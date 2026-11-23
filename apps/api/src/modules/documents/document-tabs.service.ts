import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { FileStore } from '@archivage/storage';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DocumentsService, actorName } from './documents.service';
import {
  canonicalSealPayload,
  parseSealPayload,
  sealTimestamp,
  signPayload,
  verifyPayload,
  SEAL_ALGORITHM,
  type SealingKey,
} from '@archivage/sealing';

import { computeDueDates, lifeCycleStartDate, toIsoDate } from '../archives/domain';
import type { AuthUser } from '../auth/auth.types';
import type { DocumentLifeCycleDto, DocumentPermissionDto } from './documents.dto';

/** Codes d'activité journalisés (anglais, techniques) → libellé lisible de l'onglet Historique. */
const NAVIGATION_LABELS: Record<string, string> = {
  'open document': 'Consultation du document',
};

/** Idem pour les valeurs posées par `AuditService.dataChange` sur un document. */
const DATA_CHANGE_LABELS: Record<string, string> = {
  indexed: 'Indexation enregistrée',
  'indexed+validated': 'Indexation enregistrée et document validé',
  deleted: 'Document supprimé',
  // Onglet « Sécurité et conformité » (2026-09-15). Le scellement et la vérification changent
  // l'état probatoire du document : ils doivent laisser une trace au même titre qu'une indexation.
  sealed: 'Cachet serveur apposé',
  resealed: 'Cachet serveur renouvelé',
  'integrity-ok': 'Intégrité vérifiée — conforme',
  'integrity-failed': 'Intégrité vérifiée — NON conforme',
  'integrity-imprinted': 'Empreintes de référence posées',
  'integrity-empty': 'Intégrité vérifiée — aucun fichier à contrôler',
};

/**
 * Onglets de consultation d'un document (`/documents/:id`) — cycle de vie, accès, prêts,
 * historique. Séparé de `DocumentsService`, qui porte l'indexation et le cycle de vie du binaire :
 * ces quatre onglets ne partagent aucune règle métier entre eux, seulement leur document d'ancrage.
 *
 * Depuis le 2026-08-04 (cf. mémo `docupro-v6-permission-levels-enforcement`), les écritures
 * exigent le niveau EFFECTIF de l'acteur sur ce document
 * (`DocumentsService.getEffectivePermissionLevel`, via `assertLevel`) :
 *  - `saveLifeCycle` — Archivistique (5) ;
 *  - `sealDocument` — Archivistique (5), ajouté le 2026-09-15 : le cachet fonde la valeur probante ;
 *  - `verifyIntegrity` — Modification (3), ajouté le 2026-09-15 : la vérification écrit un verdict
 *    et POSE l'empreinte de référence au premier passage, ce n'est pas une lecture.
 * `grantPermission`/`revokePermission` restent SANS contrôle ici (voir leur commentaire respectif) :
 * le niveau 4 Administration qu'ils exigent pour l'onglet Accès est posé côté `DocumentsController`,
 * pas ici, car `AccessInquiriesService.decide` réutilise `grantPermission` sous une autre
 * autorisation (menu). Les LECTURES (listPermissions, confidentialité, prêts, historique, état
 * d'intégrité et du cachet) restent ouvertes à quiconque a déjà passé `canAccess` pour charger la
 * page — c'est la consultation de la fiche, pas une action sur elle. Ce passage par `canAccess`
 * est vérifié par `DocumentsController.assertCanOpen` sur chaque route `:id/...` (2026-11-22) :
 * les méthodes de ce service, elles, ne le refont pas.
 */
@Injectable()
export class DocumentTabsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Garde de niveau EFFECTIF, factorisée : trois onglets en écriture la posent désormais avec
   * exactement la même sémantique — 404 si le document n'existe pas, 403 s'il est hors de portée.
   */
  private async assertLevel(documentId: number, user: AuthUser, min: number, refus: string) {
    const level = await this.documents.getEffectivePermissionLevel(documentId, user);
    if (level == null) throw new NotFoundException('Document introuvable');
    if (level < min) throw new ForbiddenException(refus);
  }

  private async assertDocument(documentId: number) {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: { documentId: true, documentTypeId: true, documentDate: true, createdAt: true },
    });
    if (!doc) throw new NotFoundException('Document introuvable');
    return doc;
  }

  // =========================================================================
  // Onglet « Cycle de vie »
  // =========================================================================

  /**
   * Cycle de vie du document, sur deux plans :
   *  - `typeRule` : la règle de son TYPE (`document_type_life_cycle`), en mois, avec les échéances
   *    qu'elle IMPLIQUE pour ce document précis — c'est la projection théorique ;
   *  - `documentLifeCycle` : les échéances propres au document, saisies à la main, qui l'emportent
   *    (même priorité que l'écran « DUA Expirés », cf. `ArchivesComplianceService`).
   *
   * Les deux sont renvoyés côte à côte, sans en résoudre un seul : l'écran doit pouvoir montrer
   * l'écart entre la règle générale et la dérogation, ce qu'une valeur unique masquerait.
   */
  async getLifeCycle(documentId: number) {
    const doc = await this.assertDocument(documentId);

    const typeRule = doc.documentTypeId
      ? await this.prisma.documentTypeLifeCycle.findUnique({
          where: { documentTypeId: doc.documentTypeId },
          select: {
            usefulnessLifespan: true,
            complianceLifespan: true,
            finalFate: { select: { finalFateId: true, label: true } },
            destructionMode: { select: { destructionModeId: true, label: true } },
          },
        })
      : null;

    const own = await this.prisma.documentLifeCycle.findUnique({
      where: { documentId },
      select: {
        documentLifeCycleId: true,
        usefulnessLifespan: true,
        complianceLifespan: true,
        observations: true,
        finalFateId: true,
        destructionModeId: true,
        finalFate: { select: { label: true } },
        destructionMode: { select: { label: true } },
        createdAt: true,
        modifiedAt: true,
      },
    });

    const startDate = lifeCycleStartDate(doc);
    // Échéances théoriques : ce que la règle du type donnerait pour CE document. C'est la valeur
    // que l'écran propose en pré-remplissage, et celle contre laquelle il signale un écart.
    const projected = typeRule
      ? computeDueDates(startDate, {
          usefulnessLifespan: typeRule.usefulnessLifespan,
          complianceLifespan: typeRule.complianceLifespan,
        })
      : null;

    return {
      startDate: toIsoDate(startDate),
      typeRule: typeRule
        ? {
            usefulnessLifespanMonths: typeRule.usefulnessLifespan,
            complianceLifespanMonths: typeRule.complianceLifespan,
            finalFate: typeRule.finalFate,
            destructionMode: typeRule.destructionMode,
            projectedUsefulness: toIsoDate(projected!.usefulnessLifespan),
            projectedCompliance: toIsoDate(projected!.complianceLifespan),
          }
        : null,
      documentLifeCycle: own
        ? {
            ...own,
            usefulnessLifespan: toIsoDate(own.usefulnessLifespan),
            complianceLifespan: toIsoDate(own.complianceLifespan),
          }
        : null,
    };
  }

  /**
   * Crée ou remplace le cycle de vie propre au document (un seul par document : `@@unique`).
   * Réservé au niveau 5 « Archivistique » : sort final, mode de destruction et échéances de
   * conformité engagent le sort du document bien après l'indexation courante.
   */
  async saveLifeCycle(documentId: number, input: DocumentLifeCycleDto, user: AuthUser) {
    await this.assertDocument(documentId);
    await this.assertLevel(
      documentId,
      user,
      5,
      'Niveau Archivistique requis pour le cycle de vie de ce document',
    );
    if (input.complianceLifespan < input.usefulnessLifespan) {
      // La conformité englobe l'utilité administrative : l'inverse rendrait la DUA inatteignable.
      throw new BadRequestException(
        "L'échéance de conformité ne peut pas précéder l'échéance d'utilité administrative",
      );
    }
    const data = {
      usefulnessLifespan: new Date(input.usefulnessLifespan),
      complianceLifespan: new Date(input.complianceLifespan),
      observations: input.observations?.trim() || null,
      finalFateId: input.finalFateId ?? null,
      destructionModeId: input.destructionModeId ?? null,
    };
    return this.prisma.documentLifeCycle.upsert({
      where: { documentId },
      create: { documentId, ...data, createdBy: user.userGroupId },
      update: { ...data, modifiedAt: new Date() },
    });
  }

  // =========================================================================
  // Onglet « Accès »
  // =========================================================================

  /**
   * Droits explicites posés sur CE document (`document_permission`), acteurs nommés ET profils
   * confondus : l'écran les sépare en deux onglets, mais ils vivent dans la même table et se
   * lisent d'un seul coup — `scope` dit lequel est lequel.
   */
  async listPermissions(documentId: number) {
    await this.assertDocument(documentId);
    const rows = await this.prisma.documentPermission.findMany({
      where: { documentId },
      select: {
        documentPermissionId: true,
        permissionLevelId: true,
        permissionLevel: { select: { name: true } },
        userGroupId: true,
        userGroup: {
          select: {
            userGroupId: true,
            user: { select: { fullName: true, username: true } },
            group: { select: { name: true } },
          },
        },
        groupId: true,
        group: { select: { groupId: true, name: true } },
        grantedBy: true,
        grantedAt: true,
        startDate: true,
        endDate: true,
      },
      orderBy: { grantedAt: 'desc' },
    });
    return rows.map((r) => ({
      documentPermissionId: r.documentPermissionId,
      permissionLevelId: r.permissionLevelId,
      permissionLevelName: r.permissionLevel.name,
      scope: r.groupId != null ? ('group' as const) : ('user' as const),
      userGroupId: r.userGroupId,
      // Un droit « profil » n'a pas d'acteur : le libellé porte alors le nom du profil, pour que
      // la ligne reste lisible sans que l'écran ait à recomposer deux cas.
      label:
        r.groupId != null
          ? (r.group?.name ?? `Profil #${r.groupId}`)
          : r.userGroup?.user?.fullName || r.userGroup?.user?.username || `#${r.userGroupId}`,
      groupName: r.groupId != null ? (r.group?.name ?? null) : (r.userGroup?.group?.name ?? null),
      grantedBy: r.grantedBy,
      grantedAt: r.grantedAt,
      startDate: r.startDate,
      endDate: r.endDate,
    }));
  }

  /**
   * ⚠ Pas de contrôle de niveau ICI : cette méthode est aussi appelée par
   * `AccessInquiriesService.decide` (acceptation d'une demande d'accès), autorisée par un axe
   * différent — le menu « Sécurité Documentaire » (`RequireMenu`), pas le niveau Administration
   * sur CE document. Le garde-fou niveau 4 est posé côté `DocumentsController.grantPermission`,
   * seul point d'entrée HTTP direct utilisé par l'onglet « Accès par Utilisateur »/« par Profil ».
   */
  async grantPermission(documentId: number, input: DocumentPermissionDto, user: AuthUser) {
    await this.assertDocument(documentId);
    const level = await this.prisma.permissionLevel.findUnique({
      where: { permissionLevelId: input.permissionLevelId },
    });
    if (!level) throw new BadRequestException('Niveau de permission inconnu');
    if (input.permissionLevelId === 1) {
      // « Denied » n'a pas vocation à être un droit accordé : l'absence de ligne EST le refus
      // (deny-by-default hors confidentialité). L'exclure ici double la garde déjà posée côté
      // frontend (`/referentials/permission-levels` ne le liste plus) pour un appel direct à l'API.
      throw new BadRequestException('Le niveau « Denied » ne peut pas être accordé explicitement');
    }

    if (input.groupId != null) {
      const group = await this.prisma.appGroup.findUnique({ where: { groupId: input.groupId } });
      if (!group) throw new BadRequestException('Profil introuvable');
      // Côté profil, l'unicité vient d'un index PARTIEL que Prisma ne connaît pas : pas d'`upsert`
      // possible, on retombe donc sur « chercher, puis créer si absent » — même idempotence.
      const existing = await this.prisma.documentPermission.findFirst({
        where: { documentId, groupId: input.groupId, permissionLevelId: input.permissionLevelId },
      });
      if (existing) return existing;
      return this.prisma.documentPermission.create({
        data: {
          documentId,
          groupId: input.groupId,
          permissionLevelId: input.permissionLevelId,
          grantedBy: user.userGroupId,
          startDate: input.startDate ? new Date(input.startDate) : null,
          endDate: input.endDate ? new Date(input.endDate) : null,
        },
      });
    }

    const target = await this.prisma.appUserGroup.findUnique({
      where: { userGroupId: input.userGroupId! },
    });
    if (!target) throw new BadRequestException('Utilisateur introuvable');

    // `@@unique(documentId, userGroupId, permissionLevelId)` : réaccorder le même niveau au même
    // acteur ne doit pas échouer sur une contrainte, mais rester sans effet (geste idempotent).
    return this.prisma.documentPermission.upsert({
      where: {
        documentId_userGroupId_permissionLevelId: {
          documentId,
          userGroupId: input.userGroupId!,
          permissionLevelId: input.permissionLevelId,
        },
      },
      create: {
        documentId,
        userGroupId: input.userGroupId!,
        permissionLevelId: input.permissionLevelId,
        grantedBy: user.userGroupId,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      },
      // Réaccorder le même niveau au même acteur reste sans effet SAUF sur la période : un admin
      // qui réaccorde avec une nouvelle fenêtre de dates s'attend à ce qu'elle s'applique.
      update: {
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      },
    });
  }

  /** Même remarque que `grantPermission` : le garde-fou niveau 4 vit côté `DocumentsController`. */
  async revokePermission(documentId: number, documentPermissionId: number) {
    const { count } = await this.prisma.documentPermission.deleteMany({
      where: { documentPermissionId, documentId },
    });
    if (count === 0) throw new NotFoundException('Droit introuvable');
    return { deleted: count };
  }

  // =========================================================================
  // Onglet « Accès par confidentialité »
  // =========================================================================

  /**
   * Niveau exigé par le document, et QUI l'atteint.
   *
   * La règle du module source : l'habilitation de l'utilisateur doit être de rang supérieur ou
   * égal à celui du document. On la calcule et on la montre — la liste des habilités est la seule
   * réponse utile à « qui peut voir ce document ? », qu'un simple libellé de niveau ne donne pas.
   *
   * Les administrateurs sont comptés à part : ils passent outre l'ACL (`app_user.is_admin`,
   * D-17), les inclure dans les « habilités par leur niveau » masquerait cette exception.
   */
  async getConfidentialite(documentId: number) {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: {
        confidentialiteId: true,
        confidentialite: { select: { confidentialiteId: true, label: true, rank: true } },
      },
    });
    if (!doc) throw new NotFoundException('Document introuvable');

    const requis = doc.confidentialite?.rank ?? null;

    const users = await this.prisma.appUser.findMany({
      where: { isDisabled: false },
      select: {
        userId: true,
        fullName: true,
        username: true,
        isAdmin: true,
        confidentialite: { select: { label: true, rank: true } },
      },
      orderBy: [{ fullName: 'asc' }, { username: 'asc' }],
    });

    const evalues = users.map((u) => {
      const rang = u.confidentialite?.rank ?? null;
      // Sans niveau requis, tout utilisateur actif atteint le seuil ; sinon il lui faut une
      // habilitation au moins égale. Un utilisateur sans habilitation n'atteint aucun seuil.
      const habilite = requis == null ? true : rang != null && rang >= requis;
      return {
        userId: u.userId,
        label: u.fullName || u.username,
        isAdmin: u.isAdmin,
        habilitation: u.confidentialite?.label ?? null,
        habilitationRank: rang,
        habilite,
      };
    });

    return {
      confidentialite: doc.confidentialite,
      /** Utilisateurs actifs atteignant le seuil par leur habilitation (hors passe-droit admin). */
      habilites: evalues.filter((u) => u.habilite && !u.isAdmin),
      /** Non habilités — ce sont eux que la règle écarterait si elle était bloquante. */
      nonHabilites: evalues.filter((u) => !u.habilite && !u.isAdmin),
      /** Administrateurs : accès quel que soit le niveau (D-17). */
      administrateurs: evalues.filter((u) => u.isAdmin).map((u) => u.label),
    };
  }

  /** Fixe (ou retire) le niveau de confidentialité exigé par le document. */
  async setConfidentialite(documentId: number, confidentialiteId: number | null, user: AuthUser) {
    await this.assertDocument(documentId);
    if (confidentialiteId != null) {
      const niveau = await this.prisma.confidentialite.findFirst({
        where: { confidentialiteId, isActive: true },
      });
      if (!niveau) throw new BadRequestException('Niveau de confidentialité inconnu');
    }
    await this.prisma.document.update({
      where: { documentId },
      data: { confidentialiteId, modifiedBy: user.userGroupId, modifiedAt: new Date() },
    });
    return this.getConfidentialite(documentId);
  }

  // =========================================================================
  // Onglet « Prêts »
  // =========================================================================

  /** Prêts (communications) portant sur ce document — en cours et rendus. */
  async listLendings(documentId: number) {
    await this.assertDocument(documentId);
    const rows = await this.prisma.lendingDocumentDetail.findMany({
      where: { documentId },
      select: {
        lendingDocumentDetailId: true,
        returnedDate: true,
        lending: {
          select: {
            lendingDocumentId: true,
            startDate: true,
            projectedReturnDate: true,
            motive: { select: { label: true } },
            userGroup: {
              select: {
                userGroupId: true,
                user: { select: { fullName: true, username: true } },
              },
            },
          },
        },
      },
      orderBy: { lending: { startDate: 'desc' } },
    });
    return rows.map((r) => ({
      lendingDocumentDetailId: r.lendingDocumentDetailId,
      lendingDocumentId: r.lending.lendingDocumentId,
      beneficiaryUserGroupId: r.lending.userGroup.userGroupId,
      beneficiary:
        r.lending.userGroup.user?.fullName ||
        r.lending.userGroup.user?.username ||
        `#${r.lending.userGroup.userGroupId}`,
      motive: r.lending.motive?.label ?? null,
      startDate: toIsoDate(r.lending.startDate),
      projectedReturnDate: r.lending.projectedReturnDate
        ? toIsoDate(r.lending.projectedReturnDate)
        : null,
      returnedDate: r.returnedDate,
    }));
  }

  // =========================================================================
  // Onglet « Sécurité et conformité »
  // =========================================================================

  /**
   * État d'intégrité SANS recalcul : ce que la dernière vérification a conclu, plus l'état du
   * cachet. Lire cet onglet ne doit pas relire tous les binaires du coffre — le recalcul est un
   * geste explicite (`verify`).
   */
  async getIntegrity(documentId: number) {
    await this.assertDocument(documentId);
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: {
        dateLastVerified: true,
        integrityOk: true,
        seal: true,
        versions: {
          where: { isCurrent: true },
          select: {
            files: {
              orderBy: { sortOrder: 'asc' },
              select: {
                fileId: true,
                originalName: true,
                fileExtension: true,
                byteLength: true,
                hash: true,
                hashComputedAt: true,
              },
            },
          },
        },
      },
    });
    const files = doc?.versions[0]?.files ?? [];
    return {
      dateLastVerified: doc?.dateLastVerified ?? null,
      integrityOk: doc?.integrityOk ?? null,
      seal: doc?.seal
        ? {
            algorithm: doc.seal.algorithm,
            keyFingerprint: doc.seal.keyFingerprint,
            sealedAt: doc.seal.sealedAt,
          }
        : null,
      files: files.map((f) => ({
        fileId: f.fileId,
        originalName: f.originalName,
        vaultName: `${f.fileId}${f.fileExtension}`,
        byteLength: f.byteLength != null ? Number(f.byteLength) : null,
        hash: f.hash,
        hashComputedAt: f.hashComputedAt,
      })),
    };
  }

  /**
   * Appose le cachet : signature Ed25519 sur une charge contenant les empreintes des binaires ET
   * l'instant du scellement. Exige que TOUS les binaires aient une empreinte de référence — sceller
   * un document dont on n'a pas encore mesuré le contenu n'attesterait rien.
   *
   * Re-sceller remplace le cachet précédent : c'est le geste normal après une réindexation ou un
   * remplacement de version. Le cachet remplacé n'étant plus nulle part une fois écrasé, son
   * empreinte de clé et sa date SIGNÉE partent en `oldValue` du journal (2026-09-15) — sans quoi
   * un renouvellement effaçait silencieusement l'attestation précédente.
   *
   * Niveau Archivistique (5) requis, comme le cycle de vie : le cachet est l'acte qui FONDE la
   * valeur probante du document, pas une opération d'indexation courante.
   */
  async sealDocument(documentId: number, key: SealingKey, user: AuthUser) {
    await this.assertDocument(documentId);
    await this.assertLevel(
      documentId,
      user,
      5,
      'Niveau Archivistique requis pour sceller ce document',
    );
    return this.applySeal(documentId, key, user);
  }

  /**
   * Cœur du scellement, SANS garde de document — même partage que `runIntegrityCheck`, et pour la
   * même raison : trois appelants aux autorisations différentes doivent signer avec un seul code.
   *  - `sealDocument` : geste d'archiviste sur une pièce, gardé au niveau 5 ;
   *  - `sealIfNeeded` : scellement automatique à la validation de l'indexation, autorisé par la
   *    validation elle-même (niveau 3) — exiger 5 ici rendrait l'automatisme inopérant pour
   *    l'agent qui valide, c'est-à-dire dans le cas nominal ;
   *  - `sealFonds` : rattrapage en lot, autorisé par le menu « Intégrité du fonds ».
   */
  private async applySeal(documentId: number, key: SealingKey, user: AuthUser) {
    const previous = await this.prisma.documentSeal.findUnique({
      where: { documentId },
      select: { keyFingerprint: true, payload: true },
    });
    const version = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: { files: { select: { fileId: true, hash: true } } },
    });
    const files = version?.files ?? [];
    if (files.length === 0) {
      throw new BadRequestException('Aucun fichier à sceller sur ce document');
    }
    const sansEmpreinte = files.filter((f) => !f.hash);
    if (sansEmpreinte.length > 0) {
      throw new BadRequestException(
        'Empreinte de référence manquante : lancez une vérification d’intégrité avant de sceller',
      );
    }

    // Tronqué à la seconde : c'est la précision que la colonne conserve (cf. `sealTimestamp`).
    const sealedAt = sealTimestamp(new Date());
    const payload = canonicalSealPayload({
      documentId,
      files: files.map((f) => ({ fileId: f.fileId, hash: f.hash! })),
      sealedAt,
    });
    const signature = signPayload(payload, key.privateKey);

    const seal = await this.prisma.documentSeal.upsert({
      where: { documentId },
      create: {
        documentId,
        algorithm: SEAL_ALGORITHM,
        keyFingerprint: key.fingerprint,
        payload,
        signature,
        sealedAt,
        sealedBy: user.userGroupId,
      },
      update: {
        algorithm: SEAL_ALGORITHM,
        keyFingerprint: key.fingerprint,
        payload,
        signature,
        sealedAt,
        sealedBy: user.userGroupId,
      },
    });
    const remplace = previous
      ? `${previous.keyFingerprint} @ ${parseSealPayload(previous.payload)?.sealedAt.toISOString() ?? '?'}`
      : null;
    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `document:${documentId}`,
      oldValue: remplace ?? undefined,
      newValue: previous ? 'resealed' : 'sealed',
    });

    return { algorithm: seal.algorithm, keyFingerprint: seal.keyFingerprint, sealedAt: seal.sealedAt };
  }

  /**
   * Le cachet du document couvre-t-il encore ses empreintes actuelles ?
   *
   * Sert aux deux automatismes : inutile de re-signer une pièce déjà attestée telle qu'elle est —
   * cela produirait un nouveau cachet à chaque validation et à chaque passage en lot, en écrasant
   * à chaque fois une attestation parfaitement valable et plus ancienne. Or en archivage, la date
   * la plus ANCIENNE est celle qui a de la valeur : c'est elle qui prouve depuis quand la pièce
   * existe sous cette forme.
   */
  private async sealCouvreLeContenu(documentId: number): Promise<boolean> {
    const seal = await this.prisma.documentSeal.findUnique({
      where: { documentId },
      select: { payload: true },
    });
    if (!seal) return false;
    const signed = parseSealPayload(seal.payload);
    if (!signed) return false;
    const version = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: { files: { select: { fileId: true, hash: true } } },
    });
    const files = (version?.files ?? []).filter((f) => f.hash);
    if (files.length === 0) return false;
    const actuel = canonicalSealPayload({
      documentId,
      files: files.map((f) => ({ fileId: f.fileId, hash: f.hash! })),
      sealedAt: signed.sealedAt,
    });
    return actuel === seal.payload;
  }

  /**
   * Scelle un document si — et seulement si — il ne l'est pas déjà pour son contenu actuel.
   *
   * Appelé à la VALIDATION de l'indexation (2026-09-15). Les documents acquis depuis cette date
   * sont déjà scellés par le worker : ce passage est alors un non-événement. Il sert au fonds
   * antérieur et aux pièces dont le binaire a changé depuis leur scellement.
   *
   * Ne lève jamais : une validation d'indexation réussie ne doit pas être annulée parce que le
   * cachet a échoué. Le rattrapage en lot repassera.
   */
  async sealIfNeeded(documentId: number, key: SealingKey, user: AuthUser): Promise<boolean> {
    try {
      if (await this.sealCouvreLeContenu(documentId)) return false;
      await this.applySeal(documentId, key, user);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scelle en lot les documents qui ne le sont pas encore — rattrapage du fonds antérieur.
   *
   * Même découpage en tranches que le balayage d'intégrité, et pour la même raison : sur un fonds
   * volumineux, tout signer d'un coup tiendrait la requête ouverte trop longtemps. Les candidats
   * sont les documents porteurs d'au moins un fichier avec empreinte — sans empreinte, il n'y a
   * rien à attester, et le balayage d'intégrité doit passer d'abord.
   */
  async sealFonds(key: SealingKey, user: AuthUser, limit: number) {
    // `seal: null` — les documents JAMAIS scellés, et eux seuls. Deux raisons de ne pas élargir
    // aux cachets devenus obsolètes :
    //  - la progression : chaque passage retire ses documents du filtre, donc relancer avance.
    //    Sur un critère que SQL ne sait pas exprimer, on réexaminerait les mêmes indéfiniment ;
    //  - la prudence : un cachet qui ne couvre plus le contenu peut signaler un binaire ALTÉRÉ.
    //    Re-signer automatiquement reviendrait à attester la falsification. Ce cas relève d'une
    //    décision humaine, pièce par pièce, ce que l'écran du document demande explicitement.
    const candidats = await this.prisma.document.findMany({
      where: {
        seal: null,
        versions: { some: { isCurrent: true, files: { some: { hash: { not: null } } } } },
      },
      select: { documentId: true },
      orderBy: { documentId: 'asc' },
      take: limit,
    });

    let scelles = 0;
    const echecs: { documentId: number; erreur: string }[] = [];
    for (const { documentId } of candidats) {
      try {
        await this.applySeal(documentId, key, user);
        scelles += 1;
      } catch (e) {
        echecs.push({ documentId, erreur: e instanceof Error ? e.message : 'erreur inconnue' });
      }
    }

    const restants = await this.prisma.document.count({
      where: {
        seal: null,
        versions: { some: { isCurrent: true, files: { some: { hash: { not: null } } } } },
      },
    });
    return { examines: candidats.length, scelles, echecs, restants };
  }

  /**
   * Vérifie le cachet, en séparant DEUX questions que rien ne doit confondre :
   *  - `signatureValid` : la charge signée est-elle authentique (clé de cette installation) ;
   *  - `contentMatches` : le contenu ACTUEL correspond-il encore à ce qui a été scellé.
   *
   * Une signature valide avec un contenu qui a changé n'est pas une falsification du cachet : c'est
   * un document modifié depuis son scellement, qu'il faut re-sceller. Les fondre en un seul
   * booléen rendrait les deux situations indiscernables.
   */
  async verifySeal(documentId: number, key: SealingKey) {
    await this.assertDocument(documentId);
    const seal = await this.prisma.documentSeal.findUnique({ where: { documentId } });
    if (!seal) return { sealed: false as const };

    // Clé différente (rotation, restauration sur une autre installation) : on ne peut RIEN
    // conclure — le dire, plutôt que de rendre un « invalide » qui accuserait à tort.
    if (seal.keyFingerprint !== key.fingerprint) {
      return {
        sealed: true as const,
        algorithm: seal.algorithm,
        sealedAt: seal.sealedAt,
        keyFingerprint: seal.keyFingerprint,
        knownKey: false as const,
        signatureValid: null,
        contentMatches: null,
        timestampMatches: null,
      };
    }

    const signatureValid = verifyPayload(seal.payload, seal.signature, key.publicKey);
    const signed = parseSealPayload(seal.payload);
    if (!signed) {
      // Charge illisible : le cachet ne dit plus rien, quel que soit l'état de sa signature.
      return {
        sealed: true as const,
        algorithm: seal.algorithm,
        sealedAt: seal.sealedAt,
        keyFingerprint: seal.keyFingerprint,
        knownKey: true as const,
        signatureValid: false,
        contentMatches: false,
        timestampMatches: false,
      };
    }

    const version = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: { files: { select: { fileId: true, hash: true } } },
    });
    const files = (version?.files ?? []).filter((f) => f.hash);
    // On compare le SEGMENT des fichiers, pas la charge entière : sinon une date retouchée en base
    // se signalerait comme « contenu modifié », deux problèmes bien distincts.
    const currentFiles = canonicalSealPayload({
      documentId,
      files: files.map((f) => ({ fileId: f.fileId, hash: f.hash! })),
      sealedAt: signed.sealedAt,
    });

    return {
      sealed: true as const,
      algorithm: seal.algorithm,
      // La date SIGNÉE fait foi — celle de la colonne peut avoir été retouchée.
      sealedAt: signed.sealedAt,
      keyFingerprint: seal.keyFingerprint,
      knownKey: true as const,
      signatureValid,
      contentMatches: currentFiles === seal.payload,
      timestampMatches: signed.sealedAt.getTime() === seal.sealedAt.getTime(),
    };
  }

  /**
   * Vérifie l'intégrité : pour chaque binaire de la version courante, présence sur le coffre puis
   * empreinte SHA-256 recalculée et comparée à l'empreinte de référence.
   *
   * Premier passage sur un document du fonds : il n'y a pas d'empreinte de référence, la
   * vérification la POSE (`imprinted`) au lieu de conclure à tort à une non-conformité. C'est le
   * seul moyen d'amorcer un fonds déjà numérisé — mais cela ne prouve rien sur le passé du
   * fichier, et l'écran le dit.
   *
   * Niveau Modification (3) requis (2026-09-15) : ce n'est pas une lecture. La vérification écrit
   * le verdict sur le document et, au premier passage, POSE l'empreinte de référence — décider ce
   * qui fait foi pour toutes les vérifications suivantes ne peut pas rester ouvert à un simple
   * consultant. Lire l'onglet (`getIntegrity`) reste, lui, accessible à qui peut ouvrir la fiche.
   */
  async verifyIntegrity(documentId: number, store: FileStore, user: AuthUser) {
    await this.assertDocument(documentId);
    await this.assertLevel(
      documentId,
      user,
      3,
      'Niveau Modification requis pour vérifier l’intégrité de ce document',
    );
    return this.runIntegrityCheck(documentId, store, user);
  }

  /**
   * Cœur de la vérification, SANS garde de document (2026-09-15).
   *
   * Deux appelants aux autorisations différentes le partagent, et il ne doit pas exister deux
   * implémentations d'un contrôle probatoire — deux codes qui divergent, c'est un écran et un
   * balayage qui se contredisent sur la même pièce :
   *  - `verifyIntegrity` : geste d'un agent SUR UN document, gardé par son niveau effectif ;
   *  - `sweepIntegrity` : balayage du fonds, autorisé par le MENU « Intégrité du fonds » — y
   *    appliquer le niveau document par document le rendrait inopérant, puisqu'un archiviste n'a
   *    pas de droit nominatif sur chacune des pièces qu'il a la charge de contrôler.
   */
  private async runIntegrityCheck(
    documentId: number,
    store: FileStore,
    user: AuthUser,
    /**
     * `always` pour un geste humain sur une pièce : la trace doit exister même quand tout va bien,
     * c'est la preuve que le contrôle a eu lieu. `notable` pour un balayage : n'inscrire au journal
     * que les non-conformités et les empreintes posées — 5 000 lignes « conforme » par passage
     * noieraient les quelques-unes qui demandent une action, et `dateLastVerified` porte déjà la
     * preuve qu'un document a été contrôlé.
     */
    journalisation: 'always' | 'notable' = 'always',
  ) {
    const version = await this.prisma.documentVersion.findFirst({
      where: { documentId, isCurrent: true },
      select: {
        files: {
          orderBy: { sortOrder: 'asc' },
          select: { fileId: true, fileExtension: true, originalName: true, hash: true },
        },
      },
    });
    const files = version?.files ?? [];

    const results: Array<{
      fileId: number;
      originalName: string | null;
      vaultName: string;
      exists: boolean;
      status: 'ok' | 'mismatch' | 'missing' | 'imprinted';
    }> = [];

    for (const f of files) {
      const vaultName = `${f.fileId}${f.fileExtension}`;
      if (!(await store.exists(f.fileId, f.fileExtension))) {
        results.push({ fileId: f.fileId, originalName: f.originalName, vaultName, exists: false, status: 'missing' });
        continue;
      }
      const digest = createHash('sha256').update(await store.read(f.fileId, f.fileExtension)).digest('hex');
      if (!f.hash) {
        await this.prisma.documentFile.update({
          where: { fileId: f.fileId },
          data: { hash: digest, hashComputedAt: new Date() },
        });
        results.push({ fileId: f.fileId, originalName: f.originalName, vaultName, exists: true, status: 'imprinted' });
        continue;
      }
      results.push({
        fileId: f.fileId,
        originalName: f.originalName,
        vaultName,
        exists: true,
        status: f.hash === digest ? 'ok' : 'mismatch',
      });
    }

    // Un document sans fichier n'est pas « conforme » : il n'y a rien à vérifier. `null` le dit,
    // là où `true` laisserait croire à un contrôle réussi.
    const integrityOk =
      results.length === 0 ? null : results.every((r) => r.status === 'ok' || r.status === 'imprinted');
    const verifiedAt = new Date();
    await this.prisma.document.update({
      where: { documentId },
      data: { dateLastVerified: verifiedAt, integrityOk },
    });

    // Un seul événement par passage, pas un par fichier : le journal doit rester lisible. Le code
    // retenu dit ce qui s'est joué — une non-conformité prime sur tout, une pose d'empreinte prime
    // sur un simple « conforme » car elle a CRÉÉ la référence au lieu de la contrôler.
    const code =
      integrityOk === null
        ? 'integrity-empty'
        : integrityOk === false
          ? 'integrity-failed'
          : results.some((r) => r.status === 'imprinted')
            ? 'integrity-imprinted'
            : 'integrity-ok';
    if (journalisation === 'always' || code === 'integrity-failed' || code === 'integrity-imprinted') {
      await this.audit.dataChange({
        userGroupId: user.userGroupId,
        actorFullName: actorName(user),
        objectRef: `document:${documentId}`,
        newValue: code,
      });
    }

    return { dateLastVerified: verifiedAt, integrityOk, files: results };
  }

  // =========================================================================
  // Écran « Intégrité du fonds » — contrôle en lot
  // =========================================================================

  /**
   * Couverture du fonds : combien de documents sont réellement protégés, et depuis quand.
   *
   * C'est le chiffre qui manquait — l'onglet d'une fiche dit l'état d'UNE pièce, jamais celui du
   * fonds. Sans lui, « nos archives sont contrôlées » est une affirmation invérifiable.
   *
   * `jamaisVerifies` compte les documents dont `dateLastVerified` est nul. Un document peut porter
   * une empreinte SANS avoir jamais été vérifié : depuis le 2026-09-15 l'empreinte est posée à
   * l'ingestion, ce qui protège la pièce dès son entrée mais ne constate rien. Les deux chiffres
   * répondent donc à deux questions distinctes — « est-ce mesurable ? » et « l'a-t-on mesuré ? ».
   */
  async integrityCoverage() {
    const [documents, fichiers, fichiersAvecEmpreinte, jamaisVerifies, nonConformes, scelles] =
      await Promise.all([
        this.prisma.document.count(),
        this.prisma.documentFile.count({ where: { version: { isCurrent: true } } }),
        this.prisma.documentFile.count({ where: { version: { isCurrent: true }, hash: { not: null } } }),
        this.prisma.document.count({ where: { dateLastVerified: null } }),
        this.prisma.document.count({ where: { integrityOk: false } }),
        this.prisma.documentSeal.count(),
      ]);
    return {
      documents,
      fichiers,
      fichiersAvecEmpreinte,
      jamaisVerifies,
      verifies: documents - jamaisVerifies,
      conformes: documents - jamaisVerifies - nonConformes,
      nonConformes,
      scelles,
    };
  }

  /**
   * Balaie le fonds par tranches : vérifie jusqu'à `limit` documents et rend un compte rendu.
   *
   * Ordre de passage délibéré — `dateLastVerified` croissant, NULLS FIRST : les documents jamais
   * contrôlés d'abord, puis les plus anciennement contrôlés. Relancer le balayage reprend donc là
   * où il s'est arrêté sans qu'on ait à suivre un curseur, et un fonds entier finit par être
   * couvert en répétant le même geste. Un passage tout-en-un a été écarté : sur plusieurs milliers
   * de binaires il relirait des dizaines de gigaoctets et tiendrait une requête HTTP ouverte
   * pendant des minutes.
   *
   * Une pièce en échec n'interrompt pas le balayage : un fichier absent du coffre est précisément
   * ce que l'on cherche, pas une raison d'abandonner les suivantes.
   */
  async sweepIntegrity(store: FileStore, user: AuthUser, limit: number) {
    const cibles = await this.prisma.document.findMany({
      where: { versions: { some: { isCurrent: true, files: { some: {} } } } },
      select: { documentId: true },
      orderBy: [{ dateLastVerified: { sort: 'asc', nulls: 'first' } }, { documentId: 'asc' }],
      take: limit,
    });

    let conformes = 0;
    let nonConformes = 0;
    let empreintesPosees = 0;
    const echecs: { documentId: number; erreur: string }[] = [];

    for (const { documentId } of cibles) {
      try {
        const res = await this.runIntegrityCheck(documentId, store, user, 'notable');
        if (res.integrityOk === false) nonConformes += 1;
        else conformes += 1;
        if (res.files.some((f) => f.status === 'imprinted')) empreintesPosees += 1;
      } catch (e) {
        echecs.push({ documentId, erreur: e instanceof Error ? e.message : 'erreur inconnue' });
      }
    }

    const restants = await this.prisma.document.count({
      where: { dateLastVerified: null, versions: { some: { isCurrent: true, files: { some: {} } } } },
    });
    return { traites: cibles.length, conformes, nonConformes, empreintesPosees, echecs, restants };
  }

  /** Documents actuellement en échec d'intégrité — la liste sur laquelle il faut agir. */
  async listNonCompliant(limit = 200) {
    const rows = await this.prisma.document.findMany({
      where: { integrityOk: false },
      select: { documentId: true, label: true, dateLastVerified: true },
      orderBy: { dateLastVerified: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      documentId: r.documentId,
      label: r.label,
      dateLastVerified: r.dateLastVerified,
    }));
  }

  // =========================================================================
  // Onglet « Paramétrage de numérisation »
  // =========================================================================

  /**
   * Deux plans, volontairement côte à côte :
   *  - `consigne` : ce que le paramétrage du TYPE prescrit (OCR, cryptage, compression, profil de
   *    scanner). Documentaire — V6 ne pilote aucun scanner ;
   *  - `numerisation` : ce qui a RÉELLEMENT été fait pour ce document — son lot d'acquisition, le
   *    mode employé (fusion simple ou découpage QR + OCR), et la présence effective de texte OCR
   *    dans ses binaires.
   *
   * Les afficher ensemble est tout l'intérêt de l'onglet : c'est l'ÉCART entre la consigne et le
   * réel qui informe. Ne montrer que la consigne, comme le module source, laissait croire qu'elle
   * avait été appliquée.
   */
  async getScanningSettings(documentId: number) {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: {
        documentTypeId: true,
        documentType: { select: { label: true } },
        batch: {
          select: {
            batchId: true,
            scanDate: true,
            sourceLabel: true,
            useIntercalaires: true,
            fileCount: true,
            documentCount: true,
            scannedByUser: { select: { user: { select: { fullName: true, username: true } } } },
          },
        },
        versions: {
          where: { isCurrent: true },
          select: {
            files: {
              orderBy: { sortOrder: 'asc' },
              select: {
                fileId: true,
                originalName: true,
                fileExtension: true,
                pageCount: true,
                byteLength: true,
                ocrText: true,
                fileType: { select: { friendlyName: true } },
              },
            },
          },
        },
      },
    });
    if (!doc) throw new NotFoundException('Document introuvable');

    const setting = doc.documentTypeId
      ? await this.prisma.documentTypeSetting.findUnique({
          where: { documentTypeId: doc.documentTypeId },
          select: {
            ocr: true,
            cryptage: true,
            tauxCompression: true,
            profilScanner: true,
            routines: true,
          },
        })
      : null;

    const files = doc.versions[0]?.files ?? [];
    return {
      documentTypeLabel: doc.documentType?.label ?? null,
      consigne: setting,
      numerisation: {
        batchId: doc.batch?.batchId ?? null,
        scanDate: doc.batch?.scanDate ?? null,
        sourceLabel: doc.batch?.sourceLabel ?? null,
        // Le mode du lot est ce qui décide de l'OCR : « avec intercalaires » déclenche la lecture
        // QR + OCR, « sans » se contente de fusionner les PDF.
        useIntercalaires: doc.batch?.useIntercalaires ?? null,
        fileCount: doc.batch?.fileCount ?? null,
        documentCount: doc.batch?.documentCount ?? null,
        scannedBy:
          doc.batch?.scannedByUser?.user?.fullName ||
          doc.batch?.scannedByUser?.user?.username ||
          null,
        files: files.map((f) => ({
          fileId: f.fileId,
          originalName: f.originalName,
          fileType: f.fileType?.friendlyName ?? f.fileExtension,
          pageCount: f.pageCount,
          byteLength: f.byteLength != null ? Number(f.byteLength) : null,
          // On ne renvoie pas le texte OCR (parfois énorme) : seulement s'il y en a, et combien.
          ocrChars: f.ocrText?.length ?? 0,
        })),
      },
    };
  }

  // =========================================================================
  // Onglet « Historique »
  // =========================================================================

  /**
   * Journal du document : modifications (`data_change_audit`, ancrées sur `document:{id}`) et
   * consultations (`navigation_audit`, ancrées sur l'URL). Les deux tables sont fusionnées et
   * triées ensemble — l'utilisateur veut une chronologie, pas deux listes à recouper.
   */
  async listHistory(documentId: number, limit = 200) {
    await this.assertDocument(documentId);
    const ref = `document:${documentId}`;
    const url = `/documents/${documentId}`;

    const [changes, visits] = await Promise.all([
      this.prisma.dataChangeAudit.findMany({
        where: { objectRef: ref },
        select: {
          dataChangeAuditId: true,
          changedAt: true,
          newValue: true,
          oldValue: true,
          actorFullName: true,
          auditAction: { select: { description: true } },
          userGroup: {
            select: { user: { select: { fullName: true, username: true } } },
          },
        },
        orderBy: { changedAt: 'desc' },
        take: limit,
      }),
      this.prisma.navigationAudit.findMany({
        where: { url },
        select: {
          auditId: true,
          activityAt: true,
          activity: true,
          actorFullName: true,
          userGroup: { select: { user: { select: { fullName: true, username: true } } } },
        },
        orderBy: { activityAt: 'desc' },
        take: limit,
      }),
    ]);

    const entries = [
      ...changes.map((c) => {
        // Le libellé lisible de la valeur journalisée fait un bien meilleur titre que la
        // description générique de l'action (« Modification »), qui doublonnerait avec l'étiquette.
        const readable = DATA_CHANGE_LABELS[c.newValue ?? ''];
        return {
          key: `change-${c.dataChangeAuditId}`,
          at: c.changedAt,
          kind: 'change' as const,
          action: readable ?? c.auditAction?.description ?? 'Modification',
          // Avec un libellé lisible, `newValue` ne serait qu'un doublon technique de ce libellé —
          // mais `oldValue` porte, lui, ce que l'action a REMPLACÉ (2026-09-15 : le cachet écrasé
          // par un renouvellement). Le taire aurait rendu la trace inutile là où elle compte.
          details: readable ? (c.oldValue ?? null) : (c.newValue ?? c.oldValue ?? null),
          // Le nom fige a l'ecriture prime : il dit qui a agi CE JOUR-LA. La jointure ne sert
          // que de repli pour les lignes anterieures au 2026-09-08, qui ne le portent pas.
          actor: c.actorFullName || c.userGroup?.user?.fullName || c.userGroup?.user?.username || null,
        };
      }),
      ...visits.map((v) => ({
        key: `visit-${v.auditId}`,
        at: v.activityAt,
        kind: 'visit' as const,
        // Les activités sont journalisées avec un code technique anglais : on le traduit ici
        // plutôt qu'à l'écran, pour que tout consommateur du journal lise la même chose.
        action: NAVIGATION_LABELS[v.activity ?? ''] ?? v.activity ?? 'Consultation',
        details: null,
        actor: v.actorFullName || v.userGroup?.user?.fullName || v.userGroup?.user?.username || null,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    return entries.slice(0, limit);
  }
}
