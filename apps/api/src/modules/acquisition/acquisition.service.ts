import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { HierarchyService } from '../../common/hierarchy.service';
import { AuditService } from '../audit/audit.service';
import { ACQUISITION_QUEUE_TOKEN } from '../queue/queue.constants';
import type { CreateBatchDto, NewDossierDto } from './acquisition.dto';

export interface UploadedPdf {
  originalname: string;
  buffer: Buffer;
}

@Injectable()
export class AcquisitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(ACQUISITION_QUEUE_TOKEN) private readonly queue: Queue,
  ) {}

  private get archivesPath(): string {
    return this.config.getOrThrow<string>('ARCHIVES_PATH');
  }

  /** Open a batch: resolve/create the target dossier, persist acquisition_batch (status=0). */
  async createBatch(input: CreateBatchDto, userGroupId: number | null) {
    let dossierId = input.dossierId ?? null;
    if (input.newDossier) {
      dossierId = await this.createDossier(input.newDossier);
    } else if (dossierId != null) {
      const exists = await this.prisma.dossier.findUnique({ where: { dossierId } });
      if (!exists) throw new BadRequestException('Dossier cible introuvable');
    }

    if (input.documentTypeId != null) {
      const type = await this.prisma.documentType.findUnique({
        where: { documentTypeId: input.documentTypeId },
      });
      if (!type) throw new BadRequestException('Type de document introuvable');
    }

    if (input.planId != null) {
      const plan = await this.prisma.classificationPlan.findUnique({ where: { planId: input.planId } });
      if (!plan) throw new BadRequestException('Plan de classement introuvable');
    }

    if (input.confidentialiteId != null) {
      const conf = await this.prisma.confidentialite.findUnique({
        where: { confidentialiteId: input.confidentialiteId },
      });
      if (!conf) throw new BadRequestException('Confidentialité introuvable');
    }

    const batch = await this.prisma.acquisitionBatch.create({
      data: {
        dossierId,
        documentTypeId: input.documentTypeId ?? null,
        planId: input.planId ?? null,
        confidentialiteId: input.confidentialiteId ?? null,
        scannedBy: userGroupId,
        sourceLabel: input.sourceLabel ?? null,
        useIntercalaires: input.useIntercalaires ?? false,
        status: 0,
      },
    });

    await this.audit.dataChange({
      userGroupId,
      objectRef: `acquisition_batch:${batch.batchId}`,
      newValue: 'created',
    });

    return {
      batchId: batch.batchId,
      batchGuid: batch.batchGuid,
      dossierId: batch.dossierId,
      status: batch.status,
      scanDate: batch.scanDate,
    };
  }

  /** Anti-doublon (FR-009): refuse a new dossier whose active label already exists. */
  private async createDossier(input: NewDossierDto): Promise<number> {
    const duplicate = await this.prisma.dossier.findFirst({
      where: { label: input.label, isActive: true },
      select: { dossierId: true },
    });
    if (duplicate) {
      throw new ConflictException('Un dossier actif porte déjà ce libellé');
    }

    let parentPath: string | null = null;
    let depth = 0;
    if (input.parentId != null) {
      const parent = await this.prisma.dossier.findUnique({ where: { dossierId: input.parentId } });
      if (!parent) throw new BadRequestException('Dossier parent introuvable');
      parentPath = parent.path;
      depth = parent.depth + 1;
    }

    const created = await this.prisma.dossier.create({
      data: {
        label: input.label,
        parentId: input.parentId ?? null,
        depth,
        path: '/',
      },
    });
    const path = this.hierarchy.childPath(parentPath, created.dossierId);
    await this.prisma.dossier.update({ where: { dossierId: created.dossierId }, data: { path } });
    return created.dossierId;
  }

  /**
   * Save uploaded PDFs to the batch staging dir. Uploads come in sequential chunks, so
   * file numbering continues after whatever is already staged (preserving scan order for
   * the worker), and the processing job is enqueued only when `finalize` is true.
   */
  async ingestUpload(batchId: number, files: UploadedPdf[], finalize = true) {
    const batch = await this.prisma.acquisitionBatch.findUnique({ where: { batchId } });
    if (!batch) throw new NotFoundException('Lot introuvable');
    if (files.length === 0) throw new BadRequestException('Aucun fichier reçu');

    const dir = join(this.archivesPath, '_incoming', String(batchId));
    await mkdir(dir, { recursive: true });
    // Continue numbering after files already staged by previous chunks.
    let index = (await readdir(dir)).length;
    for (const file of files) {
      const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_');
      await writeFile(join(dir, `${String(index).padStart(4, '0')}_${safe}`), file.buffer);
      index += 1;
    }

    if (finalize) await this.queue.add('process', { batchId });
    return { batchId, status: batch.status, fileCount: files.length, queued: finalize };
  }

  /** Documents produced by a batch (for the QA indexation screen + the PDF viewer). */
  async listBatchDocuments(batchId: number) {
    const batch = await this.prisma.acquisitionBatch.findUnique({ where: { batchId } });
    if (!batch) throw new NotFoundException('Lot introuvable');
    const docs = await this.prisma.document.findMany({
      where: { batchId },
      orderBy: { documentId: 'asc' },
      select: {
        documentId: true,
        label: true,
        cote: true,
        documentTypeId: true,
        planId: true,
        dossierId: true,
        confidentialiteId: true,
        documentDate: true,
        isArchived: true,
        // Valeurs déjà saisies du formulaire dynamique : sans elles, rouvrir un lot repartirait
        // de champs vides et l'enregistrement suivant les effacerait (envoi exhaustif).
        metadataValues: {
          select: { metaDataId: true, value: true, metaDataListItemId: true },
        },
        versions: {
          where: { isCurrent: true },
          select: {
            files: {
              orderBy: { sortOrder: 'asc' },
              take: 1,
              select: { fileId: true, fileExtension: true, pageCount: true },
            },
          },
        },
      },
    });
    return docs.map((d) => ({
      documentId: d.documentId,
      label: d.label,
      cote: d.cote,
      documentTypeId: d.documentTypeId,
      planId: d.planId,
      dossierId: d.dossierId,
      confidentialiteId: d.confidentialiteId,
      documentDate: d.documentDate ? d.documentDate.toISOString().slice(0, 10) : null,
      isArchived: d.isArchived,
      metadataValues: d.metadataValues,
      file: d.versions[0]?.files[0] ?? null,
    }));
  }

  async getStatus(batchId: number) {
    const batch = await this.prisma.acquisitionBatch.findUnique({ where: { batchId } });
    if (!batch) throw new NotFoundException('Lot introuvable');
    return {
      batchId: batch.batchId,
      status: batch.status,
      fileCount: batch.fileCount,
      documentCount: batch.documentCount,
      processedFiles: batch.processedFiles,
      useIntercalaires: batch.useIntercalaires,
      nextScreenUrl: null,
    };
  }

  /** Re-run a batch without duplicating (idempotent, FR-020). */
  async reprocess(batchId: number) {
    const batch = await this.prisma.acquisitionBatch.findUnique({ where: { batchId } });
    if (!batch) throw new NotFoundException('Lot introuvable');
    await this.queue.add('process', { batchId, reprocess: true });
    return { batchId, requeued: true };
  }
}
