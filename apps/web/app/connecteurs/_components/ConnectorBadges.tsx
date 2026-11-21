'use client';

import type { ReactNode } from 'react';
import { Tag } from 'antd';
import { icons } from '../../theme/icons';
import { fontSize, space as spacing } from '../../theme/tokens';
import {
  GED_SOURCE_CONNECTOR_STATUS_LABELS,
  GED_SOURCE_ITEM_STATE_LABELS,
  GED_SYNC_RUN_STATUS_LABELS,
  GedSourceConnectorStatus,
  GedSourceItemState,
  GedSyncRunStatus,
} from '../../lib/connecteurs';

/**
 * Pastilles des connecteurs. Le sens est porté par le TEXTE (jamais par la seule couleur) ; les
 * teintes sont des presets AntD, qui suivent clair/sombre sans valeur figée.
 */
const glyph = (name: 'alert' | 'check' | 'spinner' | 'delete' | 'pending'): ReactNode => {
  const Glyph = icons[name];
  return (
    <Glyph
      size={fontSize.xs}
      style={{ verticalAlign: 'text-bottom', marginInlineEnd: spacing.xs }}
    />
  );
};

const STATUS_COLOR: Record<GedSourceConnectorStatus, string> = {
  [GedSourceConnectorStatus.Inactif]: 'default',
  [GedSourceConnectorStatus.Actif]: 'success',
  [GedSourceConnectorStatus.Erreur]: 'error',
  [GedSourceConnectorStatus.AutorisationExpiree]: 'warning',
};

export function ConnectorStatusTag({ status }: { status: GedSourceConnectorStatus }) {
  const alert =
    status === GedSourceConnectorStatus.Erreur ||
    status === GedSourceConnectorStatus.AutorisationExpiree;
  return (
    <Tag color={STATUS_COLOR[status]} icon={alert ? glyph('alert') : undefined}>
      {GED_SOURCE_CONNECTOR_STATUS_LABELS[status]}
    </Tag>
  );
}

const RUN_COLOR: Record<GedSyncRunStatus, string> = {
  [GedSyncRunStatus.EnCours]: 'processing',
  [GedSyncRunStatus.Reussie]: 'success',
  [GedSyncRunStatus.Partielle]: 'warning',
  [GedSyncRunStatus.Echouee]: 'error',
};

export function RunStatusTag({ status }: { status: GedSyncRunStatus }) {
  return <Tag color={RUN_COLOR[status]}>{GED_SYNC_RUN_STATUS_LABELS[status]}</Tag>;
}

const ITEM_COLOR: Record<GedSourceItemState, string> = {
  [GedSourceItemState.Decouvert]: 'default',
  [GedSourceItemState.Copie]: 'success',
  [GedSourceItemState.IndexeEnPlace]: 'blue',
  [GedSourceItemState.ModifieSource]: 'gold',
  [GedSourceItemState.SupprimeSource]: 'error',
  [GedSourceItemState.Erreur]: 'error',
  [GedSourceItemState.Doublon]: 'purple',
};

/** « Supprimé à la source » est en teinte pleine avec icône : c'est l'état à ne pas manquer. */
export function ItemStateTag({ state }: { state: GedSourceItemState }) {
  const deleted = state === GedSourceItemState.SupprimeSource;
  return (
    <Tag
      color={ITEM_COLOR[state]}
      bordered={!deleted}
      icon={
        deleted ? glyph('delete') : state === GedSourceItemState.Erreur ? glyph('alert') : undefined
      }
      style={deleted ? { fontWeight: 600 } : undefined}
    >
      {GED_SOURCE_ITEM_STATE_LABELS[state]}
    </Tag>
  );
}
