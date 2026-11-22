// Docu-Flow — modèle PUR de l'éditeur de graphe (aucun React, aucun JSX).
// Source de vérité : un `WfGraph` immuable (chaque opération renvoie un NOUVEAU graphe) + une table de
// positions. React Flow n'est qu'une vue dérivée (`graphToFlow`) : on n'y relit jamais l'état métier.
import type { Edge, Node } from '@xyflow/react';
import {
  type WfEdge,
  type WfGraph,
  type WfStep,
  type WfTaskTypeKey,
} from '@archivage/types';
import { stepTypeLabel } from './labels';

export interface Position {
  x: number;
  y: number;
}
export type PositionMap = Record<string, Position>;
export type StepKey = string;

/** Même motif que le schéma du graphe (`STEP_KEY_PATTERN` de @archivage/types). */
export const STEP_KEY_RE = /^[a-z][a-z0-9_]*$/;

const MAX_KEY_LENGTH = 100;
const COLUMN_WIDTH = 280;
const ROW_HEIGHT = 130;

type EdgePatch = {
  label?: string | undefined;
  condition?: WfEdge['condition'] | null;
  isDefault?: boolean | undefined;
  to?: string;
};

// ---------------------------------------------------------------------------
// Utilitaires internes
// ---------------------------------------------------------------------------

/** Copie profonde : le graphe n'est que du JSON, `structuredClone` suffit. */
function cloneGraph(graph: WfGraph): WfGraph {
  return structuredClone(graph);
}

function findStep(graph: WfGraph, key: string): WfStep | undefined {
  return graph.steps.find((s) => s.key === key);
}

function hasStep(graph: WfGraph, key: string): boolean {
  return graph.steps.some((s) => s.key === key);
}

/** Vrai si l'arête est une arête de repli (même règle que le validateur). */
export function isFallbackEdge(edge: WfEdge): boolean {
  return edge.condition === undefined || edge.isDefault === true;
}

/** Retire les clés dont la valeur est `undefined` (le JSON du graphe n'en porte jamais). */
function withoutUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Clés d'étape
// ---------------------------------------------------------------------------

/** « Contrôle qualité » -> « controle_qualite ». Toujours conforme à STEP_KEY_RE, 100 caractères au plus. */
export function slugifyKey(name: string): string {
  let slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug === '') slug = 'etape';
  // Une clé doit commencer par une lettre.
  if (!/^[a-z]/.test(slug)) slug = `etape_${slug}`;
  slug = slug.slice(0, MAX_KEY_LENGTH).replace(/_+$/, '');
  return slug;
}

/** Clé unique dans le graphe : `base`, puis `base_2`, `base_3`… */
export function newStepKey(graph: WfGraph, base: string): string {
  const root = slugifyKey(base);
  if (!hasStep(graph, root)) return root;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${root.slice(0, MAX_KEY_LENGTH - suffix.length).replace(/_+$/, '')}${suffix}`;
    if (!hasStep(graph, candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function emptyGraph(): WfGraph {
  return {
    schemaVersion: 1,
    start: 'saisie',
    steps: [{ key: 'saisie', name: 'Saisie', type: 'formulaire', next: [] }],
  };
}

export function createStep(type: WfTaskTypeKey, key: string, name?: string): WfStep {
  const step: WfStep = { key, name: name ?? stepTypeLabel(type), type, next: [] };
  if (type === 'agent') {
    step.agent = { objective: '', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' };
  }
  return step;
}

export function addStep(
  graph: WfGraph,
  type: WfTaskTypeKey,
  opts: { name?: string; afterKey?: string } = {},
): { graph: WfGraph; key: string } {
  const name = opts.name ?? stepTypeLabel(type);
  const key = newStepKey(graph, name);
  let next = cloneGraph(graph);
  next.steps.push(createStep(type, key, name));
  if (opts.afterKey !== undefined && hasStep(next, opts.afterKey)) {
    // Si l'étape source a déjà un repli, addEdge pose la condition par défaut (pas d'ambiguïté).
    next = addEdge(next, opts.afterKey, key).graph;
  }
  return { graph: next, key };
}

export function removeStep(graph: WfGraph, key: string): WfGraph {
  if (!hasStep(graph, key) || graph.steps.length <= 1) return graph; // la dernière étape est protégée
  const next = cloneGraph(graph);
  next.steps = next.steps.filter((s) => s.key !== key);
  for (const step of next.steps) {
    step.next = step.next.filter((e) => e.to !== key);
  }
  if (next.start === key) {
    const first = next.steps[0];
    if (first) next.start = first.key;
  }
  return next;
}

export function updateStep(
  graph: WfGraph,
  key: string,
  patch: Partial<Omit<WfStep, 'key' | 'next'>>,
): WfGraph {
  if (!hasStep(graph, key)) return graph;
  const next = cloneGraph(graph);
  const step = findStep(next, key);
  if (!step) return graph;
  const target = step as unknown as Record<string, unknown>;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete target[field]; // `undefined` supprime le champ optionnel
    else target[field] = structuredClone(value);
  }
  if ('type' in patch && patch.type !== undefined) {
    if (patch.type !== 'agent') {
      delete step.agent;
    } else if (step.agent === undefined) {
      step.agent = { objective: '', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' };
    }
  }
  return next;
}

export function renameStepKey(
  graph: WfGraph,
  oldKey: string,
  newKey: string,
): { graph: WfGraph; error?: string } {
  if (!hasStep(graph, oldKey)) return { graph, error: "Cette étape n'existe pas." };
  if (newKey === oldKey) return { graph };
  if (newKey.trim() === '') return { graph, error: "L'identifiant de l'étape est obligatoire." };
  if (newKey.length > MAX_KEY_LENGTH || !STEP_KEY_RE.test(newKey)) {
    return {
      graph,
      error:
        "Identifiant invalide : utilisez des minuscules sans accent, des chiffres et « _ », en commençant par une lettre (100 caractères au plus).",
    };
  }
  if (hasStep(graph, newKey)) {
    return { graph, error: `L'identifiant « ${newKey} » est déjà utilisé par une autre étape.` };
  }
  const next = cloneGraph(graph);
  for (const step of next.steps) {
    if (step.key === oldKey) step.key = newKey;
    for (const edge of step.next) {
      if (edge.to === oldKey) edge.to = newKey;
    }
  }
  if (next.start === oldKey) next.start = newKey;
  return { graph: next };
}

export function setStart(graph: WfGraph, key: string): WfGraph {
  if (!hasStep(graph, key) || graph.start === key) return graph;
  return { ...cloneGraph(graph), start: key };
}

// ---------------------------------------------------------------------------
// Arêtes
// ---------------------------------------------------------------------------

export function addEdge(
  graph: WfGraph,
  from: string,
  to: string,
  init: Partial<WfEdge> = {},
): { graph: WfGraph; error?: string } {
  const source = findStep(graph, from);
  if (!source || !hasStep(graph, to)) return { graph, error: "Étape inconnue : la transition n'a pas été créée." };
  if (from === to) {
    return { graph, error: "Une étape ne peut pas pointer vers elle-même : choisissez une autre étape." };
  }
  if (source.next.some((e) => e.to === to)) {
    return { graph, error: 'Ces deux étapes sont déjà reliées dans ce sens.' };
  }
  const edge: WfEdge = withoutUndefined({ ...structuredClone(init), to });
  // Un second repli rendrait le branchement ambigu : la nouvelle arête reçoit une condition par défaut.
  if (edge.condition === undefined && source.next.some(isFallbackEdge)) {
    edge.condition = { field: 'last', op: 'exists' };
  }
  const next = cloneGraph(graph);
  findStep(next, from)?.next.push(edge);
  return { graph: next };
}

export function updateEdge(
  graph: WfGraph,
  from: string,
  to: string,
  patch: EdgePatch,
): { graph: WfGraph; error?: string } {
  const source = findStep(graph, from);
  const index = source ? source.next.findIndex((e) => e.to === to) : -1;
  if (!source || index < 0) return { graph, error: "Cette transition n'existe pas." };

  const newTarget = patch.to;
  if (newTarget !== undefined && newTarget !== to) {
    if (!hasStep(graph, newTarget)) return { graph, error: "Étape inconnue : la transition n'a pas été modifiée." };
    if (newTarget === from) {
      return { graph, error: "Une étape ne peut pas pointer vers elle-même : choisissez une autre étape." };
    }
    if (source.next.some((e) => e.to === newTarget)) {
      return { graph, error: 'Ces deux étapes sont déjà reliées dans ce sens.' };
    }
  }

  const next = cloneGraph(graph);
  const edge = findStep(next, from)?.next[index];
  if (!edge) return { graph };
  if (newTarget !== undefined) edge.to = newTarget;
  if ('label' in patch) {
    if (patch.label === undefined) delete edge.label;
    else edge.label = patch.label;
  }
  if ('condition' in patch) {
    if (patch.condition === null || patch.condition === undefined) delete edge.condition;
    else edge.condition = structuredClone(patch.condition);
  }
  if ('isDefault' in patch) {
    if (patch.isDefault === undefined) delete edge.isDefault;
    else edge.isDefault = patch.isDefault;
  }
  return { graph: next };
}

export function removeEdge(graph: WfGraph, from: string, to: string): WfGraph {
  const source = findStep(graph, from);
  if (!source || !source.next.some((e) => e.to === to)) return graph;
  const next = cloneGraph(graph);
  const step = findStep(next, from);
  if (step) step.next = step.next.filter((e) => e.to !== to);
  return next;
}

/** Réordonne les arêtes sortantes : l'ordre compte (la première condition vraie gagne). */
export function moveEdge(graph: WfGraph, from: string, to: string, delta: -1 | 1): WfGraph {
  const source = findStep(graph, from);
  const index = source ? source.next.findIndex((e) => e.to === to) : -1;
  if (!source || index < 0) return graph;
  const target = index + delta;
  if (target < 0 || target >= source.next.length) return graph;
  const next = cloneGraph(graph);
  const list = findStep(next, from)?.next;
  if (!list) return graph;
  const moved = list.splice(index, 1);
  list.splice(target, 0, ...moved);
  return next;
}

// ---------------------------------------------------------------------------
// Comparaison
// ---------------------------------------------------------------------------

/** Sérialisation canonique : clés d'objet triées, valeurs `undefined` ignorées ; l'ordre des tableaux compte. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
}

/** Égalité structurelle indépendante de l'ordre des clés d'objet (détection des modifications non enregistrées). */
export function graphsEqual(a: WfGraph, b: WfGraph): boolean {
  return canonical(a) === canonical(b);
}

// ---------------------------------------------------------------------------
// Disposition
// ---------------------------------------------------------------------------

/**
 * Disposition en couches, de gauche à droite. La profondeur est le plus court chemin depuis le départ :
 * un parcours en largeur ignore de lui-même les arêtes retour (elles visent un nœud déjà vu). Déterministe.
 */
export function layoutGraph(graph: WfGraph): PositionMap {
  const byKey = new Map<string, WfStep>();
  for (const s of graph.steps) if (!byKey.has(s.key)) byKey.set(s.key, s);

  const depth = new Map<string, number>();
  const order: string[] = [];
  if (byKey.has(graph.start)) {
    depth.set(graph.start, 0);
    order.push(graph.start);
    for (let head = 0; head < order.length; head++) {
      const key = order[head] as string;
      const d = depth.get(key) ?? 0;
      for (const edge of byKey.get(key)?.next ?? []) {
        if (byKey.has(edge.to) && !depth.has(edge.to)) {
          depth.set(edge.to, d + 1);
          order.push(edge.to);
        }
      }
    }
  }

  let maxDepth = -1;
  for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);

  const positions: PositionMap = {};
  const rowInColumn = new Map<number, number>();
  const place = (key: string, column: number) => {
    const row = rowInColumn.get(column) ?? 0;
    rowInColumn.set(column, row + 1);
    positions[key] = { x: column * COLUMN_WIDTH, y: row * ROW_HEIGHT };
  };
  for (const key of order) place(key, depth.get(key) ?? 0);
  // Étapes non atteignables : colonne supplémentaire, dans l'ordre de déclaration.
  const unreachableColumn = maxDepth + 1;
  for (const key of byKey.keys()) {
    if (!depth.has(key)) place(key, unreachableColumn);
  }
  return positions;
}

function isFinitePosition(p: unknown): p is Position {
  if (typeof p !== 'object' || p === null) return false;
  const { x, y } = p as { x?: unknown; y?: unknown };
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y);
}

/** Positions sauvegardées pour les clés encore présentes, disposition automatique pour les nouvelles. */
export function mergePositions(graph: WfGraph, saved?: PositionMap): PositionMap {
  const auto = layoutGraph(graph);
  const out: PositionMap = {};
  for (const step of graph.steps) {
    const kept = saved && Object.hasOwn(saved, step.key) ? saved[step.key] : undefined;
    const fallback = auto[step.key];
    if (isFinitePosition(kept)) out[step.key] = { x: kept.x, y: kept.y };
    else if (fallback) out[step.key] = fallback;
  }
  return out;
}

export function positionsFromNodes(nodes: Array<{ id: string; position: Position }>): PositionMap {
  const out: PositionMap = {};
  for (const n of nodes) {
    if (isFinitePosition(n.position)) out[n.id] = { x: n.position.x, y: n.position.y };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Libellés
// ---------------------------------------------------------------------------

const OP_SYMBOLS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'parmi',
  exists: 'existe',
};

/** « last.approved = true ». Valeur en JSON compact ; l'opérateur « existe » n'en porte pas. */
export function describeCondition(c: NonNullable<WfEdge['condition']>): string {
  const op = OP_SYMBOLS[c.op] ?? c.op;
  if (c.op === 'exists' || c.value === undefined) return `${c.field} ${op}`;
  return `${c.field} ${op} ${JSON.stringify(c.value) ?? ''}`.trimEnd();
}

/**
 * Libellé d'une arête. Priorité : libellé saisi, puis « Si <condition> », puis « Repli ».
 * Avec libellé ET condition : « libellé (si <condition>) » ; une arête `isDefault` avec condition est un
 * repli explicite : « libellé (repli) ».
 */
export function edgeLabel(edge: WfEdge, isFallback: boolean): string {
  const label = edge.label?.trim() ?? '';
  const explicitDefault = edge.isDefault === true && edge.condition !== undefined;
  if (label !== '') {
    if (explicitDefault) return `${label} (repli)`;
    if (edge.condition) return `${label} (si ${describeCondition(edge.condition)})`;
    return label;
  }
  if (explicitDefault) return 'Repli';
  if (edge.condition) return `Si ${describeCondition(edge.condition)}`;
  return isFallback ? 'Repli' : '';
}

/** Une arête est affichée « repli » seulement s'il y a un choix : seule sortie = simple enchaînement. */
function showsAsFallback(step: WfStep, edge: WfEdge): boolean {
  return step.next.length > 1 && isFallbackEdge(edge);
}

/** Texte court d'une arête sortante pour le libellé accessible (« si last.approved = true », « repli »). */
function edgeHint(step: WfStep, edge: WfEdge): string {
  const label = edge.label?.trim() ?? '';
  if (label !== '') return label;
  if (edge.isDefault === true && edge.condition) return 'repli';
  if (edge.condition) return `si ${describeCondition(edge.condition)}`;
  return showsAsFallback(step, edge) ? 'repli' : '';
}

/** « Étape « Valider », type Validation, étape de départ, suivantes : Archiver (si last.approved = true), Corriger (repli). » */
export function stepAriaLabel(graph: WfGraph, step: WfStep): string {
  const parts = [`Étape « ${step.name} »`, `type ${stepTypeLabel(step.type)}`];
  if (graph.start === step.key) parts.push('étape de départ');
  if (step.next.length === 0) {
    parts.push('étape finale');
  } else {
    const names = new Map(graph.steps.map((s) => [s.key, s.name]));
    const next = step.next.map((edge) => {
      const name = names.get(edge.to) ?? edge.to;
      const hint = edgeHint(step, edge);
      return hint === '' ? name : `${name} (${hint})`;
    });
    parts.push(`suivantes : ${next.join(', ')}`);
  }
  return `${parts.join(', ')}.`;
}

export interface OutlineEntry {
  key: string;
  name: string;
  type: string;
  typeLabel: string;
  isStart: boolean;
  isTerminal: boolean;
  next: Array<{ to: string; toName: string; label: string; isFallback: boolean }>;
}

/** Liste alternative accessible (lecteurs d'écran, petit écran), dans l'ordre de déclaration. */
export function listStepOutline(graph: WfGraph): OutlineEntry[] {
  const names = new Map(graph.steps.map((s) => [s.key, s.name]));
  return graph.steps.map((step) => ({
    key: step.key,
    name: step.name,
    type: step.type,
    typeLabel: stepTypeLabel(step.type),
    isStart: graph.start === step.key,
    isTerminal: step.next.length === 0,
    next: step.next.map((edge) => {
      const isFallback = showsAsFallback(step, edge);
      return {
        to: edge.to,
        toName: names.get(edge.to) ?? edge.to,
        label: edgeLabel(edge, isFallback),
        isFallback,
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Vue React Flow
// ---------------------------------------------------------------------------

export interface StepNodeData extends Record<string, unknown> {
  step: WfStep;
  isStart: boolean;
  isTerminal: boolean;
  issueCount: number;
  /** Texte accessible complet (voir stepAriaLabel). */
  label: string;
}

export interface StepEdgeData extends Record<string, unknown> {
  from: string;
  to: string;
  edge: WfEdge;
  isFallback: boolean;
  /** Rang dans les arêtes sortantes, à partir de 1. */
  order: number;
}

export function graphToFlow(
  graph: WfGraph,
  positions: PositionMap,
  issues: Array<{ stepKey?: string }> = [],
): { nodes: Node<StepNodeData, 'step'>[]; edges: Edge<StepEdgeData>[] } {
  const issueCounts = new Map<string, number>();
  for (const issue of issues) {
    if (issue.stepKey !== undefined) issueCounts.set(issue.stepKey, (issueCounts.get(issue.stepKey) ?? 0) + 1);
  }
  const auto = layoutGraph(graph);
  const names = new Map(graph.steps.map((s) => [s.key, s.name]));

  const nodes: Node<StepNodeData, 'step'>[] = graph.steps.map((step) => {
    const issueCount = issueCounts.get(step.key) ?? 0;
    const label = stepAriaLabel(graph, step);
    const saved = Object.hasOwn(positions, step.key) ? positions[step.key] : undefined;
    const position = isFinitePosition(saved) ? saved : (auto[step.key] ?? { x: 0, y: 0 });
    return {
      id: step.key,
      type: 'step',
      position,
      draggable: true,
      ariaLabel: issueCount > 0 ? `${label} ${issueCount === 1 ? '1 problème' : `${issueCount} problèmes`}.` : label,
      data: {
        step,
        isStart: graph.start === step.key,
        isTerminal: step.next.length === 0,
        issueCount,
        label,
      },
    };
  });

  const edges: Edge<StepEdgeData>[] = [];
  for (const step of graph.steps) {
    step.next.forEach((edge, i) => {
      const isFallback = showsAsFallback(step, edge);
      const label = edgeLabel(edge, isFallback);
      const sourceName = step.name;
      const targetName = names.get(edge.to) ?? edge.to;
      edges.push({
        id: `${step.key}->${edge.to}`,
        source: step.key,
        target: edge.to,
        label,
        markerEnd: { type: 'arrowclosed' },
        animated: false,
        ariaLabel: `Transition de « ${sourceName} » vers « ${targetName} »${label ? ` : ${label}` : ''}`,
        data: { from: step.key, to: edge.to, edge, isFallback, order: i + 1 },
      });
    });
  }
  return { nodes, edges };
}
