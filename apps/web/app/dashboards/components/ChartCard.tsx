'use client';

import type { ReactNode } from 'react';
import { Card, Skeleton, Typography } from 'antd';
import { EmptyState } from '../../components/EmptyState';
import { fontSize } from '../../theme/tokens';

/**
 * Conteneur standard d'un widget de dashboard : titre, action optionnelle,
 * hauteur réservée (anti layout-shift), squelette au chargement, état vide
 * explicite. Chaque widget charge indépendamment.
 */
export function ChartCard({
  title,
  subtitle,
  extra,
  loading,
  empty,
  emptyText = 'Aucune donnée pour cette période.',
  height = 300,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  extra?: ReactNode;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  height?: number;
  children: ReactNode;
}) {
  return (
    <Card styles={{ body: { padding: 16 } }} style={{ height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          {/* Titre de carte de l'échelle typographique (16 px) — le widget est bien une carte. */}
          <Typography.Text strong style={{ fontSize: fontSize.md }}>
            {title}
          </Typography.Text>
          {subtitle && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
                {subtitle}
              </Typography.Text>
            </div>
          )}
        </div>
        {extra && <div style={{ flex: 'none' }}>{extra}</div>}
      </div>
      <div style={{ minHeight: height }}>
        {loading ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : empty ? (
          <EmptyState compact icon="analytics" title={emptyText} />
        ) : (
          children
        )}
      </div>
    </Card>
  );
}
