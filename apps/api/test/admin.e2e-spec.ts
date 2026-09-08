import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/modules/prisma/prisma.service';

/** Admin authz (AdminGuard) + referentials/users CRUD + path recompute + change-password. */
describe('Admin (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let consultantToken: string;

  const tag = Math.floor(Math.random() * 1e9);
  let userId = 0;
  let groupId = 0;
  const createdDocTypeIds: number[] = [];
  const createdDossierIds: number[] = [];
  let createdUserId = 0;

  const admin = () => `Bearer ${adminToken}`;
  const consultant = () => `Bearer ${consultantToken}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);

    adminToken = (
      await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'admin', password: 'admin1234' })
    ).body.accessToken;

    const group = await prisma.appGroup.create({ data: { name: `AdminTestGrp ${tag}` } });
    groupId = group.groupId;
    const user = await prisma.appUser.create({
      data: {
        username: `adminspec${tag}`,
        firstName: 'A',
        lastName: 'Spec',
        fullName: 'A Spec',
        passwordHash: await bcrypt.hash('pass1234', 10),
        isAdmin: false,
      },
    });
    userId = user.userId;
    await prisma.appUserGroup.create({ data: { userId, groupId, isDefault: true } });
    consultantToken = (
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ username: `adminspec${tag}`, password: 'pass1234' })
    ).body.accessToken;
  });

  afterAll(async () => {
    if (createdUserId) {
      await prisma.appUserGroup.deleteMany({ where: { userId: createdUserId } });
      await prisma.appUser.deleteMany({ where: { userId: createdUserId } });
    }
    await prisma.dossier.deleteMany({ where: { dossierId: { in: createdDossierIds } } });
    await prisma.documentType.deleteMany({ where: { documentTypeId: { in: createdDocTypeIds } } });
    await prisma.appUserGroup.deleteMany({ where: { userId } });
    await prisma.appUser.deleteMany({ where: { userId } });
    await prisma.appGroup.deleteMany({ where: { groupId } });
    await app.close();
  });

  it('forbids non-admins from the admin API (403)', async () => {
    await request(app.getHttpServer()).get('/api/referentials/document-types').set('Authorization', consultant()).expect(403);
    await request(app.getHttpServer()).get('/api/users').set('Authorization', consultant()).expect(403);
  });

  it('creates a document type and refuses a duplicate active label (409)', async () => {
    const label = `AdminType ${tag}`;
    const res = await request(app.getHttpServer())
      .post('/api/referentials/document-types')
      .set('Authorization', admin())
      .send({ label })
      .expect(201);
    createdDocTypeIds.push(res.body.documentTypeId);
    await request(app.getHttpServer())
      .post('/api/referentials/document-types')
      .set('Authorization', admin())
      .send({ label })
      .expect(409);
  });

  it('creates dossiers with materialized paths and recomputes on reparent', async () => {
    const root = await request(app.getHttpServer())
      .post('/api/referentials/dossiers')
      .set('Authorization', admin())
      .send({ label: `AdminRoot ${tag}` })
      .expect(201);
    createdDossierIds.push(root.body.dossierId);
    expect(root.body.path).toBe(`/${root.body.dossierId}/`);

    const child = await request(app.getHttpServer())
      .post('/api/referentials/dossiers')
      .set('Authorization', admin())
      .send({ label: `AdminChild ${tag}`, parentId: root.body.dossierId })
      .expect(201);
    createdDossierIds.push(child.body.dossierId);
    expect(child.body.path).toBe(`/${root.body.dossierId}/${child.body.dossierId}/`);

    // Move child to the root level -> its path is recomputed.
    await request(app.getHttpServer())
      .patch(`/api/referentials/dossiers/${child.body.dossierId}/parent`)
      .set('Authorization', admin())
      .send({ parentId: null })
      .expect(200);
    const moved = await prisma.dossier.findUnique({ where: { dossierId: child.body.dossierId } });
    expect(moved?.path).toBe(`/${child.body.dossierId}/`);
    expect(moved?.depth).toBe(0);
  });

  it('admin creates a user (and non-admin cannot)', async () => {
    await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', consultant())
      .send({ username: `x${tag}`, firstName: 'X', lastName: 'Y', password: 'password123' })
      .expect(403);

    const res = await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', admin())
      .send({ username: `created${tag}`, firstName: 'New', lastName: 'User', password: 'password123', groupId })
      .expect(201);
    createdUserId = res.body.userId;
    expect(res.body.userId).toBeGreaterThan(0);
  });

  it('lets a user change their own password and re-login', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/change-password')
      .set('Authorization', consultant())
      .send({ currentPassword: 'pass1234', newPassword: 'newpass1234' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: `adminspec${tag}`, password: 'newpass1234' })
      .expect(201);
  });
});
