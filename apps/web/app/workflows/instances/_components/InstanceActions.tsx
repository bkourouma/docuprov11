'use client';

import { useRef, useState } from 'react';
import { Alert, App, Button, Input, Modal } from 'antd';
import type { WfInstanceDto } from '@archivage/types';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../../lib/workflows-api';
import { instanceActionRights, type WfAccess } from '../../_lib/access';

type ActionKind = 'cancel' | 'suspend' | 'resume';

const REASON_MAX = 1000;

const COPY: Record<ActionKind, { button: string; title: string; body: string; ok: string; done: string; danger?: boolean }> = {
  cancel: {
    button: 'Annuler',
    title: 'Annuler cette instance ?',
    body: 'L’instance sera définitivement arrêtée et ses tâches ouvertes seront annulées. Cette action est irréversible.',
    ok: 'Annuler l’instance',
    done: 'Instance annulée.',
    danger: true,
  },
  suspend: {
    button: 'Suspendre',
    title: 'Suspendre cette instance ?',
    body: 'L’instance est mise en pause : plus aucune tâche n’avance et les minuteries sont gelées jusqu’à la reprise.',
    ok: 'Suspendre l’instance',
    done: 'Instance suspendue.',
  },
  resume: {
    button: 'Reprendre',
    title: 'Reprendre cette instance ?',
    body: 'L’instance repart là où elle s’était arrêtée ; les échéances sont décalées de la durée de la pause.',
    ok: 'Reprendre l’instance',
    done: 'Instance reprise.',
  },
};

/** Messages d'erreur propres aux actions (403 : réservé au lanceur ou à l'administration ; 409 : état changé). */
export function actionErrorMessage(e: unknown): string {
  if (e instanceof WorkflowApiError) {
    if (e.status === 403) return 'Seul le lanceur ou un administrateur peut agir sur cette instance.';
    if (e.status === 409) return 'L’état de l’instance a changé entre-temps. Actualisez puis réessayez.';
  }
  return workflowErrorMessage(e);
}

/**
 * Boutons annuler / suspendre / reprendre d'une instance, avec modale de confirmation (motif facultatif pour
 * annuler et suspendre). Les droits ne servent qu'à l'AFFICHAGE : le serveur reste juge (403/409 traités).
 * `onChanged` est appelé après succès OU après un conflit (l'état affiché est alors périmé : on recharge).
 */
export function InstanceActions({
  instance,
  access,
  onChanged,
  size = 'middle',
}: {
  instance: Pick<WfInstanceDto, 'wfInstanceId' | 'startedBy' | 'status'>;
  access: WfAccess;
  onChanged: () => void;
  size?: 'small' | 'middle';
}) {
  const { message } = App.useApp();
  const rights = instanceActionRights(access, instance);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // protège du double clic avant le prochain rendu

  if (!rights.cancel && !rights.suspend && !rights.resume) return null;

  const open = (a: ActionKind) => {
    setAction(a);
    setReason('');
    setError(null);
  };
  const close = () => {
    if (!inFlight.current) setAction(null);
  };

  async function confirm() {
    if (!action || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const id = instance.wfInstanceId;
    const trimmed = reason.trim() === '' ? undefined : reason.trim();
    try {
      if (action === 'cancel') await workflowsApi.cancelInstance(id, trimmed);
      else if (action === 'suspend') await workflowsApi.suspendInstance(id, trimmed);
      else await workflowsApi.resumeInstance(id);
      message.success(COPY[action].done);
      setAction(null);
      onChanged();
    } catch (e) {
      setError(actionErrorMessage(e));
      // Un conflit signifie que l'état affiché est périmé : on recharge en gardant la modale ouverte.
      if (e instanceof WorkflowApiError && e.status === 409) onChanged();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const copy = action ? COPY[action] : null;
  return (
    <>
      <div className="wfi-actions wf-touch">
        {rights.resume && (
          <Button size={size} type="primary" onClick={() => open('resume')}>
            {COPY.resume.button}
          </Button>
        )}
        {rights.suspend && (
          <Button size={size} onClick={() => open('suspend')}>
            {COPY.suspend.button}
          </Button>
        )}
        {rights.cancel && (
          <Button size={size} danger onClick={() => open('cancel')}>
            {COPY.cancel.button}
          </Button>
        )}
      </div>
      <Modal
        open={action !== null}
        title={copy?.title}
        onCancel={close}
        onOk={confirm}
        okText={copy?.ok}
        cancelText="Fermer"
        okButtonProps={{ danger: copy?.danger, loading: busy }}
        cancelButtonProps={{ disabled: busy }}
        maskClosable={!busy}
        destroyOnClose
      >
        <p>{copy?.body}</p>
        {action && action !== 'resume' && (
          <div className="wf-field" style={{ minWidth: 0 }}>
            <label htmlFor={`wfi-reason-${instance.wfInstanceId}`}>Motif (facultatif)</label>
            <Input.TextArea
              id={`wfi-reason-${instance.wfInstanceId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              showCount
              rows={3}
              disabled={busy}
            />
          </div>
        )}
        <div aria-live="polite">
          {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}
        </div>
      </Modal>
    </>
  );
}
