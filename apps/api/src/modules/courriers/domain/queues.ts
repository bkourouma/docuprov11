import { MailStatus, MailType } from '@archivage/types';

/**
 * Prédicats PURS des files de travail (§03.2 / §03.4). Les écrans filtrent sur les DRAPEAUX et les
 * DATES plutôt que sur `status`. Ces prédicats reproduisent les filtres source ; ils servent de
 * référence testable et de base aux clauses `where` Prisma des services (phase C).
 *
 * `isDeleted` est inclus explicitement : V6 n'a pas de filtre global de soft-delete comme ABP, donc
 * chaque file doit exclure les courriers supprimés (mail.is_deleted = false).
 */
export interface MailQueueView {
  isDeleted: boolean;
  valider: boolean;
  validationDirection: boolean;
  dateTraited: Date | null;
  mailType: MailType;
  status: MailStatus;
  dateFollowUp: Date | null;
  endDateFollowUp: Date | null;
}

/**
 * Visibilité générale dans les listes (§03.1) : un courrier Arrivée reste visible même en
 * Redaction, alors que les autres types ne le sont qu'une fois sortis de Redaction. Filtre source
 * (MailsAppService.cs:2974,3165) : `MailStatus != Redaction || MailType == Arrivée`.
 */
export function isVisibleInLists(m: MailQueueView): boolean {
  return !m.isDeleted && (m.status !== MailStatus.Redaction || m.mailType === MailType.Arrivee);
}

/** File Contrôle / Courriers Arrivés (§06) : non encore validés bureau d'ordre (`Valider == false`). */
export function isInControleQueue(m: MailQueueView): boolean {
  return !m.isDeleted && !m.valider;
}

/** File Validation Direction (§10) : validés, pas encore validés Direction, non traités. */
export function isInValidationDirectionQueue(m: MailQueueView): boolean {
  return !m.isDeleted && m.valider && !m.validationDirection && m.dateTraited === null;
}

/** File Suivi (§09) : courriers en cours (non traités). */
export function isInSuiviQueue(m: MailQueueView): boolean {
  return !m.isDeleted && m.dateTraited === null;
}

/**
 * File Courrier Départ (§12, GetAllCourrierDepart) : Départs traités OU dont le suivi est ouvert
 * (`DateFollowUp != null && EndDateFollowUp == null`).
 */
export function isInDepartQueue(m: MailQueueView): boolean {
  return (
    !m.isDeleted &&
    m.mailType === MailType.Depart &&
    (m.status === MailStatus.Traite || (m.dateFollowUp !== null && m.endDateFollowUp === null))
  );
}
