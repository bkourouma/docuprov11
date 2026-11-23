import { z } from 'zod';

/**
 * Plus grand identifiant de groupe représentable : `app_user_group.user_group_id` est un `int4`.
 * Sans cette borne, un identifiant plus grand passait la validation puis faisait échouer la
 * requête Prisma de vérification des groupes (erreur 500 au lieu d'un refus 400 lisible).
 */
export const USER_GROUP_ID_MAX = 2147483647;

const userGroupId = z.number().int().positive().max(USER_GROUP_ID_MAX);

/**
 * Clé réservée `rights` de `ged_source_connector.config` : correspondance des principaux de la source
 * avec des groupes DocuPro, et groupes de repli. Le reste de `config` est propre au connecteur.
 */
export const rightsConfigSchema = z
  .object({
    principalMap: z.record(z.string().min(1).max(300), userGroupId).default({}),
    fallbackUserGroupIds: z.array(userGroupId).max(50).default([]),
  })
  .strict();
export type RightsConfig = z.infer<typeof rightsConfigSchema>;
