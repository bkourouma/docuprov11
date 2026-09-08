import { z } from 'zod';

export const generateIntercalairesSchema = z.object({
  category: z.enum(['TYPE_DOCUMENT', 'PLAN', 'LOCALISATION', 'DOSSIER', 'BLANK']),
  itemIds: z.array(z.number().int().positive()).default([]),
});

export type GenerateIntercalairesDto = z.infer<typeof generateIntercalairesSchema>;
