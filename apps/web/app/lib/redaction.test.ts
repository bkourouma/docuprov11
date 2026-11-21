// Tests des fonctions pures du client de rédaction assistée.
// Lancer : cd apps/web && npx tsx --test app/lib/redaction.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GED_DRAFT_INSTRUCTION_MAX_CHARS,
  GED_DRAFT_OUTPUT_MAX_CHARS,
  acquireInsertLock,
  buildDraftRequest,
  canInsertDraft,
  defaultDraftTemplateId,
  describeDraftError,
  isEmptyTemplate,
  isInstructionValid,
  parseRetryAfter,
  resetInsertLock,
  selectionRange,
  settleInsertLock,
  skeletonTemplates,
} from './redaction';

test('describeDraftError : messages français par statut', () => {
  assert.equal(describeDraftError(429, 'x'), 'Trop de demandes, patientez quelques secondes.');
  assert.match(describeDraftError(404, ''), /plus accessible/);
  assert.match(describeDraftError(409, ''), /Rechargez/);
  assert.match(describeDraftError(502, ''), /indisponible/);
  assert.match(describeDraftError(503, ''), /indisponible/);
  assert.match(describeDraftError(0, ''), /injoignable/);
  assert.match(describeDraftError(0, ''), /conservée/);
  assert.equal(describeDraftError(400, ' Consigne trop courte '), 'Consigne trop courte');
  assert.match(describeDraftError(500, 'stack interne'), /a échoué/);
  assert.doesNotMatch(describeDraftError(500, 'stack interne'), /stack/);
});

test('canInsertDraft : non vide et sous la taille maximale', () => {
  assert.equal(canInsertDraft(''), false);
  assert.equal(canInsertDraft('   \n'), false);
  assert.equal(canInsertDraft('<p>a</p>'), true);
  assert.equal(canInsertDraft('a'.repeat(GED_DRAFT_OUTPUT_MAX_CHARS)), true);
  assert.equal(canInsertDraft('a'.repeat(GED_DRAFT_OUTPUT_MAX_CHARS + 1)), false);
});

test('selectionRange : null si vide, bornes ordonnées sinon', () => {
  assert.equal(selectionRange({ from: 3, to: 3, empty: true }), null);
  assert.equal(selectionRange({ from: 3, to: 3, empty: false }), null);
  assert.deepEqual(selectionRange({ from: 2, to: 9, empty: false }), { from: 2, to: 9 });
  assert.deepEqual(selectionRange({ from: 9, to: 2, empty: false }), { from: 2, to: 9 });
});

test('isInstructionValid : bornes du contrat', () => {
  assert.equal(isInstructionValid('  ab '), false);
  assert.equal(isInstructionValid('abc'), true);
  assert.equal(isInstructionValid('a'.repeat(GED_DRAFT_INSTRUCTION_MAX_CHARS + 1)), false);
});

test('buildDraftRequest : contexte seulement si coché, consigne rognée', () => {
  assert.deepEqual(buildDraftRequest({ templateId: 'note', instruction: ' Rédige ', useContext: false, documentId: 7 }), {
    templateId: 'note',
    instruction: 'Rédige',
  });
  assert.deepEqual(buildDraftRequest({ templateId: 'note', instruction: 'Rédige', useContext: true, documentId: 7 }), {
    templateId: 'note',
    instruction: 'Rédige',
    contextDocumentIds: [7],
  });
});

test('modèles : squelettes sans le vide, défaut, détection du vide', () => {
  const t = [{ id: 'vide' }, { id: 'note' }, { id: 'pv' }];
  assert.deepEqual(skeletonTemplates(t), [{ id: 'note' }, { id: 'pv' }]);
  assert.equal(defaultDraftTemplateId(t), 'note');
  assert.equal(defaultDraftTemplateId([{ id: 'vide' }]), 'vide');
  assert.equal(defaultDraftTemplateId([]), undefined);
  assert.equal(isEmptyTemplate(undefined), true);
  assert.equal(isEmptyTemplate('vide'), true);
  assert.equal(isEmptyTemplate('note'), false);
});

test('parseRetryAfter : secondes valides uniquement', () => {
  assert.equal(parseRetryAfter('12'), 12);
  assert.equal(parseRetryAfter('1.2'), 2);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('abc'), null);
  assert.equal(parseRetryAfter('-1'), null);
});

test('verrou d’insertion : le second clic est ignoré, un échec relève le verrou, un nouveau brouillon aussi', () => {
  const lock = { current: false };
  assert.equal(acquireInsertLock(lock), true);
  assert.equal(acquireInsertLock(lock), false, 'double clic : pas de seconde insertion');
  settleInsertLock(lock, true);
  assert.equal(acquireInsertLock(lock), false, 'insertion réussie : verrou conservé');
  resetInsertLock(lock);
  assert.equal(acquireInsertLock(lock), true, 'nouvelle proposition : insertion à nouveau possible');
  settleInsertLock(lock, false);
  assert.equal(acquireInsertLock(lock), true, 'échec : verrou relevé, nouvel essai possible');
});
