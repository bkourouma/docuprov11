'use client';

import { MAIL_STATUS_LABELS, MAIL_TYPE_LABELS, MailStatus, MailType } from '@archivage/types';
import { StateMark, type MarkTone } from '../StateMark';

/**
 * Statut et sens d'un courrier : une pastille suivie du libellé, à l'encre de l'état
 * (`StateMark`). Plus aucun preset de couleur AntD ni étiquette pleine : dans une liste de
 * cinquante lignes, cinquante pavés colorés se disputaient l'œil avec ce qui est en retard.
 */
type Tone = MarkTone;

/** Cycle de vie (§02.1.1) : associations de teinte inchangées. */
const STATUS_TONE: Record<number, Tone> = {
  [MailStatus.Redaction]: 'neutral',
  [MailStatus.Redige]: 'brand',
  [MailStatus.Decharge]: 'info',
  [MailStatus.Traite]: 'success',
  [MailStatus.Supprime]: 'danger',
};

/** Sens de circulation (§02.1.2) : l'arrivée à l'encre de marque, le départ en bleu-gris. */
const TYPE_TONE: Record<number, Tone> = {
  [MailType.Arrivee]: 'brand',
  [MailType.Depart]: 'info',
  [MailType.Interne]: 'neutral',
};

/** Statut d'un courrier (§02.1.1). */
export function MailStatusTag({ status }: { status: number }) {
  const label = MAIL_STATUS_LABELS[status as MailStatus] ?? String(status);
  return <StateMark tone={STATUS_TONE[status] ?? 'neutral'}>{label}</StateMark>;
}

/** Sens d'un courrier (§02.1.2). */
export function MailTypeTag({ mailType }: { mailType: number }) {
  const label = MAIL_TYPE_LABELS[mailType as MailType] ?? String(mailType);
  return <StateMark tone={TYPE_TONE[mailType] ?? 'neutral'}>{label}</StateMark>;
}
