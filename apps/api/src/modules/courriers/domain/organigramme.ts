/**
 * Dérivation de `Mail.organigrammeId` à la création (§ Étape 0 / source AddMail).
 *
 * La source dérive l'organigramme du courrier depuis le 1er `OrganigrammeId` parmi les rôles du
 * destinataire, en ÉCRASANT toute valeur fournie par le DTO. En V6, un utilisateur porte un rôle
 * unique (`app_user.role_id`) et le rôle porte `role.organigramme_id` — la « 1ère valeur » se
 * réduit donc à l'organigramme du rôle du destinataire.
 *
 * Chaîne de résolution côté service : mail.destinataire (app_user_group) → app_user → role →
 * role.organigramme_id.
 */
export function resolveOrganigrammeId(
  destinataireRoleOrganigrammeId: number | null | undefined,
): number | null {
  return destinataireRoleOrganigrammeId ?? null;
}
