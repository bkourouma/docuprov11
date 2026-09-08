'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Skeleton, Typography } from 'antd';
import { icons, iconDefaults, type IconName } from '../theme/icons';
import { fmtInt } from '../theme/charts';
import { fontSize, radii, tiles, tilesDark, type TileTone } from '../theme/tokens';
import { useThemeMode } from './Providers';

/**
 * Tuile de synthèse colorée : dégradé plein, texte clair, une teinte par tuile
 * (palette « tuiles » de design-tokens.md §10). Réservée aux bandeaux de KPI
 * d'accueil (dashboards) — les tableaux et files de travail gardent `KpiCard`
 * (carte neutre bordée) pour ne pas transformer une donnée décorative en signal
 * de statut.
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
  const style = (mode === 'dark' ? tilesDark : tiles)[tone];
  const Glyph = icon ? icons[icon] : null;
  const affichage = value === null ? '—' : typeof value === 'number' ? fmtInt(value) : value;

  const body = (
    <div
      style={{
        height: '100%',
        // Rayon de CARTE : la tuile est une carte pleine, plate, sans ombre.
        borderRadius: radii.card,
        padding: '18px 20px',
        background: `linear-gradient(135deg, ${style.from}, ${style.to})`,
        color: style.fg,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 108,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography.Text style={{ color: style.fgMuted, fontSize: fontSize.sm }}>
          {label}
        </Typography.Text>
        {Glyph && (
          <span style={{ opacity: 0.85, display: 'flex' }}>
            <Glyph {...iconDefaults} size={18} />
          </span>
        )}
      </div>

      {loading ? (
        <Skeleton.Input active size="small" style={{ width: 90 }} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="da-mono" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>
            {affichage}
          </span>
          {suffix && <span style={{ color: style.fgMuted, fontSize: fontSize.xs }}>{suffix}</span>}
        </div>
      )}

      {hint && <span style={{ color: style.fgMuted, fontSize: fontSize.xs }}>{hint}</span>}
    </div>
  );

  if (href) {
    return (
      <Link href={href} style={{ display: 'block', height: '100%' }}>
        {body}
      </Link>
    );
  }
  return body;
}
