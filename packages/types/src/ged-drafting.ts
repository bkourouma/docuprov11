// Contrat REST de la rédaction assistée par l'IA dans l'éditeur natif (lot 4c). Ajouts non cassants.
//
// Le brouillon est TOUJOURS une proposition : l'API ne l'enregistre jamais, ne l'insère jamais dans
// un document. Seule une action humaine dans l'éditeur (Insérer / Remplacer la sélection) l'y place.
import { z } from 'zod';
import type { GedCollabCreated } from './ged-collab';

/** Version de prompt journalisée dans `ged_ai_decision.prompt_version` (tâche « Autre »). */
export const GED_DRAFT_PROMPT_VERSION = 'drafting-v1';

/** Identifiant de modèle : minuscules, chiffres, tirets (catalogue versionné dans le dépôt). */
export const GED_DRAFT_TEMPLATE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** Modèle sans contenu : toujours disponible, y compris IA désactivée. */
export const GED_DRAFT_EMPTY_TEMPLATE_ID = 'vide';

export const GED_DRAFT_INSTRUCTION_MIN_CHARS = 3;
export const GED_DRAFT_INSTRUCTION_MAX_CHARS = 2000;
/** Nombre maximal de documents fournis comme contexte. */
export const GED_DRAFT_MAX_CONTEXT_DOCUMENTS = 5;
/** Texte de contexte conservé par document (caractères) et au total, avant masquage et envoi. */
export const GED_DRAFT_CONTEXT_DOC_MAX_CHARS = 4000;
export const GED_DRAFT_CONTEXT_TOTAL_MAX_CHARS = 16000;
/** Taille maximale du brouillon renvoyé (HTML assaini, caractères). */
export const GED_DRAFT_OUTPUT_MAX_CHARS = 20000;
/** Libellé maximal d'un document créé depuis un modèle (colonne `document.label`). */
export const GED_DRAFT_LABEL_MAX_CHARS = 500;
/** Débit : générations par utilisateur et par minute. */
export const GED_DRAFT_RATE_LIMIT_PER_MINUTE = 5;

/** Mention affichée avec tout brouillon. */
export const GED_DRAFT_REVIEW_NOTICE =
  'Brouillon proposé par l’IA : relisez-le et corrigez-le avant de l’insérer. Rien n’est enregistré sans votre action.';

const MAX_ID = 2_147_483_647;
const positiveId = z.number().int().positive().max(MAX_ID);

/** POST /drafting/draft */
export const gedDraftRequestSchema = z
  .object({
    templateId: z.string().regex(GED_DRAFT_TEMPLATE_ID_REGEX),
    instruction: z
      .string()
      .trim()
      .min(GED_DRAFT_INSTRUCTION_MIN_CHARS, 'Consigne trop courte')
      .max(GED_DRAFT_INSTRUCTION_MAX_CHARS, 'Consigne trop longue'),
    /** Documents (autorisés) dont les données alimentent le brouillon. Un seul refus = 404 uniforme. */
    contextDocumentIds: z.array(positiveId).max(GED_DRAFT_MAX_CONTEXT_DOCUMENTS).optional(),
    /** Dossier : ses documents AUTORISÉS (au plus 5) servent de contexte. */
    dossierId: positiveId.optional(),
  })
  .strict();
export type GedDraftRequest = z.infer<typeof gedDraftRequestSchema>;

/** POST /drafting/documents */
export const gedDraftCreateDocumentSchema = z
  .object({
    spaceId: positiveId,
    templateId: z.string().regex(GED_DRAFT_TEMPLATE_ID_REGEX),
    label: z.string().trim().min(1, 'Libellé obligatoire').max(GED_DRAFT_LABEL_MAX_CHARS),
  })
  .strict();
export type GedDraftCreateDocumentRequest = z.infer<typeof gedDraftCreateDocumentSchema>;
export type GedDraftCreateDocumentResponse = GedCollabCreated;

/** Entrée du catalogue (sans squelette). */
export interface GedDraftTemplateSummary {
  id: string;
  label: string;
  description: string;
  category: string;
}

/** GET /drafting/templates */
export interface GedDraftTemplatesResponse {
  /** `false` : IA désactivée ; seul le modèle vide (et les squelettes) restent utilisables. */
  aiEnabled: boolean;
  aiMessage?: string;
  templates: GedDraftTemplateSummary[];
}

/** GET /drafting/templates/:id : le squelette est du HTML déjà assaini (liste blanche de l'éditeur). */
export interface GedDraftTemplateDetail extends GedDraftTemplateSummary {
  skeletonHtml: string;
}

/** Réponse de POST /drafting/draft. */
export type GedDraftResponse =
  | { disabled: true; message: string }
  | {
      disabled: false;
      templateId: string;
      /** HTML assaini et validé (structure) : jamais exécutable. Une PROPOSITION. */
      draftHtml: string;
      /** Texte brut équivalent (aperçu, lecteurs d'écran). */
      draftText: string;
      /** Nombre de documents réellement utilisés comme contexte. */
      contextDocumentCount: number;
      /** Identifiant de la décision du journal IA (`ged_ai_decision`), sérialisé. */
      decisionId: string | null;
      provider: string;
      model: string;
      notice: string;
    };

/** Sortie JSON exigée du modèle. */
export const gedAiDraftOutputSchema = z
  .object({ html: z.string().min(1).max(GED_DRAFT_OUTPUT_MAX_CHARS * 2) })
  .strict();
export type GedAiDraftOutput = z.infer<typeof gedAiDraftOutputSchema>;

export const GED_AI_DRAFT_JSON_SCHEMA = {
  name: 'ged_draft',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['html'],
    properties: { html: { type: 'string' } },
  },
} as const;
