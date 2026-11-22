// Docu-Flow — logique PURE de la boîte de tâches unifiée (filtres, tri, droits d'action, construction des
// résultats de clôture). Aucune dépendance à React : testée par `inbox-logic.test.ts`.
//
// Le serveur reste seul juge (docs/workflow-moteur.md, sections 3.4 et 4.1) : ces fonctions évitent d'envoyer
// ce qui sera refusé et rédigent des messages en français ; elles ne remplacent aucun contrôle côté API.
import type { WfInboxEntry } from '../../lib/workflows-api';
import { dueInfo } from './format';
import { inboxStatusLabel, priorityLabel } from './labels';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Taille de page demandée à l'API (« Charger plus »). */
export const INBOX_PAGE_SIZE = 50;
/** Commentaire de refus / délégation / validation : même plafond que le moteur (WF_COMMENT_MAX). */
export const COMMENT_MAX = 4000;
/** Plafond d'un résultat de clôture : même valeur que le moteur (WF_RESULT_MAX_BYTES). */
export const RESULT_MAX_BYTES = 65_536;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Statuts d'élément « ouverts » : à traiter (0) ou pris en charge (1). */
const OPEN_STATUSES: readonly number[] = [0, 1];
/** Instance suspendue (5) ou terminale (2, 3, 4) : le moteur refuse toute action sur ses tâches. */
const FROZEN_INSTANCE_STATUSES: readonly number[] = [2, 3, 4, 5];

// ---------------------------------------------------------------------------
// Groupes de statuts, filtres, tri
// ---------------------------------------------------------------------------

export type InboxStatusGroup = 'open' | 'done' | 'closed' | 'all';

export interface InboxStatusGroupDef {
  value: InboxStatusGroup;
  label: string;
  /** Paramètre `statuses` envoyé à l'API. */
  statuses: number[];
}

export const INBOX_STATUS_GROUPS: readonly InboxStatusGroupDef[] = [
  { value: 'open', label: 'À traiter', statuses: [0, 1] },
  { value: 'done', label: 'Terminées', statuses: [2] },
  { value: 'closed', label: 'Refusées ou expirées', statuses: [3, 4, 5] },
  { value: 'all', label: 'Tout', statuses: [0, 1, 2, 3, 4, 5] },
];

export const DEFAULT_STATUS_GROUP: InboxStatusGroup = 'open';

export function statusesForGroup(group: InboxStatusGroup): number[] {
  const def = INBOX_STATUS_GROUPS.find((g) => g.value === group) ?? INBOX_STATUS_GROUPS[0]!;
  return [...def.statuses];
}

export type InboxNatureFilter = 'all' | 'human' | 'agent';
export type InboxDueFilter = 'all' | 'overdue' | 'day' | 'week' | 'none';
export type InboxSort = 'due' | 'priority' | 'recent';

export interface InboxFilters {
  nature: InboxNatureFilter;
  due: InboxDueFilter;
  text: string;
}

export const DEFAULT_FILTERS: InboxFilters = { nature: 'all', due: 'all', text: '' };
export const DEFAULT_SORT: InboxSort = 'due';

export const NATURE_OPTIONS: readonly { value: InboxNatureFilter; label: string }[] = [
  { value: 'all', label: 'Toutes' },
  { value: 'human', label: 'Tâches humaines' },
  { value: 'agent', label: 'Validations d’agent' },
];

export const DUE_OPTIONS: readonly { value: InboxDueFilter; label: string }[] = [
  { value: 'all', label: 'Toutes' },
  { value: 'overdue', label: 'En retard' },
  { value: 'day', label: 'Dans les 24 h' },
  { value: 'week', label: 'Cette semaine' },
  { value: 'none', label: 'Sans échéance' },
];

export const SORT_OPTIONS: readonly { value: InboxSort; label: string }[] = [
  { value: 'due', label: 'Échéance (retards d’abord)' },
  { value: 'priority', label: 'Priorité' },
  { value: 'recent', label: 'Plus récentes d’abord' },
];

/** Vrai si les filtres (hors statut) diffèrent des valeurs par défaut : affiche « Réinitialiser ». */
export function filtersAreDefault(filters: InboxFilters): boolean {
  return (
    filters.nature === DEFAULT_FILTERS.nature &&
    filters.due === DEFAULT_FILTERS.due &&
    normalizeText(filters.text) === ''
  );
}

/** Minuscules, sans accents, espaces compressés : « Échéance  » et « echeance » se correspondent. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Échéance effective de l'élément : celle de l'élément de boîte, à défaut celle de la tâche. */
export function entryDueAt(entry: WfInboxEntry): string | null {
  return entry.item.dueAt ?? entry.task.dueAt ?? null;
}

function dueTime(entry: WfInboxEntry): number | null {
  const iso = entryDueAt(entry);
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Un élément est ouvert s'il reste à traiter (0) ou s'il est pris en charge (1). */
export function isOpenEntry(entry: WfInboxEntry): boolean {
  return OPEN_STATUSES.includes(entry.item.status);
}

/** En retard = échéance dépassée ET élément encore ouvert ou pris (un élément clos n'est jamais « en retard »). */
export function isOverdue(entry: WfInboxEntry, now: Date): boolean {
  if (!isOpenEntry(entry)) return false;
  const t = dueTime(entry);
  return t !== null && t < now.getTime();
}

function matchesDue(entry: WfInboxEntry, filter: InboxDueFilter, now: Date): boolean {
  if (filter === 'all') return true;
  const t = dueTime(entry);
  if (filter === 'none') return t === null;
  if (t === null) return false;
  if (filter === 'overdue') return isOverdue(entry, now);
  // « Dans les 24 h » et « cette semaine » : échéances à venir (les retards ont leur propre filtre).
  const left = t - now.getTime();
  if (left < 0) return false;
  return filter === 'day' ? left <= DAY : left <= 7 * DAY;
}

function matchesNature(entry: WfInboxEntry, filter: InboxNatureFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'agent' ? entry.item.kind === 1 : entry.item.kind === 0;
}

/** Texte de recherche : titre, workflow et étape. Tous les mots saisis doivent être trouvés. */
function matchesText(entry: WfInboxEntry, text: string): boolean {
  const q = normalizeText(text);
  if (q === '') return true;
  const haystack = normalizeText(`${entry.item.title} ${entry.definitionName} ${entry.task.stepKey}`);
  return q.split(' ').every((word) => haystack.includes(word));
}

export function filterEntries(entries: readonly WfInboxEntry[], filters: InboxFilters, now: Date): WfInboxEntry[] {
  return entries.filter(
    (e) => matchesNature(e, filters.nature) && matchesDue(e, filters.due, now) && matchesText(e, filters.text),
  );
}

function createdTime(entry: WfInboxEntry): number {
  const t = new Date(entry.item.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Tri stable, sans modifier le tableau reçu.
 * - `due` : retards d'abord (le plus ancien en premier), puis échéances à venir croissantes, puis sans échéance ;
 *   à égalité, priorité décroissante puis plus récent.
 * - `priority` : priorité décroissante, puis échéance (sans échéance en dernier).
 * - `recent` : date de création décroissante.
 */
export function sortEntries(entries: readonly WfInboxEntry[], sort: InboxSort, now: Date): WfInboxEntry[] {
  const dueRank = (e: WfInboxEntry): number => (isOverdue(e, now) ? 0 : dueTime(e) === null ? 2 : 1);
  const byDue = (a: WfInboxEntry, b: WfInboxEntry): number => {
    const ra = dueRank(a);
    const rb = dueRank(b);
    if (ra !== rb) return ra - rb;
    const ta = dueTime(a);
    const tb = dueTime(b);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    return 0;
  };
  const byPriority = (a: WfInboxEntry, b: WfInboxEntry): number => b.item.priority - a.item.priority;
  const byRecent = (a: WfInboxEntry, b: WfInboxEntry): number => createdTime(b) - createdTime(a);

  const compare = (a: WfInboxEntry, b: WfInboxEntry): number => {
    if (sort === 'priority') return byPriority(a, b) || byDue(a, b) || byRecent(a, b);
    if (sort === 'recent') return byRecent(a, b);
    return byDue(a, b) || byPriority(a, b) || byRecent(a, b);
  };
  // Array.prototype.sort est stable (ES2019) : l'ordre reçu départage les égalités restantes.
  return [...entries].sort(compare);
}

export interface InboxCountSummary {
  total: number;
  overdue: number;
  /** Texte lisible : « 12 éléments, dont 3 en retard ». */
  text: string;
}

export function countSummary(entries: readonly WfInboxEntry[], now: Date): InboxCountSummary {
  const total = entries.length;
  const overdue = entries.filter((e) => isOverdue(e, now)).length;
  if (total === 0) return { total, overdue, text: 'Aucun élément' };
  const base = `${total} ${total > 1 ? 'éléments' : 'élément'}`;
  return { total, overdue, text: overdue > 0 ? `${base}, dont ${overdue} en retard` : base };
}

/** Ajoute `incoming` à `existing` sans doublon (clé : identifiant d'élément de boîte). */
export function mergeEntries(existing: readonly WfInboxEntry[], incoming: readonly WfInboxEntry[]): WfInboxEntry[] {
  const seen = new Set(existing.map((e) => e.item.wfInboxItemId));
  const merged = [...existing];
  for (const e of incoming) {
    if (seen.has(e.item.wfInboxItemId)) continue;
    seen.add(e.item.wfInboxItemId);
    merged.push(e);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Droits d'action
// ---------------------------------------------------------------------------

export interface InboxActions {
  claim: boolean;
  complete: boolean;
  reject: boolean;
  delegate: boolean;
}

const NO_ACTION: InboxActions = { claim: false, complete: false, reject: false, delegate: false };

/**
 * Actions proposées pour un élément : prise en charge seulement à l'état 0 ; clôture, refus et délégation
 * aux états 0 et 1 (l'API accepte la clôture sans prise préalable). Rien si l'élément est clos, ni si
 * l'instance est suspendue ou terminale (le moteur refuse alors toute action : INVALID_STATE).
 */
export function allowedActions(entry: WfInboxEntry): InboxActions {
  if (FROZEN_INSTANCE_STATUSES.includes(entry.instanceStatus)) return NO_ACTION;
  const status = entry.item.status;
  if (!OPEN_STATUSES.includes(status)) return NO_ACTION;
  return { claim: status === 0, complete: true, reject: true, delegate: true };
}

/** Pourquoi aucune action n'est proposée (phrase d'aide) ; null si au moins une action existe. */
export function noActionReason(entry: WfInboxEntry): string | null {
  const a = allowedActions(entry);
  if (a.claim || a.complete || a.reject || a.delegate) return null;
  if (entry.instanceStatus === 5) return 'Le workflow est suspendu : aucune action n’est possible tant qu’il n’est pas repris.';
  if (FROZEN_INSTANCE_STATUSES.includes(entry.instanceStatus)) return 'Le workflow est terminé : aucune action n’est possible.';
  return 'Cet élément est déjà clos : aucune action n’est possible.';
}

/** Nom accessible complet d'une carte (lu par les lecteurs d'écran à la place du contenu éclaté en pastilles). */
export function entryAriaLabel(entry: WfInboxEntry, now: Date): string {
  const parts = [
    entry.item.title,
    `Workflow ${entry.definitionName}`,
    `étape ${entry.task.stepKey}`,
    entry.item.kind === 1 ? 'Validation d’agent' : 'Tâche humaine',
    inboxStatusLabel(entry.item.status),
    `Priorité ${priorityLabel(entry.item.priority).toLowerCase()}`,
  ];
  const due = entryDueAt(entry);
  if (isOpenEntry(entry)) parts.push(dueInfo(due, now).label);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Lecture de la configuration d'étape (champs « fields », « items », « choices »)
// ---------------------------------------------------------------------------

export interface ConfigField {
  key: string;
  label: string;
  required: boolean;
}

export interface ConfigChoice {
  value: string;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Lit une liste `[{key,label?,required?}]` ou `['cle']` ; ignore les entrées invalides et les clés en double. */
function readKeyedList(config: unknown, name: 'fields' | 'items'): ConfigField[] {
  if (!isRecord(config)) return [];
  const raw = config[name];
  if (!Array.isArray(raw)) return [];
  const out: ConfigField[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let field: ConfigField | null = null;
    const asKey = str(entry);
    if (asKey) field = { key: asKey, label: asKey, required: false };
    else if (isRecord(entry)) {
      const key = str(entry.key);
      if (key) field = { key, label: str(entry.label) ?? key, required: entry.required === true };
    }
    if (field && !seen.has(field.key)) {
      seen.add(field.key);
      out.push(field);
    }
  }
  return out;
}

export const readFields = (config: unknown): ConfigField[] => readKeyedList(config, 'fields');
export const readChecklistItems = (config: unknown): ConfigField[] => readKeyedList(config, 'items');

/** Choix d'une décision manuelle : chaînes, ou objets `{value|key, label?}`. */
export function readChoices(config: unknown): ConfigChoice[] {
  if (!isRecord(config) || !Array.isArray(config.choices)) return [];
  const out: ConfigChoice[] = [];
  const seen = new Set<string>();
  for (const entry of config.choices) {
    let choice: ConfigChoice | null = null;
    const asValue = str(entry);
    if (asValue) choice = { value: asValue, label: asValue };
    else if (isRecord(entry)) {
      const value = str(entry.value) ?? str(entry.key);
      if (value) choice = { value, label: str(entry.label) ?? value };
    }
    if (choice && !seen.has(choice.value)) {
      seen.add(choice.value);
      out.push(choice);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Construction des résultats de clôture
// ---------------------------------------------------------------------------

export type BuildResult<T = Record<string, unknown>> = { ok: true; result: T } | { ok: false; errors: string[] };

const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

/** Taille JSON en octets UTF-8 (le moteur refuse au-delà de 64 Kio). */
function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function checkSize<T extends Record<string, unknown>>(result: T): BuildResult<T> {
  return jsonBytes(result) > RESULT_MAX_BYTES
    ? fail('Le résultat est trop volumineux (65 536 octets au plus). Raccourcissez la saisie.')
    : { ok: true, result };
}

const isBlank = (v: string | undefined | null): boolean => v === undefined || v === null || v.trim() === '';

/** Formulaire avec champs déclarés : `{ values }`. Champs requis bloquants ; champs facultatifs vides omis. */
export function buildFormResult(fields: readonly ConfigField[], values: Record<string, string>): BuildResult {
  const errors: string[] = [];
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (isBlank(v)) {
      if (f.required) errors.push(`Le champ « ${f.label} » est obligatoire.`);
      continue;
    }
    out[f.key] = v!.trim();
  }
  return errors.length > 0 ? { ok: false, errors } : checkSize({ values: out });
}

/** Formulaire sans champs déclarés : lignes clé/valeur libres. Clés non vides et uniques. */
export function buildFreeFormResult(rows: readonly { key: string; value: string }[]): BuildResult {
  const errors: string[] = [];
  const out: Record<string, string> = {};
  rows.forEach((row, i) => {
    const key = row.key.trim();
    if (key === '' && row.value.trim() === '') return; // ligne vide ignorée
    if (key === '') {
      errors.push(`Ligne ${i + 1} : indiquez le nom du champ.`);
      return;
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      errors.push(`Ligne ${i + 1} : ce nom de champ n’est pas autorisé.`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      errors.push(`Le champ « ${key} » est saisi plusieurs fois.`);
      return;
    }
    out[key] = row.value.trim();
  });
  return errors.length > 0 ? { ok: false, errors } : checkSize({ values: out });
}

/** Checklist : `{ checked }` sans doublon ; avec éléments déclarés, aucune clé inconnue et tous les requis cochés. */
export function buildChecklistResult(items: readonly ConfigField[], checked: readonly string[]): BuildResult {
  const errors: string[] = [];
  const keys = checked.map((k) => k.trim()).filter((k) => k !== '');
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicates.length > 0) {
    errors.push(`Élément coché plusieurs fois : « ${[...new Set(duplicates)].join(' », « ')} ».`);
  }
  if (items.length > 0) {
    const known = new Set(items.map((i) => i.key));
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length > 0) errors.push(`Élément inconnu : « ${[...new Set(unknown)].join(' », « ')} ».`);
    for (const item of items) {
      if (item.required && !keys.includes(item.key)) errors.push(`L’élément « ${item.label} » doit être coché.`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : checkSize({ checked: keys });
}

/** Génération : `{ content, documentId? }`. `documentId` facultatif : entier strictement positif. */
export function buildGenerationResult(content: string, documentIdText: string): BuildResult {
  const errors: string[] = [];
  if (content.trim() === '') errors.push('Le contenu rédigé ne peut pas être vide.');
  let documentId: number | undefined;
  const idText = documentIdText.trim();
  if (idText !== '') {
    const n = /^\d+$/.test(idText) ? Number(idText) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0) errors.push('Le numéro de document doit être un entier supérieur à 0.');
    else documentId = n;
  }
  if (errors.length > 0) return { ok: false, errors };
  return checkSize(documentId === undefined ? { content } : { content, documentId });
}

export interface AssignmentInput {
  userGroupId?: string | number | null;
  groupId?: string | number | null;
  roleId?: string | number | null;
}

/** Affectation : exactement UN identifiant entier > 0 parmi utilisateur, groupe, rôle. */
export function buildAssignmentResult(input: AssignmentInput): BuildResult {
  const entries = (['userGroupId', 'groupId', 'roleId'] as const)
    .map((k) => [k, input[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  if (entries.length === 0) return fail('Indiquez un utilisateur, un groupe ou un rôle.');
  if (entries.length > 1) return fail('Indiquez un seul bénéficiaire : utilisateur, groupe ou rôle (pas plusieurs).');
  const [key, raw] = entries[0]!;
  const text = String(raw).trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return fail('L’identifiant doit être un entier supérieur à 0.');
  return checkSize({ assignee: { [key]: n } });
}

/** Valide un commentaire facultatif : retourne le texte nettoyé (ou undefined) ou une erreur. */
export function parseComment(comment: string | undefined | null): { ok: true; value: string | undefined } | { ok: false; error: string } {
  const text = (comment ?? '').trim();
  if (text.length > COMMENT_MAX) return { ok: false, error: `Le commentaire est limité à ${COMMENT_MAX} caractères (${text.length} saisis).` };
  return { ok: true, value: text === '' ? undefined : text };
}

/** Validation : `{ approved, comment? }`. Le choix est obligatoire (aucune valeur par défaut). */
export function buildApprovalResult(approved: boolean | null | undefined, comment: string): BuildResult {
  const errors: string[] = [];
  if (typeof approved !== 'boolean') errors.push('Choisissez « Approuver » ou « Ne pas approuver ».');
  const c = parseComment(comment);
  if (!c.ok) errors.push(c.error);
  if (errors.length > 0 || !c.ok) return { ok: false, errors };
  return checkSize(c.value === undefined ? { approved: approved as boolean } : { approved: approved as boolean, comment: c.value });
}

/** Décision manuelle : `{ choice }`, parmi `choices` si déclarés, sinon texte libre non vide. */
export function buildDecisionResult(choices: readonly ConfigChoice[], choice: string | null | undefined): BuildResult {
  const value = (choice ?? '').trim();
  if (value === '') return fail('Choisissez une décision.');
  if (choices.length > 0 && !choices.some((c) => c.value === value)) {
    return fail('Cette décision ne fait pas partie des choix proposés.');
  }
  return checkSize({ choice: value });
}

export type ParsedJson = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Analyse un texte JSON qui doit être un OBJET (ni tableau, ni nombre, ni null). */
export function parseJsonObject(text: string): ParsedJson {
  if (text.trim() === '') return { ok: false, error: 'Saisissez un objet JSON (par exemple {"cle": "valeur"}).' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Le JSON saisi est invalide : vérifiez les guillemets, virgules et accolades.' };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'Le JSON doit être un objet entre accolades, pas un tableau ni une valeur simple.' };
  return { ok: true, value: parsed };
}

/** Étape « agent » : le résultat est l'objet JSON saisi. */
export function buildAgentResult(text: string): BuildResult {
  const parsed = parseJsonObject(text);
  return parsed.ok ? checkSize(parsed.value) : fail(parsed.error);
}

// ---------------------------------------------------------------------------
// Délégation et refus
// ---------------------------------------------------------------------------

export type DelegateParse =
  | { ok: true; toUserGroupId: number; comment: string | undefined }
  | { ok: false; errors: string[] };

/** Délégation : identifiant entier > 0, différent du vôtre ; commentaire facultatif <= 4000. */
export function parseDelegateInput(userText: string, comment: string, selfUserGroupId: number | null): DelegateParse {
  const errors: string[] = [];
  const text = userText.trim();
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  let id = 0;
  if (text === '') errors.push('Saisissez le numéro d’utilisateur du destinataire.');
  else if (!Number.isSafeInteger(n) || n <= 0) errors.push('Le numéro d’utilisateur doit être un entier supérieur à 0.');
  else if (selfUserGroupId !== null && n === selfUserGroupId) errors.push('Vous ne pouvez pas vous déléguer la tâche à vous-même.');
  else id = n;
  const c = parseComment(comment);
  if (!c.ok) errors.push(c.error);
  if (errors.length > 0 || !c.ok) return { ok: false, errors };
  return { ok: true, toUserGroupId: id, comment: c.value };
}

// ---------------------------------------------------------------------------
// Proposition d'agent (kind 1)
// ---------------------------------------------------------------------------

/** Objet de la proposition (pour « Accepter telle quelle ») ; null si la proposition n'est pas un objet JSON. */
export function proposalAsResult(entry: WfInboxEntry): Record<string, unknown> | null {
  if (entry.item.kind !== 1) return null;
  return isRecord(entry.item.proposal) ? entry.item.proposal : null;
}

/** Texte de la proposition : `content` d'un objet, ou chaîne ; null sinon (alors affichée en JSON). */
export function proposalText(proposal: unknown): string | null {
  if (typeof proposal === 'string') return str(proposal) ? proposal : null;
  if (isRecord(proposal) && typeof proposal.content === 'string' && proposal.content.trim() !== '') return proposal.content;
  return null;
}

/** Texte initial d'une génération : proposition d'agent, à défaut suggestion rangée dans `task.input.suggestion`. */
export function initialGenerationContent(entry: WfInboxEntry, taskInput: unknown): string {
  const fromProposal = entry.item.kind === 1 ? proposalText(entry.item.proposal) : null;
  if (fromProposal) return fromProposal;
  if (isRecord(taskInput)) {
    const s = taskInput.suggestion;
    if (typeof s === 'string') return s;
    if (isRecord(s) && typeof s.content === 'string') return s.content;
  }
  return '';
}

const SOURCES_MAX = 50;
const SOURCE_TEXT_MAX = 300;

function clip(text: string): string {
  return text.length > SOURCE_TEXT_MAX ? `${text.slice(0, SOURCE_TEXT_MAX - 1)}…` : text;
}

/**
 * Sources d'une proposition → lignes de TEXTE (jamais de lien). Accepte des chaînes ou des objets
 * `{label|title|name|documentId}` ; toute autre valeur est ignorée. Plafonné à 50 lignes.
 */
export function describeSources(sources: unknown): string[] {
  const list = Array.isArray(sources) ? sources : typeof sources === 'string' ? [sources] : [];
  const out: string[] = [];
  for (const s of list) {
    let line: string | null = null;
    if (typeof s === 'string') line = str(s);
    else if (isRecord(s)) {
      line = str(s.label) ?? str(s.title) ?? str(s.name);
      if (!line && typeof s.documentId === 'number' && Number.isSafeInteger(s.documentId)) line = `Document n° ${s.documentId}`;
      else if (!line && typeof s.documentId === 'string' && /^\d+$/.test(s.documentId)) line = `Document n° ${s.documentId}`;
    }
    if (line) out.push(clip(line));
    if (out.length >= SOURCES_MAX) break;
  }
  return out;
}

/** JSON indenté d'une valeur quelconque (repli d'affichage) ; chaîne vide si non sérialisable ou absente. */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}
