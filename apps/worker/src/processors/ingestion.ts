import { PDFDocument } from 'pdf-lib';
import { buildDocumentPdf } from '@archivage/pdf';
import type { DiskFileStore } from '@archivage/storage';
import { prisma } from '../db';
import type { DocumentPlan } from './segment';
import { pageKey } from './page-source';
import { grantConsultation } from './grant-permission';

async function resolveFileType(extension: string): Promise<{ fileTypeId: number }> {
  return prisma.fileType.upsert({
    where: { extension },
    update: {},
    create: { extension, friendlyName: extension.replace('.', '').toUpperCase() || 'FILE' },
    select: { fileTypeId: true },
  });
}

// ---------------------------------------------------------------------------
// Mode « avec intercalaires » (QR + OCR) — découpe le lot en PLUSIEURS documents
// ---------------------------------------------------------------------------

/** `untyped` porte sur le type RÉSOLU (intercalaire, puis repli du lot) — pas sur le seul QR. */
function buildLabel(seq: number, batchId: number, untyped: boolean): string {
  return untyped
    ? `Lot ${batchId} – document ${seq} (sans type)`
    : `Lot ${batchId} – document ${seq}`;
}

export interface PersistOptions {
  plan: DocumentPlan;
  seq: number;
  batchId: number;
  createdBy: number | null;
  sources: PDFDocument[];
  pageText: Map<string, string>;
  fileStore: DiskFileStore;
  /**
   * Classement résolu par l'appelant : type du lot en repli du type lu sur l'intercalaire, et plan
   * du paramétrage de ce type. Passé cuit plutôt que recalculé ici pour n'interroger la base
   * qu'une fois par lot, et non une fois par document.
   */
  documentTypeId: number | null;
  planId: number | null;
  /** Confidentialité par défaut du type retenu (`document_type_setting.confidentialite_id`). */
  confidentialiteId: number | null;
}

/**
 * Crée le document + sa version courante (+ fichier sur disque s'il a des pages de contenu),
 * puis accorde la Consultation au groupe créateur (FR-017, FR-018, FR-029).
 */
export async function persistDocument(opts: PersistOptions): Promise<void> {
  const { plan, seq, batchId, createdBy, sources, pageText, fileStore } = opts;

  const document = await prisma.document.create({
    data: {
      label: buildLabel(seq, batchId, opts.documentTypeId == null),
      documentTypeId: opts.documentTypeId,
      planId: opts.planId,
      confidentialiteId: opts.confidentialiteId,
      locationId: plan.locationId,
      dossierId: plan.dossierId,
      batchId,
      isArchived: false,
      createdBy,
      versions: { create: { versionNumber: 1, isCurrent: true, createdBy } },
    },
    include: { versions: true },
  });

  if (plan.pages.length > 0) {
    const versionId = document.versions[0]!.documentVersionId;
    const bytes = await buildDocumentPdf(sources, plan.pages);
    const fileType = await resolveFileType('.pdf');
    const ocrText = plan.pages
      .map((p) => pageText.get(pageKey(p.fileIndex, p.pageIndex)) ?? '')
      .join('\n')
      .trim();

    const file = await prisma.documentFile.create({
      data: {
        documentVersionId: versionId,
        fileTypeId: fileType.fileTypeId,
        originalName: `${buildLabel(seq, batchId, opts.documentTypeId == null)}.pdf`,
        fileExtension: '.pdf',
        byteLength: BigInt(bytes.length),
        pageCount: plan.pages.length,
        ocrText: ocrText.length > 0 ? ocrText : null,
        sortOrder: 0,
      },
    });
    await fileStore.write(file.fileId, '.pdf', Buffer.from(bytes));
  }

  if (createdBy != null) {
    await grantConsultation(document.documentId, createdBy);
  }
}

// ---------------------------------------------------------------------------
// Mode « sans intercalaire » (normal) — TOUS les fichiers fusionnés en UN document
// ---------------------------------------------------------------------------

/** Fusionne plusieurs PDF en un seul (toutes les pages, dans l'ordre des fichiers). */
async function mergePdfBytes(
  files: { bytes: Uint8Array }[],
  onMerged?: (filesDone: number) => void | Promise<void>,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const merged = await PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    try {
      const src = await PDFDocument.load(files[i]!.bytes);
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach((p) => merged.addPage(p));
    } catch {
      /* fichier illisible : ignoré (best-effort) */
    }
    if (onMerged) await onMerged(i + 1);
  }
  const out = await merged.save();
  return { bytes: out, pageCount: merged.getPageCount() };
}

export interface PersistMergedOptions {
  files: { bytes: Uint8Array; originalName: string }[];
  batchId: number;
  createdBy: number | null;
  dossierId: number | null;
  /** Classement du lot, résolu par l'appelant depuis le type choisi à l'ouverture. */
  documentTypeId: number | null;
  planId: number | null;
  /** Confidentialité par défaut du type retenu (`document_type_setting.confidentialite_id`). */
  confidentialiteId: number | null;
  fileStore: DiskFileStore;
  onFileMerged?: (filesDone: number) => void | Promise<void>;
}

/**
 * Crée UN SEUL document à partir de TOUS les PDF du lot (fusionnés), sans OCR. Le classement du
 * lot (dossier, type, plan) est repris tel quel : depuis que le type se choisit AVANT le
 * téléversement, seules les métadonnées restent à saisir à l'indexation. La Consultation est
 * accordée au groupe créateur (FR-029).
 */
export async function persistMergedDocument(opts: PersistMergedOptions): Promise<void> {
  const {
    files,
    batchId,
    createdBy,
    dossierId,
    documentTypeId,
    planId,
    confidentialiteId,
    fileStore,
    onFileMerged,
  } = opts;
  const { bytes, pageCount } = await mergePdfBytes(files, onFileMerged);

  const firstBase = files[0]?.originalName.replace(/\.pdf$/i, '').trim();
  const label = firstBase && firstBase.length > 0 ? firstBase : `Lot ${batchId} – document`;

  const document = await prisma.document.create({
    data: {
      label,
      dossierId,
      documentTypeId,
      planId,
      confidentialiteId,
      batchId,
      isArchived: false,
      createdBy,
      versions: { create: { versionNumber: 1, isCurrent: true, createdBy } },
    },
    include: { versions: true },
  });

  const versionId = document.versions[0]!.documentVersionId;
  const fileType = await resolveFileType('.pdf');
  const file = await prisma.documentFile.create({
    data: {
      documentVersionId: versionId,
      fileTypeId: fileType.fileTypeId,
      originalName:
        files.length === 1
          ? files[0]!.originalName
          : `Lot ${batchId} (${files.length} fichiers).pdf`,
      fileExtension: '.pdf',
      byteLength: BigInt(bytes.length),
      pageCount,
      ocrText: null,
      sortOrder: 0,
    },
  });
  await fileStore.write(file.fileId, '.pdf', Buffer.from(bytes));

  if (createdBy != null) {
    await grantConsultation(document.documentId, createdBy);
  }
}
