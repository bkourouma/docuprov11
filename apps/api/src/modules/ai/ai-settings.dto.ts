import { z } from 'zod';
import { GED_AI_API_KEY_REF_REGEX } from '@archivage/types';

/** Texte annulable : la chaîne vide d'un formulaire devient `null` (« non renseigné »). */
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v && v.length > 0 ? v : null));

/** Référence de clé : NOM de variable d'environnement (jamais la clé), même forme que le service. */
const apiKeyRefText = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null))
  .refine((v) => v === null || GED_AI_API_KEY_REF_REGEX.test(v), {
    message: 'Référence de clé invalide (OPENAI_API_KEY ou GED_AI_*)',
  });

/**
 * Mise à jour PARTIELLE du paramétrage IA : un champ absent n'est pas touché, un champ à `null`
 * l'efface (quand la colonne SQL l'accepte). Seule la forme est vérifiée ici ; les règles métier
 * (cloud => masquage, plages, dimension, forme de la référence de clé) sont dans
 * `AiSettingsService.update`, qui les applique sur l'état RÉSULTANT (ligne existante + requête).
 */
export const updateAiSettingsSchema = z
  .object({
    mode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    provider: nullableText(50).optional(),
    model: nullableText(200).optional(),
    embeddingModel: nullableText(200).optional(),
    // La valeur imposée (1024) est vérifiée par le service ; ici, seulement un entier positif.
    embeddingDimension: z.number().int().positive().optional(),
    endpoint: nullableText(500).optional(),
    apiKeyRef: apiKeyRefText.optional(),
    maskingEnabled: z.boolean().optional(),
    autoApplyThreshold: z.number().min(0).max(1).nullable().optional(),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
  })
  // Un champ inconnu (faute de frappe, tentative d'injection) est refusé : 400, jamais ignoré.
  .strict();

export type UpdateAiSettingsDto = z.infer<typeof updateAiSettingsSchema>;

/** Vue du paramétrage pour l'administration : jamais la valeur d'une clé. */
export interface AiSettingsView {
  mode: 0 | 1 | 2;
  provider: string | null;
  model: string | null;
  embeddingModel: string | null;
  embeddingDimension: number;
  endpoint: string | null;
  apiKeyRef: string | null;
  maskingEnabled: boolean;
  autoApplyThreshold: number | null;
  timeoutSeconds: number;
  updatedAt: Date | null;
  updatedBy: number | null;
  /** `true` si une clé utilisable existe (référence, `GED_AI_API_KEY`, ou `OPENAI_API_KEY` en cloud OpenAI). */
  apiKeyConfigured: boolean;
}
