// Docu-Flow — logique PURE du canevas (aucun React) : testable sans navigateur.
import type { WfTaskTypeKey } from '@archivage/types';
import { isStepTypeKey } from '../../../_lib/labels';
import type { Position, PositionMap } from '../../../_lib/graph-model';
import type { EditorSelection } from './types';

/** Les sept types d'étape proposés dans la palette, avec leur courte description. */
export const PALETTE_ITEMS: ReadonlyArray<{ type: WfTaskTypeKey; description: string }> = [
  { type: 'formulaire', description: 'Saisie de champs' },
  { type: 'generation', description: 'Rédaction assistée' },
  { type: 'checklist', description: 'Liste de contrôle' },
  { type: 'affectation', description: 'Désigne qui traite la suite' },
  { type: 'validation', description: 'Approuver ou refuser avec commentaire' },
  { type: 'decision', description: 'Choix automatique selon des conditions' },
  { type: 'agent', description: 'Un agent IA propose ou agit' },
];

/**
 * Type d'étape lu dans un glisser-déposer. Une valeur inconnue (déposée depuis un autre onglet, une autre
 * application…) est ignorée : on ne fait jamais confiance au contenu du presse-papier de glisser-déposer.
 */
export function parseDroppedStepType(raw: string | null | undefined): WfTaskTypeKey | null {
  if (typeof raw !== 'string') return null;
  return isStepTypeKey(raw) ? raw : null;
}

/** Positions à remonter à la page à la fin d'un déplacement : les anciennes, surchargées par celles des nœuds déplacés. */
export function mergeDraggedPositions(
  current: PositionMap,
  moved: Array<{ id: string; position: Position }>,
): PositionMap {
  const next: PositionMap = { ...current };
  for (const node of moved) {
    const { x, y } = node.position;
    if (Number.isFinite(x) && Number.isFinite(y)) next[node.id] = { x, y };
  }
  return next;
}

/** Retire des transitions supprimées celles qui disparaissent déjà avec une étape supprimée (la page s'en charge). */
export function edgesNotTouching<T extends { source: string; target: string }>(edges: T[], removedKeys: string[]): T[] {
  const removed = new Set(removedKeys);
  return edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
}

/** Phrase annoncée aux lecteurs d'écran (région aria-live) quand la sélection change. */
export function describeSelection(
  selection: EditorSelection,
  nameOf: (key: string) => string | undefined,
): string {
  if (!selection) return 'Aucune sélection.';
  if (selection.kind === 'step') return `Étape « ${nameOf(selection.key) ?? selection.key} » sélectionnée.`;
  const from = nameOf(selection.from) ?? selection.from;
  const to = nameOf(selection.to) ?? selection.to;
  return `Transition de « ${from} » vers « ${to} » sélectionnée.`;
}

/** « 1 problème » / « 3 problèmes » (le texte, jamais la seule couleur). */
export function issueCountLabel(n: number): string {
  return n === 1 ? '1 problème' : `${n} problèmes`;
}
