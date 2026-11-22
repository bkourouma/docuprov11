'use client';

import { useEffect, useState } from 'react';
import { Alert, Input, InputNumber, Switch } from 'antd';
import { wfEscalationConfigSchema, type WfEscalationConfig, type WfStep } from '@archivage/types';
import { PanelField } from './PanelField';
import { AssigneeFields } from './AssigneeFields';
import { HoursInput } from './HoursInput';

export interface EscalationFieldsProps {
  value: WfEscalationConfig | undefined;
  readOnly: boolean;
  onChange(next: WfEscalationConfig | undefined): void;
}

interface Draft {
  assignee: WfStep['assignee'];
  dueInHours: number | undefined;
  maxEscalations: number;
  message: string;
}

const EMPTY: Draft = { assignee: undefined, dueInHours: undefined, maxEscalations: 1, message: '' };

const fromValue = (v: WfEscalationConfig): Draft => ({
  assignee: { kind: v.assignee.kind, id: v.assignee.id },
  dueInHours: v.dueInHours,
  maxEscalations: v.maxEscalations ?? 1,
  message: v.message ?? '',
});

/** Valeur conforme à `wfEscalationConfigSchema`, ou undefined tant que la saisie est incomplète. */
function toValue(d: Draft): WfEscalationConfig | undefined {
  const a = d.assignee;
  const parsed = wfEscalationConfigSchema.safeParse({
    assignee: a && a.id !== undefined ? { kind: a.kind, id: a.id } : undefined,
    dueInHours: d.dueInHours,
    maxEscalations: d.maxEscalations,
    ...(d.message.trim() !== '' ? { message: d.message } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

const TARGET_KINDS = ['user', 'group', 'role'] as const;

/**
 * Escalade à l'échéance. L'état local garde la saisie tant qu'elle est incomplète : seules des valeurs
 * conformes au schéma partagé sont émises (une valeur devenue incomplète émet `undefined`).
 */
export function EscalationFields({ value, readOnly, onChange }: EscalationFieldsProps) {
  const [enabled, setEnabled] = useState(value !== undefined);
  const [draft, setDraft] = useState<Draft>(value ? fromValue(value) : EMPTY);

  // Changement externe de la valeur (autre étape, annulation) : la saisie suit.
  const valueKey = JSON.stringify(value ?? null);
  useEffect(() => {
    if (value !== undefined) {
      setEnabled(true);
      setDraft((prev) => (JSON.stringify(toValue(prev) ?? null) === valueKey ? prev : fromValue(value)));
    }
  }, [valueKey]);

  const update = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    const out = toValue(next);
    if (out !== undefined || value !== undefined) onChange(out);
  };

  const complete = toValue(draft) !== undefined;

  return (
    <fieldset className="wfp-section" aria-disabled={readOnly || undefined} disabled={readOnly}>
      <legend className="wfp-legend">Escalade</legend>
      <div className="wfp-switch-row">
        <Switch
          id="wfp-escalation-switch"
          checked={enabled}
          disabled={readOnly}
          aria-describedby="wfp-escalation-help"
          onChange={(on) => {
            setEnabled(on);
            if (!on) {
              setDraft(EMPTY);
              onChange(undefined);
            }
          }}
        />
        <label htmlFor="wfp-escalation-switch">Escalader si l&apos;échéance est dépassée</label>
      </div>
      <div id="wfp-escalation-help" className="wfp-hint">
        Sans escalade, la tâche expire et le workflow est suspendu.
      </div>

      {enabled ? (
        <div className="wfp-stack">
          <AssigneeFields
            value={draft.assignee}
            readOnly={readOnly}
            kinds={TARGET_KINDS}
            allowNone={false}
            onChange={(assignee) => update({ assignee })}
          />
          <HoursInput
            label="Délai avant nouvelle échéance (obligatoire)"
            value={draft.dueInHours}
            disabled={readOnly}
            hint="Heures accordées à la personne qui reçoit la tâche escaladée."
            invalidMessage="Le délai est obligatoire : un entier d'heures entre 1 et 8760."
            onCommit={(dueInHours) => update({ dueInHours })}
          />
          <PanelField label="Nombre maximal d'escalades" hint="Entre 1 et 5 ; ensuite la tâche expire.">
            {({ controlId, describedBy }) => (
              <InputNumber
                id={controlId}
                aria-describedby={describedBy}
                style={{ width: '100%' }}
                min={1}
                max={5}
                precision={0}
                value={draft.maxEscalations}
                disabled={readOnly}
                onChange={(v) => {
                  if (typeof v === 'number' && Number.isInteger(v)) update({ maxEscalations: Math.min(5, Math.max(1, v)) });
                }}
              />
            )}
          </PanelField>
          <PanelField label="Message ajouté à la notification">
            {({ controlId, describedBy }) => (
              <Input.TextArea
                id={controlId}
                aria-describedby={describedBy}
                rows={2}
                maxLength={500}
                showCount
                value={draft.message}
                disabled={readOnly}
                onChange={(e) => update({ message: e.target.value })}
              />
            )}
          </PanelField>
          {!complete && !readOnly ? (
            <Alert
              type="warning"
              showIcon
              message="Escalade incomplète : elle ne sera enregistrée qu'une fois la cible et le délai renseignés"
            />
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
