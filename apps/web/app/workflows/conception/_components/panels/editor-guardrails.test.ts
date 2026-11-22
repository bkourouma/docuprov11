// Garde-fous dans l'éditeur : logique pure + rendu statique léger du bandeau d'autonomie, des liens et des problèmes.
// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/panels/editor-guardrails.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WfGraph } from '@archivage/types';
import { ALL_ISSUE_CODES, explainIssue } from '../../../_lib/graph-issues';
import { autonomyBanner } from '../../../_lib/guardrails-logic';
import {
  DESIGNER_TOOL_NOTICE,
  buildStepEvals,
  evalHelp,
  hasPassedEvalFor,
  issueActionView,
  missingToolsForStep,
  shouldFetchEvalStatus,
  shouldRefreshNow,
  stepEvalInfo,
  stepGuardrails,
  toolGrantNotice,
  type EditorGuardrails,
  type StepGuardrails,
} from './editor-guardrails';

type Banner = typeof import('./AutonomyBanner').AutonomyBanner;
type Links = typeof import('./AgentGuardrailLinks').AgentGuardrailLinks;
type Spec = typeof import('./AgentSpecFields').AgentSpecFields;
type Issues = typeof import('../canvas/IssuesPanel').IssuesPanel;
type Toolbar = typeof import('../editor/EditorToolbar').EditorToolbar;
let AutonomyBanner: Banner;
let AgentGuardrailLinks: Links;
let AgentSpecFields: Spec;
let IssuesPanel: Issues;
let EditorToolbar: Toolbar;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ AutonomyBanner } = await import('./AutonomyBanner'));
  ({ AgentGuardrailLinks } = await import('./AgentGuardrailLinks'));
  ({ AgentSpecFields } = await import('./AgentSpecFields'));
  ({ IssuesPanel } = await import('../canvas/IssuesPanel'));
  ({ EditorToolbar } = await import('../editor/EditorToolbar'));
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const flat = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const status = {
  steps: [
    { stepKey: 'a', eligible: true, reason: null, evalSetId: 3 },
    { stepKey: 'b', eligible: false, reason: 'Aucun jeu d\'évaluation lié à cette étape.', evalSetId: null },
  ],
};

// --- logique pure -----------------------------------------------------------------------------------------

test('buildStepEvals : une entrée par étape ; route indisponible => null', () => {
  assert.equal(buildStepEvals(null), null);
  const map = buildStepEvals(status);
  assert.ok(map);
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('a'), { eligible: true, reason: null, evalSetId: 3, known: true });
  assert.equal(map.get('b')?.reason, 'Aucun jeu d\'évaluation lié à cette étape.');
});

test('hasPassedEvalFor : eligible true/false ; null si route indisponible ; étape inconnue => false non connue', () => {
  const map = buildStepEvals(status);
  assert.equal(hasPassedEvalFor(map, 'a'), true);
  assert.equal(hasPassedEvalFor(map, 'b'), false);
  assert.equal(hasPassedEvalFor(map, 'nouvelle'), false);
  assert.equal(stepEvalInfo(map, 'nouvelle')?.known, false);
  assert.equal(hasPassedEvalFor(null, 'a'), null);
  assert.equal(stepEvalInfo(null, 'a'), null);
});

test('evalHelp : phrase d’aide toujours, avertissement si modifications non enregistrées ou étape inconnue', () => {
  const clean = evalHelp({ dirty: false, known: true });
  assert.match(clean.text, /dernière version enregistrée/);
  assert.equal(clean.warning, null);
  assert.match(evalHelp({ dirty: true, known: true }).warning ?? '', /ne sont pas enregistrées/);
  assert.match(evalHelp({ dirty: false, known: false }).warning ?? '', /n’existe pas encore/);
});

test('toolGrantNotice : liste pour l’administrateur, phrase explicative pour le concepteur', () => {
  const admin = toolGrantNotice({ canAdminister: true, missing: ['a.b', 'c'], issueNotGranted: false });
  assert.equal(admin?.text, 'Outils non autorisés pour ce workflow : a.b, c.');
  assert.equal(admin?.showLink, true);
  assert.equal(toolGrantNotice({ canAdminister: true, missing: [], issueNotGranted: false }), null);
  assert.match(toolGrantNotice({ canAdminister: true, missing: [], issueNotGranted: true })?.text ?? '', /AGENT_TOOL_NOT_GRANTED/);

  const designer = toolGrantNotice({ canAdminister: false, missing: ['a.b'], issueNotGranted: true });
  assert.equal(designer?.text, DESIGNER_TOOL_NOTICE);
  assert.equal(designer?.showLink, false);
  assert.match(DESIGNER_TOOL_NOTICE, /administrateur doit autoriser cet outil pour ce workflow \(code AGENT_TOOL_NOT_GRANTED\)/);
  // Un concepteur sans problème signalé par le serveur ne voit rien (il ne peut pas connaître les autorisations).
  assert.equal(toolGrantNotice({ canAdminister: false, missing: [], issueNotGranted: false }), null);
});

const graph: WfGraph = {
  schemaVersion: 1,
  start: 'a',
  steps: [
    { key: 'a', name: 'Tri', type: 'agent', next: [], agent: { objective: 'x', tools: ['t.one', 't.two'], confidenceThreshold: 0.8, autonomy: 'suggere' } },
    { key: 'b', name: 'Relance', type: 'agent', next: [], agent: { objective: 'y', tools: ['t.two'], confidenceThreshold: 0.8, autonomy: 'suggere' } },
  ],
};

test('missingToolsForStep / stepGuardrails : par étape, droits respectés', () => {
  assert.deepEqual(missingToolsForStep(graph, ['t.one'], 'a'), ['t.two']);
  assert.deepEqual(missingToolsForStep(graph, null, 'a'), []);
  const g: EditorGuardrails = {
    definitionId: 7,
    stepEvals: buildStepEvals(status),
    evalLoading: false,
    dirty: true,
    canAdminister: true,
    grantedKeys: ['t.one'],
  };
  const sa = stepGuardrails(g, graph, 'a', [{ code: 'AGENT_TOOL_NOT_GRANTED' }]);
  assert.deepEqual(sa.missingTools, ['t.two']);
  assert.equal(sa.issueNotGranted, true);
  assert.equal(sa.dirty, true);
  assert.equal(sa.evalInfo?.eligible, true);
  const nonAdmin = stepGuardrails({ ...g, canAdminister: false }, graph, 'a', []);
  assert.deepEqual(nonAdmin.missingTools, []);
  assert.equal(nonAdmin.issueNotGranted, false);
});

test('shouldFetchEvalStatus / shouldRefreshNow', () => {
  assert.equal(shouldFetchEvalStatus(true, 1), false);
  assert.equal(shouldFetchEvalStatus(false, null), false);
  assert.equal(shouldFetchEvalStatus(false, 1), true);
  assert.equal(shouldRefreshNow(null, 1000), true);
  assert.equal(shouldRefreshNow(1000, 1500), false);
  assert.equal(shouldRefreshNow(1000, 2600), true);
});

test('issueActionView : « Outils autorisés » réservé aux administrateurs', () => {
  const action = { label: 'Ouvrir « Outils autorisés »', href: '/workflows/conception/7/outils' };
  assert.deepEqual(issueActionView('AGENT_TOOL_NOT_GRANTED', action, true), { kind: 'link', ...action });
  const other = issueActionView('AGENT_TOOL_NOT_GRANTED', action, false);
  assert.equal(other?.kind, 'text');
  assert.match(other?.kind === 'text' ? other.text : '', /administrateur/);
  assert.equal(issueActionView('AGENT_TOOL_NOT_GRANTED', undefined, true)?.kind, 'text');
  const ev = { label: 'Ouvrir l\'évaluation', href: '/workflows/conception/7/evaluation?etape=a' };
  assert.deepEqual(issueActionView('AGENT_AUTONOMY_NOT_ELIGIBLE', ev, false), { kind: 'link', ...ev });
  assert.equal(issueActionView('SELF_LOOP', undefined, true), null);
});

test('codes émis à la publication : tous expliqués en français, jamais le message brut seul', () => {
  const codes = [
    'AGENT_CONFIG_INVALID',
    'AGENT_TOOL_UNKNOWN',
    'AGENT_TOOL_NOT_GRANTED',
    'AGENT_AUTONOMY_NOT_ELIGIBLE',
    'EXECUTOR_MISSING',
    'ESCALATION_INVALID',
    'AUTHORING_TO_COMPLETE',
  ] as const;
  for (const code of codes) {
    assert.ok(ALL_ISSUE_CODES.includes(code), code);
    const e = explainIssue({ code, message: 'MESSAGE_BRUT_TECHNIQUE', stepKey: 'a' }, graph, { definitionId: 7 });
    assert.notEqual(e.title, 'Problème de validation', code);
    assert.ok(e.fix.length > 10, code);
    assert.ok(!e.explain.includes('MESSAGE_BRUT_TECHNIQUE'), code);
    assert.equal(e.detail, 'MESSAGE_BRUT_TECHNIQUE', code);
  }
});

// --- rendu ------------------------------------------------------------------------------------------------

test('AutonomyBanner : un bandeau par niveau, icône + mot-clé + texte, région status', () => {
  for (const level of ['suggere', 'agit_avec_validation', 'autonome'] as const) {
    const b = autonomyBanner(level);
    const html = flat(render(createElement(AutonomyBanner, { level })));
    assert.match(html, /role="status"/);
    assert.match(html, new RegExp(`wfp-banner--${b.tone}`));
    assert.match(html, /aria-hidden="true"/);
    assert.ok(html.includes(b.title), level);
  }
  const s = flat(render(createElement(AutonomyBanner, { level: 'suggere' })));
  assert.match(s, /rien n'est appliqué/);
  assert.match(s, /Attention/);
  assert.match(s, /agit avec validation/);
});

test('AgentSpecFields : le bandeau suit le niveau choisi', () => {
  const base = { readOnly: false, isLowRisk: false, hasPassedEval: null, tools: null, onChange: () => {} } as const;
  const sug = flat(render(createElement(AgentSpecFields, { ...base, spec: { objective: 'x', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' } })));
  assert.match(sug, /wfp-banner--warning/);
  const act = flat(render(createElement(AgentSpecFields, { ...base, spec: { objective: 'x', tools: [], confidenceThreshold: 0.8, autonomy: 'agit_avec_validation' } })));
  assert.match(act, /wfp-banner--info/);
  assert.doesNotMatch(act, /wfp-banner--warning/);
});

const guard = (over: Partial<StepGuardrails> = {}): StepGuardrails => ({
  definitionId: 7,
  evalInfo: { eligible: false, reason: 'Aucun jeu d\'évaluation lié à cette étape.', evalSetId: null, known: true },
  evalLoading: false,
  dirty: false,
  canAdminister: false,
  missingTools: [],
  issueNotGranted: false,
  onRefreshEval: () => {},
  ...over,
});

test('AgentGuardrailLinks : lien d’évaluation, aide, actualisation ; pas de lien d’outils pour un concepteur', () => {
  const html = flat(render(createElement(AgentGuardrailLinks, { stepKey: 'etape 1', isLowRisk: false, guardrails: guard() })));
  assert.match(html, /href="\/workflows\/conception\/7\/evaluation\?etape=etape%201"/);
  assert.match(html, /Évaluer cet agent/);
  assert.match(html, /dernière version enregistrée/);
  assert.match(html, /Actualiser l’état de l’évaluation/);
  assert.match(html, /Aucun jeu d'évaluation lié/);
  assert.match(html, /Étapes pour activer le niveau autonome/);
  assert.doesNotMatch(html, /Outils autorisés/);
  assert.doesNotMatch(html, /ne sont pas enregistrées/);
});

test('AgentGuardrailLinks : modifications non enregistrées => avertissement ; administrateur => lien et liste', () => {
  const dirty = flat(render(createElement(AgentGuardrailLinks, { stepKey: 'a', isLowRisk: true, guardrails: guard({ dirty: true }) })));
  assert.match(dirty, /ne sont pas enregistrées/);

  const admin = flat(
    render(createElement(AgentGuardrailLinks, { stepKey: 'a', isLowRisk: true, guardrails: guard({ canAdminister: true, missingTools: ['t.two'] }) })),
  );
  assert.match(admin, /Outils non autorisés pour ce workflow : t\.two\./);
  assert.match(admin, /href="\/workflows\/conception\/7\/outils"/);

  const designer = flat(
    render(createElement(AgentGuardrailLinks, { stepKey: 'a', isLowRisk: true, guardrails: guard({ issueNotGranted: true }) })),
  );
  assert.match(designer, /Un administrateur doit autoriser cet outil pour ce workflow \(code AGENT_TOOL_NOT_GRANTED\)/);
  assert.doesNotMatch(designer, /\/outils/);

  const unavailable = flat(render(createElement(AgentGuardrailLinks, { stepKey: 'a', isLowRisk: true, guardrails: guard({ evalInfo: null }) })));
  assert.match(unavailable, /Évaluer cet agent/);
});

test('IssuesPanel : explication française + lien selon les droits', () => {
  const issues = [
    { code: 'AGENT_TOOL_NOT_GRANTED' as const, message: 'RAW_TOOL', stepKey: 'a' },
    { code: 'AGENT_AUTONOMY_NOT_ELIGIBLE' as const, message: 'RAW_AUTONOMY', stepKey: 'a' },
  ];
  const noop = () => {};
  const admin = flat(render(createElement(IssuesPanel, { definitionId: 7, canAdminister: true, graph, issues, serverChecked: true, onFocusStep: noop })));
  assert.match(admin, /Outil non autorisé pour ce workflow/);
  assert.match(admin, /href="\/workflows\/conception\/7\/outils"/);
  assert.match(admin, /href="\/workflows\/conception\/7\/evaluation\?etape=a"/);
  const designer = flat(render(createElement(IssuesPanel, { definitionId: 7, canAdminister: false, graph, issues, serverChecked: true, onFocusStep: noop })));
  assert.doesNotMatch(designer, /\/outils/);
  assert.match(designer, /Demandez à un administrateur d’autoriser cet outil/);
  assert.match(designer, /href="\/workflows\/conception\/7\/evaluation\?etape=a"/);
});

test('EditorToolbar : lien « Outils autorisés » seulement quand le lien est fourni (administrateurs)', () => {
  const props = {
    compact: false, readOnly: false, isDraftVersion: true, definitionArchived: false, dirty: false, busy: null,
    canPublish: true, publishBlockedReason: null, view: 'graph' as const,
    onView: () => {}, onSave: () => {}, onVerify: () => {}, onPublish: () => {}, onCreateDraft: () => {}, onArchive: () => {}, onAutoLayout: () => {},
  };
  const withLink = flat(render(createElement(EditorToolbar, { ...props, toolGrantsLink: '/workflows/conception/7/outils' })));
  assert.match(withLink, /href="\/workflows\/conception\/7\/outils"/);
  assert.match(withLink, /Outils autorisés/);
  const without = flat(render(createElement(EditorToolbar, props)));
  assert.doesNotMatch(without, /Outils autorisés/);
});
