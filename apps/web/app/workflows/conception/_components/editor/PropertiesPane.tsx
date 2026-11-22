'use client';

import { Button } from 'antd';
import type { WfEdge, WfGraph, WfStep } from '@archivage/types';
import type { WfDefinitionIssue, WfToolCatalogEntry } from '../../../../lib/workflows-api';
import { isFallbackEdge } from '../../../_lib/graph-model';
import type { EditorSelection } from '../canvas/types';
import { EdgePropertiesPanel } from '../panels/EdgePropertiesPanel';
import { hasPassedEvalFor, stepGuardrails, type EditorGuardrails } from '../panels/editor-guardrails';
import { StepPropertiesPanel } from '../panels/StepPropertiesPanel';
import { WorkflowInfoPanel, type WorkflowInfoPanelProps } from './WorkflowInfoPanel';

export interface PropertiesPaneProps {
  graph: WfGraph;
  selection: EditorSelection;
  readOnly: boolean;
  isLowRisk: boolean;
  /** Valeur de repli ; quand `guardrails` est fourni, l'éligibilité vient du statut de l'étape sélectionnée. */
  hasPassedEval: boolean | null;
  /** Évaluation par étape, outils autorisés et droits (absent : comportement historique). */
  guardrails?: EditorGuardrails;
  tools: WfToolCatalogEntry[] | null;
  /** Tous les problèmes (locaux + serveur) : le panneau d'étape ne reçoit que les siens. */
  issues: WfDefinitionIssue[];
  info: WorkflowInfoPanelProps;
  onStepChange(key: string, patch: Partial<Omit<WfStep, 'key' | 'next'>>): void;
  onRenameKey(key: string, newKey: string): string | undefined;
  onSetStart(key: string): void;
  onRemoveStep(key: string): void;
  onEdgeChange(
    from: string,
    to: string,
    patch: { label?: string | undefined; condition?: WfEdge['condition'] | null; isDefault?: boolean | undefined },
  ): void;
  onMoveEdge(from: string, to: string, delta: -1 | 1): void;
  onRemoveEdge(from: string, to: string): void;
  onShowInfo(): void;
}

/** Contenu du panneau de propriétés : étape, transition, ou fiche du workflow. Une `key` par élément. */
export function PropertiesPane(p: PropertiesPaneProps) {
  const sel = p.selection;

  if (sel?.kind === 'step') {
    const step = p.graph.steps.find((s) => s.key === sel.key);
    if (step) {
      const stepIssues = p.issues.filter((i) => i.stepKey === step.key);
      const hasPassedEval = p.guardrails ? hasPassedEvalFor(p.guardrails.stepEvals, step.key) : p.hasPassedEval;
      const guardrails =
        p.guardrails && step.type === 'agent' ? stepGuardrails(p.guardrails, p.graph, step.key, stepIssues) : undefined;
      return (
        <div className="wfe-props-content">
          <Button type="link" size="small" className="wfe-back" onClick={p.onShowInfo}>
            Fiche du workflow
          </Button>
          <StepPropertiesPanel
            key={`step:${step.key}`}
            step={step}
            stepKeys={p.graph.steps.map((s) => s.key)}
            isStart={p.graph.start === step.key}
            readOnly={p.readOnly}
            isLowRisk={p.isLowRisk}
            hasPassedEval={hasPassedEval}
            tools={p.tools}
            issues={stepIssues}
            {...(guardrails ? { guardrails } : {})}
            onChange={(patch) => p.onStepChange(step.key, patch)}
            onRenameKey={(newKey) => p.onRenameKey(step.key, newKey)}
            onSetStart={() => p.onSetStart(step.key)}
            onRemove={() => p.onRemoveStep(step.key)}
          />
        </div>
      );
    }
  }

  if (sel?.kind === 'edge') {
    const source = p.graph.steps.find((s) => s.key === sel.from);
    const target = p.graph.steps.find((s) => s.key === sel.to);
    const index = source ? source.next.findIndex((e) => e.to === sel.to) : -1;
    const edge = source && index >= 0 ? source.next[index] : undefined;
    if (source && target && edge) {
      return (
        <div className="wfe-props-content">
          <Button type="link" size="small" className="wfe-back" onClick={p.onShowInfo}>
            Fiche du workflow
          </Button>
          <EdgePropertiesPanel
            key={`${sel.from}->${sel.to}`}
            fromName={source.name}
            toName={target.name}
            edge={edge}
            position={index + 1}
            count={source.next.length}
            hasOtherFallback={source.next.some((e, i) => i !== index && isFallbackEdge(e))}
            readOnly={p.readOnly}
            onChange={(patch) => p.onEdgeChange(sel.from, sel.to, patch)}
            onMove={(delta) => p.onMoveEdge(sel.from, sel.to, delta)}
            onRemove={() => p.onRemoveEdge(sel.from, sel.to)}
          />
        </div>
      );
    }
  }

  return (
    <div className="wfe-props-content">
      <WorkflowInfoPanel {...p.info} />
    </div>
  );
}
