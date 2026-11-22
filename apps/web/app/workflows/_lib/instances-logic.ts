// Docu-Flow — logique PURE des écrans d'instances (suivi, détail, lancement, administration).
// Aucun React ici : tout est testable par `tsx --test`. Les textes affichés sont en français et jamais
// issus d'un JSON brut : le journal est traduit en phrases, `decision` n'est lu que pour des clés connues.
import {
  WF_ACTOR_KIND_LABELS,
  WF_EVENT_TYPE_MAX_LENGTH,
  WF_SUBJECT_TYPE_MAX_LENGTH,
  WF_KEY_PATTERN,
  type WfEventLogDto,
  type WfInboxItemDto,
  type WfTaskDto,
} from '@archivage/types';

// ---------------------------------------------------------------------------
// Acteurs
// ---------------------------------------------------------------------------

/** QUI : « Système », « Utilisateur n° 12 », « Agent ». Un type d'acteur inconnu reste lisible. */
export function actorLabel(kind: number, userGroupId: number | null | undefined): string {
  if (kind === 1) return typeof userGroupId === 'number' ? `Utilisateur n° ${userGroupId}` : 'Utilisateur';
  if (kind === 0 || kind === 2) return WF_ACTOR_KIND_LABELS[kind];
  return 'Acteur inconnu';
}

// ---------------------------------------------------------------------------
// Journal : phrases par type d'événement
// ---------------------------------------------------------------------------

export type EventTone = 'info' | 'success' | 'warning' | 'error' | 'agent';
export type EventFamilyKey = 'instance' | 'tasks' | 'validations' | 'agents' | 'timers' | 'budget';

interface EventSpec {
  what: string;
  tone: EventTone;
  family: EventFamilyKey;
}

const spec = (family: EventFamilyKey, tone: EventTone, what: string): EventSpec => ({ family, tone, what });

/**
 * Catalogue des événements : ceux de `WF_EVENT_TYPES` (packages/types) ET ceux réellement émis par le
 * moteur (docs/workflow-moteur.md §4.2). Un type absent de cette table prend le repli de `describeEvent`.
 */
const EVENT_SPECS: Record<string, EventSpec> = {
  'instance.started': spec('instance', 'info', 'a démarré le workflow'),
  'instance.completed': spec('instance', 'success', 'a terminé le workflow'),
  'instance.failed': spec('instance', 'error', 'a constaté l’échec du workflow'),
  'instance.cancelled': spec('instance', 'warning', 'a annulé le workflow'),
  'instance.suspended': spec('instance', 'warning', 'a suspendu le workflow'),
  'instance.resumed': spec('instance', 'info', 'a repris le workflow'),

  'task.created': spec('tasks', 'info', 'a créé une tâche'),
  'task.assigned': spec('tasks', 'info', 'a assigné la tâche'),
  'task.claimed': spec('tasks', 'info', 'a pris la tâche en charge'),
  'task.completed': spec('tasks', 'success', 'a terminé la tâche'),
  'task.rejected': spec('tasks', 'warning', 'a refusé la tâche'),
  'task.delegated': spec('tasks', 'info', 'a délégué la tâche'),
  'task.failed': spec('tasks', 'error', 'a signalé l’échec de la tâche'),
  'task.cancelled': spec('tasks', 'warning', 'a annulé la tâche'),
  'task.expired': spec('tasks', 'warning', 'a constaté l’expiration de la tâche'),
  'task.escalated': spec('tasks', 'warning', 'a escaladé la tâche vers un autre bénéficiaire'),

  'validation.requested': spec('validations', 'info', 'a demandé une validation'),
  'validation.accepted': spec('validations', 'success', 'a accepté la validation'),
  'validation.modified': spec('validations', 'warning', 'a validé en modifiant la proposition'),
  'validation.rejected': spec('validations', 'warning', 'a rejeté la validation'),
  correction: spec('validations', 'info', 'a enregistré une correction'),

  'agent.proposed': spec('agents', 'agent', 'a proposé une action, en attente de validation'),
  'agent.acted': spec('agents', 'agent', 'a exécuté une action de manière automatique'),
  'agent.escalated': spec('agents', 'agent', 'a confié la décision à un humain'),
  'agent.tool_called': spec('agents', 'agent', 'a appelé un outil (ou s’est vu refuser un outil non autorisé)'),
  'executor.error': spec('agents', 'error', 'a rencontré une erreur lors de l’exécution automatique'),
  'eval.run_completed': spec('agents', 'info', 'a terminé une évaluation de l’agent'),

  'timer.scheduled': spec('timers', 'info', 'a programmé une minuterie'),
  'timer.fired': spec('timers', 'info', 'a déclenché une minuterie'),
  'timer.cancelled': spec('timers', 'info', 'a annulé une minuterie'),
  'timer.failed': spec('timers', 'error', 'a abandonné une minuterie après plusieurs échecs'),

  'budget.threshold_reached': spec('budget', 'warning', 'a signalé que le seuil d’alerte du budget est atteint'),
  'budget.exceeded': spec('budget', 'error', 'a signalé le dépassement du budget'),
  'emergency_stop.activated': spec('budget', 'error', 'a activé l’arrêt d’urgence'),
  'emergency_stop.released': spec('budget', 'success', 'a levé l’arrêt d’urgence'),
};

/** Types connus (utile aux tests : couvrir toute la liste). */
export const KNOWN_EVENT_TYPES: readonly string[] = Object.keys(EVENT_SPECS);

export interface EventDescription {
  who: string;
  what: string;
  tone: EventTone;
  /** Famille de filtre ; `autre` pour un type inconnu (visible seulement sous « Tout »). */
  family: EventFamilyKey | 'autre';
}

/** Repli lisible pour un type inconnu : « Événement « instance started » », sans rien interpréter. */
function fallbackWhat(eventType: string): string {
  const safe = eventType.slice(0, WF_EVENT_TYPE_MAX_LENGTH).replace(/[._]+/g, ' ').trim();
  return safe ? `a enregistré l’événement « ${safe} »` : 'a enregistré un événement';
}

/** QUI + QUOI + teinte + famille d'un événement du journal. */
export function describeEvent(event: Pick<WfEventLogDto, 'eventType' | 'actorKind' | 'actorUserGroupId'>): EventDescription {
  const known = EVENT_SPECS[event.eventType];
  // Un événement d'agent reste visuellement « agent » même pour un type inconnu.
  const fallbackTone: EventTone = event.actorKind === 2 ? 'agent' : 'info';
  return {
    who: actorLabel(event.actorKind, event.actorUserGroupId),
    what: known ? known.what : fallbackWhat(event.eventType),
    tone: known ? known.tone : fallbackTone,
    family: known ? known.family : 'autre',
  };
}

export const EVENT_FAMILIES: ReadonlyArray<{ key: 'all' | EventFamilyKey; label: string }> = [
  { key: 'all', label: 'Tout' },
  { key: 'instance', label: 'Instance' },
  { key: 'tasks', label: 'Tâches' },
  { key: 'validations', label: 'Validations' },
  { key: 'agents', label: 'Agents' },
  { key: 'timers', label: 'Minuteries' },
  { key: 'budget', label: 'Budget' },
];

export type EventFamilyFilter = (typeof EVENT_FAMILIES)[number]['key'];

/** Filtre par famille ; un événement de type inconnu n'apparaît que sous « Tout ». */
export function filterEvents<T extends Pick<WfEventLogDto, 'eventType' | 'actorKind' | 'actorUserGroupId'>>(
  events: readonly T[],
  family: EventFamilyFilter,
): T[] {
  if (family === 'all') return [...events];
  return events.filter((e) => describeEvent(e).family === family);
}

/** Journal du plus ancien au plus récent (ou l'inverse) — tri stable, sans muter l'entrée. */
export function orderEvents<T extends Pick<WfEventLogDto, 'occurredAt' | 'wfEventLogId'>>(
  events: readonly T[],
  newestFirst: boolean,
): T[] {
  const sorted = [...events].sort((a, b) => {
    const d = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    if (Number.isFinite(d) && d !== 0) return d;
    return compareIds(a.wfEventLogId, b.wfEventLogId);
  });
  return newestFirst ? sorted.reverse() : sorted;
}

/** Identifiants BigInt reçus en chaîne : on compare par longueur puis lexicalement (pas de perte de précision). */
function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Champ `decision` : lecture restreinte à des clés connues
// ---------------------------------------------------------------------------

const DECISION_TEXT_MAX = 300;

const OP_LABELS: Record<string, string> = {
  eq: 'est égal à',
  neq: 'est différent de',
  gt: 'est supérieur à',
  gte: 'est supérieur ou égal à',
  lt: 'est inférieur à',
  lte: 'est inférieur ou égal à',
  in: 'fait partie de',
  exists: 'existe',
};

function primitiveText(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : t.slice(0, DECISION_TEXT_MAX);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  return null;
}

function conditionText(value: unknown): string | null {
  const direct = primitiveText(value);
  if (direct) return direct;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const field = primitiveText(rec.field);
  if (!field) return null;
  const op = typeof rec.op === 'string' ? (OP_LABELS[rec.op] ?? rec.op.slice(0, 20)) : null;
  const val = primitiveText(rec.value);
  return [field, op, val].filter(Boolean).join(' ');
}

/**
 * Lignes lisibles d'un champ `decision`. Seules les clés connues sont lues ; aucune autre n'est affichée
 * (jamais de JSON brut). Robuste à tout type de valeur : renvoie [] si rien d'exploitable.
 */
export function readDecisionSummary(decision: unknown): string[] {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) return [];
  const d = decision as Record<string, unknown>;
  const lines: string[] = [];
  const chosen = primitiveText(d.chosen);
  if (chosen) lines.push(`Étape choisie : ${chosen}`);
  const edge = primitiveText(d.edgeLabel);
  if (edge) lines.push(`Branche suivie : ${edge}`);
  const cond = conditionText(d.matchedCondition);
  if (cond) lines.push(`Condition satisfaite : ${cond}`);
  const source = primitiveText(d.source);
  if (source) lines.push(`Source : ${source}`);
  // Refus d'un outil par l'agent (`agent.tool_called`) : toujours visible, jamais le contenu des arguments.
  const deniedTool = primitiveText(d.deniedTool);
  if (deniedTool) lines.push(`Outil refusé : ${deniedTool}`);
  const denied = primitiveText(d.denied);
  if (denied) lines.push(`Motif du refus : ${denied}`);
  if (d.suspicion_injection === true) lines.push('Suspicion d’injection de consigne signalée');
  if (d.escalation !== undefined && d.escalation !== null && d.escalation !== false) {
    const esc = primitiveText(d.escalation);
    lines.push(esc && esc !== 'oui' ? `Escalade : ${esc}` : 'Escalade déclenchée');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Étapes franchies
// ---------------------------------------------------------------------------

export interface TaskAssignee {
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
}

/** Bénéficiaire d'une tâche : « Utilisateur n° 3 », « Groupe n° 2 », « Rôle n° 5 » (pas d'annuaire ici). */
export function assigneeLabel(task: TaskAssignee): string {
  if (typeof task.assigneeUserGroupId === 'number') return `Utilisateur n° ${task.assigneeUserGroupId}`;
  if (typeof task.assigneeGroupId === 'number') return `Groupe n° ${task.assigneeGroupId}`;
  if (typeof task.assigneeRoleId === 'number') return `Rôle n° ${task.assigneeRoleId}`;
  return 'Non assignée';
}

export interface DerivedStep {
  task: WfTaskDto;
  /** Étape en cours : tâche à faire (0) ou en cours (1). */
  current: boolean;
  /** Un élément de boîte ouvert attend la validation d'une proposition d'agent. */
  awaitingAgentValidation: boolean;
}

/** Tâche ouverte = à faire (0) ou en cours (1). */
export const isOpenTaskStatus = (status: number) => status === 0 || status === 1;

/**
 * Chronologie des étapes, dérivée des tâches triées par création (puis passage, puis identifiant).
 * Une étape revisitée par une boucle de correction apparaît autant de fois que de passages.
 */
export function deriveSteps(
  tasks: readonly WfTaskDto[],
  inboxItems: readonly Pick<WfInboxItemDto, 'taskId' | 'kind' | 'status'>[],
): DerivedStep[] {
  const waiting = new Set(
    inboxItems.filter((i) => i.kind === 1 && (i.status === 0 || i.status === 1)).map((i) => i.taskId),
  );
  return [...tasks]
    .sort((a, b) => {
      const d = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (Number.isFinite(d) && d !== 0) return d;
      if (a.attempt !== b.attempt) return a.attempt - b.attempt;
      return compareIds(a.wfTaskId, b.wfTaskId);
    })
    .map((task) => {
      const current = isOpenTaskStatus(task.status);
      return { task, current, awaitingAgentValidation: current && waiting.has(task.wfTaskId) };
    });
}

// ---------------------------------------------------------------------------
// Lancement manuel
// ---------------------------------------------------------------------------

/** Plafond des données de lancement (WF_CONTEXT_INPUT_MAX_BYTES côté moteur). */
export const LAUNCH_CONTEXT_MAX_BYTES = 262_144;
export const IDEMPOTENCY_KEY_MAX = 200;
/** `wf_instance.subject_id` est un BigInt : on n'accepte que des chiffres (18 au plus, sans dépasser 2^63). */
const SUBJECT_ID_PATTERN = /^\d{1,18}$/;

export type ParsedContext = { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string };

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Données de lancement : texte vide = aucune donnée ; sinon un OBJET JSON d'au plus 256 Kio (UTF-8). */
export function parseLaunchContext(text: string): ParsedContext {
  if (text.trim() === '') return { ok: true, value: undefined };
  if (utf8Length(text) > LAUNCH_CONTEXT_MAX_BYTES) {
    return { ok: false, error: 'Les données de lancement dépassent 256 Kio. Réduisez leur taille.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'Syntaxe JSON invalide : vérifiez les guillemets, les virgules et les accolades.',
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Les données de lancement doivent être un objet JSON, par exemple {"clé": "valeur"}.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface LaunchFormInput {
  contextText: string;
  subjectType: string | undefined;
  subjectId: string | undefined;
  idempotencyKey: string;
}

export interface LaunchFormErrors {
  context?: string;
  subject?: string;
  idempotencyKey?: string;
}

export interface LaunchPayload {
  context?: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
  idempotencyKey: string;
}

export interface LaunchValidation {
  valid: boolean;
  errors: LaunchFormErrors;
  /** Corps prêt à envoyer (présent seulement si `valid`). */
  payload?: LaunchPayload;
}

/** Valide le formulaire de lancement (messages en français) et construit le corps de la requête. */
export function validateLaunchForm(input: LaunchFormInput): LaunchValidation {
  const errors: LaunchFormErrors = {};

  const ctx = parseLaunchContext(input.contextText);
  if (!ctx.ok) errors.context = ctx.error;

  const type = (input.subjectType ?? '').trim();
  const id = (input.subjectId ?? '').trim();
  if ((type === '') !== (id === '')) {
    errors.subject = 'Renseignez le type ET l’identifiant de l’objet lié, ou laissez les deux vides.';
  } else if (type !== '') {
    if (type.length > WF_SUBJECT_TYPE_MAX_LENGTH || !WF_KEY_PATTERN.test(type)) {
      errors.subject = 'Le type d’objet lié est invalide (minuscules, chiffres, « _ » et « . », 50 caractères au plus).';
    } else if (!SUBJECT_ID_PATTERN.test(id)) {
      errors.subject = 'L’identifiant de l’objet lié doit être un nombre entier positif.';
    }
  }

  const key = input.idempotencyKey.trim();
  if (key === '') errors.idempotencyKey = 'La clé d’idempotence est obligatoire (1 à 200 caractères).';
  else if (key.length > IDEMPOTENCY_KEY_MAX) {
    errors.idempotencyKey = `La clé d’idempotence est trop longue (${key.length} caractères, 200 au plus).`;
  }

  if (Object.keys(errors).length > 0 || !ctx.ok) return { valid: false, errors };
  return {
    valid: true,
    errors,
    payload: {
      ...(ctx.value ? { context: ctx.value } : {}),
      ...(type !== '' ? { subjectType: type, subjectId: id } : {}),
      idempotencyKey: key,
    },
  };
}

/** Exemple affiché sous le champ « données de lancement ». */
export const LAUNCH_CONTEXT_EXAMPLE = '{\n  "priorite": "haute",\n  "montant": 1200\n}';

/** Libellés français des types d'objet lié proposés (clés de `WF_SUBJECT_TYPES`). */
export const SUBJECT_TYPE_LABELS: Record<string, string> = {
  mail: 'Courrier',
  document: 'Document',
  dossier: 'Dossier',
  other: 'Autre',
};

/** Texte d'objet lié pour l'en-tête du détail : « Document n° 12 » (texte brut, jamais interprété). */
export function subjectText(subjectType: string | null, subjectId: string | null): string | null {
  if (!subjectType && !subjectId) return null;
  const label = subjectType ? (SUBJECT_TYPE_LABELS[subjectType] ?? subjectType) : 'Objet';
  return subjectId ? `${label} n° ${subjectId}` : label;
}

// ---------------------------------------------------------------------------
// Liste : nom du workflow
// ---------------------------------------------------------------------------

/** Nom d'un workflow à partir de son identifiant, avec repli « Workflow n° X » si l'annuaire est indisponible. */
export function definitionName(names: ReadonlyMap<number, string>, definitionId: number): string {
  return names.get(definitionId) ?? `Workflow n° ${definitionId}`;
}
