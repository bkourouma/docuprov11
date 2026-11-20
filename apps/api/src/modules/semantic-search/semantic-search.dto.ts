import { z } from 'zod';
import {
  gedAskRequestSchema,
  gedSemanticSearchRequestSchema,
  type GedAskRequest,
  type GedSemanticSearchRequest,
} from '@archivage/types';

export { gedAskRequestSchema, gedSemanticSearchRequestSchema };
export type { GedAskRequest, GedSemanticSearchRequest };

/**
 * Réindexation : `{}` (tout) ou `{ documentId }` (un document). Strict : tout autre champ => 400.
 * La taille du corps est bornée par les schémas (1000 caractères au plus) et par la limite JSON
 * par défaut d'Express (100 ko) : aucune route n'accepte davantage.
 */
export const semanticReindexRequestSchema = z
  .object({ documentId: z.number().int().min(1).max(2147483647).optional() })
  .strict();
export type SemanticReindexRequest = z.infer<typeof semanticReindexRequestSchema>;
