'use client';

import { Tag } from 'antd';
import { WF_TASK_STATUS_LABELS, type WfInboxItemDto, type WfTaskDto, type WfTaskStatus } from '@archivage/types';
import { icons, iconDefaults } from '../../../theme/icons';
import { formatDateTime } from '../../_lib/format';
import { assigneeLabel, deriveSteps } from '../../_lib/instances-logic';
import { taskTypeLabel } from '../../_lib/labels';

const TASK_COLOR: Record<WfTaskStatus, string> = {
  0: 'processing',
  1: 'warning',
  2: 'success',
  3: 'default',
  4: 'orange',
  5: 'error',
};

/** Étapes franchies (chronologie dérivée des tâches) ; l'étape en cours est mise en évidence. */
export function StepsTimeline({ tasks, inboxItems }: { tasks: WfTaskDto[]; inboxItems: WfInboxItemDto[] }) {
  const steps = deriveSteps(tasks, inboxItems);
  const Sparkle = icons.sparkle;
  if (steps.length === 0) return <p className="wf-muted">Aucune étape n’a encore été franchie.</p>;

  return (
    <ol className="wfi-steps" aria-label="Étapes franchies">
      {steps.map(({ task, current, awaitingAgentValidation }) => (
        <li key={task.wfTaskId} className={`wfi-step${current ? ' wfi-step-current' : ''}`} aria-current={current ? 'step' : undefined}>
          <div className="wfi-step-head">
            <span className="wfi-step-name">{task.title || task.stepKey}</span>
            <Tag color={TASK_COLOR[task.status]}>{WF_TASK_STATUS_LABELS[task.status] ?? `Statut ${task.status}`}</Tag>
            {current && <Tag color="blue">Étape en cours</Tag>}
          </div>
          <div className="wfi-step-sub">
            <span>Étape : {task.stepKey}</span>
            <span>Passage n° {task.attempt}</span>
            <span>Type : {taskTypeLabel(task.taskType)}</span>
            <span>Bénéficiaire : {assigneeLabel(task)}</span>
          </div>
          <div className="wfi-step-sub">
            <span>
              Début : <time dateTime={task.startedAt ?? task.createdAt}>{formatDateTime(task.startedAt ?? task.createdAt)}</time>
            </span>
            <span>Fin : {task.completedAt ? <time dateTime={task.completedAt}>{formatDateTime(task.completedAt)}</time> : '—'}</span>
            {task.completedBy !== null && <span>Terminée par : Utilisateur n° {task.completedBy}</span>}
          </div>
          {awaitingAgentValidation && (
            <div className="wfi-step-wait">
              <Sparkle size={16} strokeWidth={iconDefaults.strokeWidth} aria-hidden="true" />
              En attente de validation d’une proposition d’agent
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
