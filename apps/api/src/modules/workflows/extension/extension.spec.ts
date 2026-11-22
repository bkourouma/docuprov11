import { ForbiddenException } from '@nestjs/common';

// `@archivage/mailer` (dépendance d'EmailService) n'est pas compilé dans cet espace de travail : le service de
// notifications est remplacé par un double, seule son interface compte ici.
jest.mock('../../notifications/notifications.service', () => ({ NotificationsService: class {} }));

import type { NotificationsService } from '../../notifications/notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WfEngineEvent, WfExecutorContext, WorkflowEngineApi } from '../engine/engine.types';
import type { PrincipalService } from '../principal.service';
import { WfEngineError } from '../engine/engine.types';
import { createGenerationSuggestionExecutor } from './generation-suggester';
import { SubjectAccessRegistry } from './subject-access';
import { WorkflowTriggerStarterService } from './trigger-starter';
import { WorkflowEventsPublisher } from './workflow-events';
import { MAX_NOTIFIED_MEMBERS, WorkflowNotificationsListener } from './workflow-notifications.listener';

const ev = (over: Partial<WfEngineEvent> = {}): WfEngineEvent => ({
  type: 'task.assigned',
  instanceId: '1',
  taskId: '10',
  title: 'Valider le dossier',
  ...over,
});

describe('WorkflowEventsPublisher', () => {
  it('appelle tous les écouteurs ; l’échec de l’un est ignoré', async () => {
    const pub = new WorkflowEventsPublisher();
    const bad = jest.fn().mockRejectedValue(new Error('boom'));
    const good = jest.fn();
    pub.subscribe(bad);
    pub.subscribe(good);
    await expect(pub.publish([ev()])).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledWith([ev()]);
  });

  it('un écouteur synchrone qui lève est ignoré ; se désabonner fonctionne ; liste vide = rien', async () => {
    const pub = new WorkflowEventsPublisher();
    const l = jest.fn(() => {
      throw new Error('sync');
    });
    const off = pub.subscribe(l);
    await pub.publish([ev()]);
    expect(l).toHaveBeenCalledTimes(1);
    off();
    await pub.publish([ev()]);
    await pub.publish([]);
    await pub.publish(undefined);
    expect(l).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowNotificationsListener', () => {
  function setup() {
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const prisma = { appUserGroup: { findMany: jest.fn() } };
    const publisher = new WorkflowEventsPublisher();
    const listener = new WorkflowNotificationsListener(
      publisher,
      notifications as unknown as NotificationsService,
      prisma as unknown as PrismaService,
    );
    listener.onModuleInit();
    return { notifications, prisma, publisher, listener };
  }

  it('s’abonne à l’initialisation et notifie un utilisateur assigné (targetType/targetId)', async () => {
    const t = setup();
    await t.publisher.publish([ev({ assignee: { userGroupId: 7 }, message: 'Nouvelle tâche pour vous' })]);
    expect(t.notifications.create).toHaveBeenCalledWith({
      recipientUserGroupId: 7,
      message: 'Nouvelle tâche pour vous',
      targetType: 'workflow_task',
      targetId: 10,
    });
  });

  it('targetId null si l’id de tâche dépasse 2147483647', async () => {
    const t = setup();
    await t.listener.handle([ev({ assignee: { userGroupId: 7 }, taskId: '2147483648' })]);
    expect(t.notifications.create.mock.calls[0][0]).toMatchObject({ targetId: null });
    await t.listener.handle([ev({ assignee: { userGroupId: 7 }, taskId: '2147483647' })]);
    expect(t.notifications.create.mock.calls[1][0]).toMatchObject({ targetId: 2147483647 });
  });

  it('étend un groupe à ses membres actifs, plafonné et dédoublonné', async () => {
    const t = setup();
    t.prisma.appUserGroup.findMany.mockResolvedValue([{ userGroupId: 1 }, { userGroupId: 2 }, { userGroupId: 2 }]);
    await t.listener.handle([ev({ type: 'task.delegated', assignee: { groupId: 4 } })]);
    const args = t.prisma.appUserGroup.findMany.mock.calls[0][0];
    expect(args.take).toBe(MAX_NOTIFIED_MEMBERS);
    expect(args.where).toMatchObject({ groupId: 4, user: { isDisabled: false } });
    expect(t.notifications.create).toHaveBeenCalledTimes(2);
    expect(t.notifications.create.mock.calls[0][0].message).toContain('déléguée');
  });

  it('étend un rôle actif à ses membres actifs (plafond)', async () => {
    const t = setup();
    t.prisma.appUserGroup.findMany.mockResolvedValue([{ userGroupId: 3 }]);
    await t.listener.handle([ev({ assignee: { roleId: 9 } })]);
    const args = t.prisma.appUserGroup.findMany.mock.calls[0][0];
    expect(args.take).toBe(MAX_NOTIFIED_MEMBERS);
    expect(args.where.user).toMatchObject({ roleId: 9, isDisabled: false, role: { isActive: true } });
    expect(t.notifications.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['instance.completed', 'terminé'],
    ['instance.failed', 'échoué'],
    ['instance.cancelled', 'annulé'],
    ['instance.suspended', 'suspendu'],
  ] as const)('%s : notifie le lanceur', async (type, word) => {
    const t = setup();
    await t.listener.handle([{ type, instanceId: '1', startedBy: 50 }]);
    expect(t.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserGroupId: 50, targetId: null }),
    );
    expect(t.notifications.create.mock.calls[0][0].message).toContain(word);
  });

  it('n’envoie rien pour instance.started, task.completed, ni sans bénéficiaire', async () => {
    const t = setup();
    await t.listener.handle([
      { type: 'instance.started', instanceId: '1', startedBy: 50 },
      ev({ type: 'task.completed' }),
      ev({ assignee: undefined }),
    ]);
    expect(t.notifications.create).not.toHaveBeenCalled();
  });

  it('une notification en échec n’empêche ni les autres ni l’action', async () => {
    const t = setup();
    t.prisma.appUserGroup.findMany.mockResolvedValue([{ userGroupId: 1 }, { userGroupId: 2 }]);
    t.notifications.create.mockRejectedValueOnce(new Error('smtp'));
    await expect(t.listener.handle([ev({ assignee: { groupId: 4 } })])).resolves.toBeUndefined();
    expect(t.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('une erreur d’expansion est journalisée et les événements suivants sont traités', async () => {
    const t = setup();
    t.prisma.appUserGroup.findMany.mockRejectedValueOnce(new Error('db'));
    await t.listener.handle([
      ev({ assignee: { groupId: 4 } }),
      { type: 'instance.completed', instanceId: '1', startedBy: 50 },
    ]);
    expect(t.notifications.create).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowTriggerStarterService', () => {
  function setup(canLaunch = true) {
    const engine = {
      startInstance: jest.fn().mockResolvedValue({ created: true, instance: {}, events: [ev()] }),
    };
    const principals = { canLaunch: jest.fn().mockResolvedValue(canLaunch) };
    const subjects = new SubjectAccessRegistry();
    const events = new WorkflowEventsPublisher();
    const publish = jest.spyOn(events, 'publish');
    const svc = new WorkflowTriggerStarterService(
      engine as unknown as WorkflowEngineApi,
      principals as unknown as PrincipalService,
      subjects,
      events,
    );
    return { engine, principals, subjects, publish, svc };
  }
  const base = { definitionId: 1, startedBy: 50, idempotencyKey: 'trg-1-evt-9', triggerId: 4 };

  it('démarre avec run_as, triggerId et clé d’idempotence, puis publie', async () => {
    const t = setup();
    await t.svc.start(base);
    expect(t.principals.canLaunch).toHaveBeenCalledWith(50);
    expect(t.engine.startInstance).toHaveBeenCalledWith(
      expect.objectContaining({ definitionId: 1, startedBy: 50, idempotencyKey: 'trg-1-evt-9', triggerId: 4 }),
    );
    expect(t.publish).toHaveBeenCalledTimes(1);
  });

  it('refusé (403) sans menu LANCER pour le run_as : rien n’est démarré', async () => {
    const t = setup(false);
    await expect(t.svc.start(base)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.engine.startInstance).not.toHaveBeenCalled();
  });

  it('exige une clé d’idempotence (non vide, ≤ 200)', async () => {
    const t = setup();
    await expect(t.svc.start({ ...base, idempotencyKey: '  ' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(t.svc.start({ ...base, idempotencyKey: 'x'.repeat(201) })).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.engine.startInstance).not.toHaveBeenCalled();
  });

  it('objet lié sans contrôleur d’accès : refusé ; avec contrôleur : vérifié pour le run_as', async () => {
    const t = setup();
    await expect(t.svc.start({ ...base, subjectType: 'document', subjectId: '3' })).rejects.toBeInstanceOf(ForbiddenException);
    const canAccess = jest.fn().mockResolvedValue(true);
    t.subjects.register({ subjectType: 'document', canAccess });
    await t.svc.start({ ...base, subjectType: 'document', subjectId: '3' });
    expect(canAccess).toHaveBeenCalledWith({ userGroupId: 50 }, '3');
  });

  it('rejeu : pas de republication ; erreurs moteur traduites', async () => {
    const t = setup();
    t.engine.startInstance.mockResolvedValueOnce({ created: false, instance: {}, events: [ev()] });
    await t.svc.start(base);
    expect(t.publish).not.toHaveBeenCalled();
    t.engine.startInstance.mockRejectedValueOnce(new WfEngineError('IDEMPOTENCY_CONFLICT', 'x'));
    await expect(t.svc.start(base)).rejects.toMatchObject({ status: 409 });
  });
});

describe('SubjectAccessRegistry', () => {
  it('sans objet lié : rien à vérifier ; objet incomplet : refusé', async () => {
    const r = new SubjectAccessRegistry();
    await expect(r.assertAccess({ userGroupId: 1 }, undefined, undefined)).resolves.toBeUndefined();
    await expect(r.assertAccess({ userGroupId: 1 }, 'document', undefined)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('createGenerationSuggestionExecutor', () => {
  const ctx = {
    instanceId: '1',
    taskId: '2',
    attempt: 1,
    step: { key: 'redaction' },
    context: {},
    runAs: { userGroupId: 50 },
  } as unknown as WfExecutorContext;

  it('propose (jamais complete) une suggestion', async () => {
    const ex = createGenerationSuggestionExecutor({ suggest: jest.fn().mockResolvedValue({ content: 'Texte', confidence: 0.7 }) });
    expect(ex.taskType).toBe('generation');
    await expect(ex.execute(ctx)).resolves.toMatchObject({ kind: 'propose', proposal: { content: 'Texte' }, confidence: 0.7 });
  });

  it('suggestion vide ou en erreur : la tâche reste à l’humain (wait)', async () => {
    const empty = createGenerationSuggestionExecutor({ suggest: jest.fn().mockResolvedValue({ content: '  ' }) });
    await expect(empty.execute(ctx)).resolves.toEqual({ kind: 'wait' });
    const failing = createGenerationSuggestionExecutor({ suggest: jest.fn().mockRejectedValue(new Error('llm')) });
    await expect(failing.execute(ctx)).resolves.toEqual({ kind: 'wait' });
  });
});
