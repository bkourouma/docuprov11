import {
  AsstActionTool,
  AsstMessageRole,
  AsstProposalStatus,
  asstProposedActionsSchema,
  type AsstProposedAction,
} from '@archivage/types';
import type { AsstProposalDto } from '@archivage/types';
import { InMemoryProposalStore, sha256Actions } from './in-memory-proposal-store';
import { FakeAsstIdentity, makeAsstIdentity } from './fake-identity';
import { AsstError } from '../assistant.contracts';

const T0 = new Date('2026-11-22T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const actions: AsstProposedAction[] = [
  {
    tool: AsstActionTool.Relance,
    args: { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'Merci de traiter ce courrier.' },
  },
];

async function seed(store: InMemoryProposalStore, userId = 1) {
  const conv = await store.createConversation({ userId, userGroupId: userId * 10, title: 'Essai', now: T0 });
  const msg = await store.appendMessage(
    userId,
    { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'Je propose une relance.' },
    T0,
  );
  if (!msg) throw new Error('message attendu');
  const proposal = await store.createProposal(
    {
      conversationId: conv.conversationId,
      messageId: msg.messageId,
      userId,
      userGroupId: userId * 10,
      actions,
      summary: 'Relancer le destinataire.',
      argsHash: sha256Actions(actions),
      expiresAt: at(15),
    },
    T0,
  );
  return { conv, msg, proposal };
}

function transition(p: AsstProposalDto, to: AsstProposalStatus, now: Date, extra: Record<string, unknown> = {}) {
  return {
    proposalId: p.proposalId,
    expectedRowVersion: p.rowVersion,
    expectedStatus: p.status,
    to,
    now,
    ...extra,
  };
}

describe('sha256Actions', () => {
  it('renvoie un SHA-256 hex stable, indépendant de l’ordre des clés', () => {
    const h = sha256Actions(actions);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const reordered = [{ args: { ...actions[0]!.args }, tool: actions[0]!.tool }] as AsstProposedAction[];
    expect(sha256Actions(reordered)).toBe(h);
    expect(asstProposedActionsSchema.safeParse(actions).success).toBe(true);
  });
});

describe('InMemoryProposalStore : conversations et messages', () => {
  it('crée des conversations aux identifiants chaîne croissants, dates ISO UTC, rétention', async () => {
    const store = new InMemoryProposalStore();
    const a = await store.createConversation({ userId: 1, userGroupId: 10, now: T0 });
    const b = await store.createConversation({
      userId: 1,
      userGroupId: 10,
      title: 'Titre',
      pageContext: { route: '/mails', subjectType: 'mail', subjectId: '12' },
      now: at(1),
    });
    expect(a.conversationId).toBe('1');
    expect(b.conversationId).toBe('2');
    expect(a.title).toBeNull();
    expect(a.createdAt).toBe('2026-11-22T10:00:00.000Z');
    expect(a.purgeAt).toBe('2027-02-20T10:00:00.000Z');
    expect(a.messageCount).toBe(0);
    expect(b.pageContext).toEqual({ route: '/mails', subjectType: 'mail', subjectId: '12' });
  });

  it('numérote les messages par conversation et met à jour messageCount / lastMessageAt', async () => {
    const store = new InMemoryProposalStore();
    const c1 = await store.createConversation({ userId: 1, userGroupId: 10, now: T0 });
    const c2 = await store.createConversation({ userId: 1, userGroupId: 10, now: T0 });
    const m1 = await store.appendMessage(1, { conversationId: c1.conversationId, role: AsstMessageRole.User, content: 'a' }, at(1));
    const m2 = await store.appendMessage(1, { conversationId: c1.conversationId, role: AsstMessageRole.Assistant, content: 'b', promptTokens: 3, completionTokens: 4 }, at(2));
    const n1 = await store.appendMessage(1, { conversationId: c2.conversationId, role: AsstMessageRole.User, content: 'c' }, at(3));
    expect([m1?.position, m2?.position, n1?.position]).toEqual([1, 2, 1]);
    expect(m2?.messageId).toBe('2');
    const detail = await store.getConversation(1, c1.conversationId);
    expect(detail?.messages.map((m) => m.content)).toEqual(['a', 'b']);
    expect(detail?.conversation.messageCount).toBe(2);
    expect(detail?.conversation.lastMessageAt).toBe(at(2).toISOString());
    expect(detail?.conversation.updatedAt).toBe(at(2).toISOString());
  });

  it('refuse (erreur) un contenu vide et des jetons sur un message utilisateur', async () => {
    const store = new InMemoryProposalStore();
    const c = await store.createConversation({ userId: 1, userGroupId: 10, now: T0 });
    await expect(store.appendMessage(1, { conversationId: c.conversationId, role: AsstMessageRole.User, content: '  ' }, T0)).rejects.toThrow();
    await expect(
      store.appendMessage(1, { conversationId: c.conversationId, role: AsstMessageRole.User, content: 'x', promptTokens: 1 }, T0),
    ).rejects.toThrow();
  });

  it('trie par mise à jour décroissante, pagine et compte le total', async () => {
    const store = new InMemoryProposalStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push((await store.createConversation({ userId: 1, userGroupId: 10, now: at(i) })).conversationId);
    }
    // Un message récent remonte la conversation la plus ancienne en tête.
    await store.appendMessage(1, { conversationId: ids[0]!, role: AsstMessageRole.User, content: 'x' }, at(10));
    const page1 = await store.listConversations(1, { limit: 2, offset: 0 });
    const page2 = await store.listConversations(1, { limit: 2, offset: 2 });
    const page3 = await store.listConversations(1, { limit: 2, offset: 4 });
    expect(page1.total).toBe(5);
    expect(page1.items.map((c) => c.conversationId)).toEqual([ids[0], ids[4]]);
    expect(page2.items.map((c) => c.conversationId)).toEqual([ids[3], ids[2]]);
    expect(page3.items.map((c) => c.conversationId)).toEqual([ids[1]]);
  });

  it('isole les utilisateurs : l’objet d’un autre donne null / false, jamais une erreur', async () => {
    const store = new InMemoryProposalStore();
    const { conv, proposal } = await seed(store, 1);
    expect(await store.getConversation(2, conv.conversationId)).toBeNull();
    expect(await store.appendMessage(2, { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'intrus' }, T0)).toBeNull();
    expect(await store.deleteConversation(2, conv.conversationId, T0)).toBe(false);
    expect(await store.getProposal(2, proposal.proposalId)).toBeNull();
    expect((await store.listConversations(2, { limit: 10, offset: 0 })).total).toBe(0);
    // Le propriétaire n'est pas affecté.
    expect(await store.getConversation(1, conv.conversationId)).not.toBeNull();
    expect(await store.getProposal(1, proposal.proposalId)).not.toBeNull();
    // Identifiants invalides ou inconnus.
    expect(await store.getConversation(1, '999')).toBeNull();
    expect(await store.getConversation(1, 'abc')).toBeNull();
    expect(await store.getProposal(1, '999')).toBeNull();
  });

  it('masque une conversation supprimée partout (lecture, liste, messages, propositions)', async () => {
    const store = new InMemoryProposalStore();
    const { conv, proposal } = await seed(store, 1);
    expect(await store.deleteConversation(1, conv.conversationId, at(5))).toBe(true);
    expect(await store.getConversation(1, conv.conversationId)).toBeNull();
    expect((await store.listConversations(1, { limit: 10, offset: 0 })).items).toEqual([]);
    expect(await store.getProposal(1, proposal.proposalId)).toBeNull();
    expect(await store.appendMessage(1, { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'x' }, at(6))).toBeNull();
    expect(await store.deleteConversation(1, conv.conversationId, at(7))).toBe(false);
  });

  it('rattache les propositions à leur message dans getConversation', async () => {
    const store = new InMemoryProposalStore();
    const { conv, msg, proposal } = await seed(store);
    const detail = await store.getConversation(1, conv.conversationId);
    const m = detail?.messages.find((x) => x.messageId === msg.messageId);
    expect(m?.proposals.map((p) => p.proposalId)).toEqual([proposal.proposalId]);
  });

  it('renvoie des copies : modifier un DTO ne corrompt pas le magasin', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    (proposal.actions[0]!.args as { message: string }).message = 'altéré';
    const again = await store.getProposal(1, proposal.proposalId);
    expect((again?.actions[0]!.args as { message: string }).message).toBe('Merci de traiter ce courrier.');
  });
});

describe('InMemoryProposalStore : propositions', () => {
  it('crée une proposition « proposée », version 0, champs de fin vides', async () => {
    const store = new InMemoryProposalStore();
    const { proposal, conv, msg } = await seed(store);
    expect(proposal).toMatchObject({
      proposalId: '1',
      conversationId: conv.conversationId,
      messageId: msg.messageId,
      status: AsstProposalStatus.Proposed,
      rowVersion: 0,
      confirmedAt: null,
      finishedAt: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      expiresAt: at(15).toISOString(),
      createdAt: T0.toISOString(),
    });
    expect(proposal.argsHash).toBe(sha256Actions(actions));
  });

  it('valide les entrées de createProposal', async () => {
    const store = new InMemoryProposalStore();
    const conv = await store.createConversation({ userId: 1, userGroupId: 10, now: T0 });
    const msg = await store.appendMessage(1, { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'ok' }, T0);
    const base = {
      conversationId: conv.conversationId,
      messageId: msg!.messageId,
      userId: 1,
      userGroupId: 10,
      actions,
      summary: 'Résumé',
      argsHash: sha256Actions(actions),
      expiresAt: at(15),
    };
    await expect(store.createProposal({ ...base, actions: [] }, T0)).rejects.toThrow(/actions invalides/);
    await expect(
      store.createProposal({ ...base, actions: [{ tool: 'inconnu', args: {} } as unknown as AsstProposedAction] }, T0),
    ).rejects.toThrow(/actions invalides/);
    await expect(store.createProposal({ ...base, argsHash: 'ABC' }, T0)).rejects.toThrow(/argsHash/);
    await expect(store.createProposal({ ...base, argsHash: 'A'.repeat(64) }, T0)).rejects.toThrow(/argsHash/);
    await expect(store.createProposal({ ...base, summary: '  ' }, T0)).rejects.toThrow(/résumé/);
    await expect(store.createProposal({ ...base, expiresAt: T0 }, T0)).rejects.toThrow(/expires_at/);
    await expect(store.createProposal({ ...base, userId: 2 }, T0)).rejects.toThrow(/conversation/);
    await expect(store.createProposal({ ...base, messageId: '999' }, T0)).rejects.toThrow(/message/);
  });

  it('cycle de vie : proposée -> confirmée -> appliquée (résultat, dates, versions)', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    const confirmed = await store.transitionProposal(transition(proposal, AsstProposalStatus.Confirmed, at(2)));
    expect(confirmed).toMatchObject({
      status: AsstProposalStatus.Confirmed,
      rowVersion: 1,
      confirmedAt: at(2).toISOString(),
      finishedAt: null,
    });
    const result = { effects: [{ tool: AsstActionTool.Relance, summary: { notified: 1 } }] };
    const applied = await store.transitionProposal(transition(confirmed!, AsstProposalStatus.Applied, at(3), { result }));
    expect(applied).toMatchObject({
      status: AsstProposalStatus.Applied,
      rowVersion: 2,
      confirmedAt: at(2).toISOString(),
      finishedAt: at(3).toISOString(),
      result,
      errorCode: null,
    });
    expect(await store.getProposal(1, proposal.proposalId)).toEqual(applied);
  });

  it('cycle de vie : confirmée -> échec (code et message d’erreur)', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    const confirmed = await store.transitionProposal(transition(proposal, AsstProposalStatus.Confirmed, at(1)));
    const failed = await store.transitionProposal(
      transition(confirmed!, AsstProposalStatus.Failed, at(2), { errorCode: 'effect_failed', errorMessage: 'Refus métier.' }),
    );
    expect(failed).toMatchObject({
      status: AsstProposalStatus.Failed,
      errorCode: 'effect_failed',
      errorMessage: 'Refus métier.',
      confirmedAt: at(1).toISOString(),
      finishedAt: at(2).toISOString(),
      result: null,
    });
  });

  it('refus : proposée -> refusée, clôture sans date de confirmation', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    const refused = await store.transitionProposal(transition(proposal, AsstProposalStatus.Refused, at(1)));
    expect(refused).toMatchObject({ status: AsstProposalStatus.Refused, confirmedAt: null, finishedAt: at(1).toISOString(), rowVersion: 1 });
  });

  it('CAS : version ou statut obsolètes -> null, sans effet', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    expect(await store.transitionProposal({ ...transition(proposal, AsstProposalStatus.Confirmed, at(1)), expectedRowVersion: 5 })).toBeNull();
    expect(await store.transitionProposal({ ...transition(proposal, AsstProposalStatus.Applied, at(1)), expectedStatus: AsstProposalStatus.Confirmed })).toBeNull();
    expect(await store.transitionProposal({ ...transition(proposal, AsstProposalStatus.Confirmed, at(1)), proposalId: '999' })).toBeNull();
    expect((await store.getProposal(1, proposal.proposalId))?.rowVersion).toBe(0);
  });

  it('CAS concurrent : deux transitions avec la même version, une seule gagne', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    const [a, b] = await Promise.all([
      store.transitionProposal(transition(proposal, AsstProposalStatus.Confirmed, at(1))),
      store.transitionProposal(transition(proposal, AsstProposalStatus.Refused, at(1))),
    ]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
    expect((await store.getProposal(1, proposal.proposalId))?.rowVersion).toBe(1);
  });

  it('transitions illégales : lèvent une Error explicite', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Applied, at(1)))).rejects.toThrow(/illégale/);
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Failed, at(1), { errorCode: 'x' }))).rejects.toThrow(/illégale/);
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Proposed, at(1)))).rejects.toThrow(/illégale/);
    const confirmed = await store.transitionProposal(transition(proposal, AsstProposalStatus.Confirmed, at(1)));
    await expect(store.transitionProposal(transition(confirmed!, AsstProposalStatus.Refused, at(2)))).rejects.toThrow(/illégale/);
    await expect(store.transitionProposal(transition(confirmed!, AsstProposalStatus.Expired, at(20)))).rejects.toThrow(/illégale/);
    // Aucune écriture après un refus.
    expect((await store.getProposal(1, proposal.proposalId))?.rowVersion).toBe(1);
  });

  it('ligne terminale figée : plus aucune transition', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    const refused = await store.transitionProposal(transition(proposal, AsstProposalStatus.Refused, at(1)));
    for (const to of [AsstProposalStatus.Confirmed, AsstProposalStatus.Proposed, AsstProposalStatus.Refused]) {
      await expect(store.transitionProposal(transition(refused!, to, at(2)))).rejects.toThrow(/figée/);
    }
  });

  it('confirmation refusée à l’échéance et après (expiresAt <= now)', async () => {
    const store = new InMemoryProposalStore();
    const a = await seed(store);
    await expect(store.transitionProposal(transition(a.proposal, AsstProposalStatus.Confirmed, at(15)))).rejects.toThrow(/expirée/);
    await expect(store.transitionProposal(transition(a.proposal, AsstProposalStatus.Confirmed, at(40)))).rejects.toThrow(/expirée/);
    // Juste avant l'échéance : acceptée.
    const ok = await store.transitionProposal(transition(a.proposal, AsstProposalStatus.Confirmed, new Date(at(15).getTime() - 1)));
    expect(ok?.status).toBe(AsstProposalStatus.Confirmed);
  });

  it('expiration refusée avant l’échéance, acceptée à l’échéance', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Expired, at(14)))).rejects.toThrow(/non échue/);
    const expired = await store.transitionProposal(transition(proposal, AsstProposalStatus.Expired, at(15)));
    expect(expired).toMatchObject({ status: AsstProposalStatus.Expired, confirmedAt: null, finishedAt: at(15).toISOString() });
  });

  it('result seulement pour Appliquée ; errorCode/errorMessage seulement pour Échec (code obligatoire et valide)', async () => {
    const store = new InMemoryProposalStore();
    const { proposal } = await seed(store);
    const result = { effects: [] };
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Refused, at(1), { result }))).rejects.toThrow(/result/);
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Refused, at(1), { errorCode: 'x_y' }))).rejects.toThrow(/errorCode/);
    await expect(store.transitionProposal(transition(proposal, AsstProposalStatus.Confirmed, at(1), { errorMessage: 'm' }))).rejects.toThrow(/errorCode/);
    const confirmed = await store.transitionProposal(transition(proposal, AsstProposalStatus.Confirmed, at(1)));
    await expect(store.transitionProposal(transition(confirmed!, AsstProposalStatus.Failed, at(2)))).rejects.toThrow(/errorCode/);
    await expect(
      store.transitionProposal(transition(confirmed!, AsstProposalStatus.Failed, at(2), { errorCode: 'Mauvais Code' })),
    ).rejects.toThrow(/errorCode/);
    await expect(store.transitionProposal(transition(confirmed!, AsstProposalStatus.Failed, at(2), { errorCode: 'ok', result }))).rejects.toThrow(/result/);
    // Aucune de ces tentatives n'a modifié la ligne.
    expect((await store.getProposal(1, proposal.proposalId))?.rowVersion).toBe(1);
  });

  it('listExpirableProposals : seules les « proposées » échues, triées par échéance, bornées', async () => {
    const store = new InMemoryProposalStore();
    const conv = await store.createConversation({ userId: 1, userGroupId: 10, now: T0 });
    const msg = await store.appendMessage(1, { conversationId: conv.conversationId, role: AsstMessageRole.Assistant, content: 'ok' }, T0);
    const make = (expiresAt: Date) =>
      store.createProposal(
        { conversationId: conv.conversationId, messageId: msg!.messageId, userId: 1, userGroupId: 10, actions, summary: 's', argsHash: sha256Actions(actions), expiresAt },
        T0,
      );
    const late = await make(at(30));
    const early = await make(at(5));
    const mid = await make(at(10));
    const confirmedOne = await make(at(8));
    await store.transitionProposal(transition(confirmedOne, AsstProposalStatus.Confirmed, at(1)));
    const none = await store.listExpirableProposals(at(4), 10);
    expect(none).toEqual([]);
    const due = await store.listExpirableProposals(at(12), 10);
    expect(due.map((p) => p.proposalId)).toEqual([early.proposalId, mid.proposalId]);
    expect((await store.listExpirableProposals(at(60), 2)).map((p) => p.proposalId)).toEqual([early.proposalId, mid.proposalId]);
    expect((await store.listExpirableProposals(at(60), 10)).map((p) => p.proposalId)).toEqual([early.proposalId, mid.proposalId, late.proposalId]);
    // Une proposition expirée par le job sort de la liste.
    await store.transitionProposal(transition(early, AsstProposalStatus.Expired, at(12)));
    expect((await store.listExpirableProposals(at(12), 10)).map((p) => p.proposalId)).toEqual([mid.proposalId]);
  });
});

describe('FakeAsstIdentity', () => {
  const token = (userId: number) => ({ userId, username: 'x', isAdmin: false, userGroupId: userId * 10 });

  it('résout selon la table, refuse l’inconnu, le refus simulé et l’identité machine', async () => {
    const alice = makeAsstIdentity(1, { isAdmin: true });
    const fake = new FakeAsstIdentity([alice]);
    await expect(fake.resolve(token(1))).resolves.toBe(alice);
    await expect(fake.resolve(token(2))).rejects.toBeInstanceOf(AsstError);
    fake.refuse(1);
    await expect(fake.resolve(token(1))).rejects.toMatchObject({ errorCode: 'identity_refused' });
    fake.allow(1);
    await expect(fake.resolve(token(1))).resolves.toBe(alice);
    await expect(fake.resolve({ ...token(1), isScanAgent: true })).rejects.toMatchObject({ errorCode: 'identity_refused' });
  });
});
