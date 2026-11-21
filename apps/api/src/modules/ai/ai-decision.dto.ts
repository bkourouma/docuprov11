import { z } from 'zod';

/** Plafond de page : une liste de décisions embarque des sorties JSON, elle doit rester légère. */
export const AI_DECISION_MAX_PAGE_SIZE = 100;

/**
 * Entier de requête : une chaîne vide (ou blanche) est refusée au lieu d'être coercée en 0.
 * `NaN` fait échouer `z.coerce.number()` : 400.
 */
const queryInt = (min: number, max?: number) => {
  const bounded = max === undefined ? z.number().int().min(min) : z.number().int().min(min).max(max);
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? Number.NaN : v),
    z.coerce.number().pipe(bounded),
  );
};

/** Filtres et pagination de `GET /ged/ai/decisions` (paramètres de requête, donc des chaînes). */
export const listAiDecisionsQuerySchema = z.object({
  status: queryInt(0, 4).optional(),
  task: queryInt(0, 7).optional(),
  documentId: queryInt(1, 2147483647).optional(),
  page: queryInt(1).optional(),
  pageSize: queryInt(1, AI_DECISION_MAX_PAGE_SIZE).optional(),
});

export type ListAiDecisionsQuery = z.infer<typeof listAiDecisionsQuerySchema>;
