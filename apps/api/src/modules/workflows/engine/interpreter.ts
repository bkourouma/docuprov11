import { z } from 'zod';
import {
  WfTaskPriority,
  wfTaskTypeFromKey,
  type WfEdge,
  type WfStep,
  type WfTaskType,
  type WfTaskTypeKey,
} from '@archivage/types';
import type { WfAssigneeRef, WfPrincipal } from './engine.types';

// Docu-Flow — interprète PUR du graphe (lot W1). Aucune dépendance Prisma / Nest, aucune E/S :
// lecture de chemin pointé, conditions d'arête, choix de l'arête sortante, construction d'une tâche,
// validation du résultat par type de tâche, droit d'agir, garde-fous et calcul du contexte.
// Toute décision d'écriture est prise par `engine.ts` à partir de ces fonctions, SOUS verrou.

// ---------------------------------------------------------------------------
// Garde-fous et bornes
// ---------------------------------------------------------------------------

/** Enchaînements automatiques (décisions automatiques) au plus, dans une même transition. */
export const WF_AUTO_CHAIN_LIMIT = 50;
/** Passages au plus sur une même étape (boucle de correction), sauf `config.maxAttempts`. */
export const WF_DEFAULT_MAX_ATTEMPTS = 25;
/** Plafond absolu de `config.maxAttempts`. */
export const WF_MAX_ATTEMPTS_CEILING = 100;
/** Consigne journalisée (`wf_event_log.instruction`) : longueur maximale. */
export const WF_LOG_INSTRUCTION_MAX = 2000;
/** Décision journalisée (`wf_event_log.decision`) : taille JSON maximale (octets UTF-8). */
export const WF_LOG_DECISION_MAX_BYTES = 8192;
/** Résultat de tâche accepté : taille JSON maximale (octets UTF-8). */
export const WF_RESULT_MAX_BYTES = 65536;
/** Données d'entrée d'une instance (`context.input`) : taille JSON maximale (octets UTF-8). */
export const WF_CONTEXT_INPUT_MAX_BYTES = 262144;
/** Résumé d'un élément de boîte (`summary`) : longueur maximale. */
export const WF_INBOX_SUMMARY_MAX = 500;
/** Titre d'une tâche / d'un élément de boîte (`VARCHAR(300)`). */
export const WF_TITLE_MAX = 300;
/** Commentaire libre (refus, délégation). */
export const WF_COMMENT_MAX = 4000;

// ---------------------------------------------------------------------------
// Contexte d'instance
// ---------------------------------------------------------------------------

/** `wf_instance.context` : `{ input, steps, last, assignedTo? }`. */
export interface WfInstanceContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  last: unknown;
  assignedTo?: WfAssigneeRef;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Contexte bien formé à partir de la colonne JSON (tolère une ligne ancienne ou partielle). */
export function normalizeContext(raw: unknown): WfInstanceContext {
  const obj = isPlainObject(raw) ? raw : {};
  const ctx: WfInstanceContext = {
    input: isPlainObject(obj.input) ? obj.input : {},
    steps: isPlainObject(obj.steps) ? obj.steps : {},
    last: obj.last === undefined ? null : obj.last,
  };
  const assigned = normalizeAssignee(obj.assignedTo);
  if (assigned) ctx.assignedTo = assigned;
  return ctx;
}

/** Contexte initial d'une instance. */
export function initialContext(input: Record<string, unknown> | undefined): WfInstanceContext {
  return { input: input ?? {}, steps: {}, last: null };
}

/**
 * Contexte après la clôture d'une étape : `steps[stepKey] = result` ; `last = result` sauf si
 * `setLast` est faux (décision AUTOMATIQUE : simple aiguillage, elle n'écrase pas le dernier résultat
 * humain que les conditions suivantes peuvent encore lire) ; `assignedTo` remplacé si fourni.
 * Ne modifie jamais l'objet reçu.
 */
export function applyStepResult(
  context: WfInstanceContext,
  stepKey: string,
  result: unknown,
  opts: { setLast?: boolean; assignedTo?: WfAssigneeRef } = {},
): WfInstanceContext {
  const next: WfInstanceContext = {
    input: context.input,
    steps: { ...context.steps, [stepKey]: result },
    last: opts.setLast === false ? context.last : result,
  };
  const assigned = opts.assignedTo ?? context.assignedTo;
  if (assigned) next.assignedTo = assigned;
  return next;
}

// ---------------------------------------------------------------------------
// Chemin pointé et conditions
// ---------------------------------------------------------------------------

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Lit `a.b.0.c` dans un objet JSON. Propriétés PROPRES seulement (jamais le prototype) ; un segment
 * numérique indexe un tableau. Chemin absent, vide ou invalide => `undefined`.
 */
export function readPath(source: unknown, path: string): unknown {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (segment.length === 0 || FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
      continue;
    }
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const NUMERIC_STRING = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Nombre fini, ou chaîne numérique (« 12 », « 3.5 ») ; tout le reste (booléen, null, « abc ») => undefined. */
export function toComparableNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!NUMERIC_STRING.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** JSON canonique (clés triées) : égalité structurelle et empreinte stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Égalité des conditions : STRICTE (`===`, sans conversion) sauf si l'un des deux côtés est un nombre :
 * comparaison numérique, l'autre côté pouvant être une chaîne numérique (« 10 » = 10). Objets et tableaux :
 * égalité structurelle.
 */
export function conditionValuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toComparableNumber(a);
    const nb = toComparableNumber(b);
    return na !== undefined && nb !== undefined && na === nb;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return canonicalJson(a) === canonicalJson(b);
  }
  return a === b;
}

export interface WfCondition {
  field: string;
  op: string;
  value?: unknown;
}

/**
 * Évalue une condition d'arête sur le contexte.
 *  - `exists` : vrai si la valeur est définie et non nulle (`value` ignorée) ;
 *  - chemin ABSENT : faux pour tous les autres opérateurs, y compris `neq` (prudence : on ne suit pas
 *    une branche sur une donnée qui n'existe pas) ;
 *  - `gt`/`gte`/`lt`/`lte` : numériques seulement (nombre ou chaîne numérique des deux côtés), sinon faux ;
 *  - `in` : `value` doit être un tableau, sinon faux ;
 *  - opérateur inconnu : faux.
 */
export function evaluateCondition(condition: WfCondition, context: unknown): boolean {
  const actual = readPath(context, condition.field);
  if (condition.op === 'exists') return actual !== undefined && actual !== null;
  if (actual === undefined) return false;
  switch (condition.op) {
    case 'eq':
      return conditionValuesEqual(actual, condition.value);
    case 'neq':
      return !conditionValuesEqual(actual, condition.value);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparableNumber(actual);
      const b = toComparableNumber(condition.value);
      if (a === undefined || b === undefined) return false;
      if (condition.op === 'gt') return a > b;
      if (condition.op === 'gte') return a >= b;
      if (condition.op === 'lt') return a < b;
      return a <= b;
    }
    case 'in':
      return Array.isArray(condition.value) && condition.value.some((v) => conditionValuesEqual(actual, v));
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Choix de l'arête sortante
// ---------------------------------------------------------------------------

export type WfEdgeChoice =
  /** Aucune arête déclarée : étape finale. */
  | { kind: 'terminal' }
  | { kind: 'edge'; edge: WfEdge; index: number; matchedCondition: boolean }
  /** Aucune arête applicable (erreur de routage ; en mode « rejeté » : suspension). */
  | { kind: 'none'; reason: string };

export type WfEdgeMode = 'normal' | 'rejected';

/** Arête de repli : sans condition, ou marquée `isDefault` (même si elle porte une condition). */
export function isFallbackEdge(edge: WfEdge): boolean {
  return edge.condition === undefined || edge.isDefault === true;
}

/**
 * Arêtes conditionnées dans l'ordre de déclaration : la première vraie gagne ; sinon la PREMIÈRE arête
 * de repli ; sinon aucune. En mode `rejected`, seules les arêtes conditionnées comptent (jamais le
 * repli) et une étape sans arête n'est pas « terminée » : le refus n'aboutit jamais à une fin réussie.
 */
export function chooseNextEdge(step: WfStep, context: unknown, mode: WfEdgeMode = 'normal'): WfEdgeChoice {
  const edges = step.next ?? [];
  if (edges.length === 0) {
    return mode === 'normal'
      ? { kind: 'terminal' }
      : { kind: 'none', reason: `Refus sur l'étape « ${step.name} » : aucune voie de correction n'est prévue.` };
  }
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i] as WfEdge;
    if (isFallbackEdge(edge) || edge.condition === undefined) continue;
    if (evaluateCondition(edge.condition, context)) return { kind: 'edge', edge, index: i, matchedCondition: true };
  }
  if (mode === 'rejected') {
    return {
      kind: 'none',
      reason: `Refus sur l'étape « ${step.name} » : aucune voie de correction ne correspond.`,
    };
  }
  const fallbackIndex = edges.findIndex(isFallbackEdge);
  if (fallbackIndex >= 0) {
    return { kind: 'edge', edge: edges[fallbackIndex] as WfEdge, index: fallbackIndex, matchedCondition: false };
  }
  return {
    kind: 'none',
    reason: `Erreur de routage : aucune étape suivante ne correspond depuis l'étape « ${step.name} ».`,
  };
}

// ---------------------------------------------------------------------------
// Types d'étape
// ---------------------------------------------------------------------------

export function stepTaskType(step: WfStep): WfTaskType {
  return wfTaskTypeFromKey(step.type);
}

/** Décision AUTOMATIQUE (défaut) : évaluée par le moteur ; `config.manual === true` => tâche humaine. */
export function isAutomaticDecision(step: WfStep): boolean {
  return step.type === 'decision' && step.config?.manual !== true;
}

/** Étape traitée par un humain (tous les types sauf agent et décision automatique). */
export function isHumanStep(step: WfStep): boolean {
  return step.type !== 'agent' && !isAutomaticDecision(step);
}

export function findStep(steps: readonly WfStep[], key: string): WfStep | undefined {
  return steps.find((s) => s.key === key);
}

/** Plafond de passages sur l'étape : `config.maxAttempts` entier borné à [1, 100], sinon 25. */
export function resolveMaxAttempts(step: WfStep): number {
  const raw = step.config?.maxAttempts;
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return Math.min(Math.max(raw, 1), WF_MAX_ATTEMPTS_CEILING);
  }
  return WF_DEFAULT_MAX_ATTEMPTS;
}

/** Le passage n° `attempt` (1 = premier) est-il permis ? */
export function isAttemptAllowed(step: WfStep, attempt: number): boolean {
  return attempt >= 1 && attempt <= resolveMaxAttempts(step);
}

export function attemptLimitMessage(step: WfStep): string {
  return `Boucle de correction dépassée sur l'étape « ${step.name} » (au plus ${resolveMaxAttempts(step)} passages).`;
}

export function autoChainLimitMessage(): string {
  return `Enchaînement automatique dépassé (plus de ${WF_AUTO_CHAIN_LIMIT} étapes sans intervention humaine) : boucle probable dans le graphe.`;
}

// ---------------------------------------------------------------------------
// Construction d'une tâche
// ---------------------------------------------------------------------------

export type WfAssigneeSource =
  | 'step_user'
  | 'step_group'
  | 'step_role'
  | 'initiator'
  | 'subject_owner'
  /** `subject_owner` demandé mais introuvable : repli sur le lanceur. */
  | 'subject_owner_fallback'
  /** Affectation décidée par une étape « affectation » antérieure (`context.assignedTo`). */
  | 'context'
  /** Étape sans affectation propre et contexte sans affectation : le lanceur. */
  | 'default_initiator';

export interface WfResolvedAssignee {
  userGroupId: number | null;
  groupId: number | null;
  roleId: number | null;
}

export interface WfTaskSpecInput {
  step: WfStep;
  context: WfInstanceContext;
  /** Lanceur (`started_by`). */
  startedBy: number;
  attempt: number;
  now: Date;
  /** Propriétaire de l'objet lié, déjà résolu par l'annuaire (null / absent : inconnu). */
  subjectOwner?: number | null;
}

export interface WfTaskSpec {
  taskType: WfTaskType;
  typeKey: WfTaskTypeKey;
  title: string;
  instructions: string | null;
  priority: WfTaskPriority;
  assignee: WfResolvedAssignee;
  assigneeSource: WfAssigneeSource;
  dueAt: Date | null;
  reminderAt: Date | null;
  isHuman: boolean;
}

const HOUR_MS = 3_600_000;

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** `config.priority` : 0/1/2 ou « basse » / « normale » / « haute » ; sinon normale. */
export function resolvePriority(step: WfStep): WfTaskPriority {
  const raw = step.config?.priority;
  if (raw === 0 || raw === 'basse' || raw === 'low') return WfTaskPriority.Low;
  if (raw === 2 || raw === 'haute' || raw === 'high') return WfTaskPriority.High;
  return WfTaskPriority.Normal;
}

function assigneeOf(ref: WfAssigneeRef): WfResolvedAssignee {
  return { userGroupId: ref.userGroupId ?? null, groupId: ref.groupId ?? null, roleId: ref.roleId ?? null };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Bénéficiaire bien formé : EXACTEMENT un identifiant entier positif ; sinon null. */
export function normalizeAssignee(raw: unknown): WfAssigneeRef | null {
  if (!isPlainObject(raw)) return null;
  const set = (['userGroupId', 'groupId', 'roleId'] as const).filter((k) => raw[k] !== undefined && raw[k] !== null);
  if (set.length !== 1) return null;
  const key = set[0] as 'userGroupId' | 'groupId' | 'roleId';
  return isPositiveInt(raw[key]) ? { [key]: raw[key] } : null;
}

/**
 * Bénéficiaire d'une tâche humaine — JAMAIS vide :
 * `step.assignee` (user / group / role / initiator / subject_owner, repli lanceur) ; sinon
 * `context.assignedTo` ; sinon le lanceur.
 */
export function resolveAssignee(input: {
  step: WfStep;
  context: WfInstanceContext;
  startedBy: number;
  subjectOwner?: number | null;
}): { assignee: WfResolvedAssignee; source: WfAssigneeSource } {
  const a = input.step.assignee;
  const initiator: WfResolvedAssignee = { userGroupId: input.startedBy, groupId: null, roleId: null };
  if (a) {
    switch (a.kind) {
      case 'user':
        if (isPositiveInt(a.id)) return { assignee: { userGroupId: a.id, groupId: null, roleId: null }, source: 'step_user' };
        break;
      case 'group':
        if (isPositiveInt(a.id)) return { assignee: { userGroupId: null, groupId: a.id, roleId: null }, source: 'step_group' };
        break;
      case 'role':
        if (isPositiveInt(a.id)) return { assignee: { userGroupId: null, groupId: null, roleId: a.id }, source: 'step_role' };
        break;
      case 'initiator':
        return { assignee: initiator, source: 'initiator' };
      case 'subject_owner':
        if (isPositiveInt(input.subjectOwner)) {
          return { assignee: { userGroupId: input.subjectOwner, groupId: null, roleId: null }, source: 'subject_owner' };
        }
        return { assignee: initiator, source: 'subject_owner_fallback' };
    }
    // Affectation mal formée (graphe publié non conforme) : le lanceur, jamais personne.
    return { assignee: initiator, source: 'default_initiator' };
  }
  const fromContext = normalizeAssignee(input.context.assignedTo);
  if (fromContext) return { assignee: assigneeOf(fromContext), source: 'context' };
  return { assignee: initiator, source: 'default_initiator' };
}

/** Tâche à créer à l'entrée d'une étape (type, titre, consigne, priorité, bénéficiaire, échéance, relance). */
export function buildTaskSpec(input: WfTaskSpecInput): WfTaskSpec {
  const { step, now, attempt } = input;
  const baseTitle = attempt > 1 ? `${step.name} (passage ${attempt})` : step.name;
  const { assignee, source } = resolveAssignee(input);
  const description = step.description?.trim();
  return {
    taskType: stepTaskType(step),
    typeKey: step.type,
    title: truncateText(baseTitle, WF_TITLE_MAX),
    instructions: description ? description : null,
    priority: resolvePriority(step),
    assignee,
    assigneeSource: source,
    dueAt: isPositiveInt(step.dueInHours) ? new Date(now.getTime() + step.dueInHours * HOUR_MS) : null,
    reminderAt: isPositiveInt(step.reminderAfterHours)
      ? new Date(now.getTime() + step.reminderAfterHours * HOUR_MS)
      : null,
    isHuman: isHumanStep(step),
  };
}

/** Texte français expliquant pourquoi l'élément est dans la boîte. */
export function buildInboxExplanation(stepName: string, workflowName: string, launcherLabel: string): string {
  return `Étape “${stepName}” du workflow “${workflowName}” (lancé par ${launcherLabel}).`;
}

/** Phrase expliquant un bénéficiaire de repli (journal), ou null si l'affectation est nominale. */
export function assigneeSourceNote(source: WfAssigneeSource): string | null {
  if (source === 'subject_owner_fallback') {
    return "Propriétaire de l'objet lié introuvable : tâche confiée au lanceur.";
  }
  if (source === 'default_initiator') return "Aucune affectation prévue : tâche confiée au lanceur.";
  if (source === 'context') return "Tâche confiée au bénéficiaire désigné par une étape d'affectation.";
  return null;
}

// ---------------------------------------------------------------------------
// Validation du résultat par type de tâche
// ---------------------------------------------------------------------------

export type WfResultValidation = { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] };

const positiveInt = z.number().int().positive();

const formResultSchema = z.object({ values: z.record(z.unknown()) }).strict();
const generationResultSchema = z
  .object({ content: z.string().refine((s) => s.trim().length > 0, 'le contenu est vide'), documentId: positiveInt.optional() })
  .strict();
const checklistResultSchema = z.object({ checked: z.array(z.string().min(1).max(200)) }).strict();
const assignmentResultSchema = z
  .object({
    assignee: z.union([
      z.object({ userGroupId: positiveInt }).strict(),
      z.object({ groupId: positiveInt }).strict(),
      z.object({ roleId: positiveInt }).strict(),
    ]),
  })
  .strict();
const approvalResultSchema = z.object({ approved: z.boolean(), comment: z.string().max(WF_COMMENT_MAX).optional() }).strict();
const decisionResultSchema = z.object({ choice: z.string().trim().min(1).max(200) }).strict();
const agentResultSchema = z.record(z.unknown());

interface KeyedItem {
  key: string;
  required: boolean;
}

/** `config.fields` / `config.items` : `[{ key, required? }]` ou `['cle', …]` ; entrées invalides ignorées. */
export function readKeyedConfig(raw: unknown): KeyedItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: KeyedItem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) out.push({ key: entry, required: false });
    else if (isPlainObject(entry) && typeof entry.key === 'string' && entry.key.length > 0) {
      out.push({ key: entry.key, required: entry.required === true });
    }
  }
  return out;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? `${i.path.join('.')} : ` : ''}${i.message}`);
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Valide le résultat soumis pour une étape (forme stricte : aucune clé inattendue).
 *  - formulaire : `{ values }` ; champs requis de `config.fields` présents et non vides ; si des champs
 *    sont déclarés, aucune clé inconnue ;
 *  - generation : `{ content non vide, documentId? }` ;
 *  - checklist : `{ checked }` ; éléments requis de `config.items` cochés, aucune clé inconnue, sans doublon ;
 *  - affectation : `{ assignee: { userGroupId } | { groupId } | { roleId } }` (un seul) ;
 *  - validation : `{ approved, comment? }` ;
 *  - decision (manuelle) : `{ choice }` ; parmi `config.choices` si déclaré ;
 *  - agent : un objet JSON.
 */
export function validateTaskResult(step: WfStep, result: unknown): WfResultValidation {
  if (!isPlainObject(result)) return { ok: false, issues: ['le résultat doit être un objet'] };
  if (jsonByteLength(result) > WF_RESULT_MAX_BYTES) {
    return { ok: false, issues: [`le résultat dépasse ${WF_RESULT_MAX_BYTES} octets`] };
  }
  switch (step.type) {
    case 'formulaire': {
      const parsed = formResultSchema.safeParse(result);
      if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
      const fields = readKeyedConfig(step.config?.fields);
      const issues: string[] = [];
      if (fields) {
        const known = new Set(fields.map((f) => f.key));
        for (const f of fields) {
          if (f.required && isEmptyValue(parsed.data.values[f.key])) issues.push(`le champ « ${f.key} » est obligatoire`);
        }
        for (const key of Object.keys(parsed.data.values)) {
          if (!known.has(key)) issues.push(`le champ « ${key} » n'est pas prévu par le formulaire`);
        }
      }
      return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
    }
    case 'generation': {
      const parsed = generationResultSchema.safeParse(result);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: zodIssues(parsed.error) };
    }
    case 'checklist': {
      const parsed = checklistResultSchema.safeParse(result);
      if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
      const items = readKeyedConfig(step.config?.items) ?? [];
      const known = new Set(items.map((i) => i.key));
      const checked = new Set(parsed.data.checked);
      const issues: string[] = [];
      if (checked.size !== parsed.data.checked.length) issues.push('un élément est coché plusieurs fois');
      for (const key of checked) if (!known.has(key)) issues.push(`l'élément « ${key} » n'existe pas dans la checklist`);
      for (const item of items) if (item.required && !checked.has(item.key)) issues.push(`l'élément « ${item.key} » doit être coché`);
      return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
    }
    case 'affectation': {
      const parsed = assignmentResultSchema.safeParse(result);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, issues: ['une affectation désigne exactement un utilisateur, un groupe ou un rôle'] };
    }
    case 'validation': {
      const parsed = approvalResultSchema.safeParse(result);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: zodIssues(parsed.error) };
    }
    case 'decision': {
      if (isAutomaticDecision(step)) return { ok: false, issues: ['cette décision est automatique : aucun résultat à saisir'] };
      const parsed = decisionResultSchema.safeParse(result);
      if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
      const choices = step.config?.choices;
      if (Array.isArray(choices) && choices.length > 0 && !choices.includes(parsed.data.choice)) {
        return { ok: false, issues: [`le choix « ${parsed.data.choice} » n'est pas proposé`] };
      }
      return { ok: true, value: parsed.data };
    }
    case 'agent': {
      const parsed = agentResultSchema.safeParse(result);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: zodIssues(parsed.error) };
    }
    default:
      return { ok: false, issues: ["type d'étape inconnu"] };
  }
}

/** Affectation choisie par une étape « affectation » (résultat déjà validé). */
export function assignmentFromResult(result: Record<string, unknown>): WfAssigneeRef | null {
  return normalizeAssignee(result.assignee);
}

/** Résultat d'un refus (`rejectTask`). */
export function buildRejectionResult(comment?: string): Record<string, unknown> {
  const c = comment?.trim();
  return c ? { rejected: true, approved: false, comment: truncateText(c, WF_COMMENT_MAX) } : { rejected: true, approved: false };
}

// ---------------------------------------------------------------------------
// Droit d'agir
// ---------------------------------------------------------------------------

export interface WfTaskAssigneeColumns {
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
}

/**
 * SEULE règle du droit d'agir : l'utilisateur est le bénéficiaire, OU membre du groupe bénéficiaire,
 * OU titulaire du rôle ACTIF bénéficiaire. Tâche sans bénéficiaire : personne. Aucun pouvoir implicite
 * (l'administrateur n'est pas une exception).
 */
export function isTaskAssignee(principal: WfPrincipal, task: WfTaskAssigneeColumns): boolean {
  if (!isPositiveInt(principal.userGroupId)) return false;
  if (task.assigneeUserGroupId !== null && task.assigneeUserGroupId === principal.userGroupId) return true;
  if (task.assigneeGroupId !== null && principal.groupIds.some((g) => isPositiveInt(g) && g === task.assigneeGroupId)) {
    return true;
  }
  if (task.assigneeRoleId !== null && principal.roleId !== null && principal.roleId === task.assigneeRoleId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Journal : valeurs bornées, sans contenu de document
// ---------------------------------------------------------------------------

/**
 * Valeur JSON bornée à `maxBytes` : telle quelle si elle tient, sinon un résumé tronqué
 * `{ truncated: true, bytes, preview }` (jamais d'exception, jamais de valeur non sérialisable).
 */
export function boundJson(value: unknown, maxBytes = WF_LOG_DECISION_MAX_BYTES): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: 'valeur non sérialisable' };
  }
  if (text === undefined) return null;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return JSON.parse(text) as unknown;
  const previewChars = Math.max(0, Math.floor(maxBytes / 4) - 64);
  return { truncated: true, bytes, preview: text.slice(0, previewChars) };
}

/**
 * Résultat résumé pour le journal : identifiants et données structurées seulement. Le contenu rédigé
 * d'une étape « génération » n'est JAMAIS journalisé (seulement sa longueur et le document lié).
 */
export function summarizeResultForLog(typeKey: WfTaskTypeKey, result: unknown): unknown {
  if (typeKey === 'generation' && isPlainObject(result) && result.rejected !== true) {
    const content = typeof result.content === 'string' ? result.content : '';
    const out: Record<string, unknown> = { contentLength: content.length };
    if (result.documentId !== undefined) out.documentId = result.documentId;
    return out;
  }
  return boundJson(result);
}
