// Assistant « qui agit » — énumérations & constantes métier (api / worker / web).
// Miroir TS des états stockés en base sous forme de `smallint` + CHECK (pas d'enum Prisma) :
// cf. packages/db/prisma/models/asst.prisma et packages/db/prisma/sql/asst.sql.
// Les valeurs numériques doivent rester identiques aux CHECK et aux déclencheurs SQL.

/** Rôle d'un message d'échange (asst_message.role). */
export const AsstMessageRole = {
  User: 0,
  Assistant: 1,
} as const;
export type AsstMessageRole = (typeof AsstMessageRole)[keyof typeof AsstMessageRole];

export const ASST_MESSAGE_ROLE_VALUES: readonly AsstMessageRole[] = [0, 1];

export const ASST_MESSAGE_ROLE_LABELS: Record<AsstMessageRole, string> = {
  [AsstMessageRole.User]: 'Utilisateur',
  [AsstMessageRole.Assistant]: 'Assistant',
};

export function isAsstMessageRole(value: unknown): value is AsstMessageRole {
  return typeof value === 'number' && (ASST_MESSAGE_ROLE_VALUES as readonly number[]).includes(value);
}

/**
 * Statut d'une proposition (asst_proposal.status).
 *
 * Transitions LÉGALES (déclencheur SQL `asst_proposal_guard`) :
 *   Proposed  -> Confirmed | Refused | Expired
 *   Confirmed -> Applied | Failed
 * Applied, Refused, Expired et Failed sont terminaux : la ligne est ensuite FIGÉE.
 */
export const AsstProposalStatus = {
  Proposed: 0,
  Confirmed: 1,
  Applied: 2,
  Refused: 3,
  Expired: 4,
  Failed: 5,
} as const;
export type AsstProposalStatus = (typeof AsstProposalStatus)[keyof typeof AsstProposalStatus];

export const ASST_PROPOSAL_STATUS_VALUES: readonly AsstProposalStatus[] = [0, 1, 2, 3, 4, 5];

export const ASST_PROPOSAL_STATUS_LABELS: Record<AsstProposalStatus, string> = {
  [AsstProposalStatus.Proposed]: 'Proposée',
  [AsstProposalStatus.Confirmed]: 'Confirmée',
  [AsstProposalStatus.Applied]: 'Appliquée',
  [AsstProposalStatus.Refused]: 'Refusée',
  [AsstProposalStatus.Expired]: 'Expirée',
  [AsstProposalStatus.Failed]: 'Échec',
};

export function isAsstProposalStatus(value: unknown): value is AsstProposalStatus {
  return typeof value === 'number' && (ASST_PROPOSAL_STATUS_VALUES as readonly number[]).includes(value);
}

/** Transitions légales, miroir du déclencheur SQL. */
export const ASST_PROPOSAL_TRANSITIONS: Record<AsstProposalStatus, readonly AsstProposalStatus[]> = {
  [AsstProposalStatus.Proposed]: [AsstProposalStatus.Confirmed, AsstProposalStatus.Refused, AsstProposalStatus.Expired],
  [AsstProposalStatus.Confirmed]: [AsstProposalStatus.Applied, AsstProposalStatus.Failed],
  [AsstProposalStatus.Applied]: [],
  [AsstProposalStatus.Refused]: [],
  [AsstProposalStatus.Expired]: [],
  [AsstProposalStatus.Failed]: [],
};

export function isAsstProposalTransitionAllowed(from: AsstProposalStatus, to: AsstProposalStatus): boolean {
  return ASST_PROPOSAL_TRANSITIONS[from].includes(to);
}

export function isAsstProposalTerminal(status: AsstProposalStatus): boolean {
  return ASST_PROPOSAL_TRANSITIONS[status].length === 0;
}

/**
 * Clés d'outils d'une action proposée. Ce sont EXACTEMENT les clés du catalogue d'agents
 * (`CATALOG_TOOL_KEYS` de apps/api/src/modules/workflow-agent-catalog/catalog.contracts.ts) pour que les
 * applicateurs d'effets existants soient réutilisés tels quels. La délégation est EXCLUE en v1.
 */
export const AsstActionTool = {
  ImputationCourrier: 'proposer_imputation_courrier',
  Relance: 'proposer_relance',
  BrouillonReponse: 'preparer_brouillon_reponse',
} as const;
export type AsstActionTool = (typeof AsstActionTool)[keyof typeof AsstActionTool];

export const ASST_ACTION_TOOL_VALUES = [
  AsstActionTool.ImputationCourrier,
  AsstActionTool.Relance,
  AsstActionTool.BrouillonReponse,
] as const;

export const ASST_ACTION_TOOL_LABELS: Record<AsstActionTool, string> = {
  [AsstActionTool.ImputationCourrier]: 'Imputation de courrier',
  [AsstActionTool.Relance]: 'Relance',
  [AsstActionTool.BrouillonReponse]: 'Brouillon de réponse',
};

// ---------------------------------------------------------------------------
// Constantes métier (hypothèses métier appliquées, modifiables en un seul endroit)
// ---------------------------------------------------------------------------

/** Durée de validité d'une proposition, en minutes, à partir de sa création. */
export const ASST_PROPOSAL_TTL_MINUTES = 15;
/** Conservation d'un échange (conversation + messages + propositions), en jours. */
export const ASST_RETENTION_DAYS = 90;
/** Nombre maximal d'actions dans une même proposition (même plafond que les destinataires d'imputation). */
export const ASST_PROPOSAL_ACTIONS_MAX = 5;
/** Taille maximale d'un message utilisateur / assistant (caractères). */
export const ASST_MESSAGE_MAX_CHARS = 4_000;
export const ASST_ASSISTANT_MESSAGE_MAX_CHARS = 8_000;
export const ASST_TITLE_MAX_CHARS = 200;
export const ASST_SUMMARY_MAX_CHARS = 2_000;
/** Identifiant de définition réservé à la porte `AgentGate` de l'assistant (aucune ligne `wf_definition` ne le porte). */
export const ASST_GATE_DEFINITION_ID = 0;

// ---------------------------------------------------------------------------
// Codes d'erreur typés (`errorCode` des réponses d'erreur de /assistant/**)
// ---------------------------------------------------------------------------

export const AsstErrorCode = {
  /** Brique (planificateur, exécuteur, store) pas encore branchée : HTTP 501. */
  NotImplemented: 'not_implemented',
  /** Conversation ou proposition inexistante OU appartenant à un autre utilisateur : HTTP 404 (jamais 403). */
  NotFound: 'not_found',
  /** Identité refusée : compte inactif, identité machine, acteur inconnu : HTTP 403. */
  IdentityRefused: 'identity_refused',
  /** Proposition expirée (au-delà de 15 minutes) : HTTP 409. */
  ProposalExpired: 'proposal_expired',
  /** Transition illégale (déjà confirmée, refusée, appliquée…) : HTTP 409. */
  ProposalNotPending: 'proposal_not_pending',
  /** Conflit de verrou optimiste (`rowVersion`) : HTTP 409. */
  Conflict: 'conflict',
  /** Droits insuffisants pour l'effet (menu, périmètre, imputabilité) : HTTP 403. */
  EffectForbidden: 'effect_forbidden',
  /** L'effet a échoué à l'application (refus métier de l'applicateur) : HTTP 422. */
  EffectFailed: 'effect_failed',
  /** Plafond de coût (utilisateur/jour ou global) atteint : HTTP 429. */
  BudgetExceeded: 'budget_exceeded',
  /** IA désactivée ou arrêt d'urgence : HTTP 503. */
  AssistantUnavailable: 'assistant_unavailable',
  /** Corps ou paramètres invalides : HTTP 422. */
  InvalidInput: 'invalid_input',
} as const;
export type AsstErrorCode = (typeof AsstErrorCode)[keyof typeof AsstErrorCode];

export const ASST_ERROR_CODE_VALUES = Object.values(AsstErrorCode) as readonly AsstErrorCode[];

/** Statut HTTP associé à chaque code (source unique : contrôleur, docs, front). */
export const ASST_ERROR_HTTP_STATUS: Record<AsstErrorCode, number> = {
  [AsstErrorCode.NotImplemented]: 501,
  [AsstErrorCode.NotFound]: 404,
  [AsstErrorCode.IdentityRefused]: 403,
  [AsstErrorCode.ProposalExpired]: 409,
  [AsstErrorCode.ProposalNotPending]: 409,
  [AsstErrorCode.Conflict]: 409,
  [AsstErrorCode.EffectForbidden]: 403,
  [AsstErrorCode.EffectFailed]: 422,
  [AsstErrorCode.BudgetExceeded]: 429,
  [AsstErrorCode.AssistantUnavailable]: 503,
  [AsstErrorCode.InvalidInput]: 422,
};

export function isAsstErrorCode(value: unknown): value is AsstErrorCode {
  return typeof value === 'string' && (ASST_ERROR_CODE_VALUES as readonly string[]).includes(value);
}
