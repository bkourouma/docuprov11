// Tests de la logique des conversations de l'assistant.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/conversation-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AsstConversationDto,
  AsstMessageDto,
  AsstPostMessageResponse,
  AsstProposalDto,
} from '@archivage/types';
import {
  conversationTitle,
  findProposal,
  formatDateTimeFr,
  formatTimeFr,
  hasPendingProposal,
  mergePostMessageResponse,
  readClarification,
  relativePurgeLabel,
  removeProposal,
  replaceProposal,
  sortConversations,
} from './conversation-logic';

const NOW = Date.parse('2026-11-22T12:00:00Z');

function conv(id: string, over: Partial<AsstConversationDto> = {}): AsstConversationDto {
  return {
    conversationId: id,
    title: null,
    pageContext: null,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    lastMessageAt: '2026-11-20T10:00:00Z',
    purgeAt: '2027-02-20T10:00:00Z',
    messageCount: 1,
    ...over,
  };
}

function prop(id: string, over: Partial<AsstProposalDto> = {}): AsstProposalDto {
  return {
    proposalId: id,
    conversationId: '1',
    messageId: 'm2',
    status: 0,
    actions: [],
    summary: 'Résumé',
    argsHash: 'a'.repeat(64),
    expiresAt: '2026-11-22T12:15:00Z',
    createdAt: '2026-11-22T12:00:00Z',
    confirmedAt: null,
    finishedAt: null,
    result: null,
    errorCode: null,
    errorMessage: null,
    rowVersion: 1,
    ...over,
  };
}

function msg(id: string, position: number, over: Partial<AsstMessageDto> = {}): AsstMessageDto {
  return {
    messageId: id,
    conversationId: '1',
    role: 1,
    content: 'texte',
    position,
    createdAt: '2026-11-22T12:00:00Z',
    proposals: [],
    ...over,
  };
}

test('sortConversations : décroissant, dates invalides en dernier, sans mutation', () => {
  const input = [
    conv('a', { lastMessageAt: '2026-11-01T00:00:00Z' }),
    conv('bad', { lastMessageAt: 'nope' }),
    conv('c', { lastMessageAt: '2026-11-21T00:00:00Z' }),
  ];
  const copy = [...input];
  const out = sortConversations(input);
  assert.deepEqual(out.map((c) => c.conversationId), ['c', 'a', 'bad']);
  assert.deepEqual(input, copy);
  assert.notEqual(out, input);
});

test('formatDateTimeFr / formatTimeFr', () => {
  assert.match(formatDateTimeFr('2026-11-22T12:30:00Z'), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.match(formatTimeFr('2026-11-22T12:30:00Z'), /^\d{2}:\d{2}$/);
  assert.equal(formatDateTimeFr('invalide'), '—');
  assert.equal(formatTimeFr(''), '—');
});

test('conversationTitle', () => {
  assert.equal(conversationTitle(conv('1', { title: 'Mon titre' })), 'Mon titre');
  assert.equal(conversationTitle(conv('1', { title: '  Titre  ' })), 'Titre');
  assert.match(conversationTitle(conv('1', { title: null })), /^Échange du \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.match(conversationTitle(conv('1', { title: '   ' })), /^Échange du /);
  assert.match(conversationTitle(conv('1', { title: '' })), /^Échange du /);
});

test('relativePurgeLabel', () => {
  const day = 86_400_000;
  assert.equal(relativePurgeLabel(new Date(NOW - 1000).toISOString(), NOW), 'Suppression imminente');
  assert.equal(relativePurgeLabel(new Date(NOW).toISOString(), NOW), 'Suppression imminente');
  assert.equal(relativePurgeLabel(new Date(NOW + 3600_000).toISOString(), NOW), 'Supprimé automatiquement dans 1 jour');
  assert.equal(relativePurgeLabel(new Date(NOW + day).toISOString(), NOW), 'Supprimé automatiquement dans 1 jour');
  assert.equal(relativePurgeLabel(new Date(NOW + 30 * day).toISOString(), NOW), 'Supprimé automatiquement dans 30 jours');
  assert.equal(relativePurgeLabel('x', NOW), 'Suppression automatique programmée');
});

test('mergePostMessageResponse : ajout, sans doublon, trié', () => {
  const m1 = msg('m1', 1, { role: 0 });
  const res: AsstPostMessageResponse = {
    conversation: conv('1'),
    userMessage: msg('m3', 3, { role: 0 }),
    assistantMessage: msg('m4', 4),
  };
  const base = [msg('m2', 2), m1];
  const out = mergePostMessageResponse(base, res);
  assert.deepEqual(out.map((m) => m.messageId), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(base.length, 2);

  // rejouer la même réponse ne duplique rien
  assert.deepEqual(mergePostMessageResponse(out, res).map((m) => m.messageId), ['m1', 'm2', 'm3', 'm4']);

  // un message déjà présent est remplacé par la version reçue
  const upd = mergePostMessageResponse(out, { ...res, assistantMessage: msg('m4', 4, { content: 'maj' }) });
  assert.equal(upd.find((m) => m.messageId === 'm4')?.content, 'maj');
});

test('replaceProposal : immutable, même référence si introuvable', () => {
  const p1 = prop('p1');
  const p2 = prop('p2');
  const messages = [msg('m1', 1, { role: 0 }), msg('m2', 2, { proposals: [p1, p2] })];
  const updated = prop('p1', { status: 2, rowVersion: 3 });
  const out = replaceProposal(messages, updated);
  assert.notEqual(out, messages);
  assert.equal(out[1]!.proposals[0], updated);
  assert.equal(out[1]!.proposals[1], p2);
  assert.equal(out[0], messages[0]);
  assert.equal(messages[1]!.proposals[0], p1); // entrée intacte
  assert.equal(replaceProposal(messages, prop('inconnue')), messages);
});

test('removeProposal et findProposal', () => {
  const p1 = prop('p1');
  const messages = [msg('m2', 2, { proposals: [p1, prop('p2')] })];
  const out = removeProposal(messages, 'p1');
  assert.equal(out[0]!.proposals.length, 1);
  assert.equal(out[0]!.proposals[0]!.proposalId, 'p2');
  assert.equal(messages[0]!.proposals.length, 2);
  assert.equal(removeProposal(messages, 'zz'), messages);
  assert.equal(findProposal(messages, 'p1'), p1);
  assert.equal(findProposal(messages, 'zz'), null);
});

test('hasPendingProposal', () => {
  const live = prop('p1');
  assert.equal(hasPendingProposal([msg('m', 1, { proposals: [live] })], NOW), true);
  assert.equal(hasPendingProposal([msg('m', 1, { proposals: [prop('p', { expiresAt: new Date(NOW).toISOString() })] })], NOW), false);
  assert.equal(hasPendingProposal([msg('m', 1, { proposals: [prop('p', { status: 2 })] })], NOW), false);
  assert.equal(hasPendingProposal([msg('m', 1)], NOW), false);
  assert.equal(hasPendingProposal([], NOW), false);
});

function withClar(clar: unknown, over: Partial<AsstMessageDto> = {}): AsstMessageDto {
  return { ...msg('m', 1, over), clarification: clar } as unknown as AsstMessageDto;
}

test('readClarification : cas valides', () => {
  const r = readClarification(withClar({ question: ' Lequel ? ', choices: [' A ', 'B', 'A'] }));
  assert.deepEqual(r, { question: 'Lequel ?', choices: ['A', 'B'] });
  assert.deepEqual(readClarification(withClar({ choices: ['x', 'y'] })), { question: null, choices: ['x', 'y'] });
  const many = readClarification(withClar({ choices: ['1', '2', '3', '4', '5', '6', '7', '8'] }));
  assert.equal(many?.choices.length, 6);
});

test('readClarification : cas invalides', () => {
  assert.equal(readClarification(msg('m', 1)), null);
  assert.equal(readClarification(withClar({ choices: ['seul'] })), null);
  assert.equal(readClarification(withClar({ choices: ['a', 'a'] })), null); // doublon -> 1 seul
  assert.equal(readClarification(withClar({ choices: 'abc' })), null);
  assert.equal(readClarification(withClar('x')), null);
  assert.equal(readClarification(withClar(null)), null);
  assert.equal(readClarification(withClar({ choices: ['a', 'b'] }, { role: 0 })), null);
  // éléments invalides ignorés : vides, non chaînes, trop longs
  assert.equal(readClarification(withClar({ choices: ['', '  ', 3, null, 'x'.repeat(81), 'ok'] })), null);
  const r = readClarification(withClar({ question: 42, choices: ['', 3, 'x'.repeat(80), 'ok'] }));
  assert.deepEqual(r, { question: null, choices: ['x'.repeat(80), 'ok'] });
});
