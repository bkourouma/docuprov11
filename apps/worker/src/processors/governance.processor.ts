// Lot 5 — consommateur de la file `ged-governance` : analyse de gouvernance (doublons, données
// personnelles, sensibilité). Le worker PROPOSE seulement (statut « Proposée ») : il n'applique rien.
// Journalisation : compteurs et identifiants UNIQUEMENT — jamais de contenu de document.
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import {
  GED_GOVERNANCE_BATCH_SIZE,
  GED_GOVERNANCE_JOBS,
  type GedGovernanceAnalysisResult,
  type GedGovernanceBatchJobData,
  type GedGovernanceDocumentJobData,
  type GedGovernanceJobData,
} from '@archivage/types';
import { type AiEnvSource, loadAiConfig } from './ai-config';
import { writeAiDecision } from './ai-decision-log';
import { loadMaskingRules } from './ai-masking';
import { createAiProvider } from './ai-providers';
import {
  analyzeDocument,
  safeGovernanceError,
  type GovernanceEngineDeps,
} from './governance-engine';
import {
  findEmbeddingNeighbours,
  findExactDuplicates,
  findTitleCandidates,
  listActiveConfidentialiteLevels,
  listAnalyzableDocumentIds,
  listExistingProposals,
  loadGovernanceDocument,
} from './governance-store';

/** Résultat d'un job `analyze-batch` (une page, ou la liste fournie). */
export interface GovernanceBatchResult {
  batch: true;
  scope: 'documents' | 'all';
  processed: number;
  skipped: number;
  errors: number;
  created: number;
  /** `all` : curseur du job suivant ré-enfilé, `null` si le parcours est terminé. */
  nextAfterDocumentId: number | null;
}

export type GovernanceJobResult = GedGovernanceAnalysisResult | GovernanceBatchResult;

/** Sous-ensemble de `Queue` BullMQ utilisé ici (injectable : testable sans Redis). */
export interface GovernanceQueueLike {
  add(
    name: string,
    data: GedGovernanceBatchJobData,
    opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean },
  ): Promise<unknown>;
}

export interface GovernanceLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GovernanceProcessorDeps {
  analyze(documentId: number, requestedBy: number | null): Promise<GedGovernanceAnalysisResult>;
  listAnalyzableDocumentIds(opts: { afterId: number; limit: number }): Promise<number[]>;
  queue?: GovernanceQueueLike;
  log?: GovernanceLog;
  batchSize?: number;
}

/** Identifiant de job stable (SANS deux-points : interdit par BullMQ) ; sert de déduplication. */
export const governanceAllJobId = (afterDocumentId: number): string =>
  `governance-all-${afterDocumentId}`;

function defaultLog(): GovernanceLog {
  return {
    info(obj, msg) {
      // Import paresseux : le logger pino n'est chargé qu'en production, jamais dans les tests.
      void import('../logger').then(({ logger }) => logger.info(obj, msg));
    },
    warn(obj, msg) {
      void import('../logger').then(({ logger }) => logger.warn(obj, msg));
    },
  };
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function createGovernanceProcessor(
  deps: GovernanceProcessorDeps,
): (job: Pick<Job<GedGovernanceJobData>, 'name' | 'data'>) => Promise<GovernanceJobResult> {
  const log = deps.log ?? defaultLog();
  const batchSize = deps.batchSize ?? GED_GOVERNANCE_BATCH_SIZE;

  /** Analyse séquentielle ; une erreur sur un document est consignée et n'arrête pas le lot. */
  async function runList(
    ids: readonly number[],
    requestedBy: number | null,
    scope: 'documents' | 'all',
  ): Promise<Omit<GovernanceBatchResult, 'nextAfterDocumentId'>> {
    let skipped = 0;
    let errors = 0;
    let created = 0;
    for (const id of ids) {
      try {
        const res = await deps.analyze(id, requestedBy);
        if (res.skipped) skipped += 1;
        created += res.created.length;
      } catch (err) {
        errors += 1;
        log.warn({ documentId: id, error: safeGovernanceError(err) }, 'ged-governance : analyse en échec');
      }
    }
    return { batch: true, scope, processed: ids.length, skipped, errors, created };
  }

  return async (job) => {
    if (job.name === GED_GOVERNANCE_JOBS.analyzeDocument) {
      const data = job.data as GedGovernanceDocumentJobData;
      if (!isId(data?.documentId)) {
        throw new Error('Job analyze-document : documentId invalide.');
      }
      return deps.analyze(data.documentId, data.requestedBy ?? null);
    }

    if (job.name === GED_GOVERNANCE_JOBS.analyzeBatch) {
      const data = job.data as GedGovernanceBatchJobData;
      const requestedBy = data.requestedBy ?? null;

      if (data.scope === 'documents') {
        if (!Array.isArray(data.documentIds) || !data.documentIds.every(isId)) {
          throw new Error('Job analyze-batch : documentIds invalide.');
        }
        const ids = [...new Set(data.documentIds)];
        const res = await runList(ids, requestedBy, 'documents');
        log.info({ scope: 'documents', ...stats(res) }, 'ged-governance : lot terminé');
        return { ...res, nextAfterDocumentId: null };
      }

      if (data.scope === 'all') {
        const after = data.afterDocumentId ?? 0;
        if (!Number.isInteger(after) || after < 0) {
          throw new Error('Job analyze-batch : afterDocumentId invalide.');
        }
        // On lit une ligne de plus pour savoir s'il reste des documents sans job « vide » inutile.
        const page = await deps.listAnalyzableDocumentIds({ afterId: after, limit: batchSize + 1 });
        const ids = page.slice(0, batchSize);
        const hasMore = page.length > batchSize;
        const res = await runList(ids, requestedBy, 'all');
        let next: number | null = null;
        if (hasMore && ids.length > 0 && deps.queue) {
          next = ids[ids.length - 1]!;
          await deps.queue.add(
            GED_GOVERNANCE_JOBS.analyzeBatch,
            { scope: 'all', afterDocumentId: next, requestedBy },
            { jobId: governanceAllJobId(next), removeOnComplete: true, removeOnFail: true },
          );
        }
        log.info(
          { scope: 'all', afterDocumentId: after, nextAfterDocumentId: next, ...stats(res) },
          'ged-governance : page terminée',
        );
        return { ...res, nextAfterDocumentId: next };
      }

      throw new Error('Job analyze-batch : portée inconnue.');
    }

    throw new Error(`Job de gouvernance inconnu : ${String(job.name)}`);
  };
}

function stats(r: Omit<GovernanceBatchResult, 'nextAfterDocumentId'>) {
  return { processed: r.processed, skipped: r.skipped, errors: r.errors, created: r.created };
}

type GovernancePrisma = Pick<
  PrismaClient,
  | 'gedAiSetting'
  | 'gedAiMaskingRule'
  | 'gedAiDecision'
  | 'document'
  | 'confidentialite'
  | '$queryRaw'
  | '$transaction'
>;

/** Dépendances réelles du moteur (Prisma/SQL, fetch natif, environnement du processus). */
export function createGovernanceEngineDeps(
  prisma: GovernancePrisma,
  env: AiEnvSource = process.env,
): GovernanceEngineDeps {
  return {
    loadConfig: () => loadAiConfig(prisma, env),
    loadDocument: (id) => loadGovernanceDocument(prisma, id),
    loadMaskingRules: () => loadMaskingRules(prisma),
    createProvider: (config) => createAiProvider(config),
    listConfidentialiteLevels: () => listActiveConfidentialiteLevels(prisma),
    findExactDuplicates: (id) => findExactDuplicates(prisma, id),
    findEmbeddingNeighbours: (id) => findEmbeddingNeighbours(prisma, id),
    findTitleCandidates: (id, criteria) => findTitleCandidates(prisma, id, criteria),
    listExistingProposals: (ids) => listExistingProposals(prisma, ids),
    writeDecision: (entry) => writeAiDecision(prisma, entry),
  };
}

/** Processeur BullMQ de la file `ged-governance` câblé sur Prisma. */
export function createGovernanceProcessorFromPrisma(
  prisma: GovernancePrisma,
  opts: { queue?: GovernanceQueueLike; env?: AiEnvSource; log?: GovernanceLog } = {},
): ReturnType<typeof createGovernanceProcessor> {
  const engineDeps = createGovernanceEngineDeps(prisma, opts.env ?? process.env);
  return createGovernanceProcessor({
    analyze: (documentId, requestedBy) => analyzeDocument(documentId, engineDeps, { requestedBy }),
    listAnalyzableDocumentIds: (o) => listAnalyzableDocumentIds(prisma, o),
    queue: opts.queue,
    log: opts.log,
  });
}
