import type { PrismaClient } from '@prisma/client';
import { WorkflowEngine, normalizeAudit, normalizeOutcome } from './engine';
import { WfEngineError, type WfEngineErrorCode, type WfPrincipal } from './engine.types';
import { WfExecutorRegistry } from './executor-registry';

// Tests SANS base : validation des entrées AVANT tout accès (un faux PrismaClient qui échoue au moindre
// accès le prouve) et forme de la requête de boîte (bénéficiaires seulement). Le comportement
// transactionnel réel est couvert par engine.integration.spec.ts (PostgreSQL jetable).

/** PrismaClient piégé : toute propriété lue fait échouer le test. */
function trapPrisma(): PrismaClient {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        throw new Error(`accès inattendu à la base : ${String(prop)}`);
      },
    },
  ) as PrismaClient;
}

async function expectCode(promise: Promise<unknown>, code: WfEngineErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(WfEngineError);
  await expect(promise).rejects.toMatchObject({ code });
}

const principal: WfPrincipal = { userGroupId: 10, userId: 1, groupIds: [3], roleId: 7 };

describe('WorkflowEngine — entrées refusées avant tout accès à la base', () => {
  const engine = new WorkflowEngine(trapPrisma());

  it('startInstance : identifiants, données d’entrée, objet lié, clé d’idempotence, échéance', async () => {
    await expectCode(engine.startInstance({ definitionId: 0, startedBy: 10 }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 1.5 }), 'INVALID_INPUT');
    await expectCode(
      engine.startInstance({ definitionId: 1, startedBy: 10, context: [1] as unknown as Record<string, unknown> }),
      'INVALID_INPUT',
    );
    await expectCode(
      engine.startInstance({ definitionId: 1, startedBy: 10, context: { blob: 'x'.repeat(300_000) } }),
      'INVALID_INPUT',
    );
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, subjectType: 'mail' }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, subjectId: '4' }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, subjectType: 'Mail!', subjectId: '4' }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, subjectType: 'mail', subjectId: '-4' }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, idempotencyKey: 'k'.repeat(201) }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, dueAt: new Date('invalide') }), 'INVALID_INPUT');
    await expectCode(engine.startInstance({ definitionId: 1, startedBy: 10, triggerId: -1 }), 'INVALID_INPUT');
  });

  it('actions sur une tâche : identifiant illisible => NOT_FOUND, principal invalide => FORBIDDEN', async () => {
    await expectCode(engine.claimTask({ taskId: 'abc', principal }), 'NOT_FOUND');
    await expectCode(engine.completeTask({ taskId: '0', principal, result: {} }), 'NOT_FOUND');
    await expectCode(engine.rejectTask({ taskId: '99999999999999999999', principal }), 'NOT_FOUND');
    await expectCode(engine.claimTask({ taskId: '1', principal: { ...principal, userGroupId: 0 } }), 'FORBIDDEN');
    await expectCode(engine.claimTask({ taskId: '1', principal: { ...principal, roleId: -2 } }), 'FORBIDDEN');
    await expectCode(engine.completeTask({ taskId: '1', principal, result: {}, expectedRowVersion: -1 }), 'INVALID_INPUT');
    await expectCode(engine.listInbox({ ...principal, userGroupId: Number.NaN }, { limit: 10, offset: 0 }), 'FORBIDDEN');
  });

  it('cycle de vie : auteur invalide ou utilisateur sans identifiant refusé', async () => {
    await expectCode(engine.cancelInstance({ instanceId: '1', actor: { kind: 'user' } }), 'INVALID_INPUT');
    await expectCode(engine.suspendInstance({ instanceId: '1', actor: { kind: 'robot' as 'system' } }), 'INVALID_INPUT');
    await expectCode(engine.resumeInstance({ instanceId: '1', actor: { kind: 'system', userGroupId: 0 } }), 'INVALID_INPUT');
    await expectCode(engine.cancelInstance({ instanceId: 'x', actor: { kind: 'system' } }), 'NOT_FOUND');
  });

  it('lecture : identifiant illisible => null sans accès ; rescan sans exécuteur => 0', async () => {
    expect(await engine.getInstanceDetail('12a')).toBeNull();
    expect(await engine.rescanExecutors()).toBe(0);
    expect(await new WorkflowEngine(trapPrisma(), { registry: new WfExecutorRegistry() }).rescanExecutors()).toBe(0);
  });
});

describe('WorkflowEngine.listInbox — uniquement les éléments dont l’utilisateur est bénéficiaire', () => {
  function setup() {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const prisma = { wfInboxItem: { findMany, count } } as unknown as PrismaClient;
    return { engine: new WorkflowEngine(prisma), findMany, count };
  }

  it('utilisateur + groupes + rôle actif, statuts ouverts par défaut, tri priorité / échéance / création', async () => {
    const { engine, findMany, count } = setup();
    await engine.listInbox({ userGroupId: 10, userId: 1, groupIds: [3, 3, 4], roleId: 7 }, { limit: 20, offset: 5 });
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      status: { in: [0, 1] },
      OR: [{ assigneeUserGroupId: 10 }, { assigneeGroupId: { in: [3, 4] } }, { assigneeRoleId: 7 }],
    });
    expect(args.orderBy).toEqual([
      { priority: 'desc' },
      { dueAt: { sort: 'asc', nulls: 'last' } },
      { createdAt: 'asc' },
      { wfInboxItemId: 'asc' },
    ]);
    expect(args).toMatchObject({ take: 20, skip: 5 });
    expect(count.mock.calls[0][0]).toEqual({ where: args.where });
  });

  it('sans groupe ni rôle : seulement l’utilisateur ; aucun pouvoir implicite d’administrateur', async () => {
    const { engine, findMany } = setup();
    await engine.listInbox({ userGroupId: 1, userId: 1, groupIds: [], roleId: null }, { statuses: [2], limit: 500, offset: -3 });
    const args = findMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: { in: [2] }, OR: [{ assigneeUserGroupId: 1 }] });
    expect(args).toMatchObject({ take: 200, skip: 0 });
  });

  it('filtre de statut invalide refusé', async () => {
    const { engine, findMany } = setup();
    await expectCode(engine.listInbox(principal, { statuses: [9], limit: 10, offset: 0 }), 'INVALID_INPUT');
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lot W2 : audit des agents et validation des propositions (transaction simulée)
// ---------------------------------------------------------------------------

describe('normalizeAudit / normalizeOutcome — audit d’agent', () => {
  it('retient les champs valides, ignore les inconnus et les types faux', () => {
    const audit = normalizeAudit({
      instruction: 'Résumer le courrier',
      sources: [{ kind: 'document', id: 4 }],
      decision: { classe: 'facture' },
      confidence: 0.91,
      autonomyLevel: 1,
      model: ' gpt-x ',
      aiDecisionId: '123',
      promptTokens: 10,
      completionTokens: 5,
      costAmount: 0.0123,
      inconnu: 'ignoré',
    });
    expect(audit).toEqual({
      instruction: 'Résumer le courrier',
      sources: [{ kind: 'document', id: 4 }],
      decision: { classe: 'facture' },
      confidence: 0.91,
      autonomyLevel: 1,
      model: 'gpt-x',
      aiDecisionId: '123',
      promptTokens: 10,
      completionTokens: 5,
      costAmount: 0.0123,
    });
    expect(
      normalizeAudit({
        instruction: 3,
        confidence: 1.5,
        autonomyLevel: 3,
        model: 7,
        aiDecisionId: '12a',
        promptTokens: -1,
        completionTokens: 1.5,
        costAmount: Number.NaN,
      }),
    ).toEqual({});
    expect(normalizeAudit({ aiDecisionId: '9223372036854775808' })).toEqual({});
    expect(normalizeAudit({ costAmount: 1e12 })).toEqual({});
    expect(normalizeAudit('x')).toBeUndefined();
    expect(normalizeAudit([1])).toBeUndefined();
  });

  it('complete / propose portent l’audit ; wait n’accepte l’escalade que bien formée', () => {
    expect(normalizeOutcome({ kind: 'complete', result: 1, audit: { model: 'm' } })).toMatchObject({
      kind: 'complete',
      audit: { model: 'm' },
    });
    expect(normalizeOutcome({ kind: 'propose', proposal: 1, audit: { autonomyLevel: 0 } })).toMatchObject({
      kind: 'propose',
      audit: { autonomyLevel: 0 },
    });
    expect(normalizeOutcome({ kind: 'wait' })).toEqual({ kind: 'wait' });
    expect(normalizeOutcome({ kind: 'wait', escalation: { reason: 'budget', explanation: 'Plafond atteint' } })).toEqual({
      kind: 'wait',
      escalation: { reason: 'budget', explanation: 'Plafond atteint', audit: undefined },
    });
    expect(normalizeOutcome({ kind: 'wait', escalation: { reason: '  ', explanation: 'x' } })).toEqual({ kind: 'wait' });
    expect(normalizeOutcome({ kind: 'wait', escalation: 'oups' })).toEqual({ kind: 'wait' });
  });
});

describe('WorkflowEngine — journal d’audit des agents (transaction simulée)', () => {
  const NOW = new Date('2026-11-21T10:00:00.000Z');
  const graph = {
    schemaVersion: 1,
    start: 'ia',
    steps: [
      {
        key: 'ia',
        name: 'Analyse',
        type: 'agent',
        agent: { objective: 'Classer', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' },
        next: [],
      },
    ],
  };
  const instanceRow = {
    wfInstanceId: 1n,
    definitionId: 5,
    definitionVersionId: 50,
    status: 0,
    context: { input: {}, steps: {}, last: null },
    startedBy: 10,
    triggerId: null,
    parentInstanceId: null,
    subjectType: null,
    subjectId: null,
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

  function setup(items: Array<Record<string, unknown>> = []) {
    const logged: Array<Record<string, unknown>> = [];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ row_version: 3 }]),
      wfTask: {
        findUnique: jest.fn(async (args: { select?: unknown }) => (args.select ? { instanceId: 1n } : taskRow)),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...taskRow, ...data })),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...taskRow, wfTaskId: 10n, ...data })),
      },
      wfInstance: {
        findUniqueOrThrow: jest.fn(async () => instanceRow),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      wfDefinitionVersion: {
        findUniqueOrThrow: jest.fn(async () => ({ graph, definition: { name: 'Demande' } })),
      },
      wfInboxItem: {
        findMany: jest.fn(async () => items),
        update: jest.fn(async () => ({})),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, wfInboxItemId: 77n })),
      },
      wfTimer: { updateMany: jest.fn(async () => ({ count: 0 })), create: jest.fn() },
      wfEventLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          logged.push(data);
          return { wfEventLogId: BigInt(logged.length) };
        }),
      },
    };
    const engine = new WorkflowEngine({} as PrismaClient, { now: () => NOW });
    const apply = (outcome: unknown) =>
      (
        engine as unknown as {
          applyExecutorOutcome: (tx: unknown, id: bigint, attempt: number, key: string, o: unknown) => Promise<unknown>;
        }
      ).applyExecutorOutcome(tx, 9n, 1, 'agent', normalizeOutcome(outcome));
    return { tx, logged, apply, engine };
  }

  const fullAudit = {
    instruction: 'Classer le courrier',
    sources: [{ kind: 'document', id: 4 }],
    confidence: 0.93,
    autonomyLevel: 2,
    model: 'modele-x',
    aiDecisionId: '4242',
    promptTokens: 120,
    completionTokens: 30,
    costAmount: 0.0123,
  };

  it('complete d’agent : agent.acted est journalisé AVANT task.completed, avec tout l’audit', async () => {
    const { logged, apply } = setup();
    await apply({ kind: 'complete', result: { classe: 'facture' }, explanation: 'Courrier de facturation', audit: fullAudit });
    const types = logged.map((e) => e.eventType);
    expect(types.indexOf('agent.acted')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('agent.acted')).toBeLessThan(types.indexOf('task.completed'));
    const acted = logged.find((e) => e.eventType === 'agent.acted') as Record<string, unknown>;
    expect(acted).toMatchObject({
      actorKind: 2,
      taskId: 9n,
      stepKey: 'ia',
      instruction: 'Classer le courrier',
      autonomyLevel: 2,
      model: 'modele-x',
      aiDecisionId: 4242n,
      promptTokens: 120,
      completionTokens: 30,
      explanation: 'Courrier de facturation',
    });
    expect(String(acted.confidence)).toBe('0.93');
    expect(String(acted.costAmount)).toBe('0.0123');
    expect(acted.sources).toEqual([{ kind: 'document', id: 4 }]);
  });

  it('complete invalide : aucun agent.acted (erreur, puis passage à l’humain)', async () => {
    const { logged, apply } = setup();
    await apply({ kind: 'complete', result: 'pas un objet', audit: fullAudit });
    const types = logged.map((e) => e.eventType);
    expect(types).not.toContain('agent.acted');
    expect(types).toContain('executor.error');
  });

  it('propose : agent.proposed reçoit l’audit (confiance et sources de l’audit en repli)', async () => {
    const { logged, apply } = setup();
    await apply({ kind: 'propose', proposal: { classe: 'facture' }, explanation: 'Probable', audit: fullAudit });
    const proposed = logged.find((e) => e.eventType === 'agent.proposed') as Record<string, unknown>;
    expect(proposed).toMatchObject({
      instruction: 'Classer le courrier',
      autonomyLevel: 2,
      model: 'modele-x',
      aiDecisionId: 4242n,
      promptTokens: 120,
      completionTokens: 30,
    });
    expect(String(proposed.confidence)).toBe('0.93');
    expect(proposed.sources).toEqual([{ kind: 'document', id: 4 }]);
  });

  it('wait avec escalade : agent.escalated (raison, explication, audit) puis task.assigned', async () => {
    const { logged, apply, tx } = setup();
    await apply({
      kind: 'wait',
      escalation: {
        reason: 'confiance_insuffisante',
        explanation: 'Confiance 0,4 sous le seuil',
        audit: {
          model: 'm',
          costAmount: 0.5,
          decision: { suspicion_injection: true, suspicionReasons: ['outil:tool_not_allowed'], stopReason: 'tool_denied', toolCalls: [{ tool: 'envoyer_courrier', ok: false }], reason: 'écrasé' },
        },
      },
    });
    const types = logged.map((e) => e.eventType);
    expect(types.indexOf('agent.escalated')).toBeLessThan(types.indexOf('task.assigned'));
    const esc = logged.find((e) => e.eventType === 'agent.escalated') as Record<string, unknown>;
    expect(esc).toMatchObject({
      actorKind: 2,
      decision: {
        reason: 'confiance_insuffisante',
        suspicion_injection: true,
        stopReason: 'tool_denied',
        toolCalls: [{ tool: 'envoyer_courrier', ok: false }],
      },
      explanation: 'Confiance 0,4 sous le seuil',
      model: 'm',
    });
    expect(String(esc.costAmount)).toBe('0.5');
    expect(tx.wfInboxItem.create).toHaveBeenCalledTimes(1);
  });

  it('wait sans escalade : aucun agent.escalated, passage à l’humain inchangé', async () => {
    const { logged, apply } = setup();
    await apply({ kind: 'wait' });
    expect(logged.map((e) => e.eventType)).toEqual(['task.assigned']);
  });
});

describe('WorkflowEngine — validation d’une proposition d’agent par un humain', () => {
  const NOW = new Date('2026-11-21T10:00:00.000Z');
  const user = { kind: 'user' as const, userGroupId: 20 };

  function run(
    stepType: 'agent' | 'validation',
    proposal: unknown,
    result: Record<string, unknown>,
    mode: 'normal' | 'rejected',
  ) {
    const logged: Array<Record<string, unknown>> = [];
    const tx = {
      wfTask: { update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ wfTaskId: 9n, ...data })) },
      wfInboxItem: { update: jest.fn(async () => ({})) },
      wfTimer: { updateMany: jest.fn(async () => ({ count: 0 })) },
      wfEventLog: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          logged.push(data);
          return { wfEventLogId: BigInt(logged.length) };
        }),
      },
    };
    const engine = new WorkflowEngine({} as PrismaClient, { now: () => NOW });
    const step = { key: 's', name: 'Étape', type: stepType, next: [] };
    const graph = { schemaVersion: 1, start: 's', steps: [step] };
    const r = (engine as unknown as { newRun: (...a: unknown[]) => Record<string, unknown> }).newRun(
      tx,
      NOW,
      { wfInstanceId: 1n, startedBy: 10, status: 0, context: {}, rowVersion: 0 },
      graph,
      'Demande',
      0,
    );
    const scope = {
      task: { wfTaskId: 9n, taskType: 6, title: 'Étape', startedAt: null },
      step,
      items: [{ wfInboxItemId: 77n, kind: 1, proposal, confidence: 0.87 }],
      claimedBy: null,
    };
    return {
      logged,
      go: () =>
        (engine as unknown as { closeTaskAndAdvance: (...a: unknown[]) => Promise<void> }).closeTaskAndAdvance(r, scope, {
          result,
          actor: user,
          mode,
          comment: mode === 'rejected' ? 'Non conforme' : undefined,
        }),
    };
  }

  const validations = (logged: Array<Record<string, unknown>>) =>
    logged.filter((e) => String(e.eventType).startsWith('validation.'));

  it('résultat identique à la proposition => validation.accepted', async () => {
    const { logged, go } = run('agent', { a: 1, b: 2 }, { b: 2, a: 1 }, 'normal');
    await go();
    const v = validations(logged);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      eventType: 'validation.accepted',
      actorKind: 1,
      actorUserGroupId: 20,
      validatedBy: 20,
      validatedAt: NOW,
      decision: { outcome: 'accepted', itemId: '77' },
    });
    expect(String(v[0].confidence)).toBe('0.87');
  });

  it('résultat différent => validation.modified ; refus => validation.rejected', async () => {
    const m = run('agent', { a: 1 }, { a: 2 }, 'normal');
    await m.go();
    expect(validations(m.logged)[0]).toMatchObject({
      eventType: 'validation.modified',
      decision: { outcome: 'modified', itemId: '77' },
    });
    const r = run('agent', { a: 1 }, { rejected: true, approved: false, comment: 'Non conforme' }, 'rejected');
    await r.go();
    expect(validations(r.logged)[0]).toMatchObject({
      eventType: 'validation.rejected',
      decision: { outcome: 'rejected', itemId: '77' },
      explanation: 'Non conforme',
      validatedBy: 20,
    });
  });

  it('étape de type validation : pas de doublon (un seul événement validation.* existant)', async () => {
    const { logged, go } = run('validation', { approved: true }, { approved: true }, 'normal');
    await go();
    const v = validations(logged);
    expect(v).toHaveLength(1);
    expect(v[0].decision).toEqual({ approved: true });
  });
});
