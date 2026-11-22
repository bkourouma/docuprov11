// Tests de la logique pure des plafonds et de l'arrêt d'urgence.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/budget-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMERGENCY_STOP_CONFIRM_WORD,
  buildBudgetUpdate,
  canConfirmEmergencyStop,
  consumptionLevel,
  consumptionRatio,
  describeBudget,
  emergencyStopScopeLabel,
  emergencyStopWarning,
  formatAmount,
  formatPercent,
  formatTokens,
  parseCapInput,
  parseCurrency,
  parseThresholdInput,
  periodKindLabel,
  statusSummary,
  validateStopReason,
  type BudgetLike,
} from './budget-logic';

/** Espaces insécables et fines insécables ramenés à une espace simple, pour comparer sans dépendre de l'ICU. */
const plain = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');

const budget = (over: Partial<BudgetLike> = {}): BudgetLike => ({
  periodKind: 0,
  capAmount: '500.0000',
  consumedAmount: '120.0000',
  consumedTokens: '1234567',
  alertThreshold: '0.8000',
  currency: 'XOF',
  emergencyStop: false,
  ...over,
});

test('formatAmount', () => {
  assert.equal(plain(formatAmount('1234.5', 'XOF')), '1 234,50 XOF');
  assert.equal(plain(formatAmount(0, 'EUR')), '0,00 EUR');
  assert.equal(plain(formatAmount('0.0042', 'XOF')), '0,0042 XOF');
  assert.equal(formatAmount(null, 'XOF'), '—');
  assert.equal(formatAmount('abc', 'XOF'), '—');
  assert.equal(plain(formatAmount(5, '')), '5,00');
});

test('formatTokens', () => {
  assert.equal(plain(formatTokens('1234567')), '1 234 567');
  assert.equal(plain(formatTokens(1500)), '1 500');
  assert.equal(plain(formatTokens('99999999999999999999')), '99 999 999 999 999 999 999');
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens('x'), '—');
});

test('periodKindLabel', () => {
  assert.equal(periodKindLabel(0), 'Mensuel');
  assert.equal(periodKindLabel(1), 'Journalier');
  assert.equal(periodKindLabel(2), 'Cumulé');
  assert.equal(periodKindLabel(7), 'Période inconnue');
});

test('consumptionRatio : sans plafond, plafond nul, nominal', () => {
  assert.equal(consumptionRatio(budget({ capAmount: null })), null);
  assert.equal(consumptionRatio(budget()), 0.24);
  assert.equal(consumptionRatio(budget({ capAmount: '0.0000', consumedAmount: '0' })), 1);
  assert.equal(consumptionRatio(budget({ capAmount: '100', consumedAmount: '150' })), 1.5);
  assert.equal(consumptionRatio(budget({ capAmount: 'abc' })), null);
});

test('consumptionLevel : ok, attention, dépassé, libellés texte', () => {
  assert.deepEqual(consumptionLevel(budget()), { level: 'ok', label: 'Dans le budget', ratio: 0.24 });
  assert.equal(consumptionLevel(budget({ consumedAmount: '400' })).level, 'attention', 'ratio == seuil');
  assert.equal(consumptionLevel(budget({ consumedAmount: '399.99' })).level, 'ok');
  assert.equal(consumptionLevel(budget({ consumedAmount: '500' })).level, 'depasse', 'ratio == 1');
  assert.equal(consumptionLevel(budget({ consumedAmount: '900' })).level, 'depasse');
  assert.deepEqual(consumptionLevel(budget({ capAmount: null })), { level: 'ok', label: 'Sans plafond', ratio: null });
  // Seuil invalide : repli sur 0,8.
  assert.equal(consumptionLevel(budget({ alertThreshold: 'zzz', consumedAmount: '400' })).level, 'attention');
  for (const l of ['ok', 'attention', 'depasse'] as const) {
    const cons = { ok: '10', attention: '450', depasse: '600' }[l];
    assert.ok(consumptionLevel(budget({ consumedAmount: cons })).label.length > 5);
  }
});

test('formatPercent et describeBudget', () => {
  assert.equal(formatPercent(0.24), '24 %');
  assert.equal(formatPercent(null), '—');
  const d = plain(describeBudget(budget()));
  assert.match(d, /^Mensuel : 120,00 XOF consommés, 1 234 567 jetons sur 500,00 XOF \(24 %\)/);
  assert.match(d, /dans le budget/);
  const noCap = plain(describeBudget(budget({ capAmount: null, emergencyStop: true, consumedTokens: undefined })));
  assert.match(noCap, /sans plafond/);
  assert.match(noCap, /Arrêt d'urgence actif/);
});

test('parseCapInput', () => {
  assert.deepEqual(parseCapInput(''), { ok: true, value: null });
  assert.deepEqual(parseCapInput('  '), { ok: true, value: null });
  assert.deepEqual(parseCapInput('5000'), { ok: true, value: 5000 });
  assert.deepEqual(parseCapInput('12,5'), { ok: true, value: 12.5 });
  assert.deepEqual(parseCapInput('1 000,25'), { ok: true, value: 1000.25 });
  assert.deepEqual(parseCapInput('0'), { ok: true, value: 0 });
  assert.deepEqual(parseCapInput('9999999999'), { ok: true, value: 9_999_999_999 });
  for (const bad of ['-1', 'abc', '9999999999,01', '10000000000', '1,23456', '1,2,3']) {
    const r = parseCapInput(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error);
  }
});

test('parseThresholdInput', () => {
  assert.deepEqual(parseThresholdInput('80'), { ok: true, value: 0.8 });
  assert.deepEqual(parseThresholdInput('80 %'), { ok: true, value: 0.8 });
  assert.deepEqual(parseThresholdInput('12,5'), { ok: true, value: 0.125 });
  assert.deepEqual(parseThresholdInput('0'), { ok: true, value: 0 });
  assert.deepEqual(parseThresholdInput('100'), { ok: true, value: 1 });
  for (const bad of ['', '101', '-5', 'x', '100,1']) {
    const r = parseThresholdInput(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error);
  }
});

test('parseCurrency', () => {
  assert.deepEqual(parseCurrency('XOF'), { ok: true, value: 'XOF' });
  assert.deepEqual(parseCurrency(' eur '), { ok: true, value: 'EUR' });
  for (const bad of ['', 'XO', 'XOFF', 'X0F', 'é€$']) assert.equal(parseCurrency(bad).ok, false, bad);
});

test('buildBudgetUpdate', () => {
  const ok = buildBudgetUpdate({ definitionId: 7, capRaw: '1 500,5', periodKind: 1, thresholdRaw: '75', currencyRaw: 'xof' });
  assert.deepEqual(ok, {
    ok: true,
    errors: [],
    input: { definitionId: 7, capAmount: 1500.5, periodKind: 1, alertThreshold: 0.75, currency: 'XOF' },
  });
  const removed = buildBudgetUpdate({ definitionId: null, capRaw: '', periodKind: 0, thresholdRaw: '80', currencyRaw: 'XOF' });
  assert.equal(removed.input!.capAmount, null);
  assert.equal(removed.input!.definitionId, null);
  const bad = buildBudgetUpdate({ definitionId: 0, capRaw: '-3', periodKind: 5, thresholdRaw: '', currencyRaw: '1' });
  assert.equal(bad.ok, false);
  assert.equal(bad.input, undefined);
  assert.equal(bad.errors.length, 5);
});

test('portée de l’arrêt d’urgence', () => {
  assert.match(emergencyStopScopeLabel(null), /Tous les workflows/);
  assert.equal(emergencyStopScopeLabel(12), 'Workflow n° 12');
  assert.equal(emergencyStopScopeLabel(12, ' Factures '), 'Workflow n° 12 « Factures »');
  assert.match(emergencyStopScopeLabel(undefined), /global/);
});

test('canConfirmEmergencyStop : casse, accents, espaces', () => {
  assert.equal(EMERGENCY_STOP_CONFIRM_WORD, 'ARRÊT');
  const expected = EMERGENCY_STOP_CONFIRM_WORD;
  for (const typed of ['ARRÊT', 'arrêt', 'arret', '  Arret  ', 'ARRET']) {
    assert.equal(canConfirmEmergencyStop({ typed, expected }), true, typed);
  }
  for (const typed of ['', 'arre', 'arrêts', 'ar rêt', 'STOP']) {
    assert.equal(canConfirmEmergencyStop({ typed, expected }), false, typed);
  }
  assert.equal(canConfirmEmergencyStop({ typed: '', expected: '' }), false, 'mot attendu vide : jamais valide');
  assert.equal(canConfirmEmergencyStop({ typed: 'oui', expected: 'OUI' }), true);
  assert.equal(canConfirmEmergencyStop({ typed: 'arret' }), true);
});

test('validateStopReason', () => {
  assert.deepEqual(validateStopReason('  Dérive de coûts  '), { ok: true, value: 'Dérive de coûts' });
  const empty = validateStopReason('');
  assert.equal(empty.ok, true);
  assert.ok(empty.warning);
  assert.equal(validateStopReason('', false).warning, undefined);
  assert.equal(validateStopReason('a'.repeat(500)).ok, true);
  const long = validateStopReason('a'.repeat(501));
  assert.equal(long.ok, false);
  assert.ok(long.error);
});

test('emergencyStopWarning : conséquences', () => {
  const on = emergencyStopWarning(null, true);
  assert.match(on, /tous les workflows/);
  assert.match(on, /plus aucun appel/);
  assert.match(on, /pas suivant/);
  assert.match(on, /reviennent à une personne/);
  assert.match(on, /reprise/);
  assert.match(emergencyStopWarning(5, true), /workflow n° 5/);
  const off = emergencyStopWarning(5, false);
  assert.match(off, /Lever/);
  assert.match(off, /reprennent/);
});

test('statusSummary', () => {
  const s = (a: boolean, g: boolean, n: number | null) =>
    statusSummary(
      { aiEnabled: a, aiMode: 1, emergencyStopGlobal: g },
      n === null ? null : { global: { emergencyStop: false }, workflows: Array.from({ length: n + 1 }, (_, i) => ({ emergencyStop: i < n })) },
    );
  assert.equal(s(true, false, 0), 'L\'IA est active. Aucun arrêt d\'urgence global. Aucun workflow à l\'arrêt.');
  assert.match(s(false, true, 1), /désactivée\. Arrêt d'urgence global actif.* 1 workflow est à l'arrêt\./);
  assert.match(s(true, false, 3), /3 workflows sont à l'arrêt\./);
  assert.match(s(true, false, null), /information indisponible/);
  assert.equal(statusSummary(null, null), 'État de l\'IA indisponible.');
  // Le budget global à l'arrêt compte aussi comme arrêt global.
  assert.match(
    statusSummary({ aiEnabled: true, emergencyStopGlobal: false }, { global: { emergencyStop: true }, workflows: [] }),
    /global actif/,
  );
});
