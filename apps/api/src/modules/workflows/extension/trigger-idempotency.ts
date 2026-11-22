/**
 * Espace de clés d'idempotence RÉSERVÉ aux déclencheurs (W3). Une clé qui commence par ce préfixe ne peut être
 * posée que par `WorkflowTriggerStarterService` : la route publique de lancement la refuse, sinon un lanceur
 * pourrait occuper à l'avance la clé d'un événement futur et empêcher le déclencheur de se lancer.
 */
export const WF_TRIGGER_IDEMPOTENCY_PREFIX = 'trg:';

export function isReservedTriggerIdempotencyKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith(WF_TRIGGER_IDEMPOTENCY_PREFIX);
}
