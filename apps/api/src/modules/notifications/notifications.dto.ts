import { z } from 'zod';

/**
 * Query de l'inbox : filtre non-lues + pagination. `unreadOnly` reste une chaîne 'true'/'false'
 * (pas de transform, pour garder input=output attendu par ZodValidationPipe) ; la conversion en
 * booléen se fait dans le contrôleur.
 */
export const notificationListQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type NotificationListQueryDto = z.infer<typeof notificationListQuerySchema>;
