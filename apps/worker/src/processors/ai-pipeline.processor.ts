// Socle IA — câblage BullMQ + Prisma réel du pipeline `ged-ai` (consommé par `index.ts`).
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import type {
  GedAiDocumentPatch,
  GedAiPipelineJobData,
  GedAiPipelineResult,
} from '@archivage/types';
import { type AiEnvSource, loadAiConfig } from './ai-config';
import { writeAiDecision } from './ai-decision-log';
import { loadMaskingRules } from './ai-masking';
import { runAiPipeline, type AiPipelineDeps } from './ai-pipeline';
import { createAiProvider } from './ai-providers';

type AiPrisma = Pick<
  PrismaClient,
  'gedAiSetting' | 'gedAiMaskingRule' | 'gedAiDecision' | 'document' | 'documentType'
>;

/**
 * Remplit les SEULS champs encore vides : un `updateMany` par champ avec `where: { <champ>: null }`,
 * atomique côté base — une saisie humaine concurrente n'est jamais écrasée.
 */
export async function applyEmptyFieldsPatch(
  prisma: Pick<PrismaClient, 'document'>,
  documentId: number,
  patch: GedAiDocumentPatch,
): Promise<void> {
  if (patch.documentTypeId !== undefined) {
    await prisma.document.updateMany({
      where: { documentId, documentTypeId: null },
      data: { documentTypeId: patch.documentTypeId },
    });
  }
  if (patch.documentDate !== undefined) {
    await prisma.document.updateMany({
      where: { documentId, documentDate: null },
      data: { documentDate: new Date(`${patch.documentDate}T00:00:00Z`) },
    });
  }
  if (patch.overview !== undefined) {
    await prisma.document.updateMany({
      where: { documentId, overview: null },
      data: { overview: patch.overview },
    });
  }
}

/** Dépendances réelles du pipeline (Prisma, fetch natif, environnement du processus). */
export function createAiPipelineDeps(
  prisma: AiPrisma,
  env: AiEnvSource = process.env,
): AiPipelineDeps {
  return {
    loadConfig: () => loadAiConfig(prisma, env),
    async loadDocument(documentId) {
      // Texte OCR : Document -> version courante (isCurrent) -> fichiers (DocumentFile.ocrText).
      const doc = await prisma.document.findUnique({
        where: { documentId },
        select: {
          versions: {
            where: { isCurrent: true },
            take: 1,
            select: {
              files: { orderBy: { sortOrder: 'asc' }, select: { ocrText: true } },
            },
          },
        },
      });
      if (!doc) return null;
      return { ocrTexts: (doc.versions[0]?.files ?? []).map((f) => f.ocrText) };
    },
    async listDocumentTypes() {
      const rows = await prisma.documentType.findMany({
        where: { isActive: true },
        orderBy: { documentTypeId: 'asc' },
        select: { documentTypeId: true, label: true },
      });
      return rows.map((r) => ({ id: r.documentTypeId, label: r.label }));
    },
    loadMaskingRules: () => loadMaskingRules(prisma),
    createProvider: (config) => createAiProvider(config),
    writeDecision: (entry) => writeAiDecision(prisma, entry),
    applyDocumentPatch: (documentId, patch) => applyEmptyFieldsPatch(prisma, documentId, patch),
  };
}

/** Processeur BullMQ de la file `ged-ai`. */
export function createAiPipelineProcessor(
  prisma: AiPrisma,
  env: AiEnvSource = process.env,
): (job: Job<GedAiPipelineJobData>) => Promise<GedAiPipelineResult> {
  const deps = createAiPipelineDeps(prisma, env);
  return (job) => runAiPipeline(job.data, deps);
}
