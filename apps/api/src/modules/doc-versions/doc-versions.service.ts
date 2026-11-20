import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { DiskFileStore, type FileStore } from '@archivage/storage';
import {
  DocumentState,
  GedVersionChangeKind,
  type GedDocumentVersionFile,
  type GedDocumentVersionRow,
} from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { DocumentsService, actorName } from '../documents/documents.service';
import {
  MAX_VERSION_UPLOAD_BYTES,
  type CreateVersionDto,
  type RestoreVersionDto,
} from './doc-versions.dto';
import { computeVersionHash, sha256Hex } from './domain/version-hash';

/** Fichier déposé (multipart) — forme fournie par multer via `@UploadedFile`. */
export interface UploadedVersionFile {
  originalname: string;
  mimetype?: string;
  buffer: Buffer;
  size: number;
}

/** Niveau de permission minimal pour créer ou restaurer une version (3 = Modification). */
const MIN_WRITE_LEVEL = 3;

const ROW_INCLUDE = {
  files: {
    orderBy: [{ sortOrder: 'asc' }, { fileId: 'asc' }],
    select: {
      fileId: true,
      originalName: true,
      fileExtension: true,
      byteLength: true,
      pageCount: true,
      hash: true,
    },
  },
  gedInfo: {
    select: {
      contentHash: true,
      changeKind: true,
      changeSummary: true,
      restoredFromVersion: { select: { versionNumber: true } },
    },
  },
  createdByUser: { select: { user: { select: { fullName: true, username: true } } } },
} satisfies Prisma.DocumentVersionInclude;

type VersionWithRow = Prisma.DocumentVersionGetPayload<{ include: typeof ROW_INCLUDE }>;

/** Pièce à créer dans la nouvelle version, binaire en mémoire. */
interface NewFileSpec {
  originalName: string | null;
  fileExtension: string;
  fileTypeId: number;
  pageCount: number | null;
  sortOrder: number;
  ocrText?: string | null;
  redaction?: string | null;
  pdfOwner?: string | null;
  pdfPassword?: string | null;
  buffer: Buffer;
  hash: string;
}

interface NewVersionSpec {
  documentId: number;
  files: NewFileSpec[];
  changeKind: GedVersionChangeKind;
  changeSummary: string | null;
  comment: string | null;
  restoredFromVersionId: number | null;
  contentHash: string;
  user: AuthUser;
}

@Injectable()
export class DocVersionsService {
  private readonly logger = new Logger(DocVersionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
  ) {}

  /** Coffre disque ; point d'extension pour les tests. */
  protected getStore(): FileStore {
    return new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
  }

  // --------------------------------------------------------------------------------- lecture

  async list(documentId: number, user: AuthUser): Promise<GedDocumentVersionRow[]> {
    if (!(await this.documents.canAccess(documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    const rows = await this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
      include: ROW_INCLUDE,
    });
    return rows.map((r) => this.toRow(r));
  }

  async openFileContent(
    documentId: number,
    versionId: number,
    fileId: number,
    user: AuthUser,
  ): Promise<StreamableFile> {
    if (!(await this.documents.canAccess(documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    const file = await this.prisma.documentFile.findFirst({
      where: { fileId, documentVersionId: versionId, version: { documentId } },
      select: { fileId: true, fileExtension: true, originalName: true },
    });
    if (!file) throw new NotFoundException('Fichier introuvable');

    const store = this.getStore();
    // Même garde que `DocumentsController.content` : 404 propre avant les en-têtes 200.
    if (!(await store.exists(file.fileId, file.fileExtension))) {
      throw new NotFoundException('Fichier introuvable sur le coffre disque');
    }
    const stream = store.createReadStream(file.fileId, file.fileExtension);
    const name = file.originalName ?? `${file.fileId}${file.fileExtension}`;
    const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
  }

  // -------------------------------------------------------------------------------- création

  async create(
    documentId: number,
    file: UploadedVersionFile | undefined,
    dto: CreateVersionDto,
    user: AuthUser,
  ): Promise<GedDocumentVersionRow> {
    await this.assertCanModify(documentId, user);
    const upload = this.validateUpload(file);

    const current = await this.getCurrentVersion(documentId);
    const contentHash = sha256Hex(upload.buffer);

    const currentHash = await this.currentContentHash(current);
    if (currentHash != null && currentHash === contentHash) {
      throw new ConflictException('Contenu identique à la version courante');
    }

    const created = await this.persistNewVersion({
      documentId,
      files: [
        {
          originalName: upload.originalname.slice(0, 500) || null,
          fileExtension: '.pdf',
          fileTypeId: current.files[0].fileTypeId,
          pageCount: null,
          sortOrder: 0,
          buffer: upload.buffer,
          hash: contentHash,
        },
      ],
      changeKind: GedVersionChangeKind.Modification,
      changeSummary: dto.changeSummary ?? null,
      comment: dto.comment ?? null,
      restoredFromVersionId: null,
      contentHash,
      user,
    });

    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `document:${documentId}`,
      newValue: `version-created:v${created.versionNumber}`,
    });
    return this.loadRow(created.documentVersionId);
  }

  // ------------------------------------------------------------------------------ restauration

  async restore(
    documentId: number,
    versionId: number,
    dto: RestoreVersionDto,
    user: AuthUser,
  ): Promise<GedDocumentVersionRow> {
    await this.assertCanModify(documentId, user);

    const source = await this.prisma.documentVersion.findFirst({
      where: { documentVersionId: versionId, documentId },
      select: {
        documentVersionId: true,
        versionNumber: true,
        isCurrent: true,
        files: {
          orderBy: [{ sortOrder: 'asc' }, { fileId: 'asc' }],
          select: {
            fileId: true,
            fileTypeId: true,
            originalName: true,
            fileExtension: true,
            pageCount: true,
            sortOrder: true,
            ocrText: true,
            redaction: true,
            pdfOwner: true,
            pdfPassword: true,
          },
        },
      },
    });
    if (!source) throw new NotFoundException('Version introuvable');
    if (source.isCurrent) {
      throw new ConflictException('Cette version est déjà la version courante');
    }
    if (source.files.length === 0) {
      throw new ConflictException('La version à restaurer ne contient aucune pièce');
    }

    await this.getCurrentVersion(documentId);

    // Lecture de TOUS les binaires sources avant la moindre écriture : un binaire manquant doit
    // faire échouer proprement, sans ligne ni fichier orphelin.
    const store = this.getStore();
    const files: NewFileSpec[] = [];
    for (const f of source.files) {
      if (!(await store.exists(f.fileId, f.fileExtension))) {
        throw new ConflictException(
          `Binaire de la version v${source.versionNumber} introuvable sur le coffre disque (fichier ${f.fileId})`,
        );
      }
      const buffer = await store.read(f.fileId, f.fileExtension);
      files.push({
        originalName: f.originalName,
        fileExtension: f.fileExtension,
        fileTypeId: f.fileTypeId,
        pageCount: f.pageCount,
        sortOrder: f.sortOrder,
        ocrText: f.ocrText,
        redaction: f.redaction,
        pdfOwner: f.pdfOwner,
        pdfPassword: f.pdfPassword,
        buffer,
        hash: sha256Hex(buffer),
      });
    }

    const created = await this.persistNewVersion({
      documentId,
      files,
      changeKind: GedVersionChangeKind.Restauration,
      changeSummary: dto?.changeSummary ?? null,
      comment: null,
      restoredFromVersionId: source.documentVersionId,
      contentHash: computeVersionHash(files.map((f) => f.hash)),
      user,
    });

    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `document:${documentId}`,
      newValue: `version-restored:v${created.versionNumber}from:v${source.versionNumber}`,
    });
    return this.loadRow(created.documentVersionId);
  }

  // ------------------------------------------------------------------------------- internes

  /** Accès (404), niveau >= 3 (404/403), puis document ni gelé ni épuré (409). */
  private async assertCanModify(documentId: number, user: AuthUser): Promise<void> {
    // Accès (droits par document + confidentialité) d'abord : un document existant mais refusé
    // doit être indiscernable d'un document inconnu (404), quel que soit le niveau simulé.
    if (!(await this.documents.canAccess(documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    const level = await this.documents.getEffectivePermissionLevel(documentId, user);
    if (level == null) throw new NotFoundException('Document introuvable');
    if (level < MIN_WRITE_LEVEL) {
      throw new ForbiddenException('Modification non autorisée sur ce document');
    }
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { isFrozen: true, documentState: true },
    });
    if (!doc) throw new NotFoundException('Document introuvable');
    if (doc.isFrozen) throw new ConflictException('Document gelé : versions non modifiables');
    if (doc.documentState === DocumentState.Epure) {
      throw new ConflictException('Document épuré : versions non modifiables');
    }
  }

  private validateUpload(file: UploadedVersionFile | undefined): UploadedVersionFile {
    if (!file?.buffer?.length) throw new BadRequestException('Aucun fichier reçu (ou fichier vide)');
    if (file.buffer.length > MAX_VERSION_UPLOAD_BYTES) {
      throw new BadRequestException('Fichier trop volumineux');
    }
    // Contrôle sur le contenu (signature `%PDF`), pas seulement sur le nom ou le type MIME déclarés.
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('Seuls les fichiers PDF sont acceptés');
    }
    return file;
  }

  private async getCurrentVersion(documentId: number) {
    const current = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: {
        documentVersionId: true,
        versionNumber: true,
        files: {
          orderBy: [{ sortOrder: 'asc' }, { fileId: 'asc' }],
          select: { fileId: true, fileExtension: true, fileTypeId: true, hash: true },
        },
        gedInfo: { select: { contentHash: true } },
      },
    });
    if (!current || current.files.length === 0) {
      throw new ConflictException("Le document n'a pas de version courante exploitable");
    }
    return current;
  }

  /** Empreinte de la version courante : posée en base, sinon recalculée depuis le disque. */
  private async currentContentHash(current: {
    files: { fileId: number; fileExtension: string; hash: string | null }[];
    gedInfo: { contentHash: string | null } | null;
  }): Promise<string | null> {
    if (current.gedInfo?.contentHash) return current.gedInfo.contentHash;
    const store = this.getStore();
    const hashes: string[] = [];
    for (const f of current.files) {
      if (f.hash) {
        hashes.push(f.hash);
        continue;
      }
      if (!(await store.exists(f.fileId, f.fileExtension))) return null;
      hashes.push(sha256Hex(await store.read(f.fileId, f.fileExtension)));
    }
    return computeVersionHash(hashes);
  }

  /**
   * Crée la version, puis écrit les binaires, puis seulement la rend courante.
   *  1. transaction : lignes de la nouvelle version, NON courante (l'ancienne reste courante) ;
   *  2. écriture des binaires sur le coffre ;
   *  3. transaction courte : bascule `is_current` (ancienne -> faux, nouvelle -> vrai).
   * Pas de transaction sur disque : si l'étape 2 ou 3 échoue, TOUS les binaires de la version
   * sont retirés et ses lignes supprimées (cascade) ; l'ancienne version n'a jamais cessé d'être
   * courante. Compromis : entre 1 et 3 une version non courante existe brièvement en base.
   */
  private async persistNewVersion(spec: NewVersionSpec): Promise<{
    documentVersionId: number;
    versionNumber: number;
  }> {
    const now = new Date();
    let created: { documentVersionId: number; versionNumber: number; fileIds: number[] };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const agg = await tx.documentVersion.aggregate({
          where: { documentId: spec.documentId },
          _max: { versionNumber: true },
        });
        const versionNumber = (agg._max.versionNumber ?? 0) + 1;
        const version = await tx.documentVersion.create({
          data: {
            documentId: spec.documentId,
            versionNumber,
            isCurrent: false,
            comment: spec.comment,
            createdBy: spec.user.userGroupId,
          },
          select: { documentVersionId: true },
        });
        const fileIds: number[] = [];
        for (const f of spec.files) {
          const row = await tx.documentFile.create({
            data: {
              documentVersionId: version.documentVersionId,
              fileTypeId: f.fileTypeId,
              originalName: f.originalName,
              fileExtension: f.fileExtension,
              byteLength: BigInt(f.buffer.length),
              pageCount: f.pageCount,
              sortOrder: f.sortOrder,
              ocrText: f.ocrText ?? null,
              redaction: f.redaction ?? null,
              pdfOwner: f.pdfOwner ?? null,
              pdfPassword: f.pdfPassword ?? null,
              hash: f.hash,
              hashComputedAt: now,
            },
            select: { fileId: true },
          });
          fileIds.push(row.fileId);
        }
        await tx.gedVersionInfo.create({
          data: {
            documentVersionId: version.documentVersionId,
            contentHash: spec.contentHash,
            changeKind: spec.changeKind,
            changeSummary: spec.changeSummary,
            restoredFromVersionId: spec.restoredFromVersionId,
          },
        });
        return { documentVersionId: version.documentVersionId, versionNumber, fileIds };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException("Une autre version vient d'être créée : réessayez");
      }
      throw e;
    }

    const store = this.getStore();
    try {
      for (let i = 0; i < spec.files.length; i++) {
        await store.write(created.fileIds[i], spec.files[i].fileExtension, spec.files[i].buffer);
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.documentVersion.updateMany({
          where: { documentId: spec.documentId, isCurrent: true },
          data: { isCurrent: false },
        });
        await tx.documentVersion.update({
          where: { documentVersionId: created.documentVersionId },
          data: { isCurrent: true },
        });
      });
    } catch (e) {
      // `remove` est sans effet sur un fichier absent : on nettoie TOUS les fileIds créés.
      await Promise.all(
        spec.files.map((f, i) => store.remove(created.fileIds[i], f.fileExtension)),
      );
      await this.rollbackRows(created.documentVersionId);
      this.logger.error(`Création de version échouée : ${(e as Error).message}`);
      throw e;
    }

    await this.prisma.document.update({
      where: { documentId: spec.documentId },
      data: { modifiedBy: spec.user.userGroupId, modifiedAt: now },
    });
    return { documentVersionId: created.documentVersionId, versionNumber: created.versionNumber };
  }

  /** Supprime la version (pièces et infos en cascade) ; la version courante d'origine est intacte. */
  private async rollbackRows(newVersionId: number): Promise<void> {
    try {
      await this.prisma.documentVersion.delete({ where: { documentVersionId: newVersionId } });
    } catch (e) {
      this.logger.error(
        `Annulation de la version ${newVersionId} impossible, à nettoyer à la main : ${(e as Error).message}`,
      );
    }
  }

  private async loadRow(documentVersionId: number): Promise<GedDocumentVersionRow> {
    const row = await this.prisma.documentVersion.findUnique({
      where: { documentVersionId },
      include: ROW_INCLUDE,
    });
    if (!row) throw new NotFoundException('Version introuvable');
    return this.toRow(row);
  }

  private toRow(v: VersionWithRow): GedDocumentVersionRow {
    const files: GedDocumentVersionFile[] = v.files.map((f) => ({
      fileId: f.fileId,
      originalName: f.originalName,
      fileExtension: f.fileExtension,
      byteLength: f.byteLength == null ? null : Number(f.byteLength),
      pageCount: f.pageCount,
    }));
    // Versions antérieures à la GED (pas de `ged_version_info`) : déduites de la numérotation et,
    // pour l'empreinte, de celle du fichier quand il n'y en a qu'un.
    const legacyHash = v.files.length === 1 ? (v.files[0].hash ?? null) : null;
    return {
      documentVersionId: v.documentVersionId,
      versionNumber: v.versionNumber,
      isCurrent: v.isCurrent,
      isValidated: v.isValidated,
      comment: v.comment,
      createdAt: v.createdAt.toISOString(),
      createdByName: v.createdByUser?.user?.fullName || v.createdByUser?.user?.username || null,
      changeKind: (v.gedInfo?.changeKind ??
        (v.versionNumber === 1
          ? GedVersionChangeKind.Creation
          : GedVersionChangeKind.Modification)) as GedVersionChangeKind,
      changeSummary: v.gedInfo?.changeSummary ?? null,
      contentHash: v.gedInfo ? (v.gedInfo.contentHash ?? legacyHash) : legacyHash,
      restoredFromVersionNumber: v.gedInfo?.restoredFromVersion?.versionNumber ?? null,
      files,
    };
  }
}
