// Docu-Flow — écran d'évaluation : logique PURE propre à l'écran (sans React, sans réseau).
// Complète `_lib/eval-logic.ts` (précision, cas, éligibilité) sans le modifier.
import { WfEvalRunStatus } from '@archivage/types';
import type { UpsertWfAgentConfigInput, WfEvalCaseDto, WfEvalRunDto, WfEvalSetDto, WfGraph } from '@archivage/types';
import { parseMinAccuracy, type MinAccuracyResult } from '../../../_lib/eval-logic';

// ---------------------------------------------------------------------------
// Étapes agent
// ---------------------------------------------------------------------------

export interface AgentStepOption {
  key: string;
  name: string;
}

/** Étapes agent d'un graphe (ordre du graphe). Tolère un graphe absent ou malformé. */
export function agentStepsOfGraph(graph: WfGraph | null | undefined): AgentStepOption[] {
  try {
    const steps = Array.isArray(graph?.steps) ? graph.steps : [];
    return steps
      .filter((s) => s && s.type === 'agent' && typeof s.key === 'string' && s.key !== '')
      .map((s) => ({ key: s.key, name: typeof s.name === 'string' && s.name.trim() !== '' ? s.name : s.key }));
  } catch {
    return [];
  }
}

/** Repli : étapes issues de `listDraftAgents` (le nom n'y figure pas : la clé sert de nom). */
export function agentStepsOfDraftAgents(agents: ReadonlyArray<{ stepKey: string }> | null | undefined): AgentStepOption[] {
  return (agents ?? []).map((a) => ({ key: a.stepKey, name: a.stepKey }));
}

/** Étape retenue : celle demandée si elle existe, sinon la première ; null sans étape. */
export function pickStepKey(requested: string | null | undefined, steps: readonly AgentStepOption[]): string | null {
  if (steps.length === 0) return null;
  if (requested && steps.some((s) => s.key === requested)) return requested;
  return steps[0]?.key ?? null;
}

/** Numéro de la dernière version (le plus grand) ; null sans version. */
export function latestVersionNumber(versions: ReadonlyArray<{ versionNumber: number }> | null | undefined): number | null {
  if (!versions || versions.length === 0) return null;
  return versions.reduce((m, v) => (v.versionNumber > m ? v.versionNumber : m), versions[0]?.versionNumber ?? 0);
}

/** Identifiant décimal strict (route) : entier positif ; sinon null. */
export function parseDefinitionId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Jeux
// ---------------------------------------------------------------------------

/** Jeux de l'étape ou sans étape (jeux généraux du workflow), actifs d'abord puis par nom. */
export function setsForStep(sets: readonly WfEvalSetDto[] | null | undefined, stepKey: string | null): WfEvalSetDto[] {
  return (sets ?? [])
    .filter((s) => s.stepKey === null || s.stepKey === undefined || s.stepKey === stepKey)
    .slice()
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, 'fr'));
}

/** Jeu lié à l'étape d'après la configuration du brouillon ; null si aucun. */
export function linkedSetIdOf(
  agents: ReadonlyArray<{ stepKey: string; evalSetId: number | null }> | null | undefined,
  stepKey: string | null,
): number | null {
  if (!agents || !stepKey) return null;
  return agents.find((a) => a.stepKey === stepKey)?.evalSetId ?? null;
}

/** Corps de `updateDraftAgent` pour lier (ou délier avec null) un jeu : seul `evalSetId` est envoyé. */
export function linkSetInput(setId: number | null): UpsertWfAgentConfigInput {
  return { evalSetId: setId };
}

/**
 * Seuil saisi : « 85 », « 85 % », « 85,5 % » (pourcentage) ou « 0,85 » (décimal). Un nombre strictement
 * supérieur à 1 ou suivi de « % » est un pourcentage. Ensuite : mêmes règles que `parseMinAccuracy`.
 */
export function parseMinAccuracyInput(raw: string): MinAccuracyResult {
  const s = (raw ?? '').trim();
  const hasPercent = /%\s*$/.test(s);
  const body = s.replace(/%\s*$/, '').trim().replace(',', '.');
  if (body === '' || !/^(\d*\.?\d+|\d+\.)$/.test(body)) return parseMinAccuracy(s);
  const n = Number(body);
  if (!Number.isFinite(n)) return parseMinAccuracy(s);
  if (hasPercent || n > 1) {
    if (n > 100) return { ok: false, value: null, error: 'Le seuil en pourcentage doit être compris entre 0 et 100.' };
    const scaled = n * 10; // dixièmes de pourcent = millièmes
    if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      return { ok: false, value: null, error: 'Le seuil accepte au plus une décimale en pourcentage (par exemple 85,5 %).' };
    }
    return parseMinAccuracy(String(Math.round(scaled) / 1000));
  }
  return parseMinAccuracy(body);
}

/** Valeur initiale du champ de seuil à partir de la précision de l'API (« 0.850 » -> « 85 % »). */
export function minAccuracyToInput(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return '85 %';
  const pct = Math.round(n * 1000) / 10;
  return `${String(pct).replace('.', ',')} %`;
}

// ---------------------------------------------------------------------------
// Cas
// ---------------------------------------------------------------------------

export function activeCaseCount(cases: ReadonlyArray<Pick<WfEvalCaseDto, 'isActive'>> | null | undefined): number {
  return (cases ?? []).filter((c) => c.isActive).length;
}

/** Libellés des cas par identifiant (pour le détail d'un run). */
export function caseLabelMap(
  cases: ReadonlyArray<Pick<WfEvalCaseDto, 'wfEvalCaseId' | 'label'>> | null | undefined,
): Map<number, string> {
  const m = new Map<number, string>();
  for (const c of cases ?? []) m.set(c.wfEvalCaseId, c.label);
  return m;
}

export type CaseFormField =
  | 'label'
  | 'blocks'
  | 'subject'
  | 'context'
  | 'result'
  | 'minConfidence'
  | 'expected'
  | 'weight'
  | 'sortOrder'
  | 'general';

/** Associe une erreur de `evalCaseDraftToPayload` au champ du formulaire concerné. */
export function caseErrorField(error: string): CaseFormField {
  if (error.startsWith('Le nom du cas')) return 'label';
  if (error.startsWith('Bloc ') || error.startsWith('Un cas accepte au plus')) return 'blocks';
  if (error.startsWith('Objet lié')) return 'subject';
  if (error.startsWith('Le contexte')) return 'context';
  if (error.startsWith('Le résultat attendu')) return 'result';
  if (error.startsWith('La confiance')) return 'minConfidence';
  if (error.startsWith('Indiquez au moins un critère')) return 'expected';
  if (error.startsWith('Le poids')) return 'weight';
  if (error.startsWith("L'ordre") || error.startsWith('L’ordre')) return 'sortOrder';
  return 'general';
}

export function groupCaseErrors(errors: readonly string[]): Partial<Record<CaseFormField, string[]>> {
  const out: Partial<Record<CaseFormField, string[]>> = {};
  for (const e of errors) {
    const f = caseErrorField(e);
    (out[f] ??= []).push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Plus récent d'abord (date de début décroissante, puis identifiant décroissant). */
export function sortRunsDesc(runs: readonly WfEvalRunDto[] | null | undefined): WfEvalRunDto[] {
  const idCmp = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
  return (runs ?? []).slice().sort((a, b) => {
    const ta = Date.parse(a.startedAt);
    const tb = Date.parse(b.startedAt);
    const d = (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    return d !== 0 ? d : idCmp(b.wfEvalRunId, a.wfEvalRunId);
  });
}

export function hasPassedRun(runs: ReadonlyArray<Pick<WfEvalRunDto, 'status' | 'passed'>> | null | undefined): boolean {
  return (runs ?? []).some((r) => r.status === WfEvalRunStatus.Completed && r.passed === true);
}

/** Remplace (ou ajoute) un run dans la liste, sans doublon, puis trie. */
export function upsertRun(runs: readonly WfEvalRunDto[], run: WfEvalRunDto): WfEvalRunDto[] {
  const rest = runs.filter((r) => r.wfEvalRunId !== run.wfEvalRunId);
  return sortRunsDesc([...rest, run]);
}

export interface RunLaunchState {
  allowed: boolean;
  /** Raison affichée quand le lancement est impossible ; null sinon. */
  reason: string | null;
}

/** Peut-on lancer un run ? Une seule raison, la plus bloquante, en français. */
export function runLaunchState(input: {
  hasSet: boolean;
  setActive: boolean;
  activeCases: number;
  running: boolean;
  casesLoaded: boolean;
}): RunLaunchState {
  if (!input.hasSet) return { allowed: false, reason: "Sélectionnez un jeu d'évaluation." };
  if (input.running) return { allowed: false, reason: 'Une évaluation est déjà en cours : attendez sa fin.' };
  if (!input.setActive) return { allowed: false, reason: 'Ce jeu est désactivé : réactivez-le pour lancer une évaluation.' };
  if (!input.casesLoaded) return { allowed: false, reason: 'Chargement des cas en cours.' };
  if (input.activeCases <= 0) return { allowed: false, reason: 'Ajoutez au moins un cas actif avant de lancer une évaluation.' };
  return { allowed: true, reason: null };
}

/** Annonce vocale (zone `aria-live`) lors d'un changement d'état d'un run. */
export function runAnnouncement(run: Pick<WfEvalRunDto, 'status' | 'passed' | 'passedCases' | 'totalCases'>): string {
  if (run.status === WfEvalRunStatus.Running) return 'Évaluation en cours.';
  if (run.status === WfEvalRunStatus.Completed) {
    return run.passed
      ? `Évaluation terminée : réussie, ${run.passedCases} cas sur ${run.totalCases}.`
      : `Évaluation terminée : échouée, ${run.passedCases} cas sur ${run.totalCases}.`;
  }
  return 'Évaluation interrompue sur une erreur.';
}

/** Coût affichable (« 0,0123 ») ; null si absent ou invalide. */
export function formatCost(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
