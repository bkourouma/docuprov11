import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { DiskFileStore, type FileStore } from '@archivage/storage';
import {
  DocumentState,
  GED_COLLAB_SNAPSHOT_EXTENSION,
  GED_COLLAB_STATE_EXTENSION,
  GedVersionChangeKind,
} from '@archivage/types';
import {
  EDITOR_LIMITS,
  decodeState,
  extractMentionIds,
  listComments,
  validateYDocStructure,
  yDocToHtml,
} from '@archivage/editor/server';
import type * as Y from 'yjs';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { computeVersionHash, sha256Hex } from '../../doc-versions/domain/version-hash';
import { DocumentsService, actorName } from '../../documents/documents.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CollabLoadResult,
  CollabPersistencePort,
  CollabVersionReason,
  CollabVersionResult,
} from '../collab.contracts';
import { KeyedMutex } from './keyed-mutex';
import { MAX_REGISTRY_IDS, MentionRegistryStore } from './collab-mentions-registry';
import { WorkingStateStore, safeDocumentId } from './collab-working-state';

/** Niveau de permission minimal pour créer une version (3 = Modification), comme doc-versions. */
const MIN_WRITE_LEVEL = 3;

/** Au plus ce nombre de destinataires examinés par passage (les mentions sont bornées par commentaire). */
const MAX_MENTION_CANDIDATES = 50;
/** Durée pendant laquelle un destinataire sans accès n'est pas réexaminé (évite de marteler la base à chaque autosave). */
const NO_ACCESS_RECHECK_MS = 60_000;
const NO_ACCESS_CACHE_MAX = 5000;
const REBASE_CACHE_MAX = 5000;

/** Libellés (français) du résumé de version selon la raison de la sauvegarde. */
const REASON_SUMMARY: Record<CollabVersionReason, string> = {
  manual: 'Enregistrement manuel',
  close: "Fermeture de l'éditeur",
  idle: 'Sauvegarde automatique',
  import: 'Import DOCX',
  'before-import': 'Avant import DOCX',
};

const FILE_TYPE_NAMES: Record<string, string> = {
  [GED_COLLAB_STATE_EXTENSION]: 'État Yjs (éditeur DocuPro)',
  [GED_COLLAB_SNAPSHOT_EXTENSION]: 'Instantané HTML (éditeur DocuPro)',
};

/** Pièce à créer dans la version, binaire en mémoire. */
interface PieceSpec {
  originalName: string;
  fileExtension: string;
  fileTypeId: number;
  sortOrder: number;
  buffer: Buffer;
  hash: string;
}

interface RowsSpec {
  pieces: PieceSpec[];
  contentHash: string;
  changeKind: GedVersionChangeKind;
  changeSummary: string | null;
  createdBy: number | null;
  spaceId: number | null;
}

interface CreatedRows {
  documentVersionId: number;
  versionNumber: number;
  fileIds: number[];
}

/** Entrée de création d'un document texte (document + version 1 + rattachement à l'espace). */
export interface CreateCollabDocumentInput {
  label: string;
  spaceId: number;
  state: Uint8Array;
  user: AuthUser;
  changeSummary?: string | null;
}

/**
 * État persisté (version courante) dont la structure est invalide pour l'éditeur : signalé
 * proprement (422, message générique) plutôt qu'en erreur interne.
 */
export class InvalidCollabStateException extends UnprocessableEntityException {
  constructor() {
    super("Le contenu du document est invalide et ne peut pas être chargé");
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

/** Nom de fichier lisible pour une pièce : le libellé, sans séparateur de chemin ni caractère de contrôle. */
function safeFileName(label: string, extension: string): string {
  // eslint-disable-next-line no-control-regex
  const base = label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'document';
  return `${base}${extension}`;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persistance des documents texte natifs (port `CollabPersistencePort`).
 *
 * Un document texte est un document dont la version COURANTE porte une pièce `.ydoc` (état Yjs
 * binaire, sortOrder 0) accompagnée d'un instantané `.html` assaini (sortOrder 1). Entre deux
 * versions, l'autosave écrit un « état de travail » sous `ARCHIVES/collab` (hors base) ; il n'est
 * relu que s'il dérive de la version courante.
 *
 * DUPLICATION ASSUMÉE : `DocVersionsService.persistNewVersion` est privée ; la création de version
 * (lignes non courantes -> binaires -> bascule `is_current`, avec nettoyage en cas d'échec) en est
 * reproduite ici, à l'identique. À factoriser dès que doc-versions exposera une méthode publique.
 *
 * Aucun droit n'est contrôlé ici (le serveur temps réel l'a fait à la connexion ; le service REST
 * appelle `assertCanModify`) : ce service ne fait que lire et écrire.
 */
@Injectable()
export class CollabPersistenceService implements CollabPersistencePort {
  private readonly logger = new Logger(CollabPersistenceService.name);
  private readonly versionLocks = new KeyedMutex();
  private readonly stateLocks = new KeyedMutex();
  private readonly fileTypeIds = new Map<string, number>();
  private readonly mentionLocks = new KeyedMutex();
  private workingStore: WorkingStateStore | null = null;
  private mentionStore: MentionRegistryStore | null = null;
  /**
   * Versions créées depuis l'état vivant d'une salle : `from` = version de base connue de la salle,
   * `to` = dernière version créée. La salle ne connaît que `from` : sans ce relais, un autosave
   * postérieur à une version « idle » serait ignoré au rechargement (base périmée).
   */
  private readonly rebased = new Map<number, { from: number; to: number }>();
  private readonly noAccessUntil = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Coffre disque ; point d'extension pour les tests. */
  protected getStore(): FileStore {
    return new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
  }

  /** État de travail sur disque ; point d'extension pour les tests. */
  protected getWorkingStore(): WorkingStateStore {
    if (!this.workingStore) {
      this.workingStore = new WorkingStateStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
    }
    return this.workingStore;
  }

  /** Registre serveur des mentions notifiées ; point d'extension pour les tests. */
  protected getMentionStore(): MentionRegistryStore {
    if (!this.mentionStore) {
      this.mentionStore = new MentionRegistryStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
    }
    return this.mentionStore;
  }

  // ------------------------------------------------------------------------------- gardes

  /** Accès (404), niveau >= 3 (404/403), puis document ni gelé ni épuré (409) : règle de `DocVersionsService`. */
  async assertCanModify(documentId: number, user: AuthUser): Promise<void> {
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

  /** La version courante du document porte-t-elle une pièce `.ydoc` ? (document inexistant : non) */
  async isCollabDocument(documentId: number): Promise<boolean> {
    const piece = await this.prisma.documentFile.findFirst({
      where: {
        fileExtension: GED_COLLAB_STATE_EXTENSION,
        version: { documentId, isCurrent: true },
      },
      select: { fileId: true },
    });
    return piece != null;
  }

  // -------------------------------------------------------------------------------- chargement

  async loadDocument(documentId: number): Promise<CollabLoadResult | null> {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { label: true },
    });
    if (!doc) return null;
    const current = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: {
        documentVersionId: true,
        files: {
          orderBy: [{ sortOrder: 'asc' }, { fileId: 'asc' }],
          select: { fileId: true, fileExtension: true, hash: true },
        },
      },
    });
    if (!current) return null;
    const statePiece = current.files.find((f) => f.fileExtension === GED_COLLAB_STATE_EXTENSION);
    if (!statePiece) return null;

    const working = await this.readUsableWorkingState(documentId, current.documentVersionId);
    if (working) {
      return {
        documentId,
        label: doc.label,
        state: new Uint8Array(working),
        baseVersionId: current.documentVersionId,
      };
    }

    const store = this.getStore();
    if (!(await store.exists(statePiece.fileId, statePiece.fileExtension))) {
      throw new Error(`État du document ${documentId} introuvable sur le coffre disque`);
    }
    const buffer = await store.read(statePiece.fileId, statePiece.fileExtension);
    if (buffer.length > EDITOR_LIMITS.MAX_STATE_BYTES) {
      throw new Error(`État du document ${documentId} trop volumineux`);
    }
    if (statePiece.hash && sha256Hex(buffer) !== statePiece.hash) {
      throw new Error(`État du document ${documentId} altéré (empreinte non conforme)`);
    }
    // Refus d'un état corrompu : `decodeState` jette (message sans donnée sensible).
    const check = decodeState(new Uint8Array(buffer));
    try {
      if (!validateYDocStructure(check).ok) {
        this.logger.warn(`État de version invalide (document=${documentId}) : chargement refusé`);
        throw new InvalidCollabStateException();
      }
    } finally {
      check.destroy();
    }
    return {
      documentId,
      label: doc.label,
      state: new Uint8Array(buffer),
      baseVersionId: current.documentVersionId,
    };
  }

  /** État de travail seulement s'il dérive de la version courante, est sain et décodable. */
  private async readUsableWorkingState(
    documentId: number,
    currentVersionId: number,
  ): Promise<Buffer | null> {
    let working;
    try {
      working = await this.getWorkingStore().read(documentId);
    } catch (e) {
      this.logger.warn(`État de travail illisible (document=${documentId}) : ${(e as Error).message}`);
      return null;
    }
    if (!working || working.baseVersionId !== currentVersionId) return null;
    try {
      const ydoc = decodeState(new Uint8Array(working.state));
      try {
        if (!validateYDocStructure(ydoc).ok) {
          this.logger.warn(
            `État de travail invalide ignoré (document=${documentId}) : repli sur la version courante`,
          );
          return null;
        }
      } finally {
        ydoc.destroy();
      }
    } catch {
      this.logger.warn(
        `État de travail corrompu ignoré (document=${documentId}) : repli sur la version courante`,
      );
      return null;
    }
    return working.state;
  }

  async saveWorkingState(
    documentId: number,
    state: Uint8Array,
    baseVersionId: number,
  ): Promise<void> {
    if (state.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES) {
      throw new Error('État du document trop volumineux');
    }
    safeDocumentId(documentId); // identifiant hors norme : refusé AVANT toute autre analyse
    // Défense en profondeur : un état bien formé pour Yjs mais invalide pour l'éditeur n'est pas persisté.
    if (!this.isPersistable(documentId, state)) return;
    const relay = this.rebased.get(documentId);
    const base = relay && relay.from === baseVersionId ? relay.to : baseVersionId;
    await this.stateLocks.run(documentId, () =>
      this.getWorkingStore().write(documentId, state, base),
    );
  }

  /** Décode et valide la structure ; au moindre défaut, journal générique (sans contenu) et refus. */
  private isPersistable(documentId: number, state: Uint8Array): boolean {
    let ydoc: Y.Doc;
    try {
      ydoc = decodeState(state);
    } catch {
      this.logger.warn(`État illisible non persisté (document=${documentId})`);
      return false;
    }
    try {
      if (validateYDocStructure(ydoc).ok) return true;
      this.logger.warn(`État invalide non persisté (document=${documentId})`);
      return false;
    } finally {
      ydoc.destroy();
    }
  }

  async discardWorkingState(documentId: number): Promise<void> {
    this.rebased.delete(documentId);
    await this.stateLocks.run(documentId, () => this.getWorkingStore().remove(documentId));
  }

  // ------------------------------------------------------------------------------- versions

  async createVersion(
    documentId: number,
    state: Uint8Array,
    user: AuthUser | null,
    opts: { reason: CollabVersionReason; changeSummary?: string | null },
  ): Promise<CollabVersionResult | null> {
    const ydoc = decodeState(state);
    try {
      if (!validateYDocStructure(ydoc).ok) {
        this.logger.warn(`Version non créée : état invalide (document=${documentId})`);
        return null;
      }
      return await this.versionLocks.run(documentId, () =>
        this.createVersionLocked(documentId, state, ydoc, user, opts),
      );
    } finally {
      ydoc.destroy();
    }
  }

  private async createVersionLocked(
    documentId: number,
    state: Uint8Array,
    ydoc: Y.Doc,
    user: AuthUser | null,
    opts: { reason: CollabVersionReason; changeSummary?: string | null },
  ): Promise<CollabVersionResult | null> {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { label: true, isFrozen: true, documentState: true },
    });
    if (!doc) throw new NotFoundException('Document introuvable');
    if (doc.isFrozen || doc.documentState === DocumentState.Epure) {
      // Un document gelé/épuré en cours de session ne reçoit plus de version.
      this.logger.warn(`Version ignorée : document ${documentId} gelé ou épuré`);
      return null;
    }

    const current = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: {
        documentVersionId: true,
        files: {
          orderBy: [{ sortOrder: 'asc' }, { fileId: 'asc' }],
          select: { fileId: true, fileExtension: true, hash: true },
        },
      },
    });
    if (!current || !current.files.some((f) => f.fileExtension === GED_COLLAB_STATE_EXTENSION)) {
      throw new ConflictException("Ce document n'est pas un document texte");
    }

    const html = yDocToHtml(ydoc);
    const htmlBuffer = Buffer.from(html, 'utf8');
    const stateBuffer = Buffer.from(state.buffer, state.byteOffset, state.byteLength);
    const pieces = await this.buildPieces(doc.label, stateBuffer, htmlBuffer);

    if (await this.isSameContent(current.files, pieces[1].hash, ydoc)) return null;

    const rows: RowsSpec = {
      pieces,
      contentHash: computeVersionHash(pieces.map((p) => p.hash)),
      changeKind: GedVersionChangeKind.Modification, // v1 -> Création, décidé dans la transaction
      changeSummary: (opts.changeSummary?.trim() || REASON_SUMMARY[opts.reason]).slice(0, 2000),
      createdBy: user?.userGroupId ?? null,
      spaceId: null,
    };

    let created: CreatedRows | null = null;
    for (let attempt = 0; attempt < 2 && !created; attempt++) {
      try {
        created = await this.prisma.$transaction((tx) =>
          this.insertNextVersion(tx, documentId, rows),
        );
      } catch (e) {
        // Course sur le numéro de version : un seul réessai (le numéro est recalculé).
        if (!isUniqueViolation(e)) throw e;
        if (attempt === 1) {
          throw new ConflictException("Une autre version vient d'être créée : réessayez");
        }
      }
    }
    if (!created) throw new ConflictException("Une autre version vient d'être créée : réessayez");
    const done: CreatedRows = created;

    await this.writeAndActivate(documentId, done, pieces, () =>
      this.rollbackVersionRows(done.documentVersionId),
    );

    await this.prisma.document.update({
      where: { documentId },
      data: {
        ...(user?.userGroupId != null ? { modifiedBy: user.userGroupId } : {}),
        modifiedAt: new Date(),
      },
    });
    this.rememberRebase(documentId, current.documentVersionId, done.documentVersionId);
    await this.auditVersionCreated(documentId, done.versionNumber, user);
    return { documentVersionId: done.documentVersionId, versionNumber: done.versionNumber };
  }

  /**
   * Création d'un document texte : document + rattachement à l'espace + version 1 (courante) avec
   * ses deux pièces. Même séquence que `createVersionLocked` ; en cas d'échec, le document entier
   * est supprimé (cascade) et les binaires retirés.
   */
  async createDocument(
    input: CreateCollabDocumentInput,
  ): Promise<{ documentId: number; documentVersionId: number }> {
    const ydoc = decodeState(input.state);
    let html: string;
    try {
      if (!validateYDocStructure(ydoc).ok) {
        throw new BadRequestException('Contenu du document invalide');
      }
      html = yDocToHtml(ydoc);
    } finally {
      ydoc.destroy();
    }
    const stateBuffer = Buffer.from(
      input.state.buffer,
      input.state.byteOffset,
      input.state.byteLength,
    );
    const pieces = await this.buildPieces(input.label, stateBuffer, Buffer.from(html, 'utf8'));
    const rows: RowsSpec = {
      pieces,
      contentHash: computeVersionHash(pieces.map((p) => p.hash)),
      changeKind: GedVersionChangeKind.Creation,
      changeSummary: (input.changeSummary?.trim() || 'Création du document').slice(0, 2000),
      createdBy: input.user.userGroupId,
      spaceId: input.spaceId,
    };

    const created = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: { label: input.label.slice(0, 500), createdBy: input.user.userGroupId },
        select: { documentId: true },
      });
      await tx.gedSpaceDocument.create({
        data: {
          spaceId: input.spaceId,
          documentId: doc.documentId,
          addedBy: input.user.userGroupId,
        },
      });
      const version = await this.insertNextVersion(tx, doc.documentId, rows);
      return { documentId: doc.documentId, ...version };
    });

    await this.writeAndActivate(created.documentId, created, pieces, async () => {
      try {
        await this.prisma.document.delete({ where: { documentId: created.documentId } });
      } catch (e) {
        this.logger.error(
          `Annulation du document ${created.documentId} impossible, à nettoyer à la main : ${(e as Error).message}`,
        );
      }
    });
    await this.auditVersionCreated(created.documentId, created.versionNumber, input.user);
    return { documentId: created.documentId, documentVersionId: created.documentVersionId };
  }

  // ---------------------------------------------------------------------- mécanique de version

  private async fileTypeId(extension: string): Promise<number> {
    const cached = this.fileTypeIds.get(extension);
    if (cached != null) return cached;
    // Donnée de référence (pas un changement de schéma) : posée à la demande, mise en cache.
    let row: { fileTypeId: number };
    try {
      row = await this.prisma.fileType.upsert({
        where: { extension },
        create: { extension, friendlyName: FILE_TYPE_NAMES[extension] ?? extension },
        update: {},
        select: { fileTypeId: true },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      row = await this.prisma.fileType.findUniqueOrThrow({
        where: { extension },
        select: { fileTypeId: true },
      });
    }
    this.fileTypeIds.set(extension, row.fileTypeId);
    return row.fileTypeId;
  }

  private async buildPieces(label: string, state: Buffer, html: Buffer): Promise<PieceSpec[]> {
    const [stateType, htmlType] = await Promise.all([
      this.fileTypeId(GED_COLLAB_STATE_EXTENSION),
      this.fileTypeId(GED_COLLAB_SNAPSHOT_EXTENSION),
    ]);
    return [
      {
        originalName: safeFileName(label, GED_COLLAB_STATE_EXTENSION),
        fileExtension: GED_COLLAB_STATE_EXTENSION,
        fileTypeId: stateType,
        sortOrder: 0,
        buffer: state,
        hash: sha256Hex(state),
      },
      {
        originalName: safeFileName(label, GED_COLLAB_SNAPSHOT_EXTENSION),
        fileExtension: GED_COLLAB_SNAPSHOT_EXTENSION,
        fileTypeId: htmlType,
        sortOrder: 1,
        buffer: html,
        hash: sha256Hex(html),
      },
    ];
  }

  /**
   * « Contenu identique » : même empreinte de l'instantané HTML ET mêmes commentaires que la
   * version courante (les octets de l'état Yjs varient d'une session à l'autre, inutilisables).
   * Au moindre doute (pièce illisible), on considère le contenu différent.
   */
  private async isSameContent(
    currentFiles: { fileId: number; fileExtension: string; hash: string | null }[],
    newHtmlHash: string,
    newDoc: Y.Doc,
  ): Promise<boolean> {
    const htmlFile = currentFiles.find((f) => f.fileExtension === GED_COLLAB_SNAPSHOT_EXTENSION);
    const stateFile = currentFiles.find((f) => f.fileExtension === GED_COLLAB_STATE_EXTENSION);
    if (!htmlFile || !stateFile) return false;
    try {
      const store = this.getStore();
      let currentHtmlHash = htmlFile.hash;
      if (!currentHtmlHash) {
        if (!(await store.exists(htmlFile.fileId, htmlFile.fileExtension))) return false;
        currentHtmlHash = sha256Hex(await store.read(htmlFile.fileId, htmlFile.fileExtension));
      }
      if (currentHtmlHash !== newHtmlHash) return false;
      if (!(await store.exists(stateFile.fileId, stateFile.fileExtension))) return false;
      const currentDoc = decodeState(
        new Uint8Array(await store.read(stateFile.fileId, stateFile.fileExtension)),
      );
      try {
        return sameJson(listComments(currentDoc), listComments(newDoc));
      } finally {
        currentDoc.destroy();
      }
    } catch {
      return false;
    }
  }

  /** Numéro = max + 1, lignes de la version NON courante (l'ancienne reste courante). */
  private async insertNextVersion(
    tx: Prisma.TransactionClient,
    documentId: number,
    spec: RowsSpec,
  ): Promise<CreatedRows> {
    const now = new Date();
    const agg = await tx.documentVersion.aggregate({
      where: { documentId },
      _max: { versionNumber: true },
    });
    const versionNumber = (agg._max.versionNumber ?? 0) + 1;
    const version = await tx.documentVersion.create({
      data: {
        documentId,
        versionNumber,
        isCurrent: false,
        comment: null,
        createdBy: spec.createdBy,
      },
      select: { documentVersionId: true },
    });
    const fileIds: number[] = [];
    for (const p of spec.pieces) {
      const row = await tx.documentFile.create({
        data: {
          documentVersionId: version.documentVersionId,
          fileTypeId: p.fileTypeId,
          originalName: p.originalName,
          fileExtension: p.fileExtension,
          byteLength: BigInt(p.buffer.length),
          pageCount: null,
          sortOrder: p.sortOrder,
          hash: p.hash,
          hashComputedAt: now,
        },
        select: { fileId: true },
      });
      fileIds.push(row.fileId);
    }
    await tx.gedVersionInfo.create({
      data: {
        documentVersionId: version.documentVersionId,
        spaceId: spec.spaceId,
        contentHash: spec.contentHash,
        changeKind: versionNumber === 1 ? GedVersionChangeKind.Creation : spec.changeKind,
        changeSummary: spec.changeSummary,
        restoredFromVersionId: null,
      },
    });
    return { documentVersionId: version.documentVersionId, versionNumber, fileIds };
  }

  /**
   * Écrit les binaires, puis bascule `is_current` (transaction courte). En cas d'échec : retrait
   * de TOUS les binaires et annulation des lignes (`rollback`) ; l'ancienne version n'a jamais
   * cessé d'être courante.
   */
  private async writeAndActivate(
    documentId: number,
    created: CreatedRows,
    pieces: PieceSpec[],
    rollback: () => Promise<void>,
  ): Promise<void> {
    const store = this.getStore();
    try {
      for (let i = 0; i < pieces.length; i++) {
        await store.write(created.fileIds[i], pieces[i].fileExtension, pieces[i].buffer);
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.documentVersion.updateMany({
          where: { documentId, isCurrent: true },
          data: { isCurrent: false },
        });
        await tx.documentVersion.update({
          where: { documentVersionId: created.documentVersionId },
          data: { isCurrent: true },
        });
      });
    } catch (e) {
      // `remove` est sans effet sur un fichier absent : on nettoie TOUS les fileIds créés.
      await Promise.all(pieces.map((p, i) => store.remove(created.fileIds[i], p.fileExtension)));
      await rollback();
      this.logger.error(`Création de version échouée : ${(e as Error).message}`);
      throw e;
    }
  }

  private async rollbackVersionRows(documentVersionId: number): Promise<void> {
    try {
      await this.prisma.documentVersion.delete({ where: { documentVersionId } });
    } catch (e) {
      this.logger.error(
        `Annulation de la version ${documentVersionId} impossible, à nettoyer à la main : ${(e as Error).message}`,
      );
    }
  }

  private rememberRebase(documentId: number, previous: number, created: number): void {
    const existing = this.rebased.get(documentId);
    const from = existing && existing.to === previous ? existing.from : previous;
    if (this.rebased.size >= REBASE_CACHE_MAX) this.rebased.clear();
    this.rebased.set(documentId, { from, to: created });
  }

  private async auditVersionCreated(
    documentId: number,
    versionNumber: number,
    user: AuthUser | null,
  ): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: user?.userGroupId ?? null,
        actorFullName: user ? actorName(user) : 'Système',
        objectRef: `document:${documentId}`,
        newValue: `version-created:v${versionNumber}`,
      });
    } catch (e) {
      // La version existe déjà : un journal indisponible ne doit pas la faire échouer.
      this.logger.error(
        `Audit de version impossible (document=${documentId}) : ${(e as Error).message}`,
      );
    }
  }

  // --------------------------------------------------------------------------------- mentions

  /**
   * Notifie les NOUVELLES mentions. Le registre des ids déjà notifiés est un fichier d'état SERVEUR
   * (`ARCHIVES/collab/<id>.mentions.json`), jamais le Y.Doc : un écrivain ne peut ni le réécrire
   * (re-notification) ni le vider/remplir (silence). Ce service ne lit ni n'écrit rien dans le ydoc.
   *
   * - `opts.mentionIds` fourni : seuls ces ids sont considérés, intersectés avec les mentions
   *   encore présentes dans le ydoc (un id retiré du document n'est pas notifié) ; sinon, tous.
   * - Plafonds anti-spam : `MAX_MENTION_CANDIDATES` ids par appel, `MAX_REGISTRY_IDS` par document.
   * - Toute la section est sérialisée par document : des appels concurrents ne notifient pas deux fois.
   * - Registre illisible ou corrompu : traité comme vide (au pire une re-notification, jamais d'exception).
   */
  async notifyMentions(
    documentId: number,
    ydoc: Y.Doc,
    actor: AuthUser,
    opts?: { mentionIds?: readonly number[] },
  ): Promise<void> {
    try {
      // Lecture IMMÉDIATE : le ydoc peut être en cours de déchargement.
      let mentioned = extractMentionIds(ydoc);
      if (opts?.mentionIds) {
        const allowed = new Set(opts.mentionIds);
        mentioned = mentioned.filter((id) => allowed.has(id));
      }
      if (mentioned.length === 0) return;
      await this.mentionLocks.run(documentId, () =>
        this.notifyMentionsLocked(documentId, mentioned, actor),
      );
    } catch (e) {
      this.logger.warn(
        `Notification de mentions impossible (document=${documentId}) : ${(e as Error).message}`,
      );
    }
  }

  private async notifyMentionsLocked(
    documentId: number,
    mentioned: readonly number[],
    actor: AuthUser,
  ): Promise<void> {
    const store = this.getMentionStore();
    const registry = await store.read(documentId);
    if (registry.corrupted) {
      this.logger.warn(`Registre de mentions illisible (document=${documentId}) : repart à vide.`);
    }
    const notified = registry.ids;
    const now = Date.now();
    const candidates = mentioned
      .filter((id) => !notified.has(id))
      .filter((id) => (this.noAccessUntil.get(`${documentId}:${id}`) ?? 0) <= now)
      .slice(0, MAX_MENTION_CANDIDATES);
    if (candidates.length === 0) return;

    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { label: true },
    });
    if (!doc) return;

    const selfIds = await this.actorOwnGroupIds(actor);
    const recipients: number[] = [];
    const skippedSelf: number[] = [];
    for (const id of candidates) {
      if (selfIds.has(id)) skippedSelf.push(id); // auto-mention : ignorée, jamais notifiée
      else if (await this.recipientHasAccess(documentId, id)) recipients.push(id);
      else this.rememberNoAccess(documentId, id);
    }

    // Plafond du registre : au-delà, on ne notifie plus rien de nouveau (anti-spam).
    const room = Math.max(0, MAX_REGISTRY_IDS - notified.size);
    const toMark = [...skippedSelf, ...recipients].slice(0, room);
    if (toMark.length === 0) return;
    const toSend = recipients.filter((id) => toMark.includes(id));
    // On marque AVANT d'envoyer : en cas d'échec d'envoi, on démarque ci-dessous.
    const marked = new Set([...notified, ...toMark]);
    await store.write(documentId, marked);

    if (toSend.length === 0) return;
    try {
      await this.notifications.createMany(
        toSend,
        `${actorName(actor)} vous a mentionné dans le document « ${doc.label} »`,
        { type: 'document', id: documentId },
      );
    } catch (e) {
      // Échec d'envoi : on « démarque » pour qu'un prochain passage réessaie.
      const remaining = new Set([...marked].filter((id) => !toSend.includes(id)));
      await store.write(documentId, remaining).catch(() => undefined);
      throw e;
    }
  }

  private rememberNoAccess(documentId: number, userGroupId: number): void {
    if (this.noAccessUntil.size >= NO_ACCESS_CACHE_MAX) this.noAccessUntil.clear();
    this.noAccessUntil.set(`${documentId}:${userGroupId}`, Date.now() + NO_ACCESS_RECHECK_MS);
  }

  /** Tous les comptes-groupes de la PERSONNE qui écrit : se mentionner soi-même ne notifie personne. */
  private async actorOwnGroupIds(actor: AuthUser): Promise<Set<number>> {
    const ids = new Set<number>();
    if (actor.userGroupId != null) ids.add(actor.userGroupId);
    const rows = await this.prisma.appUserGroup.findMany({
      where: { userId: actor.userId },
      select: { userGroupId: true },
    });
    rows.forEach((r) => ids.add(r.userGroupId));
    return ids;
  }

  /**
   * Reconstitue l'identité du destinataire et exige `DocumentsService.canAccess` : une mention ne
   * donne JAMAIS de droit. Compte inconnu ou désactivé : pas de notification.
   */
  private async recipientHasAccess(documentId: number, userGroupId: number): Promise<boolean> {
    const row = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId },
      select: {
        userId: true,
        user: { select: { username: true, fullName: true, isAdmin: true, isDisabled: true } },
      },
    });
    if (!row || !row.user || row.user.isDisabled) return false;
    const recipient: AuthUser = {
      userId: row.userId,
      username: row.user.username,
      isAdmin: row.user.isAdmin,
      userGroupId,
      fullName: row.user.fullName ?? null,
    };
    return this.documents.canAccess(documentId, recipient);
  }
}
