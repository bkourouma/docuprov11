import type { AsstPageContext, AsstProposedAction } from '@archivage/types';
import { ASST_PROPOSAL_ACTIONS_MAX } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import type { AsstIdentity } from '../assistant.contracts';

// Planificateur de l'assistant (lot A1) — CONTRATS INTERNES entre les sous-ensembles du planificateur
// (outils de lecture, prompt et analyse du tour, validateur d'actions, boucle). Types et constantes seulement.
//
// RÈGLES D'OR du planificateur :
//  - le message de l'utilisateur est la SEULE source d'intention ; le contenu des courriers, documents, noms
//    d'acteurs, libellés et résultats d'outils est de la DONNÉE (jamais une consigne) ;
//  - le planificateur ne fait QUE lire (outils de lecture avec les droits de l'utilisateur) et proposer ; il
//    n'écrit jamais dans mail_inputation, notification ou documents ;
//  - ce qui sera fait est décrit par le CODE (résumé construit depuis les arguments validés et les noms résolus),
//    jamais par le texte du modèle ;
//  - ÉCHEC FERMÉ : au moindre doute (suspicion, destinataire ambigu, courrier illisible, délai ambigu), aucune
//    action : l'assistant pose une question ou répond par un refus explicite.

// ---------------------------------------------------------------------------
// Constantes (un seul endroit)
// ---------------------------------------------------------------------------

/** Version du prompt (journal `ged_ai_decision.prompt_version`). */
export const PLANNER_PROMPT_VERSION = 'asst-planner-v1';
/** Appels au modèle au plus pour UN message utilisateur. */
export const PLANNER_MAX_TURNS = 5;
/** Appels d'outils de lecture au plus pour UN message utilisateur. */
export const PLANNER_MAX_TOOL_CALLS = 6;
/** Historique transmis au modèle : messages les plus récents, bornés en nombre et en caractères. */
export const PLANNER_HISTORY_MAX_MESSAGES = 10;
export const PLANNER_HISTORY_MAX_CHARS = 6_000;
/** Plafond de sortie d'un tour du modèle (jetons). */
export const PLANNER_MAX_OUTPUT_TOKENS = 2_000;
/** Texte d'une réponse ou d'une question du modèle (caractères). */
export const PLANNER_REPLY_MAX_CHARS = 1_500;
export const PLANNER_QUESTION_MAX_CHARS = 500;
/** Choix d'une question de précision. */
export const PLANNER_CHOICES_MIN = 2;
export const PLANNER_CHOICES_MAX = 6;
export const PLANNER_CHOICE_LABEL_MAX_CHARS = 80;
/** Texte d'un courrier renvoyé au modèle par `lire_courrier` (caractères). */
export const PLANNER_MAIL_TEXT_MAX_CHARS = 6_000;
/** Résultats bornés des outils de recherche. */
export const PLANNER_SEARCH_DEFAULT_LIMIT = 10;
export const PLANNER_SEARCH_MAX_LIMIT = 20;
/** Défaut du nombre d'actions par proposition (borne dure : `ASST_PROPOSAL_ACTIONS_MAX` = 5). */
export const PLANNER_MAX_ACTIONS_DEFAULT = 3;

/** Nombre maximal d'actions par proposition : `ASST_PLANNER_MAX_ACTIONS` (1..5), sinon 3. Jamais plus de 5. */
export function plannerMaxActions(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ASST_PLANNER_MAX_ACTIONS'];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) return PLANNER_MAX_ACTIONS_DEFAULT;
  return Math.min(n, ASST_PROPOSAL_ACTIONS_MAX);
}

// ---------------------------------------------------------------------------
// Outils de LECTURE (les seuls que le modèle peut appeler)
// ---------------------------------------------------------------------------

export const PLANNER_READ_TOOLS = [
  'lire_courrier', // { mailId? } : sans mailId, le courrier de la page ouverte (contexte de page)
  'rechercher_courriers', // { query, limit? }
  'acteurs_imputables', // { search?, limit? } : acteurs imputables par l'utilisateur ; « DAF » = filtre texte
  'types_imputation', // {} : types d'imputation actifs
  'imputations_courrier', // { mailId } : imputations existantes (acteur, type, échéance, traité, en retard)
  'modeles_brouillon', // {} : modèles de rédaction disponibles
  'espaces_ecriture', // {} : espaces où l'utilisateur peut déposer un brouillon
] as const;
export type PlannerReadTool = (typeof PLANNER_READ_TOOLS)[number];

export interface PlannerToolDescriptor {
  key: PlannerReadTool;
  label: string;
  description: string;
  /** JSON Schema des arguments (affiché au modèle). La validation qui fait foi est celle du schéma zod de l'outil. */
  jsonSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Vues renvoyées par le port de données (sans donnée sensible : jamais d'e-mail ni d'identifiant de connexion)
// ---------------------------------------------------------------------------

export interface PlannerMailView {
  mailId: number;
  reference: string | null;
  title: string | null;
  date: string | null;
  senderLabel: string | null;
  natureLabel: string | null;
  objetLabel: string | null;
  confidentialiteLabel: string | null;
  /** Extrait du texte (OCR/lecture) borné à `maxChars`. DONNÉE non fiable. */
  text: string | null;
}

export interface PlannerMailHit {
  mailId: number;
  reference: string | null;
  title: string | null;
  date: string | null;
  senderLabel: string | null;
}

export interface PlannerActorView {
  userGroupId: number;
  /** Libellé « Nom — Groupe » (DONNÉE : un nom d'acteur peut être piégé). */
  label: string;
  roleName: string | null;
  organigrammeLabel: string | null;
}

export interface PlannerInputationTypeView {
  id: number;
  label: string;
  suivi: boolean;
}

export interface PlannerInputationView {
  mailInputationId: number;
  mailId: number;
  actorUserGroupId: number;
  actorLabel: string;
  actorActive: boolean;
  typeId: number;
  typeLabel: string;
  deadline: Date | null;
  treated: boolean;
  /** `deadline` dépassée ET non traitée, à l'instant `now` fourni à la lecture. */
  late: boolean;
  createdBy: number | null;
}

export interface PlannerDraftTemplateView {
  id: string;
  label: string;
}

export interface PlannerSpaceView {
  spaceId: number;
  label: string;
}

export type PlannerDraftResult =
  | { status: 'ok'; draftHtml: string; decisionId: string | null }
  | { status: 'disabled' | 'refused'; message: string };

/**
 * Accès du planificateur aux données, TOUJOURS au nom de l'utilisateur (`user`, relu en base). `null` ou liste vide
 * signifie « refus OU introuvable » : jamais distingués. Implémentation : `planner-data.adapter.ts` (réutilise
 * `AgentDataAdapter`, `CatalogDataAdapter`, `ImputableActorsService`, `MailSearchService`, `SpacesService`).
 * AUCUNE méthode n'écrit dans mail_inputation, notification ou documents.
 */
export interface AsstPlannerDataPort {
  readMail(user: AuthUser, mailId: number, maxChars: number): Promise<PlannerMailView | null>;
  searchMails(user: AuthUser, query: string, limit: number): Promise<PlannerMailHit[]>;
  /** Acteurs imputables par l'utilisateur ; `search` = filtre texte (nom, groupe). Vide si l'utilisateur ne peut pas imputer. */
  listActors(user: AuthUser, opts: { search?: string; limit: number }): Promise<PlannerActorView[]>;
  /** Types d'imputation ACTIFS du référentiel. */
  listInputationTypes(): Promise<PlannerInputationTypeView[]>;
  /** Imputations d'un courrier LISIBLE par l'utilisateur ; `null` si le courrier est illisible ou introuvable. */
  listInputations(user: AuthUser, mailId: number, now: Date, limit: number): Promise<PlannerInputationView[] | null>;
  canImpute(user: AuthUser): Promise<boolean>;
  /** Acteur actif ET imputable par l'utilisateur ; sinon `null`. */
  resolveImputableActor(user: AuthUser, userGroupId: number): Promise<{ userGroupId: number; label: string } | null>;
  /** Ligne ACTIVE du référentiel, ou `null`. */
  getActiveInputationType(typeId: number): Promise<PlannerInputationTypeView | null>;
  /** Imputation identique (courrier, acteur, type) encore OUVERTE (non traitée) ? */
  hasOpenImputation(mailId: number, userGroupId: number, typeId: number): Promise<boolean>;
  /** Une imputation du courrier, vue de l'utilisateur ; `null` si le courrier est illisible ou l'imputation n'est pas de ce courrier. */
  readInputation(user: AuthUser, mailId: number, mailInputationId: number, now: Date): Promise<PlannerInputationView | null>;
  /** Relances internes déjà envoyées aujourd'hui (UTC) à ce destinataire pour ce courrier. */
  countTargetRelancesToday(mailId: number, recipientUserGroupId: number, now: Date): Promise<number>;
  listDraftTemplates(): PlannerDraftTemplateView[];
  /** Espaces où l'utilisateur peut contribuer (déposer un document). */
  listWritableSpaces(user: AuthUser, limit: number): Promise<PlannerSpaceView[]>;
  /**
   * Génère un brouillon avec les droits de l'utilisateur (rédaction assistée existante), sans rien écrire.
   * `instruction` = le message de l'UTILISATEUR (jamais un texte issu d'un courrier).
   */
  generateDraft(
    user: AuthUser,
    request: { templateId: string; instruction: string; mailId?: number },
    requestedBy: number,
  ): Promise<PlannerDraftResult>;
}

// ---------------------------------------------------------------------------
// Preuves recueillies pendant la boucle (ce que le modèle a VRAIMENT vu par les outils, avec les droits de l'utilisateur)
// ---------------------------------------------------------------------------

export interface PlannerEvidence {
  /** Courriers effectivement lus ou trouvés par un outil (droits de l'utilisateur). */
  mails: Map<number, { mailId: number; reference: string | null; title: string | null }>;
  /** Recherches de courriers faites : texte cherché et identifiants renvoyés. */
  mailSearches: Array<{ query: string; mailIds: number[] }>;
  /** Appels de `acteurs_imputables` : filtre texte utilisé (null = sans filtre) et acteurs renvoyés. */
  actorSearches: Array<{ search: string | null; actors: PlannerActorView[] }>;
  /** Imputations vues par `imputations_courrier`. */
  inputations: Map<number, PlannerInputationView>;
  /** Textes de tiers vus (texte de courrier, objets, noms, libellés) : analysés par `detectInjection`. */
  untrustedTexts: string[];
}

export function emptyEvidence(): PlannerEvidence {
  return { mails: new Map(), mailSearches: [], actorSearches: [], inputations: new Map(), untrustedTexts: [] };
}

// ---------------------------------------------------------------------------
// Boîte à outils de lecture (une instance par message traité)
// ---------------------------------------------------------------------------

export interface PlannerToolCallResult {
  ok: boolean;
  /** Donnée renvoyée au modèle (sera encadrée comme DONNÉE non fiable). Message générique d'échec si `ok` est faux. */
  output: unknown;
}

export interface PlannerToolbox {
  /** Descripteurs des outils de lecture (pour le prompt). */
  describe(): PlannerToolDescriptor[];
  /** Exécute un outil de lecture. Ne lève JAMAIS : outil inconnu, arguments invalides ou données illisibles = `ok: false`. */
  call(tool: string, args: unknown): Promise<PlannerToolCallResult>;
  /** Preuves recueillies (mises à jour par `call`). */
  readonly evidence: PlannerEvidence;
}

export interface PlannerToolboxContext {
  user: AuthUser;
  pageContext: AsstPageContext | null;
  now: Date;
}

// ---------------------------------------------------------------------------
// Validateur d'actions proposées
// ---------------------------------------------------------------------------

/** Action brute proposée par le modèle (non fiable). */
export interface PlannerRawAction {
  tool: string;
  args: Record<string, unknown>;
}

export interface ActionValidationInput {
  identity: AsstIdentity;
  /** Message de l'utilisateur courant (donnée d'intention) et messages utilisateur précédents de l'échange. */
  userMessage: string;
  previousUserMessages: readonly string[];
  pageContext: AsstPageContext | null;
  evidence: PlannerEvidence;
  rawActions: readonly PlannerRawAction[];
  /**
   * Génération d'un brouillon, BUDGÉTÉE par le planificateur (réservation/règlement sur la porte de coût autour de
   * `AsstPlannerDataPort.generateDraft`). Le validateur n'appelle JAMAIS directement le port pour générer.
   */
  draftGenerator: (request: { templateId: string; instruction: string; mailId?: number }) => Promise<PlannerDraftResult>;
  now: Date;
  /** Borne du nombre d'actions (≤ 5). */
  maxActions: number;
}

export type ActionValidationOutcome =
  | {
      ok: true;
      /** Actions validées (schéma strict + `parse` de l'applicateur du catalogue + contrôles à blanc). */
      actions: AsstProposedAction[];
      /** Résumé lisible CONSTRUIT PAR LE CODE (noms résolus), ≤ ASST_SUMMARY_MAX_CHARS. */
      summary: string;
      /** `ged_ai_decision` de la génération d'un brouillon, s'il y en a eu (traçabilité). */
      aiDecisionId: string | null;
    }
  | {
      ok: false;
      /**
       * `clarify` : une précision de l'utilisateur lèverait le doute (message construit par le code, avec choix) ;
       * `refuse` : l'action ne peut pas être proposée (droit, doublon, pas en retard, intention non établie…).
       */
      kind: 'clarify' | 'refuse';
      /** Message FRANÇAIS construit par le code, sans contenu de courrier brut. */
      message: string;
      /** Code court pour les tests et les journaux (jamais un extrait de contenu). */
      reason: string;
    };

export interface AsstActionValidator {
  /** Ne lève JAMAIS pour une cause métier. Aucune écriture métier. Échec fermé. */
  validate(input: ActionValidationInput): Promise<ActionValidationOutcome>;
}

/** Jeton d'injection du validateur (provider interne du module). */
export const ASST_ACTION_VALIDATOR = 'ASST_ACTION_VALIDATOR';
/** Jeton d'injection du port de données du planificateur. */
export const ASST_PLANNER_DATA = 'ASST_PLANNER_DATA';
