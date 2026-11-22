'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Select } from 'antd';
import { WF_BUDGET_PERIOD_KIND_LABELS, WF_BUDGET_PERIOD_KIND_VALUES, type WfBudgetDto } from '@archivage/types';
import { workflowErrorMessage, workflowsApi } from '../../../../lib/workflows-api';
import { buildBudgetUpdate, type BudgetForm } from '../../../_lib/budget-logic';
import { capBlockWarning, capBlocksImmediately, fieldErrors, formFromRow, type FieldErrors } from './budget-view-logic';

/** Cible de la modification : ligne existante, ou nouveau plafond de workflow (`row` nul, valeurs par défaut). */
export interface EditTarget {
  definitionId: number | null;
  title: string;
  /** Ligne actuelle (consommation) ; nulle pour un workflow sans plafond. */
  row: WfBudgetDto | null;
  /** Valeurs de départ du formulaire. */
  initial: BudgetForm;
}

export function editTargetFromRow(row: WfBudgetDto, title: string): EditTarget {
  return { definitionId: row.definitionId, title, row, initial: formFromRow(row) };
}

const PERIOD_OPTIONS = WF_BUDGET_PERIOD_KIND_VALUES.map((v) => ({ value: v, label: WF_BUDGET_PERIOD_KIND_LABELS[v] }));

export function BudgetEditModal({
  target,
  onClose,
  onSaved,
}: {
  target: EditTarget | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<BudgetForm | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [confirmWarning, setConfirmWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    setForm(target ? { ...target.initial } : null);
    setErrors({});
    setConfirmWarning(null);
    setApiError(null);
    setBusy(false);
  }, [target]);

  const patch = (p: Partial<BudgetForm>) => {
    setForm((f) => (f ? { ...f, ...p } : f));
    setConfirmWarning(null); // toute modification annule la confirmation en attente
  };

  const submit = async (confirmed: boolean) => {
    if (!target || !form) return;
    const found = fieldErrors(form);
    setErrors(found);
    const built = buildBudgetUpdate(form);
    if (!built.ok || !built.input) return;
    const input = built.input;
    if (!confirmed && input.capAmount !== null && capBlocksImmediately(input.capAmount, target.row?.consumedAmount ?? '0')) {
      setConfirmWarning(capBlockWarning(input.capAmount, target.row?.consumedAmount ?? '0', input.currency));
      return;
    }
    setBusy(true);
    setApiError(null);
    try {
      await workflowsApi.updateAgentBudget(input);
      onSaved(`Plafond enregistré : ${target.title}.`);
    } catch (e) {
      setApiError(workflowErrorMessage(e));
      setBusy(false);
    }
  };

  const err = (msg?: string) =>
    msg ? (
      <p className="wfp-error" role="alert">
        {msg}
      </p>
    ) : null;

  return (
    <Modal
      open={target !== null}
      title={target ? `Modifier le plafond : ${target.title}` : ''}
      onCancel={busy ? undefined : onClose}
      footer={null}
      destroyOnHidden
      maskClosable={false}
    >
      {form && target && (
        <form
          className="wfp-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <div className="wfp-field">
            <label htmlFor="wfp-cap">Plafond ({form.currencyRaw.trim() || 'devise'}), vide = pas de plafond</label>
            <Input
              id="wfp-cap"
              inputMode="decimal"
              value={form.capRaw}
              onChange={(e) => patch({ capRaw: e.target.value })}
              status={errors.cap ? 'error' : undefined}
              aria-invalid={Boolean(errors.cap)}
              autoFocus
            />
            {err(errors.cap)}
          </div>
          <div className="wfp-field">
            <label htmlFor="wfp-period">Période</label>
            <Select
              id="wfp-period"
              value={form.periodKind}
              options={PERIOD_OPTIONS}
              onChange={(v) => patch({ periodKind: v })}
              status={errors.period ? 'error' : undefined}
            />
            {err(errors.period)}
          </div>
          <div className="wfp-field">
            <label htmlFor="wfp-threshold">Seuil d’alerte (en %)</label>
            <Input
              id="wfp-threshold"
              inputMode="decimal"
              value={form.thresholdRaw}
              onChange={(e) => patch({ thresholdRaw: e.target.value })}
              status={errors.threshold ? 'error' : undefined}
              aria-invalid={Boolean(errors.threshold)}
            />
            {err(errors.threshold)}
          </div>
          <div className="wfp-field">
            <label htmlFor="wfp-currency">Devise (3 lettres)</label>
            <Input
              id="wfp-currency"
              value={form.currencyRaw}
              maxLength={3}
              onChange={(e) => patch({ currencyRaw: e.target.value.toUpperCase() })}
              status={errors.currency ? 'error' : undefined}
              aria-invalid={Boolean(errors.currency)}
            />
            {err(errors.currency)}
          </div>

          {confirmWarning && (
            <Alert
              type="warning"
              showIcon
              role="alert"
              message="Confirmation nécessaire"
              description={confirmWarning}
            />
          )}
          {apiError && <Alert type="error" showIcon role="alert" message={apiError} />}

          <div className="wfp-confirm-buttons">
            <Button onClick={onClose} disabled={busy}>
              Annuler
            </Button>
            {confirmWarning ? (
              <Button type="primary" danger loading={busy} onClick={() => void submit(true)}>
                Enregistrer quand même
              </Button>
            ) : (
              <Button type="primary" htmlType="submit" loading={busy}>
                Enregistrer
              </Button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
