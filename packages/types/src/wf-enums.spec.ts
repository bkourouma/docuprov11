import * as E from './wf-enums';

const FAMILIES: Array<[string, Record<string, number>, readonly number[], Record<number, string>]> = [
  ['DefinitionStatus', E.WfDefinitionStatus, E.WF_DEFINITION_STATUS_VALUES, E.WF_DEFINITION_STATUS_LABELS],
  ['DefinitionVersionStatus', E.WfDefinitionVersionStatus, E.WF_DEFINITION_VERSION_STATUS_VALUES, E.WF_DEFINITION_VERSION_STATUS_LABELS],
  ['DefinitionSource', E.WfDefinitionSource, E.WF_DEFINITION_SOURCE_VALUES, E.WF_DEFINITION_SOURCE_LABELS],
  ['InstanceStatus', E.WfInstanceStatus, E.WF_INSTANCE_STATUS_VALUES, E.WF_INSTANCE_STATUS_LABELS],
  ['TaskType', E.WfTaskType, E.WF_TASK_TYPE_VALUES, E.WF_TASK_TYPE_LABELS],
  ['TaskStatus', E.WfTaskStatus, E.WF_TASK_STATUS_VALUES, E.WF_TASK_STATUS_LABELS],
  ['TaskPriority', E.WfTaskPriority, E.WF_TASK_PRIORITY_VALUES, E.WF_TASK_PRIORITY_LABELS],
  ['TimerKind', E.WfTimerKind, E.WF_TIMER_KIND_VALUES, E.WF_TIMER_KIND_LABELS],
  ['TimerStatus', E.WfTimerStatus, E.WF_TIMER_STATUS_VALUES, E.WF_TIMER_STATUS_LABELS],
  ['ActorKind', E.WfActorKind, E.WF_ACTOR_KIND_VALUES, E.WF_ACTOR_KIND_LABELS],
  ['AutonomyLevel', E.WfAutonomyLevel, E.WF_AUTONOMY_LEVEL_VALUES, E.WF_AUTONOMY_LEVEL_LABELS],
  ['ToolSideEffect', E.WfToolSideEffect, E.WF_TOOL_SIDE_EFFECT_VALUES, E.WF_TOOL_SIDE_EFFECT_LABELS],
  ['BudgetPeriodKind', E.WfBudgetPeriodKind, E.WF_BUDGET_PERIOD_KIND_VALUES, E.WF_BUDGET_PERIOD_KIND_LABELS],
  ['EvalRunStatus', E.WfEvalRunStatus, E.WF_EVAL_RUN_STATUS_VALUES, E.WF_EVAL_RUN_STATUS_LABELS],
  ['InboxItemKind', E.WfInboxItemKind, E.WF_INBOX_ITEM_KIND_VALUES, E.WF_INBOX_ITEM_KIND_LABELS],
  ['InboxItemStatus', E.WfInboxItemStatus, E.WF_INBOX_ITEM_STATUS_VALUES, E.WF_INBOX_ITEM_STATUS_LABELS],
];

describe('wf-enums : cohérence des familles', () => {
  it.each(FAMILIES)('%s : valeurs uniques, tableau complet, libellé pour chaque valeur', (_n, obj, values, labels) => {
    const fromObject = Object.values(obj);
    expect(new Set(fromObject).size).toBe(fromObject.length);
    expect([...values].sort()).toEqual([...fromObject].sort());
    for (const v of values) {
      expect(typeof labels[v]).toBe('string');
      expect(labels[v]?.length).toBeGreaterThan(0);
    }
  });

  it('valeurs exactes (miroir des CHECK SQL)', () => {
    expect(E.WF_INSTANCE_STATUS_VALUES).toEqual([0, 1, 2, 3, 4, 5]);
    expect(E.WF_TASK_TYPE_VALUES).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(E.WfInstanceStatus.Suspended).toBe(5);
    expect(E.WfToolSideEffect.ExternalIrreversible).toBe(2);
  });

  it('type guards', () => {
    expect(E.isWfInstanceStatus(5)).toBe(true);
    expect(E.isWfInstanceStatus(6)).toBe(false);
    expect(E.isWfInstanceStatus('1')).toBe(false);
    expect(E.isWfTaskPriority(2)).toBe(true);
  });

  it('clés texte : index = valeur numérique', () => {
    E.WF_TASK_TYPE_KEYS.forEach((key, i) => {
      expect(E.wfTaskTypeFromKey(key)).toBe(i);
      expect(E.wfTaskTypeToKey(i as E.WfTaskType)).toBe(key);
    });
    expect(E.WF_TASK_TYPE_KEYS).toHaveLength(E.WF_TASK_TYPE_VALUES.length);
    expect(E.wfTaskTypeFromKey('agent')).toBe(E.WfTaskType.Agent);
    E.WF_AUTONOMY_KEYS.forEach((key, i) => {
      expect(E.wfAutonomyFromKey(key)).toBe(i);
      expect(E.wfAutonomyToKey(i as E.WfAutonomyLevel)).toBe(key);
    });
    expect(E.WF_AUTONOMY_KEYS).toHaveLength(E.WF_AUTONOMY_LEVEL_VALUES.length);
    expect(E.isWfTaskTypeKey('agent')).toBe(true);
    expect(E.isWfAutonomyKey('inconnu')).toBe(false);
  });
});

describe('isWfInstanceTerminal', () => {
  it('statuts terminaux = 2, 3, 4', () => {
    expect(E.WF_INSTANCE_TERMINAL_STATUSES).toEqual([2, 3, 4]);
    expect(E.isWfInstanceTerminal(E.WfInstanceStatus.Completed)).toBe(true);
    expect(E.isWfInstanceTerminal(E.WfInstanceStatus.Failed)).toBe(true);
    expect(E.isWfInstanceTerminal(E.WfInstanceStatus.Cancelled)).toBe(true);
    expect(E.isWfInstanceTerminal(E.WfInstanceStatus.Running)).toBe(false);
    expect(E.isWfInstanceTerminal(E.WfInstanceStatus.Waiting)).toBe(false);
    expect(E.isWfInstanceTerminal(E.WfInstanceStatus.Suspended)).toBe(false);
  });
});

describe('checkAutonomyAllowed', () => {
  it('autonome sans faible risque : refusé', () => {
    const r = E.checkAutonomyAllowed({ level: E.WfAutonomyLevel.Autonomous, isLowRisk: false, hasPassedEvalRun: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('autonome sans évaluation réussie : refusé', () => {
    const r = E.checkAutonomyAllowed({ level: E.WfAutonomyLevel.Autonomous, isLowRisk: true, hasPassedEvalRun: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });
  it('autonome avec faible risque et évaluation réussie : permis', () => {
    expect(
      E.checkAutonomyAllowed({ level: E.WfAutonomyLevel.Autonomous, isLowRisk: true, hasPassedEvalRun: true }),
    ).toEqual({ allowed: true });
  });
  it('autres niveaux : toujours permis', () => {
    for (const level of [E.WfAutonomyLevel.Suggest, E.WfAutonomyLevel.ActWithValidation]) {
      expect(E.checkAutonomyAllowed({ level, isLowRisk: false, hasPassedEvalRun: false }).allowed).toBe(true);
    }
  });
});

describe('confidenceRequiresHuman', () => {
  it('null, undefined ou sous le seuil : humain requis', () => {
    expect(E.confidenceRequiresHuman(null, 0.8)).toBe(true);
    expect(E.confidenceRequiresHuman(undefined, 0.8)).toBe(true);
    expect(E.confidenceRequiresHuman(0.79, 0.8)).toBe(true);
  });
  it('au seuil ou au-dessus : pas requis', () => {
    expect(E.confidenceRequiresHuman(0.8, 0.8)).toBe(false);
    expect(E.confidenceRequiresHuman(0.95, 0.8)).toBe(false);
  });
});
