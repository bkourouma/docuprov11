// Orchestration confirmer / refuser / relire : faux api, état réel (réducteur), horloge et génération simulées.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/proposal-actions.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AsstConversationDto, AsstErrorCode, AsstMessageDto, AsstProposalDto } from '@archivage/types';
import { AssistantApiError } from '../../../lib/assistant-api';
import { chatReducer, initialChatState, type ChatAction, type ChatState } from './chat-state';
import {
  RELOAD_NEEDED,
  reloadProposalAction,
  runProposalAction,
  type ProposalActionDeps,
  type ProposalApi,
} from './proposal-actions';
import { createSubmitLock } from './proposal-logic';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const EXP = '2026-11-22T12:00:00.000Z';
const BEFORE = Date.parse('2026-11-22T11:00:00.000Z');

const conv: AsstConversationDto = {
  conversationId: '1',
  title: null,
  pageContext: null,
  createdAt: '2026-11-22T09:00:00.000Z',
  updatedAt: '2026-11-22T10:00:00.000Z',
  lastMessageAt: '2026-11-22T10:00:00.000Z',
  purgeAt: '2027-02-22T09:00:00.000Z',
  messageCount: 1,
};

const prop = (over: Partial<AsstProposalDto> = {}): AsstProposalDto => ({
  proposalId: 'p1',
  conversationId: '1',
  messageId: 'm1',
  status: 0,
  actions: [],
  summary: 's',
  argsHash: HASH_A,
  expiresAt: EXP,
  createdAt: '2026-11-22T10:00:00.000Z',
  confirmedAt: null,
  finishedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  rowVersion: 0,
  ...over,
});

const message = (proposals: AsstProposalDto[]): AsstMessageDto => ({
  messageId: 'm1',
  conversationId: '1',
  role: 1 as AsstMessageDto['role'],
  content: 'c',
  position: 1,
  createdAt: '2026-11-22T10:00:00.000Z',
  proposals,
});

const apiError = (status: number, errorCode: AsstErrorCode | null = null, proposal: AsstProposalDto | null = null) =>
  new AssistantApiError({ status, errorCode, proposal, kind: status === 0 ? 'network' : 'http' });

interface Call {
  op: 'confirm' | 'refuse' | 'get';
  id: string;
  argsHash?: string;
}

/** Banc d'essai : état réel via le réducteur, appels enregistrés, réponses pilotées une à une. */
function setup(initial: AsstProposalDto = prop()) {
  let state: ChatState = chatReducer(initialChatState, {
    type: 'conversationLoaded',
    conversation: conv,
    messages: [message([initial])],
  });
  const calls: Call[] = [];
  const dispatched: ChatAction[] = [];
  const env = { now: BEFORE, gen: 0, alive: true };
  const lock = createSubmitLock();
  /** File de réponses : fonction retournant la promesse de chaque appel, dans l'ordre. */
  const handlers: Record<'confirm' | 'refuse' | 'get', Array<() => Promise<AsstProposalDto>>> = {
    confirm: [],
    refuse: [],
    get: [],
  };
  const next = (op: 'confirm' | 'refuse' | 'get'): Promise<AsstProposalDto> => {
    const h = handlers[op].shift();
    if (!h) return Promise.reject(new Error(`appel ${op} inattendu`));
    return h();
  };
  const api: ProposalApi = {
    confirm: (id, argsHash) => {
      calls.push({ op: 'confirm', id, argsHash });
      return next('confirm');
    },
    refuse: (id) => {
      calls.push({ op: 'refuse', id });
      return next('refuse');
    },
    get: (id) => {
      calls.push({ op: 'get', id });
      return next('get');
    },
  };
  const noted: unknown[] = [];
  const deps = (): ProposalActionDeps => ({
    api,
    dispatch: (a) => {
      dispatched.push(a);
      state = chatReducer(state, a);
    },
    getState: () => state,
    now: () => env.now,
    lock,
    gen: env.gen,
    isAlive: (g) => env.alive && g === env.gen,
    noteError: (e) => noted.push(e),
  });
  const ui = (id = 'p1') => state.proposals[id];
  const shown = (id = 'p1') => state.current.messages.flatMap((m) => m.proposals).find((p) => p.proposalId === id);
  return { deps, calls, dispatched, env, lock, handlers, noted, ui, shown, getState: () => state };
}

const ok = (p: AsstProposalDto) => () => Promise.resolve(p);
const ko = (e: unknown) => () => Promise.reject(e);

// --- (1) verrou synchrone ------------------------------------------------------------------------------

test('deux appels synchrones consécutifs : un seul appel réseau', async () => {
  const t = setup();
  t.handlers.confirm.push(ok(prop({ status: 2 })));
  const first = runProposalAction(t.deps(), 'p1', 'confirm');
  const second = runProposalAction(t.deps(), 'p1', 'confirm');
  const third = runProposalAction(t.deps(), 'p1', 'refuse');
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(third, null);
  assert.equal(t.calls.length, 1);
  await first;
  assert.equal(t.shown()?.status, 2);
  assert.equal(t.ui()?.busy, null);
});

test('verrou : état FIGÉ (avant proposalBusy, comme stateRef avant rendu) -> 2e et 3e appels du même tick refusés par le verrou seul', async () => {
  const t = setup();
  const frozen = t.getState(); // aucun busy : le rendu React n'a pas encore eu lieu
  t.handlers.confirm.push(ok(prop({ status: 2 })));
  const stale = (): ProposalActionDeps => ({ ...t.deps(), getState: () => frozen });
  const first = runProposalAction(stale(), 'p1', 'confirm');
  const second = runProposalAction(stale(), 'p1', 'confirm');
  const third = runProposalAction(stale(), 'p1', 'refuse');
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(third, null);
  assert.equal(t.calls.length, 1);
  assert.equal(t.lock.isLocked('p1'), true);
  await first;
  assert.equal(t.lock.isLocked('p1'), false);
});

// --- (2) hash de la proposition courante ----------------------------------------------------------------

test('le hash envoyé est celui de la proposition présente dans l’état courant', async () => {
  const t = setup(prop({ argsHash: HASH_B }));
  t.handlers.confirm.push(ok(prop({ status: 2, argsHash: HASH_B })));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.deepEqual(t.calls, [{ op: 'confirm', id: 'p1', argsHash: HASH_B }]);
});

// --- (3) conflit : relecture puis nouveau hash ------------------------------------------------------------

test('conflict : relecture GET, nouveau hash, 2e confirm avec le nouveau hash uniquement', async () => {
  const t = setup();
  t.handlers.confirm.push(ko(apiError(409, 'conflict' as AsstErrorCode)));
  t.handlers.get.push(ok(prop({ argsHash: HASH_B, rowVersion: 1, summary: 'modifiée' })));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.deepEqual(t.calls.map((c) => c.op), ['confirm', 'get']);
  assert.equal(t.shown()?.argsHash, HASH_B);
  assert.equal(t.ui()?.notice?.kind, 'conflict');
  assert.equal(t.ui()?.busy, null);
  assert.equal(t.lock.isLocked('p1'), false);

  t.handlers.confirm.push(ok(prop({ status: 2, argsHash: HASH_B })));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  const confirms = t.calls.filter((c) => c.op === 'confirm');
  assert.equal(confirms.length, 2);
  assert.equal(confirms[0]?.argsHash, HASH_A);
  assert.equal(confirms[1]?.argsHash, HASH_B);
});

// --- (4) verrou relâché dans tous les cas ------------------------------------------------------------------

test('verrou relâché après succès', async () => {
  const t = setup();
  t.handlers.confirm.push(ok(prop({ status: 2 })));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.equal(t.lock.isLocked('p1'), false);
});

const ERRORS: Array<[string, AssistantApiError]> = [
  ['conflict', apiError(409, 'conflict' as AsstErrorCode)],
  ['proposal_expired', apiError(409, 'proposal_expired' as AsstErrorCode)],
  ['proposal_not_pending', apiError(409, 'proposal_not_pending' as AsstErrorCode)],
  ['effect_failed', apiError(422, 'effect_failed' as AsstErrorCode, prop({ status: 5 }))],
  ['effect_failed sans proposition', apiError(422, 'effect_failed' as AsstErrorCode)],
  ['effect_forbidden', apiError(403, 'effect_forbidden' as AsstErrorCode, prop({ status: 5 }))],
  ['effect_forbidden sans proposition', apiError(403, 'effect_forbidden' as AsstErrorCode)],
  ['not_found', apiError(404, 'not_found' as AsstErrorCode)],
  ['réseau', apiError(0)],
  ['500', apiError(500)],
  ['503', apiError(503, 'assistant_unavailable' as AsstErrorCode)],
];

for (const [label, error] of ERRORS) {
  for (const kind of ['confirm', 'refuse'] as const) {
    test(`verrou relâché et busy remis à null après ${label} (${kind})`, async () => {
      const t = setup();
      t.handlers[kind].push(ko(error));
      t.handlers.get.push(ok(prop({ argsHash: HASH_B })));
      await runProposalAction(t.deps(), 'p1', kind);
      assert.equal(t.lock.isLocked('p1'), false);
      assert.notEqual(t.ui('p1')?.busy, 'confirm');
      assert.notEqual(t.ui('p1')?.busy, 'refuse');
    });
  }
}

test('verrou relâché après échec de la relecture', async () => {
  const t = setup();
  t.handlers.confirm.push(ko(apiError(409, 'conflict' as AsstErrorCode)));
  t.handlers.get.push(ko(apiError(500)));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.equal(t.lock.isLocked('p1'), false);
});

test('not_found retire la proposition', async () => {
  const t = setup();
  t.handlers.confirm.push(ko(apiError(404, 'not_found' as AsstErrorCode)));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.equal(t.shown(), undefined);
});

test('effect_forbidden sans proposition, erreur réseau et 5xx : relecture avec avis d’erreur ; 503 : avis seul', async () => {
  for (const error of [apiError(403, 'effect_forbidden' as AsstErrorCode), apiError(0), apiError(502)]) {
    for (const kind of ['confirm', 'refuse'] as const) {
      const t = setup();
      t.handlers[kind].push(ko(error));
      t.handlers.get.push(ok(prop({ status: 2 })));
      await runProposalAction(t.deps(), 'p1', kind);
      assert.deepEqual(t.calls.map((c) => c.op), [kind, 'get']);
      assert.equal(t.shown()?.status, 2);
      assert.equal(t.ui()?.notice?.kind, 'error');
    }
  }
  const t = setup();
  t.handlers.confirm.push(ko(apiError(503, 'assistant_unavailable' as AsstErrorCode)));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.deepEqual(t.calls.map((c) => c.op), ['confirm']);
  assert.equal(t.ui()?.notice?.kind, 'error');
  assert.equal(t.shown()?.status, 0);
});

// --- (5) refus d'appel ----------------------------------------------------------------------------------

test('clic à l’échéance ou après : aucun appel, retour null', () => {
  const t = setup();
  t.env.now = Date.parse(EXP);
  assert.equal(runProposalAction(t.deps(), 'p1', 'confirm'), null);
  t.env.now = Date.parse(EXP) + 5000;
  assert.equal(runProposalAction(t.deps(), 'p1', 'refuse'), null);
  assert.equal(t.calls.length, 0);
  assert.equal(t.lock.isLocked('p1'), false);
  assert.deepEqual(t.dispatched, []);
});

test('proposition absente, déjà occupée ou statut non 0 : aucun appel', () => {
  const t = setup();
  assert.equal(runProposalAction(t.deps(), 'inconnue', 'confirm'), null);

  const busy = setup();
  busy.deps().dispatch({ type: 'proposalBusy', id: 'p1', busy: 'confirm' });
  assert.equal(runProposalAction(busy.deps(), 'p1', 'confirm'), null);

  for (const status of [1, 2, 3, 4, 5] as const) {
    const s = setup(prop({ status }));
    assert.equal(runProposalAction(s.deps(), 'p1', 'confirm'), null);
    assert.equal(runProposalAction(s.deps(), 'p1', 'refuse'), null);
    assert.equal(s.calls.length, 0);
  }
  assert.equal(t.calls.length + busy.calls.length, 0);
});

// --- (6) réponses tardives ----------------------------------------------------------------------------------

test('réponse tardive après changement de génération : aucun dispatch, verrou relâché', async () => {
  const t = setup();
  let resolve!: (p: AsstProposalDto) => void;
  t.handlers.confirm.push(() => new Promise((r) => (resolve = r)));
  const pending = runProposalAction(t.deps(), 'p1', 'confirm');
  const before = t.dispatched.length;
  t.env.gen += 1;
  resolve(prop({ status: 2 }));
  await pending;
  assert.equal(t.dispatched.length, before, 'aucun dispatch après le changement');
  assert.equal(t.lock.isLocked('p1'), false);
  assert.equal(t.calls.length, 1, 'le POST n’est pas annulé ni répété');
});

test('erreur tardive ignorée (démontage) : aucun dispatch ni noteError, verrou relâché', async () => {
  const t = setup();
  let reject!: (e: unknown) => void;
  t.handlers.confirm.push(() => new Promise((_, r) => (reject = r)));
  const pending = runProposalAction(t.deps(), 'p1', 'confirm');
  const before = t.dispatched.length;
  t.env.alive = false;
  reject(apiError(409, 'conflict' as AsstErrorCode));
  await pending;
  assert.equal(t.dispatched.length, before);
  assert.equal(t.noted.length, 0);
  assert.equal(t.calls.length, 1, 'pas de relecture');
  assert.equal(t.lock.isLocked('p1'), false);
});

test('relecture tardive après erreur : ignorée, verrou relâché', async () => {
  const t = setup();
  let resolveGet!: (p: AsstProposalDto) => void;
  t.handlers.confirm.push(ko(apiError(409, 'conflict' as AsstErrorCode)));
  t.handlers.get.push(() => new Promise((r) => (resolveGet = r)));
  const pending = runProposalAction(t.deps(), 'p1', 'confirm');
  await new Promise((r) => setImmediate(r));
  const before = t.dispatched.length;
  t.env.gen += 1;
  resolveGet(prop({ argsHash: HASH_B }));
  await pending;
  assert.equal(t.dispatched.length, before);
  assert.equal(t.lock.isLocked('p1'), false);
});

// --- (7) refus sans hash ---------------------------------------------------------------------------------------

test('refuse n’envoie pas de hash', async () => {
  const t = setup();
  t.handlers.refuse.push(ok(prop({ status: 3 })));
  await runProposalAction(t.deps(), 'p1', 'refuse');
  assert.deepEqual(t.calls, [{ op: 'refuse', id: 'p1' }]);
  assert.equal(t.shown()?.status, 3);
});

// --- (8) échec de relecture ----------------------------------------------------------------------------------

test('échec de relecture : avis reload-needed et busy remis à null', async () => {
  const t = setup();
  t.handlers.confirm.push(ko(apiError(409, 'conflict' as AsstErrorCode)));
  t.handlers.get.push(ko(apiError(500)));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.deepEqual(t.ui()?.notice, RELOAD_NEEDED);
  assert.equal(t.ui()?.busy, null);
  assert.equal(t.shown()?.argsHash, HASH_A, 'la proposition périmée reste, mais Confirmer sera relu via Recharger');
});

test('une erreur 503 pendant l’appel est signalée (noteError)', async () => {
  const t = setup();
  const e = apiError(503, 'assistant_unavailable' as AsstErrorCode);
  t.handlers.confirm.push(ko(e));
  await runProposalAction(t.deps(), 'p1', 'confirm');
  assert.deepEqual(t.noted, [e]);
});

// --- Relecture manuelle ----------------------------------------------------------------------------------------

test('reloadProposalAction : remplace, verrou par clé, relâché', async () => {
  const t = setup();
  t.handlers.get.push(ok(prop({ argsHash: HASH_B })));
  const first = reloadProposalAction(t.deps(), 'p1');
  assert.equal(reloadProposalAction(t.deps(), 'p1'), null);
  await first;
  assert.equal(t.shown()?.argsHash, HASH_B);
  assert.equal(t.lock.isLocked('reload:p1'), false);
  assert.equal(t.calls.length, 1);
});

test('reloadProposalAction : 404 retire, autre échec donne reload-needed', async () => {
  const a = setup();
  a.handlers.get.push(ko(apiError(404, 'not_found' as AsstErrorCode)));
  await reloadProposalAction(a.deps(), 'p1');
  assert.equal(a.shown(), undefined);
  assert.equal(a.lock.isLocked('reload:p1'), false);

  const b = setup();
  b.handlers.get.push(ko(apiError(0)));
  await reloadProposalAction(b.deps(), 'p1');
  assert.deepEqual(b.ui()?.notice, RELOAD_NEEDED);
  assert.equal(b.lock.isLocked('reload:p1'), false);
});

test('reloadProposalAction : réponse tardive ignorée', async () => {
  const t = setup();
  let resolve!: (p: AsstProposalDto) => void;
  t.handlers.get.push(() => new Promise((r) => (resolve = r)));
  const pending = reloadProposalAction(t.deps(), 'p1');
  t.env.alive = false;
  resolve(prop({ argsHash: HASH_B }));
  await pending;
  assert.equal(t.dispatched.length, 0);
  assert.equal(t.lock.isLocked('reload:p1'), false);
});
