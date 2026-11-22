// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/tools/tools-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGrantRows } from '../../../_lib/guardrails-logic';
import {
  diffAgainst,
  grantUsedTools,
  hasBlockingErrors,
  isDirty,
  missingForRows,
  payloadOf,
  rowError,
  toEditRows,
  usedByIndex,
  usedByLabel,
} from './tools-logic';

const catalog = [
  { toolKey: 'doc.read', label: 'Lire', description: null, sideEffect: 0, requiresValidation: false, isEnabled: true },
  { toolKey: 'mail.send', label: 'Envoyer', description: null, sideEffect: 2, requiresValidation: true, isEnabled: true },
  { toolKey: 'old.tool', label: 'Ancien', description: null, sideEffect: 1, requiresValidation: false, isEnabled: false },
];
const graph = {
  steps: [
    { key: 'a', name: 'Lecture', type: 'agent', agent: { tools: ['doc.read', 'mail.send', 'old.tool', 'ghost'] } },
    { key: 'b', name: 'Relecture', type: 'agent', agent: { tools: ['doc.read'] } },
    { key: 'c', name: 'Humain', type: 'human' },
  ],
};
const base = () => toEditRows(buildGrantRows(catalog, [{ toolKey: 'doc.read', maxCallsPerInstance: 5 }]));
const edit = (rows: ReturnType<typeof base>, key: string, patch: object) =>
  rows.map((r) => (r.toolKey === key ? { ...r, ...patch } : r));

test("état non modifié puis modifié, retour à l'état initial", () => {
  const b = base();
  assert.equal(isDirty(b, b), false);
  const changed = edit(b, 'mail.send', { granted: true });
  assert.equal(isDirty(b, changed), true);
  assert.equal(isDirty(b, edit(changed, 'mail.send', { granted: false })), false);
  assert.equal(isDirty(b, edit(b, 'doc.read', { maxCallsText: ' 5 ' })), false);
  assert.equal(isDirty(b, edit(b, 'doc.read', { maxCallsText: '' })), true);
});

test('validation : plafond invalide, outil désactivé ou orphelin coché bloquent', () => {
  const b = base();
  assert.equal(hasBlockingErrors(b), false);
  const bad = edit(b, 'doc.read', { maxCallsText: 'abc' }).find((r) => r.toolKey === 'doc.read');
  assert.match(rowError(bad!) ?? '', /entier/);
  assert.equal(hasBlockingErrors(edit(b, 'doc.read', { maxCallsText: '0' })), true);
  assert.equal(hasBlockingErrors(edit(b, 'old.tool', { granted: true })), true);
  const orphan = toEditRows(buildGrantRows(catalog, [{ toolKey: 'zzz', maxCallsPerInstance: null }]));
  assert.match(rowError(orphan.find((r) => r.orphan)!) ?? '', /n'existe plus/);
  // Une ligne non cochée n'est pas contrôlée.
  assert.equal(hasBlockingErrors(edit(b, 'mail.send', { maxCallsText: 'zz' })), false);
});

test('payload et récapitulatif', () => {
  const b = base();
  const next = edit(edit(b, 'mail.send', { granted: true, maxCallsText: '2' }), 'doc.read', { maxCallsText: '' });
  assert.deepEqual(payloadOf(next), [
    { toolKey: 'doc.read', maxCallsPerInstance: null },
    { toolKey: 'mail.send', maxCallsPerInstance: 2 },
  ]);
  assert.deepEqual(diffAgainst(b, next), { added: ['mail.send'], removed: [], changedLimit: ['doc.read'] });
});

test('outils utilisés : index, libellé, manquants', () => {
  const idx = usedByIndex(graph);
  assert.deepEqual(idx.get('doc.read'), ['Lecture', 'Relecture']);
  assert.equal(usedByLabel(['Lecture']), "utilisé par l'étape « Lecture »");
  assert.equal(usedByLabel(['A', 'B']), 'utilisé par les étapes « A », « B »');
  assert.equal(usedByLabel([]), '');
  assert.deepEqual(
    missingForRows(graph, base()).map((m) => m.toolKey),
    ['mail.send', 'old.tool', 'ghost'],
  );
  assert.deepEqual(missingForRows(null, base()), []);
});

test('« Autoriser les outils utilisés » : coche les activés, signale irréversibles, désactivés, inconnus', () => {
  const b = base();
  const r = grantUsedTools(b, graph);
  assert.deepEqual(r.added, ['mail.send']);
  assert.deepEqual(r.irreversibleAdded, ['mail.send']);
  assert.deepEqual(r.disabled, ['old.tool']);
  assert.deepEqual(r.unknown, ['ghost']);
  assert.equal(r.rows.find((x) => x.toolKey === 'old.tool')!.granted, false);
  assert.equal(r.rows.find((x) => x.toolKey === 'doc.read')!.maxCallsText, '5');
  assert.equal(grantUsedTools(b, null).added.length, 0);
});
