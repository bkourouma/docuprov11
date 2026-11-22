import {
  ASST_ASSISTANT_MESSAGE_MAX_CHARS,
  ASST_PROPOSAL_TTL_MINUTES,
  AsstActionTool,
  AsstMessageRole,
  AsstProposalStatus,
  type AsstProposedAction,
} from '@archivage/types';
import {
  AsstError,
  type AsstGatePort,
  type AsstPlanInput,
  type AsstPlanResult,
  type AsstPlannerPort,
} from '../assistant.contracts';
import { formatClarificationContent } from '../planner/clarification-format';
import { PLANNER_HISTORY_MAX_MESSAGES } from '../planner/planner.types';
import { asstArgsHash } from '../store/asst-proposal-hash';
import { InMemoryProposalStore, makeAsstIdentity, sha256Actions } from '../testing';
import { AsstConversationsService } from './asst-conversations.service';
import { AsstMessageRateLimiter } from './asst-message-rate-limiter';

const T0 = new Date('2026-11-22T10:00:00.000Z');

const ACTIONS: AsstProposedAction[] = [
  {
    tool: AsstActionTool.Relance,
    args: { mailId: 1, mailInputationId: 2, recipientUserGroupId: 3, message: 'Merci de traiter ce courrier.' },
  },
];

class ScriptedPlanner implements AsstPlannerPort {
  readonly calls: AsstPlanInput[] = [];
  private queue: Array<AsstPlanResult | Error> = [];
  script(...items: Array<AsstPlanResult | Error>): this {
    this.queue = items;
    return this;
  }
  async plan(input: AsstPlanInput): Promise<AsstPlanResult> {
    this.calls.push(input);
    const next = this.queue.shift();
    if (!next) throw new Error('planificateur : aucun résultat scripté');
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeGate implements AsstGatePort {
  refuse: AsstError | null = null;
  asserted: number[] = [];
  async assertRunnable(userId: number): Promise<void> {
    this.asserted.push(userId);
    if (this.refuse) throw this.refuse;
  }
  reserve = jest.fn();
  settle = jest.fn();
  release = jest.fn();
  userCap = jest.fn();
}

const plain = (reply = 'Bonjour, comment puis-je aider ?'): AsstPlanResult => ({
  reply,
  actions: [],
  summary: null,
  usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 },
});

const withAction = (): AsstPlanResult => ({
  reply: 'Je propose une relance.',
  actions: ACTIONS,
  summary: 'Relancer le destinataire du courrier 1.',
  usage: { promptTokens: 120, completionTokens: 40, cost: 0.02 },
  aiDecisionId: 'dec-1',
});

function setup(limit = 100) {
  const store = new InMemoryProposalStore();
  const planner = new ScriptedPlanner();
  const gate = new FakeGate();
  const limiter = new AsstMessageRateLimiter({ limit });
  const service = new AsstConversationsService(store, planner, gate, limiter);
  service.now = () => T0;
  const alice = makeAsstIdentity(1);
  const bob = makeAsstIdentity(2);
  return { store, planner, gate, service, alice, bob };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<AsstError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AsstError);
  expect((err as AsstError).errorCode).toBe(code);
  return err as AsstError;
}

describe('AsstConversationsService : create', () => {
  it('vérifie la porte puis crée l’échange pour l’utilisateur et son groupe', async () => {
    const { service, gate, alice } = setup();
    const conv = await service.create(alice, { title: 'Mon échange', pageContext: { route: '/courriers' } });
    expect(gate.asserted).toEqual([1]);
    expect(conv.title).toBe('Mon échange');
    expect(conv.pageContext).toEqual({ route: '/courriers' });
    expect(conv.createdAt).toBe(T0.toISOString());
    expect(conv.messageCount).toBe(0);
  });

  it('sans titre ni contexte : champs nuls', async () => {
    const { service, alice } = setup();
    const conv = await service.create(alice, {});
    expect(conv.title).toBeNull();
    expect(conv.pageContext).toBeNull();
  });

  it('porte refusée (IA désactivée) : erreur 503 propagée, rien de créé', async () => {
    const { service, gate, store, alice } = setup();
    gate.refuse = new AsstError('assistant_unavailable', 'Assistant indisponible.');
    await expectCode(service.create(alice, {}), 'assistant_unavailable');
    expect((await store.listConversations(1, { limit: 10, offset: 0 })).total).toBe(0);
  });
});

describe('AsstConversationsService : list', () => {
  it('liste paginée de l’utilisateur seul', async () => {
    const { service, alice, bob } = setup();
    for (let i = 0; i < 5; i++) await service.create(alice, { title: `E${i}` });
    await service.create(bob, { title: 'Autre' });
    const page1 = await service.list(alice, { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    const page3 = await service.list(alice, { limit: 2, offset: 4 });
    expect(page3.items).toHaveLength(1);
    const ids = new Set([...page1.items, ...page3.items].map((c) => c.conversationId));
    expect(ids.size).toBe(3);
    expect((await service.list(bob, { limit: 10, offset: 0 })).total).toBe(1);
  });
});

describe('AsstConversationsService : detail', () => {
  it('renvoie l’échange et ses messages', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(plain());
    await service.postMessage(alice, conv.conversationId, { content: 'Bonjour' });
    const d = await service.detail(alice, conv.conversationId);
    expect(d.messages.map((m) => m.role)).toEqual([AsstMessageRole.User, AsstMessageRole.Assistant]);
    expect(d.messages.every((m) => m.clarification === undefined)).toBe(true);
  });

  it('échange d’un autre utilisateur : not_found', async () => {
    const { service, alice, bob } = setup();
    const conv = await service.create(alice, {});
    await expectCode(service.detail(bob, conv.conversationId), 'not_found');
  });

  it('échange inexistant ou identifiant invalide : not_found', async () => {
    const { service, alice } = setup();
    await expectCode(service.detail(alice, '999'), 'not_found');
    await expectCode(service.detail(alice, 'abc'), 'not_found');
  });

  it('échange masqué : not_found', async () => {
    const { service, alice } = setup();
    const conv = await service.create(alice, {});
    await service.remove(alice, conv.conversationId);
    await expectCode(service.detail(alice, conv.conversationId), 'not_found');
  });

  it('clarification restituée sur le DERNIER message assistant sans proposition seulement', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    const content = formatClarificationContent('Quel destinataire ?', ['La DAF', 'La DRH']);
    planner.script(plain(content), plain(content));
    await service.postMessage(alice, conv.conversationId, { content: 'Impute' });
    const d1 = await service.detail(alice, conv.conversationId);
    expect(d1.messages[1]?.clarification).toEqual({ question: 'Quel destinataire ?', choices: ['La DAF', 'La DRH'] });
    expect(d1.messages[0]?.clarification).toBeUndefined();

    // Un message supplémentaire : l'ancienne question n'est plus le dernier message.
    await service.postMessage(alice, conv.conversationId, { content: 'La DAF' });
    const d2 = await service.detail(alice, conv.conversationId);
    expect(d2.messages).toHaveLength(4);
    expect(d2.messages[1]?.clarification).toBeUndefined();
    expect(d2.messages[3]?.clarification).toEqual({ question: 'Quel destinataire ?', choices: ['La DAF', 'La DRH'] });
  });

  it('pas de clarification sur un message à proposition ni sur un message utilisateur', async () => {
    const { service, planner, store, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(withAction());
    await service.postMessage(alice, conv.conversationId, { content: '1. a\n2. b' });
    const d = await service.detail(alice, conv.conversationId);
    expect(d.messages[1]?.proposals).toHaveLength(1);
    expect(d.messages[1]?.clarification).toBeUndefined();
    // Dernier message = utilisateur au format liste : jamais de clarification.
    await store.appendMessage(1, { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'Q\n\n1. a\n2. b' }, T0);
    const d2 = await service.detail(alice, conv.conversationId);
    expect(d2.messages[2]?.clarification).toBeUndefined();
  });
});

describe('AsstConversationsService : remove', () => {
  it('masque l’échange (disparaît de la liste)', async () => {
    const { service, alice } = setup();
    const conv = await service.create(alice, {});
    await expect(service.remove(alice, conv.conversationId)).resolves.toBeUndefined();
    expect((await service.list(alice, { limit: 10, offset: 0 })).total).toBe(0);
  });

  it('inexistant, déjà masqué ou d’un autre utilisateur : not_found', async () => {
    const { service, alice, bob } = setup();
    const conv = await service.create(alice, {});
    await expectCode(service.remove(bob, conv.conversationId), 'not_found');
    await service.remove(alice, conv.conversationId);
    await expectCode(service.remove(alice, conv.conversationId), 'not_found');
    await expectCode(service.remove(alice, '4242'), 'not_found');
  });
});

describe('AsstConversationsService : postMessage', () => {
  it('nominal avec proposition : messages, jetons, proposition lisible, hash et échéance', async () => {
    const { service, planner, store, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(withAction());
    const res = await service.postMessage(alice, conv.conversationId, { content: 'Relance le courrier 1' });

    expect(res.userMessage).toMatchObject({ role: AsstMessageRole.User, content: 'Relance le courrier 1', position: 1 });
    expect(res.assistantMessage).toMatchObject({ role: AsstMessageRole.Assistant, content: 'Je propose une relance.', position: 2 });
    expect(res.conversation.messageCount).toBe(2);

    const [proposal] = res.assistantMessage.proposals;
    expect(res.assistantMessage.proposals).toHaveLength(1);
    expect(proposal).toBeDefined();
    expect(proposal?.status).toBe(AsstProposalStatus.Proposed);
    expect(proposal?.messageId).toBe(res.assistantMessage.messageId);
    expect(proposal?.actions).toEqual(ACTIONS);
    expect(proposal?.summary).toBe('Relancer le destinataire du courrier 1.');
    expect(proposal?.argsHash).toBe(asstArgsHash(ACTIONS));
    expect(proposal?.argsHash).toBe(sha256Actions(ACTIONS));
    expect(proposal?.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal?.createdAt).toBe(T0.toISOString());
    expect(Date.parse(proposal?.expiresAt ?? '') - Date.parse(proposal?.createdAt ?? '')).toBe(ASST_PROPOSAL_TTL_MINUTES * 60_000);
    expect(ASST_PROPOSAL_TTL_MINUTES).toBe(15);

    const reread = await store.getProposal(1, proposal?.proposalId ?? '');
    expect(reread).toEqual(proposal);
    expect(res.userMessage.proposals).toEqual([]);
  });

  it('les jetons et la décision IA sont enregistrés sur le message assistant (via le magasin)', async () => {
    const { service, planner, store, alice } = setup();
    const spy = jest.spyOn(store, 'appendMessage');
    const conv = await service.create(alice, {});
    planner.script(withAction());
    await service.postMessage(alice, conv.conversationId, { content: 'Relance' });
    expect(spy).toHaveBeenNthCalledWith(
      1,
      1,
      { conversationId: conv.conversationId, role: AsstMessageRole.User, content: 'Relance' },
      T0,
    );
    expect(spy).toHaveBeenNthCalledWith(
      2,
      1,
      expect.objectContaining({ role: AsstMessageRole.Assistant, promptTokens: 120, completionTokens: 40, aiDecisionId: 'dec-1' }),
      T0,
    );
  });

  it('le résumé construit par le planificateur est conservé tel quel', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    const plan = { ...withAction(), summary: '  Résumé  exact « tel quel » ; 3 jours.  ' };
    planner.script(plan);
    const res = await service.postMessage(alice, conv.conversationId, { content: 'x' });
    expect(res.assistantMessage.proposals[0]?.summary).toBe('  Résumé  exact « tel quel » ; 3 jours.  ');
  });

  it('sans action : réponse simple, aucune proposition, proposals vide', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(plain('Voici la réponse.'));
    const res = await service.postMessage(alice, conv.conversationId, { content: 'Question' });
    expect(res.assistantMessage.proposals).toEqual([]);
    expect(res.assistantMessage.clarification).toBeUndefined();
    expect(res.assistantMessage.content).toBe('Voici la réponse.');
  });

  it('question de précision : clarification renvoyée, pas de proposition', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    const clarification = { question: 'Quel délai ?', choices: ['3 jours', '5 jours'] };
    planner.script({ ...plain(formatClarificationContent('Quel délai ?', clarification.choices)), clarification });
    const res = await service.postMessage(alice, conv.conversationId, { content: 'Impute vite' });
    expect(res.assistantMessage.clarification).toEqual(clarification);
    expect(res.assistantMessage.proposals).toEqual([]);
    expect(res.assistantMessage.content).toBe('Quel délai ?\n\n1. 3 jours\n2. 5 jours');
  });

  it('un message ne crée jamais de proposition confirmée (toujours statut 0, version 0)', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(withAction(), withAction());
    const a = await service.postMessage(alice, conv.conversationId, { content: 'un' });
    const b = await service.postMessage(alice, conv.conversationId, { content: 'deux' });
    for (const p of [...a.assistantMessage.proposals, ...b.assistantMessage.proposals]) {
      expect(p.status).toBe(AsstProposalStatus.Proposed);
      expect(p.confirmedAt).toBeNull();
      expect(p.finishedAt).toBeNull();
      expect(p.result).toBeNull();
      expect(p.rowVersion).toBe(0);
    }
  });

  it('échec du planificateur : rien n’est persisté et l’erreur remonte telle quelle', async () => {
    const { service, planner, store, alice } = setup();
    const conv = await service.create(alice, {});
    const err = new AsstError('budget_exceeded', 'Plafond atteint.', { x: 1 });
    planner.script(err);
    await expect(service.postMessage(alice, conv.conversationId, { content: 'Salut' })).rejects.toBe(err);
    const d = await store.getConversation(1, conv.conversationId);
    expect(d?.messages).toEqual([]);

    planner.script(new AsstError('assistant_unavailable', 'Indisponible.'));
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'Salut' }), 'assistant_unavailable');
    planner.script(new Error('panne imprévue'));
    await expect(service.postMessage(alice, conv.conversationId, { content: 'Salut' })).rejects.toThrow('panne imprévue');
    expect((await store.getConversation(1, conv.conversationId))?.messages).toEqual([]);
  });

  it('nouvel essai propre après un échec du planificateur', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(new AsstError('assistant_unavailable', 'Indisponible.'), plain('Revoilà.'));
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'a' }), 'assistant_unavailable');
    const res = await service.postMessage(alice, conv.conversationId, { content: 'a' });
    expect(res.userMessage.position).toBe(1);
    expect(res.assistantMessage.position).toBe(2);
  });

  it('échange d’un autre utilisateur : not_found SANS appeler le planificateur', async () => {
    const { service, planner, alice, bob } = setup();
    const conv = await service.create(alice, {});
    planner.script(plain());
    await expectCode(service.postMessage(bob, conv.conversationId, { content: 'Intrusion' }), 'not_found');
    expect(planner.calls).toHaveLength(0);
  });

  it('échange inexistant ou masqué : not_found sans planificateur', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    await service.remove(alice, conv.conversationId);
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'x' }), 'not_found');
    await expectCode(service.postMessage(alice, '777', { content: 'x' }), 'not_found');
    expect(planner.calls).toHaveLength(0);
  });

  it('échange supprimé pendant la planification : not_found (appendMessage null)', async () => {
    const { service, planner, store, alice } = setup();
    const conv = await service.create(alice, {});
    planner.plan = async () => {
      await store.deleteConversation(1, conv.conversationId, T0);
      return plain();
    };
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'x' }), 'not_found');
  });

  it('historique borné : au plus PLANNER_HISTORY_MAX_MESSAGES derniers messages, AVANT le nouveau', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    const total = PLANNER_HISTORY_MAX_MESSAGES + 6;
    planner.script(...Array.from({ length: total }, (_, i) => plain(`réponse ${i}`)));
    for (let i = 0; i < total; i++) await service.postMessage(alice, conv.conversationId, { content: `question ${i}` });
    const last = planner.calls[planner.calls.length - 1];
    expect(last?.history).toHaveLength(PLANNER_HISTORY_MAX_MESSAGES);
    expect(last?.message).toBe(`question ${total - 1}`);
    expect(last?.history.some((h) => h.content === `question ${total - 1}`)).toBe(false);
    expect(last?.history[PLANNER_HISTORY_MAX_MESSAGES - 1]).toEqual({
      role: AsstMessageRole.Assistant,
      content: `réponse ${total - 2}`,
    });
    // Premier appel : historique vide.
    expect(planner.calls[0]?.history).toEqual([]);
  });

  it('transmet l’identité, l’échange et le message au planificateur', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(plain());
    await service.postMessage(alice, conv.conversationId, { content: 'Texte' });
    expect(planner.calls[0]).toMatchObject({ identity: alice, conversationId: conv.conversationId, message: 'Texte' });
  });

  it('pageContext : celui du corps, sinon celui de l’échange, sinon null', async () => {
    const { service, planner, alice } = setup();
    const withCtx = await service.create(alice, { pageContext: { route: '/a' } });
    const noCtx = await service.create(alice, {});
    planner.script(plain(), plain(), plain());
    await service.postMessage(alice, withCtx.conversationId, { content: 'x', pageContext: { route: '/b' } });
    await service.postMessage(alice, withCtx.conversationId, { content: 'y' });
    await service.postMessage(alice, noCtx.conversationId, { content: 'z' });
    expect(planner.calls.map((c) => c.pageContext)).toEqual([{ route: '/b' }, { route: '/a' }, null]);
  });

  it('réponse tronquée à ASST_ASSISTANT_MESSAGE_MAX_CHARS', async () => {
    const { service, planner, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(plain('a'.repeat(ASST_ASSISTANT_MESSAGE_MAX_CHARS + 500)));
    const res = await service.postMessage(alice, conv.conversationId, { content: 'x' });
    expect(res.assistantMessage.content).toHaveLength(ASST_ASSISTANT_MESSAGE_MAX_CHARS);
  });

  it('échec fermé : réponse vide, ou actions sans résumé = rien de persisté', async () => {
    const { service, planner, store, alice } = setup();
    const conv = await service.create(alice, {});
    planner.script(plain('   '), { ...withAction(), summary: null }, { ...withAction(), summary: '  ' });
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'x' }), 'assistant_unavailable');
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'x' }), 'assistant_unavailable');
    await expectCode(service.postMessage(alice, conv.conversationId, { content: 'x' }), 'assistant_unavailable');
    expect((await store.getConversation(1, conv.conversationId))?.messages).toEqual([]);
  });

  it('limite de débit : budget_exceeded avec retryAfterSeconds, sans planificateur', async () => {
    const { service, planner, alice, bob } = setup(2);
    const conv = await service.create(alice, {});
    const other = await service.create(bob, {});
    planner.script(plain(), plain(), plain());
    await service.postMessage(alice, conv.conversationId, { content: '1' });
    await service.postMessage(alice, conv.conversationId, { content: '2' });
    const err = await expectCode(service.postMessage(alice, conv.conversationId, { content: '3' }), 'budget_exceeded');
    expect(err.message).toBe('Trop de messages en peu de temps : patientez quelques instants.');
    expect(err.details).toEqual({ retryAfterSeconds: expect.any(Number) });
    expect(planner.calls).toHaveLength(2);
    // Un autre utilisateur n'est pas affecté.
    await expect(service.postMessage(bob, other.conversationId, { content: 'ok' })).resolves.toBeDefined();
  });

  it('sans limiteur injecté : un limiteur par défaut est créé', async () => {
    const store = new InMemoryProposalStore();
    const planner = new ScriptedPlanner().script(plain());
    const service = new AsstConversationsService(store, planner, new FakeGate());
    service.now = () => T0;
    const alice = makeAsstIdentity(1);
    const conv = await service.create(alice, {});
    await expect(service.postMessage(alice, conv.conversationId, { content: 'x' })).resolves.toBeDefined();
  });
});
