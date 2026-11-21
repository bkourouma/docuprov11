// Docu-Flow — catalogues de clés ouvertes (types d'événement, de déclencheur, d'objet lié).
// Ces listes sont INDICATIVES : le SQL accepte toute clé conforme à WF_KEY_PATTERN
// (event_type : 80 car. max ; subject_type : 50 ; tool_key : 100).

/** Forme d'une clé ouverte : minuscules, chiffres, `_` et `.`. */
export const WF_KEY_PATTERN = /^[a-z0-9_.]+$/;

export const WF_EVENT_TYPE_MAX_LENGTH = 80;
export const WF_SUBJECT_TYPE_MAX_LENGTH = 50;
export const WF_TOOL_KEY_MAX_LENGTH = 100;

export function isWfKey(value: unknown, maxLength = WF_TOOL_KEY_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && WF_KEY_PATTERN.test(value);
}

/** Types d'événement du journal d'un workflow (wf_event_log.event_type). */
export const WF_EVENT_TYPES = [
  'instance.started',
  'instance.completed',
  'instance.failed',
  'instance.cancelled',
  'instance.suspended',
  'instance.resumed',
  'task.created',
  'task.assigned',
  'task.completed',
  'task.expired',
  'agent.proposed',
  'agent.acted',
  'agent.escalated',
  'validation.requested',
  'validation.accepted',
  'validation.modified',
  'validation.rejected',
  'timer.scheduled',
  'timer.fired',
  'budget.threshold_reached',
  'budget.exceeded',
  'emergency_stop.activated',
  'emergency_stop.released',
  'eval.run_completed',
  'correction',
] as const;
export type WfEventType = (typeof WF_EVENT_TYPES)[number];

export function isWfEventType(value: unknown): value is WfEventType {
  return typeof value === 'string' && (WF_EVENT_TYPES as readonly string[]).includes(value);
}

/** Types d'événement déclencheur (wf_trigger.event_type). */
export const WF_TRIGGER_EVENT_TYPES = [
  'mail.arrived',
  'document.deposited',
  'deadline.reached',
  'threshold.crossed',
] as const;
export type WfTriggerEventType = (typeof WF_TRIGGER_EVENT_TYPES)[number];

export function isWfTriggerEventType(value: unknown): value is WfTriggerEventType {
  return typeof value === 'string' && (WF_TRIGGER_EVENT_TYPES as readonly string[]).includes(value);
}

/** Types d'objet lié à une instance (wf_instance.subject_type). */
export const WF_SUBJECT_TYPES = ['mail', 'document', 'dossier', 'other'] as const;
export type WfSubjectType = (typeof WF_SUBJECT_TYPES)[number];

export function isWfSubjectType(value: unknown): value is WfSubjectType {
  return typeof value === 'string' && (WF_SUBJECT_TYPES as readonly string[]).includes(value);
}
