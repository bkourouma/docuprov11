'use client';

import type { ReactNode } from 'react';
import { Typography } from 'antd';
import { motion } from 'motion/react';
import { fadeUp } from '../theme/motion';
import { icons, type IconName } from '../theme/icons';
import { fontSize } from '../theme/tokens';

/**
 * État vide (ou d'échec), toujours porteur d'une action quand il y en a une. Ton dans la voix
 * de l'interface — jamais d'excuse, on dit quoi faire ensuite.
 *
 * Un glyphe seul, un titre, l'action : le glyphe n'est plus posé sur une pastille grise, il
 * suffit à dire de quoi l'on parle. Pas de description non plus : les sous-titres gris ont été
 * retirés de toute l'application (2026-09-08).
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
        padding: compact ? '28px 16px' : '48px 24px',
      }}
    >
      <Glyph
        size={30}
        strokeWidth={1.5}
        aria-hidden
        style={{ color: 'var(--ant-color-text-tertiary)' }}
      />
      <Typography.Text strong style={{ fontSize: fontSize.md, textWrap: 'balance' }}>
        {title}
      </Typography.Text>
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </motion.div>
  );
}
