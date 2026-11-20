import { Controller, Get, Logger as NestLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { pinoHttpOptions, sanitizeUrl } from './log-sanitize';

@Controller()
class ProbeController {
  private readonly logger = new NestLogger('Probe');
  @Get('ged/webhooks/whatsapp/:id')
  hook() {
    this.logger.log('webhook traité');
    return 'abc';
  }
  @Get('autre')
  other() {
    this.logger.log('autre traité');
    return 'ok';
  }
}

const SIG = `sha256=${'ab12cd34'.repeat(8)}`;

describe('sanitizeUrl', () => {
  it('supprime la query des webhooks', () => {
    expect(sanitizeUrl('/api/ged/webhooks/whatsapp/1?hub.verify_token=X&a=1')).toBe(
      '/api/ged/webhooks/whatsapp/1',
    );
  });
  it('masque les paramètres sensibles ailleurs, garde les autres', () => {
    expect(sanitizeUrl('/api/x?page=2&access_token=zzz&Client_Secret=s&API-KEY=k&pwd=1&password=p')).toBe(
      '/api/x?page=2&access_token=[masqué]&Client_Secret=[masqué]&API-KEY=[masqué]&pwd=1&password=[masqué]',
    );
    expect(sanitizeUrl('/api/x')).toBe('/api/x');
  });
});

describe('journaux pino-http', () => {
  let app: INestApplication;
  const lines: string[] = [];

  beforeAll(async () => {
    const stream = {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [{ ...pinoHttpOptions }, stream as never] })],
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    lines.length = 0;
  });

  it('ne fuit ni verify_token ni signature pour un webhook (log applicatif pendant la requête)', async () => {
    await request(app.getHttpServer())
      .get('/api/ged/webhooks/whatsapp/1?hub.mode=subscribe&hub.verify_token=SUPERSECRETTOKEN&hub.challenge=abc')
      .set('x-hub-signature-256', SIG)
      .expect(200);
    const out = lines.join('');
    expect(out).toContain('webhook traité'); // le log a bien été émis
    expect(out).toContain('"req"'); // et embarque bien req
    expect(out).not.toContain('SUPERSECRETTOKEN');
    expect(out).not.toContain('verify_token');
    expect(out).not.toContain(SIG);
    expect(out).not.toContain('ab12cd34');
  });

  it('ne fuit pas access_token pour une requête ordinaire', async () => {
    await request(app.getHttpServer()).get('/api/autre?access_token=zzz&page=1').set('x-api-key', 'KEYVAL').expect(200);
    const out = lines.join('');
    expect(out).toContain('autre traité');
    expect(out).toContain('request completed');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('KEYVAL');
    expect(out).toContain('page=1');
  });
});
