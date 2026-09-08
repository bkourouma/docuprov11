import { createHash, type KeyObject } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { FileStore } from '@archivage/storage';
import { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';
import {
  canonicalSealPayload,
  parseSealPayload,
  sealTimestamp,
  signPayload,
  verifyPayload,
  SEAL_ALGORITHM,
} from './domain/sealing';

/** Clé de scellement résolue, fournie par `SealingKeyService` (le domaine reste pur). */
interface SealingKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  fingerprint: string;
}
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
};

/**
 * Onglets de consultation d'un document (`/documents/:id`) — cycle de vie, accès, prêts,
 * historique. Séparé de `DocumentsService`, qui porte l'indexation et le cycle de vie du binaire :
 * ces quatre onglets ne partagent aucune règle métier entre eux, seulement leur document d'ancrage.
 *
 * Depuis le 2026-08-04 (cf. mémo `docupro-v6-permission-levels-enforcement`), `saveLifeCycle`
 * exige le niveau EFFECTIF de l'acteur sur ce document (`DocumentsService.getEffectivePermissionLevel`)
 * — Archivistique (5) pour le cycle de vie. `grantPermission`/`revokePermission` restent SANS
 * contrôle ici (voir leur commentaire respectif) : le niveau 4 Administration qu'ils exigent pour
 * l'onglet Accès est posé côté `DocumentsController`, pas ici, car `AccessInquiriesService.decide`
 * réutilise `grantPermission` sous une autre autorisation (menu). Le reste des onglets
 * (listPermissions en LECTURE, confidentialité, prêts, historique, scellement…) reste ouvert à
 * quiconque a déjà passé `canAccess` pour charger la page.
 */
@Injectable()
export class DocumentTabsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

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
    const level = await this.documents.getEffectivePermissionLevel(documentId, user);
    if (level == null) throw new NotFoundException('Document introuvable');
    if (level < 5) {
      throw new ForbiddenException('Niveau Archivistique requis pour le cycle de vie de ce document');
    }
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
   * remplacement de version. La trace du scellement précédent reste au journal d'audit.
   */
  async sealDocument(documentId: number, key: SealingKey, user: AuthUser) {
    await this.assertDocument(documentId);
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
    return { algorithm: seal.algorithm, keyFingerprint: seal.keyFingerprint, sealedAt: seal.sealedAt };
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
   */
  async verifyIntegrity(documentId: number, store: FileStore) {
    await this.assertDocument(documentId);
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

    return { dateLastVerified: verifiedAt, integrityOk, files: results };
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
          details: readable ? null : (c.newValue ?? c.oldValue ?? null),
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
