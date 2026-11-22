import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { WfEngineError, type WfInstanceDetail, type WfPrincipal, type WorkflowEngineApi } from './engine/engine.types';
import { SubjectAccessRegistry } from './extension/subject-access';
import { WorkflowEventsPublisher } from './extension/workflow-events';
import { InstancesService } from './instances.service';
import type { PrincipalService } from './principal.service';

const user: AuthUser = { userId: 5, username: 'u', isAdmin: false, userGroupId: 50 };
const principal: WfPrincipal = { userGroupId: 50, userId: 5, groupIds: [1], roleId: 9 };
const event = { type: 'instance.started' as const, instanceId: '1' };

function detail(over: { startedBy?: number; tasks?: Array<Record<string, unknown>> } = {}): WfInstanceDetail {
  return {
    instance: { wfInstanceId: '1', startedBy: over.startedBy ?? 50 },
    definitionName: 'd',
    versionNumber: 1,
    tasks: over.tasks ?? [],
    events: [],
    inboxItems: [],
  } as unknown as WfInstanceDetail;
}

function setup(opts: { adminMenu?: boolean; principalOverride?: WfPrincipal } = {}) {
  const engine = {
    startInstance: jest.fn(),
    getInstanceDetail: jest.fn(),
    listInstances: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    cancelInstance: jest.fn().mockResolvedValue({ events: [event] }),
    suspendInstance: jest.fn().mockResolvedValue({ events: [event] }),
    resumeInstance: jest.fn().mockResolvedValue({ events: [event] }),
  };
  const principals = {
    buildPrincipal: jest.fn().mockResolvedValue(opts.principalOverride ?? principal),
    hasAdminMenu: jest.fn().mockResolvedValue(opts.adminMenu ?? false),
  };
  const events = new WorkflowEventsPublisher();
  const publish = jest.spyOn(events, 'publish');
  const subjects = new SubjectAccessRegistry();
  const svc = new InstancesService(
    engine as unknown as WorkflowEngineApi,
    principals as unknown as PrincipalService,
    events,
    subjects,
  );
  return { engine, principals, events, publish, subjects, svc };
}

describe('InstancesService.launch', () => {
  it('lance avec le userGroupId de l’utilisateur (jamais un autre) et publie les événements', async () => {
    const t = setup();
    t.engine.startInstance.mockResolvedValue({ created: true, instance: { wfInstanceId: '1' }, events: [event] });
    const out = await t.svc.launch(user, { definitionId: 3, context: { a: 1 }, idempotencyKey: 'k' });
    expect(out.created).toBe(true);
    expect(t.engine.startInstance).toHaveBeenCalledWith(
      expect.objectContaining({ definitionId: 3, startedBy: 50, idempotencyKey: 'k', subjectType: null }),
    );
    expect(t.publish).toHaveBeenCalledWith([event]);
  });

  it('rejeu d’une clé : created=false et aucun événement publié', async () => {
    const t = setup();
    t.engine.startInstance.mockResolvedValue({ created: false, instance: { wfInstanceId: '1' }, events: [event] });
    const out = await t.svc.launch(user, { definitionId: 3, idempotencyKey: 'k' });
    expect(out.created).toBe(false);
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('conflit de lanceur => 409', async () => {
    const t = setup();
    t.engine.startInstance.mockRejectedValue(new WfEngineError('IDEMPOTENCY_CONFLICT', 'clé déjà utilisée'));
    await expect(t.svc.launch(user, { definitionId: 3, idempotencyKey: 'k' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('définition non publiée => 409', async () => {
    const t = setup();
    t.engine.startInstance.mockRejectedValue(new WfEngineError('DEFINITION_NOT_PUBLISHED', 'non publié'));
    await expect(t.svc.launch(user, { definitionId: 3 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('objet lié : 403 sans contrôleur d’accès (refusé par défaut), le moteur n’est pas appelé', async () => {
    const t = setup();
    await expect(
      t.svc.launch(user, { definitionId: 3, subjectType: 'document', subjectId: '12' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.engine.startInstance).not.toHaveBeenCalled();
  });

  it('objet lié : accepté si le contrôleur autorise, refusé sinon', async () => {
    const t = setup();
    const canAccess = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    t.subjects.register({ subjectType: 'document', canAccess });
    t.engine.startInstance.mockResolvedValue({ created: true, instance: {}, events: [] });
    await t.svc.launch(user, { definitionId: 3, subjectType: 'document', subjectId: '12' });
    expect(canAccess).toHaveBeenCalledWith({ userGroupId: 50, userId: 5 }, '12');
    await expect(
      t.svc.launch(user, { definitionId: 3, subjectType: 'document', subjectId: '13' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.engine.startInstance).toHaveBeenCalledTimes(1);
  });

  it('identité machine refusée', async () => {
    const t = setup();
    t.principals.buildPrincipal.mockRejectedValue(new ForbiddenException());
    await expect(t.svc.launch({ ...user, isScanAgent: true }, { definitionId: 3 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.engine.startInstance).not.toHaveBeenCalled();
  });
});

describe('InstancesService.list', () => {
  it('un utilisateur ordinaire ne voit que les siennes', async () => {
    const t = setup();
    await t.svc.list(user, { limit: 25, offset: 0, status: 1, definitionId: 2 });
    expect(t.engine.listInstances).toHaveBeenCalledWith({
      startedBy: 50,
      definitionId: 2,
      statuses: [1],
      limit: 25,
      offset: 0,
    });
  });

  it('le détenteur du menu ADMIN voit toutes les instances, sauf avec mine=true', async () => {
    const t = setup({ adminMenu: true });
    await t.svc.list(user, { limit: 10, offset: 0 });
    expect(t.engine.listInstances).toHaveBeenLastCalledWith(expect.objectContaining({ startedBy: undefined }));
    await t.svc.list(user, { limit: 10, offset: 0, mine: true });
    expect(t.engine.listInstances).toHaveBeenLastCalledWith(expect.objectContaining({ startedBy: 50 }));
  });
});

describe('InstancesService.detail (droits de lecture)', () => {
  it('lanceur : accès', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 50 }));
    await expect(t.svc.detail(user, '1')).resolves.toBeDefined();
  });

  it.each([
    ['utilisateur', { assigneeUserGroupId: 50 }],
    ['groupe', { assigneeGroupId: 1 }],
    ['rôle', { assigneeRoleId: 9 }],
  ])('assigné (%s) : accès', async (_n, assignee) => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 77, tasks: [assignee] }));
    await expect(t.svc.detail(user, '1')).resolves.toBeDefined();
  });

  it('détenteur du menu ADMIN : accès en lecture', async () => {
    const t = setup({ adminMenu: true });
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 77 }));
    await expect(t.svc.detail(user, '1')).resolves.toBeDefined();
  });

  it('ni lanceur, ni assigné, ni admin : 404 (existence non révélée)', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(
      detail({ startedBy: 77, tasks: [{ assigneeUserGroupId: 51, assigneeGroupId: 2, assigneeRoleId: 8 }] }),
    );
    await expect(t.svc.detail(user, '1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('instance inexistante : 404', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(null);
    await expect(t.svc.detail(user, '1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InstancesService annuler / suspendre / reprendre', () => {
  it('le lanceur peut annuler : acteur = lui, événements publiés', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 50 }));
    await t.svc.cancel(user, '1', 'erreur de saisie');
    expect(t.engine.cancelInstance).toHaveBeenCalledWith({
      instanceId: '1',
      actor: { kind: 'user', userGroupId: 50 },
      reason: 'erreur de saisie',
    });
    expect(t.publish).toHaveBeenCalledWith([event]);
  });

  it('le détenteur du menu ADMIN peut suspendre et reprendre l’instance d’autrui', async () => {
    const t = setup({ adminMenu: true });
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 77 }));
    await t.svc.suspend(user, '1');
    await t.svc.resume(user, '1');
    expect(t.engine.suspendInstance).toHaveBeenCalledTimes(1);
    expect(t.engine.resumeInstance).toHaveBeenCalledWith({ instanceId: '1', actor: { kind: 'user', userGroupId: 50 } });
  });

  it('un simple assigné (lecture) ne peut pas agir sur l’instance : 403', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 77, tasks: [{ assigneeUserGroupId: 50 }] }));
    await expect(t.svc.cancel(user, '1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.engine.cancelInstance).not.toHaveBeenCalled();
  });

  it('un tiers : 404, rien n’est appelé', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 77 }));
    await expect(t.svc.resume(user, '1')).rejects.toBeInstanceOf(NotFoundException);
    expect(t.engine.resumeInstance).not.toHaveBeenCalled();
  });

  it('état invalide du moteur => 409', async () => {
    const t = setup();
    t.engine.getInstanceDetail.mockResolvedValue(detail({ startedBy: 50 }));
    t.engine.cancelInstance.mockRejectedValue(new WfEngineError('INVALID_STATE', 'déjà terminée'));
    await expect(t.svc.cancel(user, '1')).rejects.toBeInstanceOf(ConflictException);
    expect(t.publish).not.toHaveBeenCalled();
  });
});
