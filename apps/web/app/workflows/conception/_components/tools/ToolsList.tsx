'use client';

import {
  CheckCircleOutlined,
  EditOutlined,
  EyeOutlined,
  StopOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import { WfToolSideEffect } from '@archivage/types';
import { sideEffectLabel, toolRiskNote } from '../../../_lib/guardrails-logic';
import { rowError, usedByLabel, type EditRow } from './tools-logic';

export interface ToolsListProps {
  rows: readonly EditRow[];
  /** Outil -> noms des étapes de la dernière version qui l'utilisent. */
  usedBy: ReadonlyMap<string, readonly string[]>;
  busy?: boolean;
  onToggle(toolKey: string, granted: boolean): void;
  onMaxCalls(toolKey: string, text: string): void;
}

function effectIcon(sideEffect: number): ReactNode {
  if (sideEffect === WfToolSideEffect.Read) return <EyeOutlined aria-hidden="true" />;
  if (sideEffect === WfToolSideEffect.ReversibleWrite) return <EditOutlined aria-hidden="true" />;
  return <WarningOutlined aria-hidden="true" />;
}

function effectClass(sideEffect: number): string {
  if (sideEffect === WfToolSideEffect.Read) return 'wft-effect wft-effect--read';
  if (sideEffect === WfToolSideEffect.ReversibleWrite) return 'wft-effect wft-effect--write';
  return 'wft-effect wft-effect--danger';
}

/** Identifiant HTML sûr dérivé de la clé (texte venant de l'API : on ne garde que des caractères inoffensifs). */
function safeId(key: string, index: number): string {
  return `wft-${index}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * Liste des outils du catalogue fusionnés aux autorisations. Un seul balisage : tableau sur grand écran,
 * cartes empilées sous 768 px (CSS). Tout texte de l'API est affiché en texte brut (échappé par React).
 */
export function ToolsList({ rows, usedBy, busy = false, onToggle, onMaxCalls }: ToolsListProps) {
  return (
    <table className="wft-table">
      <caption className="wf-sr-only">Outils du catalogue et autorisations pour ce workflow</caption>
      <thead>
        <tr>
          <th scope="col">Autoriser</th>
          <th scope="col">Outil</th>
          <th scope="col">Effet</th>
          <th scope="col">Validation humaine</th>
          <th scope="col">Statut</th>
          <th scope="col">Plafond d&apos;appels par instance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const id = safeId(r.toolKey, i);
          const usedNames = usedBy.get(r.toolKey) ?? [];
          const error = rowError(r);
          const availabilityError = error !== undefined && r.granted && !r.isEnabled ? error : undefined;
          const maxError = error !== undefined && !availabilityError ? error : undefined;
          const cannotGrant = !r.granted && !r.isEnabled;
          const checkDisabled = busy || cannotGrant;
          const descIds = [
            availabilityError ? `${id}-avail` : null,
            cannotGrant ? `${id}-why` : null,
            usedNames.length > 0 ? `${id}-used` : null,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <tr key={r.toolKey} className={r.granted ? 'wft-row wft-row--granted' : 'wft-row'}>
              <td data-label="Autoriser" className="wft-cell-check">
                <input
                  id={`${id}-check`}
                  type="checkbox"
                  className="wft-checkbox"
                  checked={r.granted}
                  disabled={checkDisabled}
                  aria-describedby={descIds || undefined}
                  onChange={(e) => onToggle(r.toolKey, e.target.checked)}
                />
                <label htmlFor={`${id}-check`} className="wft-check-label">
                  Autoriser<span className="wf-sr-only"> l&apos;outil {r.label}</span>
                </label>
              </td>
              <th scope="row" data-label="Outil" className="wft-cell-tool">
                <div className="wft-tool-inner">
                <span className="wft-tool-label">{r.label}</span>
                <code className="wft-tool-key">{r.toolKey}</code>
                {r.description ? <span className="wft-tool-desc">{r.description}</span> : null}
                {usedNames.length > 0 ? (
                  <span id={`${id}-used`} className="wft-used">
                    {usedByLabel(usedNames)}
                  </span>
                ) : null}
                {cannotGrant ? (
                  <span id={`${id}-why`} className="wft-note">
                    Désactivé dans le catalogue : cet outil ne peut pas être autorisé tant qu&apos;un administrateur ne
                    l&apos;a pas réactivé.
                  </span>
                ) : null}
                {availabilityError ? (
                  <span id={`${id}-avail`} className="wft-error">
                    {availabilityError}
                  </span>
                ) : null}
                </div>
              </th>
              <td data-label="Effet">
                <span className={effectClass(r.sideEffect)}>
                  {effectIcon(r.sideEffect)} {sideEffectLabel(r.sideEffect)}
                </span>
                <span className="wft-note">{toolRiskNote(r)}</span>
              </td>
              <td data-label="Validation humaine">{r.requiresValidation ? 'Requise' : 'Non requise'}</td>
              <td data-label="Statut">
                {r.orphan ? (
                  <span className="wft-status wft-status--off">
                    <StopOutlined aria-hidden="true" /> Absent du catalogue
                  </span>
                ) : r.isEnabled ? (
                  <span className="wft-status wft-status--on">
                    <CheckCircleOutlined aria-hidden="true" /> Activé
                  </span>
                ) : (
                  <span className="wft-status wft-status--off">
                    <StopOutlined aria-hidden="true" /> Désactivé
                  </span>
                )}
              </td>
              <td data-label="Plafond d'appels par instance">
                <label htmlFor={`${id}-max`} className="wf-sr-only">
                  Plafond d&apos;appels par instance pour {r.label} (vide : illimité)
                </label>
                <input
                  id={`${id}-max`}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  className="wft-input"
                  placeholder="Illimité"
                  value={r.maxCallsText}
                  disabled={busy || !r.granted}
                  aria-invalid={maxError ? true : undefined}
                  aria-describedby={maxError ? `${id}-max-err` : undefined}
                  onChange={(e) => onMaxCalls(r.toolKey, e.target.value)}
                />
                {maxError ? (
                  <span id={`${id}-max-err`} className="wft-error">
                    {maxError}
                  </span>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
