'use client';

import type { ReactNode } from 'react';
import { Tag } from 'antd';
import { MAIL_STATUS_LABELS, MAIL_TYPE_LABELS, MailStatus, MailType } from '@archivage/types';
import { colors, radii } from '../../theme/tokens';

/**
 * Badges de statut et de sens d'un courrier : remplissages PLEINS à texte blanc (11 px / 600,
 * rayon 4 px), plus aucun preset AntD (`green`/`gold`/`blue`/`cyan`/`purple`) — ceux-ci
 * posaient un texte teinté sur un fond très pâle, sous AA et sans hiérarchie.
 *
 * Les fonds sont volontairement CONSTANTS entre les deux thèmes : les dérivés sombres de la
 * palette (`#00d284`, `#00cff4`…) sont calibrés pour porter du TEXTE sur une surface sombre,
 * pas pour recevoir du blanc — utilisés en fond de badge ils retomberaient sous 2:1. Ce sont
 * donc les dérivés FORTS AA (design-tokens.md §3.1) qui remplissent, dans les deux thèmes :
 * le blanc y passe à ≥ 4,7:1 et le badge reste détaché de la carte sombre (≈ 3,2:1).
 */
type Tone = 'neutral' | 'brand' | 'info' | 'success' | 'danger';

const TONE_BG: Record<Tone, string> = {
  neutral: colors.secondaryStrong, // blanc dessus : 4,74:1
  brand: colors.menuActiveBg, // 6,08:1 — le bleu roi #0033c4 s'effacerait sur carte sombre
  info: colors.info, // 4,75:1
  success: colors.success, // 4,75:1
  danger: colors.danger, // 4,75:1
};

/** Cycle de vie (§02.1.1) : mêmes associations de teinte qu'avant, portées par les dérivés AA. */
const STATUS_TONE: Record<number, Tone> = {
  [MailStatus.Redaction]: 'neutral',
  [MailStatus.Redige]: 'brand',
  [MailStatus.Decharge]: 'info',
  [MailStatus.Traite]: 'success',
  [MailStatus.Supprime]: 'danger',
};

/**
 * Sens de circulation (§02.1.2). Le violet du sens « Départ » n'a pas de dérivé AA utilisable
 * en fond de badge (la teinte des tuiles est décorative, réservée aux surfaces sans texte) :
 * il bascule sur le cyan fort, qui reste distinct du bleu roi de l'arrivée.
 */
const TYPE_TONE: Record<number, Tone> = {
  [MailType.Arrivee]: 'brand',
  [MailType.Depart]: 'info',
  [MailType.Interne]: 'neutral',
};

/**
 * Gabarit commun. La taille 11 px et le rayon 4 px viennent du thème (`Tag.fontSizeSM` /
 * `Tag.borderRadiusSM`) ; le rayon est re-posé ici pour rester lisible dans le diff.
 */
function FilledTag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Tag
      style={{
        margin: 0,
        background: TONE_BG[tone],
        color: colors.onBrand,
        borderColor: 'transparent',
        borderRadius: radii.base,
        fontWeight: 600,
      }}
    >
      {children}
    </Tag>
  );
}

/** Badge du statut d'un courrier (§02.1.1). */
export function MailStatusTag({ status }: { status: number }) {
  const label = MAIL_STATUS_LABELS[status as MailStatus] ?? String(status);
  return <FilledTag tone={STATUS_TONE[status] ?? 'neutral'}>{label}</FilledTag>;
}

/** Badge du sens d'un courrier (§02.1.2). */
export function MailTypeTag({ mailType }: { mailType: number }) {
  const label = MAIL_TYPE_LABELS[mailType as MailType] ?? String(mailType);
  return <FilledTag tone={TYPE_TONE[mailType] ?? 'neutral'}>{label}</FilledTag>;
}
