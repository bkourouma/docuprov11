// Docu-Flow W1 — planification BullMQ des minuteries : tick répétable toutes les 15 s (idempotent) + tick
// immédiat au démarrage (rescan après redémarrage : minuteries échues pendant l'arrêt, baux expirés).
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { WF_TIMERS_QUEUE } from '../queue';
import {
  createWorkflowTimersProcessor,
  defaultWorkerId,
  type RunDueTimersResult,
  type WorkflowTimersDeps,
  type WorkflowTimersLog,
} from './workflow-timers.processor';

export const WF_TIMERS_TICK_EVERY_MS = 15_000;
export const WF_TIMERS_SCHEDULER_ID = 'wf-timers-tick';
const TICK_JOB = 'wf-timers-tick';

export interface WorkflowTimersHandle {
  queue: Queue;
  worker: Worker<unknown, RunDueTimersResult>;
}

/**
 * Démarre le consommateur (concurrence 1) et le planificateur. `upsertJobScheduler` est idempotent :
 * redémarrer ne duplique pas la planification. Le tick immédiat est un job ordinaire de la même file.
 */
export async function startWorkflowTimers(
  connection: ConnectionOptions,
  db?: PrismaClient,
  deps: WorkflowTimersDeps = {},
): Promise<WorkflowTimersHandle> {
  const { logger } = await import('../logger');
  const prisma = db ?? (await import('../db')).prisma;
  const log: WorkflowTimersLog = deps.log ?? logger;
  const workerId = deps.workerId ?? defaultWorkerId();

  const queue = new Queue(WF_TIMERS_QUEUE, { connection });
  await queue.upsertJobScheduler(
    WF_TIMERS_SCHEDULER_ID,
    { every: WF_TIMERS_TICK_EVERY_MS },
    { name: TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  // Rescan immédiat : ne pas attendre 15 s après un redémarrage.
  await queue.add(
    `${TICK_JOB}-boot`,
    {},
    { jobId: `${TICK_JOB}-boot-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 },
  );

  const processor = createWorkflowTimersProcessor(prisma, { ...deps, workerId, log });
  const worker = new Worker<unknown, RunDueTimersResult>(WF_TIMERS_QUEUE, async () => processor(), {
    connection,
    concurrency: 1,
  });
  worker.on('ready', () => logger.info({ workerId }, 'wf-timers worker ready'));
  worker.on('completed', (job, res) => {
    // Un tick sans minuterie échue est le cas nominal : débogage seulement.
    if (res.claimed > 0) logger.info({ jobId: job.id, ...res }, 'wf-timers tick');
    else logger.debug({ jobId: job.id }, 'wf-timers tick sans minuterie');
  });
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.name }, 'wf-timers tick en échec'),
  );
  return { queue, worker };
}
