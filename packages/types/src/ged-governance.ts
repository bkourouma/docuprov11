import { z } from 'zod';
import { GedAiDecisionStatus, GedAiTask } from './ged';

// ===========================================================================
// Nettoyage et gouvernance (lot 5) — contrat partagé api / worker / web
// ===========================================================================
// Ajouts purs : rien ici ne modifie le socle IA du lot 1. Aucune table nouvelle : toutes les
// propositions sont des lignes de `ged_ai_decision` reconnues par `prompt_version =
// GED_GOVERNANCE_PROMPT_VERSION` (+ `task`), et le type de proposition est porté par `output.kind`.

/** File BullMQ des analyses de gouvernance (producteur api, consommateur worker). */
export const GED_GOVERNANCE_QUEUE = 'ged-governance';

/** Noms des jobs de la file `ged-governance`. */
export const GED_GOVERNANCE_JOBS = {
  /** Analyse UN document (doublons, données personnelles, sensibilité). */
  analyzeDocument: 'analyze-document',
  /** Analyse un lot (liste d'identifiants, ou tout l'archivé pour un administrateur). */
  analyzeBatch: 'analyze-batch',
} as const;
export type GedGovernanceJobName = (typeof GED_GOVERNANCE_JOBS)[keyof typeof GED_GOVERNANCE_JOBS];

export interface GedGovernanceDocumentJobData {
  documentId: number;
  /** `user_group_id` de l'auteur ; absent = déclenchement système. */
  requestedBy?: number | null;
}

export type GedGovernanceBatchJobData = {
  requestedBy?: number | null;
} & (
  | { scope: 'documents'; documentIds: number[] }
  /** Tout le fonds archivé (réservé aux administrateurs côté API), paginé par curseur. */
  | { scope: 'all'; afterDocumentId?: number }
);

export type GedGovernanceJobData = GedGovernanceDocumentJobData | GedGovernanceBatchJobData;

/** Résultat d'un job d'analyse. `disabled` ne concerne QUE la partie IA : le déterministe tourne toujours. */
export interface GedGovernanceAnalysisResult {
  documentId: number;
  /** `true` si l'IA est désactivée : seules les détections déterministes ont été produites. */
  aiDisabled: boolean;
  skipped?: 'document_not_found' | 'not_analyzable';
  /**
   * Détection des noms de personnes par le modèle : `enabled` (mode local), `disabled_cloud` (aucun texte
   * envoyé en cloud) ou `disabled_ai_off` (IA coupée). Aucune donnée : simple état.
   */
  namesDetection?: 'enabled' | 'disabled_cloud' | 'disabled_ai_off';
  /** Propositions créées (les doublons déjà connus ne sont pas recréés). */
  created: { kind: GovernanceKind; decisionId: string }[];
}

/** Version du gabarit / des règles de gouvernance (colonne `prompt_version`). */
export const GED_GOVERNANCE_PROMPT_VERSION = 'ged-governance-v1';

/** Fournisseur / modèle consignés quand la proposition est purement déterministe (IA coupée ou non sollicitée). */
export const GED_GOVERNANCE_DETERMINISTIC_PROVIDER = 'deterministe';
export const GED_GOVERNANCE_DETERMINISTIC_MODEL = 'regles-gouvernance-v1';

/** Message affiché quand l'IA est désactivée (hors constante du socle, qui reste « IA désactivée »). */
export const GED_GOVERNANCE_AI_OFF_MESSAGE =
  'IA désactivée : seules les détections déterministes (empreintes, motifs de données personnelles) sont actives. ' +
  'Les quasi-doublons par similarité sémantique et l’avis du modèle sont indisponibles.';

// --- Hypothèses métier (H4, signalées au superviseur) -------------------------------------------
/** Similarité cosinus minimale de deux documents pour proposer un quasi-doublon. */
export const GED_GOVERNANCE_NEAR_DUPLICATE_MIN_SIMILARITY = 0.95;
/** Similarité minimale de titre normalisé (Jaccard) pour le quasi-doublon « titre + métadonnées ». */
export const GED_GOVERNANCE_TITLE_MIN_SIMILARITY = 0.9;
/** Nombre maximal de quasi-doublons proposés par document analysé. */
export const GED_GOVERNANCE_MAX_NEAR_DUPLICATES = 10;
/** Taille d'un lot d'analyse (documents par job) et plafond d'une demande d'analyse par l'API. */
export const GED_GOVERNANCE_BATCH_SIZE = 50;
export const GED_GOVERNANCE_ANALYZE_MAX_DOCUMENTS = 200;
/** Plafond du texte analysé par document (caractères). */
export const GED_GOVERNANCE_MAX_TEXT_CHARS = 100_000;
/** Nombre maximal d'extraits masqués conservés par proposition de données personnelles. */
export const GED_GOVERNANCE_MAX_CONTEXTS = 6;
export const GED_GOVERNANCE_CONTEXT_RADIUS = 60;

// --- Types de proposition ----------------------------------------------------------------------

/** Nature d'une proposition (portée par `ged_ai_decision.output.kind`). */
export const GovernanceKind = {
  DoublonExact: 'duplicate_exact',
  QuasiDoublon: 'duplicate_near',
  DonneesPersonnelles: 'pii',
  Sensibilite: 'sensitivity',
} as const;
export type GovernanceKind = (typeof GovernanceKind)[keyof typeof GovernanceKind];

export const GOVERNANCE_KIND_VALUES = [
  GovernanceKind.DoublonExact,
  GovernanceKind.QuasiDoublon,
  GovernanceKind.DonneesPersonnelles,
  GovernanceKind.Sensibilite,
] as const;
export const GOVERNANCE_KINDS: readonly GovernanceKind[] = GOVERNANCE_KIND_VALUES;

export const GOVERNANCE_KIND_LABELS: Record<GovernanceKind, string> = {
  [GovernanceKind.DoublonExact]: 'Doublon exact',
  [GovernanceKind.QuasiDoublon]: 'Quasi-doublon',
  [GovernanceKind.DonneesPersonnelles]: 'Données personnelles',
  [GovernanceKind.Sensibilite]: 'Sensibilité',
};

/**
 * Tâche IA sous laquelle chaque nature est consignée. Le CHECK SQL de `ged_ai_decision.task` borne
 * la valeur à 0..7 (aucune tâche ne peut être ajoutée sans migration) : les doublons réutilisent
 * « Similarité / doublon », les données personnelles et la sensibilité « Autre ».
 */
export const GOVERNANCE_KIND_TASK: Record<GovernanceKind, GedAiTask> = {
  [GovernanceKind.DoublonExact]: GedAiTask.Similarite,
  [GovernanceKind.QuasiDoublon]: GedAiTask.Similarite,
  [GovernanceKind.DonneesPersonnelles]: GedAiTask.Autre,
  [GovernanceKind.Sensibilite]: GedAiTask.Autre,
};

/** Statuts visibles dans l'écran de gouvernance (les autres — appliquée auto, erreur — n'y figurent pas). */
export const GOVERNANCE_STATUSES = [
  GedAiDecisionStatus.Proposee,
  GedAiDecisionStatus.Validee,
  GedAiDecisionStatus.Rejetee,
] as const;
export type GovernanceStatus = (typeof GOVERNANCE_STATUSES)[number];

export const GOVERNANCE_STATUS_LABELS: Record<GovernanceStatus, string> = {
  [GedAiDecisionStatus.Proposee]: 'Proposée',
  [GedAiDecisionStatus.Validee]: 'Validée',
  [GedAiDecisionStatus.Rejetee]: 'Rejetée',
};

// --- Données personnelles ----------------------------------------------------------------------

/** Entités détectées. `name` (noms de personnes) n'est produit que par le modèle IA, jamais par motif. */
export const GOVERNANCE_PII_ENTITIES = ['email', 'phone', 'iban', 'card', 'nir', 'identity', 'name'] as const;
export type GovernancePiiEntity = (typeof GOVERNANCE_PII_ENTITIES)[number];

export const GOVERNANCE_PII_ENTITY_LABELS: Record<GovernancePiiEntity, string> = {
  email: 'Adresses e-mail',
  phone: 'Numéros de téléphone',
  iban: 'IBAN',
  card: 'Cartes bancaires',
  nir: 'Numéros de sécurité sociale',
  identity: 'Pièces d’identité',
  name: 'Noms de personnes',
};

/** Une famille de données personnelles trouvée : JAMAIS la valeur, seulement un compte et des contextes masqués. */
export interface GovernancePiiFinding {
  entity: GovernancePiiEntity;
  count: number;
  /** 0..1 : 1 = motif ET clé de contrôle valides ; moins = motif seul, ou avis du modèle. */
  confidence: number;
  /** Fenêtres de texte autour des occurrences, TOUTES valeurs masquées (au plus `GED_GOVERNANCE_MAX_CONTEXTS`). */
  contexts: string[];
}

/** Niveau de sensibilité estimé : 0 aucune, 1 modérée, 2 élevée. */
export type GovernanceSensitivityScore = 0 | 1 | 2;

// --- Sorties (champ `output` de `ged_ai_decision`) ---------------------------------------------

/** Trace de l'application d'une proposition validée. */
export const governanceAppliedSchema = z
  .object({
    action: z.enum(['confidentiality_set', 'duplicate_archived']),
    at: z.string().max(40),
    by: z.number().int().nullable(),
    previousConfidentialiteId: z.number().int().nullable().optional(),
    /** `true` si un abaissement a été appliqué sur confirmation explicite d'un gestionnaire habilité. */
    loweredWithConfirmation: z.boolean().optional(),
  })
  .strict();
export type GovernanceApplied = z.infer<typeof governanceAppliedSchema>;

export const governanceDuplicateOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum([GovernanceKind.DoublonExact, GovernanceKind.QuasiDoublon]),
    method: z.enum(['file_hash', 'source_hash', 'embedding', 'title_metadata']),
    /** 1 pour une empreinte identique ; sinon similarité mesurée (0..1). */
    similarity: z.number().min(0).max(1),
    /** Regroupe un original et ses doublons : `dup:<originalDocumentId>`. */
    groupKey: z.string().min(1).max(40),
    originalDocumentId: z.number().int().positive(),
    duplicateDocumentId: z.number().int().positive(),
    proposedAction: z.literal('archive_duplicate'),
    applied: governanceAppliedSchema.optional(),
  })
  .strict();
export type GovernanceDuplicateOutput = z.infer<typeof governanceDuplicateOutputSchema>;

export const governancePiiOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal(GovernanceKind.DonneesPersonnelles),
    findings: z
      .array(
        z
          .object({
            entity: z.enum(GOVERNANCE_PII_ENTITIES),
            count: z.number().int().min(1),
            confidence: z.number().min(0).max(1),
            contexts: z.array(z.string().max(400)).max(GED_GOVERNANCE_MAX_CONTEXTS),
          })
          .strict(),
      )
      .min(1)
      .max(GOVERNANCE_PII_ENTITIES.length),
    /** Confiance globale : la plus haute des familles trouvées. */
    overallConfidence: z.number().min(0).max(1),
    /** `ai: true` si le modèle a contribué (noms, avis de sensibilité). */
    detection: z.object({ deterministic: z.literal(true), ai: z.boolean() }).strict(),
    applied: governanceAppliedSchema.optional(),
  })
  .strict();
export type GovernancePiiOutput = z.infer<typeof governancePiiOutputSchema>;

export const GOVERNANCE_SENSITIVITY_REASONS = [
  'pii_email',
  'pii_phone',
  'pii_iban',
  'pii_card',
  'pii_nir',
  'pii_identity',
  'pii_name',
  'keyword_health',
  'keyword_hr',
  'keyword_legal',
  'keyword_finance',
  'keyword_secret',
  'ai_moderate',
  'ai_high',
] as const;
export type GovernanceSensitivityReason = (typeof GOVERNANCE_SENSITIVITY_REASONS)[number];

export const governanceSensitivityOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal(GovernanceKind.Sensibilite),
    score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    currentConfidentialiteId: z.number().int().nullable(),
    currentRank: z.number().int().nullable(),
    proposedConfidentialiteId: z.number().int().positive(),
    proposedRank: z.number().int(),
    /** `raise` : élévation (ou pose d'un niveau là où il n'y en avait pas) ; `lower` : abaissement. */
    direction: z.enum(['raise', 'lower']),
    reasons: z.array(z.enum(GOVERNANCE_SENSITIVITY_REASONS)).max(GOVERNANCE_SENSITIVITY_REASONS.length),
    detection: z.object({ deterministic: z.literal(true), ai: z.boolean() }).strict(),
    applied: governanceAppliedSchema.optional(),
  })
  .strict();
export type GovernanceSensitivityOutput = z.infer<typeof governanceSensitivityOutputSchema>;

export type GovernanceOutput =
  | GovernanceDuplicateOutput
  | GovernancePiiOutput
  | GovernanceSensitivityOutput;

/** Lit `output` d'une décision : `null` si ce n'est pas une proposition de gouvernance valide. */
export function parseGovernanceOutput(output: unknown): GovernanceOutput | null {
  if (typeof output !== 'object' || output === null) return null;
  const kind = (output as { kind?: unknown }).kind;
  const schema =
    kind === GovernanceKind.DoublonExact || kind === GovernanceKind.QuasiDoublon
      ? governanceDuplicateOutputSchema
      : kind === GovernanceKind.DonneesPersonnelles
        ? governancePiiOutputSchema
        : kind === GovernanceKind.Sensibilite
          ? governanceSensitivityOutputSchema
          : null;
  if (!schema) return null;
  const parsed = schema.safeParse(output);
  return parsed.success ? (parsed.data as GovernanceOutput) : null;
}

// --- API : requêtes ---------------------------------------------------------------------------

export const GED_GOVERNANCE_MAX_PAGE_SIZE = 100;
const positiveInt = z.coerce.number().int().positive().max(2_147_483_647);

export const governanceListQuerySchema = z
  .object({
    kind: z.enum(GOVERNANCE_KIND_VALUES).optional(),
    status: z.coerce
      .number()
      .int()
      .refine((v) => (GOVERNANCE_STATUSES as readonly number[]).includes(v), 'Statut inconnu')
      .optional(),
    documentId: positiveInt.optional(),
    groupKey: z.string().min(1).max(40).optional(),
    minConfidence: z.coerce.number().min(0).max(1).optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(GED_GOVERNANCE_MAX_PAGE_SIZE).default(25),
  })
  .strict();
export type GovernanceListQuery = z.infer<typeof governanceListQuerySchema>;

/** Corps de `POST /governance/proposals/:id/validate`. */
export const governanceValidateRequestSchema = z
  .object({
    /** Obligatoire (`true`) pour appliquer un ABAISSEMENT de confidentialité ; ignoré sinon. */
    confirmLowering: z.boolean().optional(),
  })
  .strict();
export type GovernanceValidateRequest = z.infer<typeof governanceValidateRequestSchema>;

/** Corps de `POST /governance/analyze` : un document, une liste, ou tout le fonds (administrateur). */
export const governanceAnalyzeRequestSchema = z.union([
  z.object({ documentId: positiveInt }).strict(),
  z
    .object({
      documentIds: z.array(positiveInt).min(1).max(GED_GOVERNANCE_ANALYZE_MAX_DOCUMENTS),
    })
    .strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
export type GovernanceAnalyzeRequest = z.infer<typeof governanceAnalyzeRequestSchema>;

// --- API : réponses ---------------------------------------------------------------------------

/** Résumé d'un document pour la comparaison côte à côte (accès déjà vérifié par l'API). */
export interface GovernanceDocumentSummary {
  documentId: number;
  label: string;
  cote: string | null;
  documentDate: string | null;
  documentTypeLabel: string | null;
  confidentialiteLabel: string | null;
  createdAt: string;
  fileCount: number;
  pageCount: number | null;
  byteLength: number | null;
  /** Début du texte de synthèse du document (`overview`), tronqué ; jamais le texte intégral. */
  overviewExcerpt: string | null;
  isFrozen: boolean;
}

export interface GovernanceProposalView {
  id: string;
  kind: GovernanceKind;
  status: GovernanceStatus;
  /** 0..1 ou `null`. */
  confidence: number | null;
  documentId: number | null;
  documentLabel: string | null;
  /** Doublons : document de référence. */
  originalDocumentId: number | null;
  originalDocumentLabel: string | null;
  /** Doublons : identifiant de regroupement. */
  groupKey: string | null;
  /** Sensibilité : libellés des niveaux courant et proposé. */
  currentConfidentialiteLabel: string | null;
  proposedConfidentialiteLabel: string | null;
  /** Extrait d'entrée MASQUÉ et tronqué (journal du socle IA). */
  excerpt: string | null;
  output: GovernanceOutput;
  provider: string | null;
  model: string;
  inputMasked: boolean;
  createdAt: string;
  validatedBy: number | null;
  validatedAt: string | null;
  /** Sensibilité : `true` si la validation exige `confirmLowering` (abaissement). */
  requiresLoweringConfirmation: boolean;
}

export interface GovernanceProposalDetail extends GovernanceProposalView {
  /** Doublons uniquement. */
  comparison: { original: GovernanceDocumentSummary; duplicate: GovernanceDocumentSummary } | null;
}

export interface GovernanceProposalPage {
  items: GovernanceProposalView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GovernanceKindCounts {
  proposee: number;
  validee: number;
  rejetee: number;
  total: number;
}

export interface GovernanceDashboard {
  aiEnabled: boolean;
  aiMessage: string | null;
  /** Comptes limités aux documents que l'utilisateur peut ouvrir. */
  byKind: Record<GovernanceKind, GovernanceKindCounts>;
  totals: GovernanceKindCounts;
  /** Groupes de doublons distincts (propositions en attente), toujours dans le périmètre d'accès. */
  openDuplicateGroups: number;
  generatedAt: string;
}

export interface GovernanceAnalyzeResponse {
  queued: number;
  /** Identifiants soumis que l'utilisateur ne peut pas ouvrir : ignorés, sans plus de détail. */
  ignored: number;
  aiEnabled: boolean;
  /** Message clair quand l'IA est désactivée. */
  message: string | null;
}

export interface GovernanceReviewResponse {
  proposal: GovernanceProposalView;
  /** Effet appliqué au document (`null` pour un rejet ou une donnée personnelle, qui ne modifie rien). */
  applied: GovernanceApplied | null;
}
