import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService, type MailDetailRow, type MailSeverity } from './email.service';

/** Entrée de création d'une notification in-app (§03.5). */
export interface CreateNotificationInput {
  recipientUserGroupId: number;
  message: string;
  targetType?: string | null;
  targetId?: number | null;
  /** Objet de l'e-mail et titre de sa bannière ; à défaut le message lui-même. */
  subject?: string;
  severity?: MailSeverity;
  /**
   * Corps de l'e-mail, quand il doit différer du message in-app. Les deux canaux n'ont pas les
   * mêmes contraintes : la cloche impose une ligne courte et autoportante, l'e-mail affiche déjà
   * le titre et le tableau de détails — y répéter l'objet le rend redondant.
   */
  emailBody?: string;
  /**
   * Lignes ajoutées au tableau de détails de l'e-mail, APRÈS celles du courrier — pour ce que
   * seul l'appelant connaît (type d'imputation, échéance, instructions…).
   */
  extraDetails?: MailDetailRow[];
}

/** Écran à ouvrir depuis l'e-mail, par type de cible. */
const TARGET_LINK: Record<string, (id: number) => string> = {
  mail: (id) => `/courriers/suivi/${id}`,
  document: (id) => `/editeur/${id}`,
};

export interface NotificationRow {
  notificationId: number;
  message: string;
  targetType: string | null;
  targetId: number | null;
  isRead: boolean;
  createdAt: Date;
  readAt: Date | null;
}

export interface NotificationList {
  total: number;
  unread: number;
  page: number;
  pageSize: number;
  rows: NotificationRow[];
}

/**
 * Notifications (brique transverse, aucun équivalent V6 avant Docu-Courriers). DOUBLE CANAL
 * (§03.5) : inbox in-app (+ badges par polling) ET e-mail. Tous les points de notification du
 * module courrier passent par `create`/`createMany` — c'est donc ici, et nulle part ailleurs, que
 * le canal e-mail se greffe.
 *
 * L'e-mail part APRÈS l'écriture in-app et sans être attendu : c'est la notification in-app qui
 * fait foi, l'e-mail est un doublon de confort. Une messagerie lente ou en panne ne doit ni
 * ralentir ni faire échouer l'action métier (enregistrement, imputation, validation…).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** Crée une notification pour un acteur (app_user_group). Silencieux si recipient est null. */
  async create(input: CreateNotificationInput) {
    const row = await this.prisma.notification.create({
      data: {
        recipientUserGroupId: input.recipientUserGroupId,
        message: input.message,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
      },
    });
    this.dispatchEmails([input.recipientUserGroupId], input);
    return row;
  }

  /** Crée la même notification pour plusieurs destinataires (dédoublonnés, non nuls). */
  async createMany(
    recipientUserGroupIds: readonly (number | null | undefined)[],
    message: string,
    target?: { type: string; id: number },
    opts?: {
      subject?: string;
      severity?: MailSeverity;
      extraDetails?: MailDetailRow[];
      emailBody?: string;
    },
  ) {
    const ids = [...new Set(recipientUserGroupIds.filter((id): id is number => id != null))];
    if (ids.length === 0) return { count: 0 };
    const res = await this.prisma.notification.createMany({
      data: ids.map((recipientUserGroupId) => ({
        recipientUserGroupId,
        message,
        targetType: target?.type ?? null,
        targetId: target?.id ?? null,
      })),
    });
    this.dispatchEmails(ids, {
      message,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      ...opts,
    });
    return res;
  }

  /**
   * Envoi e-mail en tâche de fond (volontairement pas `await`é par les appelants métier).
   * Toute erreur est capturée ici : `void` sur une promesse rejetée ferait tomber le process en
   * `unhandledRejection`, ce qu'une notification ne doit jamais provoquer.
   */
  private dispatchEmails(
    recipientUserGroupIds: readonly number[],
    input: Omit<CreateNotificationInput, 'recipientUserGroupId'>,
  ): void {
    if (!this.email.enabled || recipientUserGroupIds.length === 0) return;
    void this.sendEmails(recipientUserGroupIds, input).catch((e) => {
      this.logger.warn(
        `Notification e-mail abandonnée : ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  private async sendEmails(
    recipientUserGroupIds: readonly number[],
    input: Omit<CreateNotificationInput, 'recipientUserGroupId'>,
  ): Promise<void> {
    // Une personne portant plusieurs `app_user_group` ne doit pas recevoir le même e-mail en
    // plusieurs exemplaires : on dédoublonne par ADRESSE, pas par acteur. Le NOM est conservé pour
    // la civilité de l'e-mail (« À l'attention de … »).
    const rows = await this.prisma.appUserGroup.findMany({
      where: { userGroupId: { in: [...recipientUserGroupIds] }, user: { isDisabled: false } },
      select: { user: { select: { email: true, fullName: true, username: true } } },
    });
    const byAddress = new Map<string, string>();
    for (const r of rows) {
      const email = r.user.email?.trim();
      if (email && !byAddress.has(email)) {
        byAddress.set(email, r.user.fullName?.trim() || r.user.username);
      }
    }
    if (byAddress.size === 0) return;

    const link =
      input.targetType && input.targetId != null
        ? (TARGET_LINK[input.targetType]?.(input.targetId) ?? null)
        : null;

    // Tableau de détails : une requête, partagée par tous les destinataires du même message.
    // Les lignes propres à l'appelant (imputation…) viennent APRÈS celles du courrier.
    const details = [
      ...(input.targetType === 'mail' && input.targetId != null
        ? await this.mailDetails(input.targetId)
        : []),
      ...(input.extraDetails ?? []),
    ];

    const title = input.subject ?? 'Notification';
    await Promise.all(
      [...byAddress].map(([to, recipientName]) =>
        this.email.send({
          to,
          subject: `${title}${details.length ? ` — ${details[0]?.value ?? ''}` : ''}`.trim(),
          title,
          recipientName,
          body: input.emailBody ?? input.message,
          severity: input.severity,
          details,
          link,
        }),
      ),
    );
  }

  /**
   * Détails du courrier affichés dans l'e-mail (objet, référence, dates, correspondant…).
   * Reproduit le tableau « DÉTAILS DU COURRIER » du source. Les lignes vides sont omises plutôt
   * qu'affichées avec un tiret : un tableau clairsemé se lit moins bien qu'un tableau court.
   */
  private async mailDetails(mailId: number): Promise<MailDetailRow[]> {
    try {
      return await this.buildMailDetails(mailId);
    } catch {
      // Les détails ne sont qu'un enrichissement : leur échec ne doit pas priver le destinataire
      // de l'e-mail lui-même, qui porte déjà l'essentiel dans son message.
      return [];
    }
  }

  private async buildMailDetails(mailId: number): Promise<MailDetailRow[]> {
    const mail = await this.prisma.mail
      .findUnique({
        where: { mailId },
        select: {
          title: true,
          nReference: true,
          reference: true,
          date: true,
          dateButoire: true,
          description: true,
          externalEntity: { select: { label: true } },
          destinataireRole: { select: { name: true } },
          destinataire: { select: { user: { select: { fullName: true, username: true } } } },
        },
      })
      .catch(() => null);
    if (!mail) return [];

    const fmt = (d: Date | null) => (d ? d.toLocaleDateString('fr-FR') : null);
    const destinataire =
      mail.destinataireRole?.name ??
      mail.destinataire?.user.fullName?.trim() ??
      mail.destinataire?.user.username ??
      null;

    const rows: Array<[string, string | null, boolean?]> = [
      ['Objet', mail.title],
      ['Référence', mail.nReference, true],
      ['Date du courrier', fmt(mail.date)],
      ['Correspondant', mail.externalEntity?.label ?? null],
      ['Destinataire', destinataire],
      ['N° d’origine', mail.reference],
      ['Échéance', fmt(mail.dateButoire)],
      ['Résumé', mail.description],
    ];
    return rows
      .filter((r): r is [string, string, boolean?] => !!r[1]?.trim())
      .map(([label, value, strong]) => ({ label, value, strong }));
  }

  /** Nombre de notifications non lues d'un acteur — badge. */
  async unreadCount(userGroupId: number): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientUserGroupId: userGroupId, isRead: false },
    });
  }

  /** Inbox paginée d'un acteur, avec compteur non lus. */
  async list(
    userGroupId: number,
    opts: { unreadOnly?: boolean; page?: number; pageSize?: number } = {},
  ): Promise<NotificationList> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const where = {
      recipientUserGroupId: userGroupId,
      ...(opts.unreadOnly ? { isRead: false } : {}),
    };
    const [total, unread, rows] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.unreadCount(userGroupId),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          notificationId: true,
          message: true,
          targetType: true,
          targetId: true,
          isRead: true,
          createdAt: true,
          readAt: true,
        },
      }),
    ]);
    return { total, unread, page, pageSize, rows };
  }

  /** Marque une notification lue — restreint au propriétaire (aucune fuite inter-acteurs). */
  async markRead(
    notificationId: number,
    userGroupId: number,
    now: Date,
  ): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { notificationId, recipientUserGroupId: userGroupId, isRead: false },
      data: { isRead: true, readAt: now },
    });
    return { updated: res.count };
  }

  /** Marque toutes les notifications de l'acteur comme lues. */
  async markAllRead(userGroupId: number, now: Date): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { recipientUserGroupId: userGroupId, isRead: false },
      data: { isRead: true, readAt: now },
    });
    return { updated: res.count };
  }
}
