// Docu-Flow W3 - planification BullMQ des balayages d'échéances et de seuils : tick répétable toutes les 5 minutes
// (idempotent) + tick immédiat au démarrage. Crée aussi la file de PRODUCTION `wf-events` (consommée par l'API)
// et branche l'émetteur d'événements, que l'ingestion utilise dès le démarrage.
import { type ConnectionOptions, Queue, Worker } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { WF_DEADLINES_QUEUE, WF_EVENTS_QUEUE } from '../queue';
import { initWorkflowEventEmitter } from './workflow-deadlines.events';
import {
  runWorkflowSweeps,
  type WorkflowSweepLog,
  type WorkflowSweepsResult,
} from './workflow-deadlines.processor';

export const WF_DEADLINES_TICK_EVERY_MS = 5 * 60_000;
export const WF_DEADLINES_SCHEDULER_ID = 'wf-deadlines-tick';
const TICK_JOB = 'wf-deadlines-tick';

export interface WorkflowDeadlinesHandle {
  queue: Queue;
  eventsQueue: Queue;
  worker: Worker<unknown, WorkflowSweepsResult>;
}

export async function startWorkflowDeadlines(
  connection: ConnectionOptions,
  db?: PrismaClient,
  log?: WorkflowSweepLog,
): Promise<WorkflowDeadlinesHandle> {
  // File de production d'abord, et SYNCHRONEMENT : l'ingestion peut émettre dès le démarrage.
  const eventsQueue = new Queue(WF_EVENTS_QUEUE, { connection });
  initWorkflowEventEmitter(eventsQueue);
  const { logger } = await import('../logger');
  const sweepLog: WorkflowSweepLog = log ?? logger;
  initWorkflowEventEmitter(eventsQueue, logger); // même file, avec journalisation des échecs d'émission

  const prisma = db ?? (await import('../db')).prisma;

  const queue = new Queue(WF_DEADLINES_QUEUE, { connection });
  await queue.upsertJobScheduler(
    WF_DEADLINES_SCHEDULER_ID,
    { every: WF_DEADLINES_TICK_EVERY_MS },
    { name: TICK_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  // Balayage immédiat : ne pas attendre 5 minutes après un redémarrage.
  await queue.add(
    `${TICK_JOB}-boot`,
    {},
    { jobId: `${TICK_JOB}-boot-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 },
  );

  const worker = new Worker<unknown, WorkflowSweepsResult>(
    WF_DEADLINES_QUEUE,
    async () => runWorkflowSweeps(prisma, new Date(), undefined, sweepLog),
    { connection, concurrency: 1 },
  );
  worker.on('ready', () => logger.info('wf-deadlines worker ready'));
  worker.on('completed', (job, res) => {
    const emitted = res.deadlines.emitted + res.thresholds.emitted;
    const errors = res.deadlines.errors + res.thresholds.errors;
    if (emitted > 0 || errors > 0) logger.info({ jobId: job.id, ...res }, 'wf-deadlines balayage');
    else logger.debug({ jobId: job.id }, 'wf-deadlines balayage sans événement');
  });
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.name }, 'wf-deadlines balayage en échec'),
  );
  return { queue, eventsQueue, worker };
}
