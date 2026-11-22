import type { ZodType } from 'zod';
import type { AuthUser } from '../auth/auth.types';
import type { WfPrincipal } from '../workflows/engine/engine.types';

// Docu-Flow — CONTRAT du module des agents (lot W2). Types, jetons d'injection et erreurs partagés entre
// les sous-ensembles (injection/runner, budget/garde, outils/identité, évaluation, exécuteur). Aucune
// logique ici : chaque port est implémenté dans son dossier et injecté par jeton (pas d'import croisé).
//
// RÈGLES D'OR (toutes les implémentations) :
//  - le texte entrant (courrier, document, OCR, formulaire) est de la DONNÉE, jamais une instruction ;
//  - les droits de l'agent sont ceux du lanceur (`started_by`), relus en base, jamais davantage ;
//  - échec fermé : en cas de doute (budget illisible, identité douteuse, sortie invalide), jamais d'action,
//    retour à l'humain ;
//  - aucun contenu de document, aucun secret dans les logs ; identifiants et types d'erreur seulement.

/** Version du prompt agent (journal `ged_ai_decision.prompt_version`). */
export const WF_AGENT_PROMPT_VERSION = 'wf-agent-v1';

// ---------------------------------------------------------------------------
// Jetons d'injection (providers du module workflow-agents)
// ---------------------------------------------------------------------------
export const WF_AGENT_GATE = 'WF_AGENT_GATE'; // WfAgentGate         (budget/)
export const WF_AGENT_IDENTITY = 'WF_AGENT_IDENTITY'; // WfAgentIdentityPort (identity/)
export const WF_TOOL_REGISTRY = 'WF_TOOL_REGISTRY'; // WfToolRegistryPort  (tools/)
export const WF_AGENT_RUNNER = 'WF_AGENT_RUNNER'; // WfAgentRunner       (runner/)
export const WF_AGENT_EVENT_SINK = 'WF_AGENT_EVENT_SINK'; // WfAgentEventSink    (agent-event-sink.service.ts)

// ---------------------------------------------------------------------------
// Identité (droits du lanceur)
// ---------------------------------------------------------------------------

/** Identité de l'agent = celle du lanceur, reconstruite EN BASE (compte actif, droit de lancer). */
export interface AgentIdentity {
  principal: WfPrincipal;
  /** Forme attendue par les services existants (`DocumentsService.canAccess`, recherche…). */
  user: AuthUser;
}

export type AgentIdentityErrorCode = 'not_found' | 'disabled' | 'no_launch_right' | 'invalid';

export class AgentIdentityError extends Error {
  constructor(
    readonly code: AgentIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentIdentityError';
  }
}

export interface WfAgentIdentityPort {
  /** Lève `AgentIdentityError` si le compte est introuvable, désactivé, ou n'a plus le droit de lancer. */
  resolve(userGroupId: number): Promise<AgentIdentity>;
}

// ---------------------------------------------------------------------------
// Sources, actions préparées
// ---------------------------------------------------------------------------

/** Source consultée par l'agent (journal : `wf_event_log.sources`, jamais le contenu intégral). */
export interface WfAgentSource {
  kind: 'document' | 'mail' | 'passage';
  id: number;
  label?: string;
  /** Extrait court (<= 300 caractères). */
  excerpt?: string;
}

/**
 * Action PRÉPARÉE par un outil d'écriture. Jamais appliquée par l'agent : elle voyage dans la proposition
 * (élément de boîte kind 1) et ne s'applique qu'après validation humaine (niveau « agit avec validation »).
 */
export interface WfPreparedAction {
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect: 0 | 1 | 2;
  requiresValidation: boolean;
  /** Phrase en français décrivant ce qui serait fait. */
  preview: string;
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

export interface WfToolContext {
  /** Droits du LANCEUR : tout accès à une donnée passe par `identity.user`. */
  identity: AgentIdentity;
  instanceId: string | null; // null en évaluation (mode sans effet de bord)
  taskId: string | null;
  stepKey: string;
  /** Objet lié de l'instance (courrier, document…), s'il existe. */
  subject: { type: string | null; id: string | null };
  /** Évaluation : aucun effet de bord, aucune écriture (les outils d'écriture ne font que préparer). */
  dryRun: boolean;
}

export interface WfToolResult {
  /** Donnée renvoyée au modèle (sera encadrée comme DONNÉE non fiable par le runner). */
  output: unknown;
  sources: WfAgentSource[];
  /** Outils d'écriture seulement : l'action préparée (jamais appliquée). */
  prepared?: WfPreparedAction;
}

export interface WfTool<I = unknown> {
  /** Clé stable `[a-z0-9_.]+` (= `wf_tool.tool_key`). */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** 0 lecture, 1 écriture réversible, 2 externe ou irréversible. */
  readonly sideEffect: 0 | 1 | 2;
  /** Toujours vrai si `sideEffect` = 2 (CHECK SQL `ck_wf_tool_irreversible_validated`). */
  readonly requiresValidation: boolean;
  /** Validation STRICTE des arguments fournis par le modèle (`.strict()` : aucune clé inconnue). */
  readonly inputSchema: ZodType<I>;
  /** JSON Schema décrivant les arguments (affiché au modèle, stocké dans `wf_tool.input_schema`). */
  readonly jsonSchema: Record<string, unknown>;
  execute(ctx: WfToolContext, input: I): Promise<WfToolResult>;
}

export interface WfToolDescriptor {
  key: string;
  label: string;
  description: string;
  sideEffect: 0 | 1 | 2;
  requiresValidation: boolean;
  jsonSchema: Record<string, unknown>;
}

export interface WfToolRegistryPort {
  register(tool: WfTool): void; // refuse un doublon et une clé invalide
  get(key: string): WfTool | undefined;
  list(): WfTool[];
  /** Descripteurs (pour le prompt) des seuls outils demandés et connus. */
  describe(keys: readonly string[]): WfToolDescriptor[];
}

// ---------------------------------------------------------------------------
// Garde : arrêt d'urgence, mode IA, plafonds (budget)
// ---------------------------------------------------------------------------

export type AgentBlockReason =
  | 'ai_disabled' // ged_ai_setting.mode = 0 : le workflow fonctionne en mode humain
  | 'emergency_stop_global'
  | 'emergency_stop_workflow'
  | 'budget_exceeded_global'
  | 'budget_exceeded_workflow'
  | 'budget_unavailable'; // échec fermé : budget illisible

export class AgentBlockedError extends Error {
  constructor(
    readonly reason: AgentBlockReason,
    message: string,
  ) {
    super(message);
    this.name = 'AgentBlockedError';
  }
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
  /** Coût dans la devise du budget (`wf_budget.currency`). */
  cost: number;
}

/** Réservation atomique sur les lignes budgétaires (globale + workflow). Opaque pour le runner. */
export interface AgentReservation {
  readonly id: string;
  readonly definitionId: number;
  readonly reserved: AgentUsage;
}

export interface WfAgentGate {
  /**
   * Arrêt d'urgence (global puis workflow) + mode IA, SANS réserver. Lève `AgentBlockedError`.
   * Toute erreur de lecture => `AgentBlockedError('budget_unavailable')` (échec fermé).
   */
  assertRunnable(scope: { definitionId: number }): Promise<void>;
  /**
   * Réserve ATOMIQUEMENT `estimate` sur la ligne globale ET celle du workflow (consommé + estimation <=
   * plafond, sinon refus avant tout appel). Refuse si arrêt d'urgence. Lève `AgentBlockedError`.
   */
  reserve(scope: { definitionId: number }, estimate: AgentUsage): Promise<AgentReservation>;
  /** Remplace la réservation par la consommation réelle (jamais de refus : le coût est déjà engagé). */
  settle(reservation: AgentReservation, actual: AgentUsage): Promise<void>;
  /** Libère une réservation dont l'appel n'a pas eu lieu. */
  release(reservation: AgentReservation): Promise<void>;
  /** Coût d'une consommation de jetons (tarif configurable, valeur par défaut prudente). */
  costOf(tokens: { promptTokens: number; completionTokens: number }): number;
}

// ---------------------------------------------------------------------------
// Journal : événements écrits HORS transaction du moteur (lectures d'outils, refus de budget)
// ---------------------------------------------------------------------------

export interface WfAgentEventInput {
  instanceId: string;
  taskId?: string | null;
  stepKey?: string | null;
  /** `agent.tool_called`, `budget.exceeded`, `emergency_stop.*`… (clés de `WF_EVENT_TYPES`). */
  eventType: string;
  decision?: unknown;
  sources?: unknown;
  explanation?: string | null;
  autonomyLevel?: 0 | 1 | 2 | null;
}

export interface WfAgentEventSink {
  /** Ajout seul dans `wf_event_log` (acteur agent). Ne lève jamais : une erreur est journalisée côté logs. */
  append(event: WfAgentEventInput): Promise<void>;
  /** Appels déjà journalisés (`agent.tool_called`) d'un outil dans une instance (plafond par instance). */
  countToolCalls(instanceId: string, toolKey: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Runner (boucle d'agent)
// ---------------------------------------------------------------------------

/** Bloc de données non fiables fourni au modèle (jamais interprété comme consigne). */
export interface AgentUntrustedBlock {
  /** Étiquette écrite par l'application (« Courrier », « Document 12 »…) : de confiance, courte. */
  label: string;
  origin: 'mail' | 'document' | 'ocr' | 'form' | 'context';
  /** Contenu écrit par un tiers : NEUTRALISÉ par le runner. */
  text: string;
}

export interface AgentRunSpec {
  /** Objectif de l'étape (écrit par le concepteur du workflow : de confiance). */
  objective: string;
  /** 0 suggère, 1 agit avec validation, 2 autonome. */
  autonomy: 0 | 1 | 2;
  confidenceThreshold: number;
  /** Clés d'outils AUTORISÉES pour l'étape (déjà rapprochées des autorisations du workflow). */
  allowedToolKeys: readonly string[];
  /** Appels restants par outil (plafond par instance), clé absente = illimité. */
  remainingToolCalls?: Readonly<Record<string, number>>;
  model?: string | null;
  maxSteps: number;
  maxCostPerRun: number | null;
  timeoutSeconds: number;
}

export interface AgentRunInput {
  mode: 'live' | 'dry_run';
  scope: {
    definitionId: number;
    instanceId?: string; // absent en dry_run
    taskId?: string;
    stepKey: string;
    subject?: { type: string | null; id: string | null };
    /** Contexte du cas d'évaluation, transmis aux outils en `dry_run` seulement. */
    evalContext?: Readonly<Record<string, unknown>>;
  };
  spec: AgentRunSpec;
  identity: AgentIdentity;
  untrusted: readonly AgentUntrustedBlock[];
  /** `user_group_id` inscrit dans `ged_ai_decision.requested_by` (lanceur, ou évaluateur en dry_run). */
  requestedBy: number;
  signal?: AbortSignal;
}

export type AgentRunStopReason =
  | AgentBlockReason
  | 'max_steps'
  | 'timeout'
  | 'cost_per_run'
  | 'invalid_output' // sortie du modèle refusée par le schéma strict
  | 'tool_denied' // outil non autorisé / arguments invalides / plafond d'appels
  | 'provider_error'
  | 'masking_required'
  | 'aborted';

export interface AgentToolCallRecord {
  tool: string;
  ok: boolean;
  sideEffect: 0 | 1 | 2;
  /** SHA-256 des arguments (jamais les arguments eux-mêmes s'ils contiennent du contenu). */
  argsHash: string;
  sourcesCount: number;
  error?: string;
}

export interface AgentRunAudit {
  /** Instruction journalisée : l'objectif (de confiance) + libellés des blocs de données, tronquée. */
  instruction: string;
  model: string | null;
  /** `ged_ai_decision.ged_ai_decision_id` de chaque appel modèle (décimal). */
  aiDecisionIds: string[];
  promptTokens: number;
  completionTokens: number;
  costAmount: number;
  steps: number;
  toolCalls: AgentToolCallRecord[];
}

export interface AgentRunOutput {
  /** `final` : le modèle a conclu (même si la décision finale est de renvoyer à l'humain). */
  outcome: 'final' | 'stopped';
  stopReason?: AgentRunStopReason;
  /** Objet JSON borné produit par le modèle (valide au schéma strict) ; null si arrêt. */
  result: Record<string, unknown> | null;
  explanation: string;
  /** 0..1 ; null si absent ou invalide (=> traité comme sous le seuil). */
  confidence: number | null;
  sources: WfAgentSource[];
  preparedActions: WfPreparedAction[];
  /** Drapeau `suspicion_injection` : consigne détournée détectée (entrée, sortie ou appel d'outil). */
  suspicionInjection: boolean;
  suspicionReasons: string[];
  audit: AgentRunAudit;
}

export interface WfAgentRunner {
  /** Ne lève JAMAIS pour une cause métier : tout arrêt est un `AgentRunOutput` `stopped`. */
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}
