import { formatClarificationContent } from '../planner/clarification-format';
import 'reflect-metadata';
import { type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AsstActionTool, AsstMessageRole, AsstProposalStatus, type AsstProposedAction } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AssistantController } from '../assistant.controller';
import {
  ASST_CONVERSATIONS,
  ASST_EXECUTOR,
  ASST_GATE,
  ASST_IDENTITY,
  ASST_PLANNER,
  ASST_PROPOSAL_STORE,
  AsstError,
  type AsstPlanInput,
  type AsstPlanResult,
  type AsstPlannerPort,
} from '../assistant.contracts';
import { asstArgsHash } from '../store/asst-proposal-hash';
import { FakeAsstIdentity, InMemoryProposalStore, makeAsstIdentity, UnavailableExecutor } from '../testing';
import { AsstConversationsService } from './asst-conversations.service';
import { AsstMessageRateLimiter } from './asst-message-rate-limiter';

const ALICE: AuthUser = { userId: 1, username: 'user1', isAdmin: false, userGroupId: 10, fullName: null };
const BOB: AuthUser = { userId: 2, username: 'user2', isAdmin: false, userGroupId: 20, fullName: null };

const ACTIONS: AsstProposedAction[] = [
  {
    tool: AsstActionTool.ImputationCourrier,
    args: {
      mailId: 4321,
      recipients: [{ userGroupId: 17, mailInputationTypeId: 2, delayDays: 3 }],
      rationale: 'Délai de 3 jours demandé par l’utilisateur pour ce courrier.',
    },
  },
];

class ScriptedPlanner implements AsstPlannerPort {
  calls: AsstPlanInput[] = [];
  next: AsstPlanResult | AsstError | null = null;
  async plan(input: AsstPlanInput): Promise<AsstPlanResult> {
    this.calls.push(input);
    const n = this.next;
    if (!n) throw new Error('aucun résultat scripté');
    if (n instanceof Error) throw n;
    return n;
  }
}

async function boot(limit: number) {
  const store = new InMemoryProposalStore();
  const planner = new ScriptedPlanner();
  const gate = { assertRunnable: async () => undefined };
  const service = new AsstConversationsService(
    store,
    planner,
    gate as never,
    new AsstMessageRateLimiter({ limit }),
  );
  const identity = new FakeAsstIdentity([makeAsstIdentity(1, { userGroupId: 10 }), makeAsstIdentity(2, { userGroupId: 20 })]);
  const ref = await Test.createTestingModule({
    controllers: [AssistantController],
    providers: [
      { provide: PrismaService, useValue: {} },
      { provide: ASST_IDENTITY, useValue: identity },
      { provide: ASST_CONVERSATIONS, useValue: service },
      { provide: ASST_EXECUTOR, useValue: new UnavailableExecutor() },
      { provide: ASST_PROPOSAL_STORE, useValue: store },
      { provide: ASST_PLANNER, useValue: planner },
      { provide: ASST_GATE, useValue: gate },
    ],
  })
    .overrideGuard(MenuPermissionGuard)
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest<{ user?: AuthUser; headers: Record<string, string | undefined> }>();
        req.user = req.headers['x-test-user'] === '2' ? BOB : ALICE;
        return true;
      },
    })
    .compile();
  const app = ref.createNestApplication();
  await app.init();
  return { app, planner, store };
}

describe('routes de conversation (AssistantController réel + AsstConversationsService)', () => {
  let app: INestApplication;
  let planner: ScriptedPlanner;
  let store: InMemoryProposalStore;
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    ({ app, planner, store } = await boot(3));
  });
  afterEach(async () => {
    await app.close();
  });

  async function createConversation(as: 1 | 2 = 1): Promise<string> {
    const res = await http().post('/assistant/conversations').set('x-test-user', String(as)).send({ title: 'Imputation du courrier 4321' });
    expect(res.status).toBe(201);
    return (res.body as { conversationId: string }).conversationId;
  }

  it('POST /assistant/conversations : 201 et forme du DTO', async () => {
    const res = await http()
      .post('/assistant/conversations')
      .send({ title: '  Imputation du courrier 4321  ', pageContext: { route: '/courriers/controle', subjectType: 'mail', subjectId: '4321' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: 'Imputation du courrier 4321',
      pageContext: { route: '/courriers/controle', subjectType: 'mail', subjectId: '4321' },
      messageCount: 0,
    });
    expect(res.body.conversationId).toMatch(/^\d+$/);
    for (const k of ['createdAt', 'updatedAt', 'lastMessageAt', 'purgeAt']) expect(typeof res.body[k]).toBe('string');
  });

  it('POST /assistant/conversations/:id/messages : 201, proposition au statut 0 (forme du contrat)', async () => {
    const id = await createConversation();
    planner.next = {
      reply: 'Je propose d’imputer le courrier 4321 à la DAF, avec un délai de 3 jours. Confirmez pour appliquer.',
      actions: ACTIONS,
      summary: 'Imputer le courrier 4321 à la DAF (groupe 17), type 2, délai de 3 jours.',
      usage: { promptTokens: 100, completionTokens: 30, cost: 0.01 },
    };
    const res = await http()
      .post(`/assistant/conversations/${id}/messages`)
      .send({ content: 'Impute ce courrier à la DAF sous 3 jours', pageContext: { route: '/courriers/controle', subjectType: 'mail', subjectId: '4321' } });
    expect(res.status).toBe(201);
    const body = res.body as {
      conversation: { conversationId: string; messageCount: number };
      userMessage: { role: number; position: number; proposals: unknown[]; content: string };
      assistantMessage: { role: number; position: number; messageId: string; proposals: Array<Record<string, unknown>> };
    };
    expect(Object.keys(body).sort()).toEqual(['assistantMessage', 'conversation', 'userMessage']);
    expect(body.conversation).toMatchObject({ conversationId: id, messageCount: 2 });
    expect(body.userMessage).toMatchObject({ role: AsstMessageRole.User, position: 1, proposals: [], content: 'Impute ce courrier à la DAF sous 3 jours' });
    expect(body.assistantMessage).toMatchObject({ role: AsstMessageRole.Assistant, position: 2 });
    expect(body.assistantMessage.proposals).toHaveLength(1);
    const p = body.assistantMessage.proposals[0] as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(
      [
        'proposalId', 'conversationId', 'messageId', 'status', 'actions', 'summary', 'argsHash', 'expiresAt', 'createdAt',
        'confirmedAt', 'finishedAt', 'result', 'errorCode', 'errorMessage', 'rowVersion',
      ].sort(),
    );
    expect(p).toMatchObject({
      conversationId: id,
      messageId: body.assistantMessage.messageId,
      status: AsstProposalStatus.Proposed,
      actions: ACTIONS,
      summary: 'Imputer le courrier 4321 à la DAF (groupe 17), type 2, délai de 3 jours.',
      confirmedAt: null,
      finishedAt: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      rowVersion: 0,
    });
    expect(p.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.argsHash).toBe(asstArgsHash(ACTIONS));
    expect(Date.parse(p.expiresAt as string) - Date.parse(p.createdAt as string)).toBe(15 * 60_000);
    // Le contexte de page du corps est transmis au planificateur.
    expect(planner.calls[0]?.pageContext).toEqual({ route: '/courriers/controle', subjectType: 'mail', subjectId: '4321' });
  });

  it('GET liste et détail : la proposition est relue avec le message', async () => {
    const id = await createConversation();
    planner.next = { reply: 'Je propose.', actions: ACTIONS, summary: 'Imputer.', usage: { promptTokens: 1, completionTokens: 1, cost: 0 } };
    await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'Impute' });

    const list = await http().get('/assistant/conversations?limit=5&offset=0');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ conversationId: id, messageCount: 2 });

    const detail = await http().get(`/assistant/conversations/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.messages.map((m: { position: number }) => m.position)).toEqual([1, 2]);
    expect(detail.body.messages[1].proposals[0]).toMatchObject({ status: 0, actions: ACTIONS, argsHash: asstArgsHash(ACTIONS) });
    expect(detail.body.messages[1].clarification).toBeUndefined();
  });

  it('question de précision : clarification dans la réponse du message et au rechargement', async () => {
    const id = await createConversation();
    const clarification = { question: 'Quel délai ?', choices: ['3 jours', '5 jours'] };
    planner.next = {
      reply: formatClarificationContent('Quel délai ?', clarification.choices),
      actions: [],
      summary: null,
      clarification,
      usage: { promptTokens: 1, completionTokens: 1, cost: 0 },
    };
    const res = await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'Impute vite' });
    expect(res.status).toBe(201);
    expect(res.body.assistantMessage.clarification).toEqual(clarification);
    expect(res.body.assistantMessage.proposals).toEqual([]);
    const detail = await http().get(`/assistant/conversations/${id}`);
    expect(detail.body.messages[1].clarification).toEqual(clarification);
  });

  it('DELETE : 204 sans corps, puis 404 not_found', async () => {
    const id = await createConversation();
    const del = await http().delete(`/assistant/conversations/${id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    const again = await http().delete(`/assistant/conversations/${id}`);
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ statusCode: 404, errorCode: 'not_found' });
    expect((await http().get(`/assistant/conversations/${id}`)).status).toBe(404);
  });

  it('objet d’un autre utilisateur : 404 not_found partout, sans appeler le planificateur', async () => {
    const id = await createConversation(1);
    const asBob = (r: request.Test) => r.set('x-test-user', '2');
    const get = await asBob(http().get(`/assistant/conversations/${id}`));
    expect(get.status).toBe(404);
    expect(get.body).toMatchObject({ errorCode: 'not_found' });
    const post = await asBob(http().post(`/assistant/conversations/${id}/messages`)).send({ content: 'Intrusion' });
    expect(post.status).toBe(404);
    expect(post.body.errorCode).toBe('not_found');
    expect(planner.calls).toHaveLength(0);
    expect((await asBob(http().delete(`/assistant/conversations/${id}`))).status).toBe(404);
    const list = await asBob(http().get('/assistant/conversations'));
    expect(list.body).toEqual({ items: [], total: 0 });
    // L'échange d'Alice est intact.
    expect((await http().get(`/assistant/conversations/${id}`)).status).toBe(200);
  });

  it('limite de débit : 429 budget_exceeded avec retryAfterSeconds', async () => {
    const id = await createConversation();
    planner.next = { reply: 'Ok.', actions: [], summary: null, usage: { promptTokens: 1, completionTokens: 1, cost: 0 } };
    for (let i = 0; i < 3; i++) {
      expect((await http().post(`/assistant/conversations/${id}/messages`).send({ content: `m${i}` })).status).toBe(201);
    }
    const res = await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'trop' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      statusCode: 429,
      errorCode: 'budget_exceeded',
      message: 'Trop de messages en peu de temps : patientez quelques instants.',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    expect(planner.calls).toHaveLength(3);
    expect(res.headers['retry-after']).toBe(String(res.body.details.retryAfterSeconds));
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('content avec NUL : 422 invalid_input, planificateur non appelé', async () => {
    const id = await createConversation();
    planner.next = { reply: 'Ok.', actions: [], summary: null, usage: { promptTokens: 1, completionTokens: 1, cost: 0 } };
    const res = await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'abc\u0000def' });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('invalid_input');
    expect(planner.calls).toHaveLength(0);
    expect((await store.getConversation(1, id))?.messages).toEqual([]);
    // Retour à la ligne et tabulation restent acceptés.
    expect((await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'a\n\tb' })).status).toBe(201);
  });

  it('échec du planificateur : statut de l’erreur, rien de persisté', async () => {
    const id = await createConversation();
    planner.next = new AsstError('assistant_unavailable', 'IA désactivée.');
    const res = await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.errorCode).toBe('assistant_unavailable');
    expect((await store.getConversation(1, id))?.messages).toEqual([]);
  });

  it('corps invalide : 422 invalid_input (message vide, champ inconnu, titre vide, identifiant mal formé)', async () => {
    const id = await createConversation();
    const empty = await http().post(`/assistant/conversations/${id}/messages`).send({ content: '   ' });
    expect(empty.status).toBe(422);
    expect(empty.body).toMatchObject({ statusCode: 422, errorCode: 'invalid_input' });
    expect((await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'ok', extra: 1 })).status).toBe(422);
    expect((await http().post('/assistant/conversations').send({ title: '   ' })).status).toBe(422);
    const badId = await http().get('/assistant/conversations/abc');
    expect(badId.status).toBe(422);
    expect(badId.body.errorCode).toBe('invalid_input');
    expect(planner.calls).toHaveLength(0);
  });

  it('aucune exécution : la confirmation reste 501 (exécuteur factice), les messages n’appellent jamais l’exécuteur', async () => {
    const id = await createConversation();
    planner.next = { reply: 'Je propose.', actions: ACTIONS, summary: 'Imputer.', usage: { promptTokens: 1, completionTokens: 1, cost: 0 } };
    const res = await http().post(`/assistant/conversations/${id}/messages`).send({ content: 'Impute' });
    const p = res.body.assistantMessage.proposals[0] as { proposalId: string; argsHash: string };
    const confirm = await http().post(`/assistant/proposals/${p.proposalId}/confirm`).send({ argsHash: p.argsHash });
    expect(confirm.status).toBe(501);
    const stored = await store.getProposal(1, p.proposalId);
    expect(stored?.status).toBe(AsstProposalStatus.Proposed);
  });
});
