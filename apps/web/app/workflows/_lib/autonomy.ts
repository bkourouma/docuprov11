// Docu-Flow — disponibilité du niveau d'autonomie « autonome » dans l'éditeur (affichage seulement :
// le serveur refuse de toute façon la publication, cf. AUTONOMY_REQUIRES_LOW_RISK / checkAutonomyAllowed).
import { WfAutonomyLevel, checkAutonomyAllowed, type WfAutonomyKey } from '@archivage/types';

export interface AutonomyOption {
  key: WfAutonomyKey;
  label: string;
  description: string;
}

export const AUTONOMY_OPTIONS: readonly AutonomyOption[] = [
  {
    key: 'suggere',
    label: 'Suggère',
    description: "L'agent propose un résultat ; une personne le valide ou le corrige avant toute suite.",
  },
  {
    key: 'agit_avec_validation',
    label: 'Agit avec validation',
    description: "L'agent réalise l'étape, mais une personne confirme le résultat avant qu'il soit pris en compte.",
  },
  {
    key: 'autonome',
    label: 'Autonome',
    description:
      "L'agent enchaîne seul tant que sa confiance dépasse le seuil. Réservé aux workflows à faible risque évalués.",
  },
];

export interface AutonomyAvailability {
  allowed: boolean;
  /** Motif en français quand `allowed` est faux, sinon null. */
  reason: string | null;
}

const LOW_RISK_MISSING = 'le workflow doit d’abord être marqué à faible risque par un administrateur';

export function autonomyAvailability(input: {
  isLowRisk: boolean;
  hasPassedEval: boolean | null;
}): AutonomyAvailability {
  const lowRisk = input.isLowRisk === true;
  const evalOk = input.hasPassedEval === true;
  const evalUnavailable = input.hasPassedEval === null;

  // Cohérence avec la règle partagée côté serveur : elle seule peut autoriser.
  const shared = checkAutonomyAllowed({
    level: WfAutonomyLevel.Autonomous,
    isLowRisk: lowRisk,
    hasPassedEvalRun: evalOk,
  });
  if (shared.allowed) return { allowed: true, reason: null };

  if (!lowRisk && !evalOk) {
    return {
      allowed: false,
      reason: evalUnavailable
        ? `Le niveau autonome reste réservé : ${LOW_RISK_MISSING}, et les évaluations ne sont pas encore disponibles.`
        : `Le niveau autonome est réservé : ${LOW_RISK_MISSING}, et la version doit avoir passé une évaluation avec succès.`,
    };
  }
  if (!lowRisk) {
    return {
      allowed: false,
      reason: `Le niveau autonome est réservé : ${LOW_RISK_MISSING}.`,
    };
  }
  return {
    allowed: false,
    reason: evalUnavailable
      ? 'Les évaluations ne sont pas encore disponibles : le niveau autonome reste réservé.'
      : 'Le niveau autonome exige une évaluation réussie de cette version, et aucune n’a réussi pour le moment.',
  };
}
