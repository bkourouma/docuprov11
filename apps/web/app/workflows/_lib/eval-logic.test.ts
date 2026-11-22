// Tests de la logique pure de l'évaluation des agents.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/eval-logic.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EVAL_MAX_ACTIVE_CASES,
  canAddCase,
  eligibilityLabel,
  emptyEvalCaseDraft,
  evalCaseDraftToPayload,
  evalCaseToDraft,
  evalChecklist,
  evalRunStatusLabel,
  evalRunVerdict,
  foldText,
  formatAccuracy,
  isRunInProgress,
  latestRun,
  parseMinAccuracy,
  perCaseResults,
  pollDelayMs,
  shouldKeepPolling,
  type EvalCaseDraft,
  type EvalRunLike,
} from './eval-logic';

const run = (over: Partial<EvalRunLike> = {}): EvalRunLike => ({
  wfEvalRunId: '1',
  status: 1,
  totalCases: 14,
  passedCases: 12,
  accuracy: '0.857',
  requiredAccuracy: '0.800',
  passed: true,
  errorMessage: null,
  startedAt: '2026-11-22T10:00:00Z',
  finishedAt: '2026-11-22T10:01:00Z',
  ...over,
});

test('formatAccuracy', () => {
  assert.equal(formatAccuracy('0.857'), '85,7 %');
  assert.equal(formatAccuracy(0.8), '80,0 %');
  assert.equal(formatAccuracy('1.000'), '100,0 %');
  assert.equal(formatAccuracy(null), '—');
  assert.equal(formatAccuracy(undefined), '—');
  assert.equal(formatAccuracy(''), '—');
  assert.equal(formatAccuracy('abc'), '—');
  assert.equal(formatAccuracy(1.7), '100,0 %');
  assert.equal(formatAccuracy(-1), '0,0 %');
});

test('evalRunStatusLabel', () => {
  assert.equal(evalRunStatusLabel(0), 'En cours');
  assert.equal(evalRunStatusLabel(1), 'Terminé');
  assert.equal(evalRunStatusLabel(2), 'En erreur');
  assert.equal(evalRunStatusLabel(42), 'Statut inconnu');
});

test('evalRunVerdict : réussi, échoué, en cours, en erreur', () => {
  const ok = evalRunVerdict(run());
  assert.equal(ok.label, 'Réussi');
  assert.equal(ok.tone, 'success');
  assert.equal(ok.detail, '12 cas réussis sur 14, précision 85,7 % pour 80,0 % requis');

  const ko = evalRunVerdict(run({ passed: false, passedCases: 1, accuracy: '0.071' }));
  assert.equal(ko.label, 'Échoué');
  assert.equal(ko.tone, 'error');
  assert.match(ko.detail, /^1 cas réussi sur 14, précision 7,1 %/);

  assert.equal(evalRunVerdict(run({ status: 0, accuracy: null, finishedAt: null })).label, 'En cours');

  const err = evalRunVerdict(run({ status: 2, errorMessage: 'Modèle indisponible.', passedCases: 3, accuracy: null }));
  assert.equal(err.label, 'En erreur');
  assert.match(err.detail, /Modèle indisponible\./);
  assert.match(err.detail, /3 cas réussis sur 14/);
  assert.match(evalRunVerdict(run({ status: 2, errorMessage: null, passedCases: 0 })).detail, /interrompue/);
  assert.equal(evalRunVerdict(run({ status: 99 })).label, 'En erreur');
});

test('evalRunVerdict : aucun cas évalué', () => {
  const v = evalRunVerdict(run({ totalCases: 0, passedCases: 0, accuracy: null, passed: false }));
  assert.equal(v.label, 'Échoué');
  assert.match(v.detail, /Aucun cas/);
});

test('latestRun, isRunInProgress', () => {
  assert.equal(latestRun([]), null);
  assert.equal(latestRun(null), null);
  const a = run({ wfEvalRunId: '9', startedAt: '2026-11-22T09:00:00Z' });
  const b = run({ wfEvalRunId: '10', startedAt: '2026-11-22T11:00:00Z' });
  const c = run({ wfEvalRunId: '11', startedAt: '2026-11-22T11:00:00Z' });
  assert.equal(latestRun([a, b]), b);
  assert.equal(latestRun([b, a]), b);
  assert.equal(latestRun([b, c, a]), c, 'même date : identifiant le plus grand (comparaison numérique)');
  assert.equal(latestRun([run({ startedAt: 'nimporte' }), a]), a);
  assert.equal(isRunInProgress(run({ status: 0 })), true);
  assert.equal(isRunInProgress(run({ status: 1 })), false);
  assert.equal(isRunInProgress(null), false);
});

test('pollDelayMs : progressif et plafonné', () => {
  assert.equal(pollDelayMs(0), 1500);
  assert.ok(pollDelayMs(1) > 1500 && pollDelayMs(1) < 5000);
  assert.equal(pollDelayMs(10), 5000);
  assert.equal(pollDelayMs(1_000_000), 5000);
  assert.equal(pollDelayMs(-3), 1500);
  assert.equal(pollDelayMs(Number.NaN), 1500);
  let prev = 0;
  for (let i = 0; i < 12; i++) {
    const d = pollDelayMs(i);
    assert.ok(d >= prev && d >= 1500 && d <= 5000);
    prev = d;
  }
});

test('shouldKeepPolling : arrêt après 15 minutes', () => {
  const running = run({ status: 0 });
  assert.equal(shouldKeepPolling(running, 0), true);
  assert.equal(shouldKeepPolling(running, 14 * 60_000), true);
  assert.equal(shouldKeepPolling(running, 15 * 60_000), false);
  assert.equal(shouldKeepPolling(run({ status: 1 }), 1000), false);
  assert.equal(shouldKeepPolling(null, 1000), false);
  assert.equal(shouldKeepPolling(running, Number.NaN), false);
  assert.equal(shouldKeepPolling(running, -5), false);
});

test('perCaseResults : forme réelle et JSON inconnu', () => {
  const r = perCaseResults({
    agentSpecHash: 'x',
    cases: [
      { caseId: 4, passed: true, confidence: 0.9, disposition: 'complete' },
      { caseId: 5, passed: false, reason: 'Confiance absente.' },
      { passed: false, label: 'Cas sans id', reason: '' },
      { caseId: 'x', passed: 'oui' },
      null,
      42,
    ],
  });
  assert.deepEqual(r, [
    { passed: true, caseId: 4 },
    { passed: false, caseId: 5, reason: 'Confiance absente.' },
    { passed: false, label: 'Cas sans id' },
  ]);
  for (const bad of [null, undefined, 'texte', 12, [], {}, { cases: 'x' }, { cases: {} }]) {
    assert.deepEqual(perCaseResults(bad), []);
  }
});

test('parseMinAccuracy', () => {
  assert.deepEqual(parseMinAccuracy('0,85'), { ok: true, value: 0.85 });
  assert.deepEqual(parseMinAccuracy('0.857'), { ok: true, value: 0.857 });
  assert.deepEqual(parseMinAccuracy(' 1 '), { ok: true, value: 1 });
  assert.deepEqual(parseMinAccuracy('.9'), { ok: true, value: 0.9 });
  assert.deepEqual(parseMinAccuracy('0,8'), { ok: true, value: 0.8 });
  const low = parseMinAccuracy('0,79');
  assert.equal(low.ok, false);
  assert.match(low.error!, /plancher de 80,0 %/);
  for (const bad of ['', 'abc', '1,01', '0,8571', '-0,9', '85 %', '0,8,5']) {
    const r = parseMinAccuracy(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.value, null);
    assert.ok(r.error);
  }
});

const validDraft = (over: Partial<EvalCaseDraft> = {}): EvalCaseDraft => ({
  ...emptyEvalCaseDraft(),
  label: ' Facture simple ',
  returnsToHuman: false,
  ...over,
});

test('canAddCase : au plus 500 cas actifs', () => {
  assert.equal(canAddCase(0), true);
  assert.equal(canAddCase(EVAL_MAX_ACTIVE_CASES - 1), true);
  assert.equal(canAddCase(EVAL_MAX_ACTIVE_CASES), false);
  assert.equal(canAddCase(Number.NaN), false);
});

test('evalCaseDraftToPayload : cas nominal complet', () => {
  const r = evalCaseDraftToPayload(
    validDraft({
      blocks: [{ origin: 'mail', label: '', text: 'Bonjour' }, { origin: 'ocr', label: 'Scan', text: '' }],
      subjectType: 'document',
      subjectId: '12',
      contextJson: '{"montant": 120}',
      suspicionInjection: false,
      minConfidence: '0,8',
      resultJson: '{"categorie": "facture"}',
      weight: '3',
      sortOrder: '10',
    }),
  );
  assert.equal(r.ok, true, r.errors.join('|'));
  assert.deepEqual(r.payload, {
    label: 'Facture simple',
    input: {
      untrusted: [
        { label: 'mail', origin: 'mail', text: 'Bonjour' },
        { label: 'Scan', origin: 'ocr', text: '' },
      ],
      subject: { type: 'document', id: '12' },
      context: { montant: 120 },
    },
    expected: { result: { categorie: 'facture' }, returnsToHuman: false, suspicionInjection: false, minConfidence: 0.8 },
    weight: 3,
    sortOrder: 10,
  });
});

test('evalCaseDraftToPayload : cas minimal et objet lié partiel', () => {
  const r = evalCaseDraftToPayload(validDraft({ subjectType: 'document' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload!.input, { subject: { type: 'document', id: null } });
  assert.deepEqual(r.payload!.expected, { returnsToHuman: false });
  assert.equal('weight' in r.payload!, false);
});

test('evalCaseDraftToPayload : erreurs cumulées', () => {
  const r = evalCaseDraftToPayload({
    ...emptyEvalCaseDraft(),
    label: '  ',
    contextJson: '[1]',
    resultJson: '{',
    minConfidence: '2',
    weight: '0',
    sortOrder: '-1',
  });
  assert.equal(r.ok, false);
  assert.equal(r.payload, undefined);
  assert.ok(r.errors.length >= 6, r.errors.join('|'));
  assert.ok(r.errors.some((e) => /nom du cas/.test(e)));
  assert.ok(r.errors.some((e) => /contexte/i.test(e)));
  assert.ok(r.errors.some((e) => /résultat attendu/.test(e)));
  assert.ok(r.errors.some((e) => /confiance/.test(e)));
  assert.ok(r.errors.some((e) => /poids/i.test(e)));
});

test('evalCaseDraftToPayload : au moins un critère non vide', () => {
  const none = evalCaseDraftToPayload({ ...emptyEvalCaseDraft(), label: 'x' });
  assert.equal(none.ok, false);
  assert.match(none.errors[0]!, /au moins un critère/);
  const zero = evalCaseDraftToPayload({ ...emptyEvalCaseDraft(), label: 'x', minConfidence: '0' });
  assert.equal(zero.ok, false, 'minConfidence 0 ne compte pas comme critère');
  const emptyRes = evalCaseDraftToPayload({ ...emptyEvalCaseDraft(), label: 'x', resultJson: '{}' });
  assert.equal(emptyRes.ok, false);
  assert.ok(emptyRes.errors.some((e) => /ne peut pas être vide/.test(e)));
  assert.equal(evalCaseDraftToPayload({ ...emptyEvalCaseDraft(), label: 'x', minConfidence: '0,5' }).ok, true);
  assert.equal(evalCaseDraftToPayload({ ...emptyEvalCaseDraft(), label: 'x', suspicionInjection: true }).ok, true);
});

test('evalCaseDraftToPayload : limites de longueur et de taille', () => {
  assert.equal(evalCaseDraftToPayload(validDraft({ label: 'a'.repeat(300) })).ok, true);
  assert.equal(evalCaseDraftToPayload(validDraft({ label: 'a'.repeat(301) })).ok, false);

  const blocks = (n: number) => Array.from({ length: n }, () => ({ origin: 'mail', label: 'm', text: 'x' }));
  assert.equal(evalCaseDraftToPayload(validDraft({ blocks: blocks(10) })).ok, true);
  assert.equal(evalCaseDraftToPayload(validDraft({ blocks: blocks(11) })).ok, false);

  assert.equal(evalCaseDraftToPayload(validDraft({ blocks: [{ origin: 'mail', label: 'a'.repeat(101), text: '' }] })).ok, false);
  assert.equal(evalCaseDraftToPayload(validDraft({ blocks: [{ origin: 'mail', label: 'm', text: 'x'.repeat(20_001) }] })).ok, false);
  assert.equal(evalCaseDraftToPayload(validDraft({ blocks: [{ origin: 'inconnu', label: 'm', text: '' }] })).ok, false);
  assert.equal(evalCaseDraftToPayload(validDraft({ subjectType: 'a'.repeat(51) })).ok, false);

  // Taille totale : 4 blocs de 20 000 caractères « é » (2 octets) > 64 Kio.
  const big = 'é'.repeat(20_000);
  const tooBig = evalCaseDraftToPayload(
    validDraft({ blocks: Array.from({ length: 4 }, () => ({ origin: 'document', label: 'd', text: big })) }),
  );
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.errors.join(' '), /trop volumineux/);

  const ctx = `{"k": "${'x'.repeat(20_000)}"}`;
  assert.equal(evalCaseDraftToPayload(validDraft({ contextJson: ctx })).ok, false);
});

test('evalCaseToDraft : relecture et formes inattendues', () => {
  const draft = evalCaseToDraft({
    label: 'Cas',
    input: {
      untrusted: [{ origin: 'mail', label: 'Mail', text: 'Salut' }, 'bizarre'],
      subject: { type: 'document', id: null },
      context: { a: 1 },
    },
    expected: { result: { k: 'v' }, returnsToHuman: true, minConfidence: 0.85 },
    weight: 2,
    sortOrder: 5,
  });
  assert.equal(draft.label, 'Cas');
  assert.deepEqual(draft.blocks, [{ origin: 'mail', label: 'Mail', text: 'Salut' }]);
  assert.equal(draft.subjectType, 'document');
  assert.equal(draft.subjectId, '');
  assert.deepEqual(JSON.parse(draft.contextJson), { a: 1 });
  assert.deepEqual(JSON.parse(draft.resultJson), { k: 'v' });
  assert.equal(draft.returnsToHuman, true);
  assert.equal(draft.suspicionInjection, null);
  assert.equal(draft.minConfidence, '0,85');
  assert.equal(draft.weight, '2');

  // Aller-retour.
  const back = evalCaseDraftToPayload(draft);
  assert.equal(back.ok, true, back.errors.join('|'));
  assert.equal(back.payload!.expected.minConfidence, 0.85);

  for (const bad of [{}, { input: 'x', expected: 12 }, { input: null, expected: [] }]) {
    assert.doesNotThrow(() => evalCaseToDraft(bad));
    assert.equal(evalCaseToDraft(bad).blocks.length, 0);
  }
});

test('eligibilityLabel : actions suivantes selon la raison', () => {
  assert.deepEqual(eligibilityLabel({ eligible: true }), {
    label: 'Éligible à l\'autonomie',
    tone: 'success',
    nextAction: 'none',
    actionLabel: null,
  });
  const cases: Array<[string, string]> = [
    ['Aucun jeu d’évaluation n’est lié à cette étape.', 'link_set'],
    ['Aucun run d’évaluation réussi pour cette version et ce jeu.', 'run_eval'],
    ['La configuration de l’agent a changé depuis le dernier run réussi : relancer l’évaluation.', 'run_eval'],
    ['Les cas du jeu d’évaluation ont changé depuis le dernier run réussi : relancer l’évaluation.', 'run_eval'],
    ['Le run réussi a été validé avec un seuil inférieur au seuil actuel du jeu.', 'run_eval'],
    ['Le workflow n’est pas marqué faible risque.', 'mark_low_risk'],
    ['Le jeu d’évaluation est désactivé.', 'none'],
    ['Raison totalement inédite.', 'none'],
  ];
  for (const [reason, action] of cases) {
    const r = eligibilityLabel({ eligible: false, reason });
    assert.equal(r.nextAction, action, reason);
    assert.equal(r.label, reason, 'la raison est reprise telle quelle');
    assert.equal(r.tone, 'warning');
    assert.equal(r.actionLabel === null, action === 'none');
  }
  assert.equal(eligibilityLabel({ eligible: false }).nextAction, 'none');
  assert.equal(eligibilityLabel({ eligible: false, reason: null }).label, 'Non éligible à l\'autonomie');
  // Apostrophe droite et absence d'accents : même résultat.
  assert.equal(eligibilityLabel({ eligible: false, reason: "Aucun jeu d'evaluation" }).nextAction, 'link_set');
});

test('foldText', () => {
  assert.equal(foldText('ÉVALUATION d’été'), 'evaluation d\'ete');
});

test('evalChecklist', () => {
  const none = evalChecklist({ isLowRisk: false, evalSetLinked: false, activeCases: 0, hasPassedRun: false });
  assert.equal(none.complete, false);
  assert.deepEqual(
    none.items.map((i) => i.key),
    ['low_risk', 'set_linked', 'cases', 'passed_run'],
  );
  assert.ok(none.items.every((i) => !i.done));
  const partial = evalChecklist({ isLowRisk: true, evalSetLinked: true, activeCases: 3, hasPassedRun: false });
  assert.deepEqual(
    partial.items.map((i) => i.done),
    [true, true, true, false],
  );
  assert.equal(partial.complete, false);
  assert.equal(evalChecklist({ isLowRisk: true, evalSetLinked: true, activeCases: 1, hasPassedRun: true }).complete, true);
});
