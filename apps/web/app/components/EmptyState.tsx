'use client';

import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { motion } from 'motion/react';
import { fadeUp } from '../theme/motion';
import { icons, type IconName } from '../theme/icons';
import { fontSize } from '../theme/tokens';

/**
 * État vide illustré, toujours porteur d'une action. Ton dans la voix de
 * l'interface — jamais d'excuse, on dit quoi faire ensuite.
 *
 * Pas de description : les sous-titres gris ont été retirés de toute l'application
 * (2026-09-08). Le titre et le bouton d'action portent seuls le message.
 */
export function EmptyState({
  icon = 'archive',
  title,
  action,
  compact = false,
}: {
  icon?: IconName;
  title: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  const Glyph = icons[icon];
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="show"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 12,
        padding: compact ? '28px 16px' : '52px 24px',
      }}
    >
      {/* Illustration : disque gris neutre du thème + glyphe primaire (aucune teinte
          figée) ; pastille = cercle, comme les pastilles d'icône de PageHeader. */}
      <span
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 64,
          height: 64,
          borderRadius: 'var(--da-radius-pill)',
          background: 'var(--ant-color-fill-tertiary)',
          color: 'var(--ant-color-primary)',
        }}
      >
        <Glyph size={30} strokeWidth={1.6} />
      </span>
      <Typography.Text strong style={{ fontSize: fontSize.md }}>
        {title}
      </Typography.Text>
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </motion.div>
  );
}
