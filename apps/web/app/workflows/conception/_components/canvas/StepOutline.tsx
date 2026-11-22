'use client';

import { useId, useState } from 'react';
import { Button, Popconfirm, Select } from 'antd';
import type { WfGraph, WfTaskTypeKey } from '@archivage/types';
import type { WfDefinitionIssue } from '../../../../lib/workflows-api';
import { listStepOutline, stepAriaLabel, type OutlineEntry } from '../../../_lib/graph-model';
import { stepTypeLabel } from '../../../_lib/labels';
import { groupIssuesByStep } from '../../../_lib/graph-issues';
import { PALETTE_ITEMS, issueCountLabel } from './canvas-logic';
import { StepTypeIcon } from './step-visuals';
import type { EditorSelection } from './types';

export interface StepOutlineProps {
  graph: WfGraph;
  issues: WfDefinitionIssue[];
  selection: EditorSelection;
  readOnly: boolean;
  onSelect(sel: EditorSelection): void;
  onAddStep(type: WfTaskTypeKey, afterKey?: string): void;
  /** Renvoie un message d'erreur en français à afficher, ou undefined si la transition est créée. */
  onAddEdge(from: string, to: string): string | undefined;
  onRemoveStep(key: string): void;
  onRemoveEdge(from: string, to: string): void;
}

const TYPE_OPTIONS = PALETTE_ITEMS.map(({ type, description }) => ({
  value: type,
  label: `${stepTypeLabel(type)} — ${description}`,
}));

interface OutlineStepProps {
  entry: OutlineEntry;
  graph: WfGraph;
  issueCount: number;
  selection: EditorSelection;
  readOnly: boolean;
  isLast: boolean;
  onSelect(sel: EditorSelection): void;
  onAddStep(type: WfTaskTypeKey, afterKey?: string): void;
  onAddEdge(from: string, to: string): string | undefined;
  onRemoveStep(key: string): void;
  onRemoveEdge(from: string, to: string): void;
}

function OutlineStep({
  entry,
  graph,
  issueCount,
  selection,
  readOnly,
  isLast,
  onSelect,
  onAddStep,
  onAddEdge,
  onRemoveStep,
  onRemoveEdge,
}: OutlineStepProps) {
  const uid = useId();
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const step = graph.steps.find((s) => s.key === entry.key);
  const selected = selection?.kind === 'step' && selection.key === entry.key;
  const label = step ? stepAriaLabel(graph, step) : entry.name;
  const accessibleName = issueCount > 0 ? `${label} ${issueCountLabel(issueCount)}.` : label;

  // Cibles possibles d'une nouvelle transition : toutes les autres étapes pas déjà reliées dans ce sens.
  const linked = new Set(entry.next.map((n) => n.to));
  const targetOptions = graph.steps
    .filter((s) => s.key !== entry.key && !linked.has(s.key))
    .map((s) => ({ value: s.key, label: s.name }));

  const submitEdge = () => {
    if (target === undefined) {
      setError('Choisissez l’étape vers laquelle relier.');
      return;
    }
    const message = onAddEdge(entry.key, target);
    setError(message);
    if (message === undefined) setTarget(undefined);
  };

  const errorId = `${uid}-error`;

  return (
    <li className={`wfc-outline-step${selected ? ' wfc-outline-step--selected' : ''}`}>
      <button
        type="button"
        className="wfc-outline-select"
        aria-current={selected ? 'true' : undefined}
        aria-label={accessibleName}
        onClick={() => onSelect({ kind: 'step', key: entry.key })}
      >
        <span className="wfc-outline-icon">
          <StepTypeIcon type={entry.type} />
        </span>
        <span className="wfc-outline-main">
          <span className="wfc-outline-type">{entry.typeLabel}</span>
          <span className="wfc-outline-name">{entry.name}</span>
        </span>
        <span className="wfc-outline-badges">
          {entry.isStart && <span className="wfc-badge">Départ</span>}
          {entry.isTerminal && <span className="wfc-badge">Fin</span>}
          {issueCount > 0 && <span className="wfc-badge wfc-badge--issue">{issueCountLabel(issueCount)}</span>}
        </span>
      </button>

      {entry.next.length > 0 && (
        <ul className="wfc-outline-edges" aria-label={`Transitions sortantes de « ${entry.name} »`}>
          {entry.next.map((n) => {
            const edgeSelected =
              selection?.kind === 'edge' && selection.from === entry.key && selection.to === n.to;
            return (
              <li key={n.to} className={`wfc-outline-edge${edgeSelected ? ' wfc-outline-edge--selected' : ''}`}>
                <button
                  type="button"
                  className="wfc-outline-edge-select"
                  aria-current={edgeSelected ? 'true' : undefined}
                  onClick={() => onSelect({ kind: 'edge', from: entry.key, to: n.to })}
                >
                  <span aria-hidden="true">→ </span>
                  <span className="wfc-outline-edge-target">{n.toName}</span>
                  {n.label !== '' && <span className="wfc-outline-edge-label">{n.label}</span>}
                </button>
                {!readOnly && (
                  <Button
                    size="small"
                    type="text"
                    danger
                    className="wfc-touch"
                    aria-label={`Supprimer la transition vers ${n.toName}`}
                    onClick={() => onRemoveEdge(entry.key, n.to)}
                  >
                    Supprimer
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <div className="wfc-outline-actions">
          {targetOptions.length > 0 && (
            <div className="wfc-outline-field">
              <span id={`${uid}-edge-label`} className="wfc-outline-field-label">
                Ajouter une transition
              </span>
              <div className="wfc-outline-inline">
                <Select
                  className="wfc-outline-select-input"
                  placeholder="Étape suivante"
                  aria-labelledby={`${uid}-edge-label`}
                  aria-describedby={error ? errorId : undefined}
                  status={error ? 'error' : undefined}
                  options={targetOptions}
                  value={target}
                  onChange={(value: string) => {
                    setTarget(value);
                    setError(undefined);
                  }}
                />
                <Button className="wfc-touch" onClick={submitEdge}>
                  Relier
                </Button>
              </div>
              {error && (
                <div id={errorId} role="alert" className="wfc-outline-error">
                  {error}
                </div>
              )}
            </div>
          )}

          <div className="wfc-outline-inline wfc-outline-inline--wrap">
            {adding ? (
              <>
                <Select
                  className="wfc-outline-select-input"
                  autoFocus
                  defaultOpen
                  placeholder="Type de l’étape"
                  aria-label={`Type de l’étape à ajouter après « ${entry.name} »`}
                  options={TYPE_OPTIONS}
                  onChange={(type: WfTaskTypeKey) => {
                    setAdding(false);
                    onAddStep(type, entry.key);
                  }}
                />
                <Button className="wfc-touch" type="text" onClick={() => setAdding(false)}>
                  Annuler
                </Button>
              </>
            ) : (
              <Button className="wfc-touch" onClick={() => setAdding(true)}>
                Ajouter une étape après celle-ci
              </Button>
            )}
            <Popconfirm
              title="Supprimer cette étape ?"
              description="Ses transitions seront aussi supprimées."
              okText="Supprimer"
              cancelText="Annuler"
              okButtonProps={{ danger: true }}
              disabled={isLast}
              onConfirm={() => onRemoveStep(entry.key)}
            >
              <Button
                className="wfc-touch"
                danger
                disabled={isLast}
                aria-label={`Supprimer l’étape « ${entry.name} »`}
                title={isLast ? 'Un workflow doit garder au moins une étape.' : undefined}
              >
                Supprimer l’étape
              </Button>
            </Popconfirm>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Liste alternative à la vue graphique : utilisable au clavier, avec un lecteur d'écran et sur petit écran.
 * Reflète le graphe en lecture et offre les mêmes opérations (ajout, liaison, suppression).
 */
export function StepOutline({
  graph,
  issues,
  selection,
  readOnly,
  onSelect,
  onAddStep,
  onAddEdge,
  onRemoveStep,
  onRemoveEdge,
}: StepOutlineProps) {
  const entries = listStepOutline(graph);
  const { byStep } = groupIssuesByStep(issues);
  const [newType, setNewType] = useState<WfTaskTypeKey | undefined>(undefined);
  const lastOnly = graph.steps.length <= 1;

  return (
    <section className="wfc-outline" aria-labelledby="wfc-outline-title">
      <h2 id="wfc-outline-title" className="wfc-outline-title">
        Étapes du workflow
      </h2>
      <ol className="wfc-outline-list">
        {entries.map((entry) => (
          <OutlineStep
            key={entry.key}
            entry={entry}
            graph={graph}
            issueCount={Object.hasOwn(byStep, entry.key) ? (byStep[entry.key]?.length ?? 0) : 0}
            selection={selection}
            readOnly={readOnly}
            isLast={lastOnly}
            onSelect={onSelect}
            onAddStep={onAddStep}
            onAddEdge={onAddEdge}
            onRemoveStep={onRemoveStep}
            onRemoveEdge={onRemoveEdge}
          />
        ))}
      </ol>
      {!readOnly && (
        <div className="wfc-outline-add">
          <span id="wfc-outline-add-label" className="wfc-outline-field-label">
            Ajouter une étape
          </span>
          <div className="wfc-outline-inline">
            <Select
              className="wfc-outline-select-input"
              placeholder="Type de l’étape"
              aria-labelledby="wfc-outline-add-label"
              options={TYPE_OPTIONS}
              value={newType}
              onChange={(type: WfTaskTypeKey) => {
                // Ajout immédiat puis remise à zéro : le sélecteur sert de menu d'actions.
                onAddStep(type);
                setNewType(undefined);
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
