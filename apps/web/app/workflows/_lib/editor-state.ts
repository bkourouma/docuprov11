// Docu-Flow — état PUR de l'éditeur de workflow (aucun React, aucun JSX) : testable par `tsx --test`.
// Le composant EditorView ne fait que brancher ces fonctions sur useReducer et les appels d'API.
import {
  WfDefinitionStatus,
  WfDefinitionVersionStatus,
  type WfGraph,
} from '@archivage/types';
import type { EditorSelection } from '../conception/_components/canvas/types';
import type { WfDefinitionIssue } from '../../lib/workflows-api';
import { explainIssue, validateLive } from './graph-issues';
import { graphsEqual, mergePositions, type PositionMap } from './graph-model';

export type EditorViewMode = 'graph' | 'list';

export interface EditorState {
  graph: WfGraph;
  /** Dernier graphe enregistré (ou chargé) : référence de la détection de modifications. */
  savedGraph: WfGraph;
  name: string;
  savedName: string;
  description: string;
  savedDescription: string;
  positions: PositionMap;
  selection: EditorSelection;
  /** Problèmes calculés localement (validateLive), mis à jour avec un délai. */
  liveIssues: WfDefinitionIssue[];
  /** Problèmes renvoyés par le serveur (vérification ou publication refusée). */
  serverIssues: WfDefinitionIssue[];
  /** Le serveur a-t-il été interrogé depuis la dernière modification du graphe ? */
  serverChecked: boolean;
  view: EditorViewMode;
}

export interface InitEditorInput {
  graph: WfGraph;
  name: string;
  description?: string | null;
  /** Positions enregistrées (localStorage) : fusionnées avec la disposition automatique. */
  positions?: PositionMap;
  /** Vue initiale (liste sur petit écran). */
  view?: EditorViewMode;
}

export function initEditor(input: InitEditorInput): EditorState {
  const description = input.description ?? '';
  return {
    graph: input.graph,
    savedGraph: input.graph,
    name: input.name,
    savedName: input.name,
    description,
    savedDescription: description,
    positions: mergePositions(input.graph, input.positions),
    selection: null,
    liveIssues: [],
    serverIssues: [],
    serverChecked: false,
    view: input.view ?? 'graph',
  };
}

// ---------------------------------------------------------------------------
// Sélection
// ---------------------------------------------------------------------------

function selectionExists(graph: WfGraph, selection: EditorSelection): boolean {
  if (selection === null) return true;
  if (selection.kind === 'step') return graph.steps.some((s) => s.key === selection.key);
  return graph.steps.some((s) => s.key === selection.from && s.next.some((e) => e.to === selection.to));
}

export function select(state: EditorState, selection: EditorSelection): EditorState {
  if (!selectionExists(state.graph, selection)) return { ...state, selection: null };
  return { ...state, selection };
}

/**
 * Sélection après suppression d'étapes/transitions : on garde la sélection si elle existe encore,
 * sinon on retombe sur la fiche du workflow (`null`) — jamais sur un élément qui n'existe plus.
 */
export function nextSelectionAfterRemoval(
  graphAfter: WfGraph,
  selection: EditorSelection,
): EditorSelection {
  return selectionExists(graphAfter, selection) ? selection : null;
}

// ---------------------------------------------------------------------------
// Modifications
// ---------------------------------------------------------------------------

/**
 * Remplace le graphe courant (résultat d'une opération pure de graph-model). Le graphe a changé :
 * les problèmes du serveur sont périmés, on les efface dès la première modification.
 * `renamedKey` : une étape a changé de clé, sa position et la sélection la suivent.
 */
export function applyGraph(
  state: EditorState,
  newGraph: WfGraph,
  opts: { renamedKey?: { from: string; to: string }; positions?: PositionMap } = {},
): EditorState {
  if (newGraph === state.graph) return state;
  let basePositions = opts.positions ?? state.positions;
  let selection = state.selection;
  const renamed = opts.renamedKey;
  if (renamed && Object.hasOwn(basePositions, renamed.from)) {
    const { [renamed.from]: moved, ...rest } = basePositions;
    basePositions = moved ? { ...rest, [renamed.to]: moved } : rest;
  }
  if (renamed && selection) {
    if (selection.kind === 'step' && selection.key === renamed.from) {
      selection = { kind: 'step', key: renamed.to };
    } else if (selection.kind === 'edge') {
      selection = {
        kind: 'edge',
        from: selection.from === renamed.from ? renamed.to : selection.from,
        to: selection.to === renamed.from ? renamed.to : selection.to,
      };
    }
  }
  const changed = !graphsEqual(newGraph, state.graph);
  return {
    ...state,
    graph: newGraph,
    positions: mergePositions(newGraph, basePositions),
    selection: nextSelectionAfterRemoval(newGraph, selection),
    serverIssues: changed ? [] : state.serverIssues,
    serverChecked: changed ? false : state.serverChecked,
  };
}

export function setPositions(state: EditorState, positions: PositionMap): EditorState {
  return { ...state, positions: mergePositions(state.graph, positions) };
}

export function setName(state: EditorState, name: string): EditorState {
  return { ...state, name };
}

export function setDescription(state: EditorState, description: string): EditorState {
  return { ...state, description };
}

export function setLiveIssues(state: EditorState, liveIssues: WfDefinitionIssue[]): EditorState {
  return { ...state, liveIssues };
}

export function setServerIssues(
  state: EditorState,
  serverIssues: WfDefinitionIssue[],
  serverChecked = true,
): EditorState {
  return { ...state, serverIssues, serverChecked };
}

export function setView(state: EditorState, view: EditorViewMode): EditorState {
  return { ...state, view };
}

/**
 * Enregistrement réussi : l'instantané ENVOYÉ devient la référence. Si l'utilisateur a modifié le
 * graphe pendant l'appel, l'état reste « modifié » (on ne compare pas à ce qui est à l'écran).
 */
export function markSaved(
  state: EditorState,
  snapshot: { graph: WfGraph; name: string; description: string },
): EditorState {
  return {
    ...state,
    savedGraph: snapshot.graph,
    savedName: snapshot.name,
    savedDescription: snapshot.description,
  };
}

// ---------------------------------------------------------------------------
// Dérivés
// ---------------------------------------------------------------------------

export function isDirty(state: EditorState): boolean {
  return (
    !graphsEqual(state.graph, state.savedGraph) ||
    state.name !== state.savedName ||
    state.description !== state.savedDescription
  );
}

/** Version publiée ou archivée = immuable ; un workflow archivé n'est plus modifiable du tout. */
export function isReadOnly(versionStatus: number, definitionStatus: number): boolean {
  return versionStatus !== WfDefinitionVersionStatus.Draft || definitionStatus === WfDefinitionStatus.Archived;
}

/**
 * Publication possible : version ouverte = brouillon modifiable, enregistrée telle quelle (le serveur
 * publie ce qu'il a en base), sans problème local et avec un nom.
 */
export function canPublish(
  state: EditorState,
  ctx: { versionStatus: number; definitionStatus: number },
): boolean {
  if (isReadOnly(ctx.versionStatus, ctx.definitionStatus)) return false;
  if (isDirty(state)) return false;
  if (state.liveIssues.length > 0) return false;
  return state.name.trim() !== '';
}

/** Raison lisible d'une publication impossible (`null` si possible) : affichée près du bouton. */
export function publishBlockedReason(
  state: EditorState,
  ctx: { versionStatus: number; definitionStatus: number },
): string | null {
  if (ctx.definitionStatus === WfDefinitionStatus.Archived) return 'Ce workflow est archivé.';
  if (ctx.versionStatus !== WfDefinitionVersionStatus.Draft) return 'Seul un brouillon peut être publié.';
  if (state.name.trim() === '') return 'Le nom du workflow est obligatoire.';
  if (isDirty(state)) return 'Enregistrez le brouillon avant de publier.';
  if (state.liveIssues.length > 0) return 'Corrigez les problèmes signalés avant de publier.';
  return null;
}

/**
 * Version à ouvrir : celle demandée si elle existe, sinon le brouillon, sinon la publiée, sinon la plus
 * récente. `null` si le workflow n'a aucune version.
 */
export function pickVersionToOpen(
  versions: ReadonlyArray<{ versionNumber: number; status: number }>,
  requested?: number | null,
): number | null {
  if (versions.length === 0) return null;
  if (requested !== undefined && requested !== null && versions.some((v) => v.versionNumber === requested)) {
    return requested;
  }
  const newestFirst = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
  const draft = newestFirst.find((v) => v.status === WfDefinitionVersionStatus.Draft);
  if (draft) return draft.versionNumber;
  const published = newestFirst.find((v) => v.status === WfDefinitionVersionStatus.Published);
  if (published) return published.versionNumber;
  return (newestFirst[0] as { versionNumber: number }).versionNumber;
}

/** Lit `?version=n` : entier strictement positif, sinon `undefined`. */
export function parseRequestedVersion(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || !/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

/** Identifiant de définition valide dans l'URL (entier strictement positif), sinon `null`. */
export function parseDefinitionId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Mise en page (positions) : stockage local TOLÉRANT. Le graphe serveur n'a pas de positions.
// ---------------------------------------------------------------------------

/** Sous-ensemble de `Storage` utilisé (injectable pour les tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function layoutStorageKey(definitionId: number): string {
  return `wf-layout:${definitionId}`;
}

function isPositionMap(value: unknown): value is PositionMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((p) => {
    if (typeof p !== 'object' || p === null) return false;
    const { x, y } = p as { x?: unknown; y?: unknown };
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y);
  });
}

/** Positions enregistrées, ou `undefined` (stockage absent/qui lève, JSON corrompu, forme inattendue). */
export function loadLayout(storage: StorageLike | null | undefined, definitionId: number): PositionMap | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(layoutStorageKey(definitionId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isPositionMap(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Enregistre les positions ; renvoie `false` (sans lever) si le stockage est indisponible ou plein. */
export function saveLayout(
  storage: StorageLike | null | undefined,
  definitionId: number,
  positions: PositionMap,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(layoutStorageKey(definitionId), JSON.stringify(positions));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Garde-fous avant envoi à l'API
// ---------------------------------------------------------------------------

/** Note de version : l'API refuse plus de 500 caractères (`updateWfDraftSchema.changeNote`). */
export const CHANGE_NOTE_MAX = 500;

/** Note nettoyée pour l'envoi : espaces retirés, `undefined` si vide, jamais plus de CHANGE_NOTE_MAX caractères. */
export function normalizeChangeNote(note: string): string | undefined {
  const trimmed = note.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, CHANGE_NOTE_MAX);
}

export interface SaveBlocker {
  title: string;
  explain: string;
  fix: string;
  stepKey?: string;
}

/**
 * Problèmes de FORME qui feraient refuser `PUT draft` par l'API (HTTP 400, contrôle `wfGraphSchema`) : objectif
 * d'agent vide, nom d'étape vide, affectation sans identifiant… Rien ne serait enregistré : on bloque avant l'envoi
 * et on explique en français ce qui manque. Les problèmes de SÉMANTIQUE (étape inatteignable, etc.) n'empêchent pas
 * l'enregistrement d'un brouillon incomplet : ils bloquent seulement la publication.
 */
export function saveBlockers(graph: WfGraph, isLowRisk: boolean): SaveBlocker[] {
  return validateLive(graph, { isLowRisk })
    .issues.filter((i) => i.code === 'SCHEMA_INVALID')
    .map((i) => {
      const e = explainIssue(i, graph);
      return { title: e.title, explain: e.explain, fix: e.fix, stepKey: e.stepKey };
    });
}

/** Texte unique (français) listant ce qui empêche l'enregistrement. */
export function describeSaveBlockers(blockers: SaveBlocker[]): string {
  const shown = blockers.slice(0, 3).map((b) => `${b.title} : ${b.explain}`);
  const more = blockers.length > 3 ? ` (et ${blockers.length - 3} autre${blockers.length - 3 > 1 ? 's' : ''})` : '';
  return `Enregistrement impossible, complétez d’abord : ${shown.join(' ; ')}${more}`;
}
