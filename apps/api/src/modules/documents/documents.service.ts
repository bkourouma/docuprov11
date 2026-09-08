import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { DiskFileStore } from '@archivage/storage';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { IndexationDto } from './documents.dto';
import {
  MetadataValueError,
  normalizeMetadataValue,
  type RawMetadataValue,
} from './domain/metadata-value';

/**
 * Nom a consigner dans le journal pour l'acteur d'une requete.
 *
 * `fullName` vient du jeton ; il manque sur les jetons emis avant le 2026-09-08, d'ou le repli
 * sur l'identifiant de connexion — mieux vaut « admin » qu'un evenement sans auteur.
 */
function actorName(user: AuthUser): string {
  return user.fullName?.trim() || user.username;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Accès par CONFIDENTIALITÉ : fin de l'override global D-17 (2026-08-04) pour cet axe précis.
   * Un document sans confidentialité requise reste ouvert à tous, comme avant — seule une
   * confidentialité explicitement posée devient un vrai filtre. `/search` applique la même règle
   * (`SearchService.buildWhere`), pour ne pas lister ce qu'on ne peut pas ouvrir.
   *
   * Les droits `document_permission`/`document_type_permission` (menu « Sécurité Documentaire »)
   * restent eux administrés mais NON appliqués : cet axe suppose de décider quelle action exige
   * quel `PermissionLevel`, ce qui reste à concevoir (cf. `AccessTab.tsx`, toujours honnête
   * là-dessus).
   *
   * Le CRÉATEUR garde toujours accès à sa propre pièce, même sous-habilité : sans ce garde-fou, un
   * agent qui numérise un type « Secret » sans être lui-même habilité « Secret » ne pourrait plus
   * indexer ni consulter ce qu'il vient de créer.
   */
  async canAccess(documentId: number, user: AuthUser): Promise<boolean> {
    if (user.isAdmin || user.isScanAgent) return true;

    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { confidentialiteId: true, createdBy: true },
    });
    if (!doc) return false;
    if (doc.confidentialiteId == null) return true;
    if (doc.createdBy != null && doc.createdBy === user.userGroupId) return true;

    const required = await this.prisma.confidentialite.findUnique({
      where: { confidentialiteId: doc.confidentialiteId },
      select: { rank: true },
    });
    // Confidentialité référencée mais introuvable (désactivée entre-temps) : ne bloque pas sur une
    // référence orpheline plutôt que d'inventer un refus.
    if (!required) return true;

    const appUser = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: { confidentialite: { select: { rank: true } } },
    });
    const userRank = appUser?.confidentialite?.rank ?? null;
    return userRank != null && userRank >= required.rank;
  }

  /**
   * Niveau de permission EFFECTIF de `user` sur ce document (`document_permission`/
   * `document_type_permission` réellement appliqués, 2026-08-04 — cf. mémo
   * `docupro-v6-permission-levels-enforcement`) :
   *  - admin/scanAgent → 5 (Archivistique), même passe-droit que `canAccess` ;
   *  - base 2 (Consultation) : quiconque atteint ce point a déjà passé `canAccess`, donc peut au
   *    moins lire la fiche — ce plancher n'est PAS un droit accordé, juste ce que « voir la page »
   *    implique déjà ;
   *  - créateur du document → au moins 3 (Modification), même garde-fou que `canAccess` : sans
   *    lui, un agent sous-habilité ne pourrait plus indexer ce qu'il vient de créer ;
   *  - le maximum des droits explicites qui s'appliquent : `document_permission` (sur CE document,
   *    par son `userGroupId` acteur OU son `groupId` de profil) et `document_type_permission` (sur
   *    le TYPE du document, par son `userGroupId` acteur OU son `roleId`).
   * Renvoie `null` si le document n'existe pas (à l'appelant de décider 404 vs 403).
   *
   * Les deux tables ne partagent PAS le même bénéficiaire collectif (2026-08-06) : les droits sur un
   * document visent un PROFIL (`app_group`), ceux sur un type visent un RÔLE — d'où deux filtres.
   *
   * `AppUserGroup.groupId` : chaque `userGroupId` ne porte qu'UN SEUL profil (contrairement à
   * `userId`, qui peut avoir plusieurs `AppUserGroup`) — pas de résolution multi-groupe nécessaire,
   * le token ne porte que l'acteur par défaut (D7, `AuthService.login`).
   */
  async getEffectivePermissionLevel(documentId: number, user: AuthUser): Promise<number | null> {
    if (user.isAdmin || user.isScanAgent) return 5;

    const document = await this.prisma.document.findUnique({
      where: { documentId },
      select: { documentTypeId: true, createdBy: true },
    });
    if (!document) return null;

    let level = 2;
    if (document.createdBy != null && document.createdBy === user.userGroupId) {
      level = Math.max(level, 3);
    }

    const [actorGroup, account] = await Promise.all([
      user.userGroupId != null
        ? this.prisma.appUserGroup.findUnique({
            where: { userGroupId: user.userGroupId },
            select: { groupId: true },
          })
        : Promise.resolve(null),
      this.prisma.appUser.findUnique({
        where: { userId: user.userId },
        select: { roleId: true },
      }),
    ]);
    const groupId = actorGroup?.groupId ?? null;
    const roleId = account?.roleId ?? null;

    const namedActor = user.userGroupId != null ? [{ userGroupId: user.userGroupId }] : [];
    const docFilter = [...namedActor, ...(groupId != null ? [{ groupId }] : [])];
    const typeFilter = [...namedActor, ...(roleId != null ? [{ roleId }] : [])];
    if (docFilter.length === 0 && typeFilter.length === 0) return level;

    const [docGrants, typeGrants] = await Promise.all([
      docFilter.length > 0
        ? this.prisma.documentPermission.findMany({
            where: { documentId, OR: docFilter },
            select: { permissionLevelId: true },
          })
        : Promise.resolve([]),
      document.documentTypeId != null && typeFilter.length > 0
        ? this.prisma.documentTypePermission.findMany({
            where: { documentTypeId: document.documentTypeId, OR: typeFilter },
            select: { permissionLevelId: true },
          })
        : Promise.resolve([]),
    ]);
    for (const g of [...docGrants, ...typeGrants]) {
      level = Math.max(level, g.permissionLevelId);
    }
    return level;
  }

  /**
   * Document detail = current version -> files (FR-024), enrichi des libellés de classement et
   * des valeurs de métadonnées — c'est la page `/documents/:id` qui en a besoin : contrairement à
   * l'ancienne popup de `/search`, une page réachargée en direct (favori, lien partagé) ne peut
   * pas compter sur les référentiels d'une liste déjà chargée pour résoudre les IDs en libellés.
   * Emits a navigation audit (FR-033).
   */
  async getDetail(documentId: number, user: AuthUser) {
    if (!(await this.canAccess(documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    const document = await this.prisma.document.findUnique({
      where: { documentId },
      select: {
        documentId: true,
        label: true,
        cote: true,
        documentDate: true,
        createdAt: true,
        documentTypeId: true,
        documentType: { select: { documentTypeId: true, label: true } },
        planId: true,
        plan: { select: { planId: true, label: true, code: true } },
        dossierId: true,
        dossier: { select: { dossierId: true, label: true } },
        locationId: true,
        confidentialiteId: true,
        confidentialite: { select: { confidentialiteId: true, label: true, rank: true } },
        isArchived: true,
        isFrozen: true,
        metadataValues: {
          select: { metaDataId: true, value: true, metaDataListItemId: true },
        },
        versions: {
          where: { isCurrent: true },
          select: {
            documentVersionId: true,
            versionNumber: true,
            files: {
              orderBy: { sortOrder: 'asc' },
              select: { fileId: true, originalName: true, fileExtension: true, pageCount: true, sortOrder: true },
            },
          },
        },
      },
    });
    if (!document) throw new NotFoundException('Document introuvable');

    await this.audit.navigation({
      userGroupId: user.userGroupId,
      // Nom FIGÉ dans la ligne : `userGroupId` est nullable (compte sans groupe par défaut,
      // jeton émis avant que le groupe n'existe) et l'onglet « Historique » affichait alors un
      // événement sans auteur, définitivement.
      actorFullName: actorName(user),
      activity: 'open document',
      url: `/documents/${documentId}`,
    });

    const current = document.versions[0] ?? null;
    // Recalculé plutôt que réutilisé depuis `canAccess` : peu coûteux (mêmes tables, déjà en
    // cache de requête Prisma pour l'essentiel) et évite de dupliquer la logique dans l'appelant —
    // c'est ce niveau que le frontend affiche/masque l'onglet Indexation dessus.
    const effectivePermissionLevel = await this.getEffectivePermissionLevel(documentId, user);
    return {
      documentId: document.documentId,
      label: document.label,
      cote: document.cote,
      documentDate: document.documentDate ? document.documentDate.toISOString().slice(0, 10) : null,
      createdAt: document.createdAt,
      documentTypeId: document.documentTypeId,
      documentType: document.documentType,
      planId: document.planId,
      plan: document.plan,
      dossierId: document.dossierId,
      dossier: document.dossier,
      locationId: document.locationId,
      confidentialiteId: document.confidentialiteId,
      confidentialite: document.confidentialite,
      isArchived: document.isArchived,
      isFrozen: document.isFrozen,
      metadataValues: document.metadataValues,
      currentVersion: current,
      effectivePermissionLevel,
    };
  }

  /**
   * Indexation QA d'un document (FR-... / écran Menu 49 legacy) : met à jour les métadonnées
   * et, si `validate`, valide le document (`isArchived=true`) + sa version courante.
   *
   * Exige le niveau 3 « Modification » (2026-08-04) : Consultation seule (2) ne donne accès qu'à
   * la lecture, pas à l'écriture des attributs/métadonnées — c'est le pendant serveur de l'onglet
   * Indexation masqué côté frontend pour ce niveau.
   */
  async indexDocument(documentId: number, input: IndexationDto, user: AuthUser) {
    const level = await this.getEffectivePermissionLevel(documentId, user);
    if (level == null) throw new NotFoundException('Document introuvable');
    if (level < 3) throw new ForbiddenException('Modification non autorisée sur ce document');

    const data: Prisma.DocumentUncheckedUpdateInput = {
      modifiedBy: user.userGroupId,
      modifiedAt: new Date(),
    };
    if (input.label !== undefined) data.label = input.label;
    if (input.documentTypeId !== undefined) data.documentTypeId = input.documentTypeId;
    if (input.planId !== undefined) data.planId = input.planId;
    if (input.dossierId !== undefined) data.dossierId = input.dossierId;
    if (input.documentDate !== undefined) {
      data.documentDate = input.documentDate ? new Date(input.documentDate) : null;
    }
    if (input.validate) {
      data.isArchived = true;
      data.validatedBy = user.userGroupId;
      data.validatedAt = new Date();
    }

    // Le type EFFECTIF après enregistrement commande les métadonnées acceptées : celui envoyé s'il
    // change, sinon celui déjà en base.
    const current = await this.prisma.document.findUnique({
      where: { documentId },
      select: { documentTypeId: true },
    });
    const effectiveTypeId =
      input.documentTypeId !== undefined ? input.documentTypeId : (current?.documentTypeId ?? null);
    const typeChanged =
      input.documentTypeId !== undefined && input.documentTypeId !== current?.documentTypeId;

    // Un seul aller-retour transactionnel : le document et ses métadonnées ne doivent jamais rester
    // dans un état mi-enregistré (un type changé sans purge des valeurs devenues hors-type).
    const updated = await this.prisma.$transaction(async (tx) => {
      const doc = await tx.document.update({
        where: { documentId },
        data,
        select: { documentId: true, isArchived: true },
      });
      if (input.validate) {
        await tx.documentVersion.updateMany({
          where: { documentId, isCurrent: true },
          data: { isValidated: true },
        });
      }
      if (input.metadataValues !== undefined || typeChanged) {
        await this.saveMetadataValues(tx, documentId, effectiveTypeId, input.metadataValues);
      }
      return doc;
    });

    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `document:${documentId}`,
      newValue: input.validate ? 'indexed+validated' : 'indexed',
    });

    return updated;
  }

  /**
   * Enregistre les valeurs des métadonnées du formulaire dynamique.
   *
   * Deux règles tiennent la cohérence avec le paramétrage (`metadata_document_type`) :
   *  - on refuse une métadonnée qui n'est pas rattachée au type du document, plutôt que de stocker
   *    une valeur qu'aucun écran ne réafficherait jamais ;
   *  - on PURGE les valeurs hors-type — cas d'une métadonnée déliée du type depuis la saisie, ou
   *    d'un document dont le type a été retiré : elles resteraient sinon invisibles en base et
   *    ressurgiraient au retour au type d'origine.
   */
  private async saveMetadataValues(
    tx: Prisma.TransactionClient,
    documentId: number,
    documentTypeId: number | null,
    values: RawMetadataValue[] | undefined,
  ) {
    const links =
      documentTypeId == null
        ? []
        : await tx.metaDataDocumentType.findMany({
            where: { documentTypeId },
            select: { metaData: { select: { metaDataId: true, dataType: true, label: true } } },
          });
    const allowed = new Map(links.map((l) => [l.metaData.metaDataId, l.metaData]));

    // Purge : tout ce qui n'appartient plus au type courant (y compris tout, si le type est vidé).
    await tx.documentMetadataValue.deleteMany({
      where: { documentId, metaDataId: { notIn: [...allowed.keys()] } },
    });
    if (values === undefined) return;

    for (const raw of values) {
      const meta = allowed.get(raw.metaDataId);
      if (!meta) {
        throw new BadRequestException(
          `La métadonnée #${raw.metaDataId} n'est pas rattachée à ce type de document`,
        );
      }
      let normalized;
      try {
        normalized = normalizeMetadataValue(meta.dataType, raw);
      } catch (e) {
        if (e instanceof MetadataValueError) {
          throw new BadRequestException(`« ${meta.label} » : ${e.message}`);
        }
        throw e;
      }
      if (!normalized) {
        // Champ vidé : on supprime la ligne (cf. le CHECK « au moins une valeur » de la table).
        await tx.documentMetadataValue.deleteMany({
          where: { documentId, metaDataId: raw.metaDataId },
        });
        continue;
      }
      if (normalized.metaDataListItemId != null) {
        // Garde-fou : l'élément choisi doit appartenir à CETTE métadonnée, pas à une autre liste.
        const item = await tx.metaDataListItem.findUnique({
          where: { metaDataListItemId: normalized.metaDataListItemId },
          select: { metaDataId: true },
        });
        if (item?.metaDataId !== raw.metaDataId) {
          throw new BadRequestException(`« ${meta.label} » : valeur de liste inconnue`);
        }
      }
      await tx.documentMetadataValue.upsert({
        where: { documentId_metaDataId: { documentId, metaDataId: raw.metaDataId } },
        create: { documentId, metaDataId: raw.metaDataId, ...normalized },
        update: normalized,
      });
    }
  }

  /**
   * Suppression définitive d'un document : on supprime la ligne `document` (les versions,
   * fichiers et permissions partent en cascade via `onDelete: Cascade`), puis on retire les
   * binaires du coffre disque (best-effort : un fichier déjà absent est ignoré).
   */
  async deleteDocument(documentId: number, user: AuthUser) {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { versions: { select: { files: { select: { fileId: true, fileExtension: true } } } } },
    });
    if (!doc) throw new NotFoundException('Document introuvable');

    const files = doc.versions.flatMap((v) => v.files);

    await this.prisma.document.delete({ where: { documentId } });

    const store = new DiskFileStore(this.config.getOrThrow<string>('ARCHIVES_PATH'));
    await Promise.all(files.map((f) => store.remove(f.fileId, f.fileExtension)));

    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `document:${documentId}`,
      newValue: 'deleted',
    });

    return { deleted: true };
  }

  /**
   * Parmi les numéros de pièce (cotes) fournis, renvoie ceux **déjà utilisés par un autre
   * document** (doublons) — comparaison insensible à la casse et aux espaces.
   * `excludeBatchId` ignore les documents du lot en cours (qui portent justement ces cotes).
   */
  async findDuplicateCotes(cotes: string[], excludeBatchId?: number): Promise<string[]> {
    const norm = (s: string): string => s.trim().toUpperCase();
    const wanted = [...new Set((cotes ?? []).map(norm).filter((c) => c.length > 0))];
    if (wanted.length === 0) return [];

    const docs = await this.prisma.document.findMany({
      where: {
        AND: [
          { OR: wanted.map((c) => ({ cote: { equals: c, mode: 'insensitive' as const } })) },
          ...(excludeBatchId != null ? [{ NOT: { batchId: excludeBatchId } }] : []),
        ],
      },
      select: { cote: true },
    });

    const used = new Set(docs.map((d) => norm(d.cote ?? '')));
    return wanted.filter((c) => used.has(c));
  }

  async getFileForDownload(documentId: number, fileId: number, user: AuthUser) {
    if (!(await this.canAccess(documentId, user))) {
      throw new NotFoundException('Document introuvable');
    }
    const file = await this.prisma.documentFile.findFirst({
      where: { fileId, version: { documentId } },
      select: { fileId: true, fileExtension: true, originalName: true },
    });
    if (!file) throw new NotFoundException('Fichier introuvable');
    return file;
  }
}
