'use client';

import type { CSSProperties, ReactNode } from 'react';
import { Skeleton, Typography } from 'antd';
import { fontSize, space } from '../../theme/tokens';
import { StateMark, type MarkTone } from '../StateMark';

const { Text } = Typography;

/**
 * Primitives communes aux onglets de la fiche document : badge d'état, titre de sous-section,
 * filet de séparation, squelette de chargement. Les huit onglets rendaient les mêmes motifs de
 * huit manières légèrement différentes — c'est ce qui faisait de la fiche une juxtaposition
 * d'écrans plutôt qu'un seul.
 */

export type StateTone = MarkTone;

/**
 * État d'un élément de la fiche document : pastille + libellé à l'encre de l'état
 * (`StateMark`), à la place des étiquettes pleines. Le nom `StateTag` est conservé pour ne
 * toucher aucun des onglets qui le consomment.
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
    <StateMark tone={tone} style={style}>
      {children}
    </StateMark>
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
