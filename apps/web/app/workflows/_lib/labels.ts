// Docu-Flow — libellés et teintes des états. Les libellés viennent de @archivage/types (source unique) ;
// ce fichier n'ajoute que les teintes AntD et les accès par clé de graphe.
import {
  WF_INBOX_ITEM_STATUS_LABELS,
  WF_INSTANCE_STATUS_LABELS,
  WF_TASK_PRIORITY_LABELS,
  WF_TASK_TYPE_KEYS,
  WF_TASK_TYPE_LABELS,
  type WfInboxItemStatus,
  type WfInstanceStatus,
  type WfTaskPriority,
  type WfTaskType,
  type WfTaskTypeKey,
} from '@archivage/types';

/** Teintes AntD (`Tag color`). Toujours accompagnées du libellé : la couleur ne porte jamais seule l'état. */
export type TagColor = 'default' | 'processing' | 'success' | 'warning' | 'error' | 'orange';

export const INSTANCE_STATUS_COLOR: Record<WfInstanceStatus, TagColor> = {
  0: 'processing',
  1: 'warning',
  2: 'success',
  3: 'error',
  4: 'default',
  5: 'orange',
};

export const INBOX_STATUS_COLOR: Record<WfInboxItemStatus, TagColor> = {
  0: 'processing',
  1: 'warning',
  2: 'success',
  3: 'error',
  4: 'orange',
  5: 'default',
};

export const PRIORITY_COLOR: Record<WfTaskPriority, TagColor> = { 0: 'default', 1: 'processing', 2: 'error' };

export const instanceStatusLabel = (s: WfInstanceStatus) => WF_INSTANCE_STATUS_LABELS[s] ?? `Statut ${s}`;
export const inboxStatusLabel = (s: WfInboxItemStatus) => WF_INBOX_ITEM_STATUS_LABELS[s] ?? `Statut ${s}`;
export const priorityLabel = (p: WfTaskPriority) => WF_TASK_PRIORITY_LABELS[p] ?? 'Normale';
export const taskTypeLabel = (t: WfTaskType) => WF_TASK_TYPE_LABELS[t] ?? 'Tâche';

/** Libellé d'un type d'étape du graphe (clé texte : « formulaire », « agent »…). */
export function stepTypeLabel(key: string): string {
  const i = (WF_TASK_TYPE_KEYS as readonly string[]).indexOf(key);
  return i >= 0 ? (WF_TASK_TYPE_LABELS[i as WfTaskType] ?? key) : key;
}

/** Vrai si la clé est un type d'étape connu. */
export function isStepTypeKey(key: string): key is WfTaskTypeKey {
  return (WF_TASK_TYPE_KEYS as readonly string[]).includes(key);
}
