'use client';

import { Tag } from 'antd';
import { icons } from '../theme/icons';
import { colors } from '../theme/tokens';

export type DocStatus = 'validated' | 'pending' | 'processing' | 'failed';

/**
 * Fonds des badges pleins : dérivés FORTS AA de la palette CLAIRE dans les DEUX thèmes
 * (design-tokens §3.1) — le blanc y passe (≥ 4,75:1), alors que les sémantiques vives du
 * thème sombre (#00d284, #00cff4…) échoueraient sous du texte blanc (règle d'or §4.1).
 * `menuActiveBg` porte le blanc à 6,08:1 et vaut la même chose dans les deux thèmes.
 */
const CONFIG: Record<DocStatus, { label: string; bg: string; icon: keyof typeof icons }> = {
  validated: { label: 'Validé', bg: colors.success, icon: 'validated' },
  pending: { label: 'À indexer', bg: colors.warning, icon: 'pending' },
  processing: { label: 'En cours', bg: colors.menuActiveBg, icon: 'spinner' },
  failed: { label: 'Échec', bg: colors.danger, icon: 'alert' },
};

/**
 * Badge de statut cohérent (vocabulaire unique dans toute l'app).
 * `validated`/`pending` pour les documents ; `processing`/`failed` pour les lots.
 */
export function StatusBadge({ status }: { status: DocStatus }) {
  const { label, bg, icon } = CONFIG[status];
  const Glyph = icons[icon];
  return (
    // Couleur hors preset AntD : le Tag devient plein et pose lui-même le texte blanc
    // (`ant-tag-has-color`), dont hérite le glyphe via `currentColor`.
    // Rayon 4 px et corps 11 px viennent du thème (Tag) ; seule la graisse reste ici.
    <Tag
      color={bg}
      icon={
        <Glyph
          size={13}
          strokeWidth={2}
          style={{
            verticalAlign: '-2px',
            marginInlineEnd: 4,
            ...(status === 'processing' ? { animation: 'da-spin 1s linear infinite' } : {}),
          }}
        />
      }
      style={{ fontWeight: 600, paddingInline: 8 }}
    >
      {label}
    </Tag>
  );
}
