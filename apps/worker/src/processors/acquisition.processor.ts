import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiskFileStore } from '@archivage/storage';
import { prisma } from '../db';
import { logger } from '../logger';
import { buildPageStream, type IncomingFile } from './page-source';
import { segmentPages } from './segment';
import { persistDocument, persistMergedDocument } from './ingestion';

export interface AcquisitionEnv {
  archivesPath: string;
  tesseractLang: string;
  tesseractDataPath?: string;
}

export function incomingDir(archivesPath: string, batchId: number): string {
  return join(archivesPath, '_incoming', String(batchId));
}

/**
 * Résout le CLASSEMENT d'un document du lot : le type lu sur son intercalaire QR l'emporte
 * toujours, le type du lot ne servant que de repli. Pour le plan ET la confidentialité, même
 * priorité décroissante : intercalaire « Plan » du document (plan seulement — aucun intercalaire
 * de confidentialité n'existe) > choix manuel à l'ouverture du lot (`acquisition_batch.plan_id` /
 * `confidentialite_id`) > paramétrage du type retenu (`document_type_setting`).
 *
 * C'est ici, et plus dans l'écran, que la règle s'applique : depuis que l'indexation n'accepte
 * plus que les métadonnées, le classement doit être posé à la CRÉATION du document.
 */
async function classifierDuLot(
  batchTypeId: number | null,
  batchPlanId: number | null,
  batchConfidentialiteId: number | null,
) {
  // Un seul aller-retour : le paramétrage du type du lot suffit pour tous ses documents non typés.
  const settings = await prisma.documentTypeSetting.findMany({
    select: { documentTypeId: true, planId: true, confidentialiteId: true },
  });
  const planByType = new Map(settings.map((s) => [s.documentTypeId, s.planId]));
  const confByType = new Map(settings.map((s) => [s.documentTypeId, s.confidentialiteId]));

  return (qrTypeId: number | null, qrPlanId: number | null) => {
    const documentTypeId = qrTypeId ?? batchTypeId;
    const planId =
      qrPlanId ?? batchPlanId ?? (documentTypeId != null ? (planByType.get(documentTypeId) ?? null) : null);
    const confidentialiteId =
      batchConfidentialiteId ?? (documentTypeId != null ? (confByType.get(documentTypeId) ?? null) : null);
    return { documentTypeId, planId, confidentialiteId };
  };
}

/** Delete documents previously produced for this batch (cascade) + their binaries (idempotence, FR-020). */
async function clearBatchOutputs(batchId: number, fileStore: DiskFileStore): Promise<void> {
  const files = await prisma.documentFile.findMany({
    where: { version: { document: { batchId } } },
    select: { fileId: true, fileExtension: true },
  });
  await prisma.document.deleteMany({ where: { batchId } });
  for (const f of files) {
    await fileStore.remove(f.fileId, f.fileExtension);
  }
}

/**
 * Traite un lot d'acquisition selon son mode :
 *  - `useIntercalaires = false` (normal) : TOUS les PDF du lot sont fusionnés en UN SEUL
 *    document, sans OCR ni découpage. Indexation manuelle ensuite.
 *  - `useIntercalaires = true` (ancien système) : découpage par intercalaire QR + OCR en
 *    PLUSIEURS documents.
 *
 * Le compteur `processedFiles` est mis à jour au fil de l'eau pour la barre de progression.
 */
export async function processBatch(batchId: number, env: AcquisitionEnv): Promise<void> {
  const batch = await prisma.acquisitionBatch.findUnique({ where: { batchId } });
  if (!batch) throw new Error(`Acquisition batch ${batchId} not found`);

  // Les dépôts d'origine sont lus AVANT toute suppression. `clearBatchOutputs` détruit les
  // documents du lot et leurs binaires sur disque, et rien de tout cela n'est transactionnel :
  // si le dossier `_incoming` manque (lot restauré sans ses dépôts, `_incoming` purgé), l'ordre
  // inverse effaçait le lot puis échouait sur ENOENT, sans aucun moyen de revenir en arrière.
  const dir = incomingDir(env.archivesPath, batchId);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.pdf')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Acquisition batch ${batchId}: dépôt introuvable (${dir}). Aucun document supprimé.`,
      );
    }
    throw error;
  }
  // Un lot n'est mis en file qu'après le dépôt d'au moins un fichier : un dossier vide signale
  // un dépôt perdu, pas un lot légitimement vide. Retraiter détruirait tout pour ne rien produire.
  if (names.length === 0) {
    throw new Error(
      `Acquisition batch ${batchId}: aucun PDF dans ${dir}. Aucun document supprimé.`,
    );
  }

  const fileStore = new DiskFileStore(env.archivesPath);
  await clearBatchOutputs(batchId, fileStore);

  // Total connu dès le départ ; compteurs de progression remis à zéro.
  await prisma.acquisitionBatch.update({
    where: { batchId },
    data: { fileCount: names.length, documentCount: 0, processedFiles: 0, status: 0 },
  });

  const setProcessed = async (n: number): Promise<void> => {
    await prisma.acquisitionBatch.update({ where: { batchId }, data: { processedFiles: n } });
  };

  const classer = await classifierDuLot(batch.documentTypeId, batch.planId, batch.confidentialiteId);

  if (batch.useIntercalaires) {
    // --- Ancien système : QR + OCR → plusieurs documents ---
    const files: IncomingFile[] = await Promise.all(
      names.map(async (n) => ({ bytes: new Uint8Array(await readFile(join(dir, n))) })),
    );
    const { classifications, pageText, sources } = await buildPageStream(
      files,
      env.tesseractLang,
      (done) => setProcessed(done),
      env.tesseractDataPath,
    );
    const plans = segmentPages(classifications, batch.dossierId);
    let seq = 0;
    for (const plan of plans) {
      seq += 1;
      const { documentTypeId, planId, confidentialiteId } = classer(plan.documentTypeId, plan.planId);
      await persistDocument({
        plan,
        seq,
        batchId,
        createdBy: batch.scannedBy,
        sources,
        pageText,
        fileStore,
        archivesPath: env.archivesPath,
        documentTypeId,
        planId,
        confidentialiteId,
      });
      await prisma.acquisitionBatch.update({ where: { batchId }, data: { documentCount: seq } });
    }
    await prisma.acquisitionBatch.update({
      where: { batchId },
      data: { processedFiles: names.length, status: 1 },
    });
    logger.info(
      { batchId, files: files.length, documents: plans.length },
      'batch processed (QR + OCR)',
    );
  } else {
    // --- Mode normal : tous les fichiers fusionnés en UN document, sans OCR ---
    const files: { bytes: Uint8Array; originalName: string }[] = [];
    for (const n of names) {
      files.push({
        bytes: new Uint8Array(await readFile(join(dir, n))),
        originalName: n.replace(/^\d+_/, ''),
      });
    }
    // Mode normal : aucun intercalaire, le classement vient donc entièrement du type du lot.
    const { documentTypeId, planId, confidentialiteId } = classer(null, null);
    await persistMergedDocument({
      files,
      batchId,
      createdBy: batch.scannedBy,
      dossierId: batch.dossierId,
      documentTypeId,
      planId,
      confidentialiteId,
      fileStore,
      archivesPath: env.archivesPath,
      onFileMerged: (done) => setProcessed(done),
    });
    await prisma.acquisitionBatch.update({
      where: { batchId },
      data: { documentCount: 1, processedFiles: names.length, status: 1 },
    });
    logger.info(
      { batchId, files: names.length },
      'batch processed (1 document fusionné, sans OCR)',
    );
  }
}
