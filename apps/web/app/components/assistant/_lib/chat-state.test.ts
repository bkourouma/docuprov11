// Réducteur du chat de l'assistant et fonctions pures de décision.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/chat-state.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ASST_MESSAGE_MAX_CHARS,
  type AsstConversationDto,
  type AsstMessageDto,
  type AsstPostMessageResponse,
  type AsstProposalDto,
} from '@archivage/types';
import {
  canSendNow,
  chatReducer,
  initialChatState,
  isBlockingError,
  shouldLoadList,
  shouldTick,
  type ChatAction,
  type ChatState,
} from './chat-state';
import type { UiError } from './ui-error';

const run = (s: ChatState, ...actions: ChatAction[]): ChatState => actions.reduce(chatReducer, s);

const conv = (id: string, last = '2026-11-22T10:00:00.000Z', extra: Partial<AsstConversationDto> = {}): AsstConversationDto => ({
  conversationId: id,
  title: null,
  pageContext: null,
  createdAt: '2026-11-22T09:00:00.000Z',
  updatedAt: last,
  lastMessageAt: last,
  purgeAt: '2027-02-22T09:00:00.000Z',
  messageCount: 0,
  ...extra,
});

const prop = (id: string, over: Partial<AsstProposalDto> = {}): AsstProposalDto => ({
  proposalId: id,
  conversationId: '1',
  messageId: 'm2',
  status: 0,
  actions: [],
  summary: 's',
  argsHash: 'a'.repeat(64),
  expiresAt: '2026-11-22T12:00:00.000Z',
  createdAt: '2026-11-22T10:00:00.000Z',
  confirmedAt: null,
  finishedAt: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  rowVersion: 0,
  ...over,
});

const msg = (id: string, position: number, proposals: AsstProposalDto[] = [], role: 0 | 1 = 1): AsstMessageDto => ({
  messageId: id,
  conversationId: '1',
  role: role as AsstMessageDto['role'],
  content: `contenu ${id}`,
  position,
  createdAt: '2026-11-22T10:00:00.000Z',
  proposals,
});

const err = (kind: UiError['kind'], extra: Partial<UiError> = {}): UiError => ({
  kind,
  message: `erreur ${kind}`,
  retryAfterSeconds: null,
  retryable: false,
  ...extra,
});

const loadedChat = (messages: AsstMessageDto[] = []): ChatState =>
  run(initialChatState, { type: 'conversationLoaded', conversation: conv('1'), messages });

// --- Liste -----------------------------------------------------------------------------------------

test('état initial', () => {
  assert.equal(initialChatState.view, 'list');
  assert.equal(initialChatState.list.status, 'idle');
  assert.equal(initialChatState.blocked, null);
  assert.deepEqual(initialChatState.proposals, {});
});

test('liste : loading -> loaded (triée) -> failed', () => {
  let s = chatReducer(initialChatState, { type: 'listLoading' });
  assert.equal(s.list.status, 'loading');
  const a = conv('a', '2026-11-20T10:00:00.000Z');
  const b = conv('b', '2026-11-22T10:00:00.000Z');
  s = chatReducer(s, { type: 'listLoaded', items: [a, b], total: 2 });
  assert.equal(s.list.status, 'ready');
  assert.deepEqual(s.list.items.map((c) => c.conversationId), ['b', 'a']);
  assert.equal(s.list.total, 2);
  s = chatReducer(s, { type: 'listFailed', error: err('network') });
  assert.equal(s.list.status, 'error');
  assert.equal(s.list.error?.kind, 'network');
  assert.equal(s.blocked, null);
  assert.equal(s.list.items.length, 2, 'les éléments déjà chargés restent');
});

test('listLoading conserve les éléments déjà là et efface l\'erreur', () => {
  let s = run(initialChatState, { type: 'listLoaded', items: [conv('a')], total: 1 }, { type: 'listFailed', error: err('network') });
  s = chatReducer(s, { type: 'listLoading' });
  assert.equal(s.list.items.length, 1);
  assert.equal(s.list.error, null);
});

test('listLoaded ne mute pas le tableau fourni', () => {
  const items = [conv('a', '2026-11-20T10:00:00.000Z'), conv('b', '2026-11-22T10:00:00.000Z')];
  chatReducer(initialChatState, { type: 'listLoaded', items, total: 2 });
  assert.deepEqual(items.map((c) => c.conversationId), ['a', 'b']);
});

test('erreurs 503/501 sur la liste posent blocked', () => {
  const s503 = chatReducer(initialChatState, { type: 'listFailed', error: err('unavailable') });
  assert.equal(s503.blocked?.kind, 'unavailable');
  const s501 = chatReducer(initialChatState, { type: 'listFailed', error: err('not_implemented') });
  assert.equal(s501.blocked?.kind, 'not_implemented');
});

// --- Navigation ------------------------------------------------------------------------------------

test('openList change la vue (même référence si déjà en liste)', () => {
  const chat = chatReducer(initialChatState, { type: 'newConversation' });
  assert.equal(chat.view, 'chat');
  const list = chatReducer(chat, { type: 'openList' });
  assert.equal(list.view, 'list');
  assert.equal(chatReducer(list, { type: 'openList' }), list);
});

test('deleteError : posé par deleteFailed, effacé par deleteErrorCleared, openList, listLoaded, conversationDeleted', () => {
  assert.equal(initialChatState.deleteError, null);
  const e = err('network');
  const failed = chatReducer(initialChatState, { type: 'deleteFailed', error: e });
  assert.equal(failed.deleteError, e);
  assert.equal(chatReducer(failed, { type: 'deleteErrorCleared' }).deleteError, null);
  assert.equal(chatReducer(initialChatState, { type: 'deleteErrorCleared' }), initialChatState);
  assert.equal(chatReducer(failed, { type: 'openList' }).deleteError, null);
  assert.equal(chatReducer(failed, { type: 'listLoaded', items: [], total: 0 }).deleteError, null);
  assert.equal(chatReducer(failed, { type: 'conversationDeleted', id: 'x' }).deleteError, null);
  // 503/501 pendant une suppression verrouillent aussi la saisie.
  assert.equal(chatReducer(initialChatState, { type: 'deleteFailed', error: err('unavailable') }).blocked?.kind, 'unavailable');
});

test('newConversation : conversation vide, vue chat, proposals et send réinitialisés', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = run(s, { type: 'proposalBusy', id: 'p1', busy: 'confirm' }, { type: 'sendStarted', text: 'hello' });
  s = chatReducer(s, { type: 'newConversation' });
  assert.equal(s.view, 'chat');
  assert.equal(s.current.conversation, null);
  assert.deepEqual(s.current.messages, []);
  assert.equal(s.current.status, 'ready');
  assert.deepEqual(s.proposals, {});
  assert.deepEqual(s.send, { status: 'idle', pendingText: null, error: null });
});

test('conversationLoading : vue chat, état de chargement, reset proposals et send', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = run(s, { type: 'proposalBusy', id: 'p1', busy: 'refuse' }, { type: 'sendStarted', text: 'x' });
  s = chatReducer(s, { type: 'conversationLoading', id: '2' });
  assert.equal(s.view, 'chat');
  assert.equal(s.current.status, 'loading');
  assert.equal(s.current.conversation, null);
  assert.deepEqual(s.current.messages, []);
  assert.deepEqual(s.proposals, {});
  assert.equal(s.send.status, 'idle');
});

test('conversationLoaded : messages triés par position, statut ready', () => {
  const s = loadedChat([msg('m2', 2), msg('m1', 1)]);
  assert.deepEqual(s.current.messages.map((m) => m.messageId), ['m1', 'm2']);
  assert.equal(s.current.status, 'ready');
  assert.equal(s.view, 'chat');
});

test('conversationLoaded d\'une AUTRE conversation réinitialise proposals et send', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = run(s, { type: 'proposalBusy', id: 'p1', busy: 'confirm' }, { type: 'sendStarted', text: 'x' });
  s = chatReducer(s, { type: 'conversationLoaded', conversation: conv('2'), messages: [] });
  assert.deepEqual(s.proposals, {});
  assert.equal(s.send.status, 'idle');
});

test('conversationLoaded de la MÊME conversation conserve proposals (rechargement)', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = chatReducer(s, { type: 'proposalBusy', id: 'p1', busy: 'confirm' });
  s = chatReducer(s, { type: 'conversationLoaded', conversation: conv('1'), messages: [msg('m1', 1, [prop('p1')])] });
  assert.equal(s.proposals.p1?.busy, 'confirm');
});

test('conversationLoaded met à jour l\'entrée de la liste et retrie', () => {
  let s = run(initialChatState, {
    type: 'listLoaded',
    items: [conv('1', '2026-11-20T10:00:00.000Z'), conv('2', '2026-11-21T10:00:00.000Z')],
    total: 2,
  });
  s = chatReducer(s, { type: 'conversationLoaded', conversation: conv('1', '2026-11-22T10:00:00.000Z'), messages: [] });
  assert.deepEqual(s.list.items.map((c) => c.conversationId), ['1', '2']);
});

test('conversationFailed : erreur posée ; 503 pose blocked', () => {
  let s = chatReducer(initialChatState, { type: 'conversationLoading', id: '1' });
  s = chatReducer(s, { type: 'conversationFailed', error: err('not_found') });
  assert.equal(s.current.status, 'error');
  assert.equal(s.current.error?.kind, 'not_found');
  assert.equal(s.blocked, null);
  s = chatReducer(s, { type: 'conversationFailed', error: err('unavailable') });
  assert.equal(s.blocked?.kind, 'unavailable');
});

test('loadsAborted : chargement de liste -> idle ; chargement de conversation -> retour à la liste', () => {
  const l = run(initialChatState, { type: 'listLoading' }, { type: 'loadsAborted' });
  assert.equal(l.list.status, 'idle');
  const c = run(initialChatState, { type: 'conversationLoading', id: '1' }, { type: 'loadsAborted' });
  assert.equal(c.view, 'list');
  assert.equal(c.current.conversation, null);
  assert.notEqual(c.current.status, 'loading');
  assert.equal(chatReducer(initialChatState, { type: 'loadsAborted' }), initialChatState);
});

// --- Envoi -----------------------------------------------------------------------------------------

test('conversationCreated : conversation définie avant l\'envoi du message, send intact', () => {
  let s = chatReducer(initialChatState, { type: 'newConversation' });
  s = chatReducer(s, { type: 'sendStarted', text: 'bonjour' });
  s = chatReducer(s, { type: 'conversationCreated', conversation: conv('9') });
  assert.equal(s.current.conversation?.conversationId, '9');
  assert.deepEqual(s.current.messages, []);
  assert.equal(s.send.status, 'sending');
  assert.equal(s.send.pendingText, 'bonjour');
});

const response = (id: string, userPos: number): AsstPostMessageResponse => ({
  conversation: conv(id, '2026-11-22T11:00:00.000Z', { messageCount: userPos + 1 }),
  userMessage: { ...msg(`u${userPos}`, userPos, [], 0), conversationId: id },
  assistantMessage: { ...msg(`a${userPos + 1}`, userPos + 1, [prop(`p${userPos}`)]), conversationId: id },
});

test('sendStarted / sendSucceeded : fusion ordonnée, pendingText vidé, conversation mise à jour', () => {
  let s = loadedChat([msg('m0', 0)]);
  s = chatReducer(s, { type: 'sendStarted', text: 'question' });
  assert.deepEqual(s.send, { status: 'sending', pendingText: 'question', error: null });
  s = chatReducer(s, { type: 'sendSucceeded', res: response('1', 1) });
  assert.deepEqual(s.current.messages.map((m) => m.messageId), ['m0', 'u1', 'a2']);
  assert.deepEqual(s.send, { status: 'idle', pendingText: null, error: null });
  assert.equal(s.current.conversation?.messageCount, 2);
  assert.equal(s.current.messages[2]?.proposals[0]?.proposalId, 'p1');
});

test('sendSucceeded : pas de doublon si la réponse est rejouée', () => {
  let s = loadedChat();
  s = run(s, { type: 'sendSucceeded', res: response('1', 1) }, { type: 'sendSucceeded', res: response('1', 1) });
  assert.equal(s.current.messages.length, 2);
});

test('sendSucceeded : met à jour la conversation dans la liste', () => {
  let s = run(
    initialChatState,
    { type: 'listLoaded', items: [conv('1', '2026-11-20T10:00:00.000Z'), conv('2', '2026-11-21T10:00:00.000Z')], total: 2 },
    { type: 'conversationLoaded', conversation: conv('1', '2026-11-20T10:00:00.000Z'), messages: [] },
  );
  s = chatReducer(s, { type: 'sendSucceeded', res: response('1', 1) });
  assert.equal(s.list.items[0]?.conversationId, '1');
});

test('sendSucceeded d\'une autre conversation est ignoré', () => {
  const s = loadedChat();
  assert.equal(chatReducer(s, { type: 'sendSucceeded', res: response('2', 1) }), s);
});

test('sendSucceeded sur conversation vide (créée à l\'envoi) la définit', () => {
  const s = chatReducer(initialChatState, { type: 'sendSucceeded', res: response('5', 1) });
  assert.equal(s.current.conversation?.conversationId, '5');
  assert.equal(s.view, 'chat');
});

test('sendSucceeded lève blocked seulement s\'il était rate_limited', () => {
  const rate = run(loadedChat(), { type: 'blocked', error: err('rate_limited', { retryAfterSeconds: 5 }) });
  assert.equal(chatReducer(rate, { type: 'sendSucceeded', res: response('1', 1) }).blocked, null);
  const unavailable = run(loadedChat(), { type: 'blocked', error: err('unavailable') });
  assert.equal(chatReducer(unavailable, { type: 'sendSucceeded', res: response('1', 1) }).blocked?.kind, 'unavailable');
  const notImpl = run(loadedChat(), { type: 'blocked', error: err('not_implemented') });
  assert.equal(chatReducer(notImpl, { type: 'sendSucceeded', res: response('1', 1) }).blocked?.kind, 'not_implemented');
});

test('sendFailed : texte conservé pour le réessai, erreur exposée (429 avec délai)', () => {
  let s = run(loadedChat(), { type: 'sendStarted', text: 'ma question' });
  s = chatReducer(s, { type: 'sendFailed', error: err('rate_limited', { retryAfterSeconds: 30, retryable: true }) });
  assert.equal(s.send.status, 'error');
  assert.equal(s.send.pendingText, 'ma question');
  assert.equal(s.send.error?.retryAfterSeconds, 30);
  assert.equal(s.blocked, null);
});

test('sendFailed 503/501 pose blocked en gardant le texte', () => {
  const s = run(loadedChat(), { type: 'sendStarted', text: 'q' }, { type: 'sendFailed', error: err('unavailable') });
  assert.equal(s.blocked?.kind, 'unavailable');
  assert.equal(s.send.pendingText, 'q');
  const t = run(loadedChat(), { type: 'sendStarted', text: 'q' }, { type: 'sendFailed', error: err('not_implemented') });
  assert.equal(t.blocked?.kind, 'not_implemented');
});

test('sendStarted après un échec efface l\'erreur', () => {
  const s = run(loadedChat(), { type: 'sendStarted', text: 'q' }, { type: 'sendFailed', error: err('network') }, { type: 'sendStarted', text: 'q' });
  assert.equal(s.send.status, 'sending');
  assert.equal(s.send.error, null);
});

test('sendCancelled : retour à idle, texte vidé ; sans effet sur un état déjà idle', () => {
  const s = run(loadedChat(), { type: 'sendStarted', text: 'q' }, { type: 'sendCancelled' });
  assert.deepEqual(s.send, { status: 'idle', pendingText: null, error: null });
  const idle = loadedChat();
  assert.equal(chatReducer(idle, { type: 'sendCancelled' }), idle);
});

// --- Propositions ----------------------------------------------------------------------------------

test('proposalBusy : pose busy et efface l\'avis ; fin d\'appel conserve l\'avis', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = run(s, { type: 'proposalNotice', id: 'p1', notice: { kind: 'info', message: 'ancien' } });
  s = chatReducer(s, { type: 'proposalBusy', id: 'p1', busy: 'confirm' });
  assert.deepEqual(s.proposals.p1, { busy: 'confirm', notice: null });
  s = run(s, { type: 'proposalNotice', id: 'p1', notice: { kind: 'error', message: 'nouveau' } });
  s = chatReducer(s, { type: 'proposalBusy', id: 'p1', busy: null });
  assert.deepEqual(s.proposals.p1, { busy: null, notice: { kind: 'error', message: 'nouveau' } });
  const empty = loadedChat();
  assert.equal(chatReducer(empty, { type: 'proposalBusy', id: 'zz', busy: null }), empty);
});

test('proposalReplaced : remplace, busy à null, conserve la notice passée', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1'), prop('p2')])]);
  s = chatReducer(s, { type: 'proposalBusy', id: 'p1', busy: 'confirm' });
  const notice = { kind: 'conflict' as const, message: 'relisez' };
  s = chatReducer(s, { type: 'proposalReplaced', proposal: prop('p1', { status: 2, rowVersion: 3 }), notice });
  assert.equal(s.current.messages[0]?.proposals[0]?.status, 2);
  assert.equal(s.current.messages[0]?.proposals[1]?.proposalId, 'p2');
  assert.deepEqual(s.proposals.p1, { busy: null, notice });
});

test('proposalReplaced sans notice : notice null', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = run(s, { type: 'proposalNotice', id: 'p1', notice: { kind: 'info', message: 'x' } });
  s = chatReducer(s, { type: 'proposalReplaced', proposal: prop('p1', { status: 3 }) });
  assert.deepEqual(s.proposals.p1, { busy: null, notice: null });
});

test('proposalReplaced est immuable', () => {
  const before = loadedChat([msg('m1', 1, [prop('p1')])]);
  const original = before.current.messages[0];
  const after = chatReducer(before, { type: 'proposalReplaced', proposal: prop('p1', { status: 2 }) });
  assert.equal(before.current.messages[0], original);
  assert.equal(before.current.messages[0]?.proposals[0]?.status, 0);
  assert.notEqual(after.current.messages, before.current.messages);
});

test('proposalRemoved : retire la proposition (le message reste) et son état d\'UI', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1'), prop('p2')])]);
  s = run(s, { type: 'proposalBusy', id: 'p1', busy: 'refuse' }, { type: 'proposalBusy', id: 'p2', busy: 'confirm' });
  s = chatReducer(s, { type: 'proposalRemoved', id: 'p1' });
  assert.equal(s.current.messages.length, 1);
  assert.deepEqual(s.current.messages[0]?.proposals.map((p) => p.proposalId), ['p2']);
  assert.equal(s.proposals.p1, undefined);
  assert.equal(s.proposals.p2?.busy, 'confirm');
});

test('proposalNotice : pose, remplace et efface (null) sans toucher busy', () => {
  let s = loadedChat([msg('m1', 1, [prop('p1')])]);
  s = run(s, { type: 'proposalBusy', id: 'p1', busy: 'confirm' });
  s = chatReducer(s, { type: 'proposalNotice', id: 'p1', notice: { kind: 'error', message: 'e' } });
  assert.equal(s.proposals.p1?.busy, 'confirm');
  assert.equal(s.proposals.p1?.notice?.message, 'e');
  s = chatReducer(s, { type: 'proposalNotice', id: 'p1', notice: null });
  assert.equal(s.proposals.p1?.notice, null);
  const none = loadedChat();
  assert.equal(chatReducer(none, { type: 'proposalNotice', id: 'zz', notice: null }), none);
});

// --- Suppression et blocage ------------------------------------------------------------------------

test('conversationDeleted : retire de la liste, total - 1', () => {
  let s = run(initialChatState, { type: 'listLoaded', items: [conv('1'), conv('2')], total: 7 });
  s = chatReducer(s, { type: 'conversationDeleted', id: '2' });
  assert.deepEqual(s.list.items.map((c) => c.conversationId), ['1']);
  assert.equal(s.list.total, 6);
  assert.equal(s.view, 'list');
});

test('conversationDeleted d\'un id absent de la liste : total inchangé', () => {
  const s0 = run(initialChatState, { type: 'listLoaded', items: [conv('1')], total: 1 });
  assert.equal(chatReducer(s0, { type: 'conversationDeleted', id: '99' }).list.total, 1);
});

test('conversationDeleted de la courante : vide, retour à la liste, proposals et send remis à zéro', () => {
  let s = run(
    initialChatState,
    { type: 'listLoaded', items: [conv('1'), conv('2')], total: 2 },
    { type: 'conversationLoaded', conversation: conv('1'), messages: [msg('m1', 1, [prop('p1')])] },
    { type: 'proposalBusy', id: 'p1', busy: 'confirm' },
    { type: 'sendStarted', text: 'x' },
  );
  s = chatReducer(s, { type: 'conversationDeleted', id: '1' });
  assert.equal(s.view, 'list');
  assert.equal(s.current.conversation, null);
  assert.deepEqual(s.current.messages, []);
  assert.deepEqual(s.proposals, {});
  assert.equal(s.send.status, 'idle');
  assert.equal(s.list.items.length, 1);
  assert.equal(s.list.total, 1);
});

test('conversationDeleted d\'une autre conversation laisse la courante', () => {
  let s = run(
    initialChatState,
    { type: 'listLoaded', items: [conv('1'), conv('2')], total: 2 },
    { type: 'conversationLoaded', conversation: conv('1'), messages: [msg('m1', 1)] },
  );
  s = chatReducer(s, { type: 'conversationDeleted', id: '2' });
  assert.equal(s.view, 'chat');
  assert.equal(s.current.conversation?.conversationId, '1');
  assert.equal(s.current.messages.length, 1);
});

test('blocked : pose et lève ; même référence si identique', () => {
  const e = err('unavailable');
  const s = chatReducer(initialChatState, { type: 'blocked', error: e });
  assert.equal(s.blocked, e);
  assert.equal(chatReducer(s, { type: 'blocked', error: e }), s);
  assert.equal(chatReducer(s, { type: 'blocked', error: null }).blocked, null);
});

test('les actions ne mutent jamais l\'état précédent', () => {
  const s = loadedChat([msg('m1', 1, [prop('p1')])]);
  const snapshot = JSON.stringify(s);
  run(
    s,
    { type: 'proposalBusy', id: 'p1', busy: 'confirm' },
    { type: 'proposalReplaced', proposal: prop('p1', { status: 2 }) },
    { type: 'sendSucceeded', res: response('1', 2) },
    { type: 'proposalRemoved', id: 'p1' },
    { type: 'conversationDeleted', id: '1' },
  );
  assert.equal(JSON.stringify(s), snapshot);
});

// --- Fonctions pures -------------------------------------------------------------------------------

test('isBlockingError', () => {
  assert.equal(isBlockingError(err('unavailable')), true);
  assert.equal(isBlockingError(err('not_implemented')), true);
  assert.equal(isBlockingError(err('rate_limited')), false);
  assert.equal(isBlockingError(err('network')), false);
});

test('shouldLoadList : idle ou error, panneau ouvert uniquement', () => {
  assert.equal(shouldLoadList(initialChatState, true), true);
  assert.equal(shouldLoadList(initialChatState, false), false);
  const loading = chatReducer(initialChatState, { type: 'listLoading' });
  assert.equal(shouldLoadList(loading, true), false);
  const ready = chatReducer(loading, { type: 'listLoaded', items: [], total: 0 });
  assert.equal(shouldLoadList(ready, true), false);
  const failed = chatReducer(loading, { type: 'listFailed', error: err('network') });
  assert.equal(shouldLoadList(failed, true), true);
});

test('canSendNow : texte vide, trop long, envoi en cours, blocage', () => {
  const s = loadedChat();
  assert.deepEqual(canSendNow(s, '  bonjour  '), { ok: true, text: 'bonjour' });
  assert.deepEqual(canSendNow(s, '   \n '), { ok: false, reason: 'empty' });
  assert.deepEqual(canSendNow(s, ''), { ok: false, reason: 'empty' });
  assert.deepEqual(canSendNow(s, 'x'.repeat(ASST_MESSAGE_MAX_CHARS)), { ok: true, text: 'x'.repeat(ASST_MESSAGE_MAX_CHARS) });
  assert.deepEqual(canSendNow(s, 'x'.repeat(ASST_MESSAGE_MAX_CHARS + 1)), { ok: false, reason: 'too_long' });
  // Le trim s'applique avant la mesure.
  assert.equal(canSendNow(s, ` ${'x'.repeat(ASST_MESSAGE_MAX_CHARS)} `).ok, true);
  const sending = chatReducer(s, { type: 'sendStarted', text: 'a' });
  assert.deepEqual(canSendNow(sending, 'b'), { ok: false, reason: 'busy' });
  const blocked = chatReducer(s, { type: 'blocked', error: err('unavailable') });
  assert.deepEqual(canSendNow(blocked, 'b'), { ok: false, reason: 'blocked' });
  const rate = chatReducer(s, { type: 'blocked', error: err('rate_limited') });
  assert.equal(canSendNow(rate, 'b').ok, true);
  const failed = run(s, { type: 'sendStarted', text: 'a' }, { type: 'sendFailed', error: err('network') });
  assert.equal(canSendNow(failed, 'a').ok, true, 'le réessai reste possible après un échec');
});

test('shouldTick : ouvert ET proposition « proposée » non expirée', () => {
  const before = Date.parse('2026-11-22T11:00:00.000Z');
  const after = Date.parse('2026-11-22T12:00:01.000Z');
  const s = loadedChat([msg('m1', 1, [prop('p1')])]);
  assert.equal(shouldTick(s, true, before), true);
  assert.equal(shouldTick(s, false, before), false);
  assert.equal(shouldTick(s, true, after), false, 'expirée : plus de timer');
  const applied = chatReducer(s, { type: 'proposalReplaced', proposal: prop('p1', { status: 2 }) });
  assert.equal(shouldTick(applied, true, before), false);
  assert.equal(shouldTick(loadedChat(), true, before), false);
});
