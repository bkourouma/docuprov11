// Tests du modèle pur de l'éditeur de graphe.
// Lancer : cd apps/web && npx tsx --test app/workflows/_lib/graph-model.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkflowGraph, type WfGraph } from '@archivage/types';
import {
  STEP_KEY_RE,
  addEdge,
  addStep,
  createStep,
  describeCondition,
  edgeLabel,
  emptyGraph,
  graphToFlow,
  graphsEqual,
  layoutGraph,
  listStepOutline,
  mergePositions,
  moveEdge,
  newStepKey,
  positionsFromNodes,
  removeEdge,
  removeStep,
  renameStepKey,
  setStart,
  slugifyKey,
  stepAriaLabel,
  updateEdge,
  updateStep,
} from './graph-model';

/** Petit graphe : saisie -> valider -> (archiver si approuvé | corriger par défaut) ; corriger -> valider. */
function sample(): WfGraph {
  return {
    schemaVersion: 1,
    start: 'saisie',
    steps: [
      { key: 'saisie', name: 'Saisie', type: 'formulaire', next: [{ to: 'valider' }] },
      {
        key: 'valider',
        name: 'Valider',
        type: 'validation',
        next: [
          { to: 'archiver', condition: { field: 'last.approved', op: 'eq', value: true } },
          { to: 'corriger' },
        ],
      },
      { key: 'corriger', name: 'Corriger', type: 'formulaire', next: [{ to: 'valider' }] },
      { key: 'archiver', name: 'Archiver', type: 'generation', next: [] },
    ],
  };
}

function step(g: WfGraph, key: string) {
  const s = g.steps.find((x) => x.key === key);
  assert.ok(s, `étape ${key} introuvable`);
  return s;
}

test('slugifyKey : accents, vide, chiffres en tête, longueur', () => {
  assert.equal(slugifyKey('Contrôle qualité'), 'controle_qualite');
  assert.equal(slugifyKey('  Œuvre  d’art !! '), 'oeuvre_d_art');
  assert.equal(slugifyKey(''), 'etape');
  assert.equal(slugifyKey('???'), 'etape');
  assert.equal(slugifyKey('2e relecture'), 'etape_2e_relecture');
  const long = slugifyKey('a'.repeat(300));
  assert.ok(long.length <= 100);
  for (const input of ['Été', '123', '_x', 'A-B', 'x'.repeat(150) + ' ']) {
    assert.match(slugifyKey(input), STEP_KEY_RE);
  }
});

test('newStepKey : unicité par suffixe', () => {
  const g = sample();
  assert.equal(newStepKey(g, 'Nouvelle'), 'nouvelle');
  assert.equal(newStepKey(g, 'Saisie'), 'saisie_2');
  const g2 = addStep(g, 'formulaire', { name: 'Saisie' }).graph;
  assert.equal(newStepKey(g2, 'Saisie'), 'saisie_3');
});

test('emptyGraph et createStep', () => {
  const g = emptyGraph();
  assert.equal(g.start, 'saisie');
  assert.equal(g.steps.length, 1);
  assert.equal(validateWorkflowGraph(g).ok, true);
  const a = createStep('agent', 'robot');
  assert.equal(a.name, 'Agent');
  assert.deepEqual(a.agent, { objective: '', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' });
  assert.equal(createStep('validation', 'v').agent, undefined);
  assert.equal(createStep('validation', 'v', 'Contrôle').name, 'Contrôle');
});

test('addStep : sans et avec afterKey', () => {
  const g = emptyGraph();
  const r = addStep(g, 'validation');
  assert.equal(r.key, 'validation');
  assert.equal(r.graph.steps.length, 2);
  assert.deepEqual(step(r.graph, 'saisie').next, []);

  const chained = addStep(g, 'validation', { afterKey: 'saisie' });
  assert.deepEqual(step(chained.graph, 'saisie').next, [{ to: 'validation' }]);
  assert.equal(validateWorkflowGraph(chained.graph).ok, true);

  // Deuxième suite : l'étape source a déjà un repli => condition par défaut sur la nouvelle arête.
  const second = addStep(chained.graph, 'generation', { afterKey: 'saisie' });
  assert.deepEqual(step(second.graph, 'saisie').next[1], {
    to: 'generation',
    condition: { field: 'last', op: 'exists' },
  });
});

test('removeStep : arêtes entrantes, départ, dernière étape', () => {
  const g = sample();
  const r = removeStep(g, 'corriger');
  assert.equal(r.steps.length, 3);
  assert.deepEqual(step(r, 'valider').next.map((e) => e.to), ['archiver']);

  const noStart = removeStep(g, 'saisie');
  assert.equal(noStart.start, 'valider');

  const single = emptyGraph();
  assert.equal(removeStep(single, 'saisie'), single);
  assert.equal(removeStep(g, 'inconnue'), g);
});

test('renameStepKey : départ et cibles mis à jour, refus invalides', () => {
  const g = sample();
  const r = renameStepKey(g, 'saisie', 'depart');
  assert.equal(r.error, undefined);
  assert.equal(r.graph.start, 'depart');
  const r2 = renameStepKey(g, 'valider', 'controle');
  assert.deepEqual(step(r2.graph, 'saisie').next.map((e) => e.to), ['controle']);
  assert.deepEqual(step(r2.graph, 'corriger').next.map((e) => e.to), ['controle']);
  assert.equal(validateWorkflowGraph(r2.graph).ok, true);

  for (const bad of ['', 'Majuscule', '1abc', 'a-b', 'é']) {
    const e = renameStepKey(g, 'saisie', bad);
    assert.ok(e.error, `« ${bad} » devrait être refusé`);
    assert.equal(e.graph, g);
  }
  const dup = renameStepKey(g, 'saisie', 'valider');
  assert.match(dup.error ?? '', /déjà utilisé/);
  assert.equal(renameStepKey(g, 'saisie', 'saisie').error, undefined);
});

test('setStart', () => {
  const g = sample();
  assert.equal(setStart(g, 'valider').start, 'valider');
  assert.equal(setStart(g, 'inconnue'), g);
});

test('addEdge : erreurs et règle de repli', () => {
  const g = sample();
  assert.match(addEdge(g, 'saisie', 'saisie').error ?? '', /elle-même/);
  assert.match(addEdge(g, 'saisie', 'valider').error ?? '', /déjà reliées/);
  assert.match(addEdge(g, 'saisie', 'zzz').error ?? '', /inconnue/);
  assert.match(addEdge(g, 'zzz', 'saisie').error ?? '', /inconnue/);
  assert.equal(addEdge(g, 'saisie', 'saisie').graph, g);

  // Sortie sans arête : repli autorisé sans condition.
  const ok = addEdge(g, 'archiver', 'saisie');
  assert.deepEqual(step(ok.graph, 'archiver').next, [{ to: 'saisie' }]);

  // Saisie a déjà un repli : condition par défaut.
  const withFallback = addEdge(g, 'saisie', 'archiver');
  assert.deepEqual(step(withFallback.graph, 'saisie').next[1], {
    to: 'archiver',
    condition: { field: 'last', op: 'exists' },
  });
  // Condition fournie : respectée.
  const custom = addEdge(g, 'saisie', 'archiver', { condition: { field: 'x', op: 'eq', value: 1 }, label: 'Cas X' });
  assert.deepEqual(step(custom.graph, 'saisie').next[1], {
    to: 'archiver',
    condition: { field: 'x', op: 'eq', value: 1 },
    label: 'Cas X',
  });
});

test('updateEdge : condition, libellé, redirection', () => {
  const g = sample();
  const cond = updateEdge(g, 'valider', 'corriger', { condition: { field: 'a', op: 'exists' }, label: 'Retour' });
  assert.deepEqual(step(cond.graph, 'valider').next[1], {
    to: 'corriger',
    condition: { field: 'a', op: 'exists' },
    label: 'Retour',
  });
  const cleared = updateEdge(cond.graph, 'valider', 'corriger', { condition: null, label: undefined });
  assert.deepEqual(step(cleared.graph, 'valider').next[1], { to: 'corriger' });

  const def = updateEdge(g, 'valider', 'archiver', { isDefault: true });
  assert.equal(step(def.graph, 'valider').next[0]?.isDefault, true);
  const undef = updateEdge(def.graph, 'valider', 'archiver', { isDefault: undefined });
  assert.equal('isDefault' in (step(undef.graph, 'valider').next[0] ?? {}), false);

  const redirected = updateEdge(g, 'saisie', 'valider', { to: 'archiver' });
  assert.deepEqual(step(redirected.graph, 'saisie').next, [{ to: 'archiver' }]);

  assert.match(updateEdge(g, 'saisie', 'valider', { to: 'saisie' }).error ?? '', /elle-même/);
  assert.match(updateEdge(g, 'valider', 'archiver', { to: 'corriger' }).error ?? '', /déjà reliées/);
  assert.match(updateEdge(g, 'valider', 'archiver', { to: 'zzz' }).error ?? '', /inconnue/);
  assert.match(updateEdge(g, 'saisie', 'archiver', {}).error ?? '', /n'existe pas/);
});

test('removeEdge et moveEdge', () => {
  const g = sample();
  assert.deepEqual(step(removeEdge(g, 'valider', 'corriger'), 'valider').next.map((e) => e.to), ['archiver']);
  assert.equal(removeEdge(g, 'valider', 'zzz'), g);

  const moved = moveEdge(g, 'valider', 'corriger', -1);
  assert.deepEqual(step(moved, 'valider').next.map((e) => e.to), ['corriger', 'archiver']);
  assert.equal(moveEdge(g, 'valider', 'archiver', -1), g); // déjà en tête
  assert.equal(moveEdge(g, 'valider', 'corriger', 1), g); // déjà en queue
  assert.deepEqual(step(moveEdge(g, 'valider', 'archiver', 1), 'valider').next.map((e) => e.to), ['corriger', 'archiver']);
});

test('updateStep : suppression via undefined, bascule du type agent', () => {
  const g = updateStep(sample(), 'saisie', { description: 'Texte', dueInHours: 24 });
  assert.equal(step(g, 'saisie').description, 'Texte');
  const cleaned = updateStep(g, 'saisie', { description: undefined });
  assert.equal('description' in step(cleaned, 'saisie'), false);
  assert.equal(step(cleaned, 'saisie').dueInHours, 24);

  const toAgent = updateStep(sample(), 'saisie', { type: 'agent' });
  assert.deepEqual(step(toAgent, 'saisie').agent, {
    objective: '',
    tools: [],
    confidenceThreshold: 0.8,
    autonomy: 'suggere',
  });
  const back = updateStep(toAgent, 'saisie', { type: 'formulaire' });
  assert.equal(step(back, 'saisie').agent, undefined);
  assert.equal('agent' in step(back, 'saisie'), false);

  // Une spec existante est conservée.
  const custom = updateStep(toAgent, 'saisie', {
    agent: { objective: 'Classer', tools: [], confidenceThreshold: 0.5, autonomy: 'suggere' },
  });
  assert.equal(step(updateStep(custom, 'saisie', { type: 'agent' }), 'saisie').agent?.objective, 'Classer');
});

test('immutabilité : aucune opération ne modifie son entrée', () => {
  const g = sample();
  const before = JSON.stringify(g);
  addStep(g, 'agent', { afterKey: 'saisie' });
  removeStep(g, 'valider');
  updateStep(g, 'saisie', { name: 'X', description: undefined });
  renameStepKey(g, 'valider', 'controle');
  setStart(g, 'valider');
  addEdge(g, 'saisie', 'archiver');
  updateEdge(g, 'valider', 'corriger', { condition: null, to: 'saisie' });
  removeEdge(g, 'valider', 'corriger');
  moveEdge(g, 'valider', 'corriger', -1);
  layoutGraph(g);
  graphToFlow(g, {});
  assert.equal(JSON.stringify(g), before);
});

test('graphsEqual : indépendant de l’ordre des clés, sensible à l’ordre des arêtes', () => {
  const a = sample();
  const b: WfGraph = JSON.parse(JSON.stringify(a));
  // Reconstruit chaque objet avec des clés dans l'ordre inverse.
  const reorder = (o: unknown): unknown =>
    Array.isArray(o)
      ? o.map(reorder)
      : o && typeof o === 'object'
        ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reorder(v)]))
        : o;
  assert.equal(graphsEqual(a, reorder(b) as WfGraph), true);
  assert.equal(graphsEqual(a, moveEdge(a, 'valider', 'corriger', -1)), false);
  assert.equal(graphsEqual(a, updateStep(a, 'saisie', { name: 'Autre' })), false);
  // `undefined` explicite = absent.
  const withUndefined = structuredClone(a);
  (withUndefined.steps[0] as unknown as Record<string, unknown>).description = undefined;
  assert.equal(graphsEqual(a, withUndefined), true);
});

test('layoutGraph : déterministe, colonnes croissantes, non atteignables à part', () => {
  const g = sample();
  const p = layoutGraph(g);
  assert.deepEqual(layoutGraph(g), p);
  assert.deepEqual(p.saisie, { x: 0, y: 0 });
  assert.deepEqual(p.valider, { x: 280, y: 0 });
  // corriger et archiver sont à la profondeur 2 (l'arête retour corriger -> valider est ignorée).
  assert.equal(p.archiver?.x, 560);
  assert.equal(p.corriger?.x, 560);
  assert.notEqual(p.archiver?.y, p.corriger?.y);
  assert.equal(Math.abs((p.archiver?.y ?? 0) - (p.corriger?.y ?? 0)), 130);

  const orphan = addStep(g, 'checklist', { name: 'Orpheline' });
  const po = layoutGraph(orphan.graph);
  assert.equal(po.orpheline?.x, 840);
  assert.deepEqual(Object.keys(po).sort(), orphan.graph.steps.map((s) => s.key).sort());

  // Départ introuvable : tout est « non atteignable », sans exception.
  const broken: WfGraph = { ...g, start: 'zzz' };
  assert.equal(Object.keys(layoutGraph(broken)).length, 4);
});

test('mergePositions : positions sauvegardées, nouvelles disposées, entrées non finies ignorées', () => {
  const g = sample();
  const auto = layoutGraph(g);
  const merged = mergePositions(g, {
    saisie: { x: 10, y: 20 },
    valider: { x: Number.NaN, y: 0 },
    fantome: { x: 1, y: 1 },
  });
  assert.deepEqual(merged.saisie, { x: 10, y: 20 });
  assert.deepEqual(merged.valider, auto.valider);
  assert.deepEqual(merged.archiver, auto.archiver);
  assert.equal('fantome' in merged, false);
  assert.deepEqual(mergePositions(g), auto);
});

test('positionsFromNodes', () => {
  assert.deepEqual(
    positionsFromNodes([
      { id: 'a', position: { x: 1, y: 2 } },
      { id: 'b', position: { x: Number.POSITIVE_INFINITY, y: 0 } },
    ]),
    { a: { x: 1, y: 2 } },
  );
});

test('libellés : condition, arête, aria, plan', () => {
  assert.equal(describeCondition({ field: 'last.approved', op: 'eq', value: true }), 'last.approved = true');
  assert.equal(describeCondition({ field: 'n', op: 'gte', value: 3 }), 'n ≥ 3');
  assert.equal(describeCondition({ field: 'n', op: 'neq', value: 'a' }), 'n ≠ "a"');
  assert.equal(describeCondition({ field: 'k', op: 'in', value: [1, 2] }), 'k parmi [1,2]');
  assert.equal(describeCondition({ field: 'last', op: 'exists' }), 'last existe');
  assert.equal(describeCondition({ field: 'n', op: 'lt', value: 1 }), 'n < 1');
  assert.equal(describeCondition({ field: 'n', op: 'lte', value: 1 }), 'n ≤ 1');
  assert.equal(describeCondition({ field: 'n', op: 'gt', value: 1 }), 'n > 1');

  const cond = { field: 'a', op: 'eq' as const, value: 1 };
  assert.equal(edgeLabel({ to: 'x', label: 'Oui' }, false), 'Oui');
  assert.equal(edgeLabel({ to: 'x', condition: cond }, false), 'Si a = 1');
  assert.equal(edgeLabel({ to: 'x' }, true), 'Repli');
  assert.equal(edgeLabel({ to: 'x' }, false), '');
  assert.equal(edgeLabel({ to: 'x', label: 'Oui', condition: cond }, false), 'Oui (si a = 1)');
  assert.equal(edgeLabel({ to: 'x', label: 'Non', condition: cond, isDefault: true }, true), 'Non (repli)');

  const g = sample();
  assert.equal(
    stepAriaLabel(g, step(g, 'valider')),
    'Étape « Valider », type Validation, suivantes : Archiver (si last.approved = true), Corriger (repli).',
  );
  assert.equal(stepAriaLabel(g, step(g, 'archiver')), 'Étape « Archiver », type Génération, étape finale.');
  assert.equal(
    stepAriaLabel(g, step(g, 'saisie')),
    'Étape « Saisie », type Formulaire, étape de départ, suivantes : Valider.',
  );

  const outline = listStepOutline(g);
  assert.deepEqual(
    outline.map((o) => o.key),
    ['saisie', 'valider', 'corriger', 'archiver'],
  );
  assert.equal(outline[0]?.isStart, true);
  assert.equal(outline[3]?.isTerminal, true);
  assert.deepEqual(outline[1]?.next[1], { to: 'corriger', toName: 'Corriger', label: 'Repli', isFallback: true });
  assert.equal(outline[1]?.typeLabel, 'Validation');
});

test('graphToFlow : nœuds, arêtes, ids, libellés, ariaLabel', () => {
  const g = sample();
  const flow = graphToFlow(g, { saisie: { x: 5, y: 6 } }, [{ stepKey: 'valider' }, { stepKey: 'valider' }, {}]);
  assert.equal(flow.nodes.length, 4);
  assert.equal(flow.edges.length, 4);
  const saisie = flow.nodes.find((n) => n.id === 'saisie');
  assert.deepEqual(saisie?.position, { x: 5, y: 6 });
  assert.equal(saisie?.type, 'step');
  assert.equal(saisie?.draggable, true);
  assert.equal(saisie?.data.isStart, true);
  const valider = flow.nodes.find((n) => n.id === 'valider');
  assert.equal(valider?.data.issueCount, 2);
  assert.match(valider?.ariaLabel ?? '', /2 problèmes/);
  assert.equal(valider?.data.label, stepAriaLabel(g, step(g, 'valider')));
  assert.deepEqual(valider?.position, layoutGraph(g).valider);

  const ids = flow.edges.map((e) => e.id);
  assert.deepEqual(ids, ['saisie->valider', 'valider->archiver', 'valider->corriger', 'corriger->valider']);
  const repli = flow.edges.find((e) => e.id === 'valider->corriger');
  assert.equal(repli?.label, 'Repli');
  assert.equal(repli?.data?.isFallback, true);
  assert.equal(repli?.data?.order, 2);
  assert.deepEqual(repli?.markerEnd, { type: 'arrowclosed' });
  assert.equal(repli?.animated, false);
  assert.match(repli?.ariaLabel ?? '', /Transition de « Valider » vers « Corriger »/);
  // Unique sortie sans condition : simple enchaînement, pas de « Repli ».
  assert.equal(flow.edges.find((e) => e.id === 'saisie->valider')?.label, '');
});

test('aller-retour : les graphes construits par l’éditeur passent le validateur', () => {
  let g = emptyGraph();
  const a = addStep(g, 'validation', { afterKey: 'saisie' });
  g = a.graph;
  const b = addStep(g, 'generation', { afterKey: a.key, name: 'Archivage' });
  g = b.graph;
  const c = addStep(g, 'formulaire', { name: 'Correction' });
  g = c.graph;
  // Branchement : validation -> archivage (repli existant) puis -> correction (condition par défaut posée).
  g = addEdge(g, a.key, c.key).graph;
  g = addEdge(g, c.key, a.key).graph; // retour arrière
  assert.equal(step(g, a.key).next.length, 2);
  const r = validateWorkflowGraph(g);
  assert.equal(r.ok, true, JSON.stringify(r.issues));

  // Type agent + autonomie : complet seulement avec objectif ; le schéma l'exige non vide.
  const ag = addStep(g, 'agent', { afterKey: c.key });
  const incomplete = validateWorkflowGraph(ag.graph);
  assert.equal(incomplete.ok, false); // objectif vide => SCHEMA_INVALID attendu
  const filled = updateStep(ag.graph, ag.key, {
    agent: { objective: 'Classer', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' },
  });
  assert.equal(validateWorkflowGraph(filled).ok, true);
});
