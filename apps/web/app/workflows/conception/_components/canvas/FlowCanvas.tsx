'use client';

import '@xyflow/react/dist/style.css';
import './canvas.css';

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type AriaLabelConfig,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import { Grid } from 'antd';
import type { WfGraph, WfTaskTypeKey } from '@archivage/types';
import type { WfDefinitionIssue } from '../../../../lib/workflows-api';
import {
  graphToFlow,
  type PositionMap,
  type Position,
  type StepEdgeData,
} from '../../../_lib/graph-model';
import { describeSelection, edgesNotTouching, mergeDraggedPositions, parseDroppedStepType } from './canvas-logic';
import { stepNodeTypes, type StepFlowNode } from './StepNode';
import { STEP_DRAG_MIME, type EditorSelection } from './types';

export interface FlowCanvasProps {
  graph: WfGraph;
  positions: PositionMap;
  issues: WfDefinitionIssue[];
  readOnly: boolean;
  selection: EditorSelection;
  onSelect(sel: EditorSelection): void;
  /** Fin de déplacement (et fin de tout déplacement multiple) : jamais à chaque pixel. */
  onPositionsChange(next: PositionMap): void;
  /** L'erreur éventuelle (auto-boucle, doublon) est gérée par la page. */
  onConnect(from: string, to: string): void;
  onDeleteSteps(keys: string[]): void;
  onDeleteEdges(edges: Array<{ from: string; to: string }>): void;
  /** Position en coordonnées du flux (screenToFlowPosition). */
  onDropStep(type: WfTaskTypeKey, position: Position): void;
}

type StepFlowEdge = Edge<StepEdgeData>;

/** Textes de React Flow en français (contrôles, mini-carte, aides vocales des nœuds et des transitions). */
const ARIA_LABELS: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default':
    'Appuyez sur Entrée ou Espace pour sélectionner l’étape. Suppr pour la retirer, Échap pour annuler.',
  'node.a11yDescription.keyboardDisabled':
    'Appuyez sur Entrée ou Espace pour sélectionner l’étape. Les flèches la déplacent ensuite. Suppr pour la retirer, Échap pour annuler.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) =>
    `Étape déplacée (${direction}). Nouvelle position : x ${Math.round(x)}, y ${Math.round(y)}.`,
  'edge.a11yDescription.default':
    'Appuyez sur Entrée ou Espace pour sélectionner la transition. Suppr pour la retirer, Échap pour annuler.',
  'controls.ariaLabel': 'Commandes du canevas',
  'controls.zoomIn.ariaLabel': 'Zoom avant',
  'controls.zoomOut.ariaLabel': 'Zoom arrière',
  'controls.fitView.ariaLabel': 'Ajuster la vue à toutes les étapes',
  'controls.interactive.ariaLabel': 'Activer ou désactiver les interactions',
  'minimap.ariaLabel': 'Mini-carte du workflow',
  'handle.ariaLabel': 'Point de connexion',
};

const DELETE_KEYS = ['Delete', 'Backspace'];

function CanvasInner({
  graph,
  positions,
  issues,
  readOnly,
  selection,
  onSelect,
  onPositionsChange,
  onConnect,
  onDeleteSteps,
  onDeleteEdges,
  onDropStep,
}: FlowCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();
  const screens = Grid.useBreakpoint();

  // Vue dérivée : la page reste la source de vérité, on ne garde aucune copie métier du graphe.
  const flow = useMemo(() => graphToFlow(graph, positions, issues), [graph, positions, issues]);

  const derivedNodes = useMemo<StepFlowNode[]>(
    () => flow.nodes.map((n) => ({ ...n, selected: selection?.kind === 'step' && selection.key === n.id })),
    [flow.nodes, selection],
  );
  const edges = useMemo<StepFlowEdge[]>(
    () =>
      flow.edges.map((e) => ({
        ...e,
        selected: selection?.kind === 'edge' && selection.from === e.source && selection.to === e.target,
      })),
    [flow.edges, selection],
  );

  // État local des nœuds : seul moyen d'avoir un glisser fluide sans republier le graphe à chaque pixel.
  const [nodes, setNodes] = useState<StepFlowNode[]>(derivedNodes);
  useEffect(() => setNodes(derivedNodes), [derivedNodes]);

  const stepName = useCallback((key: string) => graph.steps.find((s) => s.key === key)?.name, [graph.steps]);

  const onNodesChange = useCallback(
    (changes: NodeChange<StepFlowNode>[]) => {
      // Position/dimensions : état local. Sélection : remontée à la page (clavier compris : Entrée/Espace
      // sélectionnent sans déclencher onNodeClick). Ajout/suppression : gérés par la page via onDelete.
      const local = changes.filter((c) => c.type === 'position' || c.type === 'dimensions');
      if (local.length > 0) setNodes((current) => applyNodeChanges(local, current));
      for (const change of changes) {
        if (change.type === 'select' && change.selected) onSelect({ kind: 'step', key: change.id });
      }
    },
    [onSelect],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<StepFlowEdge>[]) => {
      for (const change of changes) {
        if (change.type !== 'select' || !change.selected) continue;
        const edge = flow.edges.find((e) => e.id === change.id);
        if (edge) onSelect({ kind: 'edge', from: edge.source, to: edge.target });
      }
    },
    [flow.edges, onSelect],
  );

  const handleDragStop = useCallback(
    (_event: unknown, _node: StepFlowNode, dragged: StepFlowNode[]) => {
      onPositionsChange(mergeDraggedPositions(positions, dragged));
    },
    [onPositionsChange, positions],
  );
  const handleSelectionDragStop = useCallback(
    (_event: unknown, dragged: StepFlowNode[]) => {
      onPositionsChange(mergeDraggedPositions(positions, dragged));
    },
    [onPositionsChange, positions],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (!readOnly) onConnect(c.source, c.target);
    },
    [onConnect, readOnly],
  );

  const handleDelete = useCallback(
    ({ nodes: removedNodes, edges: removedEdges }: { nodes: StepFlowNode[]; edges: StepFlowEdge[] }) => {
      if (readOnly) return;
      const keys = removedNodes.map((n) => n.id);
      if (keys.length > 0) onDeleteSteps(keys);
      // Les transitions rattachées à une étape supprimée disparaissent avec elle : la page s'en charge.
      const own = edgesNotTouching(removedEdges, keys);
      if (own.length > 0) onDeleteEdges(own.map((e) => ({ from: e.source, to: e.target })));
    },
    [onDeleteEdges, onDeleteSteps, readOnly],
  );

  const onDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [readOnly],
  );
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (readOnly) return;
      event.preventDefault();
      const type = parseDroppedStepType(event.dataTransfer.getData(STEP_DRAG_MIME));
      if (type === null) return;
      onDropStep(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [onDropStep, readOnly, screenToFlowPosition],
  );

  return (
    <div className="wfc-canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <p id="wfc-canvas-help" className="wfc-sr-only">
        Éditeur graphique. Pour une saisie au clavier ou avec un lecteur d’écran, utilisez la vue liste.
      </p>
      <div className="wfc-sr-only" role="status" aria-live="polite">
        {describeSelection(selection, stepName)}
      </div>
      <ReactFlow<StepFlowNode, StepFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={stepNodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_e, node) => onSelect({ kind: 'step', key: node.id })}
        onEdgeClick={(_e, edge) => onSelect({ kind: 'edge', from: edge.source, to: edge.target })}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={handleDragStop}
        onSelectionDragStop={handleSelectionDragStop}
        onConnect={handleConnect}
        onDelete={handleDelete}
        deleteKeyCode={readOnly ? null : DELETE_KEYS}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        nodesFocusable
        edgesFocusable
        connectionRadius={36}
        ariaLabelConfig={ARIA_LABELS}
        aria-describedby="wfc-canvas-help"
        fitView
        minZoom={0.2}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} />
        <Controls showInteractive={false} />
        {screens.md && <MiniMap pannable zoomable ariaLabel="Mini-carte du workflow" />}
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
