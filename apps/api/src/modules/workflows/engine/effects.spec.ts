import type { PrismaClient } from '@prisma/client';
import { WfEffectApplierHolder } from './effect-applier';
import { WorkflowEngine } from './engine';
import {
  WfEffectApplyError,
  WfEngineError,
  type WfEffectApplierPort,
  type WfEffectApplyInput,
  type WfEffectApplyOutput,
  type WfPrincipal,
} from './engine.types';

// Lot W6 — applicateur d'effets appelé par le moteur à la validation humaine d'une proposition d'agent
// (transaction simulée : `$transaction` exécute la fonction avec un faux client). Le comportement
// transactionnel réel (rollback) est couvert par workflow-agent-catalog/appliers/appliers.integration.spec.ts.

const NOW = new Date('2026-11-22T09:00:00.000Z');
const VALIDATOR: WfPrincipal = { userGroupId: 20, userId: 21, groupIds: [3], roleId: 7 };

const imputation = {
  tool: 'proposer_imputation_courrier',
  arguments: { mailId: 5, recipients: [{ userGroupId: 30, mailInputationTypeId: 10 }], rationale: 'Service RH' },
  sideEffect: 1,
  requiresValidation: true,
  preview: 'Imputer le courrier 5 à 30',
};
const relance = {
  tool: 'proposer_relance',
  arguments: { mailId: 5, mailInputationId: 8, recipientUserGroupId: 30, message: 'Rappel' },
  sideEffect: 1,
  requiresValidation: true,
  preview: 'Relancer 30',
};

const actionProposal = (over: Record<string, unknown> = {}) => ({
  mode: 'action',
  result: { service: 'RH' },
  preparedActions: [imputation],
  suspicion_injection: false,
  autonomy: 1,
  reason: 'validation_required',
  ...over,
});

function setup(opts: {
  proposal?: unknown;
  stepType?: string;
  port?: WfEffectApplierPort | null;
  conflict?: boolean;
} = {}) {
  const graph = {
    schemaVersion: 1,
    start: 'ia',
    steps: [
      {
        key: 'ia',
        name: 'Analyse',
        type: opts.stepType ?? 'agent',
        assignee: { kind: 'user', id: 20 },
        config: { delegates: [{ userGroupId: 44 }] },
        ...(opts.stepType && opts.stepType !== 'agent'
          ? {}
          : { agent: { objective: 'Imputer', tools: [], confidenceThreshold: 0.8, autonomy: 'agit_avec_validation' } }),
        next: [],
      },
    ],
  };
  const instanceRow = {
    wfInstanceId: 1n,
    definitionId: 5,
    definitionVersionId: 50,
    status: 1,
    context: { input: { draftSpaceId: 4 }, steps: {}, last: null },
    startedBy: 10,
    triggerId: null,
    parentInstanceId: null,
    subjectType: 'mail',
    subjectId: 5n,
    idempotencyKey: null,
    dueAt: null,
    errorMessage: null,
    rowVersion: 3,
    startedAt: NOW,
    finishedAt: null,
    updatedAt: NOW,
  };
  const taskRow = {
    wfTaskId: 9n,
    instanceId: 1n,
    stepKey: 'ia',
    taskType: 6,
    status: 0,
    title: 'Analyse',
    instructions: null,
    priority: 1,
    assigneeUserGroupId: 20,
    assigneeGroupId: null,
    assigneeRoleId: null,
    dueAt: null,
    attempt: 1,
    input: null,
    result: null,
    startedAt: null,
    completedAt: null,
    completedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const proposal = opts.proposal === undefined ? actionProposal() : opts.proposal;
  const items = [{ wfInboxItemId: 77n, kind: 1, status: 0, claimedBy: null, proposal, confidence: 0.9 }];
  const order: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ row_version: 3 }]),
    wfTask: {
      findUnique: jest.fn(async () => taskRow),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        order.push('task.update');
        return { ...taskRow, ...data };
      }),
    },
    wfInstance: {
      findUniqueOrThrow: jest.fn(async () => instanceRow),
      updateMany: jest.fn(async () => ({ count: opts.conflict ? 0 : 1 })),
    },
    wfDefinitionVersion: { findUniqueOrThrow: jest.fn(async () => ({ graph, definition: { name: 'Courrier' } })) },
    wfInboxItem: {
      findMany: jest.fn(async () => items),
      update: jest.fn(async () => ({})),
    },
    wfTimer: { updateMany: jest.fn(async () => ({ count: 0 })) },
    wfEventLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        logged.push(data);
        order.push(`log:${String(data.eventType)}`);
        return { wfEventLogId: BigInt(logged.length) };
      }),
    },
  };
  const prisma = {
    wfTask: { findUnique: jest.fn(async () => ({ instanceId: 1n })) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  const holder = new WfEffectApplierHolder();
  if (opts.port !== null) {
    holder.set(
      opts.port ?? {
        apply: jest.fn(async (input: WfEffectApplyInput): Promise<WfEffectApplyOutput> => {
          order.push('apply');
          return { effects: input.actions.map((a) => ({ tool: a.tool, summary: { status: 'applied', mailId: 5 } })) };
        }),
      },
    );
  }
  const backgroundErrors: Array<{ stage: string }> = [];
  const engine = new WorkflowEngine(prisma, {
    now: () => NOW,
    effects: holder,
    onBackgroundError: (_e, ctx) => backgroundErrors.push(ctx),
  });
  const port = holder.get() as { apply: jest.Mock } | undefined;
  return { engine, tx, logged, order, port, proposal, backgroundErrors };
}

const clone = (v: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
const types = (logged: Array<Record<string, unknown>>) => logged.map((e) => e.eventType);

describe('WorkflowEngine — application des actions validées (lot W6)', () => {
  it('« accepted » : actions de la proposition STOCKÉE appliquées dans la transaction, avec valideur et lanceur', async () => {
    const { engine, tx, logged, order, port, proposal } = setup();
    await engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(proposal) });
    expect(port!.apply).toHaveBeenCalledTimes(1);
    const input = port!.apply.mock.calls[0][0] as WfEffectApplyInput;
    expect(input.tx).toBe(tx);
    expect(input).toMatchObject({
      now: NOW,
      instanceId: '1',
      taskId: '9',
      stepKey: 'ia',
      definitionVersionId: 50,
      subject: { type: 'mail', id: '5' },
      input: { draftSpaceId: 4 },
      stepConfig: { delegates: [{ userGroupId: 44 }] },
      validator: VALIDATOR,
      launcherUserGroupId: 10,
      outcome: 'accepted',
    });
    expect(input.actions).toEqual([imputation]);
    // Application et journal AVANT la clôture de la tâche, dans la même transaction.
    expect(order.indexOf('apply')).toBeLessThan(order.indexOf('task.update'));
    expect(types(logged).indexOf('agent.acted')).toBeLessThan(types(logged).indexOf('task.completed'));
    const acted = logged.find((e) => e.eventType === 'agent.acted')!;
    expect(acted).toMatchObject({
      actorKind: 2,
      taskId: 9n,
      stepKey: 'ia',
      validatedBy: 20,
      validatedAt: NOW,
      decision: {
        kind: 'effects_applied',
        effects: [{ tool: 'proposer_imputation_courrier', summary: { status: 'applied', mailId: 5 } }],
        validatedBy: 20,
        outcome: 'accepted',
        itemId: '77',
      },
    });
    expect(String(acted.explanation)).toContain('proposer_imputation_courrier');
    expect(types(logged)).toContain('validation.accepted');
  });

  it('« modified » : `result.preparedActions` appliquées si chaque outil figure dans la proposition stockée', async () => {
    const { engine, port, proposal } = setup();
    const changed = { ...imputation, arguments: { ...imputation.arguments, recipients: [{ userGroupId: 31, mailInputationTypeId: 10 }] } };
    await engine.completeTask({
      taskId: '9',
      principal: VALIDATOR,
      result: { ...(proposal as Record<string, unknown>), preparedActions: [changed] },
    });
    const input = port!.apply.mock.calls[0][0] as WfEffectApplyInput;
    expect(input.outcome).toBe('modified');
    expect(input.actions).toEqual([changed]);
  });

  it('« modified » : un NOUVEL outil (ou un outil en surnombre) => INVALID_INPUT, rien appliqué ni clôturé', async () => {
    const { engine, port, tx, proposal } = setup();
    const p = proposal as Record<string, unknown>;
    await expect(
      engine.completeTask({ taskId: '9', principal: VALIDATOR, result: { ...p, preparedActions: [relance] } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { code: 'action_not_proposed', tool: 'proposer_relance' } });
    await expect(
      engine.completeTask({ taskId: '9', principal: VALIDATOR, result: { ...p, preparedActions: [imputation, imputation] } }),
    ).rejects.toBeInstanceOf(WfEngineError);
    await expect(
      engine.completeTask({ taskId: '9', principal: VALIDATOR, result: { ...p, preparedActions: 'tout' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(port!.apply).not.toHaveBeenCalled();
    expect(tx.wfTask.update).not.toHaveBeenCalled();
  });

  it('« modified » sans `preparedActions` : rien appliqué, validation enregistrée', async () => {
    const { engine, port, logged } = setup();
    await engine.completeTask({ taskId: '9', principal: VALIDATOR, result: { service: 'Finances' } });
    expect(port!.apply).not.toHaveBeenCalled();
    expect(types(logged)).not.toContain('agent.acted');
    expect(types(logged)).toContain('validation.modified');
  });

  it('jamais pour un refus, une suggestion (niveau 0), une suspicion d’injection ou une étape non agent', async () => {
    const rejected = setup();
    await rejected.engine.rejectTask({ taskId: '9', principal: VALIDATOR, comment: 'Non' });
    expect(rejected.port!.apply).not.toHaveBeenCalled();

    const suggestion = setup({
      proposal: { mode: 'suggestion', result: {}, suggestedActions: [imputation], suspicion_injection: false, autonomy: 0 },
    });
    await suggestion.engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(suggestion.proposal) });
    expect(suggestion.port!.apply).not.toHaveBeenCalled();

    const suspicious = setup({ proposal: actionProposal({ suspicion_injection: true }) });
    await suspicious.engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(suspicious.proposal) });
    expect(suspicious.port!.apply).not.toHaveBeenCalled();
    expect(types(suspicious.logged)).not.toContain('agent.acted');

    const flagMissing = setup({ proposal: { mode: 'action', result: {}, preparedActions: [imputation] } });
    await flagMissing.engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(flagMissing.proposal) });
    expect(flagMissing.port!.apply).not.toHaveBeenCalled();
  });

  it('sans applicateur branché et des actions à appliquer : refus `no_applier`, rien clôturé (échec fermé)', async () => {
    const { engine, tx, proposal } = setup({ port: null });
    await expect(engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(proposal) })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('proposer_imputation_courrier'),
      details: { code: 'no_applier', tool: 'proposer_imputation_courrier' },
    });
    expect(tx.wfTask.update).not.toHaveBeenCalled();
    expect(tx.wfEventLog.create).not.toHaveBeenCalled();
  });

  it('sans applicateur branché : niveau 0 et proposition sans action inchangés (validation enregistrée, aucune erreur)', async () => {
    const suggestion = setup({
      port: null,
      proposal: { mode: 'suggestion', result: {}, suggestedActions: [imputation], suspicion_injection: false, autonomy: 0 },
    });
    await suggestion.engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(suggestion.proposal) });
    expect(types(suggestion.logged)).toEqual(expect.arrayContaining(['task.completed', 'validation.accepted']));
    expect(types(suggestion.logged)).not.toContain('agent.acted');

    const empty = setup({ port: null, proposal: actionProposal({ preparedActions: [] }) });
    await empty.engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(empty.proposal) });
    expect(types(empty.logged)).toContain('validation.accepted');

    const withPort = setup({ proposal: actionProposal({ preparedActions: [] }) });
    await withPort.engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(withPort.proposal) });
    expect(withPort.port!.apply).not.toHaveBeenCalled();
    expect(types(withPort.logged)).not.toContain('agent.acted');
  });

  it('filet : un effet `skipped` renvoyé par l’applicateur => refus `no_applier`, compensations collectées appelées', async () => {
    const compensate = jest.fn(async () => undefined);
    const { engine, tx } = setup({
      proposal: actionProposal({ preparedActions: [imputation, relance] }),
      port: {
        apply: async () => ({
          effects: [
            { tool: 'proposer_imputation_courrier', summary: { created: [1] } },
            { tool: 'proposer_relance', summary: { status: 'skipped' }, skipped: true },
          ],
          compensate,
        }),
      },
    });
    await expect(
      engine.completeTask({ taskId: '9', principal: VALIDATOR, result: actionProposal({ preparedActions: [imputation, relance] }) }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { code: 'no_applier', tool: 'proposer_relance' } });
    expect(tx.wfTask.update).not.toHaveBeenCalled();
    expect(tx.wfEventLog.create).not.toHaveBeenCalled();
    await engine.whenIdle();
    expect(compensate).toHaveBeenCalledTimes(1);
  });

  it('refus de l’applicateur : INVALID_INPUT expliqué, rien clôturé, compensations portées par l’erreur appelées', async () => {
    const compensate = jest.fn(async () => undefined);
    const { engine, tx, proposal } = setup({
      port: {
        apply: async () => {
          throw new WfEffectApplyError('Le destinataire n°30 n’est pas imputable : aucune imputation.', 'recipient_not_imputable', 'proposer_imputation_courrier', compensate);
        },
      },
    });
    const p = engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(proposal) });
    await expect(p).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Le destinataire n°30 n’est pas imputable : aucune imputation.',
      details: { code: 'recipient_not_imputable', tool: 'proposer_imputation_courrier' },
    });
    expect(tx.wfTask.update).not.toHaveBeenCalled();
    expect(tx.wfEventLog.create).not.toHaveBeenCalled();
    await engine.whenIdle();
    expect(compensate).toHaveBeenCalledTimes(1);
  });

  it('erreur technique de l’applicateur : message générique (jamais le texte de l’erreur)', async () => {
    const { engine, proposal } = setup({
      port: {
        apply: async () => {
          throw new Error('contenu confidentiel du courrier');
        },
      },
    });
    const p = engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(proposal) });
    await expect(p).rejects.toMatchObject({ code: 'INVALID_INPUT', details: { code: 'effect_failed' } });
    await expect(p).rejects.not.toMatchObject({ message: expect.stringContaining('confidentiel') });
  });

  it('transaction en échec APRÈS application (conflit de version) : compensation appelée, jamais bloquante', async () => {
    const compensate = jest.fn(async () => {
      throw new Error('échec de compensation');
    });
    const { engine, proposal, backgroundErrors } = setup({
      conflict: true,
      port: { apply: async (i) => ({ effects: i.actions.map((a) => ({ tool: a.tool, summary: {} })), compensate }) },
    });
    await expect(
      engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(proposal) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await engine.whenIdle();
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(backgroundErrors).toEqual([expect.objectContaining({ stage: 'compensation', taskId: '9' })]);
  });

  it('transaction réussie : la compensation n’est jamais appelée', async () => {
    const compensate = jest.fn(async () => undefined);
    const { engine, proposal } = setup({
      port: { apply: async (i) => ({ effects: i.actions.map((a) => ({ tool: a.tool, summary: {} })), compensate }) },
    });
    await engine.completeTask({ taskId: '9', principal: VALIDATOR, result: clone(proposal) });
    await engine.whenIdle();
    expect(compensate).not.toHaveBeenCalled();
  });
});
