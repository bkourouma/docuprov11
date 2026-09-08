import { SetMetadata } from '@nestjs/common';

/** Clé de métadonnée : menu requis pour accéder au handler. */
export const REQUIRE_MENU_KEY = 'require_menu';
/** Clé de métadonnée : handler réservé aux administrateurs. */
export const REQUIRE_ADMIN_KEY = 'require_admin';

/**
 * Exige que l'utilisateur ait accès à l'un des menus donnés (ou soit admin) — cf.
 * `MenuPermissionGuard`. Plusieurs clés quand un même endpoint sert des écrans distincts : le dépôt
 * d'un binaire §07 se fait aussi bien depuis « Documents scannés » que depuis « Enregistrement ».
 * Sans ce décorateur (ni `@RequireAdmin`), un handler est accessible à tout utilisateur
 * authentifié — utilisé pour les référentiels en LECTURE, partagés par l'acquisition et la
 * recherche.
 */
export const RequireMenu = (...menuKeys: string[]) => SetMetadata(REQUIRE_MENU_KEY, menuKeys);

/** Réserve le handler (ou le contrôleur) aux administrateurs. */
export const RequireAdmin = () => SetMetadata(REQUIRE_ADMIN_KEY, true);
