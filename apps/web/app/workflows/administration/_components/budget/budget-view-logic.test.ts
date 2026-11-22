// Lancer : cd apps/web && npx tsx --test app/workflows/administration/_components/budget/budget-view-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBudgetUpdate } from '../../../_lib/budget-logic';
import {
  capBlocksImmediately,
  fieldErrors,
  formFromRow,
  progressPercent,
  progressText,
  stopAuthorText,
  thresholdToPercentText,
  workflowDisplayName,
  workflowsWithoutBudget,
} from './budget-view-logic';

test('progressPercent borne la barre, progressText garde la valeur réelle', () => {
  assert.equal(progressPercent(null), 0);
  assert.equal(progressPercent(0.724), 72);
  assert.equal(progressPercent(1.8), 100);
  assert.equal(progressPercent(-1), 0);
  assert.equal(progressText(0.72), '72 % du plafond');
  assert.equal(progressText(1.2), '120 % du plafond');
  assert.equal(progressText(null), 'Aucun plafond défini');
});

test('thresholdToPercentText', () => {
  assert.equal(thresholdToPercentText('0.8000'), '80');
  assert.equal(thresholdToPercentText('0.125'), '12,5');
  assert.equal(thresholdToPercentText(''), '');
  assert.equal(thresholdToPercentText('abc'), '');
});

test('workflowDisplayName : repli', () => {
  const names = new Map([[3, 'Facturation']]);
  assert.equal(workflowDisplayName(null, names), 'Plafond global');
  assert.equal(workflowDisplayName(3, names), 'Facturation');
  assert.equal(workflowDisplayName(9, names), 'Workflow n° 9');
});

test('formFromRow est accepté par buildBudgetUpdate et conserve capAmount', () => {
  const row = { definitionId: 4, periodKind: 1, capAmount: '5000.0000', alertThreshold: '0.8000', currency: 'XOF', consumedAmount: '0' };
  const form = formFromRow(row);
  assert.equal(form.capRaw, '5000');
  const res = buildBudgetUpdate(form);
  assert.equal(res.ok, true);
  assert.deepEqual(res.input, { definitionId: 4, capAmount: 5000, periodKind: 1, alertThreshold: 0.8, currency: 'XOF' });
  const noCap = buildBudgetUpdate(formFromRow({ ...row, capAmount: null }));
  assert.equal(noCap.input?.capAmount, null);
});

test('fieldErrors par champ', () => {
  const e = fieldErrors({ definitionId: null, capRaw: 'abc', periodKind: 7, thresholdRaw: '150', currencyRaw: 'x' });
  assert.ok(e.cap && e.period && e.threshold && e.currency);
  assert.deepEqual(fieldErrors({ definitionId: null, capRaw: '', periodKind: 0, thresholdRaw: '80', currencyRaw: 'xof' }), {});
});

test('capBlocksImmediately', () => {
  assert.equal(capBlocksImmediately(null, '100'), false);
  assert.equal(capBlocksImmediately(50, '100'), true);
  assert.equal(capBlocksImmediately(100, '100'), true);
  assert.equal(capBlocksImmediately(500, '100'), false);
  assert.equal(capBlocksImmediately(0, '0'), true);
});

test('workflowsWithoutBudget exclut les lignes existantes et trie', () => {
  const defs = [
    { wfDefinitionId: 1, name: 'Zèbre' },
    { wfDefinitionId: 2, name: 'Achats' },
    { wfDefinitionId: 3, name: 'Congés' },
  ];
  const res = workflowsWithoutBudget(defs, [{ definitionId: null }, { definitionId: 3 }]);
  assert.deepEqual(res, [
    { value: 2, label: 'Achats' },
    { value: 1, label: 'Zèbre' },
  ]);
});

test('stopAuthorText', () => {
  assert.equal(stopAuthorText(12), 'utilisateur n° 12');
  assert.equal(stopAuthorText(null), 'auteur inconnu');
});
