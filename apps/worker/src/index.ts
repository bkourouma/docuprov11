import './config/load-env';
import { mkdirSync } from 'node:fs';
import { type ConnectionOptions, Queue, Worker, type Job } from 'bullmq';
import { loadEnv } from './config/env';
import { logger } from './logger';
import { prisma } from './db';
import {
  ACQUISITION_QUEUE,
  GED_AI_QUEUE,
  REMINDER_JOBS,
  REMINDERS_QUEUE,
  type AcquisitionJobData,
  createRedis,
} from './queue';
import { join } from 'node:path';
import { createBrandLoader, createMailer, loadInlineLogo, type Mailer } from '@archivage/mailer';
import type { GedAiPipelineJobData } from '@archivage/types';
import { createAiPipelineProcessor } from './processors/ai-pipeline.processor';
import { processBatch } from './processors/acquisition.processor';
import {
  runDateButoireReminders,
  runInputationReminders,
  type ReminderEnv,
} from './processors/mail-reminders.processor';
// --- Lot 3 : indexation sémantique ---
import { GED_EMBEDDING_QUEUE } from './queue';
import { GED_EMBEDDING_JOBS } from '@archivage/types';
import type { GedEmbeddingJobData } from '@archivage/types';
import { createEmbeddingProcessor } from './processors/embedding-processor';
// --- fin lot 3 ---

/**
 * Rappels Docu-Courriers (§03.5) : planificateurs répétables + consommateur.
 * `upsertJobScheduler` est idempotent — redémarrer le worker ne duplique pas les crons, et une
 * modification de cadence remplace l'ancienne planification.
 */
async function startReminders(
  connection: ConnectionOptions,
  reminderEnv: ReminderEnv,
  tz: string,
  mailer: Mailer,
): Promise<void> {
  const queue = new Queue(REMINDERS_QUEUE, { connection });
  await queue.upsertJobScheduler(
    REMINDER_JOBS.dateButoire,
    { pattern: '10 13 * * *', tz }, // 13h10 chaque jour (source Hangfire)
    { name: REMINDER_JOBS.dateButoire },
  );
  await queue.upsertJobScheduler(
    REMINDER_JOBS.inputationDeadline,
    { pattern: '* * * * *', tz }, // chaque minute (source Hangfire)
    { name: REMINDER_JOBS.inputationDeadline },
  );

  const worker = new Worker(
    REMINDERS_QUEUE,
    async (job: Job) => {
      const now = new Date();
      const res =
        job.name === REMINDER_JOBS.dateButoire
          ? await runDateButoireReminders(prisma, now, mailer)
          : await runInputationReminders(prisma, now, reminderEnv, mailer);
      // Un tick qui ne notifie personne est le cas nominal : on ne le loggue qu'en debug.
      if (res.notified > 0) logger.info({ job: job.name, ...res }, 'rappels envoyés');
      else logger.debug({ job: job.name, ...res }, 'tick sans rappel');
      return res;
    },
    { connection },
  );

  worker.on('ready', () => logger.info('reminders worker ready'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, job: job?.name, err: err.message }, 'rappel en échec'),
  );
}

// --- Lot 3 : indexation sémantique ---
/**
 * Indexation sémantique : segmentation + embeddings des documents archivés. Concurrence 1 (un
 * fournisseur local est souvent mono-GPU). Le rattrapage (`sweep`) est planifié toutes les 10 min par
 * `upsertJobScheduler` (idempotent, calque de `startReminders`) ; sans configuration IA il ne fait rien.
 */
async function startEmbedding(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(GED_EMBEDDING_QUEUE, { connection });
  await queue.upsertJobScheduler(
    'ged-embedding-sweep',
    { every: 10 * 60 * 1000 },
    { name: GED_EMBEDDING_JOBS.sweep },
  );

  const worker = new Worker<GedEmbeddingJobData>(
    GED_EMBEDDING_QUEUE,
    createEmbeddingProcessor(prisma, { queue }),
    { connection, concurrency: 1 },
  );
  worker.on('ready', () => logger.info('ged-embedding worker ready'));
  worker.on('completed', (job, result) =>
    logger.info(
      {
        jobId: job.id,
        job: job.name,
        disabled: result.disabled,
        ...(result.disabled
          ? {}
          : 'queued' in result
            ? { queued: result.queued }
            : { documentId: result.documentId, skipped: result.skipped, chunks: result.chunks }),
      },
      'ged-embedding job completed',
    ),
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, job: job?.name, err: err.message }, 'ged-embedding job failed'),
  );
}
// --- fin lot 3 ---

function main(): void {
  const env = loadEnv();
  const connection = createRedis(env.REDIS_URL);
  const acquisitionEnv = {
    archivesPath: env.ARCHIVES_PATH,
    tesseractLang: env.TESSERACT_LANG,
    tesseractDataPath: env.TESSERACT_DATA_PATH,
  };

  // Ensure the disk vault exists at startup (don't wait for the first acquisition).
  mkdirSync(acquisitionEnv.archivesPath, { recursive: true });
  logger.info(`Disk vault ready at ${acquisitionEnv.archivesPath}`);

  // Canal e-mail des rappels (§03.5) — même configuration que l'API. Sans SMTP_HOST il reste
  // désactivé et les rappels partent en notification in-app seule.
  const mailer = createMailer(
    {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM,
      appBaseUrl: env.APP_BASE_URL,
      orgName: env.MAIL_ORG_NAME,
      logoUrl: env.MAIL_LOGO_URL,
      productName: 'DocuPro',
    },
    (msg) => logger.warn(msg),
  );
  logger.info(
    mailer.enabled
      ? `Canal e-mail des rappels actif via ${env.SMTP_HOST}:${env.SMTP_PORT}`
      : 'SMTP_HOST absent : rappels en notification in-app seule.',
  );

  // Identité (nom, coordonnées) + logo EMBARQUÉ, lus en base à chaque envoi avec un cache court — un
  // rappel planifié doit porter la même marque qu'une notification d'enregistrement, y compris après
  // une modification faite en cours de journée depuis l'écran de paramétrage. Le worker tourne des
  // semaines d'affilée : figer l'identité au démarrage la rendrait durablement obsolète.
  const brandingDir = join(env.ARCHIVES_PATH, '_branding');
  const brandLoader = createBrandLoader(prisma.emailTemplateSetting, {
    fallback: {
      orgName: env.MAIL_ORG_NAME,
      logoUrl: env.MAIL_LOGO_URL,
      productName: 'DocuPro',
    },
    // Logo déposé sur le serveur : embarqué dans le message (CID), jamais référencé par URL — seul
    // rendu fiable depuis une boîte mail.
    loadInlineLogo: (row) => loadInlineLogo(brandingDir, row.logoFileName),
  });
  const brandedMailer: Mailer = {
    enabled: mailer.enabled,
    async send(input) {
      // `input.brand`/`inlineLogo` d'abord écrasés par le paramétrage : aucun appelant du worker
      // n'en fournit, et l'identité de l'organisation doit rester la référence.
      const { brand, inlineLogo } = await brandLoader.load();
      return mailer.send({ ...input, brand, ...(inlineLogo ? { inlineLogo } : {}) });
    },
    close: () => mailer.close(),
  };

  const worker = new Worker<AcquisitionJobData>(
    ACQUISITION_QUEUE,
    async (job: Job<AcquisitionJobData>) => {
      try {
        await processBatch(job.data.batchId, acquisitionEnv);
      } catch (err) {
        await prisma.acquisitionBatch
          .update({ where: { batchId: job.data.batchId }, data: { status: 2 } })
          .catch(() => undefined);
        throw err;
      }
    },
    { connection: connection as unknown as ConnectionOptions },
  );

  worker.on('ready', () => logger.info('acquisition worker ready'));
  worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'job failed'),
  );

  // Socle IA : pipeline lecture → classement → extraction. Concurrence 1 (un fournisseur local est
  // souvent mono-GPU). Sans configuration IA le job réussit immédiatement (« IA désactivée »).
  const aiWorker = new Worker<GedAiPipelineJobData>(
    GED_AI_QUEUE,
    createAiPipelineProcessor(prisma),
    { connection: connection as unknown as ConnectionOptions, concurrency: 1 },
  );
  aiWorker.on('ready', () => logger.info('ged-ai worker ready'));
  aiWorker.on('completed', (job, result) =>
    logger.info(
      {
        jobId: job.id,
        documentId: job.data.documentId,
        disabled: result.disabled,
        ...(result.disabled ? {} : { skipped: result.skipped, decisions: result.decisions.length }),
      },
      'ged-ai job completed',
    ),
  );
  aiWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'ged-ai job failed'),
  );

  // --- Lot 3 : indexation sémantique ---
  void startEmbedding(connection as unknown as ConnectionOptions)
    .then(() => logger.info(`Indexation sémantique active sur la file "${GED_EMBEDDING_QUEUE}".`))
    .catch((err: Error) =>
      logger.error({ err: err.message }, 'démarrage de l’indexation sémantique impossible'),
    );
  // --- fin lot 3 ---

  void startReminders(
    connection as unknown as ConnectionOptions,
    {
      delaisAlerteHours: env.DELAIS_ALERTE_HOURS,
      delaisAlerteIntervalHours: env.DELAIS_ALERTE_INTERVAL_HOURS,
    },
    env.REMINDERS_TZ,
    brandedMailer,
  ).catch((err: Error) => logger.error({ err: err.message }, 'démarrage des rappels impossible'));

  logger.info(
    `Worker booted (NODE_ENV=${env.NODE_ENV}); listening on queues "${ACQUISITION_QUEUE}", "${REMINDERS_QUEUE}" and "${GED_AI_QUEUE}".`,
  );
}

main();
