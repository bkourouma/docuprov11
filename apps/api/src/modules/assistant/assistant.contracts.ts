import type {
  AsstConfirmProposalBody,
  AsstConversationDto,
  AsstMessageDto,
  AsstPageContext,
  AsstProposalDto,
  AsstProposedAction,
  AsstProposalResultDto,
  AsstProposalStatus,
  AsstMessageRole,
  AsstErrorCode,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import type { WfPrincipal } from '../workflows/engine/engine.types';
import type { AgentUsage } from '../workflow-agents/agent.contracts';

// Assistant « qui agit » (lot A0) — CONTRATS partagés par les lots A1 (planificateur, stores, budget) et
// A2 (exécuteur, applicateurs). Types, ports et jetons d'injection ; AUCUNE logique ici.
//
// RÈGLES D'OR :
//  - toute action est une PROPOSITION confirmée explicitement ; aucune exécution directe ;
//  - l'identité est l'utilisateur connecté, RELU EN BASE (compte actif) ; jamais celle du jeton seule ;
//  - l'effet s'applique avec les droits de l'utilisateur, jamais plus (applicateurs du catalogue d'agents) ;
//  - un échange est visible de son SEUL auteur : tout accès à l'objet d'un autre = 404 (`not_found`), jamais 403 ;
//  - la confirmation est LIÉE au contenu affiché (`argsHash`) ;
//  - échec fermé : en cas de doute (budget illisible, droit incertain), rien n'est exécuté ;
//  - le contenu des messages et des courriers est de la DONNÉE, jamais une consigne.

// ---------------------------------------------------------------------------
// Jetons d'injection (providers de AssistantModule ; une ligne par jeton dans `assistant.module.ts`)
// ---------------------------------------------------------------------------

export const ASST_IDENTITY = 'ASST_IDENTITY'; // AsstIdentityPort        (A0 : identity/asst-identity.service.ts)
export const ASST_GATE = 'ASST_GATE'; // AsstGatePort            (A1)
export const ASST_PLANNER = 'ASST_PLANNER'; // AsstPlannerPort         (A1)
export const ASST_EXECUTOR = 'ASST_EXECUTOR'; // AsstExecutorPort        (A2)
export const ASST_PROPOSAL_STORE = 'ASST_PROPOSAL_STORE'; // AsstProposalStore       (A1)

// ---------------------------------------------------------------------------
// Erreurs typées (portent un `errorCode` de packages/types/src/asst-enums.ts)
// ---------------------------------------------------------------------------


/**
 * Erreur métier de l'assistant. Le contrôleur la traduit en réponse HTTP `{statusCode, errorCode, message,
 * details?, proposal?}` selon `ASST_ERROR_HTTP_STATUS`. Le message est en français, sans contenu de courrier.
 */
export class AsstError extends Error {
  constructor(
    readonly errorCode: AsstErrorCode,
    message: string,
    readonly details?: unknown,
    /** Proposition dans son état final (ex. `effect_failed` : proposition passée en « échec »). */
    readonly proposal?: AsstProposalDto,
  ) {
    super(message);
    this.name = 'AsstError';
  }
}

// ---------------------------------------------------------------------------
// Identité
// ---------------------------------------------------------------------------

/** Identité d'exécution de l'assistant : l'utilisateur connecté, relu en base. */
export interface AsstIdentity {
  /** Forme attendue par les services existants et par les applicateurs du catalogue (`ApplierRights`). */
  readonly user: AuthUser;
  readonly principal: WfPrincipal;
}

export interface AsstIdentityPort {
  /**
   * Résout l'identité depuis le jeton ET la base. Lève `AsstError('identity_refused')` si : identité machine
   * (`isScanAgent`), jeton sans `userGroupId`, acteur inconnu, acteur ne correspondant pas à l'utilisateur du
   * jeton, compte désactivé. N'exige AUCUN menu workflow (le menu `/assistant` est vérifié par le guard).
   */
  resolve(user: AuthUser): Promise<AsstIdentity>;
}

// ---------------------------------------------------------------------------
// Magasin (conversations, messages, propositions) — A1 fournit l'implémentation Prisma
// ---------------------------------------------------------------------------

/** Données d'une proposition à créer (le hash est calculé par l'appelant sur `asstCanonicalActionsJson`). */
export interface AsstNewProposal {
  conversationId: string;
  messageId: string;
  userId: number;
  userGroupId: number;
  actions: AsstProposedAction[];
  summary: string;
  /** SHA-256 hex du JSON canonique des actions. */
  argsHash: string;
  expiresAt: Date;
}

export interface AsstNewMessage {
  conversationId: string;
  role: AsstMessageRole;
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** `ged_ai_decision` de la génération, si journalisée. */
  aiDecisionId?: string | null;
}

/** Transition demandée sur une proposition (compare-and-set sur `rowVersion` ET sur le statut attendu). */
export interface AsstProposalTransition {
  proposalId: string;
  /** Verrou optimiste : la transition échoue (retourne `null`) si la version ou le statut ne correspondent plus. */
  expectedRowVersion: number;
  expectedStatus: AsstProposalStatus;
  to: AsstProposalStatus;
  /** Renseigné pour `Applied`. */
  result?: AsstProposalResultDto;
  /** Renseignés pour `Failed`. */
  errorCode?: string;
  errorMessage?: string;
  now: Date;
}

export interface AsstProposalStore {
  // Conversations — TOUTES les lectures et écritures sont bornées à `userId` (visibilité de l'auteur seul).
  createConversation(input: {
    userId: number;
    userGroupId: number;
    title?: string | null;
    pageContext?: AsstPageContext | null;
    now: Date;
  }): Promise<AsstConversationDto>;
  listConversations(userId: number, opts: { limit: number; offset: number }): Promise<{ items: AsstConversationDto[]; total: number }>;
  /** `null` si inexistante, supprimée (masquée) ou appartenant à un autre utilisateur. */
  getConversation(userId: number, conversationId: string): Promise<{ conversation: AsstConversationDto; messages: AsstMessageDto[] } | null>;
  /** Masque la conversation (`deleted_at`, `purge_at = now`). `false` si introuvable / pas à l'utilisateur. */
  deleteConversation(userId: number, conversationId: string, now: Date): Promise<boolean>;

  // Messages
  appendMessage(userId: number, input: AsstNewMessage, now: Date): Promise<AsstMessageDto | null>;

  // Propositions
  createProposal(input: AsstNewProposal, now: Date): Promise<AsstProposalDto>;
  /** `null` si introuvable OU appartenant à un autre utilisateur. */
  getProposal(userId: number, proposalId: string): Promise<AsstProposalDto | null>;
  /** Transition atomique ; `null` si le verrou optimiste ou le statut attendu ne correspondent plus. */
  transitionProposal(t: AsstProposalTransition): Promise<AsstProposalDto | null>;
  /** Propositions « proposées » échues (job d'expiration), triées par échéance, bornées. */
  listExpirableProposals(now: Date, limit: number): Promise<AsstProposalDto[]>;
}

// ---------------------------------------------------------------------------
// Planificateur (A1) : message utilisateur + contexte -> réponse + propositions
// ---------------------------------------------------------------------------

export interface AsstPlanInput {
  identity: AsstIdentity;
  conversationId: string;
  /** Contenu DÉJÀ validé (1..ASST_MESSAGE_MAX_CHARS). DONNÉE, jamais une consigne. */
  message: string;
  pageContext: AsstPageContext | null;
  /** Historique récent (ordre chronologique), borné par le planificateur. */
  history: ReadonlyArray<{ role: AsstMessageRole; content: string }>;
}

export interface AsstPlanResult {
  /** Réponse de l'assistant à afficher (texte). */
  reply: string;
  /** Actions proposées, déjà validées par `asstProposedActionsSchema`. Vide = simple réponse. Jamais exécutées. */
  actions: AsstProposedAction[];
  /** Résumé lisible de ce que la confirmation déclencherait (obligatoire si `actions` n'est pas vide). */
  summary: string | null;
  usage: AgentUsage;
  aiDecisionId?: string | null;
}

export interface AsstPlannerPort {
  /**
   * Plan d'une réponse. Lève `AsstError('budget_exceeded' | 'assistant_unavailable')` si la porte refuse.
   * Ne crée NI message NI proposition : c'est `AssistantService`/le store (A1) qui persistent le résultat.
   */
  plan(input: AsstPlanInput): Promise<AsstPlanResult>;
}

// ---------------------------------------------------------------------------
// Exécuteur (A2) : confirmer / refuser / expirer
// ---------------------------------------------------------------------------

export interface AsstExecutorPort {
  /**
   * Confirme ET exécute. Étapes obligatoires : proposition de l'utilisateur (sinon `not_found`) ; statut
   * « proposée » (`proposal_not_pending`) ; non expirée (`proposal_expired`, la proposition passe en « expirée ») ;
   * `confirm.argsHash` égal à celui de la proposition ET égal au hash RECALCULÉ des actions stockées (`conflict`) ;
   * acteur courant = `proposal.userGroupId` (sinon `identity_refused`) ; revalidation stricte des actions ;
   * transition 0->1 (CAS sur `rowVersion`) ; application avec les droits de l'utilisateur ; transition 1->2
   * (résultat) ou 1->5 (échec) puis `AsstError('effect_failed' | 'effect_forbidden', …, proposal)`.
   * Idempotence : une proposition déjà appliquée n'est JAMAIS rejouée (`proposal_not_pending`).
   */
  confirm(identity: AsstIdentity, proposalId: string, confirm: AsstConfirmProposalBody): Promise<AsstProposalDto>;
  /** Refuse (0->3). Même contrôles de propriété et de statut ; `reason` éventuel conservé dans le journal applicatif. */
  refuse(identity: AsstIdentity, proposalId: string, reason?: string): Promise<AsstProposalDto>;
  /** Lecture d'une proposition de l'utilisateur ; une proposition échue est présentée comme « expirée » (et clôturée). */
  get(identity: AsstIdentity, proposalId: string): Promise<AsstProposalDto>;
  /** Job : clôture (0->4) les propositions échues. Retourne le nombre de propositions expirées. */
  expireDue(now: Date, limit: number): Promise<number>;
}

/**
 * Service d'application consommé par le contrôleur pour les routes de conversation (créer, lister, lire,
 * poster un message, supprimer). Implémenté par A1 (orchestre store + planificateur + porte budgétaire).
 */
export interface AsstConversationsPort {
  create(identity: AsstIdentity, body: { title?: string; pageContext?: AsstPageContext }): Promise<AsstConversationDto>;
  list(identity: AsstIdentity, query: { limit: number; offset: number }): Promise<{ items: AsstConversationDto[]; total: number }>;
  detail(identity: AsstIdentity, conversationId: string): Promise<{ conversation: AsstConversationDto; messages: AsstMessageDto[] }>;
  postMessage(
    identity: AsstIdentity,
    conversationId: string,
    body: { content: string; pageContext?: AsstPageContext },
  ): Promise<{ conversation: AsstConversationDto; userMessage: AsstMessageDto; assistantMessage: AsstMessageDto }>;
  remove(identity: AsstIdentity, conversationId: string): Promise<void>;
}

export const ASST_CONVERSATIONS = 'ASST_CONVERSATIONS'; // AsstConversationsPort (A1)

// ---------------------------------------------------------------------------
// Porte de coût (A1) : AgentGate globale (definitionId réservé = ASST_GATE_DEFINITION_ID) + plafond par utilisateur/jour
// ---------------------------------------------------------------------------

export interface AsstReservation {
  readonly id: string;
  readonly userId: number;
  readonly reserved: AgentUsage;
  /** Réservation correspondante de la porte globale `WfAgentGate`. */
  readonly globalReservationId: string;
}

export interface AsstUserCap {
  /** Plafond du jour en devise du budget ; `null` = pas de plafond. */
  capAmount: number | null;
  capTokens: number | null;
  consumedAmount: number;
  consumedTokens: number;
}

export interface AsstGatePort {
  /** Mode IA, arrêt d'urgence global, puis plafond utilisateur du jour, SANS réserver. Lève `AsstError`. */
  assertRunnable(userId: number): Promise<void>;
  /**
   * Réserve ATOMIQUEMENT l'estimation sur le plafond utilisateur/jour (`asst_user_budget`) ET sur la porte
   * globale (`AgentGate`, `definitionId = ASST_GATE_DEFINITION_ID`). Lève `AsstError('budget_exceeded')` si
   * l'un des deux refuse (aucune réservation partielle ne subsiste), `assistant_unavailable` si l'IA est désactivée
   * ou l'arrêt d'urgence actif, ÉCHEC FERMÉ si le budget est illisible.
   */
  reserve(userId: number, estimate: AgentUsage): Promise<AsstReservation>;
  /** Remplace la réservation par la consommation réelle (jamais de refus : le coût est engagé). */
  settle(reservation: AsstReservation, actual: AgentUsage): Promise<void>;
  /** Libère une réservation dont l'appel n'a pas eu lieu. */
  release(reservation: AsstReservation): Promise<void>;
  /** Situation du jour de l'utilisateur (affichage, tests). */
  userCap(userId: number, now?: Date): Promise<AsstUserCap>;
}
