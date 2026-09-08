'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Skeleton, Tag, Typography } from 'antd';
import { colors, fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/**
 * Primitives communes aux onglets de la fiche document : badge d'état, titre de sous-section,
 * filet de séparation, squelette de chargement. Les huit onglets rendaient les mêmes motifs de
 * huit manières légèrement différentes — c'est ce qui faisait de la fiche une juxtaposition
 * d'écrans plutôt qu'un seul.
 */

/**
 * Teintes des badges d'état.
 *
 * Les fonds sont CONSTANTS entre les deux thèmes : les dérivés sombres de la palette
 * (`#00d284`, `#00cff4`…) sont calibrés pour porter du TEXTE sur une surface sombre, pas pour
 * recevoir du blanc — en fond de badge ils retomberaient sous 2:1. Ce sont donc les dérivés
 * FORTS AA (design-tokens.md §3.1) qui remplissent, le blanc y passant à ≥ 4,7:1.
 */
export type StateTone = 'brand' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';

const TONE_BG: Record<StateTone, string> = {
  brand: colors.menuActiveBg, // 6,08:1 — le bleu roi #0033c4 s'effacerait sur carte sombre
  info: colors.info, // 4,75:1
  success: colors.success, // 4,75:1
  warning: colors.warning, // 4,77:1
  danger: colors.danger, // 4,75:1
  neutral: colors.secondaryStrong, // 4,74:1
};

/**
 * Badge d'état PLEIN, en remplacement des presets de couleur d'AntD (`red`/`green`/`gold`/
 * `blue`/`geekblue`/`orange`) qui posaient un libellé teinté sur un fond très pâle, sous AA et
 * sans hiérarchie. Une couleur hors preset suffit à faire basculer AntD en remplissage plein à
 * texte blanc (`ant-tag-has-color`).
 *
 * Rayon 4 px et corps 11 px viennent du thème (`Tag`) : seule la graisse reste ici.
 */
export function StateTag({
  tone,
  children,
  style,
}: {
  tone: StateTone;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <Tag color={TONE_BG[tone]} style={{ fontWeight: 600, ...style }}>
      {children}
    </Tag>
  );
}

/** Filet de séparation entre deux sections d'un même onglet. */
export const sectionDivider: CSSProperties = {
  paddingTop: space.md,
  borderTop: '1px dashed var(--ant-color-border-secondary)',
};

/** Titre de sous-section (« Cachet serveur », « Habilités », « Règle du type »…). */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text strong style={{ fontSize: fontSize.sm, display: 'block', marginBottom: space.sm }}>
      {children}
    </Text>
  );
}

/**
 * Squelette de chargement d'un onglet. Le spinner centré qu'il remplace ne réservait aucune
 * place : le panneau passait d'un vide de 48 px au contenu complet d'un coup, et la carte
 * sautait de hauteur à chaque changement d'onglet.
 */
export function TabSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Chargement…" style={{ paddingBlock: space.sm }}>
      <Skeleton active title={{ width: 200 }} paragraph={{ rows }} />
    </div>
  );
}
