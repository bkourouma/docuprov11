import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DocumentState,
  GED_COLLAB_STATE_EXTENSION,
  GED_COLLAB_WS_PATH,
  type GedCollabCreated,
  type GedCollabImportResult,
  type GedCollabMentionCandidate,
  type GedCollabSaveVersionResult,
  type GedCollabSession,
  type GedDocumentVersionRow,
} from '@archivage/types';
import {
  EDITOR_LIMITS,
  applyHtmlToYDoc,
  decodeState,
  encodeState,
  exportDocx,
  htmlToYDoc,
  importDocxToHtml,
  listComments,
  yDocToJson,
} from '@archivage/editor/server';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { DocVersionsService } from '../../doc-versions/doc-versions.service';
import { DocumentsService, actorName } from '../../documents/documents.service';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveSpaceAccess, type SpaceActor } from '../../spaces/domain';
import { COLLAB_MIN_WRITE_LEVEL } from '../access/collab-access.service';
import {
  CollabPersistenceService,
  InvalidCollabStateException,
} from '../persistence/collab-persistence.service';
import { KeyedMutex } from '../persistence/keyed-mutex';
import { CollabServerService } from '../server/collab-server.service';
import {
  MAX_DOCUMENT_LABEL,
  MAX_DOCX_UPLOAD_BYTES,
  type CreateCollabDocumentDto,
  type ImportCollabDocumentDto,
  type RestoreCollabVersionDto,
  type SaveCollabVersionDto,
} from './collab-documents.dto';

/** Fichier déposé (multipart) — forme fournie par multer via `@UploadedFile`. */
export interface UploadedDocxFile {
  originalname: string;
  mimetype?: string;
  buffer: Buffer;
  size: number;
}

/** Contenu d'un export DOCX et nom de fichier d'origine (non assaini). */
export interface CollabDocxExport {
  buffer: Buffer;
  fileName: string;
}

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Plus grand identifiant de document admis (entier 32 bits signé). */
const MAX_DOCUMENT_ID = 2_147_483_647;
/** Signature d'un conteneur ZIP (un .docx en est un) : `PK\x03\x04`. */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MENTION_MAX_RESULTS = 10;
const MENTION_MIN_QUERY = 2;
/** Lignes lues avant filtrage par droits : de quoi en garder 10 même si beaucoup sont refusées. */
const MENTION_SCAN_ROWS = 60;
const MENTION_ACCESS_CONCURRENCY = 10;

/** Acteur sans aucun droit : compte désactivé/introuvable ou identité machine. */
const NO_ACTOR: SpaceActor = Object.freeze({ userGroupIds: [], roleId: null, isAdmin: false });

interface MentionRow {
  userGroupId: number;
  userId: number;
  username: string;
  fullName: string | null;
  isAdmin: boolean;
}

/** `%`, `_` et `\` sont littéraux dans la saisie : on les neutralise pour un `ILIKE ... ESCAPE '\'`. */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Nom de fichier d'export : ASCII lisible + forme UTF-8 (RFC 5987), sans caractère dangereux. */
export function buildContentDisposition(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = fileName.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 150);
  const name = clean || 'document';
  const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * API REST de l'éditeur natif : création/import de documents texte, session d'édition, versions,
 * restauration, export DOCX et candidats de mention.
 *
 * RÈGLE D'OR : toute route répond par le MÊME 404 (`Document introuvable`) quand le document est
 * inaccessible, inexistant ou n'est pas un document texte — avant tout autre contrôle, y compris
 * le niveau de permission (un 403 révélerait l'existence). Un droit d'ESPACE n'ouvre jamais un
 * document que `DocumentsService.canAccess` refuse.
 */
@Injectable()
export class CollabDocumentsService {
  private readonly logger = new Logger(CollabDocumentsService.name);
  /** Verrou par document : restauration, sauvegarde manuelle et import ne s'entrecroisent jamais. */
  private readonly documentLocks = new KeyedMutex();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly versions: DocVersionsService,
    private readonly persistence: CollabPersistenceService,
    private readonly collab: CollabServerService,
  ) {}

  // ------------------------------------------------------------------------------ création

  async createDocument(dto: CreateCollabDocumentDto, user: AuthUser): Promise<GedCollabCreated> {
    this.assertCanCreate(user);
    await this.assertCanContribute(dto.spaceId, user);
    const state = this.emptyState();
    return this.createAndAudit(dto.label, dto.spaceId, state, user, null, []);
  }

  /**
   * Création depuis un modèle (lot 4c) : le HTML est assaini par `stateFromHtml`. Mêmes droits et
   * même audit que `createDocument`.
   */
  async createDocumentFromHtml(
    spaceId: number,
    label: string,
    html: string,
    user: AuthUser,
  ): Promise<GedCollabCreated> {
    this.assertCanCreate(user);
    await this.assertCanContribute(spaceId, user);
    const state = this.stateFromHtml(html);
    return this.createAndAudit(
      label.slice(0, MAX_DOCUMENT_LABEL),
      spaceId,
      state,
      user,
      'Création depuis un modèle',
      [],
    );
  }

  async importNewDocument(
    file: UploadedDocxFile | undefined,
    dto: ImportCollabDocumentDto,
    user: AuthUser,
  ): Promise<GedCollabCreated> {
    this.assertCanCreate(user);
    // Droit d'espace AVANT toute analyse du fichier : un refus ne coûte aucun calcul.
    await this.assertCanContribute(dto.spaceId, user);
    const upload = this.validateDocx(file);
    const { html, warnings } = await this.convertDocx(upload.buffer);
    const state = this.stateFromHtml(html);
    const label = (dto.label ?? this.labelFromFileName(upload.originalname)).slice(
      0,
      MAX_DOCUMENT_LABEL,
    );
    return this.createAndAudit(label, dto.spaceId, state, user, 'Import DOCX', warnings);
  }

  private async createAndAudit(
    label: string,
    spaceId: number,
    state: Uint8Array,
    user: AuthUser,
    changeSummary: string | null,
    warnings: string[],
  ): Promise<GedCollabCreated> {
    const created = await this.persistence.createDocument({
      label,
      spaceId,
      state,
      user,
      changeSummary,
    });
    // Mêmes entrées de journal qu'un rattachement d'espace (`SpacesService.attachDocument`).
    await this.safeAudit(user, `space:${spaceId}`, `document-attached:${created.documentId}`);
    await this.safeAudit(user, `document:${created.documentId}`, `space-attached:${spaceId}`);
    return { documentId: created.documentId, label, warnings };
  }

  // ------------------------------------------------------------------------------- session

  async getSession(documentId: number, user: AuthUser): Promise<GedCollabSession> {
    const id = await this.requireTextDocument(documentId, user);
    const level = await this.documents.getEffectivePermissionLevel(id, user);
    if (level == null) throw this.notFound();
    if (user.userGroupId == null) {
      throw new ForbiddenException("Aucun profil actif n'est associé à ce compte");
    }
    const [doc, current] = await Promise.all([
      this.prisma.document.findUnique({
        where: { documentId: id },
        select: { label: true, isFrozen: true, documentState: true },
      }),
      this.prisma.documentVersion.findFirst({
        where: { documentId: id, isCurrent: true },
        select: { versionNumber: true },
      }),
    ]);
    if (!doc || !current) throw this.notFound();
    const locked = doc.isFrozen || doc.documentState === DocumentState.Epure;
    return {
      documentId: id,
      label: doc.label,
      mode: !locked && level >= COLLAB_MIN_WRITE_LEVEL ? 'write' : 'read',
      wsPath: GED_COLLAB_WS_PATH,
      currentVersionNumber: current.versionNumber,
      me: { userGroupId: user.userGroupId, name: actorName(user) },
    };
  }

  // ------------------------------------------------------------------------------- versions

  async saveVersion(
    documentId: number,
    dto: SaveCollabVersionDto,
    user: AuthUser,
  ): Promise<GedCollabSaveVersionResult> {
    const id = await this.requireTextDocument(documentId, user);
    await this.persistence.assertCanModify(id, user);
    const result = await this.documentLocks.run(id, async () => {
      const state = await this.currentState(id);
      return this.persistence.createVersion(id, state, user, {
        reason: 'manual',
        changeSummary: dto?.changeSummary ?? null,
      });
    });
    if (!result) return { created: false, version: null };
    return { created: true, version: await this.findRow(id, result.documentVersionId, user) };
  }

  async restore(
    documentId: number,
    dto: RestoreCollabVersionDto,
    user: AuthUser,
  ): Promise<GedDocumentVersionRow> {
    const id = await this.requireTextDocument(documentId, user);
    await this.persistence.assertCanModify(id, user);

    const target = await this.prisma.documentVersion.findFirst({
      where: { documentVersionId: dto.versionId, documentId: id },
      select: { files: { select: { fileExtension: true } } },
    });
    if (!target) throw new NotFoundException('Version introuvable');
    if (!target.files.some((f) => f.fileExtension === GED_COLLAB_STATE_EXTENSION)) {
      throw new ConflictException("Cette version n'est pas une version texte");
    }

    return this.documentLocks.run(id, async () => {
      // Garde-fou : les modifications non encore versionnées (salle vivante, état de travail) sont
      // figées dans une version avant d'être écartées. Sans effet si le contenu est identique.
      // NON BLOQUANT : un état illisible/invalide (document empoisonné) ne doit pas empêcher de
      // restaurer une version saine.
      try {
        await this.persistence.createVersion(id, await this.currentState(id), user, {
          reason: 'manual',
          changeSummary: 'Avant restauration',
        });
      } catch (e) {
        this.logger.warn(
          `Version « Avant restauration » non créée (document=${id}) : ${(e as Error).name}`,
        );
      }

      // Barrière de chargement (ANO-GED-08) posée AVANT `resetRoom` et levée APRÈS la suppression
      // de l'état de travail : `resetRoom` ferme les connexions en `Reload` et le client se
      // reconnecte aussitôt. Le verrou `documentLocks` ne protège que les routes REST ; sans cette
      // barrière, la reconnexion rechargeait l'état d'AVANT la restauration (version courante pas
      // encore remplacée), que la salle re-versionnait ensuite par-dessus la version restaurée.
      // Levée dans TOUS les cas (`finally`) : un échec ne laisse jamais la salle suspendue.
      const releaseRoomLoads = this.collab.holdRoomLoads(id);
      try {
        // La salle est réinitialisée AVANT la restauration : plus aucune connexion ne peut sauvegarder
        // l'état d'avant restauration après coup (le verrou ci-dessus bloque aussi les sauvegardes REST).
        // Si la salle ne peut pas être fermée, on s'arrête : rien n'est restauré (réessai possible).
        try {
          await this.collab.resetRoom(id);
        } catch (e) {
          this.logger.error(`Salle non réinitialisée (document=${id}) : ${(e as Error).message}`);
          throw new ConflictException("Restauration impossible : la salle d'édition est indisponible");
        }

        // Si `restore` jette, la salle (déjà réinitialisée) se recharge à la prochaine ouverture depuis
        // la version courante, inchangée : les clients reconnectés retrouvent l'état d'avant, qui vient
        // d'être figé dans la version « Avant restauration ».
        const row = await this.versions.restore(
          id,
          dto.versionId,
          { changeSummary: dto.changeSummary },
          user,
        );

        // La restauration est acquise : un échec de suppression de l'état de travail ne doit pas la masquer.
        try {
          await this.persistence.discardWorkingState(id);
        } catch (e) {
          this.logger.error(`État de travail non supprimé (document=${id}) : ${(e as Error).message}`);
        }
        return row;
      } finally {
        releaseRoomLoads();
      }
    });
  }

  // --------------------------------------------------------------------------------- export

  async exportDocx(documentId: number, user: AuthUser): Promise<CollabDocxExport> {
    const id = await this.requireTextDocument(documentId, user);
    const doc = await this.prisma.document.findUnique({
      where: { documentId: id },
      select: { label: true },
    });
    if (!doc) throw this.notFound();
    const ydoc = decodeState(await this.currentState(id));
    try {
      const buffer = await exportDocx({
        title: doc.label,
        json: yDocToJson(ydoc),
        comments: listComments(ydoc),
        author: actorName(user),
      });
      return { buffer, fileName: `${doc.label}.docx` };
    } finally {
      ydoc.destroy();
    }
  }

  // ---------------------------------------------------------------------- import (existant)

  async importIntoDocument(
    documentId: number,
    file: UploadedDocxFile | undefined,
    user: AuthUser,
  ): Promise<GedCollabImportResult> {
    const id = await this.requireTextDocument(documentId, user);
    await this.persistence.assertCanModify(id, user);
    const upload = this.validateDocx(file);
    // Conversion AVANT toute écriture : un fichier illisible ne laisse aucune trace.
    const { html, warnings } = await this.convertDocx(upload.buffer);
    await this.documentLocks.run(id, () => this.applyImport(id, html, user));
    return { warnings };
  }

  private async applyImport(id: number, html: string, user: AuthUser): Promise<void> {
    const live = this.collab.getLiveState(id);
    // NON BLOQUANT : la version de sauvegarde ne doit jamais empêcher l'import.
    try {
      const before = live ?? (await this.persistentState(id));
      await this.persistence.createVersion(id, before, user, { reason: 'before-import' });
    } catch (e) {
      this.logger.warn(`Version « avant import » non créée (document=${id}) : ${(e as Error).name}`);
    }

    if (live) {
      try {
        await this.collab.mutateDocument(id, (ydoc) => applyHtmlToYDoc(ydoc, html), user);
      } catch (e) {
        this.logger.error(`Import DOCX en salle impossible (document=${id}) : ${(e as Error).message}`);
        throw new ConflictException("Import impossible : contenu trop volumineux ou salle indisponible");
      }
      const after = this.collab.getLiveState(id) ?? (await this.persistentState(id));
      await this.persistence.createVersion(id, after, user, { reason: 'import' });
    } else {
      // Import = remplacement du contenu : si l'état persisté est invalide, on repart d'un état vierge.
      let base: Uint8Array;
      try {
        base = await this.persistentState(id);
      } catch (e) {
        if (!(e instanceof InvalidCollabStateException)) throw e;
        this.logger.warn(`État persisté invalide remplacé par l'import (document=${id})`);
        base = this.emptyState();
      }
      const ydoc = decodeState(base);
      let next: Uint8Array;
      try {
        applyHtmlToYDoc(ydoc, html);
        next = encodeState(ydoc);
      } finally {
        ydoc.destroy();
      }
      if (next.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES) {
        throw new BadRequestException('Le document importé est trop volumineux');
      }
      const created = await this.persistence.createVersion(id, next, user, { reason: 'import' });
      if (created) {
        await this.persistence.discardWorkingState(id);
      } else {
        // Contenu identique à la version courante : l'import doit tout de même remplacer
        // d'éventuelles modifications non versionnées -> état de travail rebasé sur la version courante.
        const current = await this.prisma.documentVersion.findFirst({
          where: { documentId: id, isCurrent: true },
          select: { documentVersionId: true },
        });
        if (current) await this.persistence.saveWorkingState(id, next, current.documentVersionId);
      }
    }
  }

  // ------------------------------------------------------------------- candidats de mention

  async mentionCandidates(
    documentId: number,
    q: string,
    user: AuthUser,
  ): Promise<GedCollabMentionCandidate[]> {
    const id = await this.requireTextDocument(documentId, user);
    const term = q.trim();
    if (term.length < MENTION_MIN_QUERY) return [];

    const pattern = `%${escapeLikePattern(term)}%`;
    const rows = await this.prisma.$queryRaw<MentionRow[]>(Prisma.sql`
      SELECT ug.user_group_id AS "userGroupId",
             ug.user_id       AS "userId",
             u.username       AS "username",
             u.full_name      AS "fullName",
             u.is_admin       AS "isAdmin"
        FROM app_user_group ug
        JOIN app_user u ON u.user_id = ug.user_id
       WHERE u.is_disabled = false
         AND u.user_id <> ${user.userId}
         AND (u.full_name ILIKE ${pattern} ESCAPE '\\' OR u.username ILIKE ${pattern} ESCAPE '\\')
       ORDER BY COALESCE(u.full_name, u.username), ug.user_group_id
       LIMIT ${MENTION_SCAN_ROWS}
    `);

    // Uniquement des acteurs QUI ONT DÉJÀ accès au document : lister quelqu'un d'autre
    // révélerait l'existence de comptes sans rien permettre (une mention ne donne aucun droit).
    const out: GedCollabMentionCandidate[] = [];
    for (let i = 0; i < rows.length && out.length < MENTION_MAX_RESULTS; i += MENTION_ACCESS_CONCURRENCY) {
      const chunk = rows.slice(i, i + MENTION_ACCESS_CONCURRENCY);
      const verdicts = await Promise.all(
        chunk.map((r) =>
          this.documents.canAccess(id, {
            userId: r.userId,
            username: r.username,
            isAdmin: r.isAdmin,
            userGroupId: r.userGroupId,
            fullName: r.fullName,
          }),
        ),
      );
      chunk.forEach((r, k) => {
        if (verdicts[k] && out.length < MENTION_MAX_RESULTS) {
          out.push({ userGroupId: r.userGroupId, name: r.fullName?.trim() || r.username });
        }
      });
    }
    return out;
  }

  // ------------------------------------------------------------------------------- internes

  private notFound(): NotFoundException {
    return new NotFoundException('Document introuvable');
  }

  /**
   * Garde commune : identité humaine, identifiant valide, accès (`canAccess`) puis document texte.
   * Tout échec = le même 404, avant tout autre contrôle.
   */
  private async requireTextDocument(documentId: number, user: AuthUser): Promise<number> {
    if (user.isScanAgent) throw this.notFound();
    if (!Number.isSafeInteger(documentId) || documentId < 1 || documentId > MAX_DOCUMENT_ID) {
      throw this.notFound();
    }
    if (!(await this.documents.canAccess(documentId, user))) throw this.notFound();
    if (!(await this.persistence.isCollabDocument(documentId))) throw this.notFound();
    return documentId;
  }

  private assertCanCreate(user: AuthUser): void {
    if (user.isScanAgent || user.userGroupId == null) {
      throw new ForbiddenException("Ce compte ne peut pas créer de document");
    }
  }

  /**
   * Droit de CONTRIBUTION sur l'espace : même règle que `SpacesService.authorize(..., 'contribute')`
   * (domaine pur `resolveSpaceAccess`), reproduite ici car `SpacesService` n'est pas fourni par
   * `CollabModule`. Espace invisible : 404 ; visible sans contribution : 403.
   */
  private async assertCanContribute(spaceId: number, user: AuthUser): Promise<void> {
    const actor = await this.resolveSpaceActor(user);
    const space = await this.prisma.gedSpace.findUnique({
      where: { gedSpaceId: spaceId },
      select: {
        kind: true,
        isActive: true,
        ownerUserGroupId: true,
        members: {
          where: {
            OR: [
              { userGroupId: { in: [...actor.userGroupIds] } },
              ...(actor.roleId != null ? [{ roleId: actor.roleId }] : []),
            ],
          },
          select: { userGroupId: true, roleId: true, permission: true },
        },
      },
    });
    if (!space) throw new NotFoundException('Espace introuvable');
    const decision = resolveSpaceAccess(
      {
        kind: space.kind,
        isActive: space.isActive,
        ownerUserGroupId: space.ownerUserGroupId,
        members: space.members,
      },
      actor,
    );
    if (!decision.visible) throw new NotFoundException('Espace introuvable');
    if (!decision.canContribute) {
      throw new ForbiddenException('Droit de contribution requis sur cet espace');
    }
  }

  /** L'acteur au niveau de la PERSONNE (comme `SpacesService.resolveActor`). */
  private async resolveSpaceActor(user: AuthUser): Promise<SpaceActor> {
    if (user.isScanAgent) return NO_ACTOR;
    const [groups, account] = await Promise.all([
      this.prisma.appUserGroup.findMany({
        where: { userId: user.userId },
        select: { userGroupId: true },
      }),
      this.prisma.appUser.findUnique({
        where: { userId: user.userId },
        select: { isDisabled: true, roleId: true, role: { select: { isActive: true } } },
      }),
    ]);
    if (!account || account.isDisabled) return NO_ACTOR;
    return {
      userGroupIds: groups.map((g) => g.userGroupId),
      roleId: account.roleId != null && account.role?.isActive ? account.roleId : null,
      isAdmin: user.isAdmin,
    };
  }

  private emptyState(): Uint8Array {
    return this.stateFromHtml('');
  }

  private stateFromHtml(html: string): Uint8Array {
    const ydoc = htmlToYDoc(html);
    try {
      const state = encodeState(ydoc);
      if (state.byteLength > EDITOR_LIMITS.MAX_STATE_BYTES) {
        throw new BadRequestException('Le document importé est trop volumineux');
      }
      return state;
    } finally {
      ydoc.destroy();
    }
  }

  /** État vivant de la salle si elle est ouverte, sinon état persistant. */
  private async currentState(documentId: number): Promise<Uint8Array> {
    return this.collab.getLiveState(documentId) ?? (await this.persistentState(documentId));
  }

  private async persistentState(documentId: number): Promise<Uint8Array> {
    const loaded = await this.persistence.loadDocument(documentId);
    if (!loaded) throw this.notFound();
    return loaded.state ?? this.emptyState();
  }

  private async findRow(
    documentId: number,
    versionId: number,
    user: AuthUser,
  ): Promise<GedDocumentVersionRow | null> {
    const rows = await this.versions.list(documentId, user);
    return rows.find((r) => r.documentVersionId === versionId) ?? null;
  }

  private validateDocx(file: UploadedDocxFile | undefined): UploadedDocxFile {
    if (!file?.buffer?.length) throw new BadRequestException('Aucun fichier reçu (ou fichier vide)');
    if (file.buffer.length > MAX_DOCX_UPLOAD_BYTES) {
      throw new BadRequestException('Fichier trop volumineux (10 Mo maximum)');
    }
    if (!/\.docx$/i.test(file.originalname ?? '')) {
      throw new BadRequestException('Seuls les fichiers Word (.docx) sont acceptés');
    }
    // Contrôle sur le contenu (signature ZIP), pas seulement sur le nom ou le type MIME déclarés.
    if (!file.buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) {
      throw new BadRequestException("Le fichier n'est pas un document Word (.docx) valide");
    }
    return file;
  }

  private async convertDocx(buffer: Buffer): Promise<{ html: string; warnings: string[] }> {
    try {
      const { html, warnings } = await importDocxToHtml(buffer);
      return { html, warnings };
    } catch (e) {
      // Détail technique journalisé, jamais renvoyé au client.
      this.logger.warn(`Import DOCX refusé : ${(e as Error).message}`);
      throw new BadRequestException('Le fichier Word est illisible ou non conforme');
    }
  }

  private labelFromFileName(fileName: string): string {
    const base = (fileName ?? '').replace(/\.docx$/i, '').trim();
    return base || 'Document importé';
  }

  /** Un journal indisponible ne doit pas faire échouer une création déjà effectuée. */
  private async safeAudit(user: AuthUser, objectRef: string, newValue: string): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: user.userGroupId,
        actorFullName: actorName(user),
        objectRef,
        newValue,
      });
    } catch (e) {
      this.logger.error(`Audit impossible (${objectRef}) : ${(e as Error).message}`);
    }
  }
}
