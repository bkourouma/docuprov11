import { z } from 'zod';
import { isoDaySchema, periodInOrder } from '../referentials/referentials.dto';

const positiveId = z.number().int().positive();

/**
 * Soumission d'une demande d'accès sur un document — bouton « Demander l'accès » de la fiche document.
 *
 * Les dates passent par `isoDaySchema` (format ET jour réel) : la seule expression régulière
 * laissait passer « 2026-13-01 », date invalide que Prisma refusait ensuite en 500, et
 * « 2026-02-31 », enregistré silencieusement au 3 mars.
 */
export const createAccessInquirySchema = z
  .object({
    documentId: positiveId,
    permissionLevelId: positiveId,
    motive: z.string().trim().min(1, 'Justifiez votre demande.'),
    startDate: isoDaySchema.optional(),
    endDate: isoDaySchema.optional(),
  })
  .refine(periodInOrder, { message: 'La date de fin précède la date de début', path: ['endDate'] });

/** Traitement d'une demande : accepter crée/actualise le droit demandé, refuser se contente du statut. */
export const decideAccessInquirySchema = z.object({
  accept: z.boolean(),
});

export type CreateAccessInquiryDto = z.infer<typeof createAccessInquirySchema>;
export type DecideAccessInquiryDto = z.infer<typeof decideAccessInquirySchema>;
