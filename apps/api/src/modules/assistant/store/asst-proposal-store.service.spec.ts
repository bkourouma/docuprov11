import {
  ASST_PROPOSAL_TTL_MINUTES,
  AsstActionTool,
  AsstMessageRole,
  AsstProposalStatus,
  type AsstProposedAction,
} from '@archivage/types';
import { AsstProposalStoreService } from './asst-proposal-store.service';
import { asstArgsHash } from './asst-proposal-hash';

const NOW = new Date('2026-11-22T10:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const actions: AsstProposedAction[] = [
  {
    tool: AsstActionTool.Relance,
    args: { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'Merci de traiter ce courrier.' },
  },
];

const proposalRow = (over: Record<string, unknown> = {}) => ({
  asstProposalId: 5n,
  conversationId: 1n,
  messageId: 2n,
  userId: 10,
  userGroupId: 100,
  status: 0,
  actions,
  summary: 'Résumé',
  argsHash: asstArgsHash(actions),
  expiresAt: at(15),
  createdAt: NOW,
  confirmedAt: null,
  finishedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  rowVersion: 0,
  ...over,
});

function makePrisma() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1n }]),
    asstMessage: {
      aggregate: jest.fn().mockResolvedValue({ _max: { position: 2 } }),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ asstMessageId: 9n, createdAt: NOW, ...data }),
      ),
    },
    asstConversation: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    asstConversation: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    asstProposal: {
      create: jest.fn().mockResolvedValue(proposalRow()),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(proposalRow({ status: 1, rowVersion: 1 })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { prisma, tx, store: new AsstProposalStoreService(prisma as never) };
}

const newProposal = (over: Record<string, unknown> = {}) => ({
  conversationId: '1',
  messageId: '2',
  userId: 10,
  userGroupId: 100,
  actions,
  summary: 'Relancer le destinataire.',
  argsHash: asstArgsHash(actions),
  expiresAt: at(ASST_PROPOSAL_TTL_MINUTES),
  ...over,
});

describe('AsstProposalStoreService — identifiants et visibilité', () => {
  it.each(['', 'abc', '12a', '1234567890123456789', '-3'])('identifiant mal formé « %s » -> null/false sans appel base', async (bad) => {
    const { store, prisma } = makePrisma();
    await expect(store.getConversation(1, bad)).resolves.toBeNull();
    await expect(store.deleteConversation(1, bad, NOW)).resolves.toBe(false);
    await expect(store.getProposal(1, bad)).resolves.toBeNull();
    await expect(store.getProposalActor(1, bad)).resolves.toBeNull();
    await expect(
      store.appendMessage(1, { conversationId: bad, role: AsstMessageRole.User, content: 'x' }, NOW),
    ).resolves.toBeNull();
    await expect(
      store.transitionProposal({
        proposalId: bad,
        expectedRowVersion: 0,
        expectedStatus: AsstProposalStatus.Proposed,
        to: AsstProposalStatus.Refused,
        now: NOW,
      }),
    ).resolves.toBeNull();
    expect(prisma.asstConversation.findFirst).not.toHaveBeenCalled();
    expect(prisma.asstProposal.findFirst).not.toHaveBeenCalled();
    expect(prisma.asstProposal.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('getProposal / getProposalActor bornent la lecture à l’utilisateur et aux échanges non masqués', async () => {
    const { store, prisma } = makePrisma();
    prisma.asstProposal.findFirst.mockResolvedValue(proposalRow());
    const actor = await store.getProposalActor(10, '5');
    expect(actor).toEqual({ userId: 10, userGroupId: 100 });
    expect(prisma.asstProposal.findFirst).toHaveBeenCalledWith({
      where: { asstProposalId: 5n, userId: 10, conversation: { deletedAt: null } },
    });
    prisma.asstProposal.findFirst.mockResolvedValue(null);
    await expect(store.getProposal(11, '5')).resolves.toBeNull();
  });

  it('getConversation borne la lecture à l’utilisateur et exclut les échanges masqués', async () => {
    const { store, prisma } = makePrisma();
    await expect(store.getConversation(10, '7')).resolves.toBeNull();
    expect(prisma.asstConversation.findFirst.mock.calls[0][0].where).toEqual({
      asstConversationId: 7n,
      userId: 10,
      deletedAt: null,
    });
  });

  it('deleteConversation : un seul UPDATE conditionnel ; false si aucune ligne', async () => {
    const { store, prisma } = makePrisma();
    await expect(store.deleteConversation(10, '7', NOW)).resolves.toBe(true);
    expect(prisma.asstConversation.updateMany).toHaveBeenCalledWith({
      where: { asstConversationId: 7n, userId: 10, deletedAt: null },
      data: { deletedAt: NOW, purgeAt: NOW, updatedAt: NOW },
    });
    prisma.asstConversation.updateMany.mockResolvedValue({ count: 0 });
    await expect(store.deleteConversation(10, '7', NOW)).resolves.toBe(false);
  });

  it('listConversations filtre les échanges masqués et trie par mise à jour décroissante', async () => {
    const { store, prisma } = makePrisma();
    await store.listConversations(10, { limit: 5, offset: 10 });
    const args = prisma.asstConversation.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 10, deletedAt: null });
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { asstConversationId: 'desc' }]);
    expect(args.take).toBe(5);
    expect(args.skip).toBe(10);
  });
});

describe('AsstProposalStoreService — appendMessage', () => {
  it('ignore jetons et décision IA pour un message utilisateur', async () => {
    const { store, tx } = makePrisma();
    await store.appendMessage(
      10,
      {
        conversationId: '1',
        role: AsstMessageRole.User,
        content: 'bonjour',
        promptTokens: 5,
        completionTokens: 6,
        aiDecisionId: '77',
      },
      NOW,
    );
    const data = tx.asstMessage.create.mock.calls[0][0].data;
    expect(data.promptTokens).toBeNull();
    expect(data.completionTokens).toBeNull();
    expect(data.aiDecisionId).toBeNull();
    expect(data.position).toBe(3);
  });

  it('conserve jetons et décision IA pour un message assistant', async () => {
    const { store, tx } = makePrisma();
    await store.appendMessage(
      10,
      { conversationId: '1', role: AsstMessageRole.Assistant, content: 'ok', promptTokens: 5, completionTokens: 6, aiDecisionId: '77' },
      NOW,
    );
    const data = tx.asstMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ promptTokens: 5, completionTokens: 6, aiDecisionId: 77n });
    expect(tx.asstConversation.update).toHaveBeenCalledWith({
      where: { asstConversationId: 1n },
      data: { lastMessageAt: NOW, updatedAt: NOW },
    });
  });

  it('retourne null (sans écriture) si l’échange n’est pas à l’utilisateur ou est masqué', async () => {
    const { store, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      store.appendMessage(10, { conversationId: '1', role: AsstMessageRole.User, content: 'x' }, NOW),
    ).resolves.toBeNull();
    expect(tx.asstMessage.create).not.toHaveBeenCalled();
  });

  it('refuse un contenu vide ou trop long (erreur de programmation)', async () => {
    const { store } = makePrisma();
    await expect(
      store.appendMessage(10, { conversationId: '1', role: AsstMessageRole.User, content: '   ' }, NOW),
    ).rejects.toThrow();
    await expect(
      store.appendMessage(10, { conversationId: '1', role: AsstMessageRole.User, content: 'a'.repeat(20_001) }, NOW),
    ).rejects.toThrow();
  });
});

describe('AsstProposalStoreService — createProposal', () => {
  it('crée à l’état 0, version 0, avec le hash des actions', async () => {
    const { store, prisma } = makePrisma();
    const dto = await store.createProposal(newProposal(), NOW);
    const data = prisma.asstProposal.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 0, rowVersion: 0, conversationId: 1n, messageId: 2n, createdAt: NOW });
    expect(dto.status).toBe(AsstProposalStatus.Proposed);
  });

  it('refuse un hash différent', async () => {
    const { store, prisma } = makePrisma();
    await expect(store.createProposal(newProposal({ argsHash: 'b'.repeat(64) }), NOW)).rejects.toThrow(/argsHash/);
    expect(prisma.asstProposal.create).not.toHaveBeenCalled();
  });

  it('refuse des actions invalides ou vides', async () => {
    const { store } = makePrisma();
    await expect(store.createProposal(newProposal({ actions: [] }), NOW)).rejects.toThrow(/actions invalides/);
    await expect(
      store.createProposal(newProposal({ actions: [{ tool: 'inconnu', args: {} }] }), NOW),
    ).rejects.toThrow(/actions invalides/);
  });

  it('refuse un résumé vide ou trop long', async () => {
    const { store } = makePrisma();
    await expect(store.createProposal(newProposal({ summary: '  ' }), NOW)).rejects.toThrow(/résumé/);
    await expect(store.createProposal(newProposal({ summary: 'a'.repeat(2_001) }), NOW)).rejects.toThrow(/résumé/);
  });

  it('refuse une échéance passée, égale à now, ou au-delà du TTL (marge d’une seconde)', async () => {
    const { store } = makePrisma();
    await expect(store.createProposal(newProposal({ expiresAt: NOW }), NOW)).rejects.toThrow(/échéance/);
    await expect(store.createProposal(newProposal({ expiresAt: at(-1) }), NOW)).rejects.toThrow(/échéance/);
    await expect(
      store.createProposal(newProposal({ expiresAt: new Date(at(ASST_PROPOSAL_TTL_MINUTES).getTime() + 1_500) }), NOW),
    ).rejects.toThrow(/échéance/);
    await expect(
      store.createProposal(newProposal({ expiresAt: new Date(at(ASST_PROPOSAL_TTL_MINUTES).getTime() + 1_000) }), NOW),
    ).resolves.toBeDefined();
  });
});

describe('AsstProposalStoreService — transitionProposal', () => {
  const base = {
    proposalId: '5',
    expectedRowVersion: 0,
    expectedStatus: AsstProposalStatus.Proposed,
    to: AsstProposalStatus.Confirmed,
    now: NOW,
  } as const;

  it('0->1 : compare-and-set, confirmedAt renseigné, version incrémentée', async () => {
    const { store, prisma } = makePrisma();
    const dto = await store.transitionProposal(base);
    expect(prisma.asstProposal.updateMany).toHaveBeenCalledWith({
      where: { asstProposalId: 5n, status: 0, rowVersion: 0 },
      data: { status: 1, rowVersion: { increment: 1 }, updatedAt: NOW, confirmedAt: NOW },
    });
    expect(dto?.status).toBe(AsstProposalStatus.Confirmed);
  });

  it('1->2 : finishedAt et résultat ; 1->5 : code et message d’erreur ; 0->3 : finishedAt seul', async () => {
    const { store, prisma } = makePrisma();
    await store.transitionProposal({
      ...base,
      expectedStatus: 1,
      expectedRowVersion: 1,
      to: AsstProposalStatus.Applied,
      result: { effects: [] },
    });
    expect(prisma.asstProposal.updateMany.mock.calls[0][0].data).toEqual({
      status: 2,
      rowVersion: { increment: 1 },
      updatedAt: NOW,
      finishedAt: NOW,
      result: { effects: [] },
    });
    await store.transitionProposal({
      ...base,
      expectedStatus: 1,
      expectedRowVersion: 1,
      to: AsstProposalStatus.Failed,
      errorCode: 'effect_failed',
      errorMessage: 'Échec.',
    });
    expect(prisma.asstProposal.updateMany.mock.calls[1][0].data).toMatchObject({
      status: 5,
      finishedAt: NOW,
      errorCode: 'effect_failed',
      errorMessage: 'Échec.',
    });
    await store.transitionProposal({ ...base, to: AsstProposalStatus.Refused, result: { effects: [] } });
    const data = prisma.asstProposal.updateMany.mock.calls[2][0].data;
    expect(data).toEqual({ status: 3, rowVersion: { increment: 1 }, updatedAt: NOW, finishedAt: NOW });
  });

  it('transition non listée : erreur de programmation, aucune écriture', async () => {
    const { store, prisma } = makePrisma();
    await expect(store.transitionProposal({ ...base, to: AsstProposalStatus.Applied })).rejects.toThrow(/illégale/);
    await expect(
      store.transitionProposal({ ...base, expectedStatus: AsstProposalStatus.Applied, to: AsstProposalStatus.Failed }),
    ).rejects.toThrow(/illégale/);
    expect(prisma.asstProposal.updateMany).not.toHaveBeenCalled();
  });

  it('count 0 -> null (verrou optimiste perdu)', async () => {
    const { store, prisma } = makePrisma();
    prisma.asstProposal.updateMany.mockResolvedValue({ count: 0 });
    await expect(store.transitionProposal(base)).resolves.toBeNull();
    expect(prisma.asstProposal.findUnique).not.toHaveBeenCalled();
  });

  it('écrit dans la transaction fournie (t.db) et pas dans le client', async () => {
    const { store, prisma } = makePrisma();
    const db = {
      asstProposal: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(proposalRow({ status: 1, rowVersion: 1 })),
      },
    };
    const dto = await store.transitionProposal({ ...base, db });
    expect(db.asstProposal.updateMany).toHaveBeenCalledTimes(1);
    expect(db.asstProposal.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.asstProposal.updateMany).not.toHaveBeenCalled();
    expect(dto?.rowVersion).toBe(1);
  });

  it('laisse remonter telle quelle l’erreur de la base (déclencheur)', async () => {
    const { store, prisma } = makePrisma();
    const err = new Error('proposition expirée, confirmation refusée');
    prisma.asstProposal.updateMany.mockRejectedValue(err);
    await expect(store.transitionProposal(base)).rejects.toBe(err);
  });
});

describe('AsstProposalStoreService — listes de balayage', () => {
  it('listExpirableProposals : statut 0, échéance <= now, tri échéance puis id, borné', async () => {
    const { store, prisma } = makePrisma();
    await store.listExpirableProposals(NOW, 20);
    expect(prisma.asstProposal.findMany).toHaveBeenCalledWith({
      where: { status: 0, expiresAt: { lte: NOW } },
      orderBy: [{ expiresAt: 'asc' }, { asstProposalId: 'asc' }],
      take: 20,
    });
  });

  it('listStaleConfirmedProposals : statut 1, confirmedAt < before, tri ancienneté puis id, borné', async () => {
    const { store, prisma } = makePrisma();
    await store.listStaleConfirmedProposals(NOW, 7);
    expect(prisma.asstProposal.findMany).toHaveBeenCalledWith({
      where: { status: 1, confirmedAt: { lt: NOW } },
      orderBy: [{ confirmedAt: 'asc' }, { asstProposalId: 'asc' }],
      take: 7,
    });
  });
});
