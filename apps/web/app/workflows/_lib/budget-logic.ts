// Docu-Flow — plafonds de coût des agents et arrêt d'urgence : logique PURE (sans React, sans réseau).
// Les formes d'entrée sont structurelles (WfBudgetDto, WfAgentStatusDto, WfAgentBudgetOverviewDto).
import { WF_BUDGET_PERIOD_KIND_LABELS, isWfBudgetPeriodKind } from '@archivage/types';

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export const BUDGET_CAP_MAX = 9_999_999_999;

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Montant en français avec devise (« 1 234,50 XOF ») ; « — » si absent ou invalide. */
export function formatAmount(value: string | number | null | undefined, currency: string): string {
  const n = toNumber(value);
  if (n === null) return '—';
  const text = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n);
  const cur = (currency ?? '').trim();
  return cur === '' ? text : `${text} ${cur}`;
}

/** Nombre de jetons avec séparateurs français (« 1 234 567 ») ; accepte les entiers décimaux très grands. */
export function formatTokens(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const fmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return fmt.format(BigInt(value.trim()));
  const n = toNumber(value);
  return n === null ? '—' : fmt.format(n);
}

export function periodKindLabel(kind: number): string {
  return isWfBudgetPeriodKind(kind) ? WF_BUDGET_PERIOD_KIND_LABELS[kind] : 'Période inconnue';
}

// ---------------------------------------------------------------------------
// Consommation
// ---------------------------------------------------------------------------

export interface BudgetLike {
  periodKind: number;
  capAmount: string | null;
  consumedAmount: string;
  consumedTokens?: string;
  alertThreshold: string;
  currency: string;
  emergencyStop?: boolean;
}

/**
 * Part du plafond consommée (0 = rien, 1 = plafond atteint) ; null sans plafond. Un plafond de 0 est traité
 * comme atteint (aucune dépense permise) : ratio 1.
 */
export function consumptionRatio(budget: Pick<BudgetLike, 'capAmount' | 'consumedAmount'>): number | null {
  const cap = toNumber(budget.capAmount);
  if (cap === null) return null;
  const used = Math.max(0, toNumber(budget.consumedAmount) ?? 0);
  if (cap <= 0) return 1;
  return used / cap;
}

export type ConsumptionLevelKey = 'ok' | 'attention' | 'depasse';

export interface ConsumptionLevel {
  level: ConsumptionLevelKey;
  /** Libellé texte (le niveau ne doit jamais reposer sur la couleur seule). */
  label: string;
  ratio: number | null;
}

/** Niveau : « attention » dès le seuil d'alerte, « dépassé » dès 100 % du plafond. Seuil invalide : 0,8. */
export function consumptionLevel(budget: Pick<BudgetLike, 'capAmount' | 'consumedAmount' | 'alertThreshold'>): ConsumptionLevel {
  const ratio = consumptionRatio(budget);
  if (ratio === null) return { level: 'ok', label: 'Sans plafond', ratio: null };
  const t = toNumber(budget.alertThreshold);
  const threshold = t === null || t < 0 || t > 1 ? 0.8 : t;
  if (ratio >= 1) return { level: 'depasse', label: 'Plafond atteint ou dépassé', ratio };
  if (ratio >= threshold) return { level: 'attention', label: 'Seuil d\'alerte atteint', ratio };
  return { level: 'ok', label: 'Dans le budget', ratio };
}

/** Pourcentage entier (« 24 % ») ; « — » si nul. */
export function formatPercent(ratio: number | null): string {
  return ratio === null || !Number.isFinite(ratio) ? '—' : `${Math.round(ratio * 100)} %`;
}

/** Phrase de synthèse d'un budget. */
export function describeBudget(budget: BudgetLike): string {
  const period = periodKindLabel(budget.periodKind);
  const used = formatAmount(budget.consumedAmount, budget.currency);
  const tokens = budget.consumedTokens !== undefined ? `, ${formatTokens(budget.consumedTokens)} jetons` : '';
  const lvl = consumptionLevel(budget);
  let text: string;
  if (lvl.ratio === null) {
    text = `${period} : ${used} consommés${tokens}, sans plafond.`;
  } else {
    text = `${period} : ${used} consommés${tokens} sur ${formatAmount(budget.capAmount, budget.currency)} (${formatPercent(lvl.ratio)}) — ${lvl.label.toLowerCase()}.`;
  }
  if (budget.emergencyStop === true) text += ' Arrêt d\'urgence actif.';
  return text;
}

// ---------------------------------------------------------------------------
// Saisies
// ---------------------------------------------------------------------------

export interface ParsedNumber {
  ok: boolean;
  /** null = champ vide (plafond retiré) ou saisie invalide, selon `ok`. */
  value: number | null;
  error?: string;
}

const cleanNumber = (raw: string): string => (raw ?? '').replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');

/** Plafond : vide = retirer le plafond (null) ; sinon nombre de 0 à 9 999 999 999, 4 décimales au plus. */
export function parseCapInput(raw: string): ParsedNumber {
  const s = cleanNumber(raw);
  if (s === '') return { ok: true, value: null };
  if (!/^\d*\.?\d+$/.test(s)) {
    return { ok: false, value: null, error: 'Saisissez un montant positif (par exemple 5000 ou 12,5), ou laissez vide pour retirer le plafond.' };
  }
  const decimals = s.includes('.') ? s.split('.')[1]!.length : 0;
  if (decimals > 4) return { ok: false, value: null, error: 'Le montant accepte au plus 4 décimales.' };
  const n = Number(s);
  if (n > BUDGET_CAP_MAX) {
    return { ok: false, value: null, error: `Le plafond ne peut pas dépasser ${BUDGET_CAP_MAX.toLocaleString('fr-FR')}.` };
  }
  return { ok: true, value: n };
}

/** Seuil d'alerte saisi en pourcentage (0 à 100, « 80 » ou « 80 % ») converti en fraction (0 à 1). */
export function parseThresholdInput(raw: string): ParsedNumber {
  const s = cleanNumber((raw ?? '').replace('%', ''));
  if (s === '') return { ok: false, value: null, error: 'Saisissez un pourcentage entre 0 et 100 (par exemple 80).' };
  if (!/^\d*\.?\d+$/.test(s)) return { ok: false, value: null, error: 'Le seuil doit être un pourcentage entre 0 et 100.' };
  const n = Number(s);
  if (n > 100) return { ok: false, value: null, error: 'Le seuil doit être compris entre 0 et 100 %.' };
  return { ok: true, value: Math.round(n * 100) / 10_000 };
}

export interface ParsedCurrency {
  ok: boolean;
  value: string | null;
  error?: string;
}

/** Devise : 3 lettres (les minuscules sont converties en majuscules). */
export function parseCurrency(raw: string): ParsedCurrency {
  const s = (raw ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return { ok: false, value: null, error: 'Devise attendue : 3 lettres (par exemple XOF).' };
  return { ok: true, value: s };
}

export interface BudgetForm {
  /** null = budget global. */
  definitionId: number | null;
  capRaw: string;
  periodKind: number;
  thresholdRaw: string;
  currencyRaw: string;
}

export interface BudgetUpdateInput {
  definitionId: number | null;
  capAmount: number | null;
  periodKind: 0 | 1 | 2;
  alertThreshold: number;
  currency: string;
}

export interface BudgetUpdateResult {
  ok: boolean;
  input?: BudgetUpdateInput;
  errors: string[];
}

/** Corps de mise à jour d'un budget (tous les champs sont envoyés : un plafond vide retire le plafond). */
export function buildBudgetUpdate(form: BudgetForm): BudgetUpdateResult {
  const errors: string[] = [];
  const cap = parseCapInput(form.capRaw);
  if (!cap.ok && cap.error) errors.push(cap.error);
  const thr = parseThresholdInput(form.thresholdRaw);
  if (!thr.ok && thr.error) errors.push(thr.error);
  const cur = parseCurrency(form.currencyRaw);
  if (!cur.ok && cur.error) errors.push(cur.error);
  if (!isWfBudgetPeriodKind(form.periodKind)) errors.push('Choisissez une période : mensuel, journalier ou cumulé.');
  if (form.definitionId !== null && !(Number.isInteger(form.definitionId) && form.definitionId > 0)) {
    errors.push('Workflow invalide.');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    input: {
      definitionId: form.definitionId,
      capAmount: cap.value,
      periodKind: form.periodKind as 0 | 1 | 2,
      alertThreshold: thr.value as number,
      currency: cur.value as string,
    },
  };
}

// ---------------------------------------------------------------------------
// Arrêt d'urgence
// ---------------------------------------------------------------------------

export const EMERGENCY_STOP_CONFIRM_WORD = 'ARRÊT';
export const STOP_REASON_MAX = 500;

/** Portée de l'arrêt : null = global ; `name` facultatif pour nommer le workflow. */
export function emergencyStopScopeLabel(definitionId: number | null | undefined, name?: string | null): string {
  if (definitionId === null || definitionId === undefined) return 'Tous les workflows (arrêt global)';
  const n = typeof name === 'string' && name.trim() !== '' ? ` « ${name.trim()} »` : '';
  return `Workflow n° ${definitionId}${n}`;
}

const fold = (s: string): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase();

/** Le mot retapé correspond (insensible à la casse et aux accents, espaces rognés). Un mot attendu vide ne valide jamais. */
export function canConfirmEmergencyStop(input: { typed: string; expected?: string }): boolean {
  const expected = fold(input.expected ?? EMERGENCY_STOP_CONFIRM_WORD);
  return expected !== '' && fold(input.typed) === expected;
}

export interface StopReasonResult {
  ok: boolean;
  /** Motif rogné (chaîne vide si absent). */
  value: string;
  error?: string;
  /** Avis non bloquant : un motif est recommandé pour l'activation. */
  warning?: string;
}

/** Motif de l'arrêt : 500 caractères au plus ; recommandé (non obligatoire) à l'activation. */
export function validateStopReason(raw: string, active = true): StopReasonResult {
  const value = (raw ?? '').trim();
  if (value.length > STOP_REASON_MAX) {
    return { ok: false, value, error: `Le motif dépasse ${STOP_REASON_MAX} caractères.` };
  }
  if (value === '' && active) {
    return { ok: true, value, warning: 'Indiquer un motif est recommandé : il sera conservé dans le journal.' };
  }
  return { ok: true, value };
}

/** Conséquences de l'activation ou de la levée de l'arrêt d'urgence. */
export function emergencyStopWarning(scope: number | null | undefined, active: boolean): string {
  const target = scope === null || scope === undefined ? 'tous les workflows' : `le workflow n° ${scope}`;
  if (!active) {
    return `Lever l'arrêt d'urgence pour ${target} : les agents reprennent et pourront de nouveau appeler le modèle d'IA, dans la limite des plafonds.`;
  }
  return (
    `Arrêt d'urgence pour ${target} : plus aucun appel au modèle d'IA ne sera effectué. ` +
    'Un agent en cours s\'arrête au pas suivant, et les tâches reviennent à une personne. ' +
    'Lever l\'arrêt permet la reprise.'
  );
}

/** Phrase d'état de l'IA et des arrêts d'urgence. */
export function statusSummary(
  status: { aiEnabled: boolean; aiMode?: number; emergencyStopGlobal: boolean } | null | undefined,
  overview: { global: { emergencyStop?: boolean }; workflows: ReadonlyArray<{ emergencyStop?: boolean }> } | null | undefined,
): string {
  if (!status) return 'État de l\'IA indisponible.';
  const globalStop = status.emergencyStopGlobal === true || overview?.global?.emergencyStop === true;
  const stopped = overview ? overview.workflows.filter((w) => w.emergencyStop === true).length : 0;
  const parts: string[] = [status.aiEnabled ? 'L\'IA est active.' : 'L\'IA est désactivée.'];
  parts.push(globalStop ? 'Arrêt d\'urgence global actif : aucun agent ne fonctionne.' : 'Aucun arrêt d\'urgence global.');
  if (!overview) parts.push('Workflows à l\'arrêt : information indisponible.');
  else if (stopped === 0) parts.push('Aucun workflow à l\'arrêt.');
  else parts.push(`${stopped} ${stopped > 1 ? 'workflows sont à l\'arrêt' : 'workflow est à l\'arrêt'}.`);
  return parts.join(' ');
}
