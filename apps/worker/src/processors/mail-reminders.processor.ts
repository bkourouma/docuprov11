// Jobs de rappel Docu-Courriers (§03.5) — remplacent les RecurringJob Hangfire du source.
// Livraison DOUBLE CANAL, comme les notifications d'action côté API : in-app + e-mail.
import type { PrismaClient } from '@prisma/client';
import type { Mailer, MailDetailRow, MailSeverity } from '@archivage/mailer';
import {
  dateButoireAlert,
  dateButoireMessage,
  daysUntil,
  inputationReminderMessage,
  shouldRemindInputation,
} from '../domain/mail-reminders';

export interface ReminderEnv {
  /** Fenêtre d'alerte avant échéance d'imputation, en heures (`DelaisAlerte`, défaut 48). */
  delaisAlerteHours: number;
  /** Intervalle minimal entre deux relances, en heures (`DelaisAlerteInterval`, défaut 6). */
  delaisAlerteIntervalHours: number;
}

export interface ReminderResult {
  scanned: number;
  notified: number;
}

/** Notification écrite en base, telle qu'on la duplique ensuite par e-mail. */
interface NotificationRow {
  recipientUserGroupId: number;
  message: string;
  targetType: string;
  targetId: number;
}

/**
 * Détails « courrier » du gabarit e-mail, par mailId. Miroir de `NotificationsService.mailDetails`
 * côté API — le worker n'a pas accès à ses services Nest, mais l'e-mail doit être identique.
 */
async function loadMailDetails(
  prisma: PrismaClient,
  mailIds: readonly number[],
): Promise<Map<number, MailDetailRow[]>> {
  const out = new Map<number, MailDetailRow[]>();
  if (mailIds.length === 0) return out;

  const mails = await prisma.mail.findMany({
    where: { mailId: { in: [...mailIds] } },
    select: {
      mailId: true,
      title: true,
      nReference: true,
      reference: true,
      date: true,
      dateButoire: true,
      externalEntity: { select: { label: true } },
      destinataireRole: { select: { name: true } },
      destinataire: { select: { user: { select: { fullName: true, username: true } } } },
    },
  });

  const fmt = (d: Date | null) => (d ? d.toLocaleDateString('fr-FR') : null);
  for (const m of mails) {
    const destinataire =
      m.destinataireRole?.name ??
      m.destinataire?.user.fullName?.trim() ??
      m.destinataire?.user.username ??
      null;
    const candidates: Array<[string, string | null, boolean?]> = [
      ['Objet', m.title],
      ['Référence', m.nReference, true],
      ['Date du courrier', fmt(m.date)],
      ['Correspondant', m.externalEntity?.label ?? null],
      ['Destinataire', destinataire],
      ['N° d’origine', m.reference],
      ['Échéance', fmt(m.dateButoire), true],
    ];
    out.set(
      m.mailId,
      candidates
        .filter((r): r is [string, string, boolean?] => !!r[1]?.trim())
        .map(([label, value, strong]) => ({ label, value, strong })),
    );
  }
  return out;
}

/**
 * Duplique par e-mail les notifications qui viennent d'être écrites (§03.5).
 *
 * JAMAIS bloquant : un rappel est déjà délivré in-app quand on arrive ici. Si la messagerie est
 * en panne, le job doit se terminer normalement — le faire échouer provoquerait un retry BullMQ
 * qui réécrirait les notifications in-app en double.
 *
 * Groupé par ADRESSE : une personne portant plusieurs `app_user_group` ne reçoit qu'un e-mail.
 */
async function dispatchReminderEmails<T extends NotificationRow>(
  prisma: PrismaClient,
  mailer: Mailer | undefined,
  rows: readonly T[],
  subject: string,
  severityOf: (row: T) => MailSeverity,
): Promise<void> {
  if (!mailer?.enabled || rows.length === 0) return;
  try {
    const actors = await prisma.appUserGroup.findMany({
      where: {
        userGroupId: { in: [...new Set(rows.map((r) => r.recipientUserGroupId))] },
        user: { isDisabled: false },
      },
      select: {
        userGroupId: true,
        user: { select: { email: true, fullName: true, username: true } },
      },
    });
    const emailByActor = new Map(
      actors
        .filter((a) => a.user.email?.trim())
        .map(
          (a) =>
            [
              a.userGroupId,
              {
                email: a.user.email!.trim(),
                name: a.user.fullName?.trim() || a.user.username,
              },
            ] as const,
        ),
    );

    // Détails du courrier, mutualisés : un même courrier peut viser plusieurs destinataires.
    const detailsByMail = await loadMailDetails(prisma, [...new Set(rows.map((r) => r.targetId))]);

    // Une même adresse peut être visée par plusieurs lignes (multi-groupes) : on ne garde que la
    // première, sinon la personne recevrait le même rappel en plusieurs exemplaires.
    const seen = new Set<string>();
    const sends: Promise<boolean>[] = [];
    for (const row of rows) {
      const actor = emailByActor.get(row.recipientUserGroupId);
      if (!actor || seen.has(actor.email)) continue;
      seen.add(actor.email);
      sends.push(
        mailer.send({
          to: actor.email,
          subject,
          title: subject,
          recipientName: actor.name,
          body: row.message,
          severity: severityOf(row),
          details: detailsByMail.get(row.targetId) ?? [],
          link: `/courriers/suivi/${row.targetId}`,
        }),
      );
    }
    await Promise.all(sends);
  } catch {
    // Silencieux : la notification in-app est déjà passée, elle fait foi.
  }
}

/**
 * Rappels d'échéance courrier (`mail-reminder-datebutoire`, 13h10/jour).
 * Cible : `dateButoire != null && dateTraited == null && valider == true` ; notifie le
 * destinataire selon le palier du jour (§03.5). Un courrier hors palier n'est pas notifié.
 *
 * Le destinataire d'un Arrivée est un rôle (§05) : le rappel part alors à chacun de ses porteurs.
 * `notified` compte les notifications écrites (et non les courriers), comme runInputationReminders.
 */
export async function runDateButoireReminders(
  prisma: PrismaClient,
  now: Date,
  mailer?: Mailer,
): Promise<ReminderResult> {
  const mails = await prisma.mail.findMany({
    where: {
      isDeleted: false,
      valider: true,
      dateTraited: null,
      dateButoire: { not: null },
    },
    select: {
      mailId: true,
      title: true,
      dateButoire: true,
      destinataireExpediteur: true,
      destinataireRoleId: true,
    },
  });

  const due = mails
    .map((m) => ({ mail: m, alert: dateButoireAlert(daysUntil(m.dateButoire as Date, now)) }))
    .filter((x): x is { mail: (typeof mails)[number]; alert: NonNullable<typeof x.alert> } =>
      Boolean(x.alert),
    );

  const byRole = await resolveRoleRecipients(
    prisma,
    due.map(({ mail }) => mail.destinataireRoleId),
  );

  // `alert` est conservé par ligne : c'est lui qui décide de la teinte de l'e-mail (retard/urgence
  // en rouge), une information que le message seul ne permettrait pas de retrouver.
  const rows = due.flatMap(({ mail, alert }) =>
    destinataires(mail, byRole).map((recipientUserGroupId) => ({
      recipientUserGroupId,
      message: dateButoireMessage(alert, mail.title),
      targetType: 'mail',
      targetId: mail.mailId,
      alert,
    })),
  );

  if (rows.length > 0) {
    // L'`alert` ne fait pas partie du modèle Notification : on ne l'écrit pas en base.
    await prisma.notification.createMany({
      data: rows.map(({ alert: _alert, ...row }) => row),
    });
    await dispatchReminderEmails(prisma, mailer, rows, 'Échéance de courrier', (row) =>
      // Retard et échéance du jour appellent une action immédiate : bannière rouge.
      row.alert === 'RETARD' || row.alert === 'URGENCE' ? 'warn' : 'info',
    );
  }

  return { scanned: mails.length, notified: rows.length };
}

/** Acteurs destinataires d'un courrier : porteurs du rôle (§05) ou acteur nommé (Départ §12). */
function destinataires(
  mail: { destinataireExpediteur: number | null; destinataireRoleId: number | null },
  byRole: Map<number, number[]>,
): number[] {
  if (mail.destinataireRoleId != null) return byRole.get(mail.destinataireRoleId) ?? [];
  return mail.destinataireExpediteur != null ? [mail.destinataireExpediteur] : [];
}

/**
 * Résout en UNE requête les porteurs de tous les rôles cités — une requête par courrier ferait un
 * N+1 sur un job qui balaie tout le stock. Miroir de `MailsService.roleRecipients` : une seule
 * identité (`app_user_group`) par personne, la personne pouvant appartenir à plusieurs groupes.
 */
async function resolveRoleRecipients(
  prisma: PrismaClient,
  roleIds: readonly (number | null)[],
): Promise<Map<number, number[]>> {
  const ids = [...new Set(roleIds.filter((id): id is number => id != null))];
  const byRole = new Map<number, number[]>();
  if (ids.length === 0) return byRole;

  const rows = await prisma.appUserGroup.findMany({
    where: { user: { roleId: { in: ids }, isDisabled: false } },
    orderBy: [{ isDefault: 'desc' }, { userGroupId: 'asc' }],
    select: { userGroupId: true, userId: true, user: { select: { roleId: true } } },
  });

  const seen = new Set<number>();
  for (const r of rows) {
    if (seen.has(r.userId) || r.user.roleId == null) continue;
    seen.add(r.userId);
    byRole.set(r.user.roleId, [...(byRole.get(r.user.roleId) ?? []), r.userGroupId]);
  }
  return byRole;
}

/**
 * Rappels d'échéance d'imputation (`mail-inputation-reminder-deadline`, chaque minute).
 * Notifie l'agent imputé **et** le créateur de l'imputation, puis horodate `lastReminderSent`
 * pour respecter l'intervalle anti-spam (§03.5).
 */
export async function runInputationReminders(
  prisma: PrismaClient,
  now: Date,
  env: ReminderEnv,
  mailer?: Mailer,
): Promise<ReminderResult> {
  // Pré-filtre en base sur la fenêtre ; le détail des règles reste dans le domaine (testé).
  const candidates = await prisma.mailInputation.findMany({
    where: {
      dateTreated: null,
      deadline: {
        not: null,
        gte: now,
        lte: new Date(now.getTime() + env.delaisAlerteHours * 3_600_000),
      },
    },
    select: {
      mailInputationId: true,
      deadline: true,
      lastReminderSent: true,
      userId: true,
      createdBy: true,
      mail: { select: { mailId: true, title: true } },
    },
  });

  const due = candidates.filter((c) =>
    shouldRemindInputation(c, now, env.delaisAlerteHours, env.delaisAlerteIntervalHours),
  );
  if (due.length === 0) return { scanned: candidates.length, notified: 0 };

  const rows = due.flatMap((c) => {
    const message = inputationReminderMessage(c.mail.title, c.deadline as Date);
    // Agent imputé + créateur, dédoublonnés : quand on s'impute soi-même, une seule notification.
    const recipients = [
      ...new Set([c.userId, c.createdBy].filter((id): id is number => id != null)),
    ];
    return recipients.map((recipientUserGroupId) => ({
      recipientUserGroupId,
      message,
      targetType: 'mail',
      targetId: c.mail.mailId,
    }));
  });

  await prisma.$transaction([
    prisma.notification.createMany({ data: rows }),
    prisma.mailInputation.updateMany({
      where: { mailInputationId: { in: due.map((c) => c.mailInputationId) } },
      data: { lastReminderSent: now },
    }),
  ]);

  // APRÈS la transaction : l'horodatage anti-spam doit être acquis avant tout envoi. Sinon un
  // échec e-mail laisserait `lastReminderSent` vide et le job relancerait à la minute suivante.
  await dispatchReminderEmails(prisma, mailer, rows, "Échéance d'imputation", () => 'info');

  return { scanned: candidates.length, notified: rows.length };
}
