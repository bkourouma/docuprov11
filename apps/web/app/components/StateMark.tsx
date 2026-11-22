'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * Marque d'état du registre : une pastille (ou un glyphe) suivie du libellé, à l'encre de
 * l'état — plus aucune étiquette pleine à texte blanc. L'état se lit comme une annotation
 * dans la marge d'une ligne, pas comme un bouton posé dessus.
 *
 * La couleur ne porte jamais seule l'information : le libellé est toujours écrit. Les teintes
 * passent par les variables de thème d'AntD, qui portent les dérivés FORTS AA dans les deux
 * thèmes (texte lisible sur papier blanc comme sur carte sombre).
 */
export type MarkTone = 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const TONE_COLOR: Record<MarkTone, string> = {
  brand: 'var(--ant-color-primary)',
  info: 'var(--ant-color-info)',
  success: 'var(--ant-color-success)',
  warning: 'var(--ant-color-warning)',
  danger: 'var(--ant-color-error)',
  neutral: 'var(--ant-color-text-secondary)',
};

export function StateMark({
  tone,
  children,
  icon,
  style,
}: {
  tone: MarkTone;
  children: ReactNode;
  /** Glyphe à la place de la pastille (états porteurs d'une icône : validé, échec…). */
  icon?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className="da-state" style={{ color: TONE_COLOR[tone], ...style }}>
      {icon ?? <span className="da-state-dot" aria-hidden />}
      {children}
    </span>
  );
}
