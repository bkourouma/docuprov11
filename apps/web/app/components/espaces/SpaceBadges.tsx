'use client';

import { Tag } from 'antd';
import { icons } from '../../theme/icons';
import { fontSize, space as spacing } from '../../theme/tokens';
import {
  GED_SPACE_KIND_LABELS,
  GED_SPACE_PERMISSION_LABELS,
  type GedSpaceAccess,
  type GedSpaceKind,
} from '../../lib/espaces';

/**
 * Pastilles d'un espace. Le sens est porté par le TEXTE (jamais par la seule couleur) ;
 * les teintes sont des presets AntD, qui suivent clair/sombre sans valeur figée.
 */
export function SpaceKindTag({ kind }: { kind: GedSpaceKind }) {
  const color = kind === 0 ? 'default' : kind === 1 ? 'blue' : kind === 2 ? 'purple' : 'cyan';
  return <Tag color={color}>{GED_SPACE_KIND_LABELS[kind]}</Tag>;
}

export function PublicationTag({ slug }: { slug: string | null }) {
  const Glyph = icons.send;
  return slug ? (
    <Tag color="success" icon={<Glyph size={fontSize.xs} style={{ verticalAlign: 'text-bottom', marginInlineEnd: spacing.xs }} />}>
      Publié
    </Tag>
  ) : (
    <Tag>Non publié</Tag>
  );
}

/** Droit de l'acteur : « Propriétaire », « Lecture »… ou « Lecture publique » (accès par slug). */
export function AccessTag({ access }: { access: GedSpaceAccess | null }) {
  if (access === null) return <Tag>Lecture publique</Tag>;
  if (access === 'owner') return <Tag color="gold">Propriétaire</Tag>;
  return <Tag>{GED_SPACE_PERMISSION_LABELS[access]}</Tag>;
}
