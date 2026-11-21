import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { WfEngineError, type WfPrincipal, type WorkflowEngineApi } from './engine/engine.types';
import { WorkflowEventsPublisher } from './extension/workflow-events';
import { InboxService } from './inbox.service';
import type { PrincipalService } from './principal.service';

const user: AuthUser = { userId: 5, username: 'u', isAdmin: false, userGroupId: 50 };
const principal: WfPrincipal = { userGroupId: 50, userId: 5, groupIds: [1], roleId: 9 };
const event = { type: 'task.completed' as const, instanceId: '1' };

function setup(item: Record<string, unknown> | null = { taskId: 700n, assigneeUserGroupId: 50 }) {
  const engine = {
    listInbox: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    claimTask: jest.fn().mockResolvedValue({ events: [event] }),
    completeTask: jest.fn().mockResolvedValue({ events: [event] }),
    rejectTask: jest.fn().mockResolvedValue({ events: [event] }),
    delegateTask: jest.fn().mockResolvedValue({ events: [event] }),
  };
  const prisma = { wfInboxItem: { findUnique: jest.fn().mockResolvedValue(item) } };
  const principals = {
    buildPrincipal: jest.fn().mockResolvedValue(principal),
    isActiveUserGroup: jest.fn().mockResolvedValue(true),
  };
  const events = new WorkflowEventsPublisher();
  const publish = jest.spyOn(events, 'publish');
  const svc = new InboxService(
    engine as unknown as WorkflowEngineApi,
    prisma as unknown as PrismaService,
    principals as unknown as PrincipalService,
    events,
  );
  return { engine, prisma, principals, publish, svc };
}

describe('InboxService : périmètre = assignation', () => {
  it.each([
    ['utilisateur', { taskId: 700n, assigneeUserGroupId: 50 }],
    ['groupe', { taskId: 700n, assigneeGroupId: 1 }],
    ['rôle', { taskId: 700n, assigneeRoleId: 9 }],
    ['preneur', { taskId: 700n, assigneeGroupId: 99, claimedBy: 50 }],
  ])('assigné (%s) : le moteur est appelé avec la tâche et le principal', async (_n, item) => {
    const t = setup(item);
    await t.svc.claim(user, '12');
    expect(t.prisma.wfInboxItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { wfInboxItemId: 12n } }),
    );
    expect(t.engine.claimTask).toHaveBeenCalledWith({ taskId: '700', principal });
    expect(t.publish).toHaveBeenCalledWith([event]);
  });

  it('élément d’un autre : 404 (pas 403), le moteur n’est jamais appelé', async () => {
    const t = setup({ taskId: 700n, assigneeUserGroupId: 51, assigneeGroupId: 2, assigneeRoleId: 8, claimedBy: 52 });
    for (const call of [
      () => t.svc.claim(user, '12'),
      () => t.svc.complete(user, '12', { result: { approved: true } }),
      () => t.svc.reject(user, '12', {}),
      () => t.svc.delegate(user, '12', { toUserGroupId: 60 }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(Object.values(t.engine).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('un administrateur n’a aucun passe-droit sur la boîte d’autrui', async () => {
    const t = setup({ taskId: 700n, assigneeUserGroupId: 51 });
    await expect(t.svc.complete({ ...user, isAdmin: true }, '12', { result: {} })).rejects.toBeInstanceOf(NotFoundException);
    expect(t.engine.completeTask).not.toHaveBeenCalled();
  });

  it('élément inexistant : 404', async () => {
    const t = setup(null);
    await expect(t.svc.claim(user, '12')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('identité machine / sans acteur : refusée avant toute lecture', async () => {
    const t = setup();
    t.principals.buildPrincipal.mockRejectedValue(new ForbiddenException());
    await expect(t.svc.list({ ...user, isScanAgent: true, userGroupId: null }, { limit: 25, offset: 0 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(t.svc.claim({ ...user, userGroupId: null }, '12')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.prisma.wfInboxItem.findUnique).not.toHaveBeenCalled();
  });

  it('list : transmet statuts et pagination avec le principal', async () => {
    const t = setup();
    await t.svc.list(user, { status: [0, 1], limit: 10, offset: 20 });
    expect(t.engine.listInbox).toHaveBeenCalledWith(principal, { statuses: [0, 1], limit: 10, offset: 20 });
  });
});

describe('InboxService : actions', () => {
  it('complete transmet résultat et expectedRowVersion', async () => {
    const t = setup();
    await t.svc.complete(user, '12', { result: { approved: true }, expectedRowVersion: 3 });
    expect(t.engine.completeTask).toHaveBeenCalledWith({
      taskId: '700',
      principal,
      result: { approved: true },
      expectedRowVersion: 3,
    });
  });

  it('les refus du moteur sont traduits (FORBIDDEN 403, CONFLICT 409, INVALID_INPUT 422)', async () => {
    const t = setup();
    t.engine.completeTask.mockRejectedValueOnce(new WfEngineError('FORBIDDEN', 'pas l’assigné'));
    await expect(t.svc.complete(user, '12', { result: {} })).rejects.toBeInstanceOf(ForbiddenException);
    t.engine.completeTask.mockRejectedValueOnce(new WfEngineError('CONFLICT', 'déjà prise'));
    await expect(t.svc.complete(user, '12', { result: {} })).rejects.toBeInstanceOf(ConflictException);
    t.engine.completeTask.mockRejectedValueOnce(new WfEngineError('INVALID_INPUT', 'résultat invalide'));
    await expect(t.svc.complete(user, '12', { result: {} })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('delegate : pas à soi-même, destinataire actif obligatoire', async () => {
    const t = setup();
    await expect(t.svc.delegate(user, '12', { toUserGroupId: 50 })).rejects.toBeInstanceOf(UnprocessableEntityException);
    t.principals.isActiveUserGroup.mockResolvedValueOnce(false);
    await expect(t.svc.delegate(user, '12', { toUserGroupId: 60 })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(t.engine.delegateTask).not.toHaveBeenCalled();
    await t.svc.delegate(user, '12', { toUserGroupId: 60, comment: 'absent' });
    expect(t.engine.delegateTask).toHaveBeenCalledWith({
      taskId: '700',
      principal,
      toUserGroupId: 60,
      comment: 'absent',
    });
  });

  it('reject transmet le commentaire', async () => {
    const t = setup();
    await t.svc.reject(user, '12', { comment: 'non conforme' });
    expect(t.engine.rejectTask).toHaveBeenCalledWith({ taskId: '700', principal, comment: 'non conforme' });
  });
});
