import { z } from 'zod';

/**
 * Clé réservée `rights` de `ged_source_connector.config` : correspondance des principaux de la source
 * avec des groupes DocuPro, et groupes de repli. Le reste de `config` est propre au connecteur.
 */
export const rightsConfigSchema = z
  .object({
    principalMap: z.record(z.string().min(1).max(300), z.number().int().positive()).default({}),
    fallbackUserGroupIds: z.array(z.number().int().positive()).max(50).default([]),
  })
  .strict();
export type RightsConfig = z.infer<typeof rightsConfigSchema>;
