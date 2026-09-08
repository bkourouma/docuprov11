import { z } from 'zod';

/** Création d'une imputation (§08). */
export const createInputationSchema = z.object({
  mailId: z.number().int().positive(),
  userGroupId: z.number().int().positive(),
  mailInputationTypeId: z.number().int().positive(),
  instructions: z.string().optional(),
  deadline: z.coerce.date().optional(),
});

/** Soumission d'un courrier à validation (§08) : DG (type 5) ou Direction (type 14). */
export const submitValidationSchema = z.object({
  mailId: z.number().int().positive(),
  userGroupId: z.number().int().positive(),
  isDG: z.boolean().optional(),
});

/** Traitement d'une imputation d'un destinataire (validation en masse §10). */
export const treatRecipientSchema = z.object({
  userGroupId: z.number().int().positive(),
});

export type CreateInputationBody = z.infer<typeof createInputationSchema>;
export type SubmitValidationBody = z.infer<typeof submitValidationSchema>;
export type TreatRecipientBody = z.infer<typeof treatRecipientSchema>;
