// Lot 2a — déclenchement du pipeline IA après l'ingestion d'un document de source.
import type { PrismaClient } from '@prisma/client';
import { GedAiMode, type GedAiPipelineJobData } from '@archivage/types';
import { loadAiConfig, type AiEnvSource } from '../ai-config';

/** Le strict nécessaire d'une `Queue` BullMQ (simulable en test). */
export interface AiQueueLike {
  add(
    name: string,
    data: GedAiPipelineJobData,
    opts: { removeOnComplete: number; removeOnFail: number },
  ): Promise<unknown>;
}

/**
 * Fabrique l'enfileur IA : IA désactivée (mode 0) = aucune écriture dans la file. Mêmes options que
 * l'API (`removeOnComplete`/`removeOnFail` à 1000) ; `requestedBy: null` = déclenchement système.
 * Peut lever (configuration IA invalide, Redis) : l'appelant le tolère, l'ingestion est déjà faite.
 */
export function createAiEnqueuer(opts: {
  prisma: Pick<PrismaClient, 'gedAiSetting'>;
  queue: AiQueueLike;
  env: AiEnvSource;
}): (documentId: number, sourceItemId: number) => Promise<void> {
  return async (documentId, sourceItemId) => {
    const config = await loadAiConfig(opts.prisma, opts.env);
    if (config.mode === GedAiMode.Desactivee) return;
    await opts.queue.add(
      'pipeline',
      { documentId, sourceItemId, requestedBy: null },
      { removeOnComplete: 1000, removeOnFail: 1000 },
    );
  };
}
