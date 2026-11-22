'use client';

import { useId, type ReactNode } from 'react';

export interface PanelFieldProps {
  label: string;
  /** Texte d'aide permanent sous le contrôle. */
  hint?: ReactNode;
  /** Message d'erreur : relié au contrôle via `aria-describedby`. */
  error?: string | null;
  /** Reçoit l'identifiant du contrôle et celui du texte descriptif (aide + erreur). */
  children: (ids: { controlId: string; describedBy: string | undefined }) => ReactNode;
}

/** Champ de panneau : libellé visible relié au contrôle, aide et erreur annoncées avec lui. */
export function PanelField({ label, hint, error, children }: PanelFieldProps) {
  const base = useId();
  const controlId = `${base}-c`;
  const hintId = `${base}-h`;
  const errorId = `${base}-e`;
  const ids = [hint ? hintId : null, error ? errorId : null].filter((v): v is string => v !== null);
  return (
    <div className="wfp-field">
      <label htmlFor={controlId} className="wfp-label">
        {label}
      </label>
      {children({ controlId, describedBy: ids.length > 0 ? ids.join(' ') : undefined })}
      {hint ? (
        <div id={hintId} className="wfp-hint">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="wfp-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
