import { Body, Controller, HttpCode, type INestApplication, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { gedWhatsappWebhookPath } from '@archivage/types';
import { WHATSAPP_MAX_BODY_BYTES } from '@archivage/connectors';
import {
  configureWhatsappRawBody,
  createWhatsappRawBodyMiddleware,
  WHATSAPP_WEBHOOK_BASE_PATH,
  WHATSAPP_WEBHOOK_ROUTE,
} from './whatsapp-raw-body';

/** Ce que le contrôleur a réellement reçu (le corps n'est jamais analysé ici). */
interface Seen {
  isBuffer: boolean;
  hex: string | null;
  parsedFlag: unknown;
  type: string;
}
const seen: Seen[] = [];

@Controller(WHATSAPP_WEBHOOK_ROUTE)
class ProbeWebhookController {
  @Post(':id')
  @HttpCode(200)
  receive(@Req() req: { body?: unknown; _body?: unknown }) {
    seen.push({
      isBuffer: Buffer.isBuffer(req.body),
      hex: Buffer.isBuffer(req.body) ? req.body.toString('hex') : null,
      parsedFlag: req._body,
      type: typeof req.body,
    });
    return { ok: true };
  }
}

/** Route hors préfixe : le parseur JSON global de Nest doit continuer à s'y appliquer. */
@Controller('autre')
class OtherController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { isBuffer: Buffer.isBuffer(body), body };
  }
}

describe('whatsapp-raw-body', () => {
  it('le préfixe correspond au contrat partagé', () => {
    expect(`${WHATSAPP_WEBHOOK_BASE_PATH}/42`).toBe(gedWhatsappWebhookPath(42));
  });

  describe('sur une vraie application Nest initialisée (parseurs JSON/urlencoded de Nest actifs)', () => {
    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ProbeWebhookController, OtherController],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      // Même ordre que main.ts : avant `setGlobalPrefix` et avant `init` (où Nest pose ses parseurs).
      configureWhatsappRawBody(app);
      app.setGlobalPrefix('api');
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      seen.length = 0;
    });

    it('JSON avec Content-Type application/json : reçu en Buffer, octets EXACTS (non ASCII, espaces)', async () => {
      const text = '{ "object" : "whatsapp_business_account",\n  "nom": "Évelyne N’Diaye 😀", "x":"\\u00e9" }  ';
      const bytes = Buffer.from(text, 'utf8');
      await request(app.getHttpServer())
        .post('/api/ged/webhooks/whatsapp/7')
        .set('Content-Type', 'application/json')
        // Chaîne (envoyée telle quelle, en UTF-8) : un Buffer serait re-sérialisé par superagent.
        .send(text)
        .expect(200, { ok: true });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.isBuffer).toBe(true);
      expect(seen[0]!.hex).toBe(bytes.toString('hex'));
      expect(seen[0]!.parsedFlag).toBe(true);
    });

    it('JSON invalide : jamais analysé, donc pas de 400 du parseur de Nest', async () => {
      const bytes = Buffer.from('{"pas du json', 'utf8');
      await request(app.getHttpServer())
        .post('/api/ged/webhooks/whatsapp/7')
        .set('Content-Type', 'application/json')
        .send(bytes.toString('utf8'))
        .expect(200);
      expect(seen[0]!.hex).toBe(bytes.toString('hex'));
    });

    it('urlencoded ou sans Content-Type : Buffer aussi (Content-Type non exigé)', async () => {
      await request(app.getHttpServer())
        .post('/api/ged/webhooks/whatsapp/7')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('a=1&b=2')
        .expect(200);
      expect(seen[0]!.isBuffer).toBe(true);
      expect(Buffer.from(seen[0]!.hex!, 'hex').toString()).toBe('a=1&b=2');
    });

    it('corps vide : Buffer vide (le service répondra 400)', async () => {
      await request(app.getHttpServer()).post('/api/ged/webhooks/whatsapp/7').expect(200);
      expect(seen[0]!.isBuffer).toBe(true);
      expect(seen[0]!.hex).toBe('');
    });

    it('exactement 256 Kio : accepté ; un octet de plus : 413 générique, contrôleur jamais appelé', async () => {
      await request(app.getHttpServer())
        .post('/api/ged/webhooks/whatsapp/7')
        .set('Content-Type', 'application/json')
        .send(' '.repeat(WHATSAPP_MAX_BODY_BYTES))
        .expect(200);
      expect(seen).toHaveLength(1);

      const res = await request(app.getHttpServer())
        .post('/api/ged/webhooks/whatsapp/7')
        .set('Content-Type', 'application/json')
        .send(' '.repeat(WHATSAPP_MAX_BODY_BYTES + 1))
        .expect(413);
      expect(res.body).toEqual({ code: 413, message: 'Payload Too Large' });
      expect(seen).toHaveLength(1);
    });

    it('corps « chunked » sans longueur annoncée au-delà de la limite : 413', async () => {
      const server = app.getHttpServer();
      if (!server.listening) await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const r = httpRequest(
          { host: '127.0.0.1', port, method: 'POST', path: '/api/ged/webhooks/whatsapp/7', headers: { 'Transfer-Encoding': 'chunked' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on('error', reject);
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        for (let i = 0; i < 5; i++) r.write(chunk);
        r.end();
      });
      expect(status).toBe(413);
      expect(seen).toHaveLength(0);
    });

    it('corps compressé (Content-Encoding) : 415, jamais décompressé', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/ged/webhooks/whatsapp/7')
        .set('Content-Encoding', 'gzip')
        .send(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
        .expect(415);
      expect(res.body).toEqual({ code: 415, message: 'Unsupported Media Type' });
      expect(seen).toHaveLength(0);
    });

    it('hors du préfixe : le parseur JSON de Nest s’applique toujours', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/autre')
        .set('Content-Type', 'application/json')
        .send('{"a":1}')
        .expect(200);
      expect(res.body).toEqual({ isBuffer: false, body: { a: 1 } });
    });

    it('préfixe voisin (`whatsappX`) non concerné', async () => {
      // Pas de route : 404 de Nest, mais surtout le middleware ne s'est pas appliqué (corps analysé
      // ailleurs) — vérifié par l'absence d'appel au contrôleur sonde.
      await request(app.getHttpServer()).post('/api/ged/webhooks/whatsappX/7').send({ a: 1 }).expect(404);
      expect(seen).toHaveLength(0);
    });
  });

  describe('middleware isolé', () => {
    it('ne relit pas un corps déjà consommé', () => {
      const mw = createWhatsappRawBodyMiddleware(10);
      const next = jest.fn();
      const req = { _body: true, body: Buffer.from('x'), readableEnded: true, headers: {} };
      mw(req as never, {} as never, next);
      expect(next).toHaveBeenCalledWith();
      expect(req.body.toString()).toBe('x');
    });
  });
});
