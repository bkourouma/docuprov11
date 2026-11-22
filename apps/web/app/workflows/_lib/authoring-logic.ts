// Docu-Flow W5 — logique PURE de la création en langage naturel (aucun React) : testable par `tsx --test`.
// Tout ce qui vient de l'API ou du stockage du navigateur est une donnée non fiable : on ne l'affiche qu'en
// texte brut (React échappe), jamais en HTML.
import {
  WF_AUTHORING_DESCRIPTION_MAX,
  WF_AUTHORING_DESCRIPTION_MIN,
  WF_AUTHORING_MARKER_KEY,
  type WfAuthoringGenerateResponse,
  type WfAuthoringToDoItem,
  type WfGraph,
  type WfTemplateSummary,
} from '@archivage/types';
import { WF_TEMPLATE_KEY_RE, WorkflowApiError, workflowErrorMessage } from '../../lib/workflows-api';
import type { StorageLike } from './editor-state';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const AUTHORING_DESCRIPTION_MAX = WF_AUTHORING_DESCRIPTION_MAX; // 4000
export const AUTHORING_DESCRIPTION_MIN = WF_AUTHORING_DESCRIPTION_MIN; // 10

export const AUTHORING_EXAMPLE =
  'Quand une facture fournisseur arrive, extraire le montant, vérifier le bon de commande, router vers le DAF au-dessus de 5 M FCFA.';

export const AUTHORING_WARNING = 'Brouillon à relire : rien n’est publié. Ne collez pas de données personnelles inutiles.';

export const AUTHORING_BANNER_TITLE = 'Brouillon généré à partir de votre description — à relire avant toute publication';

/** Paramètre d'URL posé après une génération réussie (information seulement : l'état du bandeau est en sessionStorage). */
export const AUTHORING_ORIGIN_PARAM = 'origine=langage-naturel';

/** Chemin de l'éditeur du brouillon créé ; `null` si l'identifiant n'est pas un entier positif sûr. */
export function authoringEditorPath(definitionId: unknown): string | null {
  if (typeof definitionId !== 'number' || !Number.isSafeInteger(definitionId) || definitionId < 1) return null;
  return `/workflows/conception/${definitionId}?${AUTHORING_ORIGIN_PARAM}`;
}

/** Chemin de l'éditeur d'un brouillon créé depuis un modèle ; `null` si l'identifiant est invalide. */
export function editorPath(definitionId: unknown): string | null {
  if (typeof definitionId !== 'number' || !Number.isSafeInteger(definitionId) || definitionId < 1) return null;
  return `/workflows/conception/${definitionId}`;
}

// ---------------------------------------------------------------------------
// Description saisie
// ---------------------------------------------------------------------------

/** Nombre de caractères perçus (points de code : un emoji compte pour 1, pas pour 2). */
export function countChars(text: string): number {
  return Array.from(text).length;
}

/** Libellé du compteur annoncé aux lecteurs d'écran : « 12 / 4000 ». */
export function counterLabel(text: string): string {
  return `${countChars(text)} / ${AUTHORING_DESCRIPTION_MAX}`;
}

/** Message d'erreur français, ou `null` si la description peut être envoyée (sans espaces de tête et de queue). */
export function validateDescription(text: string): string | null {
  const trimmed = text.trim();
  const n = countChars(trimmed);
  if (n === 0) return 'Décrivez le besoin en quelques phrases.';
  if (n < AUTHORING_DESCRIPTION_MIN) {
    return `La description est trop courte : ${AUTHORING_DESCRIPTION_MIN} caractères au moins (${n} saisis).`;
  }
  if (n > AUTHORING_DESCRIPTION_MAX) {
    return `La description est trop longue : ${AUTHORING_DESCRIPTION_MAX} caractères au plus (${n} saisis).`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Messages d'erreur
// ---------------------------------------------------------------------------

const FRENCH_HINT = /[àâçéèêëîïôùûüœ]|\b(le|les|des|une|est|pour|vous|votre|pas|trop|erreur)\b/i;
const MAX_API_MESSAGE = 300;

/** Le message de l'API est-il (vraisemblablement) en français ? Les messages « HTTP 409 » ou anglais sont écartés. */
function frenchApiMessage(message: string): string | null {
  const m = message.trim();
  if (m === '' || /^HTTP \d+$/.test(m) || !FRENCH_HINT.test(m)) return null;
  return m.length > MAX_API_MESSAGE ? `${m.slice(0, MAX_API_MESSAGE - 1)}…` : m;
}

export const AUTHORING_AI_DISABLED_MESSAGE =
  'L’IA est désactivée pour ce client : décrivez le besoin dans l’éditeur ou créez le workflow à la main.';

/**
 * Message affichable pour une erreur de génération, d'explication ou de modèle.
 * 409 : IA désactivée (message dédié) ou message français de l'API (arrêt d'urgence, masquage requis) ;
 * 429 : limite de débit (avec `Retry-After` si connu) ou budget ; 422 : brouillon inutilisable + problèmes ;
 * 403 : droit refusé ; le reste (session, 5xx, réseau) passe par `workflowErrorMessage`.
 */
export function authoringErrorMessage(e: unknown): string {
  if (!(e instanceof WorkflowApiError)) return workflowErrorMessage(e);
  if (e.status === 409) {
    const fr = frenchApiMessage(e.message);
    if (fr === null || /\bIA\b.*désactiv|désactiv.*\bIA\b/i.test(fr)) return AUTHORING_AI_DISABLED_MESSAGE;
    return fr;
  }
  if (e.status === 429) {
    if (typeof e.retryAfterSeconds === 'number' && e.retryAfterSeconds >= 1) {
      return `Trop de demandes de génération. Réessayez dans ${Math.ceil(e.retryAfterSeconds)} s.`;
    }
    return frenchApiMessage(e.message) ?? 'Trop de demandes de génération. Réessayez dans quelques instants.';
  }
  if (e.status === 422 && (e.code === 'AUTHORING_INVALID' || (e.issues?.length ?? 0) > 0)) {
    const base = 'Le brouillon généré n’est pas utilisable : reformulez le besoin avec plus de détails.';
    const lines = (e.issues ?? [])
      .map((i) => (typeof i.message === 'string' ? i.message.trim() : ''))
      .filter((m) => m !== '')
      .slice(0, 5)
      .map((m) => (m.length > 200 ? `${m.slice(0, 199)}…` : m));
    return lines.length > 0 ? `${base} Problèmes relevés : ${lines.join(' ; ')}` : base;
  }
  if (e.status === 403) {
    return 'Votre rôle ne permet pas de créer un workflow à partir d’une description (droit de conception requis).';
  }
  return workflowErrorMessage(e);
}

// ---------------------------------------------------------------------------
// Problèmes, éléments à compléter, bandeau
// ---------------------------------------------------------------------------

export interface ProblemLine {
  kind: 'issue' | 'todo';
  text: string;
  /** Étape concernée (sélectionnable dans l'éditeur si elle existe encore). */
  stepKey?: string;
}

export interface BannerIssue {
  code: string;
  message: string;
  stepKey?: string;
}

/** État du bandeau conservé en sessionStorage (borné, validé à la relecture). */
export interface BannerState {
  v: 1;
  assumptions: string[];
  issues: BannerIssue[];
  toComplete: WfAuthoringToDoItem[];
  trigger: { label: string; eventType: string } | null;
}

export const BANNER_LIMITS = {
  assumptions: 20,
  assumptionChars: 400,
  problems: 50,
  textChars: 400,
  nameChars: 200,
  /** Au-delà, la valeur lue est ignorée sans analyse. */
  rawChars: 60_000,
} as const;

const clip = (s: string, max: number): string => (countChars(s) > max ? `${Array.from(s).slice(0, max - 1).join('')}…` : s);

export function todoText(item: Pick<WfAuthoringToDoItem, 'stepName' | 'hint' | 'what'>): string {
  const hint = item.hint ? ` (« ${item.hint} » lu dans la description)` : '';
  return `Étape « ${item.stepName} » : renseigner le responsable${hint}.`;
}

/** Regroupe les problèmes et les éléments à compléter d'une réponse en lignes lisibles (texte brut). */
export function describeProblems(
  r: Pick<WfAuthoringGenerateResponse, 'issues' | 'toComplete'> | { issues?: BannerIssue[]; toComplete?: WfAuthoringToDoItem[] },
): ProblemLine[] {
  const lines: ProblemLine[] = [];
  for (const i of r.issues ?? []) {
    lines.push({ kind: 'issue', text: i.message, ...(i.stepKey ? { stepKey: i.stepKey } : {}) });
  }
  for (const t of r.toComplete ?? []) {
    lines.push({ kind: 'todo', text: todoText(t), stepKey: t.stepKey });
  }
  return lines;
}

export function buildBannerState(r: WfAuthoringGenerateResponse): BannerState {
  return (
    sanitizeBannerState({
      v: 1,
      assumptions: r.assumptions,
      issues: r.issues,
      toComplete: r.toComplete,
      trigger: r.triggerSuggestion ? { label: r.triggerSuggestion.label, eventType: r.triggerSuggestion.eventType } : null,
    }) ?? { v: 1, assumptions: [], issues: [], toComplete: [], trigger: null }
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Valide et borne un état de bandeau inconnu (relu du stockage ou construit depuis l'API) : `null` si la forme
 * est inattendue. Les éléments invalides sont écartés ; les listes et les textes sont tronqués.
 */
export function sanitizeBannerState(raw: unknown): BannerState | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  if (!Array.isArray(raw.assumptions) || !Array.isArray(raw.issues) || !Array.isArray(raw.toComplete)) return null;

  const assumptions = raw.assumptions
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    .slice(0, BANNER_LIMITS.assumptions)
    .map((a) => clip(a.trim(), BANNER_LIMITS.assumptionChars));

  const issues: BannerIssue[] = [];
  for (const i of raw.issues) {
    if (issues.length >= BANNER_LIMITS.problems) break;
    if (!isObj(i) || typeof i.message !== 'string' || i.message.trim() === '') continue;
    issues.push({
      code: typeof i.code === 'string' ? clip(i.code, 100) : '',
      message: clip(i.message.trim(), BANNER_LIMITS.textChars),
      ...(typeof i.stepKey === 'string' && i.stepKey !== '' ? { stepKey: clip(i.stepKey, 100) } : {}),
    });
  }

  const toComplete: WfAuthoringToDoItem[] = [];
  for (const t of raw.toComplete) {
    if (toComplete.length >= BANNER_LIMITS.problems) break;
    if (!isObj(t) || typeof t.stepKey !== 'string' || t.stepKey === '') continue;
    toComplete.push({
      stepKey: clip(t.stepKey, 100),
      stepName: typeof t.stepName === 'string' && t.stepName !== '' ? clip(t.stepName, BANNER_LIMITS.nameChars) : t.stepKey,
      what: 'assignee',
      hint: typeof t.hint === 'string' && t.hint.trim() !== '' ? clip(t.hint.trim(), BANNER_LIMITS.nameChars) : null,
    });
  }

  let trigger: BannerState['trigger'] = null;
  if (isObj(raw.trigger) && typeof raw.trigger.label === 'string' && raw.trigger.label.trim() !== '') {
    trigger = {
      label: clip(raw.trigger.label.trim(), BANNER_LIMITS.nameChars),
      eventType: typeof raw.trigger.eventType === 'string' ? clip(raw.trigger.eventType, 200) : '',
    };
  }
  return { v: 1, assumptions, issues, toComplete, trigger };
}

// ----- Stockage (sessionStorage) -----

/** Sous-ensemble de `Storage` utilisé : lecture, écriture, suppression. */
export interface BannerStorageLike extends StorageLike {
  removeItem(key: string): void;
}

export function bannerStorageKey(definitionId: number): string {
  return `wf-authoring:${definitionId}`;
}

/** Enregistre l'état du bandeau ; `false` (sans lever) si le stockage est absent, plein ou refuse l'écriture. */
export function saveBannerState(
  storage: BannerStorageLike | null | undefined,
  definitionId: number,
  state: BannerState,
): boolean {
  if (!storage) return false;
  const clean = sanitizeBannerState(state);
  if (!clean) return false;
  try {
    const raw = JSON.stringify(clean);
    if (raw.length > BANNER_LIMITS.rawChars) return false;
    storage.setItem(bannerStorageKey(definitionId), raw);
    return true;
  } catch {
    return false;
  }
}

/** État enregistré, ou `null` (stockage absent ou qui lève, JSON corrompu, trop gros, forme inattendue). */
export function loadBannerState(storage: BannerStorageLike | null | undefined, definitionId: number): BannerState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(bannerStorageKey(definitionId));
    if (raw === null || raw.length > BANNER_LIMITS.rawChars) return null;
    return sanitizeBannerState(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function clearBannerState(storage: BannerStorageLike | null | undefined, definitionId: number): void {
  if (!storage) return;
  try {
    storage.removeItem(bannerStorageKey(definitionId));
  } catch {
    /* stockage indisponible : le bandeau est de toute façon masqué dans l'état local */
  }
}

// ----- Marqueurs du graphe -----

/**
 * Étapes marquées « à compléter » par le générateur (`step.config.authoring.toComplete`), sans responsable
 * renseigné depuis. Tolérant : la forme du marqueur n'est lue que superficiellement.
 */
export function markersToComplete(graph: WfGraph | null | undefined): WfAuthoringToDoItem[] {
  const out: WfAuthoringToDoItem[] = [];
  for (const step of graph?.steps ?? []) {
    const marker = step.config?.[WF_AUTHORING_MARKER_KEY];
    if (!isObj(marker)) continue;
    const todo = marker.toComplete;
    const present = todo === true || (Array.isArray(todo) && todo.length > 0) || (typeof todo === 'string' && todo !== '') || isObj(todo);
    if (!present) continue;
    // Le serveur écrit `assigneeHint` (`hint` en repli).
    const rawHint = typeof marker.assigneeHint === 'string' && marker.assigneeHint.trim() !== '' ? marker.assigneeHint : marker.hint;
    const hint = typeof rawHint === 'string' && rawHint.trim() !== '' ? clip(rawHint.trim(), BANNER_LIMITS.nameChars) : null;
    out.push({ stepKey: step.key, stepName: step.name, what: 'assignee', hint });
  }
  return out.slice(0, BANNER_LIMITS.problems);
}

/** Éléments encore à compléter : l'étape existe toujours et n'a pas de responsable. */
export function remainingToComplete(items: readonly WfAuthoringToDoItem[], graph: WfGraph | null | undefined): WfAuthoringToDoItem[] {
  if (!graph) return [...items];
  const byKey = new Map(graph.steps.map((s) => [s.key, s]));
  return items.filter((t) => {
    const step = byKey.get(t.stepKey);
    return step !== undefined && !step.assignee;
  });
}

export interface BannerModel {
  title: string;
  assumptions: string[];
  problems: ProblemLine[];
  toComplete: ProblemLine[];
  /** « Déclencheur suggéré : … » ; rien n'a été créé. */
  triggerText: string | null;
  /** Nombre d'éléments à relire (hypothèses + problèmes + éléments à compléter). */
  count: number;
  countLabel: string;
}

export function triggerSuggestionText(label: string): string {
  return `Déclencheur suggéré : ${label} — à créer dans le panneau Déclencheurs ; rien n’a été créé.`;
}

/**
 * Modèle du bandeau, ou `null` s'il n'y a rien à montrer (ni état enregistré, ni marqueur dans le graphe).
 * Les éléments à compléter sont ceux de l'état ET des marqueurs du graphe, sans doublon, tant que l'étape n'a
 * pas de responsable.
 */
export function buildBannerModel(input: { state: BannerState | null; graph: WfGraph | null | undefined }): BannerModel | null {
  const markers = markersToComplete(input.graph);
  if (!input.state && markers.length === 0) return null;
  const state = input.state;
  const merged: WfAuthoringToDoItem[] = [...(state?.toComplete ?? [])];
  for (const m of markers) if (!merged.some((t) => t.stepKey === m.stepKey)) merged.push(m);
  const remaining = remainingToComplete(merged, input.graph);
  const lines = describeProblems({ issues: state?.issues ?? [], toComplete: remaining });
  const problems = lines.filter((l) => l.kind === 'issue');
  const toComplete = lines.filter((l) => l.kind === 'todo');
  const assumptions = state?.assumptions ?? [];
  const count = assumptions.length + problems.length + toComplete.length;
  return {
    title: AUTHORING_BANNER_TITLE,
    assumptions,
    problems,
    toComplete,
    triggerText: state?.trigger ? triggerSuggestionText(state.trigger.label) : null,
    count,
    countLabel: count === 0 ? 'Rien d’autre à relire signalé' : count === 1 ? '1 point à relire' : `${count} points à relire`,
  };
}

// ---------------------------------------------------------------------------
// Modèles (W6)
// ---------------------------------------------------------------------------

/** Étiquettes d'un modèle, séparées par des virgules ; chaîne vide s'il n'y en a pas. */
export function templateTagsLabel(tags: readonly unknown[] | null | undefined): string {
  if (!Array.isArray(tags)) return '';
  return tags
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim())
    .slice(0, 12)
    .join(', ');
}

/** Ne garde que les modèles utilisables (clé valide, nom présent) : les données de l'API ne sont pas fiables. */
export function usableTemplates(list: unknown): WfTemplateSummary[] {
  if (!Array.isArray(list)) return [];
  const out: WfTemplateSummary[] = [];
  for (const t of list) {
    if (!isObj(t) || typeof t.key !== 'string' || !WF_TEMPLATE_KEY_RE.test(t.key)) continue;
    if (typeof t.name !== 'string' || t.name.trim() === '') continue;
    out.push({
      key: t.key,
      name: clip(t.name.trim(), BANNER_LIMITS.nameChars),
      description: typeof t.description === 'string' ? clip(t.description.trim(), 600) : '',
      agentKey: typeof t.agentKey === 'string' && t.agentKey !== '' ? t.agentKey : null,
      tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
    });
  }
  return out;
}

/** Filtre de recherche (nom, description, étiquettes), insensible à la casse. */
export function filterTemplates(list: readonly WfTemplateSummary[], query: string): WfTemplateSummary[] {
  const q = query.trim().toLocaleLowerCase('fr');
  if (q === '') return [...list];
  return list.filter((t) => `${t.name} ${t.description} ${t.tags.join(' ')}`.toLocaleLowerCase('fr').includes(q));
}

// ---------------------------------------------------------------------------
// Explication (texte brut)
// ---------------------------------------------------------------------------

export interface ExplanationView {
  versionNumber: number | null;
  summary: string;
  steps: Array<{ key: string; name: string; text: string }>;
  toComplete: string[];
}

/** Réponse d'explication normalisée (champs inconnus ignorés, textes bornés) : `null` si inutilisable. */
export function normalizeExplanation(raw: unknown): ExplanationView | null {
  if (!isObj(raw) || typeof raw.summary !== 'string') return null;
  const steps: ExplanationView['steps'] = [];
  for (const s of Array.isArray(raw.steps) ? raw.steps : []) {
    if (steps.length >= 100) break;
    if (!isObj(s) || typeof s.text !== 'string') continue;
    steps.push({
      key: typeof s.key === 'string' ? clip(s.key, 100) : '',
      name: typeof s.name === 'string' ? clip(s.name, BANNER_LIMITS.nameChars) : '',
      text: clip(s.text, 1000),
    });
  }
  const todo: string[] = [];
  for (const t of Array.isArray(raw.toComplete) ? raw.toComplete : []) {
    if (todo.length >= BANNER_LIMITS.problems) break;
    if (isObj(t) && typeof t.stepName === 'string') {
      todo.push(todoText({ stepName: clip(t.stepName, BANNER_LIMITS.nameChars), hint: typeof t.hint === 'string' ? clip(t.hint, BANNER_LIMITS.nameChars) : null, what: 'assignee' }));
    }
  }
  return {
    versionNumber: typeof raw.versionNumber === 'number' && Number.isFinite(raw.versionNumber) ? raw.versionNumber : null,
    summary: clip(raw.summary, 4000),
    steps,
    toComplete: todo,
  };
}
