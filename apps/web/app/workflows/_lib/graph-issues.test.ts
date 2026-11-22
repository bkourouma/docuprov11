// Tests de l'explication des problèmes de validation.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/graph-issues.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfGraph } from '@archivage/types';
import type { WfDefinitionIssue, WfDefinitionIssueCode } from '../../lib/workflows-api';
import {
  ALL_ISSUE_CODES,
  explainIssue,
  groupIssuesByStep,
  mergeIssues,
  summarizeIssues,
  validateLive,
} from './graph-issues';

type StepInit = { key: string; type?: string; next?: Array<Record<string, unknown>>; [k: string]: unknown };

/** Construit un graphe brut (non typé : certains tests le veulent invalide). */
function raw(start: string, steps: StepInit[]): unknown {
  return {
    schemaVersion: 1,
    start,
    steps: steps.map((s) => ({ name: `Étape ${s.key}`, type: 'formulaire', next: [], ...s })),
  };
}

function codes(graph: unknown, isLowRisk = false): WfDefinitionIssueCode[] {
  return validateLive(graph, { isLowRisk }).issues.map((i) => i.code);
}

const agentSpec = { objective: 'Classer', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' };

test('graphe valide : aucun problème', () => {
  const g = raw('a', [{ key: 'a', next: [{ to: 'b' }] }, { key: 'b' }]);
  assert.deepEqual(validateLive(g, { isLowRisk: false }), { ok: true, issues: [] });
});

test('validateLive déclenche chaque code atteignable côté client', () => {
  const cases: Array<[WfDefinitionIssueCode, unknown, boolean?]> = [
    ['SCHEMA_INVALID', { schemaVersion: 1, start: 'a', steps: [] }],
    ['DUPLICATE_STEP_KEY', raw('a', [{ key: 'a' }, { key: 'a' }])],
    ['START_NOT_FOUND', raw('zzz', [{ key: 'a' }])],
    ['EDGE_TARGET_NOT_FOUND', raw('a', [{ key: 'a', next: [{ to: 'zzz' }] }])],
    ['SELF_LOOP', raw('a', [{ key: 'a', next: [{ to: 'a' }] }])],
    ['UNREACHABLE_STEP', raw('a', [{ key: 'a' }, { key: 'b' }])],
    ['NO_TERMINAL_STEP', raw('a', [{ key: 'a', next: [{ to: 'b' }] }, { key: 'b', next: [{ to: 'a' }] }])],
    [
      'STEP_CANNOT_REACH_TERMINAL',
      raw('a', [
        { key: 'a', next: [{ to: 'b', condition: { field: 'x', op: 'exists' } }, { to: 'c' }] },
        { key: 'b' },
        { key: 'c', next: [{ to: 'd' }] },
        { key: 'd', next: [{ to: 'c' }] },
      ]),
    ],
    ['AMBIGUOUS_BRANCHING', raw('a', [{ key: 'a', next: [{ to: 'b' }, { to: 'c' }] }, { key: 'b' }, { key: 'c' }])],
    ['AGENT_SPEC_MISSING', raw('a', [{ key: 'a', type: 'agent' }])],
    ['AGENT_SPEC_ON_NON_AGENT', raw('a', [{ key: 'a', agent: agentSpec }])],
    ['DUPLICATE_EDGE_TARGET', raw('a', [{ key: 'a', next: [{ to: 'b' }, { to: 'b' }] }, { key: 'b' }])],
    ['AUTONOMY_REQUIRES_LOW_RISK', raw('a', [{ key: 'a', type: 'agent', agent: { ...agentSpec, autonomy: 'autonome' } }])],
    ['DECISION_NEEDS_BRANCHES', raw('a', [{ key: 'a', type: 'decision', next: [{ to: 'b' }] }, { key: 'b' }])],
    ['ESCALATION_INVALID', raw('a', [{ key: 'a', config: { escalation: { dueInHours: 0 } } }])],
  ];
  assert.equal(cases.length, 15);
  for (const [code, graph, lowRisk] of cases) {
    assert.ok(codes(graph, lowRisk).includes(code), `${code} non déclenché : ${codes(graph, lowRisk).join(', ')}`);
  }
});

test('autonomie : acceptée si le workflow est à faible risque', () => {
  const g = raw('a', [{ key: 'a', type: 'agent', agent: { ...agentSpec, autonomy: 'autonome' } }]);
  assert.equal(validateLive(g, { isLowRisk: true }).ok, true);
});

test('escalade : valide acceptée, invalide détaillée en français', () => {
  const good = raw('a', [{ key: 'a', config: { escalation: { assignee: { kind: 'user', id: 3 }, dueInHours: 24 } } }]);
  assert.equal(validateLive(good, { isLowRisk: false }).ok, true);

  const bad = validateLive(
    raw('a', [{ key: 'a', config: { escalation: { assignee: { kind: 'user' }, maxEscalations: 9 } } }]),
    { isLowRisk: false },
  );
  const issue = bad.issues.find((i) => i.code === 'ESCALATION_INVALID');
  assert.ok(issue);
  assert.equal(issue.stepKey, 'a');
  assert.deepEqual(issue.path, ['steps', 0, 'config', 'escalation']);
  assert.match(issue.message, /délai/);
  assert.match(issue.message, /1 à 5/);
  assert.match(issue.message, /identifiant/);
});

test('validateLive tolère une entrée absurde', () => {
  for (const input of [null, undefined, 42, 'x', {}, { steps: 'non' }]) {
    const r = validateLive(input, { isLowRisk: false });
    assert.equal(r.ok, false);
    assert.ok(r.issues.length > 0);
  }
});

test('explainIssue : titre, explication et correction non vides, en français, pour les 17 codes', () => {
  assert.equal(ALL_ISSUE_CODES.length, 17);
  assert.equal(new Set(ALL_ISSUE_CODES).size, 17);
  const jargon = /zod|schéma|schema|bpathb|json|undefined|bnullb/i;
  for (const code of ALL_ISSUE_CODES) {
    const e = explainIssue({ code, message: 'Message du serveur', stepKey: 'a' });
    assert.equal(e.code, code);
    for (const text of [e.title, e.explain, e.fix]) {
      assert.ok(text.trim().length > 10, `${code} : texte vide ou trop court`);
      assert.doesNotMatch(text, jargon, `${code} : jargon dans « ${text} »`);
    }
    assert.match(`${e.title} ${e.explain} ${e.fix}`, /[éèàêôç]|le |la |les /i, `${code} semble ne pas être en français`);
    assert.equal(e.stepKey, 'a');
    assert.equal(e.detail, 'Message du serveur');
  }
  // Code inconnu venu d'un serveur plus récent : repli propre.
  const unknown = explainIssue({ code: 'AUTRE' as WfDefinitionIssueCode, message: 'm' });
  assert.ok(unknown.title && unknown.explain && unknown.fix);
});

test('explainIssue : AUTHORING_TO_COMPLETE (W5) cite l’étape et explique comment corriger', () => {
  const graph = raw('a', [{ key: 'visa_daf', name: 'Visa du DAF' }]) as WfGraph;
  const e = explainIssue(
    { code: 'AUTHORING_TO_COMPLETE', message: 'Affectation à compléter à l’étape « visa_daf »', stepKey: 'visa_daf' },
    graph,
  );
  assert.equal(e.title, 'Affectation à compléter');
  assert.match(e.explain, /Visa du DAF/);
  assert.match(e.fix, /Affectation/);
});

test('explainIssue cite le nom de l’étape quand le graphe est fourni', () => {
  const graph = raw('a', [{ key: 'controle_qualite', name: 'Contrôle qualité' }]) as WfGraph;
  const withGraph = explainIssue({ code: 'SELF_LOOP', message: 'm', stepKey: 'controle_qualite' }, graph);
  assert.match(withGraph.explain, /Contrôle qualité/);
  const without = explainIssue({ code: 'SELF_LOOP', message: 'm', stepKey: 'controle_qualite' });
  assert.match(without.explain, /controle_qualite/);

  const target = explainIssue(
    {
      code: 'EDGE_TARGET_NOT_FOUND',
      message: "L'étape « a » pointe vers « zzz », qui n'existe pas.",
      stepKey: 'a',
    },
    graph,
  );
  assert.match(target.explain, /zzz/);
});

test('SCHEMA_INVALID : chemin et message traduits', () => {
  const graph = raw('a', [
    { key: 'a', next: [{ to: 'b' }] },
    { key: 'b', name: 'Revue' },
    { key: 'c', name: 'Clôture' },
  ]) as WfGraph;
  const e = (path: (string | number)[], message: string) =>
    explainIssue({ code: 'SCHEMA_INVALID', message: `Forme du graphe invalide (${path.join('.')}) : ${message}`, path }, graph).explain;

  assert.equal(e(['steps', 1, 'name'], 'Required'), "L'étape « Revue » : le nom est obligatoire.");
  assert.match(e(['steps', 1, 'name'], 'String must contain at least 1 character(s)'), /le nom ne peut pas être vide/);
  assert.match(e(['steps', 2, 'dueInHours'], 'Number must be less than or equal to 8760'), /délai d'échéance doit être un nombre entier d'heures compris entre 1 et 8760/);
  assert.match(e(['steps', 0, 'next', 1, 'to'], 'String must contain at least 1 character(s)'), /transition n° 2 : la destination ne peut pas être vide/);
  assert.match(e(['start'], 'Required'), /étape de départ est obligatoire/);
  assert.match(e(['steps'], 'Array must contain at least 1 element(s)'), /au moins une étape/);
  assert.match(e(['steps', 1, 'agent', 'objective'], 'String must contain at least 1 character(s)'), /objectif de l'agent/);
  assert.match(e(['steps', 1, 'key'], "clé d'étape invalide (minuscules, chiffres et _, commence par une lettre)"), /identifiant de l'étape/);

  // Sans graphe : numéro d'étape ; chemin déduit du message si absent.
  const noGraph = explainIssue({
    code: 'SCHEMA_INVALID',
    message: 'Forme du graphe invalide (steps.2.name) : Required',
  });
  assert.equal(noGraph.explain, "L'étape n° 3 : le nom est obligatoire.");

  // Inconnu : repli générique propre, sans jargon.
  const generic = explainIssue({ code: 'SCHEMA_INVALID', message: 'Quelque chose' });
  assert.ok(generic.explain.length > 10);
  assert.doesNotMatch(generic.explain, /zod|schéma|path/i);
});

test('groupIssuesByStep', () => {
  const issues: WfDefinitionIssue[] = [
    { code: 'NO_TERMINAL_STEP', message: 'g' },
    { code: 'SELF_LOOP', message: 'a1', stepKey: 'a' },
    { code: 'UNREACHABLE_STEP', message: 'a2', stepKey: 'a' },
    { code: 'SELF_LOOP', message: 'b1', stepKey: 'b' },
  ];
  const g = groupIssuesByStep(issues);
  assert.equal(g.global.length, 1);
  assert.equal(g.byStep.a?.length, 2);
  assert.equal(g.byStep.b?.length, 1);
  assert.deepEqual(groupIssuesByStep([]), { global: [], byStep: {} });
});

test('summarizeIssues : accords', () => {
  const i = (stepKey?: string): WfDefinitionIssue => ({ code: 'SELF_LOOP', message: 'm', ...(stepKey ? { stepKey } : {}) });
  assert.equal(summarizeIssues([]), 'Aucun problème');
  assert.equal(summarizeIssues([i('a')]), '1 problème');
  assert.equal(summarizeIssues([i('a'), i('a'), i('b')]), '3 problèmes sur 2 étapes');
  assert.equal(summarizeIssues([i('a'), i('a')]), '2 problèmes sur 1 étape');
  assert.equal(summarizeIssues([i(), i()]), '2 problèmes');
});

test('mergeIssues : dédoublonne par code + étape + message, live d’abord', () => {
  const live: WfDefinitionIssue[] = [{ code: 'SELF_LOOP', message: 'm', stepKey: 'a' }];
  const server: WfDefinitionIssue[] = [
    { code: 'SELF_LOOP', message: 'm', stepKey: 'a', path: ['steps', 0] },
    { code: 'EXECUTOR_MISSING', message: 'x', stepKey: 'a' },
    { code: 'SELF_LOOP', message: 'm', stepKey: 'b' },
  ];
  const merged = mergeIssues(live, server);
  assert.equal(merged.length, 3);
  assert.equal(merged[0], live[0]);
  assert.deepEqual(
    merged.map((x) => x.code),
    ['SELF_LOOP', 'EXECUTOR_MISSING', 'SELF_LOOP'],
  );
});

test('mergeIssues : ESCALATION_INVALID local et serveur (messages différents) = un seul problème', () => {
  const live: WfDefinitionIssue[] = [{ code: 'ESCALATION_INVALID', message: 'Escalade : délai obligatoire.', stepKey: 'a' }];
  const server: WfDefinitionIssue[] = [
    { code: 'ESCALATION_INVALID', message: "L'escalade de l'étape « a » est invalide.", stepKey: 'a' },
    { code: 'ESCALATION_INVALID', message: 'autre étape', stepKey: 'b' },
  ];
  const merged = mergeIssues(live, server);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], live[0]);
});
