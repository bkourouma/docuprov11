import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { DiskFileStore } from '@archivage/storage';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/** Fichier déposé (multipart) — forme fournie par multer via @UploadedFile. */
export interface UploadedScan {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Extensions acceptées au dépôt → extension de `file_type` correspondante (§07 : le source accepte
 * pdf/jpg/jpeg/png/tiff/tif/bmp). `.jpeg`/`.tif` sont normalisées ; `.bmp` est refusée faute de
 * `file_type` seedé en V6 (l'ajouter serait une modification de référentiel, hors périmètre).
 */
const ACCEPTED_EXTENSIONS: Record<string, string> = {
  '.pdf': '.pdf',
  '.jpg': '.jpg',
  '.jpeg': '.jpg',
  '.png': '.png',
  '.tiff': '.tiff',
  '.tif': '.tiff',
};

/** Content-Type d'aperçu inline (§07 `GetContentType` du source). */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.bmp': 'image/bmp',
};

/** Sous-dossier des dépôts bruts sous ARCHIVES (miroir du `_incoming` de l'acquisition). */
const SCANS_DIR = '_courriers-scans';

export interface ScannedDocumentRow {
  mailScannedDocumentId: number;
  fileName: string | null;
  filePath: string | null;
  dateScanned: Date;
  machineName: string | null;
  isTraite: boolean;
  mailId: number | null;
  documentId: number | null;
}

export interface ScannedListResult {
  total: number;
  page: number;
  pageSize: number;
  rows: ScannedDocumentRow[];
}

const SELECT = {
  mailScannedDocumentId: true,
  fileName: true,
  filePath: true,
  dateScanned: true,
  machineName: true,
  isTraite: true,
  mailId: true,
  documentId: true,
};

/**
 * File des « Documents scannés » (§07) : dépôts du poste de numérisation en attente
 * d'enregistrement en courrier. `is_traite` passe à true lors de l'enregistrement (§05), qui
 * rattache le scan au Mail/Document créés (MarkAsProcessed source).
 *
 * Deux portes d'entrée : l'écran §07 (dépôt manuel) et `@archivage/scan-agent`, l'agent installé
 * sur le poste de scan qui surveille un dossier et poste ici (équivalent V6 du service Windows du
 * source, §01.5.1 — voir `docs/agent-scan-poste.md`). Le binaire brut vit sous
 * `ARCHIVES/_courriers-scans` (chemin en base, comme `DocumentScanne.FilePath` du source) et n'entre
 * dans la GED qu'à l'enregistrement, via `promoteToDocument` (le source crée aussi le `Document`
 * depuis l'écran cible, cf. §07 « les écrans cibles créent Mail et Document »).
 */
@Injectable()
export class MailScannedDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get archivesPath(): string {
    return this.config.getOrThrow<string>('ARCHIVES_PATH');
  }

  /** File d'attente : scans non encore enregistrés (les plus récents d'abord). */
  async listPending(opts?: { page?: number; pageSize?: number }): Promise<ScannedListResult> {
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 25));
    const where = { isTraite: false };
    const [total, rows] = await Promise.all([
      this.prisma.mailScannedDocument.count({ where }),
      this.prisma.mailScannedDocument.findMany({
        where,
        orderBy: { dateScanned: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: SELECT,
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  async getById(mailScannedDocumentId: number): Promise<ScannedDocumentRow> {
    const row = await this.prisma.mailScannedDocument.findUnique({
      where: { mailScannedDocumentId },
      select: SELECT,
    });
    if (!row) throw new NotFoundException('Document scanné introuvable');
    return row;
  }

  /**
   * Dépôt d'un fichier dans la file §07. Le binaire est écrit sous un nom opaque (le nom d'origine
   * est une donnée utilisateur, jamais un chemin) ; la ligne n'est créée qu'une fois l'écriture
   * réussie, et le fichier est nettoyé si l'insertion échoue — pas de ligne sans binaire.
   */
  async upload(
    file: UploadedScan | undefined,
    machineName: string | null,
    user: AuthUser,
  ): Promise<ScannedDocumentRow> {
    if (!file?.buffer?.length) throw new BadRequestException('Aucun fichier reçu');
    const ext = extname(file.originalname ?? '').toLowerCase();
    if (!ACCEPTED_EXTENSIONS[ext]) {
      throw new BadRequestException(
        `Extension non acceptée (${ext || 'inconnue'}) — attendu : ${Object.keys(ACCEPTED_EXTENSIONS).join(', ')}`,
      );
    }

    const dir = join(this.archivesPath, SCANS_DIR);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${randomUUID()}${ext}`);
    await writeFile(filePath, file.buffer);

    try {
      return await this.prisma.mailScannedDocument.create({
        data: {
          fileName: file.originalname,
          filePath,
          machineName,
          isTraite: false,
          createdBy: user.userGroupId,
        },
        select: SELECT,
      });
    } catch (e) {
      await unlink(filePath).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Aperçu inline (§07 `ViewDocument`) : renvoie le chemin disque + le Content-Type déduit de
   * l'extension. 404 si le chemin est vide ou si le binaire a disparu (règle §07).
   */
  async getContentTarget(
    mailScannedDocumentId: number,
  ): Promise<{ filePath: string; fileName: string; contentType: string }> {
    const row = await this.getById(mailScannedDocumentId);
    if (!row.filePath) throw new NotFoundException('Aucun fichier associé à ce document scanné');
    const ext = extname(row.filePath).toLowerCase();
    return {
      filePath: row.filePath,
      fileName: row.fileName ?? `scan-${mailScannedDocumentId}${ext}`,
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
    };
  }

  /**
   * Transforme un scan en document GED (Document + version 1 + fichier) et copie son binaire dans
   * le coffre. Appelé à l'enregistrement (§05) pour que le courrier porte un vrai document
   * consultable. Renvoie le `documentId` créé.
   */
  async promoteToDocument(
    mailScannedDocumentId: number,
    label: string,
    user: AuthUser,
  ): Promise<number> {
    const scan = await this.getById(mailScannedDocumentId);
    if (!scan.filePath) throw new BadRequestException('Ce document scanné n’a aucun fichier');

    const rawExt = extname(scan.filePath).toLowerCase();
    const ext = ACCEPTED_EXTENSIONS[rawExt] ?? rawExt;
    const fileType = await this.prisma.fileType.findUnique({ where: { extension: ext } });
    if (!fileType) throw new BadRequestException(`Type de fichier inconnu pour l’extension ${ext}`);

    const buffer = await readFile(scan.filePath);

    // Le fichier GED est nommé d'après son fileId : la ligne doit exister avant l'écriture disque.
    const documentId = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: { label: label.slice(0, 500), createdBy: user.userGroupId },
      });
      const version = await tx.documentVersion.create({
        data: {
          documentId: doc.documentId,
          versionNumber: 1,
          isCurrent: true,
          createdBy: user.userGroupId,
        },
      });
      await tx.documentFile.create({
        data: {
          documentVersionId: version.documentVersionId,
          fileTypeId: fileType.fileTypeId,
          originalName: scan.fileName,
          fileExtension: ext,
          byteLength: BigInt(buffer.byteLength),
        },
      });
      return doc.documentId;
    });

    const created = await this.prisma.documentFile.findFirstOrThrow({
      where: { version: { documentId } },
      select: { fileId: true },
    });
    const store = new DiskFileStore(this.archivesPath);
    await store.write(created.fileId, ext, buffer);
    return documentId;
  }
}
