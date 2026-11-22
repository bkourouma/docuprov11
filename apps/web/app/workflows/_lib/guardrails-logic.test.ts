// Tests de la logique pure des garde-fous des agents (outils autorisés, bandeau d'autonomie).
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/guardrails-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_CALLS_LIMIT,
  autonomyBanner,
  buildGrantRows,
  describeGrantsDiff,
  diffGrants,
  grantsExplanation,
  grantsToPayload,
  missingGrants,
  sideEffectLabel,
  toolRiskNote,
  usedToolsByStep,
  validateMaxCalls,
} from './guardrails-logic';

test('bandeau « suggère » : avertissement explicite', () => {
  const b = autonomyBanner('suggere');
  assert.equal(b.tone, 'warning');
  assert.match(b.text, /rien n'est appliqué/);
  assert.match(b.text, /aucun effet/);
  assert.match(b.text, /Passez à « agit avec validation »/);
});

test('bandeaux des autres niveaux et clé inconnue (repli prudent)', () => {
  assert.equal(autonomyBanner('agit_avec_validation').tone, 'info');
  assert.match(autonomyBanner('agit_avec_validation').text, /validation humaine/);
  const auto = autonomyBanner('autonome');
  assert.equal(auto.tone, 'success');
  assert.match(auto.text, /faible risque/);
  assert.match(auto.text, /irréversible/);
  assert.equal(autonomyBanner('inconnu' as never).tone, 'warning');
  assert.equal(autonomyBanner('toString' as never).tone, 'warning');
});

test('libellés d’effet de bord et notes de risque', () => {
  assert.equal(sideEffectLabel(0), 'Lecture');
  assert.equal(sideEffectLabel(1), 'Écriture réversible');
  assert.equal(sideEffectLabel(2), 'Externe ou irréversible');
  assert.equal(sideEffectLabel(9), 'Effet inconnu');
  assert.equal(toolRiskNote({ sideEffect: 0, requiresValidation: false }), 'lecture seule');
  assert.equal(toolRiskNote({ sideEffect: 1, requiresValidation: true }), 'prépare une écriture, une personne valide');
  assert.equal(toolRiskNote({ sideEffect: 1, requiresValidation: false }), 'écriture réversible');
  assert.equal(toolRiskNote({ sideEffect: 2, requiresValidation: true }), 'irréversible, validation obligatoire');
  assert.match(toolRiskNote({ sideEffect: 7, requiresValidation: false }), /irréversible/);
});

const tool = (toolKey: string, isEnabled = true, sideEffect = 0) => ({
  toolKey,
  label: `Outil ${toolKey}`,
  description: null,
  sideEffect,
  requiresValidation: sideEffect > 0,
  isEnabled,
});

test('buildGrantRows : fusion, tri (activés d’abord puis clé) et orphelins', () => {
  const rows = buildGrantRows(
    [tool('zeta'), tool('alpha', false), tool('beta'), tool('beta')],
    [
      { toolKey: 'beta', maxCallsPerInstance: 3 },
      { toolKey: 'ancien', maxCallsPerInstance: null },
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.toolKey),
    ['beta', 'zeta', 'alpha', 'ancien'],
  );
  const beta = rows.find((r) => r.toolKey === 'beta')!;
  assert.equal(beta.granted, true);
  assert.equal(beta.maxCalls, 3);
  assert.equal(beta.orphan, false);
  assert.equal(rows.find((r) => r.toolKey === 'zeta')!.granted, false);
  const orphan = rows.find((r) => r.toolKey === 'ancien')!;
  assert.equal(orphan.orphan, true);
  assert.equal(orphan.granted, true);
  assert.equal(orphan.sideEffect, 2);
});

test('buildGrantRows : listes vides', () => {
  assert.deepEqual(buildGrantRows([], []), []);
  assert.equal(buildGrantRows([tool('a')], [])[0]!.granted, false);
});

test('validateMaxCalls : vide, valide, bornes, texte', () => {
  assert.deepEqual(validateMaxCalls(''), { ok: true, value: null });
  assert.deepEqual(validateMaxCalls('  '), { ok: true, value: null });
  assert.deepEqual(validateMaxCalls('5'), { ok: true, value: 5 });
  assert.deepEqual(validateMaxCalls(String(MAX_CALLS_LIMIT)), { ok: true, value: MAX_CALLS_LIMIT });
  for (const bad of ['0', '-1', '1.5', '1,5', 'abc', String(MAX_CALLS_LIMIT + 1), '99999999999999999999']) {
    const r = validateMaxCalls(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.value, null);
    assert.ok(r.error);
  }
});

test('grantsToPayload : seulement les lignes cochées, sans doublon, clés valides', () => {
  const payload = grantsToPayload([
    { toolKey: 'a.b', granted: true, maxCalls: 2 },
    { toolKey: 'a.b', granted: true, maxCalls: 9 },
    { toolKey: 'c', granted: false, maxCalls: null },
    { toolKey: 'D majuscule', granted: true, maxCalls: null },
    { toolKey: '', granted: true, maxCalls: null },
    { toolKey: 'e_1', granted: true, maxCalls: null },
    { toolKey: 'f', granted: true, maxCalls: 0 },
    { toolKey: 'g', granted: true, maxCalls: MAX_CALLS_LIMIT + 1 },
    { toolKey: 'x'.repeat(101), granted: true, maxCalls: null },
  ]);
  assert.deepEqual(payload, [
    { toolKey: 'a.b', maxCallsPerInstance: 2 },
    { toolKey: 'e_1', maxCallsPerInstance: null },
  ]);
  assert.deepEqual(grantsToPayload([]), []);
});

test('diffGrants et describeGrantsDiff', () => {
  const d = diffGrants(
    [
      { toolKey: 'a', maxCallsPerInstance: null },
      { toolKey: 'b', maxCallsPerInstance: 2 },
      { toolKey: 'c', maxCallsPerInstance: 1 },
    ],
    [
      { toolKey: 'b', maxCallsPerInstance: 5 },
      { toolKey: 'c', maxCallsPerInstance: 1 },
      { toolKey: 'd', maxCallsPerInstance: null },
    ],
  );
  assert.deepEqual(d, { added: ['d'], removed: ['a'], changedLimit: ['b'] });
  assert.equal(describeGrantsDiff(d), 'Outil ajouté : d. Outil retiré : a. Limite modifiée pour : b.');
  const none = diffGrants([], []);
  assert.deepEqual(none, { added: [], removed: [], changedLimit: [] });
  assert.equal(describeGrantsDiff(none), 'Aucun changement.');
  assert.match(describeGrantsDiff({ added: ['x', 'y'], removed: [], changedLimit: [] }), /Outils ajoutés : x, y\./);
});

const graph = {
  steps: [
    { key: 'debut', name: 'Début', type: 'human' },
    { key: 'analyse', name: 'Analyse', type: 'agent', agent: { tools: ['lire', 'ecrire', 'lire'] } },
    { key: 'relance', name: 'Relance', type: 'agent', agent: { tools: ['envoyer'] } },
    { key: 'faux', name: 'Sans config', type: 'agent' },
  ],
};

test('usedToolsByStep : étapes agent seulement, sans doublon', () => {
  assert.deepEqual(usedToolsByStep(graph), [
    { stepKey: 'analyse', stepName: 'Analyse', toolKeys: ['lire', 'ecrire'] },
    { stepKey: 'relance', stepName: 'Relance', toolKeys: ['envoyer'] },
  ]);
  assert.deepEqual(usedToolsByStep(null), []);
  assert.deepEqual(usedToolsByStep({ steps: [] }), []);
});

test('missingGrants : outils utilisés mais non autorisés', () => {
  assert.deepEqual(missingGrants(graph, ['lire']), [
    { stepKey: 'analyse', stepName: 'Analyse', toolKey: 'ecrire' },
    { stepKey: 'relance', stepName: 'Relance', toolKey: 'envoyer' },
  ]);
  assert.deepEqual(missingGrants(graph, new Set(['lire', 'ecrire', 'envoyer'])), []);
  assert.equal(missingGrants(graph, []).length, 3);
  assert.deepEqual(missingGrants(undefined, ['x']), []);
});

test('grantsExplanation : liste blanche, code d’erreur, outil retiré', () => {
  const t = grantsExplanation();
  assert.match(t, /liste blanche/);
  assert.match(t, /AGENT_TOOL_NOT_GRANTED/);
  assert.match(t, /indisponible à l'exécution/);
});
