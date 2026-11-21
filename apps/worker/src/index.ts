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
// --- Lot 2a : connecteurs ---
import { DiskFileStore } from '@archivage/storage';
import { GED_CONNECTOR_JOB, type GedConnectorSyncJobData } from '@archivage/types';
import { GED_CONNECTOR_SYNC_QUEUE } from './queue';
import { createConnectorSyncProcessor } from './processors/connectors/sync.processor';
// --- fin Lot 2a ---
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
// --- Lot 5 : nettoyage et gouvernance ---
import { GED_GOVERNANCE_QUEUE } from './queue';
import type { GedGovernanceJobData } from '@archivage/types';
import {
  createGovernanceProcessorFromPrisma,
  type GovernanceJobResult,
} from './processors/governance.processor';
// --- fin Lot 5 ---
// --- Lot 2c : WhatsApp ---
import { GED_WHATSAPP_QUEUE } from './queue';
import type { GedWhatsappInboundJobData, GedWhatsappRefuseJobData } from '@archivage/types';
import { createWhatsappProcessor } from './processors/connectors/whatsapp.processor';
import {
  createMemoryRateLimiter,
  createRedisRateLimiter,
  type RedisCounterClient,
} from './processors/connectors/whatsapp-rate-limit';
// --- fin Lot 2c ---

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
// --- Lot 5 : nettoyage et gouvernance ---
/**
 * Gouvernance : analyse de doublons, de données personnelles et de sensibilité. Concurrence 1 ; le
 * worker PROPOSE seulement (aucune application automatique). Journaux : compteurs et identifiants.
 */
function startGovernance(connection: ConnectionOptions): void {
  const queue = new Queue(GED_GOVERNANCE_QUEUE, { connection });
  const worker = new Worker<GedGovernanceJobData, GovernanceJobResult>(
    GED_GOVERNANCE_QUEUE,
    createGovernanceProcessorFromPrisma(prisma, { queue }),
    { connection, concurrency: 1 },
  );
  worker.on('ready', () => logger.info('ged-governance worker ready'));
  worker.on('completed', (job, result) =>
    logger.info(
      {
        jobId: job.id,
        job: job.name,
        ...('batch' in result
          ? {
              scope: result.scope,
              processed: result.processed,
              skipped: result.skipped,
              errors: result.errors,
              created: result.created,
            }
          : {
              documentId: result.documentId,
              skipped: result.skipped,
              aiDisabled: result.aiDisabled,
              created: result.created.length,
            }),
      },
      'ged-governance job completed',
    ),
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, job: job?.name, err: err.message }, 'ged-governance job failed'),
  );
}
// --- fin Lot 5 ---

// --- Lot 2a : connecteurs ---
/**
 * Synchronisation des sources GED : Worker de la file (concurrence 2) + planificateur répétable
 * `tick` chaque minute (idempotent, comme `startReminders`). La file IA sert à enfiler le pipeline
 * après chaque ingestion ; elle n'a pas de consommateur ici (c'est `aiWorker`).
 */
function startConnectorSync(connection: ConnectionOptions, archivesPath: string): void {
  const syncQueue = new Queue(GED_CONNECTOR_SYNC_QUEUE, { connection });
  const aiQueue = new Queue(GED_AI_QUEUE, { connection });
  const processor = createConnectorSyncProcessor({
    prisma,
    fileStore: new DiskFileStore(archivesPath),
    archivesPath,
    aiQueue,
    syncQueue,
    env: process.env,
  });

  void syncQueue
    .upsertJobScheduler(
      'ged-connector-tick',
      { pattern: '* * * * *' },
      { name: GED_CONNECTOR_JOB.tick },
    )
    .catch((err: Error) =>
      logger.error({ err: err.message }, 'planificateur des connecteurs impossible'),
    );

  const syncWorker = new Worker<GedConnectorSyncJobData>(GED_CONNECTOR_SYNC_QUEUE, processor, {
    connection,
    concurrency: 2,
  });
  syncWorker.on('ready', () => logger.info('ged-connector-sync worker ready'));
  syncWorker.on('completed', (job, result) => {
    // Le `tick` sans connecteur échu est le cas nominal : débogage seulement.
    if (job.name === GED_CONNECTOR_JOB.tick) logger.debug({ result }, 'tick connecteurs');
    else
      logger.info(
        { jobId: job.id, connectorId: job.data.connectorId },
        'ged-connector-sync job completed',
      );
  });
  syncWorker.on('failed', (job, err) =>
    logger.error(
      { jobId: job?.id, job: job?.name, err: err.message },
      'ged-connector-sync job failed',
    ),
  );
}
// --- fin Lot 2a ---

// --- Lot 2c : WhatsApp ---
/**
 * Consommateur de la file `ged-whatsapp-inbound` (jobs `inbound` et `refuse`). La limitation de
 * débit des messages sortants passe par Redis (partagée entre processus) quand la connexion le
 * permet, sinon par un limiteur en mémoire.
 */
function startWhatsappInbound(connection: ConnectionOptions, archivesPath: string): void {
  const aiQueue = new Queue(GED_AI_QUEUE, { connection });
  const redis = connection as unknown as Partial<RedisCounterClient>;
  const rateLimiter =
    typeof redis.set === 'function' && typeof redis.incr === 'function'
      ? createRedisRateLimiter(redis as RedisCounterClient)
      : createMemoryRateLimiter();
  const processor = createWhatsappProcessor({
    prisma,
    fileStore: new DiskFileStore(archivesPath),
    archivesPath,
    aiQueue,
    rateLimiter,
    env: process.env,
  });

  const whatsappWorker = new Worker<GedWhatsappInboundJobData | GedWhatsappRefuseJobData>(
    GED_WHATSAPP_QUEUE,
    processor,
    { connection, concurrency: 2 },
  );
  whatsappWorker.on('ready', () => logger.info('ged-whatsapp worker ready'));
  // Ni numéro, ni contenu : seulement l'identifiant du job, son nom et le connecteur.
  whatsappWorker.on('completed', (job) =>
    logger.info(
      { jobId: job.id, job: job.name, connectorId: job.data.connectorId },
      'ged-whatsapp job completed',
    ),
  );
  whatsappWorker.on('failed', (job, err) =>
    logger.error(
      { jobId: job?.id, job: job?.name, err: err.message },
      'ged-whatsapp job failed',
    ),
  );
}
// --- fin Lot 2c ---

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

  // --- Lot 2a : connecteurs ---
  startConnectorSync(connection as unknown as ConnectionOptions, env.ARCHIVES_PATH);
  // --- fin Lot 2a ---

  // --- Lot 5 : nettoyage et gouvernance ---
  startGovernance(connection as unknown as ConnectionOptions);
  // --- fin Lot 5 ---
  // --- Lot 2c : WhatsApp ---
  startWhatsappInbound(connection as unknown as ConnectionOptions, env.ARCHIVES_PATH);
  // --- fin Lot 2c ---

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
    `Worker booted (NODE_ENV=${env.NODE_ENV}); listening on queues "${ACQUISITION_QUEUE}", "${REMINDERS_QUEUE}", "${GED_AI_QUEUE}", "${GED_EMBEDDING_QUEUE}", "${GED_CONNECTOR_SYNC_QUEUE}", "${GED_GOVERNANCE_QUEUE}" and "${GED_WHATSAPP_QUEUE}".`,
  );
}

main();
