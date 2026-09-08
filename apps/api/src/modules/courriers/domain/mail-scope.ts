import { MENU_SUIVI, MENU_SUIVI_DC } from '../../roles/menu-catalog';

/**
 * Périmètre de visibilité du Suivi (§09) et de la Validation (§10) :
 *  - `all`     : tous les courriers (« Suivi permanent courrier ») ;
 *  - `imputed` : uniquement ceux où l'utilisateur porte une imputation (« Suivi des Courriers DC ») ;
 *  - `none`    : aucune des deux permissions ⟹ liste vide.
 */
export type MailScope = 'all' | 'imputed' | 'none';

/**
 * Les deux permissions sont ALTERNATIVES : « Suivi permanent » l'emporte quand les deux sont
 * accordées (c'est le périmètre le plus large, le restreindre serait un retrait de droit).
 * L'admin et le rôle système ont toutes les clés, donc `all` naturellement.
 */
export function mailScopeFromMenuKeys(menuKeys: readonly string[]): MailScope {
  if (menuKeys.includes(MENU_SUIVI)) return 'all';
  if (menuKeys.includes(MENU_SUIVI_DC)) return 'imputed';
  return 'none';
}
