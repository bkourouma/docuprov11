'use client';

import type { ReactNode } from 'react';
import { Space, Typography } from 'antd';
import { fontSize, radii } from '../theme/tokens';

/**
 * Bandeau de raccourcis en tête des tableaux de bord : une bande de papier bordée d'un filet,
 * le titre à gauche, les actions à droite. Plus d'aplat de couleur ni de dégradé : un tableau
 * de bord s'ouvre sur ses chiffres, pas sur un pavé de bienvenue. L'action principale est un
 * bouton primaire, les autres des boutons ordinaires.
 */
export function HeroBanner({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        marginBottom: 16,
        borderRadius: radii.card,
        padding: '14px 20px',
        background: 'var(--ant-color-bg-container)',
        border: '1px solid var(--ant-color-border)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px 24px',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0, fontSize: fontSize.md }}>
          {title}
        </Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </div>
      {actions && <Space wrap>{actions}</Space>}
    </div>
  );
}
