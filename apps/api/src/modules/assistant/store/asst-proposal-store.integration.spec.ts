import { Prisma, PrismaClient } from '@prisma/client';
import {
  ASST_RETENTION_DAYS,
  AsstActionTool,
  AsstMessageRole,
  AsstProposalStatus,
  type AsstProposalDto,
  type AsstProposedAction,
} from '@archivage/types';
import { AsstError } from '../assistant.contracts';
import { asstArgsHash } from './asst-proposal-hash';
import { AsstProposalStoreService } from './asst-proposal-store.service';
import { AsstPurgeService } from './asst-purge.service';

// Intégration du magasin Prisma de l'assistant et de la purge sur une VRAIE base PostgreSQL JETABLE (déclencheurs et
// CHECK réels). Ne s'exécute que si WF_TEST_DATABASE_URL est définie (JAMAIS la base de développement). À lancer
// avec `--runInBand`. Utilisateurs de test : 9 200 001 à 9 200 999, nettoyés au début et à la fin.
// NB : les déclencheurs comparent à l'horloge de la BASE (`now()`) ; les dates de test sont donc ancrées sur l'horloge
// réelle (échéance simulée = création dans le passé).

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Magasin de l’assistant — intégration PostgreSQL'
  : 'Magasin de l’assistant — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL)';

const USER_BASE = 9_200_001;
const USER_MAX = 9_200_999;
const TAG = 'asst1t';

const actions: AsstProposedAction[] = [
  {
    tool: AsstActionTool.Relance,
    args: { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'Merci de traiter ce courrier.' },
  },
];

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let store: AsstProposalStoreService;
  let purge: AsstPurgeService;
  let seq = 0;
  const nextUser = (): number => USER_BASE + seq++;
  const group = (u: number): number => u + 1_000;
  // Horloge de référence : passée de quelques secondes (les horodatages sont tronqués à la seconde par la base).
  const T0 = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000);
  const at = (ms: number): Date => new Date(T0.getTime() + ms);
  const MIN = 60_000;

  const cleanup = async (): Promise<void> => {
    // 1->5 pour lever la garde « confirmée » ; purge_at ramenée à la création (<= now()) pour permettre la suppression.
    await prisma.$executeRaw`
      UPDATE "asst_proposal" SET "status" = 5, "finished_at" = now(), "error_code" = 'cleanup', "row_version" = "row_version" + 1
      WHERE "status" = 1 AND "user_id" BETWEEN ${USER_BASE} AND ${USER_MAX}`;
    await prisma.$executeRaw`
      UPDATE "asst_conversation" SET "purge_at" = "created_at"
      WHERE "user_id" BETWEEN ${USER_BASE} AND ${USER_MAX}`;
    await prisma.asstConversation.deleteMany({ where: { userId: { gte: USER_BASE, lte: USER_MAX } } });
  };

  const newConversation = async (userId: number, now: Date = T0) =>
    store.createConversation({ userId, userGroupId: group(userId), title: `${TAG} échange`, now });

  async function seed(userId: number, opts: { createdAt?: Date; ttlMs?: number } = {}) {
    const now = opts.createdAt ?? T0;
    const conv = await newConversation(userId, now);
    const msg = await store.appendMessage(
      userId,
      { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'Je propose une relance.' },
      now,
    );
    if (!msg) throw new Error('message attendu');
    const proposal = await store.createProposal(
      {
        conversationId: conv.conversationId,
        messageId: msg.messageId,
        userId,
        userGroupId: group(userId),
        actions,
        summary: 'Relancer le destinataire.',
        argsHash: asstArgsHash(actions),
        expiresAt: new Date(now.getTime() + (opts.ttlMs ?? 15 * MIN)),
      },
      now,
    );
    return { conv, msg, proposal };
  }

  const tr = (p: AsstProposalDto, to: AsstProposalStatus, now: Date, extra: Record<string, unknown> = {}) => ({
    proposalId: p.proposalId,
    expectedRowVersion: p.rowVersion,
    expectedStatus: p.status,
    to,
    now,
    ...extra,
  });

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    store = new AsstProposalStoreService(prisma as never);
    // La purge réelle est BORNÉE aux utilisateurs de test : elle ne touche jamais les échanges d'autres suites.
    const scoped = {
      asstConversation: {
        findMany: (args: { where: Record<string, unknown> }) =>
          prisma.asstConversation.findMany({ ...args, where: { ...args.where, userId: { gte: USER_BASE, lte: USER_MAX } } } as never),
        deleteMany: (args: never) => prisma.asstConversation.deleteMany(args),
      },
    };
    purge = new AsstPurgeService(scoped as never);
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it('cycle complet : conversation, messages concurrents, proposition, 0->1->2', async () => {
    const userId = nextUser();
    const conv = await store.createConversation({
      userId,
      userGroupId: group(userId),
      title: `${TAG} cycle`,
      pageContext: { route: '/courriers', subjectType: 'mail', subjectId: '12' },
      now: T0,
    });
    expect(conv.messageCount).toBe(0);
    expect(conv.pageContext).toEqual({ route: '/courriers', subjectType: 'mail', subjectId: '12' });
    expect(new Date(conv.purgeAt).getTime()).toBe(T0.getTime() + ASST_RETENTION_DAYS * 86_400_000);

    // Messages concurrents : positions distinctes et consécutives, aucune violation d'unicité.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.appendMessage(
          userId,
          { conversationId: conv.conversationId, role: AsstMessageRole.User, content: `message ${i}` },
          at(i * 1000),
        ),
      ),
    );
    const positions = results.map((m) => m?.position).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Jetons ignorés pour un message utilisateur, conservés pour l'assistant.
    const userMsg = await store.appendMessage(
      userId,
      { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'avec jetons', promptTokens: 9, completionTokens: 9, aiDecisionId: '5' },
      T0,
    );
    const asstMsg = await store.appendMessage(
      userId,
      { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'réponse', promptTokens: 11, completionTokens: 22, aiDecisionId: '6' },
      at(20_000),
    );
    if (!userMsg || !asstMsg) throw new Error('messages attendus');
    const userRow = await prisma.asstMessage.findUnique({ where: { asstMessageId: BigInt(userMsg.messageId) } });
    const asstRow = await prisma.asstMessage.findUnique({ where: { asstMessageId: BigInt(asstMsg.messageId) } });
    expect([userRow?.promptTokens, userRow?.completionTokens, userRow?.aiDecisionId]).toEqual([null, null, null]);
    expect([asstRow?.promptTokens, asstRow?.completionTokens, asstRow?.aiDecisionId]).toEqual([11, 22, 6n]);

    const proposal = await store.createProposal(
      {
        conversationId: conv.conversationId,
        messageId: asstMsg.messageId,
        userId,
        userGroupId: group(userId),
        actions,
        summary: 'Relancer le destinataire.',
        argsHash: asstArgsHash(actions),
        expiresAt: at(15 * MIN),
      },
      T0,
    );
    expect(proposal.status).toBe(AsstProposalStatus.Proposed);
    expect(proposal.rowVersion).toBe(0);

    const detail = await store.getConversation(userId, conv.conversationId);
    expect(detail?.conversation.messageCount).toBe(10);
    expect(detail?.messages.map((m) => m.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(detail?.messages[9].proposals.map((p) => p.proposalId)).toEqual([proposal.proposalId]);
    expect(detail?.messages[0].proposals).toEqual([]);
    expect(new Date(detail?.conversation.lastMessageAt ?? 0).getTime()).toBe(at(20_000).getTime());

    const confirmed = await store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000)));
    expect(confirmed).toMatchObject({ status: 1, rowVersion: 1, finishedAt: null });
    expect(confirmed?.confirmedAt).toBe(at(1000).toISOString());
    const applied = await store.transitionProposal(
      tr(confirmed as AsstProposalDto, AsstProposalStatus.Applied, at(2000), {
        result: { effects: [{ tool: 'relance', summary: { notificationId: 1 } }] },
      }),
    );
    expect(applied).toMatchObject({ status: 2, rowVersion: 2, errorCode: null });
    expect(applied?.finishedAt).toBe(at(2000).toISOString());
    expect(applied?.result).toEqual({ effects: [{ tool: 'relance', summary: { notificationId: 1 } }] });
    // Clôturée : aucune transition n'est listée depuis un état terminal (erreur de programmation).
    await expect(
      store.transitionProposal(tr(applied as AsstProposalDto, AsstProposalStatus.Failed, at(3000))),
    ).rejects.toThrow(/illégale/);
  });

  it('0->3 (refus), 0->4 (échéance simulée), 1->5 (échec)', async () => {
    const userId = nextUser();
    const refused = (await seed(userId)).proposal;
    const r = await store.transitionProposal(tr(refused, AsstProposalStatus.Refused, at(1000)));
    expect(r).toMatchObject({ status: 3, rowVersion: 1, errorCode: null, result: null });
    expect(r?.finishedAt).toBe(at(1000).toISOString());

    // Proposition déjà échue (créée il y a une heure, TTL 15 min) : expiration permise, confirmation refusée.
    const old = at(-60 * MIN);
    const expired = (await seed(userId, { createdAt: old })).proposal;
    const e = await store.transitionProposal(tr(expired, AsstProposalStatus.Expired, T0));
    expect(e).toMatchObject({ status: 4, rowVersion: 1 });

    const failing = (await seed(userId)).proposal;
    const c = (await store.transitionProposal(tr(failing, AsstProposalStatus.Confirmed, at(1000)))) as AsstProposalDto;
    const f = await store.transitionProposal(
      tr(c, AsstProposalStatus.Failed, at(2000), { errorCode: 'effect_failed', errorMessage: 'Échec de l’effet.' }),
    );
    expect(f).toMatchObject({ status: 5, rowVersion: 2, errorCode: 'effect_failed', errorMessage: 'Échec de l’effet.', result: null });
  });

  it('les erreurs de déclencheur sont levées telles quelles (confirmer après échéance, expirer avant l’heure)', async () => {
    const userId = nextUser();
    const expired = (await seed(userId, { createdAt: at(-60 * MIN) })).proposal;
    await expect(store.transitionProposal(tr(expired, AsstProposalStatus.Confirmed, T0))).rejects.toThrow(/expir/i);
    // Aucune écriture partielle.
    expect(await store.getProposal(userId, expired.proposalId)).toMatchObject({ status: 0, rowVersion: 0 });

    const active = (await seed(userId)).proposal;
    await expect(store.transitionProposal(tr(active, AsstProposalStatus.Expired, T0))).rejects.toThrow(/échue|expir/i);
    expect(await store.getProposal(userId, active.proposalId)).toMatchObject({ status: 0, rowVersion: 0 });
  });

  it('createProposal : une violation de déclencheur (acteur différent de la conversation) remonte telle quelle', async () => {
    const userId = nextUser();
    const { conv, msg } = await seed(userId);
    await expect(
      store.createProposal(
        {
          conversationId: conv.conversationId,
          messageId: msg.messageId,
          userId,
          userGroupId: group(userId) + 1,
          actions,
          summary: 'x',
          argsHash: asstArgsHash(actions),
          expiresAt: at(15 * MIN),
        },
        T0,
      ),
    ).rejects.toThrow();
  });

  it('compare-and-set concurrent : une seule transition gagne', async () => {
    const userId = nextUser();
    const { proposal } = await seed(userId);
    const outcomes = await Promise.all([
      store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000))),
      store.transitionProposal(tr(proposal, AsstProposalStatus.Refused, at(1000))),
      store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000))),
    ]);
    expect(outcomes.filter((o) => o !== null)).toHaveLength(1);
    const final = await store.getProposal(userId, proposal.proposalId);
    expect(final?.rowVersion).toBe(1);
  });

  it('1->5 puis relecture : listStaleConfirmedProposals et listExpirableProposals (bornés, triés)', async () => {
    const userId = nextUser();
    const a = (await seed(userId)).proposal;
    const b = (await seed(userId)).proposal;
    const ca = (await store.transitionProposal(tr(a, AsstProposalStatus.Confirmed, at(1000)))) as AsstProposalDto;
    const cb = (await store.transitionProposal(tr(b, AsstProposalStatus.Confirmed, at(2000)))) as AsstProposalDto;
    const mine = (list: AsstProposalDto[]) => list.filter((p) => [ca.proposalId, cb.proposalId].includes(p.proposalId));

    expect(mine(await store.listStaleConfirmedProposals(at(1000), 1000))).toEqual([]);
    expect(mine(await store.listStaleConfirmedProposals(at(1500), 1000)).map((p) => p.proposalId)).toEqual([ca.proposalId]);
    expect(mine(await store.listStaleConfirmedProposals(at(5000), 1000)).map((p) => p.proposalId)).toEqual([
      ca.proposalId,
      cb.proposalId,
    ]);
    expect(await store.listStaleConfirmedProposals(at(5000), 0)).toEqual([]);

    // Expirables : une proposition déjà échue (statut 0), une non échue.
    const old = (await seed(userId, { createdAt: at(-60 * MIN) })).proposal;
    const fresh = (await seed(userId)).proposal;
    const expirable = (await store.listExpirableProposals(T0, 1000)).map((p) => p.proposalId);
    expect(expirable).toContain(old.proposalId);
    expect(expirable).not.toContain(fresh.proposalId);
    expect(expirable).not.toContain(ca.proposalId);
  });

  it('échange d’un autre utilisateur : null/false partout ; getProposalActor ne répond qu’au propriétaire', async () => {
    const owner = nextUser();
    const other = nextUser();
    const { conv, proposal } = await seed(owner);
    expect(await store.getConversation(other, conv.conversationId)).toBeNull();
    expect((await store.listConversations(other, { limit: 50, offset: 0 })).items.map((c) => c.conversationId)).not.toContain(
      conv.conversationId,
    );
    expect(
      await store.appendMessage(other, { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'intrus' }, T0),
    ).toBeNull();
    expect(await store.getProposal(other, proposal.proposalId)).toBeNull();
    expect(await store.getProposalActor(other, proposal.proposalId)).toBeNull();
    expect(await store.deleteConversation(other, conv.conversationId, T0)).toBe(false);
    expect(await store.getProposalActor(owner, proposal.proposalId)).toEqual({ userId: owner, userGroupId: group(owner) });
    expect(await store.getConversation(owner, conv.conversationId)).not.toBeNull();
    // Identifiants mal formés : jamais d'exception.
    expect(await store.getConversation(owner, 'abc')).toBeNull();
    expect(await store.getProposal(owner, '99999999999999999999')).toBeNull();
  });

  it('masquage : introuvable, absent de la liste, proposition invisible, double suppression refusée', async () => {
    const userId = nextUser();
    const { conv, proposal } = await seed(userId);
    expect((await store.listConversations(userId, { limit: 50, offset: 0 })).total).toBe(1);
    expect(await store.deleteConversation(userId, conv.conversationId, at(1000))).toBe(true);
    expect(await store.getConversation(userId, conv.conversationId)).toBeNull();
    const list = await store.listConversations(userId, { limit: 50, offset: 0 });
    expect(list).toEqual({ items: [], total: 0 });
    expect(await store.getProposal(userId, proposal.proposalId)).toBeNull();
    expect(await store.getProposalActor(userId, proposal.proposalId)).toBeNull();
    expect(
      await store.appendMessage(userId, { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'x' }, T0),
    ).toBeNull();
    expect(await store.deleteConversation(userId, conv.conversationId, at(2000))).toBe(false);
    const row = await prisma.asstConversation.findUnique({ where: { asstConversationId: BigInt(conv.conversationId) } });
    expect(row?.deletedAt?.getTime()).toBe(at(1000).getTime());
    expect(row?.purgeAt.getTime()).toBe(at(1000).getTime());
  });

  it('listConversations : tri par mise à jour décroissante, pagination, messageCount', async () => {
    const userId = nextUser();
    const c1 = await newConversation(userId, at(-3000));
    const c2 = await newConversation(userId, at(-2000));
    const c3 = await newConversation(userId, at(-1000));
    await store.appendMessage(userId, { conversationId: c1.conversationId, role: AsstMessageRole.User, content: 'a' }, at(-500));
    await store.appendMessage(userId, { conversationId: c1.conversationId, role: AsstMessageRole.User, content: 'b' }, at(-400));
    const all = await store.listConversations(userId, { limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((c) => c.conversationId)).toEqual([c1.conversationId, c3.conversationId, c2.conversationId]);
    expect(all.items[0].messageCount).toBe(2);
    const page = await store.listConversations(userId, { limit: 1, offset: 1 });
    expect(page.items.map((c) => c.conversationId)).toEqual([c3.conversationId]);
    expect(page.total).toBe(3);
  });

  it('transition dans une transaction fournie (t.db) : annulée si la transaction échoue, validée sinon', async () => {
    const userId = nextUser();
    const { proposal } = await seed(userId);
    await expect(
      prisma.$transaction(async (tx) => {
        const done = await store.transitionProposal({ ...tr(proposal, AsstProposalStatus.Confirmed, at(1000)), db: tx });
        expect(done?.status).toBe(AsstProposalStatus.Confirmed);
        throw new Error('annulation volontaire');
      }),
    ).rejects.toThrow('annulation volontaire');
    expect(await store.getProposal(userId, proposal.proposalId)).toMatchObject({ status: 0, rowVersion: 0, confirmedAt: null });

    const committed = await prisma.$transaction((tx) =>
      store.transitionProposal({ ...tr(proposal, AsstProposalStatus.Confirmed, at(1000)), db: tx }),
    );
    expect(committed).toMatchObject({ status: 1, rowVersion: 1 });
    expect(await store.getProposal(userId, proposal.proposalId)).toMatchObject({ status: 1, rowVersion: 1 });
  });

  it('purge réelle : supprime en cascade une conversation masquée, refuse (skipped) avec une proposition confirmée', async () => {
    const userId = nextUser();
    // P1 : masquée, avec message et proposition « proposée » -> purgée en cascade.
    const p1 = await seed(userId);
    await store.deleteConversation(userId, p1.conv.conversationId, at(1000));
    // P2 : proposition CONFIRMÉE (exécution en cours) dont l'échéance de purge est échue -> refusée par le déclencheur
    // (comptée « skipped »). Le masquage par l'utilisateur ne l'abaisse pas : l'échéance est simulée en SQL.
    const p2 = await seed(userId);
    await store.transitionProposal(tr(p2.proposal, AsstProposalStatus.Confirmed, at(1000)));
    await prisma.$executeRaw`
      UPDATE "asst_conversation" SET "deleted_at" = now(), "purge_at" = "created_at"
      WHERE "asst_conversation_id" = ${BigInt(p2.conv.conversationId)}`;
    // P3 : trace d'exécution (appliquée), masquée par l'utilisateur -> purge_at conservée, NON purgée.
    const p3 = await seed(userId);
    const c3 = (await store.transitionProposal(tr(p3.proposal, AsstProposalStatus.Confirmed, at(1000)))) as AsstProposalDto;
    await store.transitionProposal(tr(c3, AsstProposalStatus.Applied, at(2000), { result: { effects: [] } }));
    await store.deleteConversation(userId, p3.conv.conversationId, at(2500));
    // P4 : non masquée, purge_at lointaine -> non sélectionnée.
    const p4 = await seed(userId);

    const outcome = await purge.purgeDue(new Date(), 1000);
    // D'autres échanges masqués des tests précédents sont aussi échus : seul le minimum est garanti.
    expect(outcome.purged).toBeGreaterThanOrEqual(1);
    expect(outcome.skipped).toBe(1);

    const exists = async (id: string) =>
      (await prisma.asstConversation.count({ where: { asstConversationId: BigInt(id) } })) > 0;
    expect(await exists(p1.conv.conversationId)).toBe(false);
    expect(await prisma.asstMessage.count({ where: { conversationId: BigInt(p1.conv.conversationId) } })).toBe(0);
    expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(p1.conv.conversationId) } })).toBe(0);
    // P3 : masquée mais conservée jusqu'à son échéance (+90 jours), trace intacte.
    expect(await exists(p3.conv.conversationId)).toBe(true);
    expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(p3.conv.conversationId) } })).toBe(1);
    expect(await exists(p2.conv.conversationId)).toBe(true);
    expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(p2.conv.conversationId) } })).toBe(1);
    expect(await exists(p4.conv.conversationId)).toBe(true);

    // Une fois l'exécution terminée (1->2), P2 devient purgeable au passage suivant.
    const c2 = (await store.getProposal(userId, p2.proposal.proposalId)) as AsstProposalDto | null;
    expect(c2).toBeNull(); // échange masqué : introuvable par le magasin ; on termine l'exécution en SQL.
    await prisma.$executeRaw`
      UPDATE "asst_proposal" SET "status" = 2, "finished_at" = now(), "row_version" = "row_version" + 1
      WHERE "asst_proposal_id" = ${BigInt(p2.proposal.proposalId)} AND "status" = 1`;
    expect(await purge.purgeDue(new Date(), 1000)).toEqual({ purged: 1, skipped: 0 });
    expect(await exists(p2.conv.conversationId)).toBe(false);
  });

  const rowOf = (id: string) => prisma.asstConversation.findUnique({ where: { asstConversationId: BigInt(id) } });
  const existsConv = async (id: string) => (await rowOf(id)) !== null;
  const DAY = 86_400_000;

  async function applyOrFail(p: AsstProposalDto, to: AsstProposalStatus) {
    const c = (await store.transitionProposal(tr(p, AsstProposalStatus.Confirmed, at(1000)))) as AsstProposalDto;
    return to === AsstProposalStatus.Applied
      ? store.transitionProposal(tr(c, to, at(2000), { result: { effects: [] } }))
      : store.transitionProposal(tr(c, to, at(2000), { errorCode: 'effect_failed', errorMessage: 'Échec de l’effet.' }));
  }

  it('masquage sans trace d’exécution (proposée, refusée, expirée) : purge_at = now, purgé par purgeDue', async () => {
    const userId = nextUser();
    const proposed = await seed(userId);
    const refused = await seed(userId);
    await store.transitionProposal(tr(refused.proposal, AsstProposalStatus.Refused, at(1000)));
    const expired = await seed(userId, { createdAt: at(-60 * MIN) });
    await store.transitionProposal(tr(expired.proposal, AsstProposalStatus.Expired, T0));

    for (const s of [proposed, refused, expired]) {
      expect(await store.deleteConversation(userId, s.conv.conversationId, at(3000))).toBe(true);
      expect((await rowOf(s.conv.conversationId))?.purgeAt.getTime()).toBe(at(3000).getTime());
      expect(await store.getConversation(userId, s.conv.conversationId)).toBeNull();
    }
    const outcome = await purge.purgeDue(new Date(), 1000);
    expect(outcome.skipped).toBe(0);
    for (const s of [proposed, refused, expired]) {
      expect(await existsConv(s.conv.conversationId)).toBe(false);
      expect(await prisma.asstMessage.count({ where: { conversationId: BigInt(s.conv.conversationId) } })).toBe(0);
      expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(s.conv.conversationId) } })).toBe(0);
    }
  });

  it.each([
    ['appliquée (statut 2)', AsstProposalStatus.Applied],
    ['en échec (statut 5)', AsstProposalStatus.Failed],
  ] as const)(
    'trace %s : masquage sans abaisser purge_at, conservée jusqu’à l’échéance puis purgée en cascade',
    async (_label, finalStatus) => {
      const userId = nextUser();
      const { conv, proposal } = await seed(userId);
      const done = await applyOrFail(proposal, finalStatus);
      expect(done?.status).toBe(finalStatus);
      const expectedPurge = T0.getTime() + ASST_RETENTION_DAYS * DAY;

      expect(await store.deleteConversation(userId, conv.conversationId, at(4000))).toBe(true);
      // Masquée : absente de la liste, introuvable ; mais purge_at inchangée (+90 jours), updated_at renseignée.
      expect(await store.getConversation(userId, conv.conversationId)).toBeNull();
      expect((await store.listConversations(userId, { limit: 50, offset: 0 })).items.map((c) => c.conversationId)).not.toContain(
        conv.conversationId,
      );
      const hidden = await rowOf(conv.conversationId);
      expect(hidden?.deletedAt?.getTime()).toBe(at(4000).getTime());
      expect(hidden?.updatedAt.getTime()).toBe(at(4000).getTime());
      expect(hidden?.purgeAt.getTime()).toBe(expectedPurge);
      // Seconde suppression : refusée (déjà masquée), purge_at toujours inchangée.
      expect(await store.deleteConversation(userId, conv.conversationId, at(5000))).toBe(false);

      // purgeDue(now) : échéance non atteinte, rien n'est sélectionné ni compté en erreur.
      const early = await purge.purgeDue(new Date(), 1000);
      expect(early.skipped).toBe(0);
      expect(await existsConv(conv.conversationId)).toBe(true);
      expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(conv.conversationId) } })).toBe(1);

      // Échéance simulée sur l'horloge de la base : purge_at ramenée dans le passé, puis purge.
      await prisma.$executeRaw`
        UPDATE "asst_conversation" SET "purge_at" = "created_at"
        WHERE "asst_conversation_id" = ${BigInt(conv.conversationId)}`;
      const late = await purge.purgeDue(new Date(Date.now() + 91 * DAY), 1000);
      expect(late.purged).toBeGreaterThanOrEqual(1);
      expect(await existsConv(conv.conversationId)).toBe(false);
      expect(await prisma.asstMessage.count({ where: { conversationId: BigInt(conv.conversationId) } })).toBe(0);
      expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(conv.conversationId) } })).toBe(0);
    },
  );

  it('purgeDue(now + 91 jours) sélectionne une trace non échue mais le déclencheur (horloge base) la refuse : comptée différée, intacte', async () => {
    const userId = nextUser();
    const { conv, proposal } = await seed(userId);
    await applyOrFail(proposal, AsstProposalStatus.Applied);
    await store.deleteConversation(userId, conv.conversationId, at(4000));
    const out = await purge.purgeDue(new Date(Date.now() + 91 * DAY), 1000);
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    expect(await existsConv(conv.conversationId)).toBe(true);
    expect((await rowOf(conv.conversationId))?.purgeAt.getTime()).toBe(T0.getTime() + ASST_RETENTION_DAYS * DAY);
  });

  it('deleteMessage : supprime un message sans proposition ; conserve celui qui en porte ; refuse autrui, échange masqué, id mal formé', async () => {
    const owner = nextUser();
    const other = nextUser();
    const { conv, msg, proposal } = await seed(owner);
    const free = await store.appendMessage(
      owner,
      { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'Aucune action à proposer.' },
      at(1000),
    );
    if (!free) throw new Error('message attendu');
    const count = () => prisma.asstMessage.count({ where: { conversationId: BigInt(conv.conversationId) } });
    expect(await count()).toBe(2);

    // Autre utilisateur, identifiants mal formés, message d'un autre échange : false, rien n'est supprimé.
    expect(await store.deleteMessage(other, conv.conversationId, free.messageId)).toBe(false);
    expect(await store.deleteMessage(owner, conv.conversationId, 'abc')).toBe(false);
    expect(await store.deleteMessage(owner, '99999999999999999999', free.messageId)).toBe(false);
    const elsewhere = await newConversation(owner);
    expect(await store.deleteMessage(owner, elsewhere.conversationId, free.messageId)).toBe(false);
    expect(await count()).toBe(2);

    // Message portant une proposition : conservé, y compris pour une proposition appliquée.
    expect(await store.deleteMessage(owner, conv.conversationId, msg.messageId)).toBe(false);
    await applyOrFail(proposal, AsstProposalStatus.Applied);
    expect(await store.deleteMessage(owner, conv.conversationId, msg.messageId)).toBe(false);
    expect(await count()).toBe(2);

    // Message sans proposition : supprimé une fois, puis false.
    expect(await store.deleteMessage(owner, conv.conversationId, free.messageId)).toBe(true);
    expect(await store.deleteMessage(owner, conv.conversationId, free.messageId)).toBe(false);
    expect(await count()).toBe(1);

    // Échange masqué : plus de suppression de message.
    const free2 = await store.appendMessage(
      owner,
      { conversationId: elsewhere.conversationId, role: AsstMessageRole.Assistant, content: 'autre' },
      at(1000),
    );
    if (!free2) throw new Error('message attendu');
    await store.deleteConversation(owner, elsewhere.conversationId, at(2000));
    expect(await store.deleteMessage(owner, elsewhere.conversationId, free2.messageId)).toBe(false);
  });

  it('course purge : échange masqué entre getProposal et la confirmation -> CAS perdu (null), statut 0 conservé', async () => {
    const userId = nextUser();
    const { conv, proposal } = await seed(userId);
    // Lecture réussie (échange encore visible), puis suppression, puis tentative de confirmation avec la lecture périmée.
    const read = await store.getProposal(userId, proposal.proposalId);
    expect(read).toMatchObject({ status: 0, rowVersion: 0 });
    expect(await store.deleteConversation(userId, conv.conversationId, at(1000))).toBe(true);
    expect(await store.transitionProposal(tr(read as AsstProposalDto, AsstProposalStatus.Confirmed, at(2000)))).toBeNull();
    // Même avec une transaction fournie (t.db) : CAS perdu, rien n'est écrit.
    const viaTx = await prisma.$transaction((tx) =>
      store.transitionProposal({ ...tr(read as AsstProposalDto, AsstProposalStatus.Confirmed, at(2000)), db: tx }),
    );
    expect(viaTx).toBeNull();
    const row = await prisma.asstProposal.findUnique({ where: { asstProposalId: BigInt(proposal.proposalId) } });
    expect(row).toMatchObject({ status: 0, rowVersion: 0, confirmedAt: null });
    // Les autres transitions ne dépendent pas du masquage : un échange masqué peut voir sa proposition refusée.
    expect(await store.transitionProposal(tr(read as AsstProposalDto, AsstProposalStatus.Refused, at(3000)))).toMatchObject({
      status: 3,
      rowVersion: 1,
    });
  });

  it('course purge concurrente : jamais « échange masqué ET proposition confirmée avec purge_at abaissée »', async () => {
    const userId = nextUser();
    const expectedPurge = T0.getTime() + ASST_RETENTION_DAYS * 86_400_000;
    const deleteAt = at(3000);
    let confirmedWins = 0;
    let deleteWins = 0;
    for (let i = 0; i < 15; i += 1) {
      const { conv, proposal } = await seed(userId);
      const [confirmed, deleted] = await Promise.all([
        store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000))),
        store.deleteConversation(userId, conv.conversationId, deleteAt),
      ]);
      expect(deleted).toBe(true);
      const conversation = await rowOf(conv.conversationId);
      const stored = await prisma.asstProposal.findUnique({ where: { asstProposalId: BigInt(proposal.proposalId) } });
      expect(conversation?.deletedAt?.getTime()).toBe(deleteAt.getTime());
      if (confirmed !== null) {
        // La confirmation a gagné : le masquage voit le statut 1 et conserve purge_at (trace d'exécution en cours).
        confirmedWins += 1;
        expect(stored).toMatchObject({ status: 1, rowVersion: 1 });
        expect(conversation?.purgeAt.getTime()).toBe(expectedPurge);
      } else {
        // Le masquage a gagné : la proposition reste proposée ; purge_at abaissée est alors cohérente (aucune trace).
        deleteWins += 1;
        expect(stored).toMatchObject({ status: 0, rowVersion: 0, confirmedAt: null });
        expect(conversation?.purgeAt.getTime()).toBe(deleteAt.getTime());
      }
    }
    expect(confirmedWins + deleteWins).toBe(15);
  });

  it('masquage d’une proposition confirmée (1) : purge_at conservée, 1 -> 2 réussit ensuite, purgeDue ne supprime pas avant l’échéance', async () => {
    const userId = nextUser();
    const { conv, proposal } = await seed(userId);
    const confirmed = (await store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000)))) as AsstProposalDto;
    expect(confirmed.status).toBe(1);
    const expectedPurge = T0.getTime() + ASST_RETENTION_DAYS * 86_400_000;

    expect(await store.deleteConversation(userId, conv.conversationId, at(2000))).toBe(true);
    const hidden = await rowOf(conv.conversationId);
    expect(hidden?.deletedAt?.getTime()).toBe(at(2000).getTime());
    expect(hidden?.purgeAt.getTime()).toBe(expectedPurge);

    // L'exécution en cours se termine malgré le masquage (1 -> 2 ne dépend pas de la visibilité).
    const applied = await store.transitionProposal(tr(confirmed, AsstProposalStatus.Applied, at(3000), { result: { effects: [] } }));
    expect(applied).toMatchObject({ status: 2, rowVersion: 2 });

    // Avant l'échéance : ni purgé ni compté en erreur.
    const out = await purge.purgeDue(new Date(), 1000);
    expect(out.skipped).toBe(0);
    expect(await existsConv(conv.conversationId)).toBe(true);
    expect(await prisma.asstProposal.count({ where: { conversationId: BigInt(conv.conversationId) } })).toBe(1);
    expect((await rowOf(conv.conversationId))?.purgeAt.getTime()).toBe(expectedPurge);
  });

  // ---------------------------------------------------------------------------
  // Verrous (comportemental, vraie base) : le verrou partagé du CAS 0 -> 1 et le verrou exclusif du masquage.
  // Ces tests ÉCHOUENT si le `FOR SHARE` est retiré du CAS (aucune attente, masquage non vu).
  // ---------------------------------------------------------------------------
  describe('verrous de ligne (FOR SHARE du CAS 0->1, FOR UPDATE et lock_timeout du masquage)', () => {
    const HOLD_MS = 1_200;
    const WAITED_MS = 900; // marge sous HOLD_MS (le verrou est pris avant le lancement de l'appel mesuré)
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /**
     * Ouvre une transaction qui verrouille l'échange (`FOR UPDATE`), signale `locked`, le tient `holdMs`, exécute
     * `before` (ex. masquage en vol) puis valide. `done` se résout à la validation.
     */
    function holdConversationLock(conversationId: string, holdMs: number, before?: (tx: Prisma.TransactionClient) => Promise<void>) {
      let signal!: () => void;
      const locked = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const done = prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          await tx.$queryRaw`
            SELECT "asst_conversation_id" FROM "asst_conversation"
            WHERE "asst_conversation_id" = ${BigInt(conversationId)} FOR UPDATE`;
          signal();
          await sleep(holdMs);
          if (before) await before(tx);
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
      return { locked, done };
    }

    const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
      const start = Date.now();
      const value = await fn();
      return { value, ms: Date.now() - start };
    };

    it('CAS 0->1 : attend le verrou exclusif tenu sur l’échange, puis renvoie null si l’échange a été masqué entre-temps', async () => {
      const userId = nextUser();
      const { conv, proposal } = await seed(userId);
      const holder = holdConversationLock(conv.conversationId, HOLD_MS, async (tx) => {
        // Tentative de masquage en vol, validée à la libération du verrou.
        await tx.$executeRaw`UPDATE "asst_conversation" SET "deleted_at" = now() WHERE "asst_conversation_id" = ${BigInt(conv.conversationId)}`;
      });
      await holder.locked;
      const { value, ms } = await timed(() =>
        store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000))),
      );
      await holder.done;
      expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
      expect(value).toBeNull();
      const row = await prisma.asstProposal.findUnique({ where: { asstProposalId: BigInt(proposal.proposalId) } });
      expect(row).toMatchObject({ status: 0, rowVersion: 0, confirmedAt: null });
    });

    it('CAS 0->1 : attend le verrou exclusif puis réussit si l’échange n’a pas été masqué', async () => {
      const userId = nextUser();
      const { conv, proposal } = await seed(userId);
      const holder = holdConversationLock(conv.conversationId, HOLD_MS);
      await holder.locked;
      const { value, ms } = await timed(() =>
        store.transitionProposal(tr(proposal, AsstProposalStatus.Confirmed, at(1000))),
      );
      await holder.done;
      expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
      expect(value).toMatchObject({ status: 1, rowVersion: 1 });
    });

    it('masquage : attend la transaction de confirmation (FOR SHARE tenu dans t.db), voit le statut 1 et NE baisse PAS purge_at', async () => {
      const userId = nextUser();
      const { conv, proposal } = await seed(userId);
      const expectedPurge = T0.getTime() + ASST_RETENTION_DAYS * 86_400_000;
      let signal!: () => void;
      const confirmed = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const confirmation = prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const out = await store.transitionProposal({
            ...tr(proposal, AsstProposalStatus.Confirmed, at(1000)),
            db: tx,
          });
          signal();
          await sleep(HOLD_MS); // exécution en cours : la transaction reste ouverte
          return out;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
      await confirmed;
      const { value, ms } = await timed(() => store.deleteConversation(userId, conv.conversationId, at(3000)));
      expect(await confirmation).toMatchObject({ status: 1, rowVersion: 1 });
      expect(ms).toBeGreaterThanOrEqual(WAITED_MS);
      expect(value).toBe(true);
      const conversation = await rowOf(conv.conversationId);
      expect(conversation?.deletedAt?.getTime()).toBe(at(3000).getTime());
      expect(conversation?.purgeAt.getTime()).toBe(expectedPurge);
      expect(await prisma.asstProposal.findUnique({ where: { asstProposalId: BigInt(proposal.proposalId) } })).toMatchObject({
        status: 1,
      });
    });

    it('masquage : lock_timeout dépassé -> conflict 409, échange NON masqué et ligne inchangée', async () => {
      const userId = nextUser();
      const { conv } = await seed(userId);
      const before = await rowOf(conv.conversationId);
      const previous = store.deleteLockTimeoutMs;
      store.deleteLockTimeoutMs = 300; // délai réduit pour ne pas ralentir la suite
      try {
        const holder = holdConversationLock(conv.conversationId, HOLD_MS);
        await holder.locked;
        const { value, ms } = await timed(() =>
          store.deleteConversation(userId, conv.conversationId, at(3000)).catch((e: unknown) => e),
        );
        await holder.done;
        expect(value).toBeInstanceOf(AsstError);
        expect(value).toMatchObject({
          errorCode: 'conflict',
          message: 'L’échange est en cours de traitement : réessayez dans un instant.',
        });
        expect(ms).toBeGreaterThanOrEqual(250);
        expect(ms).toBeLessThan(HOLD_MS);
      } finally {
        store.deleteLockTimeoutMs = previous;
      }
      const after = await rowOf(conv.conversationId);
      expect(after).toEqual(before);
      expect(after?.deletedAt).toBeNull();
      // Verrou relâché : le masquage réessayé aboutit normalement (et le délai du lock_timeout n'a pas fui sur la connexion).
      expect(await store.deleteConversation(userId, conv.conversationId, at(4000))).toBe(true);
    });
  });
});
