// Assistant « qui agit » — contrat d'échange (api / web) : schémas zod stricts pour tout ce qui est reçu du
// client, types pour les DTO de lecture, catalogue des routes (source de vérité du contrat).
// Conventions : dates ISO 8601 en chaîne, identifiants BigInt exposés en chaîne, jamais de jeton exposé.
import { z } from 'zod';
import {
  ASST_MESSAGE_MAX_CHARS,
  ASST_PROPOSAL_ACTIONS_MAX,
  ASST_TITLE_MAX_CHARS,
  AsstActionTool,
  AsstErrorCode,
  type AsstMessageRole,
  type AsstProposalStatus,
} from './asst-enums';

// ---------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------

/** Identifiant BigInt exposé en chaîne (1 à 18 chiffres). */
export const asstIdSchema = z.string().regex(/^\d{1,18}$/);
export type AsstId = z.infer<typeof asstIdSchema>;

/**
 * Contexte de la page où se trouve l'utilisateur. C'est une DONNÉE (jamais une consigne) : le serveur
 * ne lui accorde aucune autorité et revérifie les droits sur le sujet désigné.
 */
export const asstPageContextSchema = z
  .object({
    route: z.string().trim().min(1).max(200).startsWith('/'),
    subjectType: z
      .string()
      .max(50)
      .regex(/^[a-z0-9_.]+$/)
      .optional(),
    subjectId: asstIdSchema.optional(),
  })
  .strict();
export type AsstPageContext = z.infer<typeof asstPageContextSchema>;

// ---------------------------------------------------------------------------
// Actions proposées
// ---------------------------------------------------------------------------
// Les schémas d'arguments REPRODUISENT les contraintes de ceux du catalogue d'agents
// (apps/api/src/modules/workflow-agent-catalog/catalog.contracts.ts : imputationCourrierArgsSchema,
// relanceArgsSchema, brouillonReponseArgsSchema). packages/types ne pouvant pas importer apps/api, les constantes
// sont recopiées ; l'équivalence avec le catalogue est vérifiée par un test côté API.

export const ASST_IMPUTATION_DELAY_DAYS_MAX = 90;
export const ASST_IMPUTATION_RECIPIENTS_MAX = 5;
export const ASST_IMPUTATION_INSTRUCTIONS_MAX = 1000;
export const ASST_RELANCE_MESSAGE_MAX = 500;
export const ASST_DRAFT_HTML_MAX_CHARS = 20_000;

const intId = z.number().int().positive().max(2_147_483_647);

/** `proposer_imputation_courrier` */
export const asstImputationArgsSchema = z
  .object({
    mailId: intId,
    recipients: z
      .array(
        z
          .object({
            userGroupId: intId,
            mailInputationTypeId: intId,
            instructions: z.string().trim().min(1).max(ASST_IMPUTATION_INSTRUCTIONS_MAX).optional(),
            delayDays: z.number().int().min(1).max(ASST_IMPUTATION_DELAY_DAYS_MAX).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ASST_IMPUTATION_RECIPIENTS_MAX),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();
export type AsstImputationArgs = z.infer<typeof asstImputationArgsSchema>;

/** `proposer_relance` : notification interne à l'imputé en retard. */
export const asstRelanceArgsSchema = z
  .object({
    mailId: intId,
    mailInputationId: intId,
    recipientUserGroupId: intId,
    message: z.string().trim().min(1).max(ASST_RELANCE_MESSAGE_MAX),
    escalateToUserGroupId: intId.optional(),
  })
  .strict();
export type AsstRelanceArgs = z.infer<typeof asstRelanceArgsSchema>;

/** `preparer_brouillon_reponse` */
export const asstBrouillonArgsSchema = z
  .object({
    templateId: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(200),
    draftHtml: z.string().min(1).max(ASST_DRAFT_HTML_MAX_CHARS),
    mailId: intId.optional(),
    spaceId: intId.optional(),
    decisionId: z
      .string()
      .regex(/^\d{1,18}$/)
      .optional(),
  })
  .strict();
export type AsstBrouillonArgs = z.infer<typeof asstBrouillonArgsSchema>;

/** Action proposée : union discriminée sur `tool` (la délégation est exclue en v1). */
export const asstProposedActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal(AsstActionTool.ImputationCourrier), args: asstImputationArgsSchema }).strict(),
  z.object({ tool: z.literal(AsstActionTool.Relance), args: asstRelanceArgsSchema }).strict(),
  z.object({ tool: z.literal(AsstActionTool.BrouillonReponse), args: asstBrouillonArgsSchema }).strict(),
]);
export type AsstProposedAction = z.infer<typeof asstProposedActionSchema>;

export const asstProposedActionsSchema = z.array(asstProposedActionSchema).min(1).max(ASST_PROPOSAL_ACTIONS_MAX);

// ---------------------------------------------------------------------------
// DTO de lecture (types)
// ---------------------------------------------------------------------------

export type AsstConversationDto = {
  conversationId: string;
  title: string | null;
  pageContext: AsstPageContext | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  /** Date de purge programmée (rétention). */
  purgeAt: string;
  messageCount: number;
};

export type AsstProposalResultDto = {
  effects: { tool: string; summary: Record<string, unknown> }[];
};

export type AsstProposalDto = {
  proposalId: string;
  conversationId: string;
  messageId: string;
  status: AsstProposalStatus;
  actions: AsstProposedAction[];
  summary: string;
  /** SHA-256 hexadécimal du JSON canonique des actions (calculé par l'API, cf. asstCanonicalActionsJson). */
  argsHash: string;
  expiresAt: string;
  createdAt: string;
  confirmedAt: string | null;
  finishedAt: string | null;
  result: AsstProposalResultDto | null;
  errorCode: string | null;
  errorMessage: string | null;
  rowVersion: number;
};

export const ASST_CLARIFICATION_CHOICES_MIN = 2;
export const ASST_CLARIFICATION_CHOICES_MAX = 6;
export const ASST_CLARIFICATION_CHOICE_MAX_CHARS = 80;

/**
 * Question de précision posée par l'assistant (au lieu de deviner) : texte brut, 2 à 6 choix distincts de 80
 * caractères au plus. Chaque choix peut être renvoyé tel quel comme message utilisateur.
 */
export const asstClarificationSchema = z
  .object({
    question: z.string().trim().min(1).max(500).optional(),
    choices: z
      .array(z.string().trim().min(1).max(ASST_CLARIFICATION_CHOICE_MAX_CHARS))
      .min(ASST_CLARIFICATION_CHOICES_MIN)
      .max(ASST_CLARIFICATION_CHOICES_MAX)
      .refine((c) => new Set(c).size === c.length, { message: 'Choix en double.' }),
  })
  .strict();
export type AsstClarificationDto = z.infer<typeof asstClarificationSchema>;

/** Aucun jeton n'est exposé. */
export type AsstMessageDto = {
  messageId: string;
  conversationId: string;
  role: AsstMessageRole;
  content: string;
  position: number;
  createdAt: string;
  proposals: AsstProposalDto[];
  /** Optionnel : présent quand l'assistant pose une question de précision (message assistant seulement). */
  clarification?: AsstClarificationDto | null;
};

/** Corps de TOUTE erreur de /assistant/**. */
export type AsstErrorBodyDto = {
  statusCode: number;
  errorCode: AsstErrorCode;
  message: string;
  details?: unknown;
  proposal?: AsstProposalDto;
};

// ---------------------------------------------------------------------------
// Requêtes (schémas zod stricts)
// ---------------------------------------------------------------------------

/**
 * Caractères de contrôle interdits : NUL, C0 (sauf tabulation, LF, CR), DEL et C1.
 * Le texte multiligne (message) autorise tabulation, LF et CR ; le titre (affiché sur une ligne) les refuse aussi.
 */
// eslint-disable-next-line no-control-regex
const ASST_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// eslint-disable-next-line no-control-regex
const ASST_TITLE_FORBIDDEN_RE = /[\u0000-\u001F\u007F-\u009F]/;
const noControlChars = (v: string): boolean => !ASST_CONTROL_CHARS_RE.test(v);
const NO_CONTROL_MESSAGE = 'Le texte contient des caractères de contrôle interdits.';
const NO_TITLE_CONTROL_MESSAGE = 'Le titre ne doit contenir ni retour à la ligne ni caractère de contrôle.';

/** L'utilisateur est celui du jeton, JAMAIS dans le corps. */
export const createConversationBody = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(ASST_TITLE_MAX_CHARS)
      .refine((v) => !ASST_TITLE_FORBIDDEN_RE.test(v), { message: NO_TITLE_CONTROL_MESSAGE })
      .optional(),
    pageContext: asstPageContextSchema.optional(),
  })
  .strict();
export type AsstCreateConversationBody = z.infer<typeof createConversationBody>;

export const listConversationsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();
export type AsstListConversationsQuery = z.infer<typeof listConversationsQuery>;

export const conversationIdParam = asstIdSchema;
export const proposalIdParam = asstIdSchema;

export const postMessageBody = z
  .object({
    content: z.string().trim().min(1).max(ASST_MESSAGE_MAX_CHARS).refine(noControlChars, { message: NO_CONTROL_MESSAGE }),
    pageContext: asstPageContextSchema.optional(),
  })
  .strict();
export type AsstPostMessageBody = z.infer<typeof postMessageBody>;

/**
 * La confirmation est LIÉE au contenu affiché : si le hash ne correspond plus à celui de la proposition,
 * le serveur répond 409 `conflict`.
 */
export const confirmProposalBody = z
  .object({
    argsHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type AsstConfirmProposalBody = z.infer<typeof confirmProposalBody>;

export const refuseProposalBody = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type AsstRefuseProposalBody = z.infer<typeof refuseProposalBody>;

// ---------------------------------------------------------------------------
// Réponses (types)
// ---------------------------------------------------------------------------

export type AsstCreateConversationResponse = AsstConversationDto;
export type AsstListConversationsResponse = { items: AsstConversationDto[]; total: number };
export type AsstConversationDetailResponse = { conversation: AsstConversationDto; messages: AsstMessageDto[] };
/** Les propositions éventuelles sont dans `assistantMessage.proposals`. */
export type AsstPostMessageResponse = {
  conversation: AsstConversationDto;
  userMessage: AsstMessageDto;
  assistantMessage: AsstMessageDto;
};
export type AsstConfirmProposalResponse = AsstProposalDto;
export type AsstRefuseProposalResponse = AsstProposalDto;
export type AsstGetProposalResponse = AsstProposalDto;
// DELETE /assistant/conversations/:id -> 204 sans corps.

// ---------------------------------------------------------------------------
// Catalogue des routes (source de vérité : le contrôleur et la doc doivent le respecter)
// ---------------------------------------------------------------------------

export const ASST_ROUTE_MENU = '/assistant';

export type AsstRouteKey =
  | 'createConversation'
  | 'listConversations'
  | 'getConversation'
  | 'postMessage'
  | 'confirmProposal'
  | 'refuseProposal'
  | 'getProposal'
  | 'deleteConversation';

export type AsstRouteDef = {
  key: AsstRouteKey;
  method: 'GET' | 'POST' | 'DELETE';
  /** Chemin relatif au préfixe de l'API, comme dans le contrôleur. */
  path: string;
  successStatus: 200 | 201 | 204;
  menu: typeof ASST_ROUTE_MENU;
  /** Noms de schémas zod exportés par ce module. */
  request: { params?: string; query?: string; body?: string };
  /** Nom du type de réponse (« none » : aucun corps). */
  response: string;
  errors: readonly AsstErrorCode[];
};

const E = AsstErrorCode;

export const ASST_ROUTES: readonly AsstRouteDef[] = [
  {
    key: 'createConversation',
    method: 'POST',
    path: '/assistant/conversations',
    successStatus: 201,
    menu: ASST_ROUTE_MENU,
    request: { body: 'createConversationBody' },
    response: 'AsstCreateConversationResponse',
    errors: [E.InvalidInput, E.IdentityRefused, E.AssistantUnavailable, E.NotImplemented],
  },
  {
    key: 'listConversations',
    method: 'GET',
    path: '/assistant/conversations',
    successStatus: 200,
    menu: ASST_ROUTE_MENU,
    request: { query: 'listConversationsQuery' },
    response: 'AsstListConversationsResponse',
    errors: [E.InvalidInput, E.IdentityRefused, E.NotImplemented],
  },
  {
    key: 'getConversation',
    method: 'GET',
    path: '/assistant/conversations/:id',
    successStatus: 200,
    menu: ASST_ROUTE_MENU,
    request: { params: 'conversationIdParam' },
    response: 'AsstConversationDetailResponse',
    errors: [E.InvalidInput, E.NotFound, E.IdentityRefused, E.NotImplemented],
  },
  {
    key: 'postMessage',
    method: 'POST',
    path: '/assistant/conversations/:id/messages',
    successStatus: 201,
    menu: ASST_ROUTE_MENU,
    request: { params: 'conversationIdParam', body: 'postMessageBody' },
    response: 'AsstPostMessageResponse',
    errors: [
      E.InvalidInput,
      E.NotFound,
      E.IdentityRefused,
      E.BudgetExceeded,
      E.AssistantUnavailable,
      E.NotImplemented,
    ],
  },
  {
    key: 'confirmProposal',
    method: 'POST',
    path: '/assistant/proposals/:id/confirm',
    successStatus: 200,
    menu: ASST_ROUTE_MENU,
    request: { params: 'proposalIdParam', body: 'confirmProposalBody' },
    response: 'AsstConfirmProposalResponse',
    errors: [
      E.InvalidInput,
      E.NotFound,
      E.IdentityRefused,
      E.ProposalExpired,
      E.ProposalNotPending,
      E.Conflict,
      E.EffectForbidden,
      E.EffectFailed,
      E.NotImplemented,
    ],
  },
  {
    key: 'refuseProposal',
    method: 'POST',
    path: '/assistant/proposals/:id/refuse',
    successStatus: 200,
    menu: ASST_ROUTE_MENU,
    request: { params: 'proposalIdParam', body: 'refuseProposalBody' },
    response: 'AsstRefuseProposalResponse',
    errors: [E.InvalidInput, E.NotFound, E.IdentityRefused, E.ProposalExpired, E.ProposalNotPending, E.Conflict, E.NotImplemented],
  },
  {
    key: 'getProposal',
    method: 'GET',
    path: '/assistant/proposals/:id',
    successStatus: 200,
    menu: ASST_ROUTE_MENU,
    request: { params: 'proposalIdParam' },
    response: 'AsstGetProposalResponse',
    errors: [E.InvalidInput, E.NotFound, E.IdentityRefused, E.NotImplemented],
  },
  {
    key: 'deleteConversation',
    method: 'DELETE',
    path: '/assistant/conversations/:id',
    successStatus: 204,
    menu: ASST_ROUTE_MENU,
    request: { params: 'conversationIdParam' },
    response: 'none',
    errors: [E.InvalidInput, E.NotFound, E.IdentityRefused, E.NotImplemented],
  },
];

// ---------------------------------------------------------------------------
// Fonctions utilitaires pures
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = sortKeysDeep(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * JSON canonique des actions : clés triées récursivement, sans espaces ; l'ordre du tableau est conservé.
 * C'est cette chaîne que l'API hache en SHA-256 (`argsHash`). Le hachage n'est volontairement PAS ici
 * (pas de `crypto` Node dans ce paquet, pour rester compatible navigateur) : il est calculé par l'API.
 */
export function asstCanonicalActionsJson(actions: AsstProposedAction[]): string {
  return JSON.stringify(sortKeysDeep(actions));
}

/** Une proposition est expirée dès `now >= expiresAt`. */
export function isAsstProposalExpired(expiresAtIso: string, now: Date): boolean {
  return now.getTime() >= new Date(expiresAtIso).getTime();
}
