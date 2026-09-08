// Docu-Courriers — énumérations & constantes métier partagées (api / worker / web).
// Miroir TS des états stockés en base sous forme de `smallint` + CHECK (pas d'enum Prisma) :
// cf. packages/db/prisma/models/courriers.prisma. Réf. spec : §02.1 (énumérations), §03 (workflow).

/** Statut / cycle de vie d'un courrier (§02.1.1). Stocké dans `mail.status`. */
export const MailStatus = {
  Redaction: 0,
  Redige: 1,
  Decharge: 2,
  Traite: 3,
  Supprime: 4,
} as const;
export type MailStatus = (typeof MailStatus)[keyof typeof MailStatus];

export const MAIL_STATUS_LABELS: Record<MailStatus, string> = {
  [MailStatus.Redaction]: 'Rédaction',
  [MailStatus.Redige]: 'Rédigé',
  [MailStatus.Decharge]: 'Déchargé',
  [MailStatus.Traite]: 'Traité',
  [MailStatus.Supprime]: 'Supprimé',
};

/** Sens / type de circulation d'un courrier (§02.1.2). Stocké dans `mail.mail_type`. */
export const MailType = {
  Arrivee: 0,
  Depart: 1,
  Interne: 2,
} as const;
export type MailType = (typeof MailType)[keyof typeof MailType];

export const MAIL_TYPE_LABELS: Record<MailType, string> = {
  [MailType.Arrivee]: 'Arrivée',
  [MailType.Depart]: 'Départ',
  [MailType.Interne]: 'Interne',
};

/**
 * Types d'imputation « système » aux identifiants figés (§03.6). Alignés sur le seed
 * (packages/db/prisma/seed.ts). Le domaine s'y réfère par constante, jamais par nombre magique.
 */
export const MailInputationTypeId = {
  ValidationDG: 5,
  PourSuivi: 10,
  ValidationDirection: 14,
  EnCopie: 17,
} as const;
export type MailInputationTypeId = (typeof MailInputationTypeId)[keyof typeof MailInputationTypeId];

/** Codes d'action du journal métier `mail_action_log` (§03.6 / §04) — remplace ICustomAuditLogses.AddLog. */
export const MailActionCode = {
  Delaison: 1014,
  Decharge: 1015,
  ValidationDG: 1017,
  SoumissionValidation: 1018,
  Controle: 1019,
  EnregistrementReponse: 1021,
} as const;
export type MailActionCode = (typeof MailActionCode)[keyof typeof MailActionCode];

/**
 * Libellés d'action pour l'historique de la Fiche d'Imputation (§09 IV).
 * Le source les lit dans une table référentielle (`CustomAuditLogsActions`) qui n'est pas reprise
 * en V6 ; on reprend les termes du §03.6, qui nomme chaque code.
 */
export const MAIL_ACTION_LABELS: Record<number, string> = {
  [MailActionCode.Delaison]: 'Déliaison',
  [MailActionCode.Decharge]: 'Décharge',
  [MailActionCode.ValidationDG]: 'Validation DG',
  [MailActionCode.SoumissionValidation]: 'Soumission validation',
  [MailActionCode.Controle]: 'Contrôle',
  [MailActionCode.EnregistrementReponse]: 'Enregistrement réponse',
};

/** Paramètres par défaut des rappels planifiés (§03.5), en heures. */
export const REMINDER_DEFAULTS = {
  /** Fenêtre d'alerte avant l'échéance d'une imputation — source `DelaisAlerte`. */
  imputationAlertWindowHours: 48,
  /** Intervalle anti-spam entre deux rappels d'imputation — source `DelaisAlerteInterval`. */
  imputationReminderIntervalHours: 6,
} as const;

/** Niveau d'alerte du rappel « date butoir » selon les jours restants (§03.5). */
export const ReminderLevel = {
  PremiereAlerte: 'PREMIERE_ALERTE',
  Rappel: 'RAPPEL',
  DerniereChance: 'DERNIERE_CHANCE',
  Urgence: 'URGENCE',
  Retard: 'RETARD',
} as const;
export type ReminderLevel = (typeof ReminderLevel)[keyof typeof ReminderLevel];

// ---- Paliers d'alerte d'échéance (§03.5) ------------------------------------
/**
 * Paliers d'alerte sur la date butoir d'un courrier. Partagé par le worker (rappels planifiés)
 * et l'interface (bandeau d'alerte sur le détail du courrier) : les deux doivent annoncer le
 * MÊME palier au même moment, sinon l'utilisateur voit « échéance dans 3 jours » à l'écran et
 * reçoit un e-mail « dernière chance ».
 */
export type DateButoireAlert =
  | 'PREMIERE_ALERTE'
  | 'RAPPEL'
  | 'DERNIERE_CHANCE'
  | 'URGENCE'
  | 'RETARD';

/**
 * Palier applicable selon le nombre de jours restants : **paliers exacts**, pas des seuils.
 * 7 → PREMIÈRE_ALERTE, 3 → RAPPEL, 1 → DERNIÈRE_CHANCE, 0 → URGENCE, -1/-2/-3 → RETARD.
 * `null` = aucun rappel à ce stade (6, 5, 4, 2, puis -4 et au-delà).
 */
export function dateButoireAlert(daysRemaining: number): DateButoireAlert | null {
  switch (daysRemaining) {
    case 7:
      return 'PREMIERE_ALERTE';
    case 3:
      return 'RAPPEL';
    case 1:
      return 'DERNIERE_CHANCE';
    case 0:
      return 'URGENCE';
    case -1:
    case -2:
    case -3:
      return 'RETARD';
    default:
      return null;
  }
}

/**
 * Jours calendaires entre deux instants, à la journée : l'heure ne doit pas décaler le palier
 * (un courrier dû « aujourd'hui à 8 h » reste à J-0 toute la journée). Positif = dans le futur.
 */
export function daysUntilDeadline(deadline: Date, now: Date): number {
  const d = Date.UTC(deadline.getUTCFullYear(), deadline.getUTCMonth(), deadline.getUTCDate());
  const n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((d - n) / 86_400_000);
}

/** Libellés d'écran par palier — l'e-mail a ses propres formulations, plus verbeuses. */
export const DATE_BUTOIRE_LABELS: Record<DateButoireAlert, string> = {
  PREMIERE_ALERTE: 'Échéance dans 7 jours',
  RAPPEL: 'Échéance dans 3 jours',
  DERNIERE_CHANCE: 'Échéance demain',
  URGENCE: "Échéance aujourd'hui",
  RETARD: 'Échéance dépassée',
};
