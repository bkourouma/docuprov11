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

export const searchSchema = z.object({
  fullText: z.string().optional(),
  documentTypeId: z.number().int().positive().optional(),
  dossierId: z.number().int().positive().optional(),
  planId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().optional(),
  fileTypeId: z.number().int().positive().optional(), // « Type de fichier » (legacy Recherche_multicriteres)
  createdByUserId: z.number().int().positive().optional(), // « Ajouté par » (legacy Recherche_multicriteres)
  documentDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  documentDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.array(z.object({ field: sortFieldEnum, dir: z.enum(['asc', 'desc']) })).optional(),
  groupBy: z.array(z.string()).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(500).default(50),
});

export const exportSchema = searchSchema.extend({
  format: z.enum(['xlsx', 'pdf', 'docx', 'csv']),
});

export type SearchDto = z.infer<typeof searchSchema>;
export type ExportDto = z.infer<typeof exportSchema>;
