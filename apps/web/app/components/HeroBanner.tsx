'use client';

import type { ReactNode } from 'react';
import { Space, Typography } from 'antd';
import { radii } from '../theme/tokens';

/**
 * Bandeau d'accueil des tableaux de bord — porte le dégradé signature
 * cyan → bleu roi (PRD relook §4.5.4).
 *
 * Le dégradé garde les deux teintes de marque (`--da-brand-from` cyan,
 * `--da-brand-to` bleu roi) mais réserve au bleu toute la zone où vit le
 * texte : le cyan seul ne contraste qu'à 1,87:1 avec du blanc, contre 9,25:1
 * pour le bleu roi. Le cyan n'affleure donc qu'au bord opposé.
 */
export function HeroBanner({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: radii.card,
        padding: '22px 26px',
        background:
          'linear-gradient(100deg, var(--da-brand-to) 0%, var(--da-brand-to) 55%, var(--da-brand-from) 145%)',
        color: 'var(--da-on-brand)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <Typography.Title level={4} style={{ color: 'var(--da-on-brand)', margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Text style={{ color: 'var(--da-on-brand-muted)' }}>
          {description}
        </Typography.Text>
      </div>
      {actions && <Space wrap>{actions}</Space>}
    </div>
  );
}

/** Style des boutons secondaires posés sur le bandeau (bordure et texte blancs). */
export const heroGhostStyle = {
  borderColor: 'var(--da-on-brand-muted)',
  color: 'var(--da-on-brand)',
} as const;
