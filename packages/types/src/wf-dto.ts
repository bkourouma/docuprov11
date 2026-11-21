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
import { WF_DEFINITION_SOURCE_VALUES } from './wf-enums';
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
