'use client';

import { useEffect, useState } from 'react';
import { Alert, Checkbox, Input, Modal } from 'antd';
import type { WfEvalSetDto } from '@archivage/types';
import { WF_EVAL_ACCURACY_FLOOR } from '@archivage/types';
import { workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import { formatAccuracy } from '../../../_lib/eval-logic';
import { minAccuracyToInput, parseMinAccuracyInput } from './evaluation-view-logic';

const NAME_MAX = 200;
const DESCRIPTION_MAX = 5000;

export interface EvalSetModalProps {
  open: boolean;
  definitionId: number;
  /** Étape agent visée par un nouveau jeu. */
  stepKey: string | null;
  /** Jeu à modifier ; null = création. */
  editing: WfEvalSetDto | null;
  onClose: () => void;
  onSaved: (set: WfEvalSetDto) => void;
}

/** Création / modification d'un jeu d'évaluation (nom, description, précision minimale, activation). */
export function EvalSetModal({ open, definitionId, stepKey, editing, onClose, onSaved }: EvalSetModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accuracy, setAccuracy] = useState('85 %');
  const [isActive, setIsActive] = useState(true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [accuracyError, setAccuracyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Réinitialise à chaque ouverture (la modale est détruite à la fermeture).
  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setDescription(editing?.description ?? '');
    setAccuracy(editing ? minAccuracyToInput(editing.minAccuracy) : '85 %');
    setIsActive(editing?.isActive ?? true);
    setNameError(null);
    setAccuracyError(null);
    setError(null);
  }, [open, editing]);

  const submit = async () => {
    if (busy) return;
    const trimmed = name.trim();
    let ok = true;
    if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
      setNameError(`Le nom est obligatoire (1 à ${NAME_MAX} caractères).`);
      ok = false;
    } else setNameError(null);
    const parsed = parseMinAccuracyInput(accuracy);
    if (!parsed.ok || parsed.value === null) {
      setAccuracyError(parsed.error ?? 'Seuil invalide.');
      ok = false;
    } else setAccuracyError(null);
    if (description.length > DESCRIPTION_MAX) {
      setError(`La description ne peut pas dépasser ${DESCRIPTION_MAX} caractères.`);
      ok = false;
    } else setError(null);
    if (!ok || parsed.value === null) return;

    setBusy(true);
    try {
      const desc = description.trim() === '' ? null : description.trim();
      const saved = editing
        ? await workflowsApi.updateEvalSet(editing.wfEvalSetId, {
            name: trimmed,
            description: desc,
            minAccuracy: parsed.value,
            isActive,
          })
        : await workflowsApi.createEvalSet({
            definitionId,
            ...(stepKey ? { stepKey } : {}),
            name: trimmed,
            ...(desc !== null ? { description: desc } : {}),
            minAccuracy: parsed.value,
          });
      onSaved(saved);
    } catch (e) {
      setError(workflowErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? 'Modifier le jeu d’évaluation' : 'Nouveau jeu d’évaluation'}
      okText={editing ? 'Enregistrer' : 'Créer le jeu'}
      cancelText="Annuler"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => {
        if (!busy) onClose();
      }}
      maskClosable={false}
      destroyOnHidden
    >
      <form
        className="wfev-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {error && <Alert type="error" showIcon message={error} role="alert" style={{ marginBottom: 12 }} />}

        <div className="wf-field">
          <label htmlFor="wfev-set-name">Nom du jeu</label>
          <Input
            id="wfev-set-name"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            aria-required="true"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'wfev-set-name-err' : undefined}
            autoFocus
          />
          {nameError && (
            <div id="wfev-set-name-err" className="wfev-field-error" role="alert">
              {nameError}
            </div>
          )}
        </div>

        <div className="wf-field">
          <label htmlFor="wfev-set-desc">Description (facultative)</label>
          <Input.TextArea
            id="wfev-set-desc"
            value={description}
            maxLength={DESCRIPTION_MAX}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="wf-field">
          <label htmlFor="wfev-set-acc">Précision minimale requise</label>
          <Input
            id="wfev-set-acc"
            value={accuracy}
            onChange={(e) => setAccuracy(e.target.value)}
            inputMode="decimal"
            aria-required="true"
            aria-invalid={accuracyError ? true : undefined}
            aria-describedby={accuracyError ? 'wfev-set-acc-hint wfev-set-acc-err' : 'wfev-set-acc-hint'}
          />
          <div id="wfev-set-acc-hint" className="wf-muted">
            En pourcentage (« 85 % ») ou en décimal (« 0,85 »). Plancher imposé : {formatAccuracy(WF_EVAL_ACCURACY_FLOOR)}{' '}
            (un seuil plus bas est refusé). Trois décimales au plus.
          </div>
          {accuracyError && (
            <div id="wfev-set-acc-err" className="wfev-field-error" role="alert">
              {accuracyError}
            </div>
          )}
        </div>

        {editing && (
          <Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)}>
            Jeu actif (un jeu désactivé ne peut pas être évalué)
          </Checkbox>
        )}
      </form>
    </Modal>
  );
}
