import type { PrismaClient } from '@prisma/client';
import { WorkflowEngine } from './engine';
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
