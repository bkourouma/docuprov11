import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MailActionCode, MailInputationTypeId, MailStatus, MailType } from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { effectiveMenuKeys } from '../auth/menu-access';
import { NotificationsService } from '../notifications/notifications.service';
import type { MailSeverity } from '../notifications/email.service';
import { MailScannedDocumentsService } from './mail-scanned.service';
import { WorkflowEventBus, mailArrivedEvent } from '../workflow-triggers/bus';
import {
  archiveEffect,
  mailScopeFromMenuKeys,
  markDecharge,
  markDepartRedige,
  nextReference,
  resolveOrganigrammeId,
  type MailScope,
} from './domain';

/** Échéance par défaut d'une imputation « Pour Suivi » créée à la validation DG (§08 : +48 h). */
const POUR_SUIVI_DEADLINE_HOURS = 48;

// Clés de verrou consultatif (pg_advisory_xact_lock) pour sérialiser la numérotation NReference.
const NREF_ARRIVEE_LOCK = 918470001;
const NREF_DEPART_NAMESPACE = 918470002;

/** Projection commune des lignes de worklist. */
const LIST_SELECT = {
  mailId: true,
  title: true,
  date: true,
  nReference: true,
  reference: true,
  mailType: true,
  status: true,
  valider: true,
  validationDirection: true,
  validationDG: true,
  decharge: true,
  dateTraited: true,
  dateButoire: true,
  createdAt: true,
  externalEntity: { select: { label: true } },
  destinataire: { select: { user: { select: { fullName: true, username: true } } } },
  destinataireRole: { select: { roleId: true, name: true } },
} satisfies Prisma.MailSelect;

export interface MailListResult {
  total: number;
  page: number;
  pageSize: number;
  rows: unknown[];
}

export interface CreateArriveeInput {
  title: string;
  date: Date;
  /** Destinataire = rôle (§05) : tous les utilisateurs qui le portent reçoivent le courrier. */
  destinataireRoleId: number;
  description?: string | null;
  reference?: string | null;
  nReference?: string | null;
  dateEnregistrementCourrier?: Date | null;
  dateFollowUp?: Date | null;
  dateButoire?: Date | null;
  mailNatureId?: number | null;
  confidentialiteId?: number | null;
  externalEntityId?: number | null;
  mailObjetId?: number | null;
  documentId?: number | null;
  scannedDocumentId?: number | null;
  enCopieUserGroupIds?: number[];
}

export interface CreateDepartInput {
  title: string;
  date: Date;
  /** Défaut : l'acteur courant (le rédacteur du Départ en est l'émetteur). */
  destinataireUserGroupId?: number | null;
  mailDepartTypeId?: number | null;
  nReference?: string | null;
  description?: string | null;
  reference?: string | null;
  externalEntityId?: number | null;
  confidentialiteId?: number | null;
  documentId?: number | null;
  /** PDF déposé via la file §07, promu en document GED — même chemin qu'à l'enregistrement (§05). */
  scannedDocumentId?: number | null;
  parentMailId?: number | null;
}

@Injectable()
export class MailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly scanned: MailScannedDocumentsService,
    // Docu-Flow W3 : bus d'événements métier (facultatif : absent hors application complète).
    @Optional() private readonly wfEvents?: WorkflowEventBus,
  ) {}

  private readonly wfLogger = new Logger('MailsService');

  /** Docu-Flow W3 : construction ET émission protégées ; ne remonte jamais (le courrier est déjà enregistré). */
  private emitMailArrived(mail: Parameters<typeof mailArrivedEvent>[0], hasDocument: boolean): void {
    try {
      this.wfEvents?.emit(mailArrivedEvent(mail, { hasDocument }));
    } catch (err) {
      this.wfLogger.warn(`émission « courrier arrivé » ignorée : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Worklists (§03.2/§03.4) ---------------------------------------------
  /**
   * File Contrôle (§06) : c'est la boîte de réception du destinataire PRINCIPAL désigné à
   * l'enregistrement (acteur nommé, ou porteur du rôle destinataire §05) — pas de tout le monde.
   * Un courrier n'y apparaît que tant qu'il n'est pas validé ; dès que ce destinataire le valide
   * (via sa première imputation, §06 auto), il en sort et n'y revient jamais.
   */
  async listControle(user: AuthUser, opts?: { page?: number; pageSize?: number }) {
    return this.paginate(await this.controleWhere(user), opts);
  }

  /** Where-clause du Contrôle (§06), partagée avec `badgeCounts` pour que le badge du menu ne
   *  compte pas plus de courriers que ce que la liste montre réellement à l'utilisateur. */
  private async controleWhere(user: AuthUser): Promise<Prisma.MailWhereInput> {
    const actor =
      user.userGroupId == null
        ? null
        : await this.prisma.appUser.findUnique({
            where: { userId: user.userId },
            select: { roleId: true },
          });
    return {
      isDeleted: false,
      valider: false,
      AND: [
        this.visibility(),
        {
          OR: [
            { destinataireExpediteur: user.userGroupId ?? -1 },
            ...(actor?.roleId != null ? [{ destinataireRoleId: actor.roleId }] : []),
          ],
        },
      ],
    };
  }

  /**
   * File Parapheur / Courriers Imputés (§08) : boîte de travail PERSONNELLE de chaque utilisateur —
   * les courriers qui LUI ont été confiés (imputés) pour traitement, réponse ou avis. Un courrier
   * n'y apparaît que tant que son imputation à cet utilisateur n'est pas traitée ; dès qu'il la
   * traite (`treatRecipient`), il en sort et n'y revient jamais — ce n'est pas une file commune.
   *
   * « En Copie » (type 17) est EXCLU : c'est une mise en connaissance, pas une charge de travail —
   * elle n'appelle aucune action de sa part. Ces courriers restent consultables au Suivi (§09).
   * Le filtre porte sur « au moins une imputation actionnable » et non sur « aucune En Copie » :
   * un même destinataire peut être à la fois en copie ET réellement imputé, auquel cas le courrier
   * doit bien figurer dans son parapheur.
   */
  listParapheur(user: AuthUser, opts?: { page?: number; pageSize?: number }) {
    return this.paginate(
      {
        isDeleted: false,
        ...this.visibility(),
        inputations: {
          some: {
            userId: user.userGroupId ?? -1,
            dateTreated: null,
            mailInputationTypeId: { not: MailInputationTypeId.EnCopie },
          },
        },
      },
      opts,
    );
  }

  /**
   * File Validation (§10) : les courriers validés au contrôle (§06) et pas encore traités. C'est
   * ici qu'on les marque traités — d'où la sortie de file sur `dateTraited`, et sur rien d'autre.
   *
   * Volontairement PAS restreinte au périmètre de suivi (§09) : l'écran est gardé par son propre
   * menu, et l'y soumettre rendait la liste vide pour un rôle ayant la Validation sans permission
   * de suivi. Pas de filtre sur `validationDirection` non plus : le drapeau est posé en même temps
   * que `dateTraited`, il ferait double emploi — et masquerait un courrier validé Direction resté
   * non traité.
   */
  listValidationDirection(opts?: { page?: number; pageSize?: number }) {
    return this.paginate({ isDeleted: false, valider: true, dateTraited: null }, opts);
  }

  /** File Suivi (§09) : courriers en cours (non traités), dans le périmètre de l'utilisateur. */
  async listSuivi(user: AuthUser, opts?: { page?: number; pageSize?: number }) {
    return this.paginateInScope(
      await this.mailScope(user),
      user,
      { isDeleted: false, dateTraited: null, ...this.visibility() },
      opts,
    );
  }

  /**
   * Périmètre de suivi de l'utilisateur (§09/§10) — cf. `mailScopeFromMenuKeys`. Recalculé depuis
   * le rôle en base, comme le `MenuPermissionGuard` : le JWT ne porte pas les menus, et un droit
   * retiré doit prendre effet sans reconnexion.
   */
  // Public : le tableau de bord doit résoudre le périmètre EXACTEMENT comme les files, sinon ses
  // compteurs et les listes divergeraient. Dupliquer la logique serait le meilleur moyen de les
  // laisser dériver l'une de l'autre.
  async mailScope(user: AuthUser): Promise<MailScope> {
    if (user.isAdmin) return 'all';
    const row = await this.prisma.appUser.findUnique({
      where: { userId: user.userId },
      select: {
        isAdmin: true,
        role: {
          select: { isActive: true, isSystem: true, menus: { select: { menuKey: true } } },
        },
      },
    });
    return mailScopeFromMenuKeys(effectiveMenuKeys(row?.isAdmin ?? false, row?.role ?? null));
  }

  /**
   * Applique le périmètre à une file : « DC » n'ouvre que les courriers où l'utilisateur porte une
   * imputation (traitée ou non — c'est l'existence du lien qui compte), et sans permission de suivi
   * la file est vide plutôt qu'ouverte par défaut.
   */
  private paginateInScope(
    scope: MailScope,
    user: AuthUser,
    where: Prisma.MailWhereInput,
    opts?: { page?: number; pageSize?: number },
  ): Promise<MailListResult> {
    if (scope === 'none') {
      return Promise.resolve({
        total: 0,
        page: Math.max(1, opts?.page ?? 1),
        pageSize: Math.min(200, Math.max(1, opts?.pageSize ?? 25)),
        rows: [],
      });
    }
    return this.paginate(
      scope === 'imputed'
        ? { ...where, inputations: { some: { userId: user.userGroupId ?? -1 } } }
        : where,
      opts,
    );
  }

  /**
   * Lookup « Courrier » de l'Intégration décharge (§13) : les courriers de DÉPART dont la preuve de
   * remise n'a pas encore été intégrée. Le critère est l'absence d'un document rattaché portant
   * `decharge = true` — c'est ce booléen (et non le drapeau `Decharge` du courrier) qui matérialise
   * la pièce signée, donc lui seul dit si la décharge est déjà là.
   */
  listDechargesEnAttente() {
    return this.prisma.mail.findMany({
      where: {
        isDeleted: false,
        mailType: MailType.Depart,
        documents: { none: { decharge: true } },
      },
      orderBy: [{ date: 'desc' }, { mailId: 'desc' }],
      take: 200,
      select: {
        mailId: true,
        nReference: true,
        title: true,
        date: true,
        externalEntity: { select: { label: true } },
      },
    });
  }

  /** File Courrier Départ (§12) : Départs traités OU en suivi ouvert. */
  listDepart(opts?: { page?: number; pageSize?: number }) {
    return this.paginate(
      {
        isDeleted: false,
        mailType: MailType.Depart,
        OR: [{ status: MailStatus.Traite }, { dateFollowUp: { not: null }, endDateFollowUp: null }],
      },
      opts,
    );
  }

  /**
   * Lookup « Lié au courrier » (§12) : courriers déjà enregistrés pour un correspondant donné.
   * Alimente le rattachement d'un Départ au courrier auquel il répond — d'où le filtre par
   * correspondant plutôt qu'une liste globale, qui serait inexploitable à l'écran.
   */
  listByExternalEntity(externalEntityId: number) {
    return this.prisma.mail.findMany({
      where: { isDeleted: false, externalEntityId },
      orderBy: [{ date: 'desc' }, { mailId: 'desc' }],
      take: 200,
      select: { mailId: true, nReference: true, title: true, date: true, mailType: true },
    });
  }

  /**
   * Détail d'un courrier. `restrictImputations` (parapheur §08) réduit la chaîne d'imputations à
   * ce qui concerne l'appelant : celles qui LUI sont adressées et celles qu'il a lui-même créées.
   * Le destinataire principal du courrier (et l'admin) échappe à cette réduction — c'est lui qui
   * pilote la chaîne, il doit en voir tout le déroulé.
   *
   * La décision est prise ICI et non côté client : l'appelant demande la réduction, mais c'est le
   * serveur qui tranche s'il y a droit d'y échapper. Les écrans de consultation (Recherche §11) ne
   * la demandent pas et reçoivent la chaîne complète.
   */
  async getById(mailId: number, user?: AuthUser, restrictImputations = false) {
    const mail = await this.prisma.mail.findFirst({
      where: { mailId, isDeleted: false },
      include: {
        externalEntity: { select: { externalEntityId: true, label: true } },
        nature: { select: { label: true } },
        confidentialite: { select: { label: true } },
        objet: { select: { label: true } },
        departType: { select: { label: true } },
        organigramme: { select: { label: true } },
        destinataire: {
          select: { userGroupId: true, user: { select: { fullName: true, username: true } } },
        },
        destinataireRole: { select: { roleId: true, name: true } },
        inputations: { include: { type: { select: { label: true, suivi: true } } } },
        documents: { include: { document: { select: { documentId: true, label: true } } } },
      },
    });
    if (!mail) throw new NotFoundException('Courrier introuvable');
    if (!restrictImputations || user?.isAdmin) return mail;

    const me = user?.userGroupId ?? null;
    if (me != null && (await this.isDestinataire(mail, me))) return mail;
    return {
      ...mail,
      inputations: mail.inputations.filter((i) => i.userId === me || i.createdBy === me),
    };
  }

  /**
   * Compteurs de badges de menu (§04.7). Endpoint AUTHENTIFIÉ (corrige l'autorisation désactivée de
   * la source) : sous MenuPermissionGuard, seul un utilisateur connecté peut les lire.
   */
  async badgeCounts(user: AuthUser): Promise<{
    controle: number;
    validation: number;
    suivi: number;
    parapheur: number;
    decharge: number;
    scans: number;
  }> {
    // Chaque badge compte EXACTEMENT ce que sa file affiche — un compteur portant sur des courriers
    // que l'utilisateur ne peut pas ouvrir serait un leurre. Le Suivi (§09) est donc soumis au
    // périmètre ; la Validation (§10), gardée par son seul menu, ne l'est pas.
    const scope = await this.mailScope(user);
    const suiviWhere: Prisma.MailWhereInput = {
      isDeleted: false,
      dateTraited: null,
      ...this.visibility(),
      ...(scope === 'imputed' ? { inputations: { some: { userId: user.userGroupId ?? -1 } } } : {}),
    };

    const [controle, validation, suivi, parapheur, decharge, scans] = await Promise.all([
      this.prisma.mail.count({ where: await this.controleWhere(user) }),
      this.prisma.mail.count({ where: { isDeleted: false, valider: true, dateTraited: null } }),
      scope === 'none' ? Promise.resolve(0) : this.prisma.mail.count({ where: suiviWhere }),
      // Parapheur (§08) : PERSONNEL, miroir exact de `listParapheur` — imputation actionnable non
      // traitée (« En Copie » exclu, il n'appelle aucun geste).
      this.prisma.mail.count({
        where: {
          isDeleted: false,
          ...this.visibility(),
          inputations: {
            some: {
              userId: user.userGroupId ?? -1,
              dateTreated: null,
              mailInputationTypeId: { not: MailInputationTypeId.EnCopie },
            },
          },
        },
      }),
      // Intégration décharge (§13) : miroir de `listDechargesEnAttente`, sans son `take: 200` —
      // un badge plafonné à 200 mentirait dès le 201ᵉ.
      this.prisma.mail.count({
        where: {
          isDeleted: false,
          mailType: MailType.Depart,
          documents: { none: { decharge: true } },
        },
      }),
      // Documents scannés (§07) : file d'ingestion, sans lien utilisateur ni périmètre.
      this.prisma.mailScannedDocument.count({ where: { isTraite: false } }),
    ]);
    return { controle, validation, suivi, parapheur, decharge, scans };
  }

  /**
   * Acteurs sélectionnables (destinataire §05, imputé §08) : un acteur = un `app_user_group`
   * (identité effective V6). Un même utilisateur peut apparaître pour plusieurs groupes, d'où le
   * libellé « Nom — Groupe » qui lève l'ambiguïté. Les comptes désactivés sont exclus. `roleId`
   * (§04 rôles applicatifs) permet au front de filtrer les acteurs imputables par rôle choisi
   * (imputation §08 : on sélectionne d'abord un rôle, puis un ou plusieurs de ses porteurs).
   */
  async listActors(): Promise<
    Array<{ userGroupId: number; label: string; roleId: number | null }>
  > {
    const rows = await this.prisma.appUserGroup.findMany({
      where: { user: { isDisabled: false } },
      select: {
        userGroupId: true,
        user: { select: { fullName: true, username: true, roleId: true } },
        group: { select: { name: true } },
      },
    });
    return rows
      .map((r) => {
        const person = r.user.fullName?.trim() || r.user.username;
        return {
          userGroupId: r.userGroupId,
          label: `${person} — ${r.group.name}`,
          roleId: r.user.roleId,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }

  /**
   * Rôles sélectionnables comme destinataire (§05) : au bureau d'ordre on adresse un courrier à une
   * fonction, pas à un individu. `userCount` sert à l'écran d'enregistrement — un rôle sans porteur
   * ne notifierait personne, autant le dire avant l'envoi plutôt que de laisser le courrier muet.
   *
   * Le rôle système est exclu : c'est un rôle technique (tous les menus, non supprimable) porté par
   * les comptes d'administration, pas une fonction du circuit courrier. Filtré sur `isSystem` et non
   * sur son libellé, qui est renommable.
   */
  async listDestinataireRoles(): Promise<
    Array<{ roleId: number; label: string; userCount: number }>
  > {
    const rows = await this.prisma.role.findMany({
      where: { isActive: true, isSystem: false },
      select: {
        roleId: true,
        name: true,
        _count: { select: { users: { where: { isDisabled: false } } } },
      },
    });
    return rows
      .map((r) => ({ roleId: r.roleId, label: r.name, userCount: r._count.users }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
  }

  /**
   * Acteurs à notifier pour un rôle : une entrée `app_user_group` par utilisateur actif le portant.
   * Une même personne peut appartenir à plusieurs groupes (donc porter plusieurs `app_user_group`) —
   * on ne retient que son identité par défaut, sinon elle recevrait le courrier en autant
   * d'exemplaires qu'elle a de groupes.
   */
  private async roleRecipients(roleId: number): Promise<number[]> {
    const rows = await this.prisma.appUserGroup.findMany({
      where: { user: { roleId, isDisabled: false } },
      orderBy: [{ isDefault: 'desc' }, { userGroupId: 'asc' }],
      select: { userGroupId: true, userId: true },
    });
    const byUser = new Map<number, number>();
    for (const r of rows) if (!byUser.has(r.userId)) byUser.set(r.userId, r.userGroupId);
    return [...byUser.values()];
  }

  /**
   * Destinataires effectifs d'un courrier : les porteurs du rôle (§05) ou l'acteur nommé (Départ
   * §12, courriers antérieurs au destinataire-rôle). Les deux colonnes s'excluent (CHECK
   * `ck_mail_destinataire`).
   */
  private async destinataireRecipients(mail: {
    destinataireExpediteur: number | null;
    destinataireRoleId: number | null;
  }): Promise<number[]> {
    if (mail.destinataireRoleId != null) return this.roleRecipients(mail.destinataireRoleId);
    return mail.destinataireExpediteur != null ? [mail.destinataireExpediteur] : [];
  }

  /** Notifie tous les destinataires d'un courrier (rôle ou acteur nommé). */
  private async notifyDestinataires(
    mail: {
      mailId: number;
      title: string;
      destinataireExpediteur: number | null;
      destinataireRoleId: number | null;
    },
    message: string,
    /** Objet de l'e-mail (§03.5) et teinte de sa bannière ; l'in-app n'en tient pas compte. */
    mailOpts?: { subject?: string; severity?: MailSeverity },
  ): Promise<void> {
    const recipients = await this.destinataireRecipients(mail);
    await this.notifications.createMany(
      recipients,
      message,
      { type: 'mail', id: mail.mailId },
      mailOpts,
    );
  }

  // ---- Numérotation NReference (§05/§19) -----------------------------------
  /** Aperçu du prochain n° d'enregistrement Arrivée (registre global, hors Départ). Lecture seule. */
  async previewNextArriveeReference(): Promise<string> {
    const rows = await this.prisma.mail.findMany({
      where: { mailType: { not: MailType.Depart }, nReference: { not: null } },
      select: { nReference: true },
    });
    return nextReference(rows.map((r) => r.nReference));
  }

  /** Aperçu du prochain n° Départ pour un type donné (numérotation par type, §19). Lecture seule. */
  async previewNextDepartReference(mailDepartTypeId: number): Promise<string> {
    const rows = await this.prisma.mail.findMany({
      where: { mailType: MailType.Depart, mailDepartTypeId, nReference: { not: null } },
      select: { nReference: true },
    });
    return nextReference(rows.map((r) => r.nReference));
  }

  // ---- Création (§05 Arrivée / §12 Départ) ---------------------------------
  async createArrivee(input: CreateArriveeInput, user: AuthUser) {
    const now = new Date();
    const organigrammeId = await this.deriveOrganigramme(input.destinataireRoleId);
    const actor = user.userGroupId;

    // §07 : l'écran d'enregistrement est ce qui transforme le scan en document GED. Hors
    // transaction — la promotion lit et écrit des binaires, à ne pas tenir dans une transaction SQL.
    const documentId =
      input.documentId ??
      (input.scannedDocumentId != null
        ? await this.scanned.promoteToDocument(input.scannedDocumentId, input.title, user)
        : null);

    const mail = await this.prisma.$transaction(async (tx) => {
      const nReference = input.nReference?.trim() || (await this.lockedArriveeRef(tx));
      const created = await tx.mail.create({
        data: {
          title: input.title,
          date: input.date,
          description: input.description ?? null,
          reference: input.reference ?? null,
          nReference,
          mailType: MailType.Arrivee,
          status: MailStatus.Redaction,
          dateEnregistrementCourrier: input.dateEnregistrementCourrier ?? now,
          dateFollowUp: input.dateFollowUp ?? null,
          dateButoire: input.dateButoire ?? null,
          destinataireExpediteur: null,
          destinataireRoleId: input.destinataireRoleId,
          mailNatureId: input.mailNatureId ?? null,
          confidentialiteId: input.confidentialiteId ?? null,
          externalEntityId: input.externalEntityId ?? null,
          mailObjetId: input.mailObjetId ?? null,
          organigrammeId,
          createdBy: actor,
        },
      });
      if (documentId != null) {
        await tx.mailDocument.create({
          data: {
            mailId: created.mailId,
            documentId,
            decharge: false,
            createdBy: actor,
          },
        });
      }
      if (input.scannedDocumentId != null) {
        await tx.mailScannedDocument.update({
          where: { mailScannedDocumentId: input.scannedDocumentId },
          data: { isTraite: true, mailId: created.mailId, documentId },
        });
      }
      // Imputations « En Copie » (type 17) DANS la transaction : l'enregistrement est atomique
      // (courrier + NReference + scan + imputations), sinon un échec partiel dupliquerait un NReference.
      const enCopie = [...new Set(input.enCopieUserGroupIds ?? [])];
      if (enCopie.length > 0) {
        await tx.mailInputation.createMany({
          data: enCopie.map((userId) => ({
            mailId: created.mailId,
            userId,
            mailInputationTypeId: MailInputationTypeId.EnCopie,
            createdBy: actor,
          })),
        });
      }
      return created;
    });

    // Docu-Flow W3 : événement « courrier arrivé », APRÈS commit, sans attente ni échec possible (champs structurés seulement).
    this.emitMailArrived(mail, documentId != null);

    // §05 : notification d'enregistrement (NotificationEnregistrementCourrierAsync). Aucun journal
    // de contrôle ici (émis par valider()). Le destinataire étant un rôle, « le » destinataire =
    // chacun de ses porteurs.
    //
    // DEUX messages distincts, comme la source : le destinataire doit agir sur le courrier, la
    // personne en copie est seulement informée. Les confondre ferait croire à cette dernière
    // qu'une prise en charge lui incombe.
    const target = { type: 'mail', id: mail.mailId };
    await this.notifications.createMany(
      await this.roleRecipients(input.destinataireRoleId),
      `Nouveau courrier enregistré : ${mail.title}`,
      target,
      { subject: 'Enregistrement de courrier' },
    );
    await this.notifications.createMany(
      input.enCopieUserGroupIds ?? [],
      `Courrier enregistré, vous êtes en copie : ${mail.title}`,
      target,
      { subject: 'Enregistrement en copie' },
    );
    return mail;
  }

  async createDepart(input: CreateDepartInput, user: AuthUser) {
    const now = new Date();
    const actor = user.userGroupId;
    const patch = markDepartRedige(now); // Rédigé + DateDecharge (date d'archivage du Départ)

    // §12 : le rédacteur d'un Départ en est l'émetteur, l'écran ne le demande plus. Le CHECK
    // `ck_mail_destinataire` exige qu'il soit posé (un Départ n'a pas de rôle destinataire) —
    // sans acteur effectif l'insertion échouerait en 500, d'où le 400 explicite.
    const emetteur = input.destinataireUserGroupId ?? actor;
    if (emetteur == null) {
      throw new BadRequestException("Aucun acteur effectif : impossible de déterminer l'émetteur");
    }

    // Promotion du scan HORS transaction, comme à l'enregistrement (§05) : elle écrit le binaire
    // sur disque, une opération non annulable par un rollback.
    const documentId =
      input.documentId ??
      (input.scannedDocumentId != null
        ? await this.scanned.promoteToDocument(input.scannedDocumentId, input.title, user)
        : null);

    const mail = await this.prisma.$transaction(async (tx) => {
      const nReference =
        input.nReference?.trim() ||
        (input.mailDepartTypeId != null
          ? await this.lockedDepartRef(tx, input.mailDepartTypeId)
          : null);
      const created = await tx.mail.create({
        data: {
          title: input.title,
          date: input.date,
          description: input.description ?? null,
          reference: input.reference ?? null,
          nReference,
          mailType: MailType.Depart,
          status: patch.status,
          dateDecharge: patch.dateDecharge ?? null,
          destinataireExpediteur: emetteur,
          externalEntityId: input.externalEntityId ?? null,
          confidentialiteId: input.confidentialiteId ?? null,
          mailDepartTypeId: input.mailDepartTypeId ?? null,
          mailParent: input.parentMailId ?? null,
          createdBy: actor,
        },
      });
      if (documentId != null) {
        await tx.mailDocument.create({
          data: {
            mailId: created.mailId,
            documentId,
            decharge: false,
            createdBy: actor,
          },
        });
      }
      if (input.scannedDocumentId != null) {
        await tx.mailScannedDocument.update({
          where: { mailScannedDocumentId: input.scannedDocumentId },
          data: { isTraite: true, mailId: created.mailId, documentId },
        });
      }
      if (input.parentMailId != null) {
        // §12 : la réponse est aussi rattachée au courrier PARENT — c'est ce qui permet de
        // retrouver, depuis le courrier d'origine, le départ qui y a répondu (onglet Fichiers).
        if (documentId != null) {
          await tx.mailDocument.upsert({
            where: { ux_mail_document: { mailId: input.parentMailId, documentId } },
            update: {},
            create: { mailId: input.parentMailId, documentId, decharge: false, createdBy: actor },
          });
        }
        // Réponse à un courrier parent : on l'archive (DateTraited).
        await tx.mail.update({ where: { mailId: input.parentMailId }, data: archiveEffect(now) });
      }
      return created;
    });

    // §12 : le Départ clôt le courrier auquel il répond — on prévient TOUS les acteurs de ce
    // courrier parent (destinataire + imputés), pas l'émetteur du Départ (qui vient d'agir).
    //
    // UNE seule notification couvre les deux faits (réponse créée + courrier clos) : ce sont les
    // deux faces du même événement, et les scinder enverrait deux e-mails au même public.
    //
    // Départ NON lié : aucun acteur à prévenir — personne n'était associé à ce courrier avant sa
    // création. On n'envoie donc rien (décision explicite, à revoir si un rôle de repli est défini).
    if (input.parentMailId != null) {
      const parent = await this.prisma.mail.findUnique({
        where: { mailId: input.parentMailId },
        select: { title: true, nReference: true },
      });
      await this.notifications.createMany(
        await this.mailAudience(input.parentMailId),
        `Courrier traité et archivé — réponse envoyée : ${parent?.title ?? mail.title}`,
        // Cible = le courrier PARENT : c'est celui que les acteurs connaissent, et son onglet
        // Fichiers contient désormais la réponse (rattachée à la création du Départ).
        { type: 'mail', id: input.parentMailId },
        {
          subject: 'Courrier traité et archivé',
          severity: 'success',
          emailBody:
            'Une réponse a été enregistrée pour ce courrier. Il est désormais traité définitivement et archivé.',
          extraDetails: [
            { label: 'Réponse (Départ)', value: mail.title },
            ...(mail.nReference ? [{ label: 'N° de la réponse', value: mail.nReference }] : []),
            { label: 'Rédigée par', value: await this.actorName(emetteur) },
            { label: "Date d'archivage", value: now.toLocaleString('fr-FR') },
          ],
        },
      );
    }
    return mail;
  }

  // ---- Transitions de drapeaux (§03.2) -------------------------------------
  /** Contrôle / validation bureau d'ordre (§06) : Valider=true + notification destinataire. */
  async valider(mailId: number, user: AuthUser) {
    const mail = await this.setFlags(mailId, { valider: true }, user);
    await this.notifyDestinataires(mail, `Courrier à imputer : ${mail.title}`, {
      subject: 'Courrier à imputer',
    });
    await this.log(mailId, MailActionCode.Controle, user.userGroupId, 'Contrôle courrier');
    return mail;
  }

  /**
   * Contrôle automatique (§06) : le bureau d'ordre ne valide plus à la main. Le courrier passe
   * Valider=true de lui-même dès que son destinataire principal l'impute — la première imputation
   * vaut prise en charge. No-op (silencieux) si le courrier est déjà validé, absent, ou si l'acteur
   * n'est pas destinataire : une imputation créée par un tiers ne doit pas court-circuiter le
   * contrôle.
   */
  async autoValiderOnImputation(mailId: number, user: AuthUser): Promise<boolean> {
    if (user.userGroupId == null) return false;
    const mail = await this.prisma.mail.findFirst({
      where: { mailId, isDeleted: false, valider: false },
      select: { destinataireExpediteur: true, destinataireRoleId: true },
    });
    if (!mail) return false;
    if (!(await this.isDestinataire(mail, user.userGroupId))) return false;
    await this.valider(mailId, user);
    return true;
  }

  /**
   * L'acteur est-il LE destinataire du courrier ? Destinataire-rôle (§05) : appartenance par le
   * rôle porté, et non par `roleRecipients` — celui-ci ne retient qu'un userGroup par utilisateur
   * (le défaut), ce qui exclurait à tort un acteur connecté sous un autre groupe.
   */
  private async isDestinataire(
    mail: { destinataireExpediteur: number | null; destinataireRoleId: number | null },
    userGroupId: number,
  ): Promise<boolean> {
    if (mail.destinataireRoleId != null) {
      const actor = await this.prisma.appUserGroup.findUnique({
        where: { userGroupId },
        select: { user: { select: { roleId: true } } },
      });
      return actor?.user.roleId === mail.destinataireRoleId;
    }
    return mail.destinataireExpediteur === userGroupId;
  }

  /** Décharge (§08) : Decharge=true (distinct du statut Déchargé). */
  async dechargeCourrier(mailId: number, user: AuthUser) {
    const mail = await this.setFlags(mailId, { decharge: true }, user);
    // Archivage définitif : la source le signale en rouge — c'est une action sans retour.
    await this.notifyDestinataires(mail, `Courrier déchargé : ${mail.title}`, {
      subject: 'Archivage définitif',
      severity: 'warn',
    });
    await this.log(mailId, MailActionCode.Decharge, user.userGroupId, 'Décharge courrier');
    return mail;
  }

  /** Transfert Guichet Unique / enregistrement réponse (§08). */
  async enregistrementReponse(mailId: number, user: AuthUser) {
    const mail = await this.setFlags(mailId, { enregistrementReponse: true }, user);
    await this.notifyDestinataires(mail, `Réponse enregistrée : ${mail.title}`, {
      subject: 'Transfert vers Guichet Unique',
    });
    await this.log(
      mailId,
      MailActionCode.EnregistrementReponse,
      user.userGroupId,
      'Enregistrement réponse',
    );
    return mail;
  }

  /**
   * Validation DG (§08) : ValidationDG=true + imputation « Pour Suivi » (type 10, +48 h). Le drapeau
   * et son imputation obligatoire sont écrits DANS une même transaction (sinon le courrier resterait
   * marqué validé sans imputation de suivi).
   */
  async validationDG(mailId: number, user: AuthUser) {
    const now = new Date();
    const current = await this.assertMailActive(mailId);
    const deadline = new Date(now.getTime() + POUR_SUIVI_DEADLINE_HOURS * 3600 * 1000);
    // Le destinataire pouvant être un rôle, « l'imputation du destinataire » en devient une par
    // porteur : le suivi doit incomber à quelqu'un, et rien ne désigne un porteur plutôt qu'un autre.
    const suivis = await this.destinataireRecipients(current);
    const mail = await this.prisma.$transaction(async (tx) => {
      const m = await tx.mail.update({
        where: { mailId },
        data: { validationDG: true, modifiedBy: user.userGroupId, modifiedAt: now },
      });
      if (suivis.length > 0) {
        await tx.mailInputation.createMany({
          data: suivis.map((userId) => ({
            mailId,
            userId,
            mailInputationTypeId: MailInputationTypeId.PourSuivi,
            deadline,
            createdBy: user.userGroupId,
          })),
        });
      }
      return m;
    });
    // UNE seule notification : la source en envoie deux à la même personne (branche if/else morte,
    // les deux variables étant toujours égales) — bug relevé à l'audit, non reproduit.
    await this.notifyDestinataires(mail, `Validation DG : ${mail.title}`, {
      subject: 'Validation DG',
      severity: 'success',
    });
    await this.log(mailId, MailActionCode.ValidationDG, user.userGroupId, 'Validation DG');
    return mail;
  }

  /**
   * Validation Direction en lot (§10) : ValidationDirection=true + notifications (destinataire +
   * imputés). C'est ici que le courrier est déclaré traité — comme « Marquer traité » (§08), ça
   * traite TOUTES ses imputations, sans quoi il resterait indéfiniment dans le parapheur personnel
   * de chacun de ses destinataires (§08 : n'y figurent que les imputations non traitées).
   *
   * Écart ASSUMÉ avec l'application source, qui ne bascule que `ValidationDirection` : chez elle le
   * courrier validé reste non traité, donc visible sans fin au Suivi et dans les parapheurs. Ne pas
   * « corriger » en s'alignant sur la source sans rouvrir cette décision.
   */
  async validationDirection(mailIds: number[], user: AuthUser): Promise<{ updated: number }> {
    const now = new Date();
    const res = await this.prisma.mail.updateMany({
      where: { mailId: { in: mailIds }, isDeleted: false },
      data: {
        validationDirection: true,
        status: MailStatus.Traite,
        dateTraited: now,
        modifiedBy: user.userGroupId,
        modifiedAt: now,
      },
    });
    await this.prisma.mailInputation.updateMany({
      where: { mailId: { in: mailIds }, dateTreated: null },
      data: { dateTreated: now },
    });
    const mails = await this.prisma.mail.findMany({
      where: { mailId: { in: mailIds }, isDeleted: false },
      select: {
        mailId: true,
        title: true,
        destinataireExpediteur: true,
        destinataireRoleId: true,
        // Le TYPE distingue « en copie » (17) des imputations actives : le message annonce à
        // chacun à quel titre il est concerné.
        inputations: { select: { userId: true, mailInputationTypeId: true } },
      },
    });
    const validateur =
      user.userGroupId != null ? await this.actorName(user.userGroupId) : 'la Direction';
    await Promise.all(mails.map((m) => this.notifyValidationDirection(m, validateur, now)));
    return { updated: res.count };
  }

  /**
   * Notifie la validation Direction (§10) en annonçant à chacun À QUEL TITRE il est concerné :
   * destinataire principal, personne en copie, ou personne imputée. Un même acteur pouvant cumuler
   * ces rôles, il est classé UNE fois selon la priorité destinataire > copie > imputé — sans quoi
   * il recevrait plusieurs e-mails contradictoires pour un seul courrier.
   */
  private async notifyValidationDirection(
    mail: {
      mailId: number;
      title: string;
      destinataireExpediteur: number | null;
      destinataireRoleId: number | null;
      inputations: { userId: number; mailInputationTypeId: number }[];
    },
    validateur: string,
    now: Date,
  ): Promise<void> {
    const destinataires = await this.destinataireRecipients(mail);
    const enCopie = mail.inputations
      .filter((i) => i.mailInputationTypeId === MailInputationTypeId.EnCopie)
      .map((i) => i.userId);
    const imputes = mail.inputations.map((i) => i.userId);

    // Premier rôle rencontré = rôle retenu, l'ordre des groupes portant la priorité.
    const attribue = new Set<number>();
    const prendre = (ids: readonly number[]): number[] => {
      const retenus: number[] = [];
      for (const id of ids) {
        if (attribue.has(id)) continue;
        attribue.add(id);
        retenus.push(id);
      }
      return retenus;
    };

    const groupes: Array<[number[], string]> = [
      [prendre(destinataires), 'destinataire principal'],
      [prendre(enCopie), 'personne en copie'],
      [prendre(imputes), 'personne imputée'],
    ];

    const extraDetails = [
      { label: 'Validé par', value: validateur, strong: true },
      { label: 'Date de validation', value: now.toLocaleString('fr-FR') },
    ];

    await Promise.all(
      groupes
        .filter(([ids]) => ids.length > 0)
        .map(([ids, role]) =>
          this.notifications.createMany(
            ids,
            // In-app : court et autoportant, la cloche n'affiche qu'une ligne.
            `Validation Direction : ${mail.title}`,
            { type: 'mail', id: mail.mailId },
            {
              subject: 'Validation Direction',
              severity: 'success',
              // E-mail : phrase complète. Le titre et l'objet figurent déjà ailleurs dans le
              // gabarit, les répéter ici alourdirait pour rien.
              emailBody: `Le courrier auquel vous êtes associé en tant que ${role} a été validé par la Direction.`,
              extraDetails,
            },
          ),
        ),
    );
  }

  /** Nom lisible d'un acteur, pour les libellés de notification. */
  private async actorName(userGroupId: number | null): Promise<string> {
    // `null` = compte sans identité effective : un libellé neutre vaut mieux qu'une ligne vide
    // dans l'e-mail (ou qu'un plantage de la notification).
    if (userGroupId == null) return 'le service courrier';
    const row = await this.prisma.appUserGroup
      .findUnique({
        where: { userGroupId },
        select: { user: { select: { fullName: true, username: true } } },
      })
      .catch(() => null);
    return row?.user.fullName?.trim() || row?.user.username || 'le service courrier';
  }

  /** Archivage service courrier (§03.1) : DateTraited=now, statut inchangé. */
  async archiver(mailId: number, user: AuthUser) {
    const now = new Date();
    const mail = await this.updateMail(mailId, {
      ...archiveEffect(now),
      modifiedBy: user.userGroupId,
      modifiedAt: now,
    });
    await this.notifyDestinataires(mail, `Courrier archivé : ${mail.title}`, {
      subject: 'Courrier archivé',
    });
    return mail;
  }

  /**
   * Intégration de la décharge signée (§13) : rattache le document (decharge=true), passe le
   * courrier en Déchargé (+DateDecharge) puis l'archive (+DateTraited) — le tout en transaction.
   */
  async integrateDecharge(
    mailId: number,
    input: { documentId?: number | null; scannedDocumentId?: number | null },
    user: AuthUser,
  ) {
    const now = new Date();
    const actor = user.userGroupId;
    const target = await this.assertMailActive(mailId);
    // Le PDF de décharge entre par la file §07 comme tout binaire du flux courrier : on le promeut
    // en document GED avant de le rattacher (même chemin qu'à la création d'un Départ, §12).
    const documentId =
      input.documentId ??
      (input.scannedDocumentId != null
        ? await this.scanned.promoteToDocument(
            input.scannedDocumentId,
            `Décharge — ${target.title}`,
            user,
          )
        : null);
    if (documentId == null) {
      throw new BadRequestException('Aucun document de décharge fourni');
    }
    const mail = await this.prisma.$transaction(async (tx) => {
      await tx.mailDocument.upsert({
        where: { ux_mail_document: { mailId, documentId } },
        update: { decharge: true },
        create: { mailId, documentId, decharge: true, createdBy: actor },
      });
      const data: Prisma.MailUncheckedUpdateInput = {
        ...markDecharge(now), // Déchargé + DateDecharge
        ...archiveEffect(now),
        modifiedBy: actor,
        modifiedAt: now,
      };
      const m = await tx.mail.update({ where: { mailId }, data });
      // §13 : le document de décharge est aussi rattaché au courrier PARENT, le cas échéant.
      if (m.mailParent != null) {
        await tx.mailDocument.upsert({
          where: { ux_mail_document: { mailId: m.mailParent, documentId } },
          update: { decharge: true },
          create: { mailId: m.mailParent, documentId, decharge: true, createdBy: actor },
        });
      }
      // Le scan quitte la file §07 : sans ça il resterait indéfiniment « en attente ».
      if (input.scannedDocumentId != null) {
        await tx.mailScannedDocument.update({
          where: { mailScannedDocumentId: input.scannedDocumentId },
          data: { isTraite: true, mailId, documentId },
        });
      }
      return m;
    });
    await this.notifyDestinataires(mail, `Décharge intégrée : ${mail.title}`, {
      subject: 'Décharge intégrée',
      severity: 'success',
    });

    // §13 : la décharge clôt l'échange. Si ce Départ répondait à un courrier, ses acteurs
    // (destinataire + imputés) doivent savoir que la remise est prouvée — sans quoi ils resteraient
    // sur « réponse envoyée » sans jamais apprendre qu'elle a bien été reçue.
    //
    // Départ sans courrier parent : aucun acteur en amont, on ne notifie que son destinataire
    // (ci-dessus). Décision explicite, à revoir si un rôle de repli est défini.
    if (mail.mailParent != null) {
      const parent = await this.prisma.mail.findUnique({
        where: { mailId: mail.mailParent },
        select: { title: true },
      });
      await this.notifications.createMany(
        await this.mailAudience(mail.mailParent),
        `Décharge reçue — échange clos : ${parent?.title ?? mail.title}`,
        { type: 'mail', id: mail.mailParent },
        {
          subject: 'Décharge reçue',
          severity: 'success',
          emailBody:
            'La preuve de remise de la réponse a été intégrée : cet échange est désormais clos.',
          extraDetails: [
            { label: 'Réponse (Départ)', value: mail.title },
            { label: 'Décharge intégrée par', value: await this.actorName(actor) },
            { label: "Date d'intégration", value: now.toLocaleString('fr-FR') },
          ],
        },
      );
    }
    await this.log(mailId, MailActionCode.Decharge, actor, 'Intégration décharge');
    return mail;
  }

  /**
   * Suppression logique (§03.1) : la source pilote la suppression par is_deleted uniquement (le
   * statut Supprimé n'est jamais affecté). On reste fidèle : is_deleted=true, statut inchangé.
   */
  async softDelete(mailId: number, user: AuthUser) {
    return this.updateMail(mailId, {
      isDeleted: true,
      modifiedBy: user.userGroupId,
      modifiedAt: new Date(),
    });
  }

  // ---- Helpers privés -------------------------------------------------------
  private visibility(): Prisma.MailWhereInput {
    // Un Arrivée reste visible même en Redaction ; les autres types uniquement hors Redaction.
    return { OR: [{ status: { not: MailStatus.Redaction } }, { mailType: MailType.Arrivee }] };
  }

  private async paginate(
    where: Prisma.MailWhereInput,
    opts?: { page?: number; pageSize?: number },
  ): Promise<MailListResult> {
    const page = Math.max(1, opts?.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, opts?.pageSize ?? 25));
    const [total, rows] = await Promise.all([
      this.prisma.mail.count({ where }),
      this.prisma.mail.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: LIST_SELECT,
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  /**
   * Organigramme du courrier = celui du rôle destinataire (§05). Le rôle étant désormais choisi
   * directement, la chaîne app_user_group → app_user → role disparaît. Rôle inconnu/inactif = 400 :
   * sans ce contrôle la FK échouerait en 500 à l'insertion.
   */
  private async deriveOrganigramme(destinataireRoleId: number): Promise<number | null> {
    const role = await this.prisma.role.findFirst({
      where: { roleId: destinataireRoleId, isActive: true },
      select: { organigrammeId: true },
    });
    if (!role) throw new BadRequestException('Rôle destinataire introuvable ou inactif');
    return resolveOrganigrammeId(role.organigrammeId);
  }

  private async lockedArriveeRef(tx: Prisma.TransactionClient): Promise<string> {
    // $executeRaw (et NON $queryRaw) : pg_advisory_xact_lock() renvoie `void`, que $queryRaw
    // tente de désérialiser → « Failed to deserialize column of type 'void' ».
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NREF_ARRIVEE_LOCK}::bigint)`;
    const rows = await tx.mail.findMany({
      where: { mailType: { not: MailType.Depart }, nReference: { not: null } },
      select: { nReference: true },
    });
    return nextReference(rows.map((r) => r.nReference));
  }

  private async lockedDepartRef(
    tx: Prisma.TransactionClient,
    mailDepartTypeId: number,
  ): Promise<string> {
    // $executeRaw : idem, la fonction de verrou renvoie `void` (cf. lockedArriveeRef).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NREF_DEPART_NAMESPACE}::int, ${mailDepartTypeId}::int)`;
    const rows = await tx.mail.findMany({
      where: { mailType: MailType.Depart, mailDepartTypeId, nReference: { not: null } },
      select: { nReference: true },
    });
    return nextReference(rows.map((r) => r.nReference));
  }

  private async setFlags(
    mailId: number,
    flags: Prisma.MailUncheckedUpdateInput,
    user: AuthUser,
    now: Date = new Date(),
  ) {
    return this.updateMail(mailId, { ...flags, modifiedBy: user.userGroupId, modifiedAt: now });
  }

  /** Vérifie que le courrier existe et n'est pas supprimé, et renvoie de quoi résoudre ses destinataires. */
  private async assertMailActive(mailId: number): Promise<{
    title: string;
    destinataireExpediteur: number | null;
    destinataireRoleId: number | null;
  }> {
    const exists = await this.prisma.mail.findFirst({
      where: { mailId, isDeleted: false },
      select: { title: true, destinataireExpediteur: true, destinataireRoleId: true },
    });
    if (!exists) throw new NotFoundException('Courrier introuvable');
    return exists;
  }

  private async updateMail(mailId: number, data: Prisma.MailUncheckedUpdateInput) {
    await this.assertMailActive(mailId);
    return this.prisma.mail.update({ where: { mailId }, data });
  }

  /** Audience de notification d'un courrier : destinataires + utilisateurs imputés (dédoublonnés). */
  private async mailAudience(mailId: number): Promise<number[]> {
    const mail = await this.prisma.mail.findUnique({
      where: { mailId },
      select: {
        destinataireExpediteur: true,
        destinataireRoleId: true,
        inputations: { select: { userId: true } },
      },
    });
    if (!mail) return [];
    return [...(await this.destinataireRecipients(mail)), ...mail.inputations.map((i) => i.userId)];
  }

  private async notify(
    recipientUserGroupId: number | null,
    message: string,
    mailId: number,
  ): Promise<void> {
    if (recipientUserGroupId == null) return;
    await this.notifications.create({
      recipientUserGroupId,
      message,
      targetType: 'mail',
      targetId: mailId,
    });
  }

  private async log(
    mailId: number,
    actionCode: number,
    userGroupId: number | null,
    details: string,
  ): Promise<void> {
    await this.prisma.mailActionLog.create({ data: { mailId, actionCode, userGroupId, details } });
  }
}
