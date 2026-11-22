'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Input, Modal, Select } from 'antd';
import { useRouter } from 'next/navigation';
import { WF_SUBJECT_TYPES, type WfDefinitionDto } from '@archivage/types';
import { WorkflowApiError, workflowErrorMessage, workflowsApi } from '../../../lib/workflows-api';
import { newIdempotencyKey } from '../../_lib/format';
import {
  IDEMPOTENCY_KEY_MAX,
  LAUNCH_CONTEXT_EXAMPLE,
  SUBJECT_TYPE_LABELS,
  validateLaunchForm,
  type LaunchFormErrors,
} from '../../_lib/instances-logic';

/** Message d'erreur d'un lancement refusé (clé réutilisée, workflow non publié, objet lié refusé…). */
export function launchErrorMessage(e: unknown): string {
  if (e instanceof WorkflowApiError) {
    if (e.code === 'IDEMPOTENCY_CONFLICT') {
      return 'Cette clé d’idempotence est déjà utilisée par un autre lanceur. Cliquez sur « Régénérer » pour en obtenir une nouvelle.';
    }
    if (e.code === 'DEFINITION_NOT_PUBLISHED') return 'Ce workflow n’est plus publié : il ne peut pas être lancé.';
    if (e.status === 403 && (!e.message || /^HTTP \d+$/.test(e.message))) {
      return 'Accès refusé : vous ne pouvez pas lancer ce workflow ou utiliser cet objet lié.';
    }
  }
  return workflowErrorMessage(e);
}

const SUBJECT_OPTIONS = WF_SUBJECT_TYPES.map((t) => ({ value: t, label: SUBJECT_TYPE_LABELS[t] ?? t }));

/**
 * Lancement manuel d'un workflow. La clé d'idempotence est générée à chaque ouverture (modifiable) : rejouer la
 * même clé ne crée pas de doublon. Les erreurs du serveur restent dans la modale, sans perdre la saisie.
 */
export function LaunchModal({ definition, onClose }: { definition: WfDefinitionDto | null; onClose: () => void }) {
  const { message } = App.useApp();
  const router = useRouter();

  const [contextText, setContextText] = useState('');
  const [subjectType, setSubjectType] = useState<string | undefined>();
  const [subjectId, setSubjectId] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [errors, setErrors] = useState<LaunchFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // double clic : le drapeau est posé avant le prochain rendu

  const open = definition !== null;
  const defId = definition?.wfDefinitionId ?? null;

  // Nouvelle ouverture => formulaire vierge et NOUVELLE clé d'idempotence.
  useEffect(() => {
    if (defId === null) return;
    setContextText('');
    setSubjectType(undefined);
    setSubjectId('');
    setIdempotencyKey(newIdempotencyKey());
    setErrors({});
    setServerError(null);
  }, [defId]);

  async function submit() {
    if (!definition || inFlight.current) return;
    const v = validateLaunchForm({ contextText, subjectType, subjectId, idempotencyKey });
    setErrors(v.errors);
    setServerError(null);
    if (!v.valid || !v.payload) return;

    inFlight.current = true;
    setBusy(true);
    try {
      const { instance, created } = await workflowsApi.launch({
        definitionId: definition.wfDefinitionId,
        context: v.payload.context,
        subjectType: v.payload.subjectType,
        subjectId: v.payload.subjectId,
        idempotencyKey: v.payload.idempotencyKey,
      });
      if (created) message.success('Workflow lancé.');
      else message.info('Une instance existe déjà pour cette clé : la voici.');
      router.push(`/workflows/instances/${encodeURIComponent(instance.wfInstanceId)}`);
      // On garde `busy` jusqu'à la navigation : pas de second lancement possible entre-temps.
    } catch (e) {
      setServerError(launchErrorMessage(e));
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={definition ? `Lancer « ${definition.name} »` : 'Lancer un workflow'}
      onCancel={() => {
        if (!busy) onClose();
      }}
      maskClosable={false}
      destroyOnClose
      width={620}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={busy}>
          Fermer
        </Button>,
        <Button key="ok" type="primary" onClick={() => void submit()} loading={busy}>
          Lancer
        </Button>,
      ]}
    >
      <div className="wfi-form">
        <div className="wf-field" style={{ minWidth: 0 }}>
          <label htmlFor="wfi-context">Données de lancement (JSON, facultatif)</label>
          <div className="wfi-mono">
            <Input.TextArea
              id="wfi-context"
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              rows={5}
              placeholder={LAUNCH_CONTEXT_EXAMPLE}
              spellCheck={false}
              status={errors.context ? 'error' : undefined}
              aria-invalid={Boolean(errors.context)}
              aria-describedby={errors.context ? 'wfi-context-err wfi-context-hint' : 'wfi-context-hint'}
              disabled={busy}
            />
          </div>
          <p id="wfi-context-hint" className="wfi-hint">
            Un objet JSON de 256 Kio au plus, par exemple {'{"priorite": "haute"}'}. Laissez vide s’il n’y a rien à transmettre.
          </p>
          {errors.context && (
            <p id="wfi-context-err" className="wfi-error" role="alert">
              {errors.context}
            </p>
          )}
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="wf-field" style={{ padding: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ant-color-text-secondary)' }}>
              Objet lié (facultatif : le type et l’identifiant vont ensemble)
            </span>
          </legend>
          <div className="wfi-subject-row">
            <Select
              aria-label="Type d’objet lié"
              allowClear
              placeholder="Type"
              value={subjectType}
              options={SUBJECT_OPTIONS}
              onChange={(v: string | undefined) => setSubjectType(v)}
              disabled={busy}
              status={errors.subject ? 'error' : undefined}
            />
            <Input
              aria-label="Identifiant de l’objet lié"
              inputMode="numeric"
              placeholder="Identifiant (nombre)"
              value={subjectId}
              onChange={(e) => setSubjectId(e.target.value)}
              disabled={busy}
              status={errors.subject ? 'error' : undefined}
              aria-invalid={Boolean(errors.subject)}
              aria-describedby={errors.subject ? 'wfi-subject-err' : undefined}
            />
          </div>
          {errors.subject && (
            <p id="wfi-subject-err" className="wfi-error" role="alert">
              {errors.subject}
            </p>
          )}
        </fieldset>

        <div className="wf-field" style={{ minWidth: 0 }}>
          <label htmlFor="wfi-key">Clé d’idempotence</label>
          <div className="wfi-key-row">
            <Input
              id="wfi-key"
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              maxLength={IDEMPOTENCY_KEY_MAX + 20 /* laisse la validation signaler le dépassement */}
              status={errors.idempotencyKey ? 'error' : undefined}
              aria-invalid={Boolean(errors.idempotencyKey)}
              aria-describedby={errors.idempotencyKey ? 'wfi-key-err wfi-key-hint' : 'wfi-key-hint'}
              disabled={busy}
            />
            <Button onClick={() => setIdempotencyKey(newIdempotencyKey())} disabled={busy}>
              Régénérer
            </Button>
          </div>
          <p id="wfi-key-hint" className="wfi-hint">
            Rejouer la même clé ne crée pas de doublon : si une instance existe déjà pour cette clé, elle vous est
            simplement montrée. 1 à 200 caractères.
          </p>
          {errors.idempotencyKey && (
            <p id="wfi-key-err" className="wfi-error" role="alert">
              {errors.idempotencyKey}
            </p>
          )}
        </div>

        <div aria-live="polite">{serverError && <Alert type="error" showIcon message={serverError} />}</div>
      </div>
    </Modal>
  );
}
