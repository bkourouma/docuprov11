'use client';

import type { ReactNode } from 'react';
import type { IconName } from '../theme/icons';
import type { StatusTone } from '../theme/tokens';
import { Tile } from './StatTile';

/**
 * Teintes d'état : les sémantiques FORTES AA du thème, lisibles en texte sur le papier dans
 * les deux thèmes (variables AntD).
 */
const TONE_COLOR: Record<StatusTone, string> = {
  success: 'var(--ant-color-success)',
  warning: 'var(--ant-color-warning)',
  danger: 'var(--ant-color-error)',
  info: 'var(--ant-color-info)',
};

/**
 * Tuile de synthèse d'ÉTAT — même gabarit de papier que `StatTile`, mais la teinte porte un
 * sens : pastille et chiffre prennent la couleur sémantique (succès, alerte, danger, info).
 * Réservée aux chiffres qui disent un statut (alertes, retards, files de travail) : ici la
 * couleur n'est jamais un choix esthétique — un rouge signifie toujours qu'il y a un problème.
 */
export function StatusTile({
  tone,
  label,
  value,
  suffix,
  hint,
  icon,
  href,
  loading,
}: {
  tone: StatusTone;
  label: string;
  value: number | string | null;
  suffix?: string;
  hint?: ReactNode;
  icon?: IconName;
  href?: string;
  loading?: boolean;
}) {
  const color = TONE_COLOR[tone];
  return (
    <Tile
      mark={color}
      figureColor={color}
      label={label}
      value={value}
      suffix={suffix}
      hint={hint}
      icon={icon}
      href={href}
      loading={loading}
    />
  );
}
