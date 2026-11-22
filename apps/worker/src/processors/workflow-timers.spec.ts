import {
  createWorkflowTimersProcessor,
  expandRecipients,
  readStepParams,
  registerTimerHandler,
  runDueTimers,
  type NotificationRow,
  type RunDueTimersOptions,
} from './workflow-timers.processor';
import {
  emptyStore,
  makeFakePrisma,
  type FakeInstance,
  type FakeStore,
  type FakeTask,
  type FakeTimer,
} from './workflow-timers.fake-db';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const WORKER = 'host:1';
const HOUR = 3_600_000;
const VERSION = 7;

function addInstance(store: FakeStore, over: Partial<FakeInstance> = {}): FakeInstance {
  const inst: FakeInstance = {
    wfInstanceId: 1n,
    status: 1,
    definitionVersionId: VERSION,
    startedBy: 42,
    rowVersion: 3,
    ...over,
  };
  store.instances.push(inst);
  return inst;
}

function addTask(store: FakeStore, over: Partial<FakeTask> = {}): FakeTask {
  const task: FakeTask = {
    wfTaskId: 10n,
    instanceId: 1n,
    stepKey: 'controle',
    status: 0,
    title: 'Contrôler le dossier',
    attempt: 1,
    dueAt: new Date(NOW.getTime() - 1000),
    assigneeUserGroupId: 5,
    assigneeGroupId: null,
    assigneeRoleId: null,
    ...over,
  };
  store.tasks.push(task);
  store.inbox.push({
    taskId: task.wfTaskId,
    kind: 0,
    status: 1,
    dueAt: task.dueAt,
    assigneeUserGroupId: task.assigneeUserGroupId,
    assigneeGroupId: task.assigneeGroupId,
    assigneeRoleId: task.assigneeRoleId,
    claimedBy: 5,
    claimedAt: new Date(NOW.getTime() - HOUR),
  });
  return task;
}

function addTimer(store: FakeStore, over: Partial<FakeTimer> = {}): FakeTimer {
  const timer: FakeTimer = {
    wfTimerId: 100n,
    instanceId: 1n,
    taskId: 10n,
    stepKey: 'controle',
    kind: 2,
    status: 0,
    fireAt: new Date(NOW.getTime() - 1000),
    firedAt: null,
    attempts: 0,
    payload: { taskId: '10', attempt: 1 },
    lockedBy: null,
    lockedUntil: null,
    ...over,
  };
  store.timers.push(timer);
  return timer;
}

function graphWith(step: Record<string, unknown>): unknown {
  return { schemaVersion: 1, start: 'controle', steps: [{ key: 'controle', name: 'Contrôle', type: 'form', next: [], ...step }] };
}

function setup(step: Record<string, unknown> = {}): FakeStore {
  const store = emptyStore();
  store.graphs[VERSION] = graphWith(step);
  addInstance(store);
  return store;
}

function run(store: FakeStore, over: Partial<RunDueTimersOptions> = {}) {
  return runDueTimers(makeFakePrisma(store), { now: NOW, workerId: WORKER, ...over });
}

const eventTypes = (store: FakeStore) => store.events.map((e) => e.eventType);

describe('runDueTimers — relance (nature 1)', () => {
  it('notifie le bénéficiaire, journalise et ré-arme tant que la prochaine relance précède l’échéance', async () => {
    const store = setup({ reminderAfterHours: 2, dueInHours: 24 });
    addTask(store, { dueAt: new Date(NOW.getTime() + 10 * HOUR) });
    addTimer(store, { kind: 1 });

    const res = await run(store);

    expect(res).toMatchObject({ claimed: 1, reminded: 1, failed: 0, notified: 1 });
    const fired = store.timers.find((t) => t.wfTimerId === 100n);
    expect(fired).toMatchObject({ status: 1, lockedBy: null, lockedUntil: null });
    expect(fired?.firedAt).toEqual(NOW);
    // Nouvelle minuterie de relance à now + 2 h.
    const rearmed = store.timers.filter((t) => t.status === 0);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]).toMatchObject({ kind: 1, stepKey: 'controle', taskId: 10n });
    expect(rearmed[0]?.fireAt).toEqual(new Date(NOW.getTime() + 2 * HOUR));
    expect(eventTypes(store)).toEqual(['timer.fired', 'timer.scheduled']);
    expect(store.events.every((e) => e.actorKind === 0)).toBe(true);
    expect(store.notifications).toEqual([
      expect.objectContaining({ recipientUserGroupId: 5, targetType: 'workflow_task', targetId: 10 }),
    ]);
  });

  it('ne ré-arme pas quand la prochaine relance tomberait après l’échéance de la tâche', async () => {
    const store = setup({ reminderAfterHours: 5 });
    addTask(store, { dueAt: new Date(NOW.getTime() + 3 * HOUR) });
    addTimer(store, { kind: 1 });

    const res = await run(store);

    expect(res.reminded).toBe(1);
    expect(store.timers.filter((t) => t.status === 0)).toHaveLength(0);
    expect(eventTypes(store)).toEqual(['timer.fired']);
  });

  it('ne ré-arme pas une tâche sans échéance (relances non bornées interdites)', async () => {
    const store = setup({ reminderAfterHours: 1 });
    addTask(store, { dueAt: null });
    addTimer(store, { kind: 1 });
    await run(store);
    expect(store.timers.filter((t) => t.status === 0)).toHaveLength(0);
  });

  it('tâche déjà terminée : minuterie marquée déclenchée, aucun effet ni notification', async () => {
    const store = setup({ reminderAfterHours: 1 });
    addTask(store, { status: 2 });
    addTimer(store, { kind: 1 });

    const res = await run(store);

    expect(res).toMatchObject({ claimed: 1, noop: 1, reminded: 0, notified: 0 });
    expect(store.timers[0]).toMatchObject({ status: 1 });
    expect(store.events).toEqual([expect.objectContaining({ eventType: 'timer.fired', decision: { noop: true } })]);
    expect(store.notifications).toHaveLength(0);
  });
});

describe('runDueTimers — échéance (nature 2)', () => {
  const escalation = { assignee: { kind: 'group', id: 7 }, dueInHours: 24, maxEscalations: 2 };

  function withMembers(store: FakeStore): void {
    store.members.push(
      { userGroupId: 71, userId: 1, groupId: 7, roleId: null, isDisabled: false },
      { userGroupId: 72, userId: 2, groupId: 7, roleId: null, isDisabled: false },
      { userGroupId: 73, userId: 3, groupId: 7, roleId: null, isDisabled: true },
    );
  }

  it('escalade : ré-affecte la même tâche (assignee exclusif), nouvelle échéance, boîte rouverte', async () => {
    const store = setup({ dueInHours: 24, config: { escalation } });
    withMembers(store);
    addTask(store);
    addTimer(store);

    const res = await run(store);

    expect(res).toMatchObject({ claimed: 1, escalated: 1, expired: 0, notified: 2 });
    const task = store.tasks[0];
    expect(task).toMatchObject({ assigneeUserGroupId: null, assigneeGroupId: 7, assigneeRoleId: null, status: 0 });
    expect(task?.dueAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    expect(store.inbox[0]).toMatchObject({
      status: 0,
      claimedBy: null,
      claimedAt: null,
      assigneeUserGroupId: null,
      assigneeGroupId: 7,
    });
    // Instance toujours active, version incrémentée (le client qui avait lu avant verra un conflit).
    expect(store.instances[0]).toMatchObject({ status: 1, rowVersion: 4 });
    // Nouvelle minuterie d'échéance active.
    const active = store.timers.filter((t) => t.status === 0);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ kind: 2, taskId: 10n });
    expect(active[0]?.fireAt).toEqual(new Date(NOW.getTime() + 24 * HOUR));
    expect(eventTypes(store)).toEqual(['timer.fired', 'task.escalated', 'timer.scheduled']);
    // Notification : membres ACTIFS du groupe seulement.
    expect(store.notifications.map((n) => (n as NotificationRow).recipientUserGroupId)).toEqual([71, 72]);
  });

  it('compte les escalades précédentes : deuxième escalade permise (max 2), troisième refusée', async () => {
    const store = setup({ dueInHours: 24, config: { escalation } });
    withMembers(store);
    addTask(store);
    store.events.push({ instanceId: 1n, taskId: 10n, stepKey: 'controle', eventType: 'task.escalated', actorKind: 0, occurredAt: NOW });
    addTimer(store);
    expect((await run(store)).escalated).toBe(1);

    // Escalade n° 3 : plafond atteint => expiration + suspension.
    const store2 = setup({ dueInHours: 24, config: { escalation } });
    addTask(store2);
    for (let i = 0; i < 2; i += 1) {
      store2.events.push({ instanceId: 1n, taskId: 10n, stepKey: 'controle', eventType: 'task.escalated', actorKind: 0, occurredAt: NOW });
    }
    addTimer(store2);
    const res = await run(store2);
    expect(res).toMatchObject({ escalated: 0, expired: 1 });
  });

  it('maxEscalations atteint : tâche expirée, boîte expirée, instance suspendue, autres minuteries annulées', async () => {
    const store = setup({ config: { escalation: { assignee: { kind: 'user', id: 9 }, dueInHours: 12 } } }); // max par défaut = 1
    addTask(store);
    store.events.push({ instanceId: 1n, taskId: 10n, stepKey: 'controle', eventType: 'task.escalated', actorKind: 0, occurredAt: NOW });
    addTimer(store);
    addTimer(store, { wfTimerId: 101n, kind: 1, fireAt: new Date(NOW.getTime() + HOUR) });

    const res = await run(store);

    expect(res).toMatchObject({ claimed: 1, expired: 1, escalated: 0, notified: 1 });
    expect(store.tasks[0]?.status).toBe(4);
    expect(store.inbox[0]?.status).toBe(4);
    expect(store.instances[0]).toMatchObject({ status: 5, rowVersion: 4 });
    expect(store.timers.find((t) => t.wfTimerId === 101n)?.status).toBe(2);
    expect(eventTypes(store)).toEqual(['task.escalated', 'timer.fired', 'task.expired', 'instance.suspended']);
    // Le lanceur est prévenu.
    expect(store.notifications).toEqual([expect.objectContaining({ recipientUserGroupId: 42 })]);
  });

  it('sans escalade déclarée : expiration + suspension', async () => {
    const store = setup({});
    addTask(store);
    addTimer(store);
    const res = await run(store);
    expect(res).toMatchObject({ expired: 1, escalated: 0 });
    expect(store.instances[0]?.status).toBe(5);
    expect(store.events.find((e) => e.eventType === 'instance.suspended')?.decision).toEqual({ reason: 'deadline_exceeded' });
  });

  it('configuration d’escalade invalide : traitée comme « pas d’escalade » et journalisée', async () => {
    const store = setup({ config: { escalation: { assignee: { kind: 'group' } } } }); // id manquant
    addTask(store);
    addTimer(store);
    const res = await run(store);
    expect(res.expired).toBe(1);
    expect(store.events.find((e) => e.eventType === 'timer.fired')?.decision).toMatchObject({ escalation: 'invalid_config' });
  });

  it('tâche déjà terminée : aucun effet, instance intacte', async () => {
    const store = setup({ config: { escalation } });
    addTask(store, { status: 2 });
    addTimer(store);
    const res = await run(store);
    expect(res).toMatchObject({ noop: 1, escalated: 0, expired: 0 });
    expect(store.instances[0]).toMatchObject({ status: 1, rowVersion: 3 });
    expect(store.timers[0]?.status).toBe(1);
    expect(store.events).toEqual([expect.objectContaining({ eventType: 'timer.fired', decision: { noop: true } })]);
  });

  it('escalade : tous les éléments de boîte ouverts de la tâche (nature 0 ET 1) sont ré-affectés', async () => {
    const store = setup({ dueInHours: 24, config: { escalation } });
    addTask(store);
    store.inbox.push({ ...store.inbox[0]!, kind: 1, status: 0, claimedBy: null, claimedAt: null });
    store.inbox.push({ ...store.inbox[0]!, kind: 1, status: 2 }); // déjà traité : intact
    addTimer(store);
    await run(store);
    expect(store.inbox.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 0, status: 0, assigneeGroupId: 7, assigneeUserGroupId: null, claimedBy: null }),
      expect.objectContaining({ kind: 1, status: 0, assigneeGroupId: 7, assigneeUserGroupId: null, claimedBy: null }),
    ]);
    expect(store.inbox[2]).toMatchObject({ status: 2, assigneeUserGroupId: 5 });
  });

  it.each([
    ['user', { users: [], groups: [7], roles: [7] }],
    ['group', { users: [7], groups: [], roles: [7] }],
    ['role', { users: [7], groups: [7], roles: [] }],
  ])('cible d’escalade inactive (%s) : repli sur l’expiration, journalisé', async (kind, targets) => {
    const store = setup({ dueInHours: 24, config: { escalation: { assignee: { kind, id: 7 }, dueInHours: 24 } } });
    store.targets = targets;
    addTask(store);
    addTimer(store);
    const res = await run(store);
    expect(res).toMatchObject({ expired: 1, escalated: 0 });
    expect(store.tasks[0]).toMatchObject({ status: 4, assigneeUserGroupId: 5 });
    expect(store.instances[0]?.status).toBe(5);
    expect(store.events.find((e) => e.eventType === 'timer.fired')?.decision).toMatchObject({ escalation: 'target_inactive' });
  });

  it('cible d’escalade active : l’escalade a lieu', async () => {
    const store = setup({ dueInHours: 24, config: { escalation } });
    store.targets = { users: [], groups: [7], roles: [] };
    addTask(store);
    addTimer(store);
    expect((await run(store)).escalated).toBe(1);
  });
});

describe('runDueTimers — bail, concurrence et reprise', () => {
  it('SQL de réclamation : paramétré, jointure sur le statut d’instance, SKIP LOCKED', async () => {
    const store = setup({});
    await run(store, { workerId: 'worker-secret-id' });
    const claim = store.sqlLog[0];
    expect(claim?.sql).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(claim?.sql).toContain('JOIN "wf_instance" i');
    expect(claim?.sql).toMatch(/i\."status" IN \(0, 1\)/);
    expect(claim?.sql).toContain('"locked_until" < ');
    // Aucune valeur interpolée dans le texte : tout passe par des paramètres.
    expect(claim?.sql).not.toContain('worker-secret-id');
    expect(claim?.values).toContain('worker-secret-id');
  });

  it('les instances suspendues (ou terminées) ne sont pas réclamées', async () => {
    const store = emptyStore();
    store.graphs[VERSION] = graphWith({});
    addInstance(store, { status: 5 });
    addTask(store);
    addTimer(store);
    const res = await run(store);
    expect(res.claimed).toBe(0);
    expect(store.timers[0]).toMatchObject({ status: 0, lockedBy: null });
  });

  it('instance suspendue entre la réclamation et le traitement : bail levé, aucun effet', async () => {
    const store = setup({});
    addTask(store);
    addTimer(store);
    store.afterClaim = (s) => {
      s.instances[0]!.status = 5;
    };
    const res = await run(store);
    expect(res).toMatchObject({ claimed: 1, skipped: 1, expired: 0 });
    expect(store.timers[0]).toMatchObject({ status: 0, lockedBy: null, lockedUntil: null });
    expect(store.events).toHaveLength(0);
  });

  it('CAS perdu (bail repris par un autre worker) : ignorée, aucun effet, aucun écrasement', async () => {
    const store = setup({});
    addTask(store);
    addTimer(store);
    store.afterClaim = (s) => {
      s.timers[0]!.lockedBy = 'autre:9';
    };
    const res = await run(store);
    expect(res).toMatchObject({ claimed: 1, lost: 1, expired: 0, notified: 0 });
    expect(store.timers[0]).toMatchObject({ status: 0, lockedBy: 'autre:9' });
    expect(store.tasks[0]?.status).toBe(0);
    expect(store.events).toHaveLength(0);
  });

  it('échec en cours de transaction : aucun effet partiel, puis reprise au bail suivant', async () => {
    const escalation = { assignee: { kind: 'user', id: 9 }, dueInHours: 12 };
    const store = setup({ dueInHours: 12, config: { escalation } });
    addTask(store);
    addTimer(store);
    // L'événement task.escalated est écrit APRÈS la mise à jour de la tâche et de la boîte : la panne
    // survient donc au milieu de l'effet.
    store.failEventType = 'task.escalated';
    const errors: string[] = [];
    const log = { info: jest.fn(), warn: jest.fn(), error: (o: Record<string, unknown>) => errors.push(String(o.err)) };

    const first = await run(store, { log });

    expect(first).toMatchObject({ claimed: 1, failed: 1, escalated: 0, notified: 0 });
    expect(store.tasks[0]).toMatchObject({ assigneeUserGroupId: 5, status: 0 });
    expect(store.inbox[0]).toMatchObject({ status: 1, claimedBy: 5 });
    expect(store.instances[0]?.rowVersion).toBe(3);
    expect(store.events).toHaveLength(0);
    expect(store.timers).toHaveLength(1);
    expect(store.timers[0]).toMatchObject({ status: 0, attempts: 1, lockedBy: WORKER });
    expect(errors).toEqual(['Error']); // l'étiquette seule : jamais le message ni les données

    // Bail encore valide : rien à réclamer.
    expect((await run(store, { now: new Date(NOW.getTime() + 60_000) })).claimed).toBe(0);

    // Bail expiré, panne résorbée : reprise et traitement complet.
    store.failEventType = undefined;
    const later = new Date(NOW.getTime() + 121_000);
    const second = await run(store, { now: later });
    expect(second).toMatchObject({ claimed: 1, escalated: 1 });
    expect(store.timers.find((t) => t.wfTimerId === 100n)).toMatchObject({ status: 1, attempts: 2 });
    expect(store.tasks[0]).toMatchObject({ assigneeUserGroupId: 9 });
  });

  it('au-delà de maxAttempts : minuterie annulée + événement timer.failed, sans effet métier', async () => {
    const store = setup({});
    addTask(store);
    addTimer(store, { attempts: 5 }); // la réclamation passe à 6 > 5
    const res = await run(store, { maxAttempts: 5 });
    expect(res).toMatchObject({ claimed: 1, abandoned: 1, expired: 0 });
    expect(store.timers[0]).toMatchObject({ status: 2, lockedBy: null, lockedUntil: null });
    expect(store.events).toEqual([expect.objectContaining({ eventType: 'timer.failed', actorKind: 0 })]);
    expect(store.tasks[0]?.status).toBe(0);
    expect(store.instances[0]?.status).toBe(1);
  });

  it('traite plusieurs lots dans un tick tant qu’un lot est plein', async () => {
    const store = setup({});
    for (let i = 0; i < 3; i += 1) {
      store.tasks.push({
        wfTaskId: BigInt(20 + i),
        instanceId: 1n,
        stepKey: `s${i}`,
        status: 2,
        title: 't',
        attempt: 1,
        dueAt: null,
        assigneeUserGroupId: null,
        assigneeGroupId: null,
        assigneeRoleId: null,
      });
      addTimer(store, { wfTimerId: BigInt(200 + i), taskId: BigInt(20 + i), stepKey: `s${i}`, kind: 1 });
    }
    const tick = createWorkflowTimersProcessor(makeFakePrisma(store), { workerId: WORKER, batchSize: 2, clock: () => NOW });
    const res = await tick();
    expect(res).toMatchObject({ claimed: 3, noop: 3 });
    expect(store.timers.every((t) => t.status === 1)).toBe(true);
  });
});

describe('runDueTimers — notifications', () => {
  it('une notification en échec n’annule pas le traitement (déjà commité)', async () => {
    const store = setup({});
    addTask(store);
    addTimer(store);
    const warn = jest.fn();
    const notify = jest.fn().mockRejectedValue(new Error('base de notifications indisponible'));

    const res = await run(store, { notify, log: { info: jest.fn(), warn, error: jest.fn() } });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ expired: 1, failed: 0, notified: 0 });
    expect(store.tasks[0]?.status).toBe(4);
    expect(store.instances[0]?.status).toBe(5);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'Error' }), expect.any(String));
  });

  it('un annuaire indisponible n’annule pas non plus le traitement', async () => {
    const store = setup({ config: { escalation: { assignee: { kind: 'role', id: 3 }, dueInHours: 12 } } });
    addTask(store);
    addTimer(store);
    store.failMembers = true;
    const res = await run(store);
    expect(res).toMatchObject({ escalated: 1, failed: 0 });
    expect(store.tasks[0]?.assigneeRoleId).toBe(3);
  });

  it('bénéficiaire rôle : membres actifs, plafond 200 et un seul compte par personne', async () => {
    const store = emptyStore();
    store.members.push(
      { userGroupId: 1, userId: 1, groupId: 1, roleId: 3, isDisabled: false },
      { userGroupId: 2, userId: 1, groupId: 2, roleId: 3, isDisabled: false }, // même personne
      { userGroupId: 3, userId: 2, groupId: 1, roleId: 3, isDisabled: false },
    );
    const rows = await expandRecipients(makeFakePrisma(store), [
      { beneficiary: { roleId: 3 }, message: 'm', taskId: 10n },
    ]);
    expect(rows.map((r) => r.recipientUserGroupId)).toEqual([1, 3]);
    expect(store.memberQueries[0]).toMatchObject({ take: 200, distinct: ['userId'] });
    expect(store.memberQueries[0]?.where).toEqual({ user: { roleId: 3, isDisabled: false } });
  });

  it('targetId : identifiant de la tâche s’il tient dans un entier 32 bits, sinon null', async () => {
    const store = emptyStore();
    const rows = await expandRecipients(makeFakePrisma(store), [
      { beneficiary: { userGroupId: 1 }, message: 'a', taskId: 2147483647n },
      { beneficiary: { userGroupId: 1 }, message: 'b', taskId: 2147483648n },
      { beneficiary: {}, message: 'personne', taskId: 1n },
    ]);
    expect(rows.map((r) => r.targetId)).toEqual([2147483647, null]);
    expect(rows.every((r) => r.targetType === 'workflow_task')).toBe(true);
  });

  it('défaut : écrit directement dans la table notification, après le commit', async () => {
    const store = setup({});
    addTask(store);
    addTimer(store);
    const seenAtNotify: number[] = [];
    const notify = async (rows: NotificationRow[]) => {
      seenAtNotify.push(store.tasks[0]?.status ?? -1); // l'état est déjà commité
      store.notifications.push(...rows);
    };
    await run(store, { notify });
    expect(seenAtNotify).toEqual([4]);
  });
});

describe('runDueTimers — natures 0 et 3 (points d’extension)', () => {
  it('appelle le gestionnaire injecté dans la transaction et journalise timer.fired', async () => {
    const store = setup({});
    addTimer(store, { kind: 3, taskId: null });
    const handler = jest.fn().mockResolvedValue(undefined);

    const res = await run(store, { handlers: { 3: handler } });

    expect(res).toMatchObject({ handled: 1, failed: 0 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ now: NOW, timer: expect.objectContaining({ kind: 3 }) }));
    expect(store.timers[0]).toMatchObject({ status: 1 });
    expect(eventTypes(store)).toEqual(['timer.fired']);
  });

  it('sans gestionnaire : seulement l’événement, aucun effet', async () => {
    const store = setup({});
    addTimer(store, { kind: 0, taskId: null });
    const res = await run(store);
    expect(res.handled).toBe(1);
    expect(eventTypes(store)).toEqual(['timer.fired']);
    expect(store.instances[0]).toMatchObject({ status: 1, rowVersion: 3 });
  });

  it('un gestionnaire qui lève annule tout : la minuterie reste active, reprise au bail suivant', async () => {
    const store = setup({});
    addTimer(store, { kind: 0, taskId: null });
    const res = await run(store, { handlers: { 0: jest.fn().mockRejectedValue(new Error('boom')) } });
    expect(res).toMatchObject({ failed: 1, handled: 0 });
    expect(store.timers[0]).toMatchObject({ status: 0, lockedBy: WORKER });
    expect(store.events).toHaveLength(0);
  });

  it('registerTimerHandler : enregistrement global, refusé pour les natures 1 et 2', async () => {
    expect(() => registerTimerHandler(1, jest.fn())).toThrow();
    expect(() => registerTimerHandler(2, jest.fn())).toThrow();
    const store = setup({});
    addTimer(store, { kind: 0, taskId: null });
    const handler = jest.fn().mockResolvedValue(undefined);
    registerTimerHandler(0, handler);
    await run(store);
    expect(handler).toHaveBeenCalledTimes(1);
    registerTimerHandler(0, async () => undefined); // neutralise pour les autres tests
  });
});

describe('readStepParams', () => {
  it('lit échéance, relance et escalade ; distingue absente, invalide et valide', () => {
    const graph = {
      steps: [
        { key: 'a', dueInHours: 4, reminderAfterHours: 1, config: { escalation: { assignee: { kind: 'role', id: 2 }, dueInHours: 6 } } },
        { key: 'b', config: { escalation: { assignee: { kind: 'user', id: -1 } } } },
        { key: 'c' },
      ],
    };
    expect(readStepParams(graph, 'a')).toMatchObject({
      dueInHours: 4,
      reminderAfterHours: 1,
      escalation: { assignee: { kind: 'role', id: 2 }, dueInHours: 6 },
    });
    expect(readStepParams(graph, 'b').escalation).toBeNull();
    expect(readStepParams(graph, 'c').escalation).toBeUndefined();
    expect(readStepParams(graph, 'inconnue')).toEqual({ dueInHours: null, reminderAfterHours: null, escalation: undefined });
    expect(readStepParams(null, 'a').escalation).toBeUndefined();
  });
});
