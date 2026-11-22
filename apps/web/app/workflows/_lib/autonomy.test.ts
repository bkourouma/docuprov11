// Tests de la disponibilité du niveau « autonome ».
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/autonomy.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTONOMY_OPTIONS, autonomyAvailability } from './autonomy';

test('autorisé seulement si faible risque ET évaluation réussie', () => {
  assert.deepEqual(autonomyAvailability({ isLowRisk: true, hasPassedEval: true }), { allowed: true, reason: null });
  for (const [isLowRisk, hasPassedEval] of [
    [true, false],
    [false, true],
    [false, false],
    [true, null],
    [false, null],
  ] as const) {
    const r = autonomyAvailability({ isLowRisk, hasPassedEval });
    assert.equal(r.allowed, false, `${isLowRisk}/${hasPassedEval}`);
    assert.ok(r.reason && r.reason.length > 10);
  }
});

test('motifs distincts selon le manque', () => {
  const noRisk = autonomyAvailability({ isLowRisk: false, hasPassedEval: true }).reason;
  const noEval = autonomyAvailability({ isLowRisk: true, hasPassedEval: false }).reason;
  const unavailable = autonomyAvailability({ isLowRisk: true, hasPassedEval: null }).reason;
  const both = autonomyAvailability({ isLowRisk: false, hasPassedEval: false }).reason;
  assert.match(noRisk!, /faible risque par un administrateur/);
  assert.match(noEval!, /évaluation réussie/);
  assert.match(unavailable!, /ne sont pas encore disponibles/);
  assert.match(both!, /faible risque/);
  assert.match(both!, /évaluation/);
  assert.equal(new Set([noRisk, noEval, unavailable, both]).size, 4);
});

test('trois options d’autonomie, clés conformes au graphe', () => {
  assert.deepEqual(
    AUTONOMY_OPTIONS.map((o) => o.key),
    ['suggere', 'agit_avec_validation', 'autonome'],
  );
  for (const o of AUTONOMY_OPTIONS) assert.ok(o.label && o.description);
});
