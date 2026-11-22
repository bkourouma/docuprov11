// Accès au panneau : réservé aux détenteurs du menu « /assistant » (refus par défaut).
import { ASST_ROUTE_MENU } from '@archivage/types';

/** Vrai seulement si /auth/me renvoie explicitement le menu : une liste absente (backend ancien) = pas d'accès. */
export function hasAssistantMenu(menuKeys: readonly string[] | null | undefined): boolean {
  return Array.isArray(menuKeys) && menuKeys.includes(ASST_ROUTE_MENU);
}
