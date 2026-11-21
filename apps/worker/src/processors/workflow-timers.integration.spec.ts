// Docu-Flow W1 — test d'intégration des minuteries sur PostgreSQL RÉEL.
// Exécuté seulement si WF_TEST_DATABASE_URL pointe une base JETABLE où la migration
// `20261121120000_add_workflow_foundations` (et les migrations précédentes) est appliquée.
// BASE ATTENDUE : une base jetable ne contenant QUE les tables wf_* (migration 20261121120000 seule) ; les tables
// d'identité de remplacement sont alors créées ici. Une base complète (app_user_group existante) est refusée avec
// un message explicite : la cible d'escalade y exigerait de vraies lignes d'utilisateurs, non fournies par ce test.
// Le journal `wf_event_log` est append-only : les données créées ne sont pas nettoyées (base jetable).
import { PrismaClient } from '@prisma/client';
import { runDueTimers } from './workflow-timers.processor';

const url = process.env.WF_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('minuteries du workflow sur PostgreSQL', () => {
  let prisma: PrismaClient;
  const suffix = `${Date.now()}`;
  const hour = 3_600_000;

  beforeAll(() => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasources: { db: { url: url as string } } });
  });
  // La cible d'escalade est vérifiée dans les tables d'identité (app_user_group…). Sur une base jetable qui ne
  // contient QUE les tables wf_*, on crée de simples tables de remplacement ; sur une base complète, rien n'est touché.
  beforeAll(async () => {
    const rows = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.app_user_group') IS NOT NULL AS present`;
    if (rows[0]?.present) {
      throw new Error(
        'Ce test exige une base jetable ne contenant que les tables wf_* (app_user_group existe déjà) : utiliser une base neuve migrée avec 20261121120000 seule.',
      );
    }
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS app_user (user_id int PRIMARY KEY, is_disabled boolean NOT NULL DEFAULT false)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS app_group (group_id int PRIMARY KEY, name text, is_active boolean NOT NULL DEFAULT true)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS role (role_id int PRIMARY KEY, is_active boolean NOT NULL DEFAULT true)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS app_user_group (user_group_id int PRIMARY KEY, user_id int NOT NULL, group_id int NOT NULL, is_default boolean NOT NULL DEFAULT true)`);
    await prisma.$executeRawUnsafe(`INSERT INTO app_user (user_id) VALUES (1), (2) ON CONFLICT DO NOTHING`);
    await prisma.$executeRawUnsafe(`INSERT INTO app_group (group_id) VALUES (1) ON CONFLICT DO NOTHING`);
    await prisma.$executeRawUnsafe(`INSERT INTO app_user_group (user_group_id, user_id, group_id) VALUES (1, 1, 1), (2, 2, 1) ON CONFLICT DO NOTHING`);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seed(opts: {
    name: string;
    escalation?: unknown;
    instanceStatus?: number;
    timers?: number;
  }) {
    const def = await prisma.wfDefinition.create({ data: { name: `${opts.name}-${suffix}` } });
    const graph = {
      schemaVersion: 1,
      start: 'controle',
      steps: [
        {
          key: 'controle',
          name: 'Contrôle',
          type: 'formulaire',
          dueInHours: 24,
          next: [],
          ...(opts.escalation ? { config: { escalation: opts.escalation } } : {}),
        },
      ],
    };
    const version = await prisma.wfDefinitionVersion.create({
      data: { definitionId: def.wfDefinitionId, versionNumber: 1, graph },
    });
    const out: { instanceId: bigint; taskId: bigint; timerIds: bigint[] }[] = [];
    for (let i = 0; i < (opts.timers ?? 1); i += 1) {
      const instance = await prisma.wfInstance.create({
        data: {
          definitionId: def.wfDefinitionId,
          definitionVersionId: version.wfDefinitionVersionId,
          status: opts.instanceStatus ?? 1,
          startedBy: 1,
        },
      });
      const task = await prisma.wfTask.create({
        data: {
          instanceId: instance.wfInstanceId,
          stepKey: 'controle',
          taskType: 0,
          title: 'Contrôle',
          assigneeUserGroupId: 1,
          dueAt: new Date(Date.now() - 1000),
        },
      });
      await prisma.wfInboxItem.create({
        data: {
          taskId: task.wfTaskId,
          instanceId: instance.wfInstanceId,
          title: 'Contrôle',
          assigneeUserGroupId: 1,
          status: 1,
          claimedBy: 1,
          claimedAt: new Date(),
        },
      });
      const timer = await prisma.wfTimer.create({
        data: {
          instanceId: instance.wfInstanceId,
          taskId: task.wfTaskId,
          stepKey: 'controle',
          kind: 2,
          fireAt: new Date(Date.now() - 5000),
          payload: { taskId: task.wfTaskId.toString(), attempt: 1 },
        },
      });
      out.push({ instanceId: instance.wfInstanceId, taskId: task.wfTaskId, timerIds: [timer.wfTimerId] });
    }
    return out;
  }

  const noNotify = async () => undefined;

  it('escalade par ré-affectation, puis expiration + suspension une fois le plafond atteint', async () => {
    const [row] = await seed({ name: 'escalade', escalation: { assignee: { kind: 'user', id: 2 }, dueInHours: 1 } });
    const res1 = await runDueTimers(prisma, { now: new Date(), workerId: 'it:1', notify: noNotify });
    expect(res1.escalated).toBeGreaterThanOrEqual(1);
    const task = await prisma.wfTask.findUniqueOrThrow({ where: { wfTaskId: row!.taskId } });
    expect(task).toMatchObject({ assigneeUserGroupId: 2, assigneeGroupId: null, status: 0 });

    // Nouvelle échéance à now + 1 h : on avance l'horloge, le plafond (1) est atteint.
    const res2 = await runDueTimers(prisma, { now: new Date(Date.now() + 2 * hour), workerId: 'it:1', notify: noNotify });
    expect(res2.expired).toBeGreaterThanOrEqual(1);
    const instance = await prisma.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: row!.instanceId } });
    expect(instance.status).toBe(5);
    const events = await prisma.wfEventLog.findMany({ where: { instanceId: row!.instanceId }, orderBy: { wfEventLogId: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['task.escalated', 'task.expired', 'instance.suspended']),
    );
  });

  it('les instances suspendues ne sont pas réclamées', async () => {
    const [row] = await seed({ name: 'suspendue', instanceStatus: 5 });
    await runDueTimers(prisma, { now: new Date(), workerId: 'it:2', notify: noNotify });
    const timer = await prisma.wfTimer.findUniqueOrThrow({ where: { wfTimerId: row!.timerIds[0]! } });
    expect(timer).toMatchObject({ status: 0, lockedBy: null, attempts: 0 });
  });

  it('deux workers concurrents : chaque minuterie est traitée exactement une fois', async () => {
    const rows = await seed({ name: 'concurrence', timers: 6 });
    const now = new Date();
    await Promise.all([
      runDueTimers(prisma, { now, workerId: 'it:A', batchSize: 3, notify: noNotify }),
      runDueTimers(prisma, { now, workerId: 'it:B', batchSize: 3, notify: noNotify }),
    ]);
    await runDueTimers(prisma, { now, workerId: 'it:A', batchSize: 10, notify: noNotify });
    for (const row of rows) {
      const fired = await prisma.wfEventLog.count({ where: { instanceId: row.instanceId, eventType: 'timer.fired' } });
      expect(fired).toBe(1);
    }
  });
});
