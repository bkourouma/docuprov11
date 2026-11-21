// Docu-Flow — énumérations & constantes métier du moteur de workflow (api / worker / web).
// Miroir TS des états stockés en base sous forme de `smallint` + CHECK (pas d'enum Prisma) :
// cf. packages/db/prisma/models/wf.prisma. Les valeurs numériques doivent rester identiques aux CHECK SQL.

/** Statut d'un workflow (wf_definition.status). */
export const WfDefinitionStatus = {
  Draft: 0,
  Published: 1,
  Archived: 2,
} as const;
export type WfDefinitionStatus = (typeof WfDefinitionStatus)[keyof typeof WfDefinitionStatus];

export const WF_DEFINITION_STATUS_VALUES: readonly WfDefinitionStatus[] = [0, 1, 2];

export const WF_DEFINITION_STATUS_LABELS: Record<WfDefinitionStatus, string> = {
  [WfDefinitionStatus.Draft]: 'Brouillon',
  [WfDefinitionStatus.Published]: 'Publié',
  [WfDefinitionStatus.Archived]: 'Archivé',
};

export function isWfDefinitionStatus(value: unknown): value is WfDefinitionStatus {
  return typeof value === 'number' && (WF_DEFINITION_STATUS_VALUES as readonly number[]).includes(value);
}

/** Statut d'une version de workflow (wf_definition_version.status). Une version publiée est immuable. */
export const WfDefinitionVersionStatus = {
  Draft: 0,
  Published: 1,
  Archived: 2,
} as const;
export type WfDefinitionVersionStatus = (typeof WfDefinitionVersionStatus)[keyof typeof WfDefinitionVersionStatus];

export const WF_DEFINITION_VERSION_STATUS_VALUES: readonly WfDefinitionVersionStatus[] = [0, 1, 2];

export const WF_DEFINITION_VERSION_STATUS_LABELS: Record<WfDefinitionVersionStatus, string> = {
  [WfDefinitionVersionStatus.Draft]: 'Brouillon',
  [WfDefinitionVersionStatus.Published]: 'Publiée',
  [WfDefinitionVersionStatus.Archived]: 'Archivée',
};

export function isWfDefinitionVersionStatus(value: unknown): value is WfDefinitionVersionStatus {
  return typeof value === 'number' && (WF_DEFINITION_VERSION_STATUS_VALUES as readonly number[]).includes(value);
}

/** Origine d'un workflow (wf_definition.source). */
export const WfDefinitionSource = {
  Manual: 0,
  NaturalLanguage: 1,
} as const;
export type WfDefinitionSource = (typeof WfDefinitionSource)[keyof typeof WfDefinitionSource];

export const WF_DEFINITION_SOURCE_VALUES: readonly WfDefinitionSource[] = [0, 1];

export const WF_DEFINITION_SOURCE_LABELS: Record<WfDefinitionSource, string> = {
  [WfDefinitionSource.Manual]: 'Manuel',
  [WfDefinitionSource.NaturalLanguage]: 'Langage naturel',
};

export function isWfDefinitionSource(value: unknown): value is WfDefinitionSource {
  return typeof value === 'number' && (WF_DEFINITION_SOURCE_VALUES as readonly number[]).includes(value);
}

/** Statut d'une instance de workflow (wf_instance.status). */
export const WfInstanceStatus = {
  Running: 0,
  Waiting: 1,
  Completed: 2,
  Failed: 3,
  Cancelled: 4,
  Suspended: 5,
} as const;
export type WfInstanceStatus = (typeof WfInstanceStatus)[keyof typeof WfInstanceStatus];

export const WF_INSTANCE_STATUS_VALUES: readonly WfInstanceStatus[] = [0, 1, 2, 3, 4, 5];

export const WF_INSTANCE_STATUS_LABELS: Record<WfInstanceStatus, string> = {
  [WfInstanceStatus.Running]: 'En cours',
  [WfInstanceStatus.Waiting]: 'En attente',
  [WfInstanceStatus.Completed]: 'Terminée',
  [WfInstanceStatus.Failed]: 'Échouée',
  [WfInstanceStatus.Cancelled]: 'Annulée',
  [WfInstanceStatus.Suspended]: 'Suspendue',
};

export function isWfInstanceStatus(value: unknown): value is WfInstanceStatus {
  return typeof value === 'number' && (WF_INSTANCE_STATUS_VALUES as readonly number[]).includes(value);
}

/** Type d'étape / de tâche (wf_task.task_type). */
export const WfTaskType = {
  Form: 0,
  Generation: 1,
  Checklist: 2,
  Assignment: 3,
  Approval: 4,
  Decision: 5,
  Agent: 6,
} as const;
export type WfTaskType = (typeof WfTaskType)[keyof typeof WfTaskType];

export const WF_TASK_TYPE_VALUES: readonly WfTaskType[] = [0, 1, 2, 3, 4, 5, 6];

export const WF_TASK_TYPE_LABELS: Record<WfTaskType, string> = {
  [WfTaskType.Form]: 'Formulaire',
  [WfTaskType.Generation]: 'Génération',
  [WfTaskType.Checklist]: 'Checklist',
  [WfTaskType.Assignment]: 'Affectation',
  [WfTaskType.Approval]: 'Validation',
  [WfTaskType.Decision]: 'Décision',
  [WfTaskType.Agent]: 'Agent',
};

export function isWfTaskType(value: unknown): value is WfTaskType {
  return typeof value === 'number' && (WF_TASK_TYPE_VALUES as readonly number[]).includes(value);
}

/** Statut d'une tâche (wf_task.status). */
export const WfTaskStatus = {
  Todo: 0,
  InProgress: 1,
  Done: 2,
  Cancelled: 3,
  Expired: 4,
  Failed: 5,
} as const;
export type WfTaskStatus = (typeof WfTaskStatus)[keyof typeof WfTaskStatus];

export const WF_TASK_STATUS_VALUES: readonly WfTaskStatus[] = [0, 1, 2, 3, 4, 5];

export const WF_TASK_STATUS_LABELS: Record<WfTaskStatus, string> = {
  [WfTaskStatus.Todo]: 'À faire',
  [WfTaskStatus.InProgress]: 'En cours',
  [WfTaskStatus.Done]: 'Terminée',
  [WfTaskStatus.Cancelled]: 'Annulée',
  [WfTaskStatus.Expired]: 'Expirée',
  [WfTaskStatus.Failed]: 'Échouée',
};

export function isWfTaskStatus(value: unknown): value is WfTaskStatus {
  return typeof value === 'number' && (WF_TASK_STATUS_VALUES as readonly number[]).includes(value);
}

/** Priorité d'une tâche ou d'un élément de boîte de réception. */
export const WfTaskPriority = {
  Low: 0,
  Normal: 1,
  High: 2,
} as const;
export type WfTaskPriority = (typeof WfTaskPriority)[keyof typeof WfTaskPriority];

export const WF_TASK_PRIORITY_VALUES: readonly WfTaskPriority[] = [0, 1, 2];

export const WF_TASK_PRIORITY_LABELS: Record<WfTaskPriority, string> = {
  [WfTaskPriority.Low]: 'Basse',
  [WfTaskPriority.Normal]: 'Normale',
  [WfTaskPriority.High]: 'Haute',
};

export function isWfTaskPriority(value: unknown): value is WfTaskPriority {
  return typeof value === 'number' && (WF_TASK_PRIORITY_VALUES as readonly number[]).includes(value);
}

/** Nature d'une minuterie (wf_timer.kind). */
export const WfTimerKind = {
  Wait: 0,
  Reminder: 1,
  Deadline: 2,
  Resume: 3,
} as const;
export type WfTimerKind = (typeof WfTimerKind)[keyof typeof WfTimerKind];

export const WF_TIMER_KIND_VALUES: readonly WfTimerKind[] = [0, 1, 2, 3];

export const WF_TIMER_KIND_LABELS: Record<WfTimerKind, string> = {
  [WfTimerKind.Wait]: 'Attente',
  [WfTimerKind.Reminder]: 'Relance',
  [WfTimerKind.Deadline]: 'Échéance',
  [WfTimerKind.Resume]: 'Reprise',
};

export function isWfTimerKind(value: unknown): value is WfTimerKind {
  return typeof value === 'number' && (WF_TIMER_KIND_VALUES as readonly number[]).includes(value);
}

/** Statut d'une minuterie (wf_timer.status). */
export const WfTimerStatus = {
  Active: 0,
  Fired: 1,
  Cancelled: 2,
} as const;
export type WfTimerStatus = (typeof WfTimerStatus)[keyof typeof WfTimerStatus];

export const WF_TIMER_STATUS_VALUES: readonly WfTimerStatus[] = [0, 1, 2];

export const WF_TIMER_STATUS_LABELS: Record<WfTimerStatus, string> = {
  [WfTimerStatus.Active]: 'Active',
  [WfTimerStatus.Fired]: 'Déclenchée',
  [WfTimerStatus.Cancelled]: 'Annulée',
};

export function isWfTimerStatus(value: unknown): value is WfTimerStatus {
  return typeof value === 'number' && (WF_TIMER_STATUS_VALUES as readonly number[]).includes(value);
}

/** Auteur d'un événement du journal (wf_event_log.actor_kind). */
export const WfActorKind = {
  System: 0,
  User: 1,
  Agent: 2,
} as const;
export type WfActorKind = (typeof WfActorKind)[keyof typeof WfActorKind];

export const WF_ACTOR_KIND_VALUES: readonly WfActorKind[] = [0, 1, 2];

export const WF_ACTOR_KIND_LABELS: Record<WfActorKind, string> = {
  [WfActorKind.System]: 'Système',
  [WfActorKind.User]: 'Utilisateur',
  [WfActorKind.Agent]: 'Agent',
};

export function isWfActorKind(value: unknown): value is WfActorKind {
  return typeof value === 'number' && (WF_ACTOR_KIND_VALUES as readonly number[]).includes(value);
}

/** Niveau d'autonomie d'un agent (wf_agent_config.autonomy_level). */
export const WfAutonomyLevel = {
  Suggest: 0,
  ActWithValidation: 1,
  Autonomous: 2,
} as const;
export type WfAutonomyLevel = (typeof WfAutonomyLevel)[keyof typeof WfAutonomyLevel];

export const WF_AUTONOMY_LEVEL_VALUES: readonly WfAutonomyLevel[] = [0, 1, 2];

export const WF_AUTONOMY_LEVEL_LABELS: Record<WfAutonomyLevel, string> = {
  [WfAutonomyLevel.Suggest]: 'Suggère',
  [WfAutonomyLevel.ActWithValidation]: 'Agit avec validation',
  [WfAutonomyLevel.Autonomous]: 'Autonome',
};

export function isWfAutonomyLevel(value: unknown): value is WfAutonomyLevel {
  return typeof value === 'number' && (WF_AUTONOMY_LEVEL_VALUES as readonly number[]).includes(value);
}

/** Effet de bord d'un outil d'agent (wf_tool.side_effect). */
export const WfToolSideEffect = {
  Read: 0,
  ReversibleWrite: 1,
  ExternalIrreversible: 2,
} as const;
export type WfToolSideEffect = (typeof WfToolSideEffect)[keyof typeof WfToolSideEffect];

export const WF_TOOL_SIDE_EFFECT_VALUES: readonly WfToolSideEffect[] = [0, 1, 2];

export const WF_TOOL_SIDE_EFFECT_LABELS: Record<WfToolSideEffect, string> = {
  [WfToolSideEffect.Read]: 'Lecture',
  [WfToolSideEffect.ReversibleWrite]: 'Écriture réversible',
  [WfToolSideEffect.ExternalIrreversible]: 'Externe ou irréversible',
};

export function isWfToolSideEffect(value: unknown): value is WfToolSideEffect {
  return typeof value === 'number' && (WF_TOOL_SIDE_EFFECT_VALUES as readonly number[]).includes(value);
}

/** Période d'un budget (wf_budget.period_kind). */
export const WfBudgetPeriodKind = {
  Monthly: 0,
  Daily: 1,
  Cumulative: 2,
} as const;
export type WfBudgetPeriodKind = (typeof WfBudgetPeriodKind)[keyof typeof WfBudgetPeriodKind];

export const WF_BUDGET_PERIOD_KIND_VALUES: readonly WfBudgetPeriodKind[] = [0, 1, 2];

export const WF_BUDGET_PERIOD_KIND_LABELS: Record<WfBudgetPeriodKind, string> = {
  [WfBudgetPeriodKind.Monthly]: 'Mensuel',
  [WfBudgetPeriodKind.Daily]: 'Journalier',
  [WfBudgetPeriodKind.Cumulative]: 'Cumulé',
};

export function isWfBudgetPeriodKind(value: unknown): value is WfBudgetPeriodKind {
  return typeof value === 'number' && (WF_BUDGET_PERIOD_KIND_VALUES as readonly number[]).includes(value);
}

/** Statut d'une exécution d'évaluation (wf_eval_run.status). */
export const WfEvalRunStatus = {
  Running: 0,
  Completed: 1,
  Errored: 2,
} as const;
export type WfEvalRunStatus = (typeof WfEvalRunStatus)[keyof typeof WfEvalRunStatus];

export const WF_EVAL_RUN_STATUS_VALUES: readonly WfEvalRunStatus[] = [0, 1, 2];

export const WF_EVAL_RUN_STATUS_LABELS: Record<WfEvalRunStatus, string> = {
  [WfEvalRunStatus.Running]: 'En cours',
  [WfEvalRunStatus.Completed]: 'Terminé',
  [WfEvalRunStatus.Errored]: 'En erreur',
};

export function isWfEvalRunStatus(value: unknown): value is WfEvalRunStatus {
  return typeof value === 'number' && (WF_EVAL_RUN_STATUS_VALUES as readonly number[]).includes(value);
}

/** Nature d'un élément de boîte de réception (wf_inbox_item.kind). */
export const WfInboxItemKind = {
  HumanTask: 0,
  AgentValidation: 1,
} as const;
export type WfInboxItemKind = (typeof WfInboxItemKind)[keyof typeof WfInboxItemKind];

export const WF_INBOX_ITEM_KIND_VALUES: readonly WfInboxItemKind[] = [0, 1];

export const WF_INBOX_ITEM_KIND_LABELS: Record<WfInboxItemKind, string> = {
  [WfInboxItemKind.HumanTask]: 'Tâche humaine',
  [WfInboxItemKind.AgentValidation]: "Validation d'agent",
};

export function isWfInboxItemKind(value: unknown): value is WfInboxItemKind {
  return typeof value === 'number' && (WF_INBOX_ITEM_KIND_VALUES as readonly number[]).includes(value);
}

/** Statut d'un élément de boîte de réception (wf_inbox_item.status). */
export const WfInboxItemStatus = {
  Open: 0,
  Claimed: 1,
  Done: 2,
  Rejected: 3,
  Expired: 4,
  Cancelled: 5,
} as const;
export type WfInboxItemStatus = (typeof WfInboxItemStatus)[keyof typeof WfInboxItemStatus];

export const WF_INBOX_ITEM_STATUS_VALUES: readonly WfInboxItemStatus[] = [0, 1, 2, 3, 4, 5];

export const WF_INBOX_ITEM_STATUS_LABELS: Record<WfInboxItemStatus, string> = {
  [WfInboxItemStatus.Open]: 'Ouverte',
  [WfInboxItemStatus.Claimed]: 'Prise',
  [WfInboxItemStatus.Done]: 'Traitée',
  [WfInboxItemStatus.Rejected]: 'Rejetée',
  [WfInboxItemStatus.Expired]: 'Expirée',
  [WfInboxItemStatus.Cancelled]: 'Annulée',
};

export function isWfInboxItemStatus(value: unknown): value is WfInboxItemStatus {
  return typeof value === 'number' && (WF_INBOX_ITEM_STATUS_VALUES as readonly number[]).includes(value);
}

// ---------------------------------------------------------------------------
// Statuts terminaux d'instance
// ---------------------------------------------------------------------------

/** Statuts terminaux : `finished_at` est renseignée ssi l'instance est dans l'un d'eux (CHECK SQL). */
export const WF_INSTANCE_TERMINAL_STATUSES: readonly WfInstanceStatus[] = [
  WfInstanceStatus.Completed,
  WfInstanceStatus.Failed,
  WfInstanceStatus.Cancelled,
];

export function isWfInstanceTerminal(status: WfInstanceStatus): boolean {
  return WF_INSTANCE_TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Clés texte du graphe JSON (index = valeur numérique)
// ---------------------------------------------------------------------------

/** Clés texte des types d'étape dans le graphe JSON ; l'index est la valeur numérique de WfTaskType. */
export const WF_TASK_TYPE_KEYS = [
  'formulaire',
  'generation',
  'checklist',
  'affectation',
  'validation',
  'decision',
  'agent',
] as const;
export type WfTaskTypeKey = (typeof WF_TASK_TYPE_KEYS)[number];

export function isWfTaskTypeKey(value: unknown): value is WfTaskTypeKey {
  return typeof value === 'string' && (WF_TASK_TYPE_KEYS as readonly string[]).includes(value);
}

export function wfTaskTypeFromKey(key: WfTaskTypeKey): WfTaskType {
  return WF_TASK_TYPE_KEYS.indexOf(key) as WfTaskType;
}

export function wfTaskTypeToKey(type: WfTaskType): WfTaskTypeKey {
  return WF_TASK_TYPE_KEYS[type];
}

/** Clés texte des niveaux d'autonomie ; l'index est la valeur numérique de WfAutonomyLevel. */
export const WF_AUTONOMY_KEYS = ['suggere', 'agit_avec_validation', 'autonome'] as const;
export type WfAutonomyKey = (typeof WF_AUTONOMY_KEYS)[number];

export function isWfAutonomyKey(value: unknown): value is WfAutonomyKey {
  return typeof value === 'string' && (WF_AUTONOMY_KEYS as readonly string[]).includes(value);
}

export function wfAutonomyFromKey(key: WfAutonomyKey): WfAutonomyLevel {
  return WF_AUTONOMY_KEYS.indexOf(key) as WfAutonomyLevel;
}

export function wfAutonomyToKey(level: WfAutonomyLevel): WfAutonomyKey {
  return WF_AUTONOMY_KEYS[level];
}

// ---------------------------------------------------------------------------
// Garde-fous d'autonomie (miroir des déclencheurs SQL)
// ---------------------------------------------------------------------------

export interface WfAutonomyCheckInput {
  level: WfAutonomyLevel;
  /** Le workflow est marqué « à faible risque » par un administrateur. */
  isLowRisk: boolean;
  /** Une exécution d'évaluation réussie existe pour la version. */
  hasPassedEvalRun: boolean;
  /** Effets de bord des outils de l'étape (information ; non bloquant à ce stade). */
  toolsSideEffects?: readonly WfToolSideEffect[];
}

export interface WfAutonomyCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Le niveau « autonome » exige un workflow à faible risque ET une évaluation réussie ;
 * les autres niveaux sont toujours permis.
 */
export function checkAutonomyAllowed(input: WfAutonomyCheckInput): WfAutonomyCheckResult {
  if (input.level !== WfAutonomyLevel.Autonomous) return { allowed: true };
  if (!input.isLowRisk) {
    return { allowed: false, reason: "Le niveau autonome exige que le workflow soit marqué à faible risque." };
  }
  if (!input.hasPassedEvalRun) {
    return { allowed: false, reason: "Le niveau autonome exige une évaluation réussie de la version." };
  }
  return { allowed: true };
}

/** Vrai si la confiance est absente ou inférieure au seuil : une validation humaine est requise. */
export function confidenceRequiresHuman(
  confidence: number | null | undefined,
  threshold: number,
): boolean {
  return confidence === null || confidence === undefined || Number.isNaN(confidence) || confidence < threshold;
}
