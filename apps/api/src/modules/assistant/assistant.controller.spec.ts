import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext, type INestApplication, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantController } from './assistant.controller';
import {
  ASST_CONVERSATIONS,
  ASST_EXECUTOR,
  ASST_IDENTITY,
  AsstError,
  type AsstIdentity,
} from './assistant.contracts';
import { NotImplementedConversations, NotImplementedExecutor } from './not-implemented';

const HASH = 'a'.repeat(64);

const TOKEN_USER: AuthUser = { userId: 7, username: 'alice', isAdmin: false, userGroupId: 70, fullName: null };
const identityOf = (user: AuthUser): AsstIdentity => ({
  user,
  principal: { userGroupId: user.userGroupId ?? 0, userId: user.userId, groupIds: [1], roleId: null },
});

type Mocks = {
  identity: { resolve: jest.Mock };
  conversations: Record<'create' | 'list' | 'detail' | 'postMessage' | 'remove', jest.Mock>;
  executor: Record<'confirm' | 'refuse' | 'get' | 'expireDue', jest.Mock>;
};

function makeMocks(): Mocks {
  return {
    identity: { resolve: jest.fn(async (u: AuthUser) => identityOf(u)) },
    conversations: {
      create: jest.fn(),
      list: jest.fn(),
      detail: jest.fn(),
      postMessage: jest.fn(),
      remove: jest.fn(),
    },
    executor: { confirm: jest.fn(), refuse: jest.fn(), get: jest.fn(), expireDue: jest.fn() },
  };
}

async function boot(
  providers: Provider[],
  guard: (ctx: ExecutionContext) => boolean = () => true,
): Promise<INestApplication> {
  const ref = await Test.createTestingModule({
    controllers: [AssistantController],
    providers: [{ provide: PrismaService, useValue: {} }, ...providers],
  })
    .overrideGuard(MenuPermissionGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user = TOKEN_USER;
        return guard(ctx);
      },
    })
    .compile();
  const app = ref.createNestApplication();
  await app.init();
  return app;
}

const mockProviders = (m: Mocks): Provider[] => [
  { provide: ASST_IDENTITY, useValue: m.identity },
  { provide: ASST_CONVERSATIONS, useValue: m.conversations },
  { provide: ASST_EXECUTOR, useValue: m.executor },
];

describe('AssistantController : délégation', () => {
  let app: INestApplication;
  let m: Mocks;

  beforeEach(async () => {
    m = makeMocks();
    app = await boot(mockProviders(m));
  });
  afterEach(async () => {
    await app.close();
  });

  it('POST /assistant/conversations : 201, identité du jeton, corps validé', async () => {
    m.conversations.create.mockResolvedValue({ conversationId: '1' });
    const res = await request(app.getHttpServer())
      .post('/assistant/conversations')
      .send({ title: '  Mon titre  ', pageContext: { route: '/courriers', subjectType: 'mail', subjectId: '12' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ conversationId: '1' });
    expect(m.identity.resolve).toHaveBeenCalledWith(TOKEN_USER);
    expect(m.conversations.create).toHaveBeenCalledWith(identityOf(TOKEN_USER), {
      title: 'Mon titre',
      pageContext: { route: '/courriers', subjectType: 'mail', subjectId: '12' },
    });
  });

  it('GET /assistant/conversations : 200, valeurs par défaut de pagination', async () => {
    m.conversations.list.mockResolvedValue({ items: [], total: 0 });
    const res = await request(app.getHttpServer()).get('/assistant/conversations');
    expect(res.status).toBe(200);
    expect(m.conversations.list).toHaveBeenCalledWith(identityOf(TOKEN_USER), { limit: 20, offset: 0 });
    await request(app.getHttpServer()).get('/assistant/conversations?limit=5&offset=10');
    expect(m.conversations.list).toHaveBeenLastCalledWith(identityOf(TOKEN_USER), { limit: 5, offset: 10 });
  });

  it('GET /assistant/conversations/:id : 200', async () => {
    m.conversations.detail.mockResolvedValue({ conversation: {}, messages: [] });
    const res = await request(app.getHttpServer()).get('/assistant/conversations/42');
    expect(res.status).toBe(200);
    expect(m.conversations.detail).toHaveBeenCalledWith(identityOf(TOKEN_USER), '42');
  });

  it('POST /assistant/conversations/:id/messages : 201', async () => {
    const payload = { conversation: {}, userMessage: {}, assistantMessage: {} };
    m.conversations.postMessage.mockResolvedValue(payload);
    const res = await request(app.getHttpServer())
      .post('/assistant/conversations/42/messages')
      .send({ content: ' Bonjour ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(payload);
    expect(m.conversations.postMessage).toHaveBeenCalledWith(identityOf(TOKEN_USER), '42', { content: 'Bonjour' });
  });

  it('POST /assistant/proposals/:id/confirm : 200, confirm(identité, id, corps)', async () => {
    m.executor.confirm.mockResolvedValue({ proposalId: '9' });
    const res = await request(app.getHttpServer()).post('/assistant/proposals/9/confirm').send({ argsHash: HASH });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ proposalId: '9' });
    expect(m.executor.confirm).toHaveBeenCalledWith(identityOf(TOKEN_USER), '9', { argsHash: HASH });
  });

  it('POST /assistant/proposals/:id/refuse : 200, motif transmis (ou absent)', async () => {
    m.executor.refuse.mockResolvedValue({ proposalId: '9' });
    const withReason = await request(app.getHttpServer()).post('/assistant/proposals/9/refuse').send({ reason: ' non ' });
    expect(withReason.status).toBe(200);
    expect(m.executor.refuse).toHaveBeenLastCalledWith(identityOf(TOKEN_USER), '9', 'non');
    const without = await request(app.getHttpServer()).post('/assistant/proposals/9/refuse').send({});
    expect(without.status).toBe(200);
    expect(m.executor.refuse).toHaveBeenLastCalledWith(identityOf(TOKEN_USER), '9', undefined);
  });

  it('GET /assistant/proposals/:id : 200', async () => {
    m.executor.get.mockResolvedValue({ proposalId: '9' });
    const res = await request(app.getHttpServer()).get('/assistant/proposals/9');
    expect(res.status).toBe(200);
    expect(m.executor.get).toHaveBeenCalledWith(identityOf(TOKEN_USER), '9');
  });

  it('DELETE /assistant/conversations/:id : 204 sans corps', async () => {
    m.conversations.remove.mockResolvedValue(undefined);
    const res = await request(app.getHttpServer()).delete('/assistant/conversations/42');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(m.conversations.remove).toHaveBeenCalledWith(identityOf(TOKEN_USER), '42');
  });

  it("l'utilisateur vient du jeton : un userId dans le corps est refusé (champ inconnu)", async () => {
    const res = await request(app.getHttpServer()).post('/assistant/conversations').send({ userId: 1, title: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('invalid_input');
    expect(m.conversations.create).not.toHaveBeenCalled();
  });
});

describe('AssistantController : validation AVANT toute délégation', () => {
  let app: INestApplication;
  let m: Mocks;

  beforeEach(async () => {
    m = makeMocks();
    app = await boot(mockProviders(m));
  });
  afterEach(async () => {
    await app.close();
  });

  const cases: [string, () => request.Test][] = [
    ['id de conversation non numérique', () => request(app.getHttpServer()).get('/assistant/conversations/abc')],
    ['id de proposition trop long', () => request(app.getHttpServer()).get('/assistant/proposals/1234567890123456789')],
    ['suppression avec un id invalide', () => request(app.getHttpServer()).delete('/assistant/conversations/x1')],
    ['pagination hors bornes', () => request(app.getHttpServer()).get('/assistant/conversations?limit=500')],
    ['paramètre de requête inconnu', () => request(app.getHttpServer()).get('/assistant/conversations?foo=1')],
    [
      'message vide (après trim)',
      () => request(app.getHttpServer()).post('/assistant/conversations/1/messages').send({ content: '   ' }),
    ],
    [
      'message avec champ inconnu',
      () => request(app.getHttpServer()).post('/assistant/conversations/1/messages').send({ content: 'a', role: 'x' }),
    ],
    [
      'confirmation sans empreinte valide',
      () => request(app.getHttpServer()).post('/assistant/proposals/1/confirm').send({ argsHash: 'xyz' }),
    ],
    ['confirmation sans corps', () => request(app.getHttpServer()).post('/assistant/proposals/1/confirm').send({})],
    [
      'refus avec motif vide',
      () => request(app.getHttpServer()).post('/assistant/proposals/1/refuse').send({ reason: '  ' }),
    ],
  ];

  it.each(cases)('422 invalid_input : %s', async (_name, run) => {
    const res = await run();
    expect(res.status).toBe(422);
    expect(res.body).toEqual(
      expect.objectContaining({ statusCode: 422, errorCode: 'invalid_input', message: expect.any(String) }),
    );
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(m.identity.resolve).not.toHaveBeenCalled();
    for (const fn of [...Object.values(m.conversations), ...Object.values(m.executor)]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('AssistantController : erreurs', () => {
  let app: INestApplication;
  let m: Mocks;

  beforeEach(async () => {
    m = makeMocks();
    app = await boot(mockProviders(m));
  });
  afterEach(async () => {
    await app.close();
  });

  it('identité refusée : 403 identity_refused, aucune délégation', async () => {
    m.identity.resolve.mockRejectedValue(new AsstError('identity_refused', 'Identité refusée.'));
    const res = await request(app.getHttpServer()).get('/assistant/conversations');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ statusCode: 403, errorCode: 'identity_refused', message: 'Identité refusée.' });
    expect(m.conversations.list).not.toHaveBeenCalled();
  });

  it("objet d'un autre utilisateur : 404 not_found (jamais 403)", async () => {
    m.executor.get.mockRejectedValue(new AsstError('not_found', 'Proposition introuvable.'));
    const res = await request(app.getHttpServer()).get('/assistant/proposals/9');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ statusCode: 404, errorCode: 'not_found', message: 'Proposition introuvable.' });
  });

  it('conflit de hachage : 409 conflict', async () => {
    m.executor.confirm.mockRejectedValue(new AsstError('conflict', 'Le contenu a changé.'));
    const res = await request(app.getHttpServer()).post('/assistant/proposals/9/confirm').send({ argsHash: HASH });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('conflict');
  });

  it('effet en échec : la proposition finale est jointe au corps', async () => {
    const proposal = { proposalId: '9', status: 5 } as never;
    m.executor.confirm.mockRejectedValue(new AsstError('effect_failed', 'Échec.', { reason: 'x' }, proposal));
    const res = await request(app.getHttpServer()).post('/assistant/proposals/9/confirm').send({ argsHash: HASH });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      statusCode: 422,
      errorCode: 'effect_failed',
      message: 'Échec.',
      details: { reason: 'x' },
      proposal: { proposalId: '9', status: 5 },
    });
  });

  it('refus du guard (HttpException) : laissé tel quel, sans errorCode', async () => {
    await app.close();
    app = await boot(mockProviders(m), () => {
      throw new ForbiddenException("Vous n'avez pas accès à cette section.");
    });
    const res = await request(app.getHttpServer()).get('/assistant/conversations');
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBeUndefined();
    expect(res.body.message).toBe("Vous n'avez pas accès à cette section.");
    expect(m.identity.resolve).not.toHaveBeenCalled();
  });
});

describe('AssistantController : implémentations par défaut', () => {
  let app: INestApplication;
  const identity = { resolve: jest.fn(async (u: AuthUser) => identityOf(u)) };

  beforeEach(async () => {
    app = await boot([
      { provide: ASST_IDENTITY, useValue: identity },
      { provide: ASST_CONVERSATIONS, useClass: NotImplementedConversations },
      { provide: ASST_EXECUTOR, useClass: NotImplementedExecutor },
    ]);
  });
  afterEach(async () => {
    await app.close();
  });

  const routes: [string, string, object | undefined][] = [
    ['POST', '/assistant/conversations', {}],
    ['GET', '/assistant/conversations', undefined],
    ['GET', '/assistant/conversations/1', undefined],
    ['POST', '/assistant/conversations/1/messages', { content: 'Bonjour' }],
    ['POST', '/assistant/proposals/1/confirm', { argsHash: HASH }],
    ['POST', '/assistant/proposals/1/refuse', {}],
    ['GET', '/assistant/proposals/1', undefined],
    ['DELETE', '/assistant/conversations/1', undefined],
  ];

  it.each(routes)('%s %s : 501 not_implemented', async (method, path, body) => {
    const agent = request(app.getHttpServer());
    let req: request.Test;
    if (method === 'GET') req = agent.get(path);
    else if (method === 'DELETE') req = agent.delete(path);
    else req = agent.post(path).send(body ?? {});
    const res = await req;
    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      statusCode: 501,
      errorCode: 'not_implemented',
      message: 'Fonction pas encore disponible.',
    });
  });
});
