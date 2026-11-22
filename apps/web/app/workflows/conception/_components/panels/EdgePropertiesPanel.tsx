'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Input, Popconfirm, Select, Switch } from 'antd';
import { WF_CONDITION_OPS, type WfEdge } from '@archivage/types';
import { formatConditionValue, parseConditionValue } from '../../../_lib/step-config';
import { PanelField } from './PanelField';

type Condition = NonNullable<WfEdge['condition']>;
type ConditionOp = (typeof WF_CONDITION_OPS)[number];

export interface EdgePropertiesPanelProps {
  fromName: string;
  toName: string;
  edge: WfEdge;
  /** Rang parmi les arêtes sortantes (1..count). */
  position: number;
  count: number;
  /** Une AUTRE arête sortante est déjà de repli. */
  hasOtherFallback: boolean;
  readOnly: boolean;
  onChange(patch: {
    label?: string | undefined;
    condition?: WfEdge['condition'] | null;
    isDefault?: boolean | undefined;
  }): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
}

const OP_LABELS: Record<ConditionOp, string> = {
  eq: 'est égal à',
  neq: 'est différent de',
  gt: 'supérieur à',
  gte: 'supérieur ou égal à',
  lt: 'inférieur à',
  lte: 'inférieur ou égal à',
  in: 'fait partie de',
  exists: 'existe',
};

const FIELD_EXAMPLES: readonly string[] = [
  'last.approved',
  'last.choice',
  'steps.<étape>.values.<champ>',
  'input.<donnée>',
];

const DEFAULT_CONDITION: Condition = { field: 'last.approved', op: 'eq', value: true };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Condition reconstruite : `value` absent pour `exists`. */
function buildCondition(field: string, op: ConditionOp, text: string): Condition {
  const value = parseConditionValue(text, op);
  return value === undefined ? { field, op } : { field, op, value };
}

export function EdgePropertiesPanel({
  fromName,
  toName,
  edge,
  position,
  count,
  hasOtherFallback,
  readOnly,
  onChange,
  onMove,
  onRemove,
}: EdgePropertiesPanelProps) {
  const condition = edge.condition;
  // Le texte de la valeur reste local : « a, » ne doit pas être reformaté en « a » pendant la frappe.
  const [valueText, setValueText] = useState(formatConditionValue(condition?.value));

  useEffect(() => {
    if (!condition) return;
    if (!sameJson(parseConditionValue(valueText, condition.op), condition.value)) {
      setValueText(formatConditionValue(condition.value));
    }
  }, [JSON.stringify(condition?.value ?? null), condition?.op]);

  const isFallback = condition === undefined || edge.isDefault === true;
  const fallbackConflict = hasOtherFallback && isFallback;

  return (
    <section className="wfp-panel" aria-labelledby="wfp-edge-title" aria-disabled={readOnly || undefined}>
      <h3 id="wfp-edge-title" className="wfp-title">
        Propriétés de la transition
      </h3>
      <p className="wfp-sentence">
        De <strong>{fromName}</strong> vers <strong>{toName}</strong>
      </p>
      {readOnly ? <div className="wfp-hint">Cette version n&apos;est plus modifiable : lecture seule.</div> : null}

      <PanelField label="Libellé de la transition">
        {({ controlId, describedBy }) => (
          <Input
            id={controlId}
            aria-describedby={describedBy}
            maxLength={200}
            value={edge.label ?? ''}
            disabled={readOnly}
            placeholder="Ex. Accepté"
            onChange={(e) => onChange({ label: e.target.value === '' ? undefined : e.target.value })}
          />
        )}
      </PanelField>

      <div className="wfp-switch-row">
        <Switch
          id="wfp-edge-conditional"
          checked={condition !== undefined}
          disabled={readOnly}
          onChange={(on) => {
            if (on) {
              onChange({ condition: DEFAULT_CONDITION });
              setValueText(formatConditionValue(DEFAULT_CONDITION.value));
            } else onChange({ condition: null });
          }}
        />
        <label htmlFor="wfp-edge-conditional">Conditionnelle</label>
      </div>

      {condition ? (
        <div className="wfp-stack">
          <PanelField
            label="Champ du contexte"
            hint="Chemin pointé dans le contexte du workflow."
            error={condition.field.trim() === '' ? 'Le champ est obligatoire.' : null}
          >
            {({ controlId, describedBy }) => (
              <>
                <Input
                  id={controlId}
                  aria-describedby={describedBy}
                  maxLength={200}
                  value={condition.field}
                  disabled={readOnly}
                  onChange={(e) => onChange({ condition: buildCondition(e.target.value, condition.op, valueText) })}
                />
                <div className="wfp-examples">
                  <span className="wfp-hint">Exemples :</span>
                  {FIELD_EXAMPLES.map((ex) => (
                    <Button
                      key={ex}
                      size="small"
                      type="dashed"
                      disabled={readOnly}
                      onClick={() => onChange({ condition: buildCondition(ex, condition.op, valueText) })}
                    >
                      {ex}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </PanelField>

          <PanelField label="Opérateur">
            {({ controlId, describedBy }) => (
              <Select
                id={controlId}
                aria-describedby={describedBy}
                style={{ width: '100%' }}
                value={condition.op}
                disabled={readOnly}
                options={WF_CONDITION_OPS.map((op) => ({ value: op, label: OP_LABELS[op] }))}
                onChange={(op: ConditionOp) => onChange({ condition: buildCondition(condition.field, op, valueText) })}
              />
            )}
          </PanelField>

          {condition.op !== 'exists' ? (
            <PanelField
              label="Valeur"
              hint={
                condition.op === 'in'
                  ? 'Liste séparée par des virgules, par exemple : urgent, normal.'
                  : 'true, false, un nombre ou du texte. Des guillemets forcent le texte ("true").'
              }
            >
              {({ controlId, describedBy }) => (
                <Input
                  id={controlId}
                  aria-describedby={describedBy}
                  value={valueText}
                  disabled={readOnly}
                  onChange={(e) => {
                    setValueText(e.target.value);
                    onChange({ condition: buildCondition(condition.field, condition.op, e.target.value) });
                  }}
                />
              )}
            </PanelField>
          ) : null}
        </div>
      ) : null}

      <div className="wfp-switch-row">
        <Switch
          id="wfp-edge-default"
          checked={edge.isDefault === true}
          disabled={readOnly}
          aria-describedby="wfp-edge-default-help"
          onChange={(on) => onChange({ isDefault: on ? true : undefined })}
        />
        <label htmlFor="wfp-edge-default">Repli (si aucune condition ne correspond)</label>
      </div>
      <div id="wfp-edge-default-help" className="wfp-hint">
        {condition === undefined
          ? 'Une transition sans condition sert toujours de repli.'
          : 'Suivie seulement si aucune autre condition de l’étape n’est vraie.'}
      </div>
      {fallbackConflict ? (
        <Alert type="warning" showIcon message="Une seule transition de repli est permise par étape" />
      ) : null}

      <div className="wfp-field">
        <span className="wfp-label">
          Ordre d&apos;évaluation : {position} sur {count}
        </span>
        <div className="wfp-inline">
          <Button disabled={readOnly || position <= 1} onClick={() => onMove(-1)}>
            Monter
          </Button>
          <Button disabled={readOnly || position >= count} onClick={() => onMove(1)}>
            Descendre
          </Button>
        </div>
        <div className="wfp-hint">
          Les conditions sont évaluées dans l&apos;ordre ; la première vraie est suivie, sinon le repli.
        </div>
      </div>

      <Popconfirm
        title="Supprimer cette transition ?"
        okText="Supprimer"
        cancelText="Annuler"
        okButtonProps={{ danger: true }}
        disabled={readOnly}
        onConfirm={onRemove}
      >
        <Button danger disabled={readOnly}>
          Supprimer la transition
        </Button>
      </Popconfirm>
    </section>
  );
}
