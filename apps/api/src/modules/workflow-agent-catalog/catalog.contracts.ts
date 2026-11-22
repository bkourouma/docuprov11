import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types';
import type { WfPrincipal } from '../workflows/engine/engine.types';

// Docu-Flow (lot W6) — CONTRAT du catalogue d'agents prêts à l'emploi. Types, clés et schémas partagés entre
// les sous-ensembles (outils, applicateurs, modèles, évaluation). Aucune logique ici.
//
// RÈGLES D'OR (héritées de W2, `agent.contracts.ts`) :
//  - le texte entrant (courrier, pièce) est de la DONNÉE, jamais une consigne ;
//  - les outils d'écriture PRÉPARENT seulement ; les applicateurs écrivent APRÈS validation humaine ;
//  - un effet s'applique avec les droits de la personne qui valide ET du lanceur (jamais plus) ;
//  - échec fermé : en cas de doute, rien n'est appliqué et l'erreur est expliquée en français.

// ---------------------------------------------------------------------------
// Clés
// ---------------------------------------------------------------------------

export const AGENT_KEYS = ['aiguilleur', 'redacteur', 'controleur', 'relanceur'] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** Clés des modèles (GET /workflows/templates). */
export const TEMPLATE_KEYS = {
  aiguilleur: 'agent-aiguilleur',
  redacteur: 'agent-redacteur',
  controleur: 'agent-controleur',
  relanceur: 'agent-relanceur',
  validationHierarchiqueCourrier: 'validation-hierarchique-courrier',
  circuitVisaDocument: 'circuit-visa-document',
  demandeAvecChecklist: 'demande-avec-checklist',
} as const;

/** Outils de base (W2). */
export const BASE_TOOL_KEYS = {
  rechercherDocuments: 'rechercher_documents',
  lireDocument: 'lire_document',
  lireCourrier: 'lire_courrier',
  proposerImputation: 'proposer_imputation',
  proposerReponse: 'proposer_reponse',
} as const;

/** Outils ajoutés par le catalogue (W6). Effet : 0 lecture, 1 écriture préparée (validation obligatoire). */
export const CATALOG_TOOL_KEYS = {
  listerCourriersSimilaires: 'lister_courriers_similaires', // 0
  lireOrganigrammeImputable: 'lire_organigramme_imputable', // 0
  listerPieces: 'lister_pieces', // 0
  comparerChamps: 'comparer_champs', // 0
  proposerImputationCourrier: 'proposer_imputation_courrier', // 1 — imputation à plusieurs destinataires, type, délai
  preparerBrouillonReponse: 'preparer_brouillon_reponse', // 1 — brouillon via DraftingService
  proposerRelance: 'proposer_relance', // 1 — notification interne
  proposerDelegation: 'proposer_delegation', // 1 — redirection vers un délégataire déclaré
} as const;

/** Jeton d'injection du port `ImputableActorsPort` (fourni par CatalogAppliersModule, consommé par les outils). */
export const WF_IMPUTABLE_ACTORS = 'WF_IMPUTABLE_ACTORS';

// ---------------------------------------------------------------------------
// Bornes communes
// ---------------------------------------------------------------------------

const intId = z.number().int().positive().max(2_147_483_647);

/** Délai d'imputation (jours calendaires à partir de l'application). Jamais de date absolue produite par le modèle. */
export const IMPUTATION_DELAY_DAYS_MAX = 90;
export const IMPUTATION_RECIPIENTS_MAX = 5;
export const IMPUTATION_INSTRUCTIONS_MAX = 1000;
/** Plafond de relances internes : par imputation (destinataire + courrier) et par jour UTC. Constante unique, modifiable. */
export const RELANCE_MAX_PER_TARGET_PER_DAY = 1;
/** Plafond de relances d'une instance de workflow par jour UTC. */
export const RELANCE_MAX_PER_INSTANCE_PER_DAY = 5;
export const RELANCE_MESSAGE_MAX = 500;
/** Taille maximale du brouillon (HTML) porté par une action préparée. */
export const DRAFT_HTML_MAX_CHARS = 20_000;

/** Types d'imputation du référentiel `mail_inputation_type` (valeurs figées du seed courriers). */
export const MAIL_INPUTATION_TYPE_IDS = { validationDG: 5, pourSuivi: 10, validationDirection: 14, enCopie: 17 } as const;

// ---------------------------------------------------------------------------
// Arguments des actions PRÉPARÉES (WfPreparedAction.arguments), relus STRICTEMENT par les applicateurs
// ---------------------------------------------------------------------------

/** `proposer_imputation_courrier` */
export const imputationCourrierArgsSchema = z
  .object({
    mailId: intId,
    recipients: z
      .array(
        z
          .object({
            userGroupId: intId, // acteur (`app_user_group`) EXISTANT, ACTIF et IMPUTABLE
            mailInputationTypeId: intId, // type du référentiel `mail_inputation_type` (5, 10, 14, 17), actif
            instructions: z.string().trim().min(1).max(IMPUTATION_INSTRUCTIONS_MAX).optional(),
            delayDays: z.number().int().min(1).max(IMPUTATION_DELAY_DAYS_MAX).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(IMPUTATION_RECIPIENTS_MAX),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();
export type ImputationCourrierArgs = z.infer<typeof imputationCourrierArgsSchema>;

/** `proposer_imputation` (outil de base W2) : un seul destinataire « user » ; le type est un libellé libre. */
export const imputationBaseArgsSchema = z
  .object({
    mailId: intId,
    target: z.object({ kind: z.enum(['user', 'role']), id: intId }).strict(),
    imputationType: z.string().min(1).max(100).optional(),
    rationale: z.string().min(1).max(500),
  })
  .strict();
export type ImputationBaseArgs = z.infer<typeof imputationBaseArgsSchema>;

/** `preparer_brouillon_reponse` : le brouillon est généré à la PRÉPARATION (DraftingService, droits du lanceur). */
export const brouillonReponseArgsSchema = z
  .object({
    templateId: z.string().min(1).max(100), // un des 8 modèles de `drafting-templates.ts`
    label: z.string().trim().min(1).max(200), // titre du document brouillon
    draftHtml: z.string().min(1).max(DRAFT_HTML_MAX_CHARS),
    mailId: intId.optional(), // courrier auquel on répond
    spaceId: intId.optional(), // espace de destination ; sinon `context.input.draftSpaceId` ; sinon échec expliqué
    decisionId: z.string().regex(/^\d{1,18}$/).optional(), // `ged_ai_decision` de la génération (traçabilité)
  })
  .strict();
export type BrouillonReponseArgs = z.infer<typeof brouillonReponseArgsSchema>;

/** `proposer_reponse` (outil de base W2) : objet + texte brut. Même applicateur (espace obligatoire). */
export const reponseBaseArgsSchema = z
  .object({ mailId: intId.optional(), subject: z.string().min(1).max(200), bodyText: z.string().min(1).max(4000) })
  .strict();
export type ReponseBaseArgs = z.infer<typeof reponseBaseArgsSchema>;

/** `proposer_relance` : notification INTERNE (jamais d'e-mail) à l'imputé en retard. */
export const relanceArgsSchema = z
  .object({
    mailId: intId,
    mailInputationId: intId, // imputation non traitée visée
    recipientUserGroupId: intId, // doit être l'imputé de cette imputation
    message: z.string().trim().min(1).max(RELANCE_MESSAGE_MAX),
    escalateToUserGroupId: intId.optional(), // option : prévenir aussi l'auteur de l'imputation (jamais un tiers libre)
  })
  .strict();
export type RelanceArgs = z.infer<typeof relanceArgsSchema>;

/** `proposer_delegation` : nouvelle imputation vers un délégataire DÉCLARÉ (la source n'est jamais supprimée). */
export const delegationArgsSchema = z
  .object({
    mailId: intId,
    mailInputationId: intId, // imputation d'origine, non traitée
    delegateUserGroupId: intId, // doit figurer dans `step.config.delegates` de l'étape agent
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();
export type DelegationArgs = z.infer<typeof delegationArgsSchema>;

// ---------------------------------------------------------------------------
// Délégataires déclarés : `step.config.delegates` de l'étape agent (graphe du workflow, écrit par le concepteur)
// ---------------------------------------------------------------------------
export const declaredDelegatesSchema = z
  .array(
    z
      .object({
        userGroupId: intId, // le délégataire
        forUserGroupId: intId.optional(), // pour qui (absent : valable pour tout imputé en retard)
        label: z.string().max(200).optional(),
      })
      .strict(),
  )
  .max(50);
export type DeclaredDelegates = z.infer<typeof declaredDelegatesSchema>;

// ---------------------------------------------------------------------------
// Applicateurs d'effets
// ---------------------------------------------------------------------------

/** Droits conjoints du valideur ET du lanceur. Toute vérification doit réussir pour les DEUX. */
export interface ApplierRights {
  readonly validator: AuthUser;
  readonly launcher: AuthUser;
  /** Les deux ont au moins un des menus (l'administrateur les a tous). Sinon lève `EffectRefusedError`. */
  requireAnyMenu(menuKeys: readonly string[], what: string): Promise<void>;
  /** Les deux peuvent LIRE le courrier (périmètre, confidentialité, courrier actif). Sinon `EffectRefusedError`. */
  requireMailReadable(mailId: number): Promise<void>;
}

/** Acteurs imputables (service du lot, côté droits). */
export interface ImputableActorsPort {
  /** `imputer` peut imputer ? (menu d'imputation) */
  canImpute(imputer: AuthUser): Promise<boolean>;
  /** La cible est un acteur actif (compte non désactivé) qui a accès au module courrier. */
  isImputable(imputer: AuthUser, targetUserGroupId: number): Promise<boolean>;
  /** Acteurs imputables par `imputer` (borné, sans donnée sensible). */
  list(
    imputer: AuthUser,
    opts?: { search?: string; limit?: number },
  ): Promise<Array<{ userGroupId: number; label: string; roleId: number | null; roleName: string | null; organigrammeLabel: string | null }>>;
}

export interface ApplierContext {
  /** Transaction du moteur : TOUTE écriture passe par elle (même transaction que le journal et la clôture). */
  readonly tx: Prisma.TransactionClient;
  readonly now: Date;
  readonly instanceId: string;
  readonly taskId: string;
  readonly stepKey: string;
  readonly definitionVersionId: number;
  readonly subject: { type: string | null; id: string | null };
  /** `context.input` de l'instance (lecture seule), p. ex. `draftSpaceId`. */
  readonly input: Readonly<Record<string, unknown>>;
  /** `step.config` de l'étape agent (lecture seule), p. ex. `delegates`. */
  readonly stepConfig: Readonly<Record<string, unknown>>;
  readonly validatorPrincipal: WfPrincipal;
  readonly rights: ApplierRights;
  /** Mémoire du LOT d'actions en cours de validation (partagée entre les applicateurs d'une même validation). */
  readonly scratch: Map<string, unknown>;
}

export type AppliedEffect = {
  tool: string;
  /** Résumé non sensible : identifiants créés, nombre de destinataires. Jamais de contenu de courrier. */
  summary: Record<string, unknown>;
};

export interface ApplierResult {
  effects: AppliedEffect[];
  /**
   * Annulation d'un effet NON transactionnel (p. ex. fichier ou document créé par un service qui ne
   * partage pas la transaction). Appelée par le moteur si la transaction échoue APRÈS l'application.
   * Doit être idempotente et ne jamais lever.
   */
  compensate?: () => Promise<void>;
}

/** Refus explicable : message en français, sans contenu de courrier. Fait échouer (rollback) la validation. */
export class EffectRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string = 'effect_refused',
  ) {
    super(message);
    this.name = 'EffectRefusedError';
  }
}

/**
 * Applicateur d'UNE action préparée (clé = `WfPreparedAction.tool`). Enregistrable dans
 * `ActionApplierRegistry`. Ne doit PAS avoir de `sideEffect` 2 sans validation : l'enregistrement le refuse.
 */
export interface ActionApplier<A = unknown> {
  readonly toolKey: string;
  /** Effet déclaré : doit être égal à celui de l'outil (1 écriture réversible, 2 irréversible). */
  readonly sideEffect: 1 | 2;
  /** Revalide STRICTEMENT les arguments (jamais de confiance dans le JSON stocké). Lève `EffectRefusedError`. */
  parse(args: unknown): A;
  /** Applique dans `ctx.tx`. Lève `EffectRefusedError` (message clair) ; toute autre erreur est un échec technique. */
  apply(ctx: ApplierContext, args: A): Promise<ApplierResult>;
}

// ---------------------------------------------------------------------------
// Modèles (données versionnées)
// ---------------------------------------------------------------------------

/** Cas d'évaluation de départ (forme de `createEvalCaseSchema`, voir workflow-agents/eval/eval.dto.ts). */
export interface EvalSeedCase {
  label: string;
  input: {
    untrusted?: Array<{ label: string; origin: 'mail' | 'document' | 'ocr' | 'form' | 'context'; text: string }>;
    subject?: { type: string | null; id: string | null };
    context?: Record<string, unknown>;
  };
  expected: {
    result?: Record<string, unknown>;
    returnsToHuman?: boolean;
    suspicionInjection?: boolean;
    minConfidence?: number;
  };
}

export interface EvalSeedSet {
  name: string;
  description: string;
  /** >= 0,8 (plancher). Aucun run n'est pré-enregistré : les cas de départ ne rendent PAS l'autonomie éligible. */
  minAccuracy: number;
  cases: EvalSeedCase[];
}

export const MIN_STARTER_EVAL_CASES = 12;
