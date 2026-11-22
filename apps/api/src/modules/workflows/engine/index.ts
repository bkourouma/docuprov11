// Docu-Flow — point d'entrée du moteur (lot W1).
export { WorkflowEngine, toEventDto, toInboxDto, toInstanceDto, toTaskDto } from './engine';
export type { WorkflowEngineDeps } from './engine';
export { WfExecutorRegistry } from './executor-registry';
export { WF_EFFECT_ACTIONS_MAX, WfEffectApplierHolder, selectValidatedActions } from './effect-applier';
export {
  WF_AUTO_CHAIN_LIMIT,
  WF_DEFAULT_MAX_ATTEMPTS,
  WF_MAX_ATTEMPTS_CEILING,
  WF_RESULT_MAX_BYTES,
  applyStepResult,
  boundJson,
  buildTaskSpec,
  chooseNextEdge,
  evaluateCondition,
  isAutomaticDecision,
  isHumanStep,
  isTaskAssignee,
  normalizeContext,
  readPath,
  resolveAssignee,
  resolveMaxAttempts,
  summarizeResultForLog,
  validateTaskResult,
} from './interpreter';
export type {
  WfAssigneeSource,
  WfCondition,
  WfEdgeChoice,
  WfEdgeMode,
  WfInstanceContext,
  WfResultValidation,
  WfTaskSpec,
  WfTaskSpecInput,
} from './interpreter';
export * from './engine.types';
