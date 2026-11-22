'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Input, Modal, Select } from 'antd';
import type { WfEvalCaseDto } from '@archivage/types';
import { workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import type { CreateEvalCaseInput } from '../../../../lib/workflows-api';
import {
  EVAL_BLOCK_TEXT_MAX,
  EVAL_CASE_LABEL_MAX,
  EVAL_MAX_BLOCKS,
  EVAL_ORIGINS,
  EVAL_ORIGIN_LABELS,
  emptyEvalCaseDraft,
  evalCaseDraftToPayload,
  evalCaseToDraft,
  type EvalBlockDraft,
  type EvalCaseDraft,
} from '../../../_lib/eval-logic';
import { groupCaseErrors, type CaseFormField } from './evaluation-view-logic';

type Tri = 'unset' | 'yes' | 'no';
const triOf = (v: boolean | null): Tri => (v === null ? 'unset' : v ? 'yes' : 'no');
const triToBool = (t: Tri): boolean | null => (t === 'unset' ? null : t === 'yes');
const TRI_OPTIONS = [
  { value: 'unset', label: 'Non renseigné' },
  { value: 'yes', label: 'Oui' },
  { value: 'no', label: 'Non' },
];
const ORIGIN_OPTIONS = EVAL_ORIGINS.map((o) => ({ value: o, label: EVAL_ORIGIN_LABELS[o] }));

export interface EvalCaseModalProps {
  open: boolean;
  setId: number;
  /** Cas à modifier ; null = ajout. */
  editing: WfEvalCaseDto | null;
  onClose: () => void;
  onSaved: (c: WfEvalCaseDto) => void;
}

function Field({
  id,
  label,
  hint,
  errors,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  errors?: string[];
  children: ReactNode;
}) {
  return (
    <div className="wf-field wfev-field-wide">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && (
        <div id={`${id}-hint`} className="wf-muted">
          {hint}
        </div>
      )}
      {errors?.map((e) => (
        <div key={e} className="wfev-field-error" role="alert">
          {e}
        </div>
      ))}
    </div>
  );
}

/** Formulaire guidé d'un cas d'évaluation ; la validation vient de `evalCaseDraftToPayload` (le serveur revalide). */
export function EvalCaseModal({ open, setId, editing, onClose, onSaved }: EvalCaseModalProps) {
  const [draft, setDraft] = useState<EvalCaseDraft>(emptyEvalCaseDraft());
  const [errors, setErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(editing ? evalCaseToDraft(editing) : emptyEvalCaseDraft());
    setErrors([]);
    setApiError(null);
  }, [open, editing]);

  const byField = useMemo(() => groupCaseErrors(errors), [errors]);
  const fe = (f: CaseFormField) => byField[f];
  const patch = (p: Partial<EvalCaseDraft>) => setDraft((d) => ({ ...d, ...p }));
  const patchBlock = (i: number, p: Partial<EvalBlockDraft>) =>
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b, k) => (k === i ? { ...b, ...p } : b)) }));

  const submit = async () => {
    if (busy) return;
    const res = evalCaseDraftToPayload(draft);
    if (!res.ok || !res.payload) {
      setErrors(res.errors);
      setApiError(null);
      return;
    }
    setErrors([]);
    setApiError(null);
    setBusy(true);
    try {
      // Les origines ont été validées par `evalCaseDraftToPayload` (liste fermée).
      const body = res.payload as CreateEvalCaseInput;
      const saved = editing
        ? await workflowsApi.updateEvalCase(setId, editing.wfEvalCaseId, body)
        : await workflowsApi.addEvalCase(setId, body);
      onSaved(saved);
    } catch (e) {
      setApiError(workflowErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const general = fe('general');

  return (
    <Modal
      open={open}
      title={editing ? 'Modifier le cas' : 'Nouveau cas d’évaluation'}
      okText={editing ? 'Enregistrer le cas' : 'Ajouter le cas'}
      cancelText="Annuler"
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => {
        if (!busy) onClose();
      }}
      maskClosable={false}
      destroyOnHidden
      width={760}
      style={{ maxWidth: 'calc(100vw - 16px)' }}
    >
      <form
        className="wfev-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {apiError && <Alert type="error" showIcon message={apiError} role="alert" style={{ marginBottom: 12 }} />}
        {errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            role="alert"
            style={{ marginBottom: 12 }}
            message={`Le cas n’est pas enregistré : ${errors.length} point${errors.length > 1 ? 's' : ''} à corriger.`}
            description={general ? general.join(' ') : 'Les messages sont affichés sous chaque champ concerné.'}
          />
        )}

        <Field id="wfev-case-label" label="Nom du cas" errors={fe('label')}>
          <Input
            id="wfev-case-label"
            value={draft.label}
            maxLength={EVAL_CASE_LABEL_MAX}
            onChange={(e) => patch({ label: e.target.value })}
            aria-required="true"
            aria-invalid={fe('label') ? true : undefined}
            autoFocus
          />
        </Field>

        <fieldset className="wfev-fieldset">
          <legend>Données fournies à l’agent</legend>
          <p className="wf-muted">
            Blocs de texte tels que l’agent les recevrait (courriel, document, texte reconnu…). Au plus {EVAL_MAX_BLOCKS} blocs.
          </p>
          {draft.blocks.map((b, i) => (
            <div key={i} className="wfev-block">
              <div className="wfev-block-head">
                <strong>Bloc {i + 1}</strong>
                <Button
                  size="small"
                  onClick={() => setDraft((d) => ({ ...d, blocks: d.blocks.filter((_, k) => k !== i) }))}
                  aria-label={`Retirer le bloc ${i + 1}`}
                >
                  Retirer
                </Button>
              </div>
              <div className="wf-field">
                <label htmlFor={`wfev-block-origin-${i}`}>Origine du bloc {i + 1}</label>
                <Select
                  id={`wfev-block-origin-${i}`}
                  value={b.origin}
                  options={ORIGIN_OPTIONS}
                  onChange={(v: string) => patchBlock(i, { origin: v })}
                />
              </div>
              <div className="wf-field">
                <label htmlFor={`wfev-block-title-${i}`}>Titre du bloc {i + 1} (facultatif)</label>
                <Input id={`wfev-block-title-${i}`} value={b.label} onChange={(e) => patchBlock(i, { label: e.target.value })} />
              </div>
              <div className="wf-field">
                <label htmlFor={`wfev-block-text-${i}`}>Texte du bloc {i + 1}</label>
                <Input.TextArea
                  id={`wfev-block-text-${i}`}
                  value={b.text}
                  rows={4}
                  maxLength={EVAL_BLOCK_TEXT_MAX}
                  onChange={(e) => patchBlock(i, { text: e.target.value })}
                />
              </div>
            </div>
          ))}
          {fe('blocks')?.map((e) => (
            <div key={e} className="wfev-field-error" role="alert">
              {e}
            </div>
          ))}
          <Button
            disabled={draft.blocks.length >= EVAL_MAX_BLOCKS}
            onClick={() => setDraft((d) => ({ ...d, blocks: [...d.blocks, { origin: 'document', label: '', text: '' }] }))}
          >
            Ajouter un bloc de données
          </Button>
        </fieldset>

        <fieldset className="wfev-fieldset">
          <legend>Objet lié (facultatif)</legend>
          <div className="wfev-grid2">
            <div className="wf-field">
              <label htmlFor="wfev-subject-type">Type de l’objet</label>
              <Input
                id="wfev-subject-type"
                value={draft.subjectType}
                maxLength={50}
                onChange={(e) => patch({ subjectType: e.target.value })}
              />
            </div>
            <div className="wf-field">
              <label htmlFor="wfev-subject-id">Identifiant de l’objet</label>
              <Input
                id="wfev-subject-id"
                value={draft.subjectId}
                maxLength={50}
                onChange={(e) => patch({ subjectId: e.target.value })}
              />
            </div>
          </div>
          {fe('subject')?.map((e) => (
            <div key={e} className="wfev-field-error" role="alert">
              {e}
            </div>
          ))}
        </fieldset>

        <Field
          id="wfev-case-context"
          label="Contexte (JSON, facultatif)"
          hint={'Un objet JSON, par exemple {"montant": 120}.'}
          errors={fe('context')}
        >
          <Input.TextArea
            id="wfev-case-context"
            value={draft.contextJson}
            rows={3}
            className="wfev-mono"
            spellCheck={false}
            onChange={(e) => patch({ contextJson: e.target.value })}
            aria-invalid={fe('context') ? true : undefined}
            aria-describedby="wfev-case-context-hint"
          />
        </Field>

        <fieldset className="wfev-fieldset">
          <legend>Résultat attendu</legend>
          <p className="wf-muted">Renseignez au moins un critère.</p>
          <div className="wfev-grid2">
            <div className="wf-field">
              <label htmlFor="wfev-exp-human">L’agent doit renvoyer à l’humain</label>
              <Select
                id="wfev-exp-human"
                value={triOf(draft.returnsToHuman)}
                options={TRI_OPTIONS}
                onChange={(v: Tri) => patch({ returnsToHuman: triToBool(v) })}
              />
            </div>
            <div className="wf-field">
              <label htmlFor="wfev-exp-inj">L’agent doit signaler une injection</label>
              <Select
                id="wfev-exp-inj"
                value={triOf(draft.suspicionInjection)}
                options={TRI_OPTIONS}
                onChange={(v: Tri) => patch({ suspicionInjection: triToBool(v) })}
              />
            </div>
          </div>
          <Field
            id="wfev-exp-conf"
            label="Confiance minimale attendue (de 0 à 1, facultative)"
            hint="Par exemple 0,8."
            errors={fe('minConfidence')}
          >
            <Input
              id="wfev-exp-conf"
              value={draft.minConfidence}
              inputMode="decimal"
              onChange={(e) => patch({ minConfidence: e.target.value })}
              aria-invalid={fe('minConfidence') ? true : undefined}
              aria-describedby="wfev-exp-conf-hint"
            />
          </Field>
          <Field
            id="wfev-exp-result"
            label="Résultat attendu (JSON partiel, facultatif)"
            hint={'Seules les clés indiquées sont comparées, par exemple {"categorie": "facture"}.'}
            errors={fe('result')}
          >
            <Input.TextArea
              id="wfev-exp-result"
              value={draft.resultJson}
              rows={3}
              className="wfev-mono"
              spellCheck={false}
              onChange={(e) => patch({ resultJson: e.target.value })}
              aria-invalid={fe('result') ? true : undefined}
              aria-describedby="wfev-exp-result-hint"
            />
          </Field>
          {fe('expected')?.map((e) => (
            <div key={e} className="wfev-field-error" role="alert">
              {e}
            </div>
          ))}
        </fieldset>

        <div className="wfev-grid2">
          <Field id="wfev-case-weight" label="Poids (1 à 1 000, facultatif)" errors={fe('weight')}>
            <Input
              id="wfev-case-weight"
              value={draft.weight ?? ''}
              inputMode="numeric"
              onChange={(e) => patch({ weight: e.target.value })}
              aria-invalid={fe('weight') ? true : undefined}
            />
          </Field>
          <Field id="wfev-case-order" label="Ordre d’affichage (facultatif)" errors={fe('sortOrder')}>
            <Input
              id="wfev-case-order"
              value={draft.sortOrder ?? ''}
              inputMode="numeric"
              onChange={(e) => patch({ sortOrder: e.target.value })}
              aria-invalid={fe('sortOrder') ? true : undefined}
            />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
