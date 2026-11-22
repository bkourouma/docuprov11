'use client';

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { stepTypeLabel } from '../../../_lib/labels';
import type { StepNodeData } from '../../../_lib/graph-model';
import { AUTONOMY_OPTIONS } from '../../../_lib/autonomy';
import { issueCountLabel } from './canvas-logic';
import { StepTypeIcon } from './step-visuals';

export type StepFlowNode = Node<StepNodeData, 'step'>;

function autonomyLabel(key: string | undefined): string | undefined {
  return AUTONOMY_OPTIONS.find((o) => o.key === key)?.label;
}

/**
 * Carte d'une étape dans le canevas. Le nom accessible complet est porté par le nœud React Flow lui-même
 * (`ariaLabel` de graphToFlow) : ici tout est visible, la couleur n'est jamais seule (texte « n problèmes »).
 */
function StepNodeImpl({ data, selected }: NodeProps<StepFlowNode>) {
  const { step, isStart, isTerminal, issueCount } = data;
  const autonomy = step.type === 'agent' ? autonomyLabel(step.agent?.autonomy) : undefined;
  const classes = ['wfc-node', selected ? 'wfc-node--selected' : '', issueCount > 0 ? 'wfc-node--issue' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <Handle type="target" position={Position.Left} className="wfc-handle" />
      <div className="wfc-node-type">
        <StepTypeIcon type={step.type} size={16} />
        <span>{stepTypeLabel(step.type)}</span>
      </div>
      <div className="wfc-node-name" title={step.name}>
        {step.name}
      </div>
      {(isStart || isTerminal || autonomy || issueCount > 0) && (
        <div className="wfc-node-badges">
          {isStart && <span className="wfc-badge">Départ</span>}
          {isTerminal && <span className="wfc-badge">Fin</span>}
          {autonomy && <span className="wfc-badge">{autonomy}</span>}
          {issueCount > 0 && <span className="wfc-badge wfc-badge--issue">{issueCountLabel(issueCount)}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="wfc-handle" />
    </div>
  );
}

export const StepNode = memo(StepNodeImpl);

export const stepNodeTypes = { step: StepNode };
