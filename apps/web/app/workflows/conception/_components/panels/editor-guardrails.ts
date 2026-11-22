// Docu-Flow — garde-fous des agents dans l'éditeur : fusion des statuts d'évaluation par étape, textes d'aide
// selon les droits, état « modifications non enregistrées ». Logique PURE (sans React, sans réseau).
import type { WfDefinitionIssueCode } from '../../../../lib/workflows-api';
import { missingGrants, type GraphLike } from '../../../_lib/guardrails-logic';

// ---------------------------------------------------------------------------
// Statut d'évaluation par étape
// ---------------------------------------------------------------------------

/** Forme minimale de `WfEvalStatus` (structurelle : pas d'import du client d'API). */
export interface EvalStatusLike {
  steps: ReadonlyArray<{ stepKey: string; eligible: boolean; reason: string | null; evalSetId: number | null }>;
}

export interface StepEvalInfo {
  eligible: boolean;
  /** Raison en français de l'API quand l'étape n'est pas éligible. */
  reason: string | null;
  evalSetId: number | null;
  /** Faux quand l'API ne connaît pas encore cette étape (étape ajoutée depuis le dernier enregistrement). */
  known: boolean;
}

/** Une entrée par étape. `null` = route indisponible (403/404) : « Autonome » reste grisé. */
export function buildStepEvals(status: EvalStatusLike | null | undefined): Map<string, StepEvalInfo> | null {
  if (!status || !Array.isArray(status.steps)) return null;
  const map = new Map<string, StepEvalInfo>();
  for (const s of status.steps) {
    if (map.has(s.stepKey)) continue;
    map.set(s.stepKey, {
      eligible: s.eligible === true,
      reason: typeof s.reason === 'string' && s.reason.trim() !== '' ? s.reason.trim() : null,
      evalSetId: s.evalSetId ?? null,
      known: true,
    });
  }
  return map;
}

/** Informations d'une étape ; `null` si la route est indisponible. Étape inconnue de l'API : non éligible, `known: false`. */
export function stepEvalInfo(map: ReadonlyMap<string, StepEvalInfo> | null, stepKey: string): StepEvalInfo | null {
  if (map === null) return null;
  return map.get(stepKey) ?? { eligible: false, reason: null, evalSetId: null, known: false };
}

/** Valeur de `hasPassedEval` pour une étape : `eligible`, ou `null` si la route est indisponible. */
export function hasPassedEvalFor(map: ReadonlyMap<string, StepEvalInfo> | null, stepKey: string): boolean | null {
  const info = stepEvalInfo(map, stepKey);
  return info === null ? null : info.eligible;
}

// ---------------------------------------------------------------------------
// Aide à l'évaluation
// ---------------------------------------------------------------------------

export interface EvalHelp {
  /** Phrase d'aide toujours affichée. */
  text: string;
  /** Avertissement supplémentaire (modifications non enregistrées, étape non enregistrée), sinon null. */
  warning: string | null;
}

/**
 * L'évaluation porte sur la dernière version ENREGISTRÉE du workflow : on prévient si le brouillon à l'écran a
 * des modifications non enregistrées, ou si l'étape n'existe pas encore côté serveur.
 */
export function evalHelp(input: { dirty: boolean; known: boolean }): EvalHelp {
  const text =
    'L’évaluation porte sur la dernière version enregistrée du workflow : enregistrez le brouillon d’abord.';
  let warning: string | null = null;
  if (input.dirty) {
    warning =
      'Des modifications ne sont pas enregistrées : l’évaluation ne les prendra pas en compte. Enregistrez le brouillon avant d’évaluer.';
  } else if (!input.known) {
    warning = 'Cette étape n’existe pas encore dans la version enregistrée : enregistrez le brouillon avant de l’évaluer.';
  }
  return { text, warning };
}

// ---------------------------------------------------------------------------
// Outils autorisés
// ---------------------------------------------------------------------------

export const TOOL_NOT_GRANTED_CODE: WfDefinitionIssueCode = 'AGENT_TOOL_NOT_GRANTED';

export const DESIGNER_TOOL_NOTICE =
  'Un administrateur doit autoriser cet outil pour ce workflow (code AGENT_TOOL_NOT_GRANTED).';

export interface ToolGrantNotice {
  kind: 'admin' | 'designer';
  text: string;
  /** Afficher le lien « Outils autorisés » (administrateurs uniquement). */
  showLink: boolean;
}

/**
 * Avertissement non bloquant sur les outils d'une étape agent.
 * - administrateur : liste exacte (`missing`, calculée à partir des autorisations chargées) ; si les autorisations
 *   n'ont pas pu être chargées mais que le serveur a signalé le problème, message générique ;
 * - concepteur non administrateur : phrase explicative, uniquement quand le serveur a signalé le problème
 *   (il ne peut pas connaître les autorisations).
 */
export function toolGrantNotice(input: {
  canAdminister: boolean;
  missing: readonly string[];
  issueNotGranted: boolean;
}): ToolGrantNotice | null {
  if (input.canAdminister) {
    if (input.missing.length > 0) {
      return { kind: 'admin', text: `Outils non autorisés pour ce workflow : ${input.missing.join(', ')}.`, showLink: true };
    }
    if (input.issueNotGranted) {
      return {
        kind: 'admin',
        text: 'Un outil de cette étape n’est pas autorisé pour ce workflow (code AGENT_TOOL_NOT_GRANTED).',
        showLink: true,
      };
    }
    return null;
  }
  return input.issueNotGranted ? { kind: 'designer', text: DESIGNER_TOOL_NOTICE, showLink: false } : null;
}

/** Outils non autorisés d'UNE étape ; `grantedKeys` nul (autorisations non chargées) => aucune liste. */
export function missingToolsForStep(
  graph: GraphLike | null | undefined,
  grantedKeys: readonly string[] | null,
  stepKey: string,
): string[] {
  if (grantedKeys === null) return [];
  return missingGrants(graph, grantedKeys)
    .filter((m) => m.stepKey === stepKey)
    .map((m) => m.toolKey);
}

// ---------------------------------------------------------------------------
// Garde-fous transmis au panneau d'une étape agent
// ---------------------------------------------------------------------------

export interface StepGuardrails {
  definitionId: number;
  /** `null` = route d'évaluation indisponible. */
  evalInfo: StepEvalInfo | null;
  evalLoading: boolean;
  /** Brouillon avec modifications non enregistrées. */
  dirty: boolean;
  canAdminister: boolean;
  /** Outils de CETTE étape non autorisés (administrateurs, autorisations chargées). */
  missingTools: string[];
  /** Le serveur a signalé AGENT_TOOL_NOT_GRANTED sur cette étape. */
  issueNotGranted: boolean;
  onRefreshEval?: () => void;
}

export interface EditorGuardrails {
  definitionId: number;
  stepEvals: Map<string, StepEvalInfo> | null;
  evalLoading: boolean;
  dirty: boolean;
  canAdminister: boolean;
  /** `null` = autorisations non chargées (non administrateur, ou échec silencieux). */
  grantedKeys: string[] | null;
  onRefreshEval?: () => void;
}

export function stepGuardrails(
  g: EditorGuardrails,
  graph: GraphLike,
  stepKey: string,
  issues: ReadonlyArray<{ code: string }>,
): StepGuardrails {
  const out: StepGuardrails = {
    definitionId: g.definitionId,
    evalInfo: stepEvalInfo(g.stepEvals, stepKey),
    evalLoading: g.evalLoading,
    dirty: g.dirty,
    canAdminister: g.canAdminister,
    missingTools: g.canAdminister ? missingToolsForStep(graph, g.grantedKeys, stepKey) : [],
    issueNotGranted: issues.some((i) => i.code === TOOL_NOT_GRANTED_CODE),
  };
  if (g.onRefreshEval) out.onRefreshEval = g.onRefreshEval;
  return out;
}

// ---------------------------------------------------------------------------
// Rafraîchissement
// ---------------------------------------------------------------------------

/** L'état d'évaluation n'est utile que pour un brouillon modifiable. */
export function shouldFetchEvalStatus(readOnly: boolean, definitionId: number | null): boolean {
  return !readOnly && definitionId !== null;
}

/** Évite deux appels coup sur coup (`focus` + `visibilitychange` partent presque ensemble). */
export function shouldRefreshNow(lastMs: number | null, nowMs: number, minGapMs = 1500): boolean {
  return lastMs === null || nowMs - lastMs >= minGapMs;
}

// ---------------------------------------------------------------------------
// Action d'un problème (panneau des problèmes)
// ---------------------------------------------------------------------------

export type IssueActionView =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'text'; text: string };

/**
 * Rendu de l'action d'un problème expliqué. « Outils autorisés » n'est un lien que pour un administrateur ;
 * sinon un texte invite à demander à un administrateur. Les autres actions (évaluation) restent des liens.
 */
export function issueActionView(
  code: string,
  action: { label: string; href: string } | undefined,
  canAdminister: boolean,
): IssueActionView | null {
  if (code === TOOL_NOT_GRANTED_CODE) {
    if (action && canAdminister) return { kind: 'link', label: action.label, href: action.href };
    return { kind: 'text', text: 'Demandez à un administrateur d’autoriser cet outil pour ce workflow.' };
  }
  return action ? { kind: 'link', label: action.label, href: action.href } : null;
}
