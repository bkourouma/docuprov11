import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { AppModule } from '../src/app.module';

/** Collect a binary response body into a Buffer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function binaryParser(res: any, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

interface Item {
  id: number;
  depth: number;
}

describe('Intercalaires (e2e)', () => {
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

  it('lists the 5 intercalaire categories incl. BLANK', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/intercalaires/categories')
      .set('Authorization', auth())
      .expect(200);
    expect(res.body).toHaveLength(5);
    expect(res.body.find((c: { code: string }) => c.code === 'BLANK')?.isBlank).toBe(true);
  });

  it('lists document types as a flat list (depth 0)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/intercalaires/items?category=TYPE_DOCUMENT')
      .set('Authorization', auth())
      .expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((i: Item) => i.depth === 0)).toBe(true);
  });

  it('generates a PDF with one page per selected item (CA-P1)', async () => {
    const items = await request(app.getHttpServer())
      .get('/api/intercalaires/items?category=TYPE_DOCUMENT')
      .set('Authorization', auth());
    const ids = (items.body as Item[]).slice(0, 2).map((i) => i.id);

    const res = await request(app.getHttpServer())
      .post('/api/intercalaires/generate')
      .set('Authorization', auth())
      .send({ category: 'TYPE_DOCUMENT', itemIds: ids })
      .buffer()
      .parse(binaryParser)
      .expect(200);

    expect(res.headers['content-type']).toContain('application/pdf');
    const doc = await PDFDocument.load(res.body);
    expect(doc.getPageCount()).toBe(ids.length);
  });

  it('rejects an empty selection (400, CA-P1-a)', () =>
    request(app.getHttpServer())
      .post('/api/intercalaires/generate')
      .set('Authorization', auth())
      .send({ category: 'TYPE_DOCUMENT', itemIds: [] })
      .expect(400));

  it('generates a single blank separator sheet', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/intercalaires/generate')
      .set('Authorization', auth())
      .send({ category: 'BLANK', itemIds: [] })
      .buffer()
      .parse(binaryParser)
      .expect(200);
    expect((await PDFDocument.load(res.body)).getPageCount()).toBe(1);
  });
});
