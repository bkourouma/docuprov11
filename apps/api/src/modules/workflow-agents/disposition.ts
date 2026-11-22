import type { AgentRunOutput } from './agent.contracts';

/**
 * Décision finale d'une exécution d'agent selon le niveau d'autonomie (fonction PURE, testée).
 *
 *  - arrêt du runner, sortie invalide, sous le seuil de confiance (ou confiance absente) : jamais d'action
 *    seule => retour à l'humain (`return_to_human`) ;
 *  - `suspicion_injection` : la proposition (signalée) est déposée en boîte kind 1, sans aucune action
 *    préparée : un humain tranche (`propose`) ;
 *  - niveau 0 (suggère) : toujours une proposition ;
 *  - niveau 1 (agit avec validation) : une proposition validée en un clic ;
 *  - niveau 2 (autonome) : `complete` SEULEMENT si le niveau est éligible à l'instant T (faible risque + run
 *    d'évaluation réussi, relus en base), si aucune action préparée n'exige de validation et si la confiance
 *    atteint le seuil. Sinon proposition.
 */
export type AgentDisposition =
  | { kind: 'complete' }
  | { kind: 'propose'; reason: DispositionReason }
  | { kind: 'return_to_human'; reason: DispositionReason };

export type DispositionReason =
  | 'stopped'
  | 'low_confidence'
  | 'suspicion_injection'
  | 'suggestion_only'
  | 'validation_required'
  | 'autonomy_not_eligible'
  | 'action_requires_validation';

export interface DispositionInput {
  autonomy: 0 | 1 | 2;
  confidenceThreshold: number;
  run: Pick<AgentRunOutput, 'outcome' | 'confidence' | 'suspicionInjection' | 'preparedActions' | 'result'>;
  /** `checkAutonomyAllowed` relu en base à l'instant de l'exécution (faible risque + run réussi). */
  autonomousEligible: boolean;
}

export function decideDisposition(input: DispositionInput): AgentDisposition {
  const { run } = input;
  if (run.outcome !== 'final' || run.result === null) return { kind: 'return_to_human', reason: 'stopped' };
  if (run.suspicionInjection) return { kind: 'propose', reason: 'suspicion_injection' };
  const c = run.confidence;
  if (c === null || c === undefined || Number.isNaN(c) || c < input.confidenceThreshold) {
    return { kind: 'return_to_human', reason: 'low_confidence' };
  }
  if (input.autonomy === 0) return { kind: 'propose', reason: 'suggestion_only' };
  if (input.autonomy === 1) return { kind: 'propose', reason: 'validation_required' };
  if (!input.autonomousEligible) return { kind: 'propose', reason: 'autonomy_not_eligible' };
  if (run.preparedActions.some((a) => a.requiresValidation || a.sideEffect !== 0)) {
    return { kind: 'propose', reason: 'action_requires_validation' };
  }
  return { kind: 'complete' };
}
