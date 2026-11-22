// Docu-Flow — écran « Plafonds et arrêt d'urgence » : logique PURE complémentaire (sans React, sans réseau).
import { isWfBudgetPeriodKind } from '@archivage/types';
import {
  formatAmount,
  parseCapInput,
  parseCurrency,
  parseThresholdInput,
  type BudgetForm,
} from '../../../_lib/budget-logic';

interface RowLike {
  definitionId: number | null;
  periodKind: number;
  capAmount: string | null;
  alertThreshold: string;
  currency: string;
  consumedAmount: string;
}

/** Largeur de la barre de progression (0 à 100, entier) ; une consommation > 100 % reste à 100. */
export function progressPercent(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio)) return 0;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

/** Texte « 72 % du plafond » (la valeur réelle est affichée même au-delà de 100 %). */
export function progressText(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'Aucun plafond défini';
  return `${Math.round(Math.max(0, ratio) * 100)} % du plafond`;
}

/** Seuil d'alerte (fraction décimale en chaîne) en pourcentage lisible (« 80 »). */
export function thresholdToPercentText(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10_000) / 100).replace('.', ',');
}

/** Nom d'un workflow, avec repli « Workflow n° X ». Le nom vient de l'API : texte brut. */
export function workflowDisplayName(definitionId: number | null, names: ReadonlyMap<number, string>): string {
  if (definitionId === null) return 'Plafond global';
  const name = names.get(definitionId);
  return name && name.trim() !== '' ? name : `Workflow n° ${definitionId}`;
}

/** Valeurs initiales du formulaire à partir d'une ligne de budget (plafond vide = pas de plafond). */
export function formFromRow(row: RowLike): BudgetForm {
  return {
    definitionId: row.definitionId,
    capRaw: row.capAmount === null ? '' : String(Number(row.capAmount)).replace('.', ','),
    periodKind: row.periodKind,
    thresholdRaw: thresholdToPercentText(row.alertThreshold),
    currencyRaw: row.currency,
  };
}

export interface FieldErrors {
  cap?: string;
  period?: string;
  threshold?: string;
  currency?: string;
}

/** Erreurs de saisie par champ (mêmes règles que `buildBudgetUpdate`). */
export function fieldErrors(form: BudgetForm): FieldErrors {
  const out: FieldErrors = {};
  const cap = parseCapInput(form.capRaw);
  if (!cap.ok) out.cap = cap.error;
  const thr = parseThresholdInput(form.thresholdRaw);
  if (!thr.ok) out.threshold = thr.error;
  const cur = parseCurrency(form.currencyRaw);
  if (!cur.ok) out.currency = cur.error;
  if (!isWfBudgetPeriodKind(form.periodKind)) out.period = 'Choisissez une période : mensuel, journalier ou cumulé.';
  return out;
}

/** Le nouveau plafond est-il égal ou inférieur à la consommation actuelle (agents bloqués aussitôt) ? */
export function capBlocksImmediately(cap: number | null, consumedAmount: string | number | null | undefined): boolean {
  if (cap === null) return false;
  const used = Number(consumedAmount ?? 0);
  return Number.isFinite(used) && cap <= Math.max(0, used);
}

export function capBlockWarning(cap: number, consumedAmount: string, currency: string): string {
  return (
    `Le nouveau plafond (${formatAmount(cap, currency)}) est inférieur ou égal à la consommation actuelle ` +
    `(${formatAmount(consumedAmount, currency)}) : les agents concernés seront bloqués immédiatement et leurs tâches reviendront à une personne.`
  );
}

/** Workflows proposés pour « Définir un plafond » : ceux qui n'ont pas encore de ligne, triés par nom. */
export function workflowsWithoutBudget(
  definitions: ReadonlyArray<{ wfDefinitionId: number; name: string }>,
  rows: ReadonlyArray<{ definitionId: number | null }>,
): Array<{ value: number; label: string }> {
  const taken = new Set(rows.map((r) => r.definitionId));
  return definitions
    .filter((d) => !taken.has(d.wfDefinitionId))
    .map((d) => ({ value: d.wfDefinitionId, label: d.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/** Auteur d'un arrêt d'urgence (identifiant utilisateur seulement : l'API n'expose pas le nom). */
export function stopAuthorText(by: number | null | undefined): string {
  return typeof by === 'number' ? `utilisateur n° ${by}` : 'auteur inconnu';
}
