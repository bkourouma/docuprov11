import { PrismaClient } from '@prisma/client';
import { validateWorkflowGraph, type WfGraph } from '@archivage/types';
import { WorkflowEngine } from './engine';
import { WfEngineError, type WfDirectory, type WfEngineErrorCode, type WfPrincipal, type WfTaskExecutor } from './engine.types';
import { WfExecutorRegistry } from './executor-registry';

// Test d'intégration du moteur sur une VRAIE base PostgreSQL JETABLE (verrous, CHECK, uniques
// partiels, déclencheurs append-only). Ne s'exécute que si WF_TEST_DATABASE_URL est définie ; la base
// doit contenir la migration 20261121120000_add_workflow_foundations. JAMAIS la base de développement :
// le test refuse de tourner si l'URL est celle de DATABASE_URL. Aucune donnée n'est supprimée (le journal
// est en ajout seul) : chaque test crée ses propres définitions.

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'WorkflowEngine — intégration PostgreSQL'
  : 'WorkflowEngine — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL vers une base jetable pour l’exécuter)';

const HOUR = 3_600_000;
/** Base d'identifiants propre à cette exécution : la base jetable peut contenir les données d'exécutions précédentes. */
const RUN = (Math.floor(Date.now() / 1000) % 1_000_000) * 1000;

const user = (id: number, groupIds: number[] = [], roleId: number | null = null): WfPrincipal => ({
  userGroupId: id,
  userId: id,
  groupIds,
  roleId,
});
/** Administrateur : aucun lien avec les tâches testées (groupes / rôle sans rapport). */
const ADMIN = user(1, [1], 1);

async function expectCode(promise: Promise<unknown>, code: WfEngineErrorCode): Promise<WfEngineError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WfEngineError);
    expect((err as WfEngineError).code).toBe(code);
    return err as WfEngineError;
  }
  throw new Error(`une erreur ${code} était attendue`);
}

suite(title, () => {
  let prisma: PrismaClient;
  let engine: WorkflowEngine;
  let seq = 0;
  const directory: WfDirectory = {
    isUserGroupActive: (id) => Promise.resolve(id !== 99),
    resolveSubjectOwner: (_type, id) => Promise.resolve(id === '500' ? 77 : null),
    describeUserGroup: (id) => Promise.resolve(`Utilisateur ${id}`),
  };

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    engine = new WorkflowEngine(prisma, { directory });
  });

  afterAll(async () => {
    await engine?.whenIdle();
    await prisma?.$disconnect();
  });

  async function publish(graph: unknown): Promise<number> {
    const check = validateWorkflowGraph(graph);
    expect(check.issues).toEqual([]);
    seq += 1;
    const def = await prisma.wfDefinition.create({ data: { name: `wf-test-${Date.now()}-${seq}`, status: 1 } });
    await prisma.wfDefinitionVersion.create({
      data: {
        definitionId: def.wfDefinitionId,
        versionNumber: 1,
        status: 1,
        graph: graph as object,
        publishedAt: new Date(),
        publishedBy: 1,
      },
    });
    return def.wfDefinitionId;
  }

  const tasksOf = (instanceId: string) =>
    prisma.wfTask.findMany({ where: { instanceId: BigInt(instanceId) }, orderBy: { wfTaskId: 'asc' } });
  const eventsOf = (instanceId: string) =>
    prisma.wfEventLog.findMany({ where: { instanceId: BigInt(instanceId) }, orderBy: { wfEventLogId: 'asc' } });
  const openTask = async (instanceId: string) => {
    const open = await prisma.wfTask.findMany({ where: { instanceId: BigInt(instanceId), status: { in: [0, 1] } } });
    expect(open).toHaveLength(1);
    return open[0]!;
  };
  const instanceRow = (instanceId: string) => prisma.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: BigInt(instanceId) } });

  // Graphe de référence : saisie -> contrôle -> aiguillage (décision auto) -> direction | archivage.
  const expenseGraph = (saisieConfig: Record<string, unknown> = {}, directionRoleId = 7): WfGraph =>
    ({
      schemaVersion: 1,
      start: 'saisie',
      steps: [
        {
          key: 'saisie',
          name: 'Saisie de la demande',
          type: 'formulaire',
          description: 'Renseigner le montant.',
          assignee: { kind: 'initiator' },
          config: { fields: [{ key: 'montant', required: true }, { key: 'motif' }], ...saisieConfig },
          next: [{ to: 'controle' }],
        },
        {
          key: 'controle',
          name: 'Contrôle',
          type: 'validation',
          assignee: { kind: 'user', id: 20 },
          next: [
            { to: 'saisie', label: 'Correction', condition: { field: 'last.approved', op: 'eq', value: false } },
            { to: 'aiguillage' },
          ],
        },
        {
          key: 'aiguillage',
          name: 'Aiguillage',
          type: 'decision',
          next: [
            { to: 'direction', label: 'Gros montant', condition: { field: 'steps.saisie.values.montant', op: 'gt', value: 1000 } },
            { to: 'archivage', label: 'Standard', isDefault: true },
          ],
        },
        { key: 'direction', name: 'Visa direction', type: 'validation', assignee: { kind: 'role', id: directionRoleId }, next: [{ to: 'archivage' }] },
        {
          key: 'archivage',
          name: 'Archivage',
          type: 'checklist',
          config: { items: [{ key: 'classe', required: true }, { key: 'scan' }] },
          next: [],
        },
      ],
    }) as WfGraph;

  // -------------------------------------------------------------------------

  it('lancement : instance en attente, tâche affectée, élément de boîte expliqué, journal', async () => {
    const launcher = RUN + 10;
    const definitionId = await publish(expenseGraph());
    const res = await engine.startInstance({ definitionId, startedBy: launcher, context: { origine: 'test' } });
    expect(res.created).toBe(true);
    expect(res.instance).toMatchObject({ status: 1, startedBy: launcher, rowVersion: 1, finishedAt: null });
    expect(typeof res.instance.wfInstanceId).toBe('string');
    expect(res.instance.context).toMatchObject({ input: { origine: 'test' }, steps: {}, last: null });
    expect(res.openedTasks).toHaveLength(1);
    expect(res.openedTasks[0]).toMatchObject({ stepKey: 'saisie', taskType: 0, status: 0, attempt: 1, assigneeUserGroupId: launcher });
    expect(res.events.map((e) => e.type)).toEqual(['instance.started', 'task.assigned']);

    const inbox = await engine.listInbox(user(launcher), { limit: 10, offset: 0 });
    expect(inbox.total).toBe(1);
    const mine = inbox.items.filter((i) => i.item.instanceId === res.instance.wfInstanceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.item.explanation).toContain('Étape “Saisie de la demande” du workflow');
    expect(mine[0]!.item.explanation).toContain(`(lancé par Utilisateur ${launcher})`);
    expect(mine[0]!.item.summary).toBe('Renseigner le montant.');
    expect(mine[0]!.instanceStatus).toBe(1);

    const events = await eventsOf(res.instance.wfInstanceId);
    expect(events.map((e) => e.eventType)).toEqual(['instance.started', 'task.created', 'task.assigned']);
    expect(events[0]).toMatchObject({ actorKind: 1, actorUserGroupId: launcher });
  });

  it('définition non publiée : DEFINITION_NOT_PUBLISHED', async () => {
    const def = await prisma.wfDefinition.create({ data: { name: `wf-brouillon-${Date.now()}-${++seq}` } });
    await expectCode(engine.startInstance({ definitionId: def.wfDefinitionId, startedBy: 10 }), 'DEFINITION_NOT_PUBLISHED');
  });

  it('idempotence : lancements CONCURRENTS avec la même clé => une seule instance ; autre lanceur refusé', async () => {
    const definitionId = await publish(expenseGraph());
    const key = `mail-${Date.now()}`;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => engine.startInstance({ definitionId, startedBy: 10, idempotencyKey: key })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.instance.wfInstanceId)).size).toBe(1);
    const [a] = results as [(typeof results)[number]];
    expect(await prisma.wfInstance.count({ where: { definitionId, idempotencyKey: key } })).toBe(1);
    const before = await prisma.wfEventLog.count({ where: { instanceId: BigInt(a.instance.wfInstanceId) } });

    const replay = await engine.startInstance({ definitionId, startedBy: 10, idempotencyKey: key });
    expect(replay).toMatchObject({ created: false, events: [], openedTasks: [] });
    expect(await prisma.wfEventLog.count({ where: { instanceId: BigInt(a.instance.wfInstanceId) } })).toBe(before);

    const err = await expectCode(engine.startInstance({ definitionId, startedBy: 11, idempotencyKey: key }), 'IDEMPOTENCY_CONFLICT');
    expect(err.message).not.toContain(a.instance.wfInstanceId);
  });

  it('idempotence : course perdue au moment de l’insertion (violation d’unicité P2002) => instance existante relue', async () => {
    const definitionId = await publish(expenseGraph());
    const key = `course-${Date.now()}`;
    const first = await engine.startInstance({ definitionId, startedBy: 10, idempotencyKey: key });
    // Simule un concurrent qui a passé la vérification préalable AVANT le commit du premier.
    const spy = jest.spyOn(prisma.wfInstance, 'findFirst').mockResolvedValueOnce(null);
    try {
      const second = await engine.startInstance({ definitionId, startedBy: 10, idempotencyKey: key });
      expect(second).toMatchObject({ created: false });
      expect(second.instance.wfInstanceId).toBe(first.instance.wfInstanceId);
      expect(spy).toHaveBeenCalledTimes(2); // pré-vérification (simulée vide) puis relecture après P2002
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.wfInstance.count({ where: { definitionId } })).toBe(1);
  });

  it('parcours complet : formulaire -> validation -> décision automatique -> checklist -> fin', async () => {
    const definitionId = await publish(expenseGraph());
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const id = start.instance.wfInstanceId;

    const s1 = await engine.completeTask({
      taskId: start.openedTasks[0]!.wfTaskId,
      principal: user(10),
      result: { values: { montant: 500, motif: 'Fournitures' } },
      expectedRowVersion: start.instance.rowVersion,
    });
    expect(s1.openedTasks[0]).toMatchObject({ stepKey: 'controle', taskType: 4, assigneeUserGroupId: 20 });

    const s2 = await engine.completeTask({ taskId: s1.openedTasks[0]!.wfTaskId, principal: user(20), result: { approved: true } });
    // Décision automatique enchaînée dans la même transaction : vers « archivage » (montant <= 1000).
    expect(s2.closedTasks.map((t) => t.stepKey)).toEqual(['controle', 'aiguillage']);
    const decision = s2.closedTasks[1]!;
    expect(decision).toMatchObject({ taskType: 5, status: 2, completedBy: null });
    expect(decision.completedAt).not.toBeNull();
    expect(decision.result).toEqual({ decision: { chosen: 'archivage', edgeLabel: 'Standard', matchedCondition: false } });
    expect(s2.openedTasks[0]).toMatchObject({ stepKey: 'archivage', taskType: 2, assigneeUserGroupId: 10 });
    // La décision automatique n'écrase pas « last ».
    expect(s2.instance.context).toMatchObject({ last: { approved: true } });

    await expectCode(
      engine.completeTask({ taskId: s2.openedTasks[0]!.wfTaskId, principal: user(10), result: { checked: ['scan'] } }),
      'INVALID_INPUT',
    );
    const end = await engine.completeTask({ taskId: s2.openedTasks[0]!.wfTaskId, principal: user(10), result: { checked: ['classe'] } });
    expect(end.instance.status).toBe(2);
    expect(end.instance.finishedAt).not.toBeNull();
    expect(end.events.map((e) => e.type)).toContain('instance.completed');

    const events = (await eventsOf(id)).map((e) => e.eventType);
    expect(events).toEqual([
      'instance.started',
      'task.created',
      'task.assigned',
      'task.completed',
      'task.created',
      'task.assigned',
      'task.completed',
      'validation.accepted',
      'task.created',
      'task.completed',
      'task.created',
      'task.assigned',
      'task.completed',
      'instance.completed',
    ]);
    const accepted = (await eventsOf(id)).find((e) => e.eventType === 'validation.accepted')!;
    expect(accepted).toMatchObject({ actorKind: 1, actorUserGroupId: 20, validatedBy: 20 });
    expect(accepted.validatedAt).not.toBeNull();
    const saisieDone = (await eventsOf(id)).find((e) => e.eventType === 'task.completed')!;
    expect(saisieDone.instruction).toBe('Renseigner le montant.');
    expect(saisieDone.decision).toMatchObject({ result: { values: { montant: 500 } }, next: 'controle' });

    const items = await prisma.wfInboxItem.findMany({ where: { instanceId: BigInt(id) } });
    expect(items.map((i) => i.status)).toEqual([2, 2, 2]);
    expect(items.every((i) => i.resolvedAt !== null)).toBe(true);

    const detail = await engine.getInstanceDetail(id);
    expect(detail).not.toBeNull();
    expect(detail!.tasks).toHaveLength(4);
    expect(detail!.versionNumber).toBe(1);
    expect(detail!.events[0]!.eventType).toBe('instance.started');
    expect(typeof detail!.events[0]!.wfEventLogId).toBe('string');
    expect(detail!.events[0]!.occurredAt).toMatch(/Z$/);
  });

  it('boucle de correction : refus puis resoumission (attempt incrémenté), puis branche conditionnée par rôle', async () => {
    const ROLE = RUN + 7;
    const definitionId = await publish(expenseGraph({}, ROLE));
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const id = start.instance.wfInstanceId;
    const s1 = await engine.completeTask({ taskId: start.openedTasks[0]!.wfTaskId, principal: user(10), result: { values: { montant: 2000 } } });

    const rejected = await engine.rejectTask({ taskId: s1.openedTasks[0]!.wfTaskId, principal: user(20), comment: 'Justificatif manquant' });
    expect(rejected.closedTasks[0]!.result).toEqual({ rejected: true, approved: false, comment: 'Justificatif manquant' });
    expect(rejected.openedTasks[0]).toMatchObject({ stepKey: 'saisie', attempt: 2, title: 'Saisie de la demande (passage 2)' });
    const rejectedItem = await prisma.wfInboxItem.findFirstOrThrow({ where: { taskId: BigInt(s1.openedTasks[0]!.wfTaskId) } });
    expect(rejectedItem).toMatchObject({ status: 3, resolvedBy: 20, resolutionComment: 'Justificatif manquant' });
    const types = (await eventsOf(id)).map((e) => e.eventType);
    expect(types).toContain('task.rejected');
    expect(types).toContain('validation.rejected');

    const s3 = await engine.completeTask({ taskId: rejected.openedTasks[0]!.wfTaskId, principal: user(10), result: { values: { montant: 2000 } } });
    expect(s3.openedTasks[0]).toMatchObject({ stepKey: 'controle', attempt: 2 });
    const s4 = await engine.completeTask({ taskId: s3.openedTasks[0]!.wfTaskId, principal: user(20), result: { approved: true } });
    expect(s4.openedTasks[0]).toMatchObject({ stepKey: 'direction', assigneeRoleId: ROLE, assigneeUserGroupId: null });
    expect(s4.closedTasks[1]!.result).toEqual({ decision: { chosen: 'direction', edgeLabel: 'Gros montant', matchedCondition: true } });

    // Rôle : le titulaire du rôle actif agit ; rôle absent ou administrateur : refusé.
    await expectCode(engine.completeTask({ taskId: s4.openedTasks[0]!.wfTaskId, principal: user(21), result: { approved: true } }), 'FORBIDDEN');
    await expectCode(engine.completeTask({ taskId: s4.openedTasks[0]!.wfTaskId, principal: ADMIN, result: { approved: true } }), 'FORBIDDEN');
    const roleInbox = await engine.listInbox(user(RUN + 21, [], ROLE), { limit: 50, offset: 0 });
    expect(roleInbox.items.map((i) => i.task.wfTaskId)).toEqual([s4.openedTasks[0]!.wfTaskId]);
    expect((await engine.listInbox(user(RUN + 21, [], null), { limit: 50, offset: 0 })).total).toBe(0);
    const s5 = await engine.completeTask({ taskId: s4.openedTasks[0]!.wfTaskId, principal: user(21, [], ROLE), result: { approved: true } });
    expect(s5.openedTasks[0]).toMatchObject({ stepKey: 'archivage' });
  });

  it('plafond de boucle de correction (config.maxAttempts) : instance échouée, travail ouvert clos', async () => {
    const definitionId = await publish(expenseGraph({ maxAttempts: 2 }));
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    let taskId = start.openedTasks[0]!.wfTaskId;
    let last = start;
    for (let i = 0; i < 2; i++) {
      const s = await engine.completeTask({ taskId, principal: user(10), result: { values: { montant: 1 } } });
      last = { ...s, created: true };
      const r = await engine.completeTask({ taskId: s.openedTasks[0]!.wfTaskId, principal: user(20), result: { approved: false } });
      last = { ...r, created: true };
      taskId = r.openedTasks[0]?.wfTaskId ?? '';
    }
    expect(last.instance.status).toBe(3);
    expect(last.instance.errorMessage).toContain('Boucle de correction dépassée');
    expect(last.instance.finishedAt).not.toBeNull();
    const id = start.instance.wfInstanceId;
    expect(await prisma.wfTask.count({ where: { instanceId: BigInt(id), status: { in: [0, 1] } } })).toBe(0);
    expect(await prisma.wfInboxItem.count({ where: { instanceId: BigInt(id), status: { in: [0, 1] } } })).toBe(0);
    expect((await eventsOf(id)).at(-1)!.eventType).toBe('instance.failed');
  });

  it('garde-fou d’enchaînement automatique : boucle de décisions => instance échouée', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'd1',
      steps: [
        {
          key: 'd1',
          name: 'D1',
          type: 'decision',
          next: [
            { to: 'd2', condition: { field: 'input.x', op: 'eq', value: 1 } },
            { to: 'fin', condition: { field: 'input.x', op: 'eq', value: 2 } },
          ],
        },
        {
          key: 'd2',
          name: 'D2',
          type: 'decision',
          next: [
            { to: 'd1', condition: { field: 'input.x', op: 'eq', value: 1 } },
            { to: 'fin', condition: { field: 'input.x', op: 'eq', value: 2 } },
          ],
        },
        { key: 'fin', name: 'Fin', type: 'formulaire', next: [] },
      ],
    });
    const res = await engine.startInstance({ definitionId, startedBy: 10, context: { x: 1 } });
    expect(res.instance.status).toBe(3);
    expect(res.instance.errorMessage).toContain('Enchaînement automatique dépassé');
    expect(await prisma.wfTask.count({ where: { instanceId: BigInt(res.instance.wfInstanceId) } })).toBe(50);
  });

  it('refus sans voie de correction : tâche close, instance SUSPENDUE, puis reprise (étape rouverte, attempt + 1)', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'avis',
      steps: [
        { key: 'avis', name: 'Avis', type: 'validation', assignee: { kind: 'user', id: 20 }, next: [{ to: 'fin' }] },
        { key: 'fin', name: 'Fin', type: 'formulaire', next: [] },
      ],
    });
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const id = start.instance.wfInstanceId;
    const rejected = await engine.rejectTask({ taskId: start.openedTasks[0]!.wfTaskId, principal: user(20) });
    expect(rejected.instance.status).toBe(5);
    expect(rejected.instance.finishedAt).toBeNull();
    expect(rejected.openedTasks).toEqual([]);
    expect(rejected.events.map((e) => e.type)).toEqual(['task.rejected', 'instance.suspended']);
    const suspendedEvent = (await eventsOf(id)).find((e) => e.eventType === 'instance.suspended')!;
    expect(JSON.stringify(suspendedEvent.decision)).toContain('aucune voie de correction');

    await expectCode(engine.suspendInstance({ instanceId: id, actor: { kind: 'user', userGroupId: 10 } }), 'INVALID_STATE');
    const resumed = await engine.resumeInstance({ instanceId: id, actor: { kind: 'user', userGroupId: 10 } });
    expect(resumed.instance.status).toBe(1);
    expect(resumed.openedTasks[0]).toMatchObject({ stepKey: 'avis', attempt: 2, assigneeUserGroupId: 20 });
    const done = await engine.completeTask({ taskId: resumed.openedTasks[0]!.wfTaskId, principal: user(20), result: { approved: true } });
    expect(done.openedTasks[0]).toMatchObject({ stepKey: 'fin' });
    await expectCode(engine.resumeInstance({ instanceId: id, actor: { kind: 'user', userGroupId: 10 } }), 'INVALID_STATE');
  });

  it('minuteries à l’entrée d’étape (dueInHours / reminderAfterHours), suspension et reprise avec décalage', async () => {
    let now = new Date('2026-12-01T08:00:00.000Z');
    const clocked = new WorkflowEngine(prisma, { directory, now: () => now });
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'piece',
      steps: [
        { key: 'piece', name: 'Pièce', type: 'formulaire', dueInHours: 24, reminderAfterHours: 2, next: [{ to: 'fin' }] },
        { key: 'fin', name: 'Fin', type: 'formulaire', next: [] },
      ],
    });
    const t0 = now.getTime();
    const start = await clocked.startInstance({ definitionId, startedBy: 10 });
    const id = BigInt(start.instance.wfInstanceId);
    const task = start.openedTasks[0]!;
    expect(task.dueAt).toBe(new Date(t0 + 24 * HOUR).toISOString());
    const timers = await prisma.wfTimer.findMany({ where: { instanceId: id }, orderBy: { kind: 'asc' } });
    expect(timers.map((t) => [t.kind, t.status, t.fireAt.getTime()])).toEqual([
      [1, 0, t0 + 2 * HOUR],
      [2, 0, t0 + 24 * HOUR],
    ]);
    expect(timers[0]!.payload).toEqual({ taskId: task.wfTaskId, attempt: 1 });
    expect((await eventsOf(start.instance.wfInstanceId)).filter((e) => e.eventType === 'timer.scheduled')).toHaveLength(2);

    now = new Date(t0 + HOUR);
    const suspended = await clocked.suspendInstance({ instanceId: start.instance.wfInstanceId, actor: { kind: 'user', userGroupId: 10 }, reason: 'Congés' });
    expect(suspended.instance.status).toBe(5);
    // Suspendue : toute action est refusée, la tâche reste ouverte.
    await expectCode(clocked.completeTask({ taskId: task.wfTaskId, principal: user(10), result: { values: {} } }), 'INVALID_STATE');
    await expectCode(clocked.claimTask({ taskId: task.wfTaskId, principal: user(10) }), 'INVALID_STATE');
    expect((await openTask(start.instance.wfInstanceId)).status).toBe(0);

    now = new Date(t0 + 4 * HOUR); // 3 h de suspension
    const resumed = await clocked.resumeInstance({ instanceId: start.instance.wfInstanceId, actor: { kind: 'system' } });
    expect(resumed.instance.status).toBe(1);
    const shifted = await prisma.wfTimer.findMany({ where: { instanceId: id }, orderBy: { kind: 'asc' } });
    expect(shifted.map((t) => t.fireAt.getTime())).toEqual([t0 + 5 * HOUR, t0 + 27 * HOUR]);
    expect((await openTask(start.instance.wfInstanceId)).dueAt!.getTime()).toBe(t0 + 27 * HOUR);
    const item = await prisma.wfInboxItem.findFirstOrThrow({ where: { instanceId: id } });
    expect(item.dueAt!.getTime()).toBe(t0 + 27 * HOUR);
    const resumedEvent = (await eventsOf(start.instance.wfInstanceId)).find((e) => e.eventType === 'instance.resumed')!;
    expect(resumedEvent.decision).toMatchObject({ pausedSeconds: 3 * 3600 });

    // Étape quittée : ses minuteries actives sont annulées.
    await clocked.completeTask({ taskId: task.wfTaskId, principal: user(10), result: { values: {} } });
    const after = await prisma.wfTimer.findMany({ where: { instanceId: id } });
    expect(after.every((t) => t.status === 2 && t.lockedBy === null)).toBe(true);
  });

  it('annulation : tâches annulées, boîte annulée, minuteries annulées ; refusée si déjà terminale', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'a',
      steps: [
        { key: 'a', name: 'A', type: 'formulaire', dueInHours: 5, next: [{ to: 'b' }] },
        { key: 'b', name: 'B', type: 'formulaire', next: [] },
      ],
    });
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const id = start.instance.wfInstanceId;
    const cancelled = await engine.cancelInstance({ instanceId: id, actor: { kind: 'user', userGroupId: 10 }, reason: 'Doublon' });
    expect(cancelled.instance.status).toBe(4);
    expect(cancelled.instance.finishedAt).not.toBeNull();
    expect(cancelled.closedTasks[0]).toMatchObject({ status: 3 });
    expect((await prisma.wfInboxItem.findFirstOrThrow({ where: { instanceId: BigInt(id) } })).status).toBe(5);
    expect((await prisma.wfTimer.findFirstOrThrow({ where: { instanceId: BigInt(id) } })).status).toBe(2);
    expect((await eventsOf(id)).map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['task.cancelled', 'timer.cancelled', 'instance.cancelled']),
    );
    await expectCode(engine.cancelInstance({ instanceId: id, actor: { kind: 'system' } }), 'INVALID_STATE');
    await expectCode(engine.completeTask({ taskId: start.openedTasks[0]!.wfTaskId, principal: user(10), result: { values: {} } }), 'INVALID_STATE');
    await expectCode(engine.cancelInstance({ instanceId: '999999999', actor: { kind: 'system' } }), 'NOT_FOUND');
    await expectCode(engine.cancelInstance({ instanceId: id, actor: { kind: 'user' } }), 'INVALID_INPUT');
  });

  it('droits : groupe (prise en charge exclusive), non assigné, administrateur sans pouvoir, boîte filtrée', async () => {
    const G = RUN + 3;
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'g',
      steps: [
        { key: 'g', name: 'Tâche de groupe', type: 'formulaire', assignee: { kind: 'group', id: G }, config: { priority: 'haute' }, next: [] },
      ],
    });
    const start = await engine.startInstance({ definitionId, startedBy: RUN + 110 });
    const taskId = start.openedTasks[0]!.wfTaskId;
    expect(start.openedTasks[0]).toMatchObject({ assigneeGroupId: G, assigneeUserGroupId: null, priority: 2 });

    const listFor = async (p: WfPrincipal) => (await engine.listInbox(p, { limit: 200, offset: 0 })).items;
    expect((await listFor(user(RUN + 11, [G]))).map((i) => i.task.wfTaskId)).toEqual([taskId]);
    expect(await listFor(user(RUN + 12, [G + 1]))).toHaveLength(0);
    expect(await listFor(user(RUN + 110))).toHaveLength(0); // le lanceur n'est pas bénéficiaire
    expect((await listFor(ADMIN)).some((i) => i.task.wfTaskId === taskId)).toBe(false);

    for (const action of [
      () => engine.claimTask({ taskId, principal: user(12, [4]) }),
      () => engine.completeTask({ taskId, principal: ADMIN, result: { values: {} } }),
      () => engine.rejectTask({ taskId, principal: ADMIN }),
      () => engine.delegateTask({ taskId, principal: ADMIN, toUserGroupId: 1 }),
    ]) {
      await expectCode(action(), 'FORBIDDEN');
    }
    await expectCode(engine.completeTask({ taskId: '123456789012', principal: user(11, [G]), result: {} }), 'NOT_FOUND');

    const claimed = await engine.claimTask({ taskId, principal: user(11, [G]) });
    expect(claimed.instance.rowVersion).toBe(start.instance.rowVersion + 1);
    const again = await engine.claimTask({ taskId, principal: user(11, [G]) });
    expect(again.instance.rowVersion).toBe(claimed.instance.rowVersion); // déjà prise par moi : aucune écriture
    const item = await prisma.wfInboxItem.findFirstOrThrow({ where: { taskId: BigInt(taskId) } });
    expect(item).toMatchObject({ status: 1, claimedBy: 11 });
    expect((await prisma.wfTask.findUniqueOrThrow({ where: { wfTaskId: BigInt(taskId) } })).status).toBe(1);

    await expectCode(engine.completeTask({ taskId, principal: user(13, [G]), result: { values: {} } }), 'CONFLICT');
    await expectCode(engine.claimTask({ taskId, principal: user(13, [G]) }), 'CONFLICT');
    const done = await engine.completeTask({ taskId, principal: user(11, [G]), result: { values: { ok: true } } });
    expect(done.instance.status).toBe(2);
    expect(done.closedTasks[0]).toMatchObject({ completedBy: 11 });
  });

  it('double complétion concurrente : une seule gagne, l’autre reçoit CONFLICT ; version attendue périmée', async () => {
    const definitionId = await publish(expenseGraph());
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const taskId = start.openedTasks[0]!.wfTaskId;

    await expectCode(
      engine.completeTask({ taskId, principal: user(10), result: { values: { montant: 1 } }, expectedRowVersion: start.instance.rowVersion + 5 }),
      'CONFLICT',
    );
    const outcomes = await Promise.allSettled(
      [1, 2, 3].map((n) => engine.completeTask({ taskId, principal: user(10), result: { values: { montant: n } } })),
    );
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect((r.reason as WfEngineError).code).toBe('CONFLICT');
    const id = start.instance.wfInstanceId;
    expect(await prisma.wfTask.count({ where: { instanceId: BigInt(id), stepKey: 'controle' } })).toBe(1);
    expect((await eventsOf(id)).filter((e) => e.eventType === 'task.completed')).toHaveLength(1);
  });

  it('résultat invalide : INVALID_INPUT et rien n’est écrit', async () => {
    const definitionId = await publish(expenseGraph());
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const taskId = start.openedTasks[0]!.wfTaskId;
    const before = await eventsOf(start.instance.wfInstanceId);
    const err = await expectCode(engine.completeTask({ taskId, principal: user(10), result: { values: { motif: 'x' } } }), 'INVALID_INPUT');
    expect(err.details).toEqual({ issues: ['le champ « montant » est obligatoire'] });
    await expectCode(engine.completeTask({ taskId, principal: user(10), result: 'texte' }), 'INVALID_INPUT');
    expect((await instanceRow(start.instance.wfInstanceId)).rowVersion).toBe(start.instance.rowVersion);
    expect(await eventsOf(start.instance.wfInstanceId)).toHaveLength(before.length);
  });

  it('journal append-only : la base refuse UPDATE, DELETE et TRUNCATE', async () => {
    const definitionId = await publish(expenseGraph());
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const id = BigInt(start.instance.wfInstanceId);
    await expect(prisma.$executeRaw`UPDATE "wf_event_log" SET "event_type" = 'falsifie' WHERE "instance_id" = ${id}`).rejects.toThrow(
      /ajout seul/,
    );
    await expect(prisma.$executeRaw`DELETE FROM "wf_event_log" WHERE "instance_id" = ${id}`).rejects.toThrow(/ajout seul/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE "wf_event_log" CASCADE')).rejects.toThrow(/ajout seul/);
    expect(await prisma.wfEventLog.count({ where: { instanceId: id } })).toBe(3);
  });

  it('délégation : réaffecte, vide la prise en charge, journalise ; destinataire inactif refusé', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'a',
      steps: [{ key: 'a', name: 'A', type: 'validation', assignee: { kind: 'user', id: 20 }, next: [] }],
    });
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const taskId = start.openedTasks[0]!.wfTaskId;
    await engine.claimTask({ taskId, principal: user(20) });
    await expectCode(engine.delegateTask({ taskId, principal: user(20), toUserGroupId: 99 }), 'INVALID_INPUT');
    await expectCode(engine.delegateTask({ taskId, principal: user(20), toUserGroupId: 20 }), 'INVALID_INPUT');

    const delegated = await engine.delegateTask({ taskId, principal: user(20), toUserGroupId: 30, comment: 'Absent demain' });
    expect(delegated.events).toEqual([
      expect.objectContaining({ type: 'task.delegated', assignee: { userGroupId: 30 }, taskId }),
    ]);
    const task = await prisma.wfTask.findUniqueOrThrow({ where: { wfTaskId: BigInt(taskId) } });
    expect(task).toMatchObject({ assigneeUserGroupId: 30, status: 0 });
    const item = await prisma.wfInboxItem.findFirstOrThrow({ where: { taskId: BigInt(taskId) } });
    expect(item).toMatchObject({ assigneeUserGroupId: 30, status: 0, claimedBy: null, claimedAt: null });
    const log = (await eventsOf(start.instance.wfInstanceId)).find((e) => e.eventType === 'task.delegated')!;
    expect(log).toMatchObject({ actorKind: 1, actorUserGroupId: 20, explanation: 'Absent demain' });

    await expectCode(engine.completeTask({ taskId, principal: user(20), result: { approved: true } }), 'FORBIDDEN');
    const done = await engine.completeTask({ taskId, principal: user(30), result: { approved: true } });
    expect(done.instance.status).toBe(2);
  });

  it('affectation : l’étape suivante sans bénéficiaire propre va au groupe choisi ; personne inactive refusée', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'choix',
      steps: [
        { key: 'choix', name: 'Choisir le service', type: 'affectation', next: [{ to: 'traitement' }] },
        { key: 'traitement', name: 'Traitement', type: 'formulaire', next: [] },
      ],
    });
    const start = await engine.startInstance({ definitionId, startedBy: 10 });
    const taskId = start.openedTasks[0]!.wfTaskId;
    await expectCode(engine.completeTask({ taskId, principal: user(10), result: { assignee: { userGroupId: 99 } } }), 'INVALID_INPUT');
    const res = await engine.completeTask({ taskId, principal: user(10), result: { assignee: { groupId: 6 } } });
    expect(res.openedTasks[0]).toMatchObject({ stepKey: 'traitement', assigneeGroupId: 6, assigneeUserGroupId: null });
    expect(res.instance.context).toMatchObject({ assignedTo: { groupId: 6 } });
  });

  it('subject_owner : propriétaire résolu par l’annuaire, sinon repli sur le lanceur (expliqué)', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'a',
      steps: [{ key: 'a', name: 'A', type: 'formulaire', assignee: { kind: 'subject_owner' }, next: [] }],
    });
    const owned = await engine.startInstance({ definitionId, startedBy: 10, subjectType: 'mail', subjectId: '500' });
    expect(owned.openedTasks[0]).toMatchObject({ assigneeUserGroupId: 77 });
    expect(owned.instance).toMatchObject({ subjectType: 'mail', subjectId: '500' });
    const fallback = await engine.startInstance({ definitionId, startedBy: 10, subjectType: 'mail', subjectId: '501' });
    expect(fallback.openedTasks[0]).toMatchObject({ assigneeUserGroupId: 10 });
    const assigned = (await eventsOf(fallback.instance.wfInstanceId)).find((e) => e.eventType === 'task.assigned')!;
    expect(assigned.explanation).toContain('introuvable');
    await expectCode(engine.startInstance({ definitionId, startedBy: 10, subjectType: 'mail' }), 'INVALID_INPUT');
  });

  it('étape agent sans exécuteur : tâche échouée et instance échouée avec un message clair', async () => {
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'ia',
      steps: [{ key: 'ia', name: 'Analyse IA', type: 'agent', agent: { objective: 'Classer', tools: [] }, next: [] }],
    });
    const res = await engine.startInstance({ definitionId, startedBy: 10 });
    expect(res.instance.status).toBe(3);
    expect(res.instance.errorMessage).toContain('aucun exécuteur « agent »');
    expect(res.closedTasks[0]).toMatchObject({ taskType: 6, status: 5 });
  });

  it('exécuteurs (après commit) : agent qui propose (boîte kind 1, acceptée), agent qui termine, agent en échec', async () => {
    let mode: 'propose' | 'complete' | 'fail' | 'throw' = 'propose';
    const calls: string[] = [];
    const agent: WfTaskExecutor = {
      taskType: 'agent',
      execute: (ctx) => {
        calls.push(ctx.taskId);
        expect(ctx.runAs).toEqual({ userGroupId: 10 });
        if (mode === 'throw') return Promise.reject(new Error('panne réseau'));
        if (mode === 'fail') return Promise.resolve({ kind: 'fail', error: 'document illisible' });
        if (mode === 'complete') return Promise.resolve({ kind: 'complete', result: { classe: 'facture' } });
        return Promise.resolve({ kind: 'propose', proposal: { classe: 'facture' }, explanation: 'Mot « facture » en en-tête', confidence: 0.91 });
      },
    };
    const registry = new WfExecutorRegistry();
    registry.register(agent);
    const published: string[] = [];
    const withAgent = new WorkflowEngine(prisma, {
      registry,
      directory,
      onEvents: (events) => {
        published.push(...events.map((e) => e.type));
      },
    });
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'ia',
      steps: [
        { key: 'ia', name: 'Analyse IA', type: 'agent', assignee: { kind: 'user', id: 20 }, agent: { objective: 'Classer', tools: [] }, next: [{ to: 'fin' }] },
        { key: 'fin', name: 'Fin', type: 'formulaire', next: [] },
      ],
    });

    // 1) Proposition : élément kind 1 avec explication ; un humain l'accepte.
    const p = await withAgent.startInstance({ definitionId, startedBy: 10 });
    expect(p.instance.status).toBe(0);
    await withAgent.whenIdle();
    const proposal = await prisma.wfInboxItem.findFirstOrThrow({ where: { instanceId: BigInt(p.instance.wfInstanceId) } });
    expect(proposal).toMatchObject({ kind: 1, status: 0, assigneeUserGroupId: 20, explanation: 'Mot « facture » en en-tête' });
    expect(proposal.proposal).toEqual({ classe: 'facture' });
    expect(proposal.confidence?.toString()).toBe('0.91');
    expect(proposal.agentEventId).not.toBeNull();
    expect((await instanceRow(p.instance.wfInstanceId)).status).toBe(1);
    expect(published).toContain('task.assigned');
    expect(await withAgent.rescanExecutors()).toBe(0); // une proposition attend : rien à relancer
    const accepted = await withAgent.completeTask({ taskId: p.openedTasks[0]!.wfTaskId, principal: user(20), result: { classe: 'facture' } });
    expect(accepted.openedTasks[0]).toMatchObject({ stepKey: 'fin' });
    const resolved = await prisma.wfInboxItem.findUniqueOrThrow({ where: { wfInboxItemId: proposal.wfInboxItemId } });
    expect(resolved).toMatchObject({ status: 2, resolvedBy: 20, resolution: { outcome: 'accepted' } });

    // 2) Résultat produit : la tâche est terminée par l'agent et l'instance avance.
    mode = 'complete';
    const c = await withAgent.startInstance({ definitionId, startedBy: 10 });
    await withAgent.whenIdle();
    const agentTask = await prisma.wfTask.findUniqueOrThrow({ where: { wfTaskId: BigInt(c.openedTasks[0]!.wfTaskId) } });
    expect(agentTask).toMatchObject({ status: 2, completedBy: null, result: { classe: 'facture' } });
    const completedLog = (await eventsOf(c.instance.wfInstanceId)).find((e) => e.eventType === 'task.completed')!;
    expect(completedLog.actorKind).toBe(2);
    expect((await openTask(c.instance.wfInstanceId)).stepKey).toBe('fin');

    // 3) Exception de l'exécuteur : journalisée, la tâche passe à son bénéficiaire humain (kind 0).
    mode = 'throw';
    const t = await withAgent.startInstance({ definitionId, startedBy: 10 });
    await withAgent.whenIdle();
    expect((await instanceRow(t.instance.wfInstanceId)).status).toBe(1);
    const humanItem = await prisma.wfInboxItem.findFirstOrThrow({ where: { instanceId: BigInt(t.instance.wfInstanceId) } });
    expect(humanItem).toMatchObject({ kind: 0, assigneeUserGroupId: 20 });
    expect((await eventsOf(t.instance.wfInstanceId)).map((e) => e.eventType)).toContain('executor.error');

    // 4) Échec déclaré : tâche échouée, instance échouée.
    mode = 'fail';
    const f = await withAgent.startInstance({ definitionId, startedBy: 10 });
    await withAgent.whenIdle();
    const failed = await instanceRow(f.instance.wfInstanceId);
    expect(failed.status).toBe(3);
    expect(failed.errorMessage).toContain('document illisible');
    expect((await tasksOf(f.instance.wfInstanceId))[0]!.status).toBe(5);
    expect(calls).toHaveLength(4);
  });

  it('lecture : listInstances filtré et paginé, détail inconnu => null', async () => {
    const definitionId = await publish(expenseGraph());
    await engine.startInstance({ definitionId, startedBy: 41 });
    await engine.startInstance({ definitionId, startedBy: 41 });
    await engine.startInstance({ definitionId, startedBy: 42 });
    const mine = await engine.listInstances({ startedBy: 41, definitionId, limit: 1, offset: 0 });
    expect(mine.total).toBe(2);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]!.startedBy).toBe(41);
    const waiting = await engine.listInstances({ definitionId, statuses: [1], limit: 10, offset: 0 });
    expect(waiting.total).toBe(3);
    expect(await engine.getInstanceDetail('999999999')).toBeNull();
    expect(await engine.getInstanceDetail('abc')).toBeNull();
  });
});
