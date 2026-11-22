// Docu-Flow — évaluation des agents : logique PURE (sans React, sans réseau).
// Reproduit côté client les règles de apps/api/.../eval/eval-expected.ts et eval.dto.ts pour guider la saisie ;
// le serveur reste l'autorité (il revalide tout).
import { WF_EVAL_ACCURACY_FLOOR, WF_EVAL_RUN_STATUS_LABELS, WfEvalRunStatus, isWfEvalRunStatus } from '@archivage/types';

// ---------------------------------------------------------------------------
// Précision
// ---------------------------------------------------------------------------

/** Précision décimale de l'API (« 0.857 ») en pourcentage français (« 85,7 % ») ; « — » si absente ou invalide. */
export function formatAccuracy(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  const clamped = Math.min(1, Math.max(0, n));
  return `${(Math.round(clamped * 1000) / 10).toFixed(1).replace('.', ',')} %`;
}

// ---------------------------------------------------------------------------
// Exécutions (runs)
// ---------------------------------------------------------------------------

export interface EvalRunLike {
  wfEvalRunId?: string;
  status: number;
  totalCases: number;
  passedCases: number;
  accuracy: string | null;
  requiredAccuracy: string;
  passed: boolean;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  results?: unknown;
}

export function evalRunStatusLabel(status: number): string {
  return isWfEvalRunStatus(status) ? WF_EVAL_RUN_STATUS_LABELS[status] : 'Statut inconnu';
}

export type VerdictTone = 'success' | 'error' | 'info' | 'warning';

export interface EvalRunVerdict {
  label: 'Réussi' | 'Échoué' | 'En cours' | 'En erreur';
  tone: VerdictTone;
  detail: string;
}

function casesSentence(passed: number, total: number): string {
  return `${passed} ${passed > 1 ? 'cas réussis' : 'cas réussi'} sur ${total}`;
}

/** Verdict lisible d'un run. Un statut inconnu est traité comme « en erreur » (échec fermé). */
export function evalRunVerdict(run: EvalRunLike): EvalRunVerdict {
  if (run.status === WfEvalRunStatus.Running) {
    return { label: 'En cours', tone: 'info', detail: 'L\'évaluation est en cours : les cas sont jugés un par un.' };
  }
  if (run.status !== WfEvalRunStatus.Completed) {
    const msg = typeof run.errorMessage === 'string' && run.errorMessage.trim() !== '' ? run.errorMessage.trim() : null;
    const partial = run.passedCases > 0 ? ` ${casesSentence(run.passedCases, run.totalCases)} avant l'interruption.` : '';
    return { label: 'En erreur', tone: 'error', detail: `${msg ?? 'L\'évaluation s\'est interrompue sur une erreur.'}${partial}`.trim() };
  }
  if (run.totalCases <= 0) {
    return { label: 'Échoué', tone: 'error', detail: 'Aucun cas n\'a été évalué : le jeu ne contient aucun cas actif.' };
  }
  const detail = `${casesSentence(run.passedCases, run.totalCases)}, précision ${formatAccuracy(run.accuracy)} pour ${formatAccuracy(run.requiredAccuracy)} requis`;
  return run.passed ? { label: 'Réussi', tone: 'success', detail } : { label: 'Échoué', tone: 'error', detail };
}

/** Comparaison d'identifiants décimaux (BigInt côté API) sans perte de précision. */
function compareIds(a: string | undefined, b: string | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Run le plus récent (date de début, puis identifiant) ; null si la liste est vide. */
export function latestRun<T extends Pick<EvalRunLike, 'startedAt'> & { wfEvalRunId?: string }>(
  runs: readonly T[] | null | undefined,
): T | null {
  if (!runs || runs.length === 0) return null;
  let best: T | null = null;
  for (const r of runs) {
    if (best === null) {
      best = r;
      continue;
    }
    const tr = Date.parse(r.startedAt);
    const tb = Date.parse(best.startedAt);
    const a = Number.isNaN(tr) ? -Infinity : tr;
    const b = Number.isNaN(tb) ? -Infinity : tb;
    if (a > b || (a === b && compareIds(r.wfEvalRunId, best.wfEvalRunId) > 0)) best = r;
  }
  return best;
}

export function isRunInProgress(run: Pick<EvalRunLike, 'status'> | null | undefined): boolean {
  return !!run && run.status === WfEvalRunStatus.Running;
}

export const POLL_MIN_MS = 1500;
export const POLL_MAX_MS = 5000;
export const POLL_GIVE_UP_MS = 15 * 60_000;

/** Délai avant la prochaine interrogation : progressif de 1 500 à 5 000 ms (tentative 0 = première attente). */
export function pollDelayMs(attempt: number): number {
  const a = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(POLL_MAX_MS, Math.round(POLL_MIN_MS * Math.pow(1.5, Math.min(a, 20))));
}

/** Continuer à interroger tant que le run est en cours et que 15 minutes ne sont pas écoulées. */
export function shouldKeepPolling(run: Pick<EvalRunLike, 'status'> | null | undefined, elapsedMs: number): boolean {
  if (!isRunInProgress(run)) return false;
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < POLL_GIVE_UP_MS;
}

export interface CaseResult {
  caseId?: number;
  label?: string;
  passed: boolean;
  reason?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Résultats par cas, lus défensivement dans `run.results` (forme réelle : `{ cases: [{ caseId, passed, reason? … }] }`).
 * Toute forme inattendue donne []. Ne lève jamais.
 */
export function perCaseResults(results: unknown): CaseResult[] {
  try {
    if (!isObj(results) || !Array.isArray(results.cases)) return [];
    const out: CaseResult[] = [];
    for (const c of results.cases as unknown[]) {
      if (!isObj(c) || typeof c.passed !== 'boolean') continue;
      const item: CaseResult = { passed: c.passed };
      if (typeof c.caseId === 'number' && Number.isFinite(c.caseId)) item.caseId = c.caseId;
      if (typeof c.label === 'string' && c.label !== '') item.label = c.label;
      if (typeof c.reason === 'string' && c.reason !== '') item.reason = c.reason;
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Seuil de précision
// ---------------------------------------------------------------------------

export interface MinAccuracyResult {
  ok: boolean;
  value: number | null;
  error?: string;
}

/** Seuil d'un jeu : décimal de 0 à 1, 3 décimales au plus, virgule ou point ; plancher WF_EVAL_ACCURACY_FLOOR. */
export function parseMinAccuracy(raw: string): MinAccuracyResult {
  const s = (raw ?? '').trim().replace(',', '.');
  if (s === '') return { ok: false, value: null, error: 'Saisissez un seuil de précision (par exemple 0,85).' };
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.$/.test(s)) {
    return { ok: false, value: null, error: 'Le seuil doit être un nombre décimal entre 0 et 1 (par exemple 0,85).' };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n > 1) return { ok: false, value: null, error: 'Le seuil doit être compris entre 0 et 1.' };
  if (Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-9) {
    return { ok: false, value: null, error: 'Le seuil accepte au plus 3 décimales (par exemple 0,857).' };
  }
  const milli = Math.round(n * 1000);
  if (milli < Math.round(WF_EVAL_ACCURACY_FLOOR * 1000)) {
    return {
      ok: false,
      value: null,
      error: `Le seuil ne peut pas être inférieur au plancher de ${formatAccuracy(WF_EVAL_ACCURACY_FLOOR)} (soit ${String(WF_EVAL_ACCURACY_FLOOR).replace('.', ',')}).`,
    };
  }
  return { ok: true, value: milli / 1000 };
}

// ---------------------------------------------------------------------------
// Cas d'évaluation
// ---------------------------------------------------------------------------

export const EVAL_CASE_MAX_BYTES = 64 * 1024;
export const EVAL_CASE_LABEL_MAX = 300;
export const EVAL_BLOCK_LABEL_MAX = 100;
export const EVAL_BLOCK_TEXT_MAX = 20_000;
export const EVAL_MAX_BLOCKS = 10;
export const EVAL_CONTEXT_MAX_CHARS = EVAL_BLOCK_TEXT_MAX;
export const EVAL_MAX_ACTIVE_CASES = 500;
export const EVAL_ORIGINS = ['mail', 'document', 'ocr', 'form', 'context'] as const;
export type EvalOrigin = (typeof EVAL_ORIGINS)[number];

export const EVAL_ORIGIN_LABELS: Record<EvalOrigin, string> = {
  mail: 'Courriel',
  document: 'Document',
  ocr: 'Texte reconnu (OCR)',
  form: 'Formulaire',
  context: 'Contexte',
};

export interface EvalBlockDraft {
  origin: string;
  label: string;
  text: string;
}

export interface EvalCaseDraft {
  label: string;
  blocks: EvalBlockDraft[];
  /** Objet lié (type et identifiant), tous deux facultatifs. */
  subjectType: string;
  subjectId: string;
  /** Contexte : objet JSON saisi en texte ; vide = aucun. */
  contextJson: string;
  /** null = critère non renseigné. */
  returnsToHuman: boolean | null;
  suspicionInjection: boolean | null;
  /** Confiance minimale attendue, saisie brute (« 0,8 ») ; vide = non renseignée. */
  minConfidence: string;
  /** Résultat attendu : objet JSON partiel saisi en texte ; vide = non renseigné. */
  resultJson: string;
  /** Facultatifs, saisie brute. */
  weight?: string;
  sortOrder?: string;
}

export function emptyEvalCaseDraft(): EvalCaseDraft {
  return {
    label: '',
    blocks: [],
    subjectType: '',
    subjectId: '',
    contextJson: '',
    returnsToHuman: null,
    suspicionInjection: null,
    minConfidence: '',
    resultJson: '',
  };
}

export interface EvalCasePayload {
  label: string;
  input: {
    untrusted?: Array<{ label: string; origin: string; text: string }>;
    subject?: { type: string | null; id: string | null };
    context?: Record<string, unknown>;
  };
  expected: {
    result?: Record<string, unknown>;
    returnsToHuman?: boolean;
    suspicionInjection?: boolean;
    minConfidence?: number;
  };
  weight?: number;
  sortOrder?: number;
}

export interface EvalCaseDraftResult {
  ok: boolean;
  payload?: EvalCasePayload;
  errors: string[];
}

/** Un nouveau cas actif est possible tant que le jeu compte moins de 500 cas actifs. */
export function canAddCase(activeCount: number): boolean {
  return Number.isFinite(activeCount) && activeCount < EVAL_MAX_ACTIVE_CASES;
}

function parseJsonObject(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const v: unknown = JSON.parse(raw);
    return isObj(v) ? { ok: true, value: v } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function parseBoundedInt(raw: string | undefined, min: number, max: number): number | null | 'invalid' {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return 'invalid';
  const n = Number(s);
  return n >= min && n <= max ? n : 'invalid';
}

/**
 * Transforme le formulaire en corps d'API en appliquant les règles du serveur. Les erreurs sont toutes
 * collectées (pas seulement la première). Un bloc sans titre prend son type comme titre (« mail », « document »…).
 */
export function evalCaseDraftToPayload(draft: EvalCaseDraft): EvalCaseDraftResult {
  const errors: string[] = [];

  const label = (draft.label ?? '').trim();
  if (label === '') errors.push('Le nom du cas est obligatoire.');
  else if (label.length > EVAL_CASE_LABEL_MAX) errors.push(`Le nom du cas dépasse ${EVAL_CASE_LABEL_MAX} caractères.`);

  const input: EvalCasePayload['input'] = {};
  const blocks = Array.isArray(draft.blocks) ? draft.blocks : [];
  if (blocks.length > EVAL_MAX_BLOCKS) errors.push(`Un cas accepte au plus ${EVAL_MAX_BLOCKS} blocs de données.`);
  else if (blocks.length > 0) {
    const out: Array<{ label: string; origin: string; text: string }> = [];
    blocks.forEach((b, i) => {
      const n = i + 1;
      const origin = (EVAL_ORIGINS as readonly string[]).includes(b.origin) ? b.origin : null;
      if (origin === null) errors.push(`Bloc ${n} : origine inconnue.`);
      const blockLabel = (b.label ?? '').trim() || origin || `bloc ${n}`;
      if (blockLabel.length > EVAL_BLOCK_LABEL_MAX) errors.push(`Bloc ${n} : le titre dépasse ${EVAL_BLOCK_LABEL_MAX} caractères.`);
      const text = b.text ?? '';
      if (text.length > EVAL_BLOCK_TEXT_MAX) {
        errors.push(`Bloc ${n} : le texte dépasse ${EVAL_BLOCK_TEXT_MAX.toLocaleString('fr-FR')} caractères.`);
      }
      if (origin !== null) out.push({ label: blockLabel, origin, text });
    });
    input.untrusted = out;
  }

  const subjectType = (draft.subjectType ?? '').trim();
  const subjectId = (draft.subjectId ?? '').trim();
  if (subjectType !== '' || subjectId !== '') {
    if (subjectType.length > 50) errors.push('Objet lié : le type dépasse 50 caractères.');
    if (subjectId.length > 50) errors.push('Objet lié : l\'identifiant dépasse 50 caractères.');
    input.subject = { type: subjectType === '' ? null : subjectType, id: subjectId === '' ? null : subjectId };
  }

  const ctxRaw = (draft.contextJson ?? '').trim();
  if (ctxRaw !== '') {
    const p = parseJsonObject(ctxRaw);
    if (!p.ok) errors.push('Le contexte doit être un objet JSON valide (par exemple {"montant": 120}).');
    else if (JSON.stringify(p.value).length > EVAL_CONTEXT_MAX_CHARS) {
      errors.push(`Le contexte est trop volumineux (${EVAL_CONTEXT_MAX_CHARS.toLocaleString('fr-FR')} caractères au plus).`);
    } else input.context = p.value;
  }

  const expected: EvalCasePayload['expected'] = {};
  const resRaw = (draft.resultJson ?? '').trim();
  if (resRaw !== '') {
    const p = parseJsonObject(resRaw);
    if (!p.ok) errors.push('Le résultat attendu doit être un objet JSON valide (par exemple {"categorie": "facture"}).');
    else if (Object.keys(p.value).length === 0) errors.push('Le résultat attendu ne peut pas être vide.');
    else expected.result = p.value;
  }
  if (draft.returnsToHuman !== null && draft.returnsToHuman !== undefined) expected.returnsToHuman = draft.returnsToHuman;
  if (draft.suspicionInjection !== null && draft.suspicionInjection !== undefined) {
    expected.suspicionInjection = draft.suspicionInjection;
  }
  const confRaw = (draft.minConfidence ?? '').trim().replace(',', '.');
  if (confRaw !== '') {
    const c = /^\d*\.?\d+$/.test(confRaw) ? Number(confRaw) : NaN;
    if (!Number.isFinite(c) || c < 0 || c > 1) errors.push('La confiance minimale attendue doit être un nombre entre 0 et 1.');
    else expected.minConfidence = c;
  }
  const hasCriterion =
    expected.result !== undefined ||
    expected.returnsToHuman !== undefined ||
    expected.suspicionInjection !== undefined ||
    (expected.minConfidence !== undefined && expected.minConfidence > 0);
  const criterionErrorAlready = errors.some((e) => e.startsWith('Le résultat attendu') || e.startsWith('La confiance'));
  if (!hasCriterion && !criterionErrorAlready) {
    errors.push(
      'Indiquez au moins un critère attendu : résultat, renvoi à l\'humain, suspicion d\'injection ou confiance minimale supérieure à 0.',
    );
  }

  const weight = parseBoundedInt(draft.weight, 1, 1000);
  if (weight === 'invalid') errors.push('Le poids doit être un entier de 1 à 1 000.');
  const sortOrder = parseBoundedInt(draft.sortOrder, 0, 1_000_000);
  if (sortOrder === 'invalid') errors.push('L\'ordre doit être un entier de 0 à 1 000 000.');

  if (errors.length === 0) {
    if (byteLength(JSON.stringify(input)) + byteLength(JSON.stringify(expected)) > EVAL_CASE_MAX_BYTES) {
      errors.push(`Le cas est trop volumineux (${EVAL_CASE_MAX_BYTES / 1024} Kio au plus).`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const payload: EvalCasePayload = { label, input, expected };
  if (typeof weight === 'number') payload.weight = weight;
  if (typeof sortOrder === 'number') payload.sortOrder = sortOrder;
  return { ok: true, payload, errors: [] };
}

/** Relit un cas de l'API pour l'éditer ; tolère toute forme inattendue (champs ignorés). Ne lève jamais. */
export function evalCaseToDraft(c: {
  label?: unknown;
  input?: unknown;
  expected?: unknown;
  weight?: unknown;
  sortOrder?: unknown;
}): EvalCaseDraft {
  const draft = emptyEvalCaseDraft();
  try {
    if (typeof c.label === 'string') draft.label = c.label;
    const input = isObj(c.input) ? c.input : {};
    if (Array.isArray(input.untrusted)) {
      for (const b of input.untrusted as unknown[]) {
        if (!isObj(b)) continue;
        draft.blocks.push({
          origin: typeof b.origin === 'string' ? b.origin : 'document',
          label: typeof b.label === 'string' ? b.label : '',
          text: typeof b.text === 'string' ? b.text : '',
        });
      }
    }
    if (isObj(input.subject)) {
      if (typeof input.subject.type === 'string') draft.subjectType = input.subject.type;
      if (typeof input.subject.id === 'string') draft.subjectId = input.subject.id;
    }
    if (isObj(input.context)) draft.contextJson = JSON.stringify(input.context, null, 2);

    const exp = isObj(c.expected) ? c.expected : {};
    if (typeof exp.returnsToHuman === 'boolean') draft.returnsToHuman = exp.returnsToHuman;
    if (typeof exp.suspicionInjection === 'boolean') draft.suspicionInjection = exp.suspicionInjection;
    if (typeof exp.minConfidence === 'number' && Number.isFinite(exp.minConfidence)) {
      draft.minConfidence = String(exp.minConfidence).replace('.', ',');
    }
    if (isObj(exp.result)) draft.resultJson = JSON.stringify(exp.result, null, 2);
    if (typeof c.weight === 'number' && Number.isFinite(c.weight)) draft.weight = String(c.weight);
    if (typeof c.sortOrder === 'number' && Number.isFinite(c.sortOrder)) draft.sortOrder = String(c.sortOrder);
  } catch {
    // Forme inattendue : on garde le brouillon partiel.
  }
  return draft;
}

// ---------------------------------------------------------------------------
// Éligibilité à l'autonomie
// ---------------------------------------------------------------------------

export type EligibilityAction = 'link_set' | 'run_eval' | 'mark_low_risk' | 'none';

export interface EligibilityLabel {
  label: string;
  tone: 'success' | 'warning';
  nextAction: EligibilityAction;
  /** Libellé du bouton associé à `nextAction` ; null si aucune action. */
  actionLabel: string | null;
}

const ACTION_LABELS: Record<Exclude<EligibilityAction, 'none'>, string> = {
  link_set: 'Lier un jeu d\'évaluation',
  run_eval: 'Lancer une évaluation',
  mark_low_risk: 'Marquer le workflow à faible risque',
};

/** Minuscules, sans accents, apostrophes typographiques ramenées à l'apostrophe droite. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’ʼ]/g, '\'')
    .toLowerCase();
}

function actionFromReason(reason: string): EligibilityAction {
  const r = foldText(reason);
  if (r.includes('aucun jeu d\'evaluation')) return 'link_set';
  if (r.includes('pas marque faible risque')) return 'mark_low_risk';
  if (
    r.includes('aucun run d\'evaluation reussi') ||
    r.includes('a change depuis le dernier run') ||
    r.includes('ont change depuis le dernier run') ||
    r.includes('seuil inferieur au seuil actuel')
  ) {
    return 'run_eval';
  }
  return 'none';
}

/** Étiquette d'éligibilité d'une étape ; la raison de l'API (en français) est reprise telle quelle. */
export function eligibilityLabel(step: { eligible: boolean; reason?: string | null }): EligibilityLabel {
  if (step.eligible === true) {
    return { label: 'Éligible à l\'autonomie', tone: 'success', nextAction: 'none', actionLabel: null };
  }
  const reason = typeof step.reason === 'string' && step.reason.trim() !== '' ? step.reason.trim() : null;
  if (reason === null) return { label: 'Non éligible à l\'autonomie', tone: 'warning', nextAction: 'none', actionLabel: null };
  const nextAction = actionFromReason(reason);
  return {
    label: reason,
    tone: 'warning',
    nextAction,
    actionLabel: nextAction === 'none' ? null : ACTION_LABELS[nextAction],
  };
}

export interface EvalChecklistItem {
  key: 'low_risk' | 'set_linked' | 'cases' | 'passed_run';
  label: string;
  done: boolean;
}

export interface EvalChecklist {
  items: EvalChecklistItem[];
  /** Toutes les conditions sont remplies. */
  complete: boolean;
}

/** Étapes à suivre pour dégriser le niveau « Autonome ». */
export function evalChecklist(input: {
  isLowRisk: boolean;
  evalSetLinked: boolean;
  activeCases: number;
  hasPassedRun: boolean;
}): EvalChecklist {
  const items: EvalChecklistItem[] = [
    { key: 'low_risk', label: 'Faire marquer le workflow « faible risque » par un administrateur', done: input.isLowRisk === true },
    { key: 'set_linked', label: 'Lier un jeu d\'évaluation à l\'étape agent', done: input.evalSetLinked === true },
    { key: 'cases', label: 'Ajouter au moins un cas actif au jeu', done: input.activeCases > 0 },
    { key: 'passed_run', label: 'Lancer une évaluation et obtenir un run réussi', done: input.hasPassedRun === true },
  ];
  return { items, complete: items.every((i) => i.done) };
}
