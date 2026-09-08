/**
 * Clés de menu du menu « Sécurité Documentaire » (réactivation du legacy `DocumentSecurity`),
 * nommées une fois pour toutes.
 *
 * Elles sont AUSSI déclarées dans `roles/menu-catalog.ts` (permissions assignables) et dans
 * `apps/web/app/components/nav.ts` (barre latérale) — même patron que `archives/archives.menus.ts`.
 * Consommées par plusieurs contrôleurs : ce module (`access-inquiries.controller.ts`) et
 * `referentials.controller.ts` (droits par type + confidentialités, déjà hébergés là-bas).
 */
export const SECURITY_MENUS = {
  accessInquiries: '/admin/securite/demandes-acces',
  typeSecurityByUser: '/admin/securite/type-par-utilisateur',
  // Écran « Sécurité type document par rôle » (ex-« par profil », 2026-08-06). La CLÉ, elle, reste
  // `type-par-profil` : c'est la route de la page et la valeur stockée en base
  // (`role_menu_permission.menu_key`) — la renommer invaliderait les permissions déjà accordées.
  typeSecurityByRole: '/admin/securite/type-par-profil',
  securityByClassification: '/admin/securite/par-classification',
  userConfidentiality: '/admin/securite/confidentialite-utilisateurs',
  confidentialites: '/admin/securite/confidentialites',
} as const;

export type SecurityMenuKey = (typeof SECURITY_MENUS)[keyof typeof SECURITY_MENUS];
