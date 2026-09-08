'use client';

import { colors, fontSize } from '../theme/tokens';

/**
 * Pastille de comptage Plus Admin — un nombre plein, en pilule primaire, à côté d'un libellé,
 * utilisée en en-tête de carte partout où un simple texte « N élément(s) » gagnait à être plus
 * visible (files de travail courrier, résultats de recherche).
 *
 * Le remplissage est `menuActiveBg` (#1a55e3) et non `--ant-color-primary` : c'est le seul bleu
 * de la palette CONSTANT entre les deux thèmes et porteur de texte blanc (6,08:1) — le primaire
 * du thème sombre (#5a85ff) n'atteint que 2,99:1 sous du blanc.
 */
export function CountBadge({ value, label }: { value: number | string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span
        className="da-mono da-pill"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 30,
          height: 26,
          padding: '0 9px',
          background: colors.menuActiveBg,
          color: 'var(--ant-color-white)',
          fontWeight: 700,
          fontSize: fontSize.sm,
        }}
      >
        {value}
      </span>
      <span>{label}</span>
    </span>
  );
}
