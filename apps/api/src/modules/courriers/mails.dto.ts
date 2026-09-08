import { z } from 'zod';

const optionalId = z.number().int().positive().optional();

/** Pagination des worklists (query string, coercition des chaînes). */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
});

/** Enregistrement d'un courrier Arrivée (§05). Le destinataire est un rôle, pas une personne. */
export const createArriveeSchema = z.object({
  title: z.string().trim().min(1),
  date: z.coerce.date(),
  destinataireRoleId: z.number().int().positive(),
  description: z.string().optional(),
  reference: z.string().optional(),
  nReference: z.string().optional(),
  dateEnregistrementCourrier: z.coerce.date().optional(),
  dateFollowUp: z.coerce.date().optional(),
  dateButoire: z.coerce.date().optional(),
  mailNatureId: optionalId,
  confidentialiteId: optionalId,
  externalEntityId: optionalId,
  mailObjetId: optionalId,
  documentId: optionalId,
  scannedDocumentId: optionalId,
  enCopieUserGroupIds: z.array(z.number().int().positive()).optional(),
});

/** Création d'un courrier Départ (§12). */
export const createDepartSchema = z.object({
  title: z.string().trim().min(1),
  date: z.coerce.date(),
  // Optionnel : l'émetteur d'un Départ est par défaut son rédacteur (acteur courant), l'écran §12
  // ne le demande donc plus. Reste accepté pour un émetteur explicite (reprise, saisie pour autrui).
  destinataireUserGroupId: optionalId,
  mailDepartTypeId: optionalId,
  nReference: z.string().optional(),
  description: z.string().optional(),
  reference: z.string().optional(),
  externalEntityId: optionalId,
  confidentialiteId: optionalId,
  documentId: optionalId,
  scannedDocumentId: optionalId,
  parentMailId: optionalId,
});

/** Validation Direction en lot (§10). */
export const validationDirectionSchema = z.object({
  mailIds: z.array(z.number().int().positive()).min(1),
});

/** Intégration de la décharge signée (§13). */
/**
 * Intégration décharge (§13) : la pièce signée arrive soit d'un document GED existant, soit d'un
 * PDF déposé dans la file §07 (cas courant). L'un des deux est requis — le service tranche.
 */
export const integrateDechargeSchema = z
  .object({
    documentId: z.number().int().positive().optional(),
    scannedDocumentId: z.number().int().positive().optional(),
  })
  .refine((v) => v.documentId != null || v.scannedDocumentId != null, {
    message: 'Fournissez le document de décharge (documentId ou scannedDocumentId)',
  });

/** Rattachement d'un document à un courrier. */
export const linkDocumentSchema = z.object({
  documentId: z.number().int().positive(),
  decharge: z.boolean().optional(),
});

/** Recherche multicritères (§11). */
export const mailSearchSchema = z.object({
  fullText: z.string().optional(),
  mailType: z.number().int().min(0).max(2).optional(),
  status: z.number().int().min(0).max(4).optional(),
  externalEntityId: optionalId,
  mailNatureId: optionalId,
  mailObjetId: optionalId,
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) })).optional(),
});

export type PaginationQueryDto = z.infer<typeof paginationQuerySchema>;
export type CreateArriveeBody = z.infer<typeof createArriveeSchema>;
export type CreateDepartBody = z.infer<typeof createDepartSchema>;
export type ValidationDirectionDto = z.infer<typeof validationDirectionSchema>;
export type IntegrateDechargeDto = z.infer<typeof integrateDechargeSchema>;
export type LinkDocumentDto = z.infer<typeof linkDocumentSchema>;
export type MailSearchDto = z.infer<typeof mailSearchSchema>;
