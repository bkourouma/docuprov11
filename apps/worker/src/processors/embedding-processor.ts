// Lot 3 — consommateur de la file `ged-embedding` : indexation sémantique (segments + embeddings).
// Journalisation : compteurs et identifiants UNIQUEMENT — jamais de texte de document, de vecteur ni de clé.
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import {
  GED_AI_DISABLED_MESSAGE,
  GED_EMBEDDING_JOBS,
  GedAiMode,
  type GedEmbeddingDocumentJobData,
  type GedEmbeddingJobData,
  type GedEmbeddingResult,
} from '@archivage/types';
import type { AiEnvSource } from './ai-config';
import type { FetchLike } from './ai-providers';
import { chunkText, pagesFromFiles } from './embedding-chunker';
import { createEmbedder, type Embedder, type EmbeddingSetup } from './embedding-provider';
import {
  deleteDocumentChunks,
  listIndexableDocumentIds,
  listOrphanChunkDocumentIds,
  listStaleDocumentIds,
  replaceDocumentChunks,
} from './embedding-store';

/** Documents mis en file par passage du rattrapage. */
export const EMBEDDING_SWEEP_LIMIT = 200;
/** Taille de page de `reindex-all` (pagination par curseur). */
export const EMBEDDING_REINDEX_PAGE = 500;
/** État documentaire « épuré » (`document.document_state`). */
const STATE_PURGED = 3;

/** Résultat des jobs `reindex-all` et `sweep`. */
export type GedEmbeddingBulkResult =
  | { disabled: true; message: string }
  | { disabled: false; queued: number };

export type EmbeddingJobResult = GedEmbeddingResult | GedEmbeddingBulkResult;

/** Sous-ensemble de `Queue` BullMQ utilisé ici (injectable : testable sans Redis). */
export interface EmbeddingQueueLike {
  add(
    name: string,
    data: GedEmbeddingDocumentJobData,
    opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean },
  ): Promise<unknown>;
}

export interface EmbeddingLog {
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface EmbeddingProcessorDeps {
  queue?: EmbeddingQueueLike;
  embedder?: Embedder;
  env?: AiEnvSource;
  fetchImpl?: FetchLike;
  log?: EmbeddingLog;
  sweepLimit?: number;
}

type EmbeddingPrisma = Pick<
  PrismaClient,
  | 'gedAiSetting'
  | 'gedAiMaskingRule'
  | 'document'
  | '$queryRaw'
  | '$executeRaw'
  | '$transaction'
>;

/** Identifiant de job stable (SANS deux-points : interdit par BullMQ) ; sert de déduplication. */
export const reindexJobId = (documentId: number): string => `reindex-document-${documentId}`;

const isOff = (setup: EmbeddingSetup): boolean =>
  setup.config.mode !== GedAiMode.Locale && setup.config.mode !== GedAiMode.Cloud;

function defaultLog(): EmbeddingLog {
  return {
    info(obj, msg) {
      // Import paresseux : le logger pino n'est chargé qu'en production, jamais dans les tests.
      void import('../logger').then(({ logger }) => logger.info(obj, msg));
    },
  };
}

function parseDocumentId(data: GedEmbeddingJobData | undefined): number {
  const id = (data as GedEmbeddingDocumentJobData | undefined)?.documentId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) {
    throw new Error('Job reindex-document : documentId invalide.');
  }
  return id;
}

/** Fabrique du handler BullMQ de la file `ged-embedding`. */
export function createEmbeddingProcessor(
  prisma: EmbeddingPrisma,
  deps: EmbeddingProcessorDeps = {},
): (job: Job<GedEmbeddingJobData>) => Promise<EmbeddingJobResult> {
  const embedder = deps.embedder ?? createEmbedder(prisma, deps.env ?? process.env, deps.fetchImpl);
  const log = deps.log ?? defaultLog();
  const sweepLimit = deps.sweepLimit ?? EMBEDDING_SWEEP_LIMIT;
  const disabled = { disabled: true as const, message: GED_AI_DISABLED_MESSAGE };

  const requireQueue = (): EmbeddingQueueLike => {
    if (!deps.queue) throw new Error('File ged-embedding non fournie au processeur.');
    return deps.queue;
  };

  const enqueue = (queue: EmbeddingQueueLike, documentId: number, requestedBy?: number | null) =>
    queue.add(
      GED_EMBEDDING_JOBS.reindexDocument,
      { documentId, ...(requestedBy != null ? { requestedBy } : {}) },
      // Les jobs terminés/échoués sont retirés : sinon le jobId stable bloquerait toute ré-indexation.
      { jobId: reindexJobId(documentId), removeOnComplete: true, removeOnFail: true },
    );

  async function reindexDocument(documentId: number): Promise<GedEmbeddingResult> {
    const setup = await embedder.loadSetup();
    if (isOff(setup)) return disabled;

    const doc = await prisma.document.findUnique({
      where: { documentId },
      select: {
        isArchived: true,
        isFrozen: true,
        documentState: true,
        versions: {
          where: { isCurrent: true },
          take: 1,
          select: {
            documentVersionId: true,
            versionNumber: true,
            files: { orderBy: { sortOrder: 'asc' }, select: { ocrText: true, pageCount: true } },
          },
        },
      },
    });
    if (!doc) return { disabled: false, documentId, skipped: 'document_not_found', chunks: 0 };

    if (!doc.isArchived || doc.isFrozen || doc.documentState === STATE_PURGED) {
      // Un document devenu épuré/gelé ne doit plus être interrogeable.
      const removed = await deleteDocumentChunks(prisma, documentId);
      log.info({ documentId, removed }, 'ged-embedding : document non indexable, segments supprimés');
      return { disabled: false, documentId, skipped: 'not_indexable', chunks: 0 };
    }

    const version = doc.versions[0];
    const chunks = version ? chunkText(pagesFromFiles(version.files)) : [];
    if (!version || chunks.length === 0) {
      const removed = await deleteDocumentChunks(prisma, documentId);
      log.info({ documentId, removed }, 'ged-embedding : aucun texte, segments supprimés');
      return { disabled: false, documentId, skipped: 'no_text', chunks: 0 };
    }

    // Tous les vecteurs d'abord : un échec ici laisse les anciens segments intacts.
    const res = await embedder.embed(
      setup,
      chunks.map((c) => c.content),
    );
    if (res.disabled) return disabled;

    await replaceDocumentChunks(prisma, {
      documentId,
      versionId: version.documentVersionId,
      model: res.model,
      chunks,
      vectors: res.vectors,
    });
    log.info(
      { documentId, versionNumber: version.versionNumber, chunks: chunks.length },
      'ged-embedding : document indexé',
    );
    return { disabled: false, documentId, chunks: chunks.length };
  }

  async function reindexAll(requestedBy?: number | null): Promise<GedEmbeddingBulkResult> {
    const setup = await embedder.loadSetup();
    if (isOff(setup)) return disabled;
    const queue = requireQueue();
    let afterId = 0;
    let queued = 0;
    for (;;) {
      const ids = await listIndexableDocumentIds(prisma, {
        afterId,
        limit: EMBEDDING_REINDEX_PAGE,
      });
      for (const id of ids) {
        await enqueue(queue, id, requestedBy);
        queued++;
      }
      if (ids.length < EMBEDDING_REINDEX_PAGE) break;
      afterId = ids[ids.length - 1]!;
    }
    log.info({ queued }, 'ged-embedding : réindexation complète planifiée');
    return { disabled: false, queued };
  }

  async function sweep(): Promise<GedEmbeddingBulkResult> {
    const setup = await embedder.loadSetup();
    if (isOff(setup)) return disabled;
    const queue = requireQueue();
    const stale = await listStaleDocumentIds(prisma, { model: setup.model, limit: sweepLimit });
    // Documents devenus non indexables mais encore interrogeables : leur réindexation supprime les segments.
    const orphans =
      stale.length < sweepLimit
        ? await listOrphanChunkDocumentIds(prisma, { limit: sweepLimit - stale.length })
        : [];
    const ids = [...new Set([...stale, ...orphans])];
    for (const id of ids) await enqueue(queue, id);
    if (ids.length > 0) {
      log.info(
        { queued: ids.length, stale: stale.length, orphans: orphans.length },
        'ged-embedding : rattrapage',
      );
    }
    return { disabled: false, queued: ids.length };
  }

  return async (job) => {
    switch (job.name) {
      case GED_EMBEDDING_JOBS.reindexDocument:
        return reindexDocument(parseDocumentId(job.data));
      case GED_EMBEDDING_JOBS.reindexAll:
        return reindexAll((job.data as { requestedBy?: number | null } | undefined)?.requestedBy);
      case GED_EMBEDDING_JOBS.sweep:
        return sweep();
      default:
        throw new Error(`Job ged-embedding inconnu : ${job.name}`);
    }
  };
}
