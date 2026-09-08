import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';

/**
 * Deny-by-default visibility (SC-004) + full-text OCR hit (SC-006) + admin bypass.
 * Seeds a consultant with a grant on exactly one document. Requires the dev stack + seed.
 */
describe('Search ACL + full-text (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let consultantToken: string;
  let adminToken: string;

  const tag = Math.floor(Math.random() * 1e9);
  const ocrTerm = `tournesol${tag}`;
  let userId = 0;
  let groupId = 0;
  let userGroupId = 0;
  let secretDocId = 0;
  let otherDocId = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    adminToken = (
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin1234' })
    ).body.accessToken;

    const group = await prisma.appGroup.create({ data: { name: `Consultants ${tag}` } });
    groupId = group.groupId;
    const user = await prisma.appUser.create({
      data: {
        username: `consult${tag}`,
        firstName: 'Consult',
        lastName: 'User',
        fullName: 'Consult User',
        passwordHash: await bcrypt.hash('pass1234', 10),
        isAdmin: false,
      },
    });
    userId = user.userId;
    const ug = await prisma.appUserGroup.create({ data: { userId, groupId, isDefault: true } });
    userGroupId = ug.userGroupId;

    const pdfType = await prisma.fileType.findUnique({ where: { extension: '.pdf' } });

    const secret = await prisma.document.create({
      data: {
        label: `SecretDoc ${tag}`,
        createdBy: userGroupId,
        versions: {
          create: {
            versionNumber: 1,
            isCurrent: true,
            files: {
              create: {
                fileTypeId: pdfType!.fileTypeId,
                fileExtension: '.pdf',
                ocrText: `Contenu confidentiel mentionnant ${ocrTerm} dans le corps du document.`,
                sortOrder: 0,
              },
            },
          },
        },
      },
    });
    secretDocId = secret.documentId;

    const other = await prisma.document.create({
      data: { label: `OtherDoc ${tag}`, versions: { create: { versionNumber: 1, isCurrent: true } } },
    });
    otherDocId = other.documentId;

    await prisma.documentPermission.create({
      data: { documentId: secretDocId, userGroupId, permissionLevelId: 1 },
    });

    consultantToken = (
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ username: `consult${tag}`, password: 'pass1234' })
    ).body.accessToken;
  });

  afterAll(async () => {
    await prisma.document.deleteMany({ where: { documentId: { in: [secretDocId, otherDocId] } } });
    await prisma.appUserGroup.deleteMany({ where: { userGroupId } });
    await prisma.appUser.deleteMany({ where: { userId } });
    await prisma.appGroup.deleteMany({ where: { groupId } });
    await app.close();
  });

  const search = (token: string, body: object) =>
    request(app.getHttpServer()).post('/api/documents/search').set('Authorization', `Bearer ${token}`).send(body);

  it('consultant sees only the document they were granted (SC-004)', async () => {
    const res = await search(consultantToken, { pageSize: 500 }).expect(200);
    const ids = res.body.rows.map((r: { documentId: number }) => r.documentId);
    expect(ids).toContain(secretDocId);
    expect(ids).not.toContain(otherDocId);
  });

  it('full-text finds a document by a term only in its OCR text (SC-006)', async () => {
    const res = await search(consultantToken, { fullText: ocrTerm }).expect(200);
    const ids = res.body.rows.map((r: { documentId: number }) => r.documentId);
    expect(ids).toContain(secretDocId);
  });

  it('admin sees both documents (ACL bypass)', async () => {
    const res = await search(adminToken, { pageSize: 500 }).expect(200);
    const ids = res.body.rows.map((r: { documentId: number }) => r.documentId);
    expect(ids).toContain(secretDocId);
    expect(ids).toContain(otherDocId);
  });

  it('consultant cannot open a non-granted document (404)', () =>
    request(app.getHttpServer())
      .get(`/api/documents/${otherDocId}`)
      .set('Authorization', `Bearer ${consultantToken}`)
      .expect(404));

  it('consultant can open the granted document (200, current version + file)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/documents/${secretDocId}`)
      .set('Authorization', `Bearer ${consultantToken}`)
      .expect(200);
    expect(res.body.currentVersion.files).toHaveLength(1);
  });

  it('admin can export the current result set (csv reflects rows)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/documents/export')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fullText: ocrTerm, format: 'csv' })
      .buffer()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .parse((r: any, cb: (e: Error | null, b: Buffer) => void) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.body.toString('utf8')).toContain(`SecretDoc ${tag}`);
  });
});
