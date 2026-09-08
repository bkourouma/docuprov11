import { z } from 'zod';

const positiveId = z.number().int().positive();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ');

/** Soumission d'une demande d'accès sur un document — bouton « Demander l'accès » de la fiche document. */
export const createAccessInquirySchema = z.object({
  documentId: positiveId,
  permissionLevelId: positiveId,
  motive: z.string().trim().min(1, 'Justifiez votre demande.'),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});

/** Traitement d'une demande : accepter crée/actualise le droit demandé, refuser se contente du statut. */
export const decideAccessInquirySchema = z.object({
  accept: z.boolean(),
});

export type CreateAccessInquiryDto = z.infer<typeof createAccessInquirySchema>;
export type DecideAccessInquiryDto = z.infer<typeof decideAccessInquirySchema>;
