// Lot 2c — webhook public WhatsApp, de bout en bout SANS service externe : vrai `ConnectorsModule`
// (contrôleurs, service, limiteurs, arrêt), vrai garde JWT global, vrai `AllExceptionsFilter`, vrai
// corps brut monté comme dans main.ts. Seuls Prisma, l'audit et les deux files BullMQ sont des
// doubles en mémoire (aucun Postgres, aucun Redis, aucun réseau hors boucle locale).
import { Global, type INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { encryptCredentials, hashPhone, loadKeyRing, WHATSAPP_MAX_BODY_BYTES } from '@archivage/connectors';
import { GED_WHATSAPP_JOB, gedWhatsappWebhookPath } from '@archivage/types';
import { AllExceptionsFilter } from '../src/common/all-exceptions.filter';
import { AuditService } from '../src/modules/audit/audit.service';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { ConnectorsModule } from '../src/modules/connectors/connectors.module';
import { GED_CONNECTOR_QUEUE_TOKEN } from '../src/modules/connectors/connectors-queue.provider';
import { GED_WHATSAPP_QUEUE_TOKEN } from '../src/modules/connectors/whatsapp-queue.provider';
import { configureWhatsappRawBody } from '../src/modules/connectors/whatsapp-raw-body';
import { PrismaService } from '../src/modules/prisma/prisma.service';

// Valeurs FACTICES.
const APP_SECRET = 'app-secret-e2e-factice-0123';
const VERIFY_TOKEN = 'verify-token-e2e-factice';
const ACCESS_TOKEN = 'access-token-e2e-factice-0123456789';
const KEY_ENV = { GED_CONNECTOR_KEY: Buffer.alloc(32, 3).toString('base64'), GED_CONNECTOR_KEY_ID: 'k1' };
const PHONE_NUMBER_ID = '109876543210987';
const SENDER = '22507080910';
const CONNECTOR_ID = 7;

const enc = encryptCredentials(
  { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
  loadKeyRing(KEY_ENV),
);
const connectorRow = {
  connectorType: 'whatsapp',
  status: 1,
  isActive: true,
  credentialsEnc: enc.credentialsEnc,
  credentialsKeyId: enc.credentialsKeyId,
  credentialsRef: null,
  config: {
    phoneNumberId: PHONE_NUMBER_ID,
    senders: [{ phone: `+${SENDER}`, label: 'Koffi' }],
    rights: { principalMap: {}, fallbackUserGroupIds: [3] },
  },
};

const items: { gedSourceItemId: bigint; data: Record<string, unknown> }[] = [];
const prisma = {
  gedSourceConnector: {
    findUnique: jest.fn(async ({ where }: { where: { gedSourceConnectorId: number } }) =>
      where.gedSourceConnectorId === CONNECTOR_ID ? connectorRow : null,
    ),
  },
  gedSourceItem: {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (items.some((i) => i.data.externalId === data.externalId)) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const gedSourceItemId = BigInt(items.length + 1);
      items.push({ gedSourceItemId, data });
      return { gedSourceItemId };
    }),
    findUnique: jest.fn(async () => null),
  },
};
const whatsappQueue = { add: jest.fn(async () => ({})), close: jest.fn(async () => undefined) };
const syncQueue = { add: jest.fn(), getJob: jest.fn(), close: jest.fn(async () => undefined) };

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: AuditService, useValue: {} },
  ],
  exports: [PrismaService, AuditService],
})
class FakeInfraModule {}

function body(messageId: string, pretty: boolean): string {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '22500000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Koffi Adjoumani' }, wa_id: SENDER }],
              messages: [
                {
                  from: SENDER,
                  id: messageId,
                  timestamp: String(Math.floor(Date.now() / 1000) - 3),
                  type: 'document',
                  document: {
                    id: '4242424242',
                    mime_type: 'application/pdf',
                    filename: 'Relevé d’été — n° 3.pdf',
                    caption: 'Légende très privée 🙂',
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  return pretty ? JSON.stringify(payload, null, 2) + '\n' : JSON.stringify(payload);
}

const sign = (raw: string | Buffer, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw).digest('hex')}`;

describe('Webhook WhatsApp (e2e, sans Redis ni Postgres)', () => {
  let app: INestApplication;
  const savedEnv = { ...process.env };
  const logged: unknown[][] = [];
  const spies: jest.SpyInstance[] = [];
  const url = gedWhatsappWebhookPath(CONNECTOR_ID);

  beforeAll(async () => {
    Object.assign(process.env, KEY_ENV);
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
      spies.push(
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logged.push(args);
        }),
      );
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_SECRET: 'jwt-secret-e2e-factice', REDIS_URL: 'redis://unused.invalid:6379' })],
        }),
        FakeInfraModule,
        ConnectorsModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
    })
      .overrideProvider(GED_CONNECTOR_QUEUE_TOKEN)
      .useValue(syncQueue)
      .overrideProvider(GED_WHATSAPP_QUEUE_TOKEN)
      .useValue(whatsappQueue)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Même ordre que main.ts.
    configureWhatsappRawBody(app);
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const s of spies) s.mockRestore();
    process.env = savedEnv;
  });

  it('GET : challenge valide → 200 text/plain, sans JWT', async () => {
    const res = await request(app.getHttpServer())
      .get(url)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '987654321' })
      .expect(200);
    expect(res.text).toBe('987654321');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('GET : mauvais jeton ou connecteur inconnu → même 403 générique', async () => {
    const bad = await request(app.getHttpServer())
      .get(url)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'mauvais-jeton', 'hub.challenge': '1' })
      .expect(403);
    const unknown = await request(app.getHttpServer())
      .get(gedWhatsappWebhookPath(8))
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' })
      .expect(403);
    expect(bad.headers['content-type']).toMatch(/^application\/json/);
    expect(bad.body).toEqual({ code: 403, message: 'Forbidden' });
    expect(unknown.body).toEqual(bad.body);
  });

  it('POST : JSON indenté, non ASCII, signé sur ses octets exacts → 200, élément + job', async () => {
    const raw = body('wamid.E2E000001', true);
    const res = await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw)
      .expect(200);
    expect(res.body).toEqual({ received: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.data).toMatchObject({
      connectorId: CONNECTOR_ID,
      externalId: 'wamid.E2E000001',
      name: 'Relevé d’été — n° 3.pdf',
      originAuthor: hashPhone(SENDER, APP_SECRET),
      state: 0,
    });
    expect(whatsappQueue.add).toHaveBeenCalledWith(
      GED_WHATSAPP_JOB.inbound,
      { connectorId: CONNECTOR_ID, itemId: '1' },
      expect.objectContaining({ jobId: 'wa-in-1', attempts: 3 }),
    );
  });

  it('POST : mêmes données re-sérialisées (autres octets) avec la signature d’origine → 401', async () => {
    const pretty = body('wamid.E2E000002', true);
    const compact = JSON.stringify(JSON.parse(pretty));
    const before = items.length;
    const res = await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(pretty))
      .send(compact)
      .expect(401);
    expect(res.body).toEqual({ code: 401, message: 'Unauthorized' });
    expect(items).toHaveLength(before);
  });

  it('POST : Content-Type non exigé (text/plain ou absent)', async () => {
    const raw = body('wamid.E2E000003', false);
    await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'text/plain')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw)
      .expect(200, { received: true });
    expect(items.map((i) => i.data.externalId)).toContain('wamid.E2E000003');
  });

  it('POST : signature absente, connecteur inconnu, identifiant invalide → réponses génériques', async () => {
    const raw = body('wamid.E2E000004', false);
    const absent = await request(app.getHttpServer()).post(url).set('Content-Type', 'application/json').send(raw).expect(401);
    const unknown = await request(app.getHttpServer())
      .post(gedWhatsappWebhookPath(8))
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw)
      .expect(401);
    expect(unknown.body).toEqual(absent.body);
    await request(app.getHttpServer()).post('/api/ged/webhooks/whatsapp/0').send(raw).expect(404);
    expect(items.map((i) => i.data.externalId)).not.toContain('wamid.E2E000004');
  });

  it('POST : corps de plus de 256 Kio → 413 avant tout traitement', async () => {
    const calls = prisma.gedSourceConnector.findUnique.mock.calls.length;
    const res = await request(app.getHttpServer())
      .post(url)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
      .send(' '.repeat(WHATSAPP_MAX_BODY_BYTES + 10))
      .expect(413);
    expect(res.body).toEqual({ code: 413, message: 'Payload Too Large' });
    expect(prisma.gedSourceConnector.findUnique.mock.calls.length).toBe(calls);
  });

  it('les routes d’administration des connecteurs restent fermées sans JWT', async () => {
    await request(app.getHttpServer()).get('/api/ged/connectors').expect(401);
    await request(app.getHttpServer()).post('/api/ged/connectors/7/sync').expect(401);
  });

  it('aucun numéro, secret, nom de fichier, légende ni signature dans les journaux', () => {
    expect(logged.length).toBeGreaterThan(0);
    const dump = JSON.stringify(logged);
    for (const s of [SENDER, APP_SECRET, VERIFY_TOKEN, ACCESS_TOKEN, 'Relevé', 'Légende', 'Koffi', 'sha256=', 'mauvais-jeton']) {
      expect(dump).not.toContain(s);
    }
    expect(dump).toContain('decision=accepted');
  });

  it('l’arrêt de l’application ferme les deux files', async () => {
    // Vérifié dans afterAll par `app.close()` ; ici on s'assure que le hook est bien branché.
    const moduleInstance = app.get(ConnectorsModule);
    await moduleInstance.onApplicationShutdown();
    expect(syncQueue.close).toHaveBeenCalled();
    expect(whatsappQueue.close).toHaveBeenCalled();
  });
});
