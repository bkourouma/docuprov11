import { PrismaClient } from '@prisma/client';
import { WorkflowEngine } from './engine';
import type { WfPrincipal } from './engine.types';
// Le processor du worker n'importe que @prisma/client et @archivage/types : on le rejoue ici contre la même base
// que le moteur pour vérifier le contrat entre les deux (minuteries créées par l'api, consommées par le worker).
// Chargé par `require` : le code du worker est hors du `rootDir` de ce projet TypeScript (tsc le refuserait en import).
type RunDueTimers = (
  prisma: PrismaClient,
  opts: { now: Date; workerId: string; notify: () => Promise<void> },
) => Promise<unknown>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runDueTimers } = require('../../../../../worker/src/processors/workflow-timers.processor') as {
  runDueTimers: RunDueTimers;
};

// Intégration CROISÉE moteur (api) + minuteries (worker) sur une base PostgreSQL JETABLE. Ne tourne que si
// WF_TEST_DATABASE_URL est définie ; refuse la base de développement (DATABASE_URL).

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Moteur + worker — expiration puis reprise (intégration PostgreSQL)'
  : 'Moteur + worker — expiration puis reprise (IGNORÉ : définir WF_TEST_DATABASE_URL vers une base jetable)';

const HOUR = 3_600_000;
const RUN = (Math.floor(Date.now() / 1000) % 1_000_000) * 1000;
const user = (id: number): WfPrincipal => ({ userGroupId: id, userId: id, groupIds: [], roleId: null });
const noNotify = (): Promise<void> => Promise.resolve();

suite(title, () => {
  let prisma: PrismaClient;
  let engine: WorkflowEngine;
  let seq = 0;

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    engine = new WorkflowEngine(prisma);
  });

  afterAll(async () => {
    await engine?.whenIdle();
    await prisma?.$disconnect();
  });

  async function publish(graph: object): Promise<number> {
    seq += 1;
    const def = await prisma.wfDefinition.create({ data: { name: `wf-cross-${Date.now()}-${seq}`, status: 1 } });
    await prisma.wfDefinitionVersion.create({
      data: {
        definitionId: def.wfDefinitionId,
        versionNumber: 1,
        status: 1,
        graph,
        publishedAt: new Date(),
        publishedBy: 1,
      },
    });
    return def.wfDefinitionId;
  }

  it('relance puis échéance par le worker, suspension, reprise par le moteur : étape rouverte au passage 2', async () => {
    const assignee = RUN + 5;
    const starter = RUN + 9;
    const definitionId = await publish({
      schemaVersion: 1,
      start: 'saisie',
      steps: [
        {
          key: 'saisie',
          name: 'Saisie',
          type: 'formulaire',
          assignee: { kind: 'user', id: assignee },
          dueInHours: 2,
          reminderAfterHours: 1,
          config: {},
          next: [{ to: 'fin' }],
        },
        { key: 'fin', name: 'Fin', type: 'checklist', assignee: { kind: 'user', id: assignee }, config: { items: [{ key: 'ok' }] }, next: [] },
      ],
    });
    const started = await engine.startInstance({ definitionId, startedBy: starter });
    const instanceId = started.instance.wfInstanceId;
    const id = BigInt(instanceId);

    // L'api crée bien les deux minuteries avec la tâche renseignée.
    const created = await prisma.wfTimer.findMany({ where: { instanceId: id }, orderBy: { kind: 'asc' } });
    expect(created.map((t) => t.kind)).toEqual([1, 2]);
    expect(created.every((t) => t.taskId !== null)).toBe(true);

    // Relance (T+1,2 h) puis échéance (T+2,5 h), jouées par le worker.
    await runDueTimers(prisma, { now: new Date(Date.now() + 1.2 * HOUR), workerId: 'cross:1', notify: noNotify });
    await runDueTimers(prisma, { now: new Date(Date.now() + 2.5 * HOUR), workerId: 'cross:1', notify: noNotify });

    const suspended = await prisma.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: id } });
    expect(suspended.status).toBe(5);
    const [expired] = await prisma.wfTask.findMany({ where: { instanceId: id }, orderBy: { wfTaskId: 'asc' } });
    expect(expired?.status).toBe(4);
    const inbox = await prisma.wfInboxItem.findMany({ where: { instanceId: id } });
    expect(inbox.every((i) => i.status === 4)).toBe(true);

    // Un assigné ne peut plus agir sur une instance suspendue ; le lanceur la reprend via le moteur.
    await expect(
      engine.completeTask({ taskId: String(expired?.wfTaskId), principal: user(assignee), result: { values: {} } }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_STATE|CONFLICT/) });
    const resumed = await engine.resumeInstance({ instanceId, actor: { kind: 'user', userGroupId: starter } });
    expect(resumed.instance.status).toBe(1);

    const tasks = await prisma.wfTask.findMany({ where: { instanceId: id }, orderBy: { wfTaskId: 'asc' } });
    expect(tasks.map((t) => [t.stepKey, t.status, t.attempt])).toEqual([
      ['saisie', 4, 1],
      ['saisie', 0, 2],
    ]);
    const reopened = tasks[1];
    // Nouvelle échéance rouverte et minuterie d'échéance active de nouveau (une seule par étape et nature).
    expect(reopened?.dueAt).not.toBeNull();
    const active = await prisma.wfTimer.findMany({ where: { instanceId: id, status: 0 } });
    expect(active.filter((t) => t.kind === 2)).toHaveLength(1);

    // Le parcours reprend normalement après la reprise.
    const done = await engine.completeTask({
      taskId: String(reopened?.wfTaskId),
      principal: user(assignee),
      result: { values: {} },
    });
    expect(done.openedTasks.map((t) => t.stepKey)).toEqual(['fin']);

    const events = (
      await prisma.wfEventLog.findMany({ where: { instanceId: id }, orderBy: { wfEventLogId: 'asc' } })
    ).map((e) => e.eventType);
    expect(events).toEqual(
      expect.arrayContaining(['timer.fired', 'task.expired', 'instance.suspended', 'instance.resumed', 'task.completed']),
    );
  });
});
