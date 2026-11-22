// Tests de l'état pur de l'éditeur de workflow.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/editor-state.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfGraph } from '@archivage/types';
import {
  applyGraph,
  canPublish,
  initEditor,
  isDirty,
  isReadOnly,
  layoutStorageKey,
  loadLayout,
  markSaved,
  nextSelectionAfterRemoval,
  parseDefinitionId,
  parseRequestedVersion,
  pickVersionToOpen,
  publishBlockedReason,
  saveLayout,
  select,
  setDescription,
  setLiveIssues,
  setName,
  setServerIssues,
  type StorageLike,
} from './editor-state';
import { addEdge, addStep, removeStep, renameStepKey, updateStep } from './graph-model';

const D = { Draft: 0, Published: 1, Archived: 2 };

function base(): WfGraph {
  return {
    schemaVersion: 1,
    start: 'a',
    steps: [
      { key: 'a', name: 'A', type: 'formulaire', next: [{ to: 'b' }] },
      { key: 'b', name: 'B', type: 'validation', next: [] },
    ],
  };
}

const ctxDraft = { versionStatus: D.Draft, definitionStatus: D.Draft };

test('initEditor : propre, non modifié, positions complètes', () => {
  const s = initEditor({ graph: base(), name: 'Mon flux', description: null });
  assert.equal(isDirty(s), false);
  assert.equal(s.description, '');
  assert.deepEqual(Object.keys(s.positions).sort(), ['a', 'b']);
  assert.equal(s.selection, null);
});

test('dirty : modification puis annulation de la modification => propre', () => {
  let s = initEditor({ graph: base(), name: 'N' });
  s = applyGraph(s, updateStep(s.graph, 'a', { name: 'Autre' }));
  assert.equal(isDirty(s), true);
  s = applyGraph(s, updateStep(s.graph, 'a', { name: 'A' }));
  assert.equal(isDirty(s), false, 'retour à l’état enregistré');
});

test('dirty : nom ou description modifiés, puis enregistrés', () => {
  let s = initEditor({ graph: base(), name: 'N', description: 'd' });
  s = setName(s, 'N2');
  assert.equal(isDirty(s), true);
  s = setDescription(setName(s, 'N'), 'd2');
  assert.equal(isDirty(s), true);
  s = markSaved(s, { graph: s.graph, name: s.name, description: s.description });
  assert.equal(isDirty(s), false);
});

test('markSaved : une modification faite pendant l’enregistrement reste « modifiée »', () => {
  let s = initEditor({ graph: base(), name: 'N' });
  const sent = s.graph;
  s = applyGraph(s, updateStep(s.graph, 'a', { name: 'Pendant' }));
  s = markSaved(s, { graph: sent, name: 'N', description: '' });
  assert.equal(isDirty(s), true);
});

test('applyGraph : efface les problèmes du serveur à la première modification, pas avant', () => {
  let s = initEditor({ graph: base(), name: 'N' });
  s = setServerIssues(s, [{ code: 'NO_TERMINAL_STEP', message: 'x' }]);
  assert.equal(s.serverChecked, true);
  assert.equal(applyGraph(s, s.graph).serverIssues.length, 1, 'même graphe : rien ne change');
  s = applyGraph(s, updateStep(s.graph, 'b', { name: 'B2' }));
  assert.deepEqual(s.serverIssues, []);
  assert.equal(s.serverChecked, false);
});

test('applyGraph : nouvelle étape => position automatique, positions existantes conservées', () => {
  let s = initEditor({ graph: base(), name: 'N', positions: { a: { x: 500, y: 40 } } });
  assert.deepEqual(s.positions.a, { x: 500, y: 40 });
  const { graph, key } = addStep(s.graph, 'checklist', { afterKey: 'b' });
  s = applyGraph(s, graph);
  assert.ok(s.positions[key]);
  assert.deepEqual(s.positions.a, { x: 500, y: 40 });
});

test('applyGraph : renommage de clé => position et sélection suivent', () => {
  let s = initEditor({ graph: base(), name: 'N', positions: { b: { x: 10, y: 20 } } });
  s = select(s, { kind: 'step', key: 'b' });
  const r = renameStepKey(s.graph, 'b', 'fin');
  assert.equal(r.error, undefined);
  s = applyGraph(s, r.graph, { renamedKey: { from: 'b', to: 'fin' } });
  assert.deepEqual(s.positions.fin, { x: 10, y: 20 });
  assert.equal(s.positions.b, undefined);
  assert.deepEqual(s.selection, { kind: 'step', key: 'fin' });
});

test('sélection : étape supprimée => retour à la fiche ; transition supprimée idem', () => {
  let s = initEditor({ graph: base(), name: 'N' });
  s = select(s, { kind: 'step', key: 'b' });
  s = applyGraph(s, removeStep(s.graph, 'b'));
  assert.equal(s.selection, null);

  s = initEditor({ graph: base(), name: 'N' });
  s = select(s, { kind: 'edge', from: 'a', to: 'b' });
  assert.deepEqual(s.selection, { kind: 'edge', from: 'a', to: 'b' });
  const c = addStep(s.graph, 'checklist').graph;
  assert.deepEqual(nextSelectionAfterRemoval(c, s.selection), s.selection);
  const noEdge = { ...c, steps: c.steps.map((st) => (st.key === 'a' ? { ...st, next: [] } : st)) };
  assert.equal(nextSelectionAfterRemoval(noEdge, s.selection), null);
});

test('select : une cible inexistante est ignorée', () => {
  const s = select(initEditor({ graph: base(), name: 'N' }), { kind: 'step', key: 'zzz' });
  assert.equal(s.selection, null);
  assert.equal(select(s, { kind: 'edge', from: 'b', to: 'a' }).selection, null);
});

test('addEdge refusé : le graphe n’est pas modifié (erreur remontée par graph-model)', () => {
  const s = initEditor({ graph: base(), name: 'N' });
  const r = addEdge(s.graph, 'a', 'a');
  assert.ok(r.error);
  assert.equal(applyGraph(s, r.graph), s);
});

test('canPublish : brouillon enregistré, sans problème local, avec un nom', () => {
  let s = initEditor({ graph: base(), name: 'N' });
  assert.equal(canPublish(s, ctxDraft), true);
  assert.equal(publishBlockedReason(s, ctxDraft), null);

  const dirty = setName(s, 'N2');
  assert.equal(canPublish(dirty, ctxDraft), false);
  assert.match(publishBlockedReason(dirty, ctxDraft) ?? '', /Enregistrez/);

  s = setLiveIssues(s, [{ code: 'UNREACHABLE_STEP', message: 'x', stepKey: 'a' }]);
  assert.equal(canPublish(s, ctxDraft), false);
  assert.match(publishBlockedReason(s, ctxDraft) ?? '', /problèmes/);
});

test('canPublish : refusé pour une version publiée/archivée, un workflow archivé ou un nom vide', () => {
  const s = initEditor({ graph: base(), name: 'N' });
  assert.equal(canPublish(s, { versionStatus: D.Published, definitionStatus: D.Published }), false);
  assert.equal(canPublish(s, { versionStatus: D.Archived, definitionStatus: D.Published }), false);
  assert.equal(canPublish(s, { versionStatus: D.Draft, definitionStatus: D.Archived }), false);
  const blank = initEditor({ graph: base(), name: '   ' });
  assert.equal(canPublish(blank, ctxDraft), false);
});

test('isReadOnly : seul un brouillon d’un workflow non archivé est modifiable', () => {
  assert.equal(isReadOnly(D.Draft, D.Draft), false);
  assert.equal(isReadOnly(D.Draft, D.Published), false);
  assert.equal(isReadOnly(D.Published, D.Published), true);
  assert.equal(isReadOnly(D.Archived, D.Published), true);
  assert.equal(isReadOnly(D.Draft, D.Archived), true);
});

test('pickVersionToOpen : demandée > brouillon > publiée > plus récente', () => {
  const v = (versionNumber: number, status: number) => ({ versionNumber, status });
  assert.equal(pickVersionToOpen([]), null);
  assert.equal(pickVersionToOpen([v(1, D.Archived), v(2, D.Published), v(3, D.Draft)]), 3);
  assert.equal(pickVersionToOpen([v(1, D.Archived), v(2, D.Published)]), 2);
  assert.equal(pickVersionToOpen([v(1, D.Archived), v(2, D.Archived)]), 2);
  assert.equal(pickVersionToOpen([v(1, D.Archived), v(2, D.Published), v(3, D.Draft)], 1), 1);
  assert.equal(pickVersionToOpen([v(1, D.Published)], 9), 1, 'version demandée inexistante => règle par défaut');
  assert.equal(pickVersionToOpen([v(1, D.Published)], null), 1);
});

test('paramètres d’URL : valeurs invalides ignorées', () => {
  assert.equal(parseRequestedVersion('3'), 3);
  for (const bad of [null, undefined, '', '0', '-1', 'abc', '1.5', '99999999999']) {
    assert.equal(parseRequestedVersion(bad), undefined, String(bad));
  }
  assert.equal(parseDefinitionId('12'), 12);
  for (const bad of [undefined, ['1'], '', '0', 'x', '1e3', '-4']) {
    assert.equal(parseDefinitionId(bad as string), null, String(bad));
  }
});

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.hasOwn(data, k) ? (data[k] as string) : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

test('mise en page : aller-retour, clé stable', () => {
  const storage = memoryStorage();
  assert.equal(layoutStorageKey(7), 'wf-layout:7');
  assert.equal(saveLayout(storage, 7, { a: { x: 1, y: 2 } }), true);
  assert.deepEqual(loadLayout(storage, 7), { a: { x: 1, y: 2 } });
  assert.equal(loadLayout(storage, 8), undefined);
});

test('mise en page : JSON corrompu ou forme inattendue ignorés', () => {
  for (const raw of ['{pas du json', 'null', '[]', '{"a":{"x":"1","y":2}}', '{"a":null}', '"texte"']) {
    const storage = memoryStorage({ [layoutStorageKey(1)]: raw });
    assert.equal(loadLayout(storage, 1), undefined, raw);
  }
});

test('mise en page : stockage indisponible ou qui lève => jamais d’exception', () => {
  const throwing: StorageLike = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(loadLayout(throwing, 1), undefined);
  assert.equal(saveLayout(throwing, 1, {}), false);
  assert.equal(loadLayout(null, 1), undefined);
  assert.equal(saveLayout(undefined, 1, {}), false);
});

// --- Corrections de relecture : note de version, blocage avant enregistrement --------------------------------------

test('note de version : au plus 500 caractères (limite de l’API), vide => undefined', async () => {
  const { CHANGE_NOTE_MAX, normalizeChangeNote } = await import('./editor-state');
  assert.equal(CHANGE_NOTE_MAX, 500);
  assert.equal(normalizeChangeNote('   '), undefined);
  assert.equal(normalizeChangeNote('  ok  '), 'ok');
  assert.equal(normalizeChangeNote('x'.repeat(900))?.length, 500);
});

test('saveBlockers : agent sans objectif, nom d’étape vide et affectation sans identifiant bloquent, en français', async () => {
  const { saveBlockers, describeSaveBlockers } = await import('./editor-state');
  const { addStep, emptyGraph, updateStep } = await import('./graph-model');
  const base = emptyGraph();
  assert.deepEqual(saveBlockers(base, false), []);

  const withAgent = addStep(base, 'agent', { afterKey: base.start }).graph; // objectif vide
  const blockers = saveBlockers(withAgent, false);
  assert.ok(blockers.length >= 1);
  assert.ok(blockers.every((b) => b.title && b.explain && b.fix));
  assert.doesNotMatch(describeSaveBlockers(blockers), /Required|String must|zod/i);

  const emptyName = updateStep(base, base.start, { name: '' });
  assert.ok(saveBlockers(emptyName, false).length >= 1);

  const noId = updateStep(base, base.start, { assignee: { kind: 'user' } });
  assert.ok(saveBlockers(noId, false).length >= 1);
});

test('saveBlockers : un graphe incomplet mais bien formé reste enregistrable (étape non reliée)', async () => {
  const { saveBlockers } = await import('./editor-state');
  const { addStep, emptyGraph, updateStep } = await import('./graph-model');
  let g = addStep(emptyGraph(), 'validation').graph; // inatteignable : problème de sémantique, pas de forme
  g = updateStep(g, g.steps[1]?.key ?? '', { name: 'Valider' });
  assert.deepEqual(saveBlockers(g, false), []);
});
