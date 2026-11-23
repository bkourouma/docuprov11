'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Skeleton, Typography } from 'antd';
import { icons, iconDefaults, type IconName } from '../theme/icons';
import { fmtInt } from '../theme/charts';
import { fontSize, radii, statusTiles, statusTilesDark, type StatusTone } from '../theme/tokens';
import { useThemeMode } from './Providers';

/**
 * Tuile de synthèse colorée — même traitement visuel que `StatTile`, mais calée sur les couleurs
 * SÉMANTIQUES FORTES AA (success/warning/danger/info) plutôt que décoratives. Réservée aux
 * chiffres qui portent un vrai sens de statut (alertes, retards, files de travail) : contrairement
 * à `StatTile`, la couleur ici n'est jamais un simple choix esthétique — un rouge signifie toujours
 * qu'il y a un problème, jamais l'inverse.
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
  const { mode } = useThemeMode();
  const style = (mode === 'dark' ? statusTilesDark : statusTiles)[tone];
  const Glyph = icon ? icons[icon] : null;
  const affichage = value === null ? '—' : typeof value === 'number' ? fmtInt(value) : value;

  const body = (
    <div
      style={{
        height: '100%',
        // Rayon de CARTE : la tuile est une carte pleine, plate, sans ombre.
        borderRadius: radii.card,
        padding: '18px 20px',
        // Aplat : le registre n'a pas de dégradé (`from` et `to` sont identiques).
        background: style.from,
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
          <span className="da-figure" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>
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
