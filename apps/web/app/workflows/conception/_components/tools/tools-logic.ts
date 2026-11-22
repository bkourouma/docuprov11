// Docu-Flow — écran « Outils autorisés » : état d'édition des autorisations. Logique PURE (sans React ni réseau).
// S'appuie sur la logique commune de _lib/guardrails-logic.ts (fusion catalogue/autorisations, validation, diff).
import { WfToolSideEffect } from '@archivage/types';
import {
  diffGrants,
  grantsToPayload,
  missingGrants,
  usedToolsByStep,
  validateMaxCalls,
  type GraphLike,
  type GrantPayloadItem,
  type GrantRow,
  type GrantsDiff,
  type MissingGrant,
  type ToolGrantInput,
} from '../../../_lib/guardrails-logic';

/** Ligne éditable : la ligne fusionnée plus le texte brut du plafond (vide = illimité). */
export interface EditRow extends GrantRow {
  maxCallsText: string;
}

export function toEditRows(rows: readonly GrantRow[]): EditRow[] {
  return rows.map((r) => ({ ...r, maxCallsText: r.maxCalls === null ? '' : String(r.maxCalls) }));
}

/** Effet irréversible ou inconnu (traité comme irréversible par prudence). */
export function isIrreversible(sideEffect: number): boolean {
  return sideEffect !== WfToolSideEffect.Read && sideEffect !== WfToolSideEffect.ReversibleWrite;
}

/** Erreur à afficher sous une ligne, ou undefined. Les lignes non cochées ne sont pas contrôlées. */
export function rowError(row: EditRow): string | undefined {
  if (!row.granted) return undefined;
  if (!row.isEnabled) {
    return row.orphan
      ? "Cet outil n'existe plus dans le catalogue : décochez-le pour pouvoir enregistrer."
      : 'Cet outil est désactivé dans le catalogue : décochez-le pour pouvoir enregistrer.';
  }
  const res = validateMaxCalls(row.maxCallsText);
  return res.ok ? undefined : res.error;
}

export function hasBlockingErrors(rows: readonly EditRow[]): boolean {
  return rows.some((r) => rowError(r) !== undefined);
}

/** Corps du PUT. Appeler seulement quand `hasBlockingErrors` est faux. */
export function payloadOf(rows: readonly EditRow[]): GrantPayloadItem[] {
  return grantsToPayload(
    rows.map((r) => {
      const res = validateMaxCalls(r.maxCallsText);
      return { toolKey: r.toolKey, granted: r.granted, maxCalls: res.ok ? res.value : -1 };
    }),
  );
}

function signature(rows: readonly EditRow[]): string {
  return rows
    .filter((r) => r.granted)
    .map((r) => `${r.toolKey}:${r.maxCallsText.trim()}`)
    .sort()
    .join('|');
}

/** Vrai si l'état d'édition diffère de l'état de départ (même une saisie invalide compte comme modification). */
export function isDirty(baseline: readonly EditRow[], rows: readonly EditRow[]): boolean {
  return signature(baseline) !== signature(rows);
}

/** Récapitulatif : différence entre les autorisations enregistrées et l'état d'édition. */
export function diffAgainst(baseline: readonly EditRow[], rows: readonly EditRow[]): GrantsDiff {
  const toInput = (list: readonly EditRow[]): ToolGrantInput[] =>
    list
      .filter((r) => r.granted)
      .map((r) => {
        const res = validateMaxCalls(r.maxCallsText);
        return { toolKey: r.toolKey, maxCallsPerInstance: res.ok ? res.value : null };
      });
  return diffGrants(toInput(baseline), toInput(rows));
}

/** Index « outil -> noms des étapes qui l'utilisent ». */
export function usedByIndex(graph: GraphLike | null | undefined): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const s of usedToolsByStep(graph)) {
    for (const k of s.toolKeys) {
      const names = index.get(k) ?? [];
      if (!names.includes(s.stepName)) names.push(s.stepName);
      index.set(k, names);
    }
  }
  return index;
}

/** « utilisé par l'étape X » / « utilisé par les étapes X, Y ». */
export function usedByLabel(stepNames: readonly string[]): string {
  if (stepNames.length === 0) return '';
  return stepNames.length === 1
    ? `utilisé par l'étape « ${stepNames[0]} »`
    : `utilisé par les étapes ${stepNames.map((n) => `« ${n} »`).join(', ')}`;
}

/** Outils utilisés par le graphe mais non cochés dans l'état d'édition (publication refusée). */
export function missingForRows(graph: GraphLike | null | undefined, rows: readonly EditRow[]): MissingGrant[] {
  return missingGrants(graph, rows.filter((r) => r.granted).map((r) => r.toolKey));
}

export interface AutoGrantResult {
  rows: EditRow[];
  /** Outils nouvellement cochés. */
  added: string[];
  /** Parmi eux, ceux dont l'effet est irréversible (avertissement visible obligatoire). */
  irreversibleAdded: string[];
  /** Utilisés mais désactivés dans le catalogue : non autorisables. */
  disabled: string[];
  /** Utilisés mais absents du catalogue : non autorisables. */
  unknown: string[];
}

/** Coche les outils utilisés par le graphe qui sont activés au catalogue ; ne touche à rien d'autre. */
export function grantUsedTools(rows: readonly EditRow[], graph: GraphLike | null | undefined): AutoGrantResult {
  const used = new Set<string>();
  for (const s of usedToolsByStep(graph)) for (const k of s.toolKeys) used.add(k);
  const added: string[] = [];
  const irreversibleAdded: string[] = [];
  const disabled: string[] = [];
  const known = new Set(rows.filter((r) => !r.orphan).map((r) => r.toolKey));
  const next = rows.map((r) => {
    if (!used.has(r.toolKey) || r.granted || r.orphan) return r;
    if (!r.isEnabled) {
      disabled.push(r.toolKey);
      return r;
    }
    added.push(r.toolKey);
    if (isIrreversible(r.sideEffect)) irreversibleAdded.push(r.toolKey);
    return { ...r, granted: true };
  });
  const unknown = [...used].filter((k) => !known.has(k)).sort();
  return { rows: next, added: added.sort(), irreversibleAdded: irreversibleAdded.sort(), disabled: disabled.sort(), unknown };
}
