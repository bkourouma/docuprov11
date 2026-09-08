import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * Contract/e2e for /api/batches (T025). Requires the dev stack (Postgres :5432 + Redis)
 * and the seed (admin / admin1234, dossier id 1). Run via `pnpm --filter @archivage/api test:e2e`.
 */
describe('Batches (e2e)', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin1234' });
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => `Bearer ${token}`;

  it('rejects an unauthenticated request (deny-by-default)', () =>
    request(app.getHttpServer()).post('/api/batches').send({ dossierId: 1 }).expect(401));

  it('creates a batch for an existing dossier', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/batches')
      .set('Authorization', auth())
      .send({ dossierId: 1 })
      .expect(201);
    expect(res.body.batchId).toBeGreaterThan(0);
    expect(res.body.status).toBe(0);
  });

  it('refuses a duplicate active dossier label (409, FR-009)', async () => {
    const label = `E2EDup${Math.floor(Math.random() * 1e9)}`;
    await request(app.getHttpServer())
      .post('/api/batches')
      .set('Authorization', auth())
      .send({ newDossier: { label } })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/batches')
      .set('Authorization', auth())
      .send({ newDossier: { label } })
      .expect(409);
  });

  it('validates the request body (400)', () =>
    request(app.getHttpServer())
      .post('/api/batches')
      .set('Authorization', auth())
      .send({})
      .expect(400));

  it('returns a 404 for an unknown batch status', () =>
    request(app.getHttpServer())
      .get('/api/batches/99999999')
      .set('Authorization', auth())
      .expect(404));
});
