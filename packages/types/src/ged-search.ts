import { z } from 'zod';
import { GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL, GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL } from './ged';

// ===========================================================================
// Recherche sémantique et questions-réponses (lot 3) — contrat partagé api / worker / web
// ===========================================================================
// Sans dépendance d'exécution (hors zod). Ajouts purs : rien ici ne modifie le socle IA du lot 1.

/** File BullMQ d'indexation (segmentation + embeddings). Producteur api, consommateur worker. */
export const GED_EMBEDDING_QUEUE = 'ged-embedding';

/** Noms des jobs de la file `ged-embedding`. */
export const GED_EMBEDDING_JOBS = {
  /** Réindexe UN document (version courante) : remplace ses segments. */
  reindexDocument: 'reindex-document',
  /** Réindexation complète : met en file un job par document archivé. */
  reindexAll: 'reindex-all',
  /** Rattrapage périodique : ne réindexe que les documents dont l'index est absent ou périmé. */
  sweep: 'sweep',
} as const;
export type GedEmbeddingJobName = (typeof GED_EMBEDDING_JOBS)[keyof typeof GED_EMBEDDING_JOBS];

/** Données d'un job `reindex-document`. */
export interface GedEmbeddingDocumentJobData {
  documentId: number;
  /** `user_group_id` de l'auteur ; absent = déclenchement système. */
  requestedBy?: number | null;
}

/** Données des jobs `reindex-all` et `sweep`. */
export interface GedEmbeddingBulkJobData {
  requestedBy?: number | null;
}

export type GedEmbeddingJobData = GedEmbeddingDocumentJobData | GedEmbeddingBulkJobData;

/** Résultat d'un job `reindex-document`. */
export type GedEmbeddingResult =
  | { disabled: true; message: string }
  | {
      disabled: false;
      documentId: number;
      /** `no_text` : aucun texte (OCR absent) ; `not_indexable` : brouillon, épuré ou gelé. */
      skipped?: 'no_text' | 'document_not_found' | 'not_indexable';
      chunks: number;
    };

// --- Paramètres métier (hypothèses signalées au superviseur) -----------------------------------

/** Taille cible d'un segment, en caractères. */
export const GED_CHUNK_TARGET_CHARS = 800;
/** Chevauchement entre deux segments consécutifs, en caractères. */
export const GED_CHUNK_OVERLAP_CHARS = 120;
/** Nombre maximal de segments envoyés au modèle pour une question. */
export const GED_QA_MAX_SEGMENTS = 8;
/** Similarité cosinus (1 - distance) en dessous de laquelle un segment n'est pas une source. */
export const GED_QA_MIN_SIMILARITY = 0.3;
/** Longueur maximale de la question / requête (caractères). */
export const GED_SEMANTIC_QUERY_MAX_CHARS = 1000;
export const GED_SEMANTIC_QUERY_MIN_CHARS = 2;
/** Nombre de résultats de la recherche sémantique (défaut et maximum). */
export const GED_SEMANTIC_DEFAULT_LIMIT = 10;
export const GED_SEMANTIC_MAX_LIMIT = 20;
/** Longueur maximale de l'extrait de segment renvoyé au client. */
export const GED_SEMANTIC_EXCERPT_MAX_CHARS = 300;

/**
 * Nom canonique du modèle d'embedding, identique côté API et worker : espaces retirés, valeur
 * vide (ou absente) = modèle par défaut du mode. Indispensable : `ged_document_chunk` est filtrée
 * par égalité stricte sur `embedding_model`.
 */
export function normalizeEmbeddingModel(raw: string | null | undefined, cloud: boolean): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed) return trimmed;
  return cloud ? GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL : GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL;
}

/** Version du prompt de question-réponse (tracée dans `ged_ai_decision.prompt_version`). */
export const GED_QA_PROMPT_VERSION = 'ged-qa-v1';

/** Réponse quand les sources autorisées sont insuffisantes. */
export const GED_QA_UNKNOWN_ANSWER =
  'Je ne sais pas : les documents auxquels vous avez accès ne contiennent pas assez d’éléments pour répondre à cette question.';

/** Message affiché quand l'IA est désactivée et que la recherche retombe sur le plein texte. */
export const GED_SEMANTIC_FALLBACK_MESSAGE =
  'L’IA est désactivée : voici les résultats de la recherche plein texte. La recherche sémantique et les réponses aux questions sont indisponibles.';

// --- Requêtes API (zod strict) ------------------------------------------------------------------

const queryText = (min: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(GED_SEMANTIC_QUERY_MAX_CHARS);

export const gedSemanticSearchRequestSchema = z
  .object({
    query: queryText(GED_SEMANTIC_QUERY_MIN_CHARS),
    limit: z.number().int().min(1).max(GED_SEMANTIC_MAX_LIMIT).default(GED_SEMANTIC_DEFAULT_LIMIT),
  })
  .strict();
export type GedSemanticSearchRequest = z.infer<typeof gedSemanticSearchRequestSchema>;

export const gedAskRequestSchema = z.object({ question: queryText(3) }).strict();
export type GedAskRequest = z.infer<typeof gedAskRequestSchema>;

// --- Réponses API --------------------------------------------------------------------------------

/** Un résultat : un segment (sémantique) ou un document (plein texte : champs de segment à `null`). */
export interface GedSemanticHit {
  documentId: number;
  documentLabel: string;
  versionId: number | null;
  versionNumber: number | null;
  pageFrom: number | null;
  pageTo: number | null;
  chunkIndex: number | null;
  /** Extrait (au plus `GED_SEMANTIC_EXCERPT_MAX_CHARS`). */
  excerpt: string;
  /** Similarité cosinus 0..1 ; `null` en repli plein texte. */
  score: number | null;
}

export interface GedSemanticSearchResponse {
  /** `fulltext` : IA désactivée, repli sur la recherche plein texte. */
  mode: 'semantic' | 'fulltext';
  message?: string;
  hits: GedSemanticHit[];
}

/** Citation d'une réponse : `marker` est le numéro [n] employé dans le texte de la réponse. */
export interface GedCitation {
  marker: number;
  documentId: number;
  documentLabel: string;
  versionId: number | null;
  versionNumber: number | null;
  pageFrom: number | null;
  pageTo: number | null;
  excerpt: string;
}

export interface GedAskResponse {
  mode: 'semantic' | 'fulltext';
  /** `false` : « je ne sais pas » (sources insuffisantes) ou IA désactivée. */
  answered: boolean;
  /** Texte de la réponse (vide en repli plein texte). */
  answer: string;
  citations: GedCitation[];
  /** Repli plein texte : documents trouvés. Vide sinon. */
  hits: GedSemanticHit[];
  message?: string;
  /** Identifiant de `ged_ai_decision` (texte, BigInt côté base) ; `null` si aucune décision. */
  decisionId: string | null;
}

// --- Sortie structurée du modèle (tâche Question) ------------------------------------------------

/**
 * Sortie attendue du modèle : `citations` liste des NUMÉROS de segments fournis (1..n). Toute
 * valeur hors de cet intervalle est écartée par l'application (jamais citée).
 */
export const gedAiQaOutputSchema = z
  .object({
    answerable: z.boolean(),
    answer: z.string().max(4000),
    citations: z.array(z.number().int().min(1).max(GED_QA_MAX_SEGMENTS)).max(GED_QA_MAX_SEGMENTS),
  })
  .strict();
export type GedAiQaOutput = z.infer<typeof gedAiQaOutputSchema>;

/** JSON Schema (sortie structurée stricte) équivalent à `gedAiQaOutputSchema`. */
export const GED_AI_QA_JSON_SCHEMA = {
  name: 'ged_qa_answer',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['answerable', 'answer', 'citations'],
    properties: {
      answerable: { type: 'boolean' },
      answer: { type: 'string' },
      citations: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: GED_QA_MAX_SEGMENTS },
      },
    },
  },
} as const;
