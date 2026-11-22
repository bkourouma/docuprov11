'use client';

import { useEffect, useState } from 'react';
import { InputNumber } from 'antd';
import { HOURS_MAX, HOURS_MIN, isValidHours } from '../../../_lib/step-config';
import { PanelField } from './PanelField';

export interface HoursInputProps {
  label: string;
  value: number | undefined;
  disabled: boolean;
  hint?: string;
  /** Message affiché quand la saisie est hors bornes. */
  invalidMessage?: string;
  /** Appelé uniquement avec un entier valide (1..8760) ou `undefined` (champ vidé). */
  onCommit(next: number | undefined): void;
  /** Avertissement non bloquant (ex. relance après l'échéance). */
  warning?: string | null;
}

/**
 * Saisie d'un nombre d'heures entier 1..8760. L'état local ne sert qu'à garder la saisie en cours tant qu'elle
 * est hors bornes : rien d'invalide n'est jamais émis vers le graphe.
 */
export function HoursInput({ label, value, disabled, hint, invalidMessage, onCommit, warning }: HoursInputProps) {
  const [draft, setDraft] = useState<number | null>(value ?? null);

  useEffect(() => {
    setDraft(value ?? null);
  }, [value]);

  const invalid = draft !== null && !isValidHours(draft);
  const error = invalid
    ? (invalidMessage ?? `Indiquez un nombre entier d'heures entre ${HOURS_MIN} et ${HOURS_MAX}.`)
    : null;

  return (
    <PanelField label={label} hint={hint} error={error}>
      {({ controlId, describedBy }) => (
        <>
          <InputNumber
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            status={invalid ? 'error' : undefined}
            style={{ width: '100%' }}
            min={0}
            max={HOURS_MAX + 1}
            precision={0}
            step={1}
            value={draft}
            disabled={disabled}
            suffix="h"
            placeholder="Aucune"
            onChange={(v) => {
              const next = typeof v === 'number' ? v : null;
              setDraft(next);
              if (next === null) onCommit(undefined);
              else if (isValidHours(next)) onCommit(next);
            }}
          />
          {warning ? (
            <div className="wfp-warning" role="status">
              {warning}
            </div>
          ) : null}
        </>
      )}
    </PanelField>
  );
}
