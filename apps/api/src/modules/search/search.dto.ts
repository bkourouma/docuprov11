import { z } from 'zod';

export const sortFieldEnum = z.enum([
  'label',
  'documentType',
  'cote',
  'documentDate',
  'createdAt',
  'dossier',
  'plan',
  'location',
]);

/**
 * Date AAAA-MM-JJ qui existe au CALENDRIER. Le seul format ne suffit pas : « 2026-02-30 » ou
 * « 2026-13-01 » passaient la regex puis faisaient échouer le `::date` de PostgreSQL, et la
 * requête de recherche (ou d'export) partait en 500 au lieu d'un 400 lisible.
 */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ')
  .refine((s) => {
    const [y = 0, m = 0, d = 0] = s.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }, 'Date inexistante');

const searchFields = z.object({
  fullText: z.string().optional(),
  documentTypeId: z.number().int().positive().optional(),
  dossierId: z.number().int().positive().optional(),
  planId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().optional(),
  fileTypeId: z.number().int().positive().optional(), // « Type de fichier » (legacy Recherche_multicriteres)
  createdByUserId: z.number().int().positive().optional(), // « Ajouté par » (legacy Recherche_multicriteres)
  documentDateFrom: calendarDate.optional(),
  documentDateTo: calendarDate.optional(),
  sort: z.array(z.object({ field: sortFieldEnum, dir: z.enum(['asc', 'desc']) })).optional(),
  groupBy: z.array(z.string()).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(500).default(50),
});

/**
 * Plage de dates inversée (« du » postérieur au « au ») : refusée plutôt que de renvoyer une liste
 * vide sans explication — l'utilisateur croirait qu'aucun document n'existe sur la période. Les
 * dates étant au format AAAA-MM-JJ validé, la comparaison lexicographique est chronologique.
 */
function checkDateRange(
  v: { documentDateFrom?: string; documentDateTo?: string },
  ctx: z.RefinementCtx,
): void {
  if (v.documentDateFrom && v.documentDateTo && v.documentDateFrom > v.documentDateTo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['documentDateTo'],
      message: 'La date de fin doit être postérieure ou égale à la date de début',
    });
  }
}

export const searchSchema = searchFields.superRefine(checkDateRange);

export const exportSchema = searchFields
  .extend({
    format: z.enum(['xlsx', 'pdf', 'docx', 'csv']),
  })
  .superRefine(checkDateRange);

export type SearchDto = z.infer<typeof searchSchema>;
export type ExportDto = z.infer<typeof exportSchema>;
