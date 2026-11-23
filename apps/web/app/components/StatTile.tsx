'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Skeleton } from 'antd';
import { icons, iconDefaults, type IconName } from '../theme/icons';
import { fmtInt } from '../theme/charts';
import { fontSize, radii, tileMarks, tileMarksDark, type TileTone } from '../theme/tokens';
import { useThemeMode } from './Providers';

/**
 * Tuile de synthèse : une tuile de PAPIER bordée d'un filet, le chiffre à l'encre. La teinte
 * (`tone`) n'est plus un aplat : c'est une pastille devant le libellé, décorative, qui
 * distingue les tuiles d'un bandeau entre elles sans jamais se lire comme un état.
 *
 * Pour un chiffre qui porte un sens de statut (retards, files), prendre `StatusTile`.
 */
export function StatTile({
  tone,
  label,
  value,
  suffix,
  hint,
  icon,
  href,
  loading,
}: {
  tone: TileTone;
  label: string;
  value: number | string | null;
  suffix?: string;
  hint?: ReactNode;
  icon?: IconName;
  href?: string;
  loading?: boolean;
}) {
  const { mode } = useThemeMode();
  void (mode === 'dark' ? tileMarksDark : tileMarks)[tone]; // teinte conservée dans les tokens, non affichée
  return (
    <Tile label={label} value={value} suffix={suffix} hint={hint} icon={icon} href={href} loading={loading} />
  );
}

/**
 * Gabarit commun de `StatTile` et `StatusTile` : pastille + libellé, chiffre, précision.
 * `figureColor` teinte le chiffre (tuiles d'état) ; absent, le chiffre est à l'encre.
 */
export function Tile({
  mark,
  figureColor,
  label,
  value,
  suffix,
  hint,
  icon,
  href,
  loading,
}: {
  mark?: string;
  figureColor?: string;
  label: string;
  value: number | string | null;
  suffix?: string;
  hint?: ReactNode;
  icon?: IconName;
  href?: string;
  loading?: boolean;
}) {
  const Glyph = icon ? icons[icon] : null;
  const affichage = value === null ? '—' : typeof value === 'number' ? fmtInt(value) : value;
  const secondary = 'var(--ant-color-text-secondary)';

  const body = (
    <div
      className="da-tile"
      style={{
        height: '100%',
        borderRadius: radii.card,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 96,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            color: secondary,
            fontSize: fontSize.sm,
          }}
        >
          {mark && (
            <span
              aria-hidden
              style={{ flex: 'none', width: 8, height: 8, borderRadius: '50%', background: mark }}
            />
          )}
          {label}
        </span>
        {Glyph && (
          <span style={{ color: 'var(--ant-color-text-tertiary)', display: 'flex' }}>
            <Glyph {...iconDefaults} size={18} aria-hidden />
          </span>
        )}
      </div>

      {loading ? (
        <Skeleton.Input active size="small" style={{ width: 90 }} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            className="da-figure"
            style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1, color: figureColor }}
          >
            {affichage}
          </span>
          {suffix && <span style={{ color: secondary, fontSize: fontSize.xs }}>{suffix}</span>}
        </div>
      )}

      {hint && <span style={{ color: secondary, fontSize: fontSize.xs }}>{hint}</span>}
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="da-tile-link" style={{ display: 'block', height: '100%' }}>
        {body}
      </Link>
    );
  }
  return body;
}
