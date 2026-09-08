import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MailInputationTypeId } from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthUser } from '../auth/auth.types';
import { MailsService } from './mails.service';
import type { MailDetailRow, MailSeverity } from '../notifications/email.service';
import {
  computeAutomaticValidation,
  computeManualTreatment,
  type InputationView,
  type TreatmentResult,
} from './domain';

/** Échéance par défaut d'une imputation de validation (§08 : Deadline = +48 h). */
const VALIDATION_DEADLINE_HOURS = 48;

export interface CreateInputationInput {
  mailId: number;
  userGroupId: number;
  mailInputationTypeId: number;
  instructions?: string | null;
  deadline?: Date | null;
}

@Injectable()
export class MailInputationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly mails: MailsService,
  ) {}

  private actorId(user: AuthUser): number | null {
    return user.userGroupId;
  }

  /**
   * Crée une imputation (§08 AddImputation) + notifie l'agent imputé (`ImputationAssigneeAsync`).
   * Le contrôle bureau d'ordre (§06) s'ensuit automatiquement quand c'est le destinataire principal
   * qui impute : il n'y a plus de bouton « Valider » côté interface.
   */
  async create(input: CreateInputationInput, user: AuthUser) {
    const row = await this.createRow(input, user);
    await this.mails.autoValiderOnImputation(input.mailId, user);

    // L'e-mail porte ce que l'imputé doit savoir pour agir : qui l'impute, à quel titre, pour
    // quand et avec quelles consignes. Sans ça il devrait ouvrir l'application pour le découvrir.
    const [titre, typeLabel, auteur] = await Promise.all([
      this.mailTitle(input.mailId),
      this.inputationTypeLabel(input.mailInputationTypeId),
      user.userGroupId != null ? this.actorName(user.userGroupId) : Promise.resolve(null),
    ]);
    const extraDetails = [
      ...(typeLabel ? [{ label: "Type d'imputation", value: typeLabel }] : []),
      ...(auteur ? [{ label: 'Imputé par', value: auteur }] : []),
      // L'échéance est mise en évidence : c'est l'information qui engage le destinataire.
      ...(input.deadline
        ? [{ label: 'Échéance', value: input.deadline.toLocaleString('fr-FR'), strong: true }]
        : []),
      ...(input.instructions?.trim()
        ? [{ label: 'Instructions', value: input.instructions.trim() }]
        : []),
    ];

    await this.notify(input.userGroupId, `Courrier imputé : ${titre}`, input.mailId, {
      subject: 'Courrier imputé',
      extraDetails,
    });
    return row;
  }

  /** Libellé du type d'imputation — le détail ne renvoie que son identifiant. */
  private async inputationTypeLabel(mailInputationTypeId: number): Promise<string | null> {
    const row = await this.prisma.mailInputationType
      .findUnique({ where: { mailInputationTypeId }, select: { label: true } })
      .catch(() => null);
    return row?.label ?? null;
  }

  /**
   * Imputation de validation (§08) : type 5 (DG) ou 14 (Direction), échéance +48 h. Notifie le
   * valideur (`SoumissionValidationAsync`) — notification distincte de l'imputation ordinaire.
   */
  async createValidation(
    mailId: number,
    userGroupId: number,
    isDG: boolean,
    user: AuthUser,
    now: Date,
  ) {
    const row = await this.createRow(
      {
        mailId,
        userGroupId,
        mailInputationTypeId: isDG
          ? MailInputationTypeId.ValidationDG
          : MailInputationTypeId.ValidationDirection,
        deadline: this.deadlineFrom(now),
      },
      user,
    );
    const cible = isDG ? 'DG' : 'Direction';
    await this.notify(
      userGroupId,
      `Soumission à validation ${cible} : ${await this.mailTitle(mailId)}`,
      mailId,
      { subject: `Soumission pour validation ${cible}` },
    );
    return row;
  }

  /**
   * Validation automatique à la lecture (§03.1) : traite les imputations de type `suivi==true` et,
   * si toutes sont alors traitées, bascule le courrier en Traité. Appliqué en transaction.
   */
  async treatOnRead(mailId: number, now: Date): Promise<TreatmentResult> {
    const views = await this.loadViews(mailId);
    const result = computeAutomaticValidation(views, now);
    await this.applyTreatment(mailId, result, now);
    return result;
  }

  /** « Marquer comme traité » manuel (§08) : traite toutes les imputations puis Traité. */
  async markTreated(mailId: number, now: Date): Promise<TreatmentResult> {
    const views = await this.loadViews(mailId);
    const result = computeManualTreatment(views, now);
    await this.applyTreatment(mailId, result, now);
    return result;
  }

  /**
   * Marque traitées les imputations d'un destinataire donné (validation en masse §10) sans forcer
   * le statut ; renvoie le nombre d'imputations concernées.
   */
  async markRecipientTreated(
    mailId: number,
    userGroupId: number,
    now: Date,
  ): Promise<{ treated: number }> {
    // Les AUTEURS des imputations sont lus AVANT la mise à jour : après, le filtre
    // `dateTreated: null` ne rendrait plus rien et personne ne serait prévenu.
    const concernees = await this.prisma.mailInputation.findMany({
      where: { mailId, userId: userGroupId, dateTreated: null },
      select: { createdBy: true, type: { select: { label: true } } },
    });
    const res = await this.prisma.mailInputation.updateMany({
      where: { mailId, userId: userGroupId, dateTreated: null },
      data: { dateTreated: now },
    });
    if (res.count > 0) await this.notifyImputationTreated(mailId, userGroupId, concernees, now);
    return { treated: res.count };
  }

  /**
   * Prévient le ou les AUTEURS des imputations qu'elles ont été traitées (§08
   * `ImputationTraiteeAsync`) : celui qui délègue doit savoir que le travail est fait, sans avoir
   * à surveiller le courrier. Une notification par auteur distinct — s'il s'est imputé lui-même,
   * il ne reçoit rien (il vient d'agir).
   */
  private async notifyImputationTreated(
    mailId: number,
    traiteurUserGroupId: number,
    imputations: readonly { createdBy: number | null; type: { label: string } | null }[],
    now: Date,
  ): Promise<void> {
    const auteurs = [
      ...new Set(
        imputations
          .map((i) => i.createdBy)
          .filter((id): id is number => id != null && id !== traiteurUserGroupId),
      ),
    ];
    if (auteurs.length === 0) return;

    const [titre, traiteur] = await Promise.all([
      this.mailTitle(mailId),
      this.actorName(traiteurUserGroupId),
    ]);
    const types = [...new Set(imputations.map((i) => i.type?.label).filter(Boolean))].join(', ');

    await this.notifications.createMany(
      auteurs,
      `Imputation traitée par ${traiteur} : ${titre}`,
      { type: 'mail', id: mailId },
      {
        subject: 'Imputation traitée',
        severity: 'success',
        extraDetails: [
          ...(types ? [{ label: "Type d'imputation", value: types }] : []),
          { label: 'Traitée par', value: traiteur, strong: true },
          { label: 'Date de traitement', value: now.toLocaleString('fr-FR') },
        ],
      },
    );
  }

  /** Nom lisible d'un acteur, pour les libellés de notification. */
  private async actorName(userGroupId: number): Promise<string> {
    const row = await this.prisma.appUserGroup
      .findUnique({
        where: { userGroupId },
        select: { user: { select: { fullName: true, username: true } } },
      })
      .catch(() => null);
    return row?.user.fullName?.trim() || row?.user.username || `Acteur ${userGroupId}`;
  }

  /**
   * Supprime une imputation — réservé à son auteur (`createdBy`) : celui qui a imputé un courrier
   * est seul à pouvoir revenir dessus, pas le destinataire ni un tiers.
   */
  async remove(mailInputationId: number, user: AuthUser): Promise<{ deleted: true }> {
    const row = await this.prisma.mailInputation.findUnique({
      where: { mailInputationId },
      select: { createdBy: true },
    });
    if (!row) throw new NotFoundException('Imputation introuvable');
    if (row.createdBy == null || row.createdBy !== user.userGroupId) {
      throw new ForbiddenException("Seul l'auteur de l'imputation peut la supprimer");
    }
    await this.prisma.mailInputation.delete({ where: { mailInputationId } });
    return { deleted: true };
  }

  private createRow(input: CreateInputationInput, user: AuthUser) {
    return this.prisma.mailInputation.create({
      data: {
        mailId: input.mailId,
        userId: input.userGroupId,
        mailInputationTypeId: input.mailInputationTypeId,
        instructions: input.instructions ?? null,
        deadline: input.deadline ?? null,
        createdBy: this.actorId(user),
      },
    });
  }

  /** Objet du courrier, pour le libellé de notification. */
  private async mailTitle(mailId: number): Promise<string> {
    const mail = await this.prisma.mail.findUnique({
      where: { mailId },
      select: { title: true },
    });
    return mail?.title ?? `#${mailId}`;
  }

  private async notify(
    recipientUserGroupId: number,
    message: string,
    mailId: number,
    mailOpts?: { subject?: string; severity?: MailSeverity; extraDetails?: MailDetailRow[] },
  ): Promise<void> {
    await this.notifications.create({
      recipientUserGroupId,
      message,
      targetType: 'mail',
      targetId: mailId,
      ...mailOpts,
    });
  }

  private deadlineFrom(now: Date): Date {
    return new Date(now.getTime() + VALIDATION_DEADLINE_HOURS * 3600 * 1000);
  }

  private async loadViews(mailId: number): Promise<InputationView[]> {
    const rows = await this.prisma.mailInputation.findMany({
      where: { mailId },
      select: { mailInputationId: true, dateTreated: true, type: { select: { suivi: true } } },
    });
    return rows.map((r) => ({
      mailInputationId: r.mailInputationId,
      dateTreated: r.dateTreated,
      suivi: r.type.suivi,
    }));
  }

  private async applyTreatment(mailId: number, result: TreatmentResult, now: Date): Promise<void> {
    if (result.inputationsToTreat.length === 0 && !result.mailPatch) return;
    await this.prisma.$transaction(async (tx) => {
      if (result.inputationsToTreat.length > 0) {
        await tx.mailInputation.updateMany({
          where: { mailInputationId: { in: result.inputationsToTreat } },
          data: { dateTreated: now },
        });
      }
      if (result.mailPatch) {
        await tx.mail.update({ where: { mailId }, data: result.mailPatch });
      }
    });
  }
}
