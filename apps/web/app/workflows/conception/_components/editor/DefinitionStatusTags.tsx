'use client';

import { Tag } from 'antd';
import {
  WF_DEFINITION_STATUS_LABELS,
  WF_DEFINITION_VERSION_STATUS_LABELS,
  WfDefinitionStatus,
  WfDefinitionVersionStatus,
} from '@archivage/types';
import type { TagColor } from '../../../_lib/labels';

// Texte + teinte : la couleur ne porte jamais seule l'état.
const DEFINITION_COLOR: Record<WfDefinitionStatus, TagColor> = {
  [WfDefinitionStatus.Draft]: 'warning',
  [WfDefinitionStatus.Published]: 'success',
  [WfDefinitionStatus.Archived]: 'default',
};

const VERSION_COLOR: Record<WfDefinitionVersionStatus, TagColor> = {
  [WfDefinitionVersionStatus.Draft]: 'warning',
  [WfDefinitionVersionStatus.Published]: 'success',
  [WfDefinitionVersionStatus.Archived]: 'default',
};

export function DefinitionStatusTag({ status }: { status: WfDefinitionStatus }) {
  return <Tag color={DEFINITION_COLOR[status]}>{WF_DEFINITION_STATUS_LABELS[status] ?? `Statut ${status}`}</Tag>;
}

export function VersionStatusTag({ status }: { status: WfDefinitionVersionStatus }) {
  return <Tag color={VERSION_COLOR[status]}>{WF_DEFINITION_VERSION_STATUS_LABELS[status] ?? `Statut ${status}`}</Tag>;
}
