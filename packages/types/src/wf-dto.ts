import { z } from 'zod';
import type {
  WfActorKind,
  WfAutonomyLevel,
  WfBudgetPeriodKind,
  WfDefinitionSource,
  WfDefinitionStatus,
  WfDefinitionVersionStatus,
  WfEvalRunStatus,
  WfInboxItemKind,
  WfInboxItemStatus,
  WfInstanceStatus,
  WfTaskPriority,
  WfTaskStatus,
  WfTaskType,
  WfTimerKind,
  WfTimerStatus,
  WfToolSideEffect,
} from './wf-enums';
import { WF_AUTONOMY_KEYS, WF_DEFINITION_SOURCE_VALUES } from './wf-enums';
import { WF_EVENT_TYPE_MAX_LENGTH, WF_KEY_PATTERN } from './wf-events';
import type { WfGraph } from './wf-graph';
import { wfGraphSchema } from './wf-graph';

// Docu-Flow — DTO de base. Dates en chaîne ISO UTC ; identifiants BigInt exposés en `string`,
// identifiants Int en `number` ; montants et ratios `Decimal` exposés en `string` (comme Prisma les
// sérialise). Les champs reprennent les colonnes de packages/db/prisma/models/wf.prisma en camelCase.

export interface WfDefinitionDto {
  wfDefinitionId: number;
  name: string;
  description: string | null;
  status: WfDefinitionStatus;
  source: WfDefinitionSource;
  isLowRisk: boolean;
  lowRiskMarkedBy: number | null;
  lowRiskMarkedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WfDefinitionVersionDto {
  wfDefinitionVersionId: number;
  definitionId: number;
  versionNumber: number;
  status: WfDefinitionVersionStatus;
  graph: WfGraph;
  graphHash: string | null;
  sourcePrompt: string | null;
  changeNote: string | null;
  publishedBy: number | null;
  publishedAt: string | null;
  createdBy: number | null;
  createdAt: string;
}

export interface WfInstanceDto {
  wfInstanceId: string;
  definitionId: number;
  definitionVersionId: number;
  status: WfInstanceStatus;
  context: Record<string, unknown>;
  startedBy: number;
  triggerId: number | null;
  parentInstanceId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  idempotencyKey: string | null;
  dueAt: string | null;
  errorMessage: string | null;
  rowVersion: number;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export interface WfTaskDto {
  wfTaskId: string;
  instanceId: string;
  stepKey: string;
  taskType: WfTaskType;
  status: WfTaskStatus;
  title: string;
  instructions: string | null;
  priority: WfTaskPriority;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
  dueAt: string | null;
  attempt: number;
  input: unknown;
  result: unknown;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WfEventLogDto {
  wfEventLogId: string;
  instanceId: string;
  taskId: string | null;
  stepKey: string | null;
  eventType: string;
  actorKind: WfActorKind;
  actorUserGroupId: number | null;
  instruction: string | null;
  sources: unknown;
  decision: unknown;
  explanation: string | null;
  confidence: string | null;
  autonomyLevel: WfAutonomyLevel | null;
  model: string | null;
  aiDecisionId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costAmount: string | null;
  validatedBy: number | null;
  validatedAt: string | null;
  correctsEventId: string | null;
  occurredAt: string;
}

export interface WfTimerDto {
  wfTimerId: string;
  instanceId: string;
  taskId: string | null;
  stepKey: string;
  kind: WfTimerKind;
  status: WfTimerStatus;
  fireAt: string;
  firedAt: string | null;
  attempts: number;
  payload: unknown;
  lockedBy: string | null;
  lockedUntil: string | null;
  createdAt: string;
}

export interface WfTriggerDto {
  wfTriggerId: number;
  definitionId: number;
  name: string;
  eventType: string;
  conditions: Record<string, unknown>;
  runAsUserGroupId: number;
  isActive: boolean;
  lastFiredAt: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WfToolDto {
  wfToolId: number;
  toolKey: string;
  label: string;
  description: string | null;
  sideEffect: WfToolSideEffect;
  requiresValidation: boolean;
  inputSchema: unknown;
  isEnabled: boolean;
  createdAt: string;
}

export interface WfToolGrantDto {
  wfToolGrantId: number;
  definitionId: number;
  toolId: number;
  maxCallsPerInstance: number | null;
  grantedBy: number | null;
  grantedAt: string;
}

export interface WfAgentConfigDto {
  wfAgentConfigId: number;
  definitionVersionId: number;
  stepKey: string;
  objective: string;
  autonomyLevel: WfAutonomyLevel;
  confidenceThreshold: string;
  model: string | null;
  maxSteps: number;
  maxCostPerRun: string | null;
  timeoutSeconds: number;
  evalSetId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WfBudgetDto {
  wfBudgetId: number;
  definitionId: number | null;
  periodKind: WfBudgetPeriodKind;
  periodStart: string;
  capAmount: string | null;
  consumedAmount: string;
  consumedTokens: string;
  alertThreshold: string;
  currency: string;
  emergencyStop: boolean;
  emergencyStopAt: string | null;
  emergencyStopBy: number | null;
  emergencyStopReason: string | null;
  updatedAt: string;
  updatedBy: number | null;
}

export interface WfEvalSetDto {
  wfEvalSetId: number;
  definitionId: number;
  stepKey: string | null;
  name: string;
  description: string | null;
  minAccuracy: string;
  isActive: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WfEvalCaseDto {
  wfEvalCaseId: number;
  evalSetId: number;
  label: string;
  input: unknown;
  expected: unknown;
  weight: number;
  sortOrder: number;
  isActive: boolean;
}

export interface WfEvalRunDto {
  wfEvalRunId: string;
  evalSetId: number;
  definitionVersionId: number;
  status: WfEvalRunStatus;
  totalCases: number;
  passedCases: number;
  accuracy: string | null;
  requiredAccuracy: string;
  passed: boolean;
  model: string | null;
  results: unknown;
  costAmount: string | null;
  errorMessage: string | null;
  runBy: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WfInboxItemDto {
  wfInboxItemId: string;
  taskId: string;
  instanceId: string;
  kind: WfInboxItemKind;
  status: WfInboxItemStatus;
  priority: WfTaskPriority;
  title: string;
  summary: string | null;
  proposal: unknown;
  explanation: string | null;
  sources: unknown;
  confidence: string | null;
  agentEventId: string | null;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
  dueAt: string | null;
  claimedBy: number | null;
  claimedAt: string | null;
  resolvedBy: number | null;
  resolvedAt: string | null;
  resolution: unknown;
  resolutionComment: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Schémas d'entrée
// ---------------------------------------------------------------------------

export const createWfDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  source: z
    .number()
    .refine((v) => (WF_DEFINITION_SOURCE_VALUES as readonly number[]).includes(v), {
      message: "origine du workflow invalide",
    })
    .optional(),
  graph: wfGraphSchema,
});
export type CreateWfDefinitionInput = z.infer<typeof createWfDefinitionSchema>;

export const createWfTriggerSchema = z.object({
  definitionId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  eventType: z.string().min(1).max(WF_EVENT_TYPE_MAX_LENGTH).regex(WF_KEY_PATTERN),
  conditions: z.record(z.unknown()),
  runAsUserGroupId: z.number().int().positive(),
});
export type CreateWfTriggerInput = z.infer<typeof createWfTriggerSchema>;

export const resolveWfInboxItemSchema = z.object({
  outcome: z.enum(['accepted', 'modified', 'rejected']),
  modifiedProposal: z.unknown().optional(),
  comment: z.string().max(4000).optional(),
});
export type ResolveWfInboxItemInput = z.infer<typeof resolveWfInboxItemSchema>;

export const emergencyStopSchema = z.object({
  definitionId: z.number().int().positive().nullable().optional(),
  active: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type EmergencyStopInput = z.infer<typeof emergencyStopSchema>;

// ---------------------------------------------------------------------------
// Moteur (lot W1) — configuration d'escalade d'une étape (ajout rétro-compatible)
// ---------------------------------------------------------------------------

/**
 * Escalade déclarée dans le graphe : `step.config.escalation`. Quand l'échéance d'une tâche humaine est
 * dépassée, le worker ré-affecte la MÊME tâche à `assignee` (nouvelle échéance `dueInHours`, OBLIGATOIRE : sans elle aucune minuterie d'échéance ne serait recréée), au plus
 * `maxEscalations` fois (défaut 1). Sans escalade déclarée (ou une fois épuisée), la tâche passe à
 * « expirée » et l'instance est suspendue (reprise manuelle). Partagé api (validation à la publication) /
 * worker (exécution des minuteries).
 */
export const wfEscalationConfigSchema = z.object({
  assignee: z
    .object({
      kind: z.enum(['user', 'group', 'role']),
      id: z.number().int().positive(),
    })
    .strict(),
  dueInHours: z.number().int().positive().max(8760), // au plus un an
  maxEscalations: z.number().int().min(1).max(5).optional(),
  message: z.string().max(500).optional(),
});
export type WfEscalationConfig = z.infer<typeof wfEscalationConfigSchema>;

// ---------------------------------------------------------------------------
// Agents (lot W2) — constantes partagées (ajout rétro-compatible)
// ---------------------------------------------------------------------------

/**
 * Plancher de précision d'un jeu d'évaluation : l'application refuse un `min_accuracy` inférieur
 * (le SQL accepte 0..1). Hypothèse métier prudente, réversible : modifier cette seule constante.
 */
export const WF_EVAL_ACCURACY_FLOOR = 0.8;

/**
 * Configuration d'une étape agent sur le BROUILLON (route `PUT /workflows/definitions/:id/draft/agents/:stepKey`).
 * Les champs communs au graphe (`objective`, `tools`, `confidenceThreshold`, `autonomy`, `model`, `maxSteps`,
 * `maxCostPerRun`) sont écrits dans le graphe (source de vérité) ET dans la ligne `wf_agent_config` ; `timeoutSeconds`
 * et `evalSetId` ne vivent que dans la ligne. Bornes alignées sur les CHECK SQL. Champs inconnus refusés.
 */
export const upsertWfAgentConfigSchema = z
  .object({
    objective: z.string().trim().min(1).max(4000).optional(),
    tools: z
      .array(z.string().min(1).max(100).regex(WF_KEY_PATTERN, "clé d'outil invalide"))
      .max(100)
      .refine((tools) => new Set(tools).size === tools.length, {
        message: "la liste d'outils contient un doublon",
      })
      .optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    autonomy: z.enum(WF_AUTONOMY_KEYS).optional(),
    /** null = modèle de la configuration IA. */
    model: z.string().trim().min(1).max(200).nullable().optional(),
    maxSteps: z.number().int().min(1).max(50).optional(),
    /** null = pas de plafond de coût par exécution. */
    maxCostPerRun: z.number().min(0).nullable().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).optional(),
    /** null = délier le jeu d'évaluation. */
    evalSetId: z.number().int().positive().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'aucune modification fournie' });
export type UpsertWfAgentConfigInput = z.infer<typeof upsertWfAgentConfigSchema>;

/** Configuration d'agent d'une étape, avec ses outils (clés) et l'empreinte de son comportement. */
export interface WfAgentConfigDetailDto extends WfAgentConfigDto {
  tools: string[];
  /** Empreinte (`agentSpecHash`) de la configuration : comparée à celle du dernier run d'évaluation. */
  agentSpecHash: string;
}

// ---------------------------------------------------------------------------
// Docu-Flow W5 — création d'un workflow en langage naturel (ajouts rétro-compatibles).
// Routes : POST /workflows/authoring/generate, POST /workflows/authoring/explain/:definitionId.
// La description de l'utilisateur est une DONNÉE : elle n'est jamais une consigne pour le générateur.
// ---------------------------------------------------------------------------

export const WF_AUTHORING_DESCRIPTION_MAX = 4000;
export const WF_AUTHORING_DESCRIPTION_MIN = 10;

/** Clé réservée de `step.config` : marqueurs posés par le générateur (jamais lus par le moteur). */
export const WF_AUTHORING_MARKER_KEY = 'authoring';

export interface WfAuthoringGenerateInput {
  description: string;
  /** Type d'événement évoqué par l'utilisateur (suggestion de déclencheur ; rien n'est créé). */
  triggerHint?: string;
}

/** Problème renvoyé avec un brouillon généré (même forme que les problèmes de validation de l'éditeur). */
export interface WfAuthoringIssue {
  code: string;
  message: string;
  stepKey?: string;
  path?: (string | number)[];
}

/** Élément laissé « à compléter » par le générateur (aucun identifiant n'est jamais inventé). */
export interface WfAuthoringToDoItem {
  stepKey: string;
  stepName: string;
  /** Ce qui reste à renseigner. */
  what: 'assignee';
  /** Libellé lu dans la description (ex. « DAF »), jamais un identifiant. */
  hint: string | null;
}

/** Suggestion de déclencheur : JAMAIS créée automatiquement (conditions du catalogue de W3). */
export interface WfAuthoringTriggerSuggestion {
  eventType: string;
  label: string;
  /** Conditions structurées au format `wf_trigger.conditions` (sans identifiant inventé). */
  conditions: Record<string, unknown>;
  reason: string;
  /** Éléments à compléter avant de créer le déclencheur (ex. `threshold.metaDataId`). */
  incomplete: string[];
}

export interface WfAuthoringGenerateResponse {
  definitionId: number;
  name: string;
  graph: WfGraph;
  issues: WfAuthoringIssue[];
  /** Hypothèses à relire (montants, seuils, choix du générateur). */
  assumptions: string[];
  toComplete: WfAuthoringToDoItem[];
  triggerSuggestion: WfAuthoringTriggerSuggestion | null;
}

export interface WfAuthoringExplanation {
  definitionId: number;
  versionNumber: number;
  /** Résumé en français (texte brut). */
  summary: string;
  steps: Array<{ key: string; name: string; text: string }>;
  toComplete: WfAuthoringToDoItem[];
}

/** W6 (contrat consommé par le web) : `GET /workflows/templates`. */
export interface WfTemplateSummary {
  key: string;
  name: string;
  description: string;
  agentKey: string | null;
  tags: string[];
}
