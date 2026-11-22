// Logique pure de l'écran d'évaluation + rendu statique léger (éligibilité, historique des runs).
// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/evaluation/evaluation.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WfEvalRunDto, WfEvalSetDto, WfGraph } from '@archivage/types';
import {
  activeCaseCount,
  agentStepsOfDraftAgents,
  agentStepsOfGraph,
  caseErrorField,
  caseLabelMap,
  formatCost,
  groupCaseErrors,
  hasPassedRun,
  latestVersionNumber,
  linkSetInput,
  linkedSetIdOf,
  minAccuracyToInput,
  parseDefinitionId,
  parseMinAccuracyInput,
  pickStepKey,
  runAnnouncement,
  runLaunchState,
  setsForStep,
  sortRunsDesc,
  upsertRun,
} from './evaluation-view-logic';
import { evalCaseDraftToPayload, emptyEvalCaseDraft } from '../../../_lib/eval-logic';
import { EligibilityPanel, buildChecklist } from './EligibilityPanel';
import { RunsList } from './RunsList';

(globalThis as { React?: unknown }).React = React;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const graph = {
  schemaVersion: 1,
  start: 'a',
  steps: [
    { key: 'a', name: 'Saisie', type: 'human', next: [] },
    { key: 'classer', name: 'Classer le courriel', type: 'agent', next: [] },
    { key: 'resumer', name: '', type: 'agent', next: [] },
  ],
} as unknown as WfGraph;

const run = (over: Partial<WfEvalRunDto> = {}): WfEvalRunDto => ({
  wfEvalRunId: '10',
  evalSetId: 1,
  definitionVersionId: 5,
  status: 1,
  totalCases: 4,
  passedCases: 4,
  accuracy: '1.000',
  requiredAccuracy: '0.850',
  passed: true,
  model: null,
  results: { cases: [{ caseId: 7, passed: true }, { caseId: 8, passed: false, reason: 'Résultat différent' }] },
  costAmount: null,
  errorMessage: null,
  runBy: 1,
  startedAt: '2026-11-20T10:00:00Z',
  finishedAt: '2026-11-20T10:01:00Z',
  ...over,
});

const set = (over: Partial<WfEvalSetDto>): WfEvalSetDto => ({
  wfEvalSetId: 1,
  definitionId: 3,
  stepKey: null,
  name: 'Jeu',
  description: null,
  minAccuracy: '0.850',
  isActive: true,
  createdBy: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ...over,
});

test('étapes agent : graphe, repli, sélection par ?etape=', () => {
  const steps = agentStepsOfGraph(graph);
  assert.deepEqual(steps, [
    { key: 'classer', name: 'Classer le courriel' },
    { key: 'resumer', name: 'resumer' },
  ]);
  assert.deepEqual(agentStepsOfGraph(null), []);
  assert.deepEqual(agentStepsOfDraftAgents([{ stepKey: 'x' }]), [{ key: 'x', name: 'x' }]);
  assert.equal(pickStepKey('resumer', steps), 'resumer');
  assert.equal(pickStepKey('inconnue', steps), 'classer');
  assert.equal(pickStepKey(null, steps), 'classer');
  assert.equal(pickStepKey('x', []), null);
});

test('identifiants et versions', () => {
  assert.equal(parseDefinitionId('12'), 12);
  assert.equal(parseDefinitionId('0'), null);
  assert.equal(parseDefinitionId('1a'), null);
  assert.equal(parseDefinitionId(undefined), null);
  assert.equal(latestVersionNumber([{ versionNumber: 2 }, { versionNumber: 5 }, { versionNumber: 3 }]), 5);
  assert.equal(latestVersionNumber([]), null);
});

test('jeux : filtre étape ou sans étape, lien, corps de liaison', () => {
  const list = [
    set({ wfEvalSetId: 1, name: 'B', stepKey: 'classer' }),
    set({ wfEvalSetId: 2, name: 'A', stepKey: null }),
    set({ wfEvalSetId: 3, name: 'C', stepKey: 'resumer' }),
    set({ wfEvalSetId: 4, name: 'D', stepKey: 'classer', isActive: false }),
  ];
  assert.deepEqual(setsForStep(list, 'classer').map((s) => s.wfEvalSetId), [2, 1, 4]);
  assert.equal(linkedSetIdOf([{ stepKey: 'classer', evalSetId: 9 }], 'classer'), 9);
  assert.equal(linkedSetIdOf([{ stepKey: 'classer', evalSetId: null }], 'classer'), null);
  assert.equal(linkedSetIdOf(null, 'classer'), null);
  assert.deepEqual(linkSetInput(4), { evalSetId: 4 });
  assert.deepEqual(linkSetInput(null), { evalSetId: null });
});

test('précision saisie : pourcentage ou décimal, plancher 80 %', () => {
  assert.equal(parseMinAccuracyInput('85 %').value, 0.85);
  assert.equal(parseMinAccuracyInput('85').value, 0.85);
  assert.equal(parseMinAccuracyInput('85,5 %').value, 0.855);
  assert.equal(parseMinAccuracyInput('0,9').value, 0.9);
  assert.equal(parseMinAccuracyInput('1').value, 1);
  assert.equal(parseMinAccuracyInput('100 %').value, 1);
  assert.equal(parseMinAccuracyInput('70 %').ok, false);
  assert.match(parseMinAccuracyInput('70').error ?? '', /plancher/);
  assert.equal(parseMinAccuracyInput('0,5').ok, false);
  assert.equal(parseMinAccuracyInput('120').ok, false);
  assert.equal(parseMinAccuracyInput('85,55 %').ok, false);
  assert.equal(parseMinAccuracyInput('').ok, false);
  assert.equal(parseMinAccuracyInput('abc').ok, false);
  assert.equal(minAccuracyToInput('0.850'), '85 %');
  assert.equal(minAccuracyToInput('0.857'), '85,7 %');
  assert.equal(minAccuracyToInput(null), '85 %');
});

test('cas : compteurs, libellés, erreurs associées aux champs', () => {
  const cases = [
    { wfEvalCaseId: 1, label: 'A', isActive: true },
    { wfEvalCaseId: 2, label: 'B', isActive: false },
  ];
  assert.equal(activeCaseCount(cases), 1);
  assert.equal(caseLabelMap(cases).get(2), 'B');

  const r = evalCaseDraftToPayload(emptyEvalCaseDraft());
  assert.equal(r.ok, false);
  const fields = r.errors.map(caseErrorField);
  assert.ok(fields.includes('label'));
  assert.ok(fields.includes('expected'));
  assert.equal(caseErrorField('Bloc 2 : origine inconnue.'), 'blocks');
  assert.equal(caseErrorField('Le contexte doit être un objet JSON valide'), 'context');
  assert.equal(caseErrorField('Autre'), 'general');
  assert.deepEqual(groupCaseErrors(['Le poids x', 'Le poids y']).weight, ['Le poids x', 'Le poids y']);
});

test('runs : tri, run réussi, remplacement, lancement, annonces, coût', () => {
  const a = run({ wfEvalRunId: '9', startedAt: '2026-11-19T10:00:00Z' });
  const b = run({ wfEvalRunId: '10', startedAt: '2026-11-20T10:00:00Z' });
  assert.deepEqual(sortRunsDesc([a, b]).map((r) => r.wfEvalRunId), ['10', '9']);
  assert.equal(hasPassedRun([run({ status: 1, passed: false })]), false);
  assert.equal(hasPassedRun([run({ status: 2, passed: true })]), false);
  assert.equal(hasPassedRun([a]), true);
  const updated = upsertRun([a, b], run({ wfEvalRunId: '10', status: 2 }));
  assert.equal(updated.length, 2);
  assert.equal(updated[0]?.status, 2);

  const base = { hasSet: true, setActive: true, activeCases: 3, running: false, casesLoaded: true };
  assert.equal(runLaunchState(base).allowed, true);
  assert.match(runLaunchState({ ...base, activeCases: 0 }).reason ?? '', /au moins un cas actif/);
  assert.match(runLaunchState({ ...base, running: true }).reason ?? '', /déjà en cours/);
  assert.match(runLaunchState({ ...base, setActive: false }).reason ?? '', /désactivé/);
  assert.equal(runLaunchState({ ...base, hasSet: false }).allowed, false);

  assert.match(runAnnouncement(run({ status: 0 })), /en cours/);
  assert.match(runAnnouncement(run()), /réussie, 4 cas sur 4/);
  assert.match(runAnnouncement(run({ passed: false, passedCases: 2 })), /échouée/);
  assert.match(runAnnouncement(run({ status: 2 })), /erreur/);
  assert.equal(formatCost(null), null);
  assert.equal(formatCost('abc'), null);
  assert.ok(formatCost('0.0123'));
});

test('EligibilityPanel : état, raison, action suivante et checklist en texte', () => {
  const checklist = buildChecklist({ isLowRisk: true, evalSetLinked: true, activeCases: 2, hasPassedRun: false });
  const html = render(
    createElement(EligibilityPanel, {
      available: true,
      step: { stepKey: 'classer', evalSetId: 1, eligible: false, reason: 'aucun run d’évaluation réussi pour la version actuelle.' },
      stepKey: 'classer',
      versionNumber: 3,
      checklist,
      loading: false,
      onRefresh: () => {},
    }),
  );
  assert.match(html, /Non éligible/);
  assert.match(html, /aucun run d’évaluation réussi/);
  assert.match(html, /Action suivante :<\/strong> Lancer une évaluation/);
  assert.match(html, /version 3/);
  assert.match(html, /Fait<\/span><span class="wfev-text">Faire marquer/);
  assert.match(html, /À faire<\/span><span class="wfev-text">Lancer une évaluation et obtenir/);
  assert.match(html, /Actualiser/);
});

test('EligibilityPanel : éligible, et route indisponible', () => {
  const ok = render(
    createElement(EligibilityPanel, {
      available: true,
      step: { stepKey: 'c', evalSetId: 1, eligible: true, reason: null },
      stepKey: 'c',
      versionNumber: 1,
      checklist: buildChecklist({ isLowRisk: true, evalSetLinked: true, activeCases: 1, hasPassedRun: true }),
      loading: false,
      onRefresh: () => {},
    }),
  );
  assert.match(ok, />Éligible</);
  assert.doesNotMatch(ok, /Non éligible/);

  const na = render(
    createElement(EligibilityPanel, {
      available: false,
      step: null,
      stepKey: 'c',
      versionNumber: null,
      checklist: buildChecklist({ isLowRisk: false, evalSetLinked: false, activeCases: 0, hasPassedRun: false }),
      loading: false,
      onRefresh: () => {},
    }),
  );
  assert.match(na, /n’est pas disponible/);
  assert.match(na, /Conditions à remplir/);
});

test('RunsList : verdict, précision, détail par cas avec libellé, texte brut', () => {
  const labels = new Map([[7, 'Facture simple'], [8, '<b>Cas piégé</b>']]);
  const runs = [
    run({ costAmount: '0.0420' }),
    run({ wfEvalRunId: '11', status: 2, passed: false, passedCases: 1, accuracy: null, errorMessage: '<script>alert(1)</script> budget atteint' }),
  ];
  const table = render(createElement(RunsList, { runs, caseLabels: labels, layout: 'table' }));
  assert.match(table, /<th scope="col">Verdict<\/th>/);
  assert.match(table, /Réussi/);
  assert.match(table, /100,0 %/);
  assert.match(table, /85,0 %/);
  assert.match(table, /Facture simple/);
  assert.match(table, /Résultat différent/);
  assert.match(table, /En erreur/);
  assert.doesNotMatch(table, /<script>/);
  assert.match(table, /&lt;script&gt;/);
  assert.match(table, /&lt;b&gt;Cas piégé/);

  const cards = render(createElement(RunsList, { runs, caseLabels: labels, layout: 'cards' }));
  assert.match(cards, /Précision requise/);
  assert.match(cards, /Coût/);
  assert.match(cards, /Détail par cas \(2\)/);

  assert.match(render(createElement(RunsList, { runs: [], caseLabels: labels, layout: 'table' })), /Aucune évaluation lancée/);
});
