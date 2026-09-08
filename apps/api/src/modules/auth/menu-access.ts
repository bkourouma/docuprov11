import { MENU_KEYS } from '../roles/menu-catalog';

/** Rôle (avec ses menus) tel que requis pour calculer les menus effectifs. */
export interface RoleMenusLike {
  isActive: boolean;
  isSystem: boolean;
  menus: { menuKey: string }[];
}

/**
 * Menus effectifs d'un utilisateur — règle UNIQUE, partagée par `/auth/me` et le
 * `MenuPermissionGuard` (évite toute dérive entre l'affichage du menu et l'accès aux données) :
 *  - l'admin et le rôle système actif voient TOUT ;
 *  - sinon l'accueil « / » + les menus du rôle actif.
 *
 * Renvoie une liste dédoublonnée.
 */
export function effectiveMenuKeys(
  isAdmin: boolean,
  role: RoleMenusLike | null | undefined,
): string[] {
  const fullAccess = isAdmin || !!(role && role.isActive && role.isSystem);
  const granted = fullAccess
    ? MENU_KEYS
    : ['/', ...(role && role.isActive ? role.menus.map((m) => m.menuKey) : [])];
  return [...new Set(granted)];
}
