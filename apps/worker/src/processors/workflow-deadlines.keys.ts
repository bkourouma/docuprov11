// Docu-Flow W3 - clé d'idempotence d'un lancement par déclencheur, calculée côté worker.
//
// MÊME format que l'API (`workflow-triggers/domain/events.ts`, `triggerIdempotencyKey`) :
//   trg:{triggerId}:{type}:{subjectType}:{subjectId}[:{occurrenceKey}]
// Le balayage SQL (`workflow-deadlines.processor.ts`) recompose cette clé en SQL pour savoir si une instance
// existe déjà ; toute modification du format doit être reportée des deux côtés.

/** Préfixe réservé aux déclencheurs (voir `trigger-idempotency.ts` côté API). */
export const WF_TRIGGER_KEY_PREFIX = 'trg:';

export interface WfKeyEvent {
  type: string;
  subjectType: string;
  subjectId: string;
  occurrenceKey?: string;
}

export function triggerIdempotencyKey(triggerId: number, event: WfKeyEvent): string {
  const base = `${WF_TRIGGER_KEY_PREFIX}${triggerId}:${event.type}:${event.subjectType}:${event.subjectId}`;
  return event.occurrenceKey ? `${base}:${event.occurrenceKey}` : base;
}
