// Palette, liste alternative, panneau des problèmes (rendu statique) et logique pure du canevas.
// Lancer : cd apps/web && npx tsx --test app/workflows/conception/_components/canvas/canvas.test.ts
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WfGraph } from '@archivage/types';
import type { WfDefinitionIssue } from '../../../../lib/workflows-api';
import {
  describeSelection,
  edgesNotTouching,
  mergeDraggedPositions,
  parseDroppedStepType,
  PALETTE_ITEMS,
} from './canvas-logic';

// tsconfig a `jsx: preserve` : sous tsx le JSX devient `React.createElement`, donc `React` doit exister
// globalement AVANT le chargement des composants (import dynamique).
type Palette = typeof import('./StepPalette').StepPalette;
type Outline = typeof import('./StepOutline').StepOutline;
type Issues = typeof import('./IssuesPanel').IssuesPanel;
let StepPalette: Palette;
let StepOutline: Outline;
let IssuesPanel: Issues;
before(async () => {
  (globalThis as { React?: unknown }).React = React;
  ({ StepPalette } = await import('./StepPalette'));
  ({ StepOutline } = await import('./StepOutline'));
  ({ IssuesPanel } = await import('./IssuesPanel'));
});

const graph: WfGraph = {
  schemaVersion: 1,
  start: 'saisie',
  steps: [
    { key: 'saisie', name: 'Saisie', type: 'formulaire', next: [{ to: 'valider' }] },
    {
      key: 'valider',
      name: 'Valider',
      type: 'validation',
      next: [
        { to: 'fin', condition: { field: 'last.approved', op: 'eq', value: true } },
        { to: 'saisie', label: 'Corriger' },
      ],
    },
    { key: 'fin', name: 'Clôture', type: 'checklist', next: [] },
  ],
};

const noop = () => undefined;
const outlineProps = {
  graph,
  issues: [] as WfDefinitionIssue[],
  selection: null,
  readOnly: false,
  onSelect: noop,
  onAddStep: noop,
  onAddEdge: () => undefined,
  onRemoveStep: noop,
  onRemoveEdge: noop,
};

test('palette : sept boutons, type agent marqué IA', () => {
  const html = renderToStaticMarkup(createElement(StepPalette, { disabled: false, onAdd: noop }));
  assert.equal((html.match(/<button/g) ?? []).length, 7);
  assert.equal((html.match(/draggable="true"/g) ?? []).length, 7);
  assert.match(html, /Saisie de champs/);
  assert.match(html, /Un agent IA propose ou agit/);
  assert.match(html, />IA</);
  assert.doesNotMatch(html, /Version en lecture seule/);
});

test('palette : désactivée en lecture seule', () => {
  const html = renderToStaticMarkup(createElement(StepPalette, { disabled: true, onAdd: noop }));
  assert.equal((html.match(/disabled=""/g) ?? []).length, 7);
  assert.doesNotMatch(html, /draggable="true"/);
  assert.match(html, /Version en lecture seule/);
});

test('liste alternative : étapes, transitions, actions', () => {
  const html = renderToStaticMarkup(createElement(StepOutline, outlineProps));
  assert.match(html, /<ol/);
  assert.equal((html.match(/wfc-outline-step"/g) ?? []).length, 3);
  assert.match(html, /Départ/);
  assert.match(html, /Fin</);
  assert.match(html, /Supprimer la transition vers Clôture/);
  assert.match(html, /Si last\.approved = true/);
  assert.match(html, /Corriger/);
  assert.match(html, /Ajouter une étape après celle-ci/);
  assert.match(html, /Ajouter une transition/);
  assert.match(html, /Supprimer l’étape « Saisie »/);
  assert.match(html, /Ajouter une étape</);
});

test('liste alternative : sélection mise en évidence et problèmes dans le nom accessible', () => {
  const issues: WfDefinitionIssue[] = [{ code: 'UNREACHABLE_STEP', message: 'x', stepKey: 'fin' }];
  const html = renderToStaticMarkup(
    createElement(StepOutline, { ...outlineProps, issues, selection: { kind: 'step', key: 'valider' } }),
  );
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /1 problème/);
});

test('liste alternative : lecture seule sans aucune action', () => {
  const html = renderToStaticMarkup(createElement(StepOutline, { ...outlineProps, readOnly: true }));
  assert.match(html, /Saisie/);
  assert.doesNotMatch(html, /Supprimer/);
  assert.doesNotMatch(html, /Ajouter une/);
});

test('problèmes : aucun problème', () => {
  const html = renderToStaticMarkup(createElement(IssuesPanel, { graph, issues: [], serverChecked: false, onFocusStep: noop }));
  assert.match(html, /Aucun problème détecté/);
  assert.match(html, /Vérification locale en direct/);
  assert.match(html, /exécuteur d’agent/);
});

test('problèmes : vérifié par le serveur', () => {
  const html = renderToStaticMarkup(createElement(IssuesPanel, { graph, issues: [], serverChecked: true, onFocusStep: noop }));
  assert.match(html, /Vérifié par le serveur/);
});

test('problèmes : explications en français, étape et détail technique', () => {
  const issues: WfDefinitionIssue[] = [
    { code: 'NO_TERMINAL_STEP', message: 'No terminal step' },
    { code: 'UNREACHABLE_STEP', message: 'Étape « fin » inaccessible', stepKey: 'fin' },
  ];
  const html = renderToStaticMarkup(createElement(IssuesPanel, { graph, issues, serverChecked: false, onFocusStep: noop }));
  assert.match(html, /2 problèmes sur 1 étape/);
  assert.match(html, /Aucune étape finale/);
  assert.match(html, /Étape jamais utilisée/);
  assert.match(html, /Comment corriger/);
  assert.match(html, /Aller à l’étape « Clôture »/);
  assert.match(html, /Détail technique/);
  assert.match(html, /No terminal step/);
  assert.doesNotMatch(html, /Aucun problème détecté/);
});

test('logique : type déposé validé', () => {
  assert.equal(parseDroppedStepType('agent'), 'agent');
  assert.equal(parseDroppedStepType('inconnu'), null);
  assert.equal(parseDroppedStepType(''), null);
  assert.equal(parseDroppedStepType(null), null);
  assert.equal(PALETTE_ITEMS.length, 7);
});

test('logique : positions déplacées fusionnées sans muter', () => {
  const current = { a: { x: 0, y: 0 }, b: { x: 5, y: 5 } };
  const next = mergeDraggedPositions(current, [
    { id: 'a', position: { x: 10, y: 20 } },
    { id: 'c', position: { x: Number.NaN, y: 1 } },
  ]);
  assert.deepEqual(next, { a: { x: 10, y: 20 }, b: { x: 5, y: 5 } });
  assert.deepEqual(current.a, { x: 0, y: 0 });
});

test('logique : transitions déjà emportées par une étape supprimée', () => {
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
  ];
  assert.deepEqual(edgesNotTouching(edges, ['b']), [{ source: 'c', target: 'd' }]);
});

test('logique : annonce de la sélection', () => {
  const nameOf = (k: string) => (k === 'a' ? 'Alpha' : undefined);
  assert.equal(describeSelection(null, nameOf), 'Aucune sélection.');
  assert.equal(describeSelection({ kind: 'step', key: 'a' }, nameOf), 'Étape « Alpha » sélectionnée.');
  assert.equal(
    describeSelection({ kind: 'edge', from: 'a', to: 'z' }, nameOf),
    'Transition de « Alpha » vers « z » sélectionnée.',
  );
});
