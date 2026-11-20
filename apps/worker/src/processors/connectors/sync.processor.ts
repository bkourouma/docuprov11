// Lot 2a — câblage du moteur de synchronisation : processeur BullMQ de la file `ged-connector-sync`.
//   job `sync` : une passe pour un connecteur ;
//   job `tick` : planificateur (chaque minute) qui enfile les `sync` échus.
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import {
  buildConnector,
  createDefaultRegistry,
  decryptCredentials,
  loadKeyRing,
  redactSecrets,
  resolveCredentialsRef,
  type ConnectorCredentials,
  type ConnectorRegistry,
} from '@archivage/connectors';
import type { DiskFileStore } from '@archivage/storage';
import {
  GED_CONNECTOR_JOB,
  GedSourceConnectorStatus,
  type GedConnectorSyncJobData,
} from '@archivage/types';
import { logger } from '../../logger';
import {
  addVersionFromSource,
  extractTextFromBytes,
  ingestExternalFile,
  TEXT_EXTRACTABLE_EXTENSIONS,
} from '../ingestion';
import { createAiEnqueuer, type AiQueueLike } from './ai-trigger';
import { createPrismaSyncStore } from './prisma-store';
import {
  runConnectorSync,
  type ConnectorRow,
  type SyncDeps,
  type SyncLogger,
  type SyncOutcome,
} from './sync-engine';

type SyncPrisma = Pick<
  PrismaClient,
  | 'gedSourceConnector'
  | 'gedSourceSyncRun'
  | 'gedSourceItem'
  | 'gedAiSetting'
  | 'fileType'
  | 'document'
  | 'documentVersion'
  | '$transaction'
>;

/** Le strict nécessaire d'une `Queue` BullMQ pour enfiler des `sync`. */
export interface SyncQueueLike {
  add(
    name: string,
    data: GedConnectorSyncJobData,
    opts: { jobId: string; delay?: number; removeOnComplete: boolean; removeOnFail: boolean },
  ): Promise<unknown>;
}

export interface ConnectorSyncProcessorDeps {
  prisma: SyncPrisma;
  fileStore: Pick<DiskFileStore, 'write'>;
  archivesPath: string;
  /** File du pipeline IA ; `null` = pas de file (tests, ou IA non câblée). */
  aiQueue: AiQueueLike | null;
  syncQueue: SyncQueueLike;
  /** Défaut : `process.env`. Lu pour GED_CONNECTOR_* et les références d'identifiants. */
  env?: NodeJS.ProcessEnv;
  registry?: ConnectorRegistry;
  now?: () => Date;
  log?: SyncLogger;
}

export type SyncJobResult =
  | SyncOutcome
  | { skipped: 'inactive' | 'unknown_connector' | 'setup_error'; message?: string };

/** Variables transmises au connecteur : les trois dont il a besoin, rien d'autre (pas de JWT_SECRET…). */
function connectorEnv(env: NodeJS.ProcessEnv, archivesPath: string): NodeJS.ProcessEnv {
  return {
    GED_CONNECTOR_FS_ROOTS: env.GED_CONNECTOR_FS_ROOTS,
    GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS: env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS,
    ARCHIVES_PATH: archivesPath,
  };
}

interface ConnectorRecord {
  gedSourceConnectorId: number;
  label: string;
  connectorType: string;
  mode: number;
  status: number;
  config: unknown;
  credentialsEnc: string | null;
  credentialsKeyId: string | null;
  credentialsRef: string | null;
  changeToken: string | null;
  targetDossierId: number | null;
  isActive: boolean;
}

function resolveCredentials(record: ConnectorRecord, env: NodeJS.ProcessEnv): ConnectorCredentials {
  if (record.credentialsEnc) {
    if (env.GED_CONNECTOR_KEY == null || env.GED_CONNECTOR_KEY.trim() === '') {
      throw new Error('GED_CONNECTOR_KEY absente : identifiants chiffrés illisibles');
    }
    return decryptCredentials(record.credentialsEnc, record.credentialsKeyId, loadKeyRing(env));
  }
  if (record.credentialsRef) return resolveCredentialsRef(record.credentialsRef, env);
  return {};
}

/** Une passe pour le connecteur de `data` : charge, résout les identifiants, construit, lance le moteur. */
export async function runSyncJob(
  data: GedConnectorSyncJobData,
  deps: ConnectorSyncProcessorDeps,
): Promise<SyncJobResult> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? createDefaultRegistry();

  if (!Number.isInteger(data?.connectorId) || data.connectorId <= 0) {
    throw new Error('connectorId invalide');
  }
  const record = (await deps.prisma.gedSourceConnector.findUnique({
    where: { gedSourceConnectorId: data.connectorId },
  })) as ConnectorRecord | null;
  if (!record) throw new Error(`connecteur ${data.connectorId} introuvable`);

  const reportSetupError = async (message: string): Promise<SyncJobResult> => {
    log.error({ connectorId: record.gedSourceConnectorId, message }, 'connecteur non démarrable');
    await deps.prisma.gedSourceConnector.update({
      where: { gedSourceConnectorId: record.gedSourceConnectorId },
      data: { status: GedSourceConnectorStatus.Erreur, lastError: message, lastSyncAt: now() },
    });
    return { skipped: 'setup_error', message };
  };

  if (!record.isActive || record.status === GedSourceConnectorStatus.Inactif) {
    log.info(
      { connectorId: record.gedSourceConnectorId },
      'connecteur inactif : synchronisation refusée',
    );
    return { skipped: 'inactive' };
  }
  if (!registry.get(record.connectorType)) {
    await reportSetupError('type de connecteur absent du registre');
    return { skipped: 'unknown_connector', message: 'type de connecteur absent du registre' };
  }

  let credentials: ConnectorCredentials = {};
  let connector;
  try {
    credentials = resolveCredentials(record, env);
    connector = buildConnector(registry, record.connectorType, {
      config: record.config,
      credentials,
      deps: { env: connectorEnv(env, deps.archivesPath), now },
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return reportSetupError(redactSecrets(raw, credentials).slice(0, 2000));
  }

  const row: ConnectorRow = {
    id: record.gedSourceConnectorId,
    label: record.label,
    mode: record.mode,
    status: record.status,
    changeToken: record.changeToken,
    targetDossierId: record.targetDossierId,
    config: record.config,
  };
  const ingestDeps = {
    prisma: deps.prisma,
    fileStore: deps.fileStore,
    archivesPath: deps.archivesPath,
    now,
  };
  const enqueueAi = deps.aiQueue
    ? createAiEnqueuer({ prisma: deps.prisma, queue: deps.aiQueue, env })
    : async () => undefined;
  const engineDeps: SyncDeps = {
    store: createPrismaSyncStore(deps.prisma),
    ingest: {
      createDocument: (input, grants) => ingestExternalFile(input, grants, ingestDeps),
      addVersion: (documentId, input) => addVersionFromSource(documentId, input, ingestDeps),
    },
    extractText: (bytes, extension) => extractTextFromBytes(bytes, extension),
    extractableExtensions: TEXT_EXTRACTABLE_EXTENSIONS,
    now,
    enqueueAi,
    scheduleResume: async (connectorId, delayMs) => {
      // Identifiant propre à chaque reprise : l'id du job courant est encore pris tant qu'il est
      // actif, et BullMQ ignore un `add` dont l'id existe déjà. L'anti-concurrence du moteur évite
      // qu'une reprise et un `tick` ne synchronisent en même temps.
      await deps.syncQueue.add(
        GED_CONNECTOR_JOB.sync,
        { connectorId, trigger: 'schedule', requestedBy: null },
        {
          jobId: `ged-sync-resume-${connectorId}-${now().getTime()}`,
          delay: delayMs,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    },
    log,
  };

  try {
    return await runConnectorSync({ row, connector, credentials }, engineDeps);
  } finally {
    await connector.close().catch(() => undefined);
  }
}

/**
 * Planificateur : enfile un `sync` pour chaque connecteur actif, avec une cadence, dont la dernière
 * synchronisation + l'intervalle est dépassée (ou jamais synchronisé). `jobId` stable = pas de
 * doublon tant qu'un job du même connecteur existe encore.
 */
export async function runConnectorTick(
  deps: Pick<ConnectorSyncProcessorDeps, 'prisma' | 'syncQueue' | 'now'>,
): Promise<{ enqueued: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await deps.prisma.gedSourceConnector.findMany({
    where: {
      isActive: true,
      status: {
        notIn: [GedSourceConnectorStatus.Inactif, GedSourceConnectorStatus.AutorisationExpiree],
      },
      syncIntervalMinutes: { not: null },
    },
    select: { gedSourceConnectorId: true, lastSyncAt: true, syncIntervalMinutes: true },
  });
  let enqueued = 0;
  for (const c of candidates) {
    const interval = c.syncIntervalMinutes;
    if (interval == null || interval <= 0) continue;
    const due = c.lastSyncAt == null || c.lastSyncAt.getTime() + interval * 60_000 <= now.getTime();
    if (!due) continue;
    await deps.syncQueue.add(
      GED_CONNECTOR_JOB.sync,
      { connectorId: c.gedSourceConnectorId, trigger: 'schedule', requestedBy: null },
      {
        jobId: `ged-sync-${c.gedSourceConnectorId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    enqueued++;
  }
  return { enqueued };
}

/** Processeur BullMQ de la file `ged-connector-sync`. */
export function createConnectorSyncProcessor(
  deps: ConnectorSyncProcessorDeps,
): (job: Pick<Job<GedConnectorSyncJobData>, 'name' | 'data'>) => Promise<unknown> {
  return async (job) => {
    if (job.name === GED_CONNECTOR_JOB.tick) return runConnectorTick(deps);
    if (job.name === GED_CONNECTOR_JOB.sync) return runSyncJob(job.data, deps);
    throw new Error(`job inconnu : ${job.name}`);
  };
}
