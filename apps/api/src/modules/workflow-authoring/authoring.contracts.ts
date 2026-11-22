import type {
  WfAuthoringToDoItem,
  WfAuthoringTriggerSuggestion,
  WfAuthoringExplanation,
  WfGraph,
  WfTriggerEventType,
} from '@archivage/types';

// Docu-Flow W5 — contrat interne du module de création en langage naturel.
// Ce fichier fixe les signatures partagées entre le prompt, les garde-fous, la suggestion de déclencheur,
// l'explication et le service. Aucune logique ici.

export const WF_AUTHORING_PROMPT_VERSION = 'wf-authoring-v1';

/** Plafonds. La description fait 4000 caractères au plus (`WF_AUTHORING_DESCRIPTION_MAX` côté DTO). */
export const AUTHORING_SOURCE_PROMPT_MAX = 2000;
export const AUTHORING_MAX_STEPS = 30;
export const AUTHORING_MAX_OUTPUT_TOKENS = 6000;
export const AUTHORING_NAME_MAX = 120;
export const AUTHORING_ASSUMPTION_MAX_CHARS = 400;
export const AUTHORING_MAX_ASSUMPTIONS = 20;
/** Seuil de confiance plancher imposé aux étapes agent générées (jamais en dessous du défaut moteur). */
export const AUTHORING_MIN_CONFIDENCE = 0.8;

/** Outil du catalogue (`wf_tool` actif) proposé au générateur. Seules ces clés peuvent être utilisées. */
export interface AuthoringToolInfo {
  key: string;
  label: string;
  description: string | null;
  /** 0 lecture, 1 écriture réversible (préparée seulement), 2 irréversible (préparée seulement). */
  sideEffect: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// authoring.prompt.ts
// ---------------------------------------------------------------------------

export interface AuthoringPromptInput {
  /** Jeton aléatoire PROPRE à cet appel (`generateNonce()` de workflow-agents/injection/untrusted). */
  nonce: string;
  /** Texte de l'utilisateur : DONNÉE non fiable, jamais une consigne. */
  description: string;
  /** Type d'événement évoqué (déjà validé contre le catalogue de W3), sinon absent. */
  triggerHint?: WfTriggerEventType;
  tools: readonly AuthoringToolInfo[];
  /** Passe de réparation (une seule) : graphe précédent + problèmes à corriger (données, non fiables). */
  repair?: { previousGraph: unknown; issues: readonly string[] };
}

export interface AuthoringPromptRequest {
  system: string;
  text: string;
  jsonSchema: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
}

// ---------------------------------------------------------------------------
// authoring.output.ts : sortie brute du modèle (avant garde-fous)
// ---------------------------------------------------------------------------

export interface AuthoringModelOutput {
  name: string;
  description: string | null;
  /** Graphe brut : NON validé (le service le passe aux garde-fous puis à `validateWorkflowGraph`). */
  graph: unknown;
  assumptions: string[];
  /** Déclencheur évoqué par le modèle (brut, revalidé par `suggestTrigger`). */
  trigger: { eventType: string; conditions?: unknown; reason?: string } | null;
}

/** Levée quand la sortie n'est pas un objet JSON conforme (taille, forme, clés dangereuses). Message sans contenu. */
export class AuthoringOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoringOutputError';
  }
}

// ---------------------------------------------------------------------------
// authoring.guardrails.ts
// ---------------------------------------------------------------------------

export interface GuardrailContext {
  /** Clés d'outils du catalogue ACTIF (`wf_tool.is_enabled`). Tout autre outil est retiré. */
  allowedTools: ReadonlySet<string>;
}

export interface GuardrailResult {
  /** Graphe nettoyé (toujours un objet JSON ; à valider ensuite par `validateWorkflowGraph`). */
  graph: unknown;
  /** Lignes en français à ajouter aux hypothèses (outils retirés, autonomie ramenée, etc.). */
  notes: string[];
  toComplete: WfAuthoringToDoItem[];
  /** Éléments refusés (outils, autonomie, faible risque, identifiants), pour l'audit : types et nombres, pas de texte. */
  removed: { tools: number; autonomy: number; assignees: number; configKeys: number; suspiciousText: number };
}

// ---------------------------------------------------------------------------
// authoring.trigger.ts / authoring.assumptions.ts / authoring.explain.ts (fonctions pures)
// ---------------------------------------------------------------------------

export interface SuggestTriggerInput {
  description: string;
  triggerHint?: WfTriggerEventType;
  /** Déclencheur évoqué par le modèle (brut). */
  modelTrigger: AuthoringModelOutput['trigger'];
}

export type SuggestTrigger = (input: SuggestTriggerInput) => WfAuthoringTriggerSuggestion | null;

export type ExtractFigures = (description: string) => string[];

export type ExplainGraph = (
  graph: WfGraph,
  meta: { definitionId: number; versionNumber: number; name: string },
) => WfAuthoringExplanation;
