'use client';

import { Tag } from 'antd';
import type { WfInboxItemStatus, WfInstanceStatus, WfTaskPriority } from '@archivage/types';
import { dueInfo } from '../_lib/format';
import {
  INBOX_STATUS_COLOR,
  INSTANCE_STATUS_COLOR,
  PRIORITY_COLOR,
  inboxStatusLabel,
  instanceStatusLabel,
  priorityLabel,
} from '../_lib/labels';

/** Pastilles d'état : libellé TOUJOURS visible (la couleur ne porte jamais seule l'information). */
export function InstanceStatusTag({ status }: { status: WfInstanceStatus }) {
  return <Tag color={INSTANCE_STATUS_COLOR[status]}>{instanceStatusLabel(status)}</Tag>;
}

export function InboxStatusTag({ status }: { status: WfInboxItemStatus }) {
  return <Tag color={INBOX_STATUS_COLOR[status]}>{inboxStatusLabel(status)}</Tag>;
}

export function PriorityTag({ priority }: { priority: WfTaskPriority }) {
  return <Tag color={PRIORITY_COLOR[priority]}>{`Priorité ${priorityLabel(priority).toLowerCase()}`}</Tag>;
}

/** Échéance : un retard est signalé par le texte (« En retard de 2 h »), en plus de la teinte. */
export function DueTag({ dueAt, now }: { dueAt: string | null | undefined; now?: Date }) {
  const info = dueInfo(dueAt, now);
  if (info.state === 'none') return <span className="wf-muted">{info.label}</span>;
  const color = info.state === 'overdue' ? 'error' : info.state === 'soon' ? 'warning' : 'default';
  return <Tag color={color}>{info.label}</Tag>;
}
