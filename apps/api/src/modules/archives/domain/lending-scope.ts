// Périmètre des gestes sur un prêt IDENTIFIÉ (lecture, commentaire, retour) — règle pure, sans
// dépendance NestJS/Prisma.
//
// Les listes ont chacune leur menu et leur périmètre (« Documents communiqués » : tous les prêts ;
// « Mes documents communiqués » : ceux dont l'utilisateur est le bénéficiaire). Les gestes sur un
// prêt, eux, sont ouverts à PLUSIEURS menus (`@RequireMenu(a, b, …)`) : le garde dit seulement que
// l'appelant porte l'un d'eux, pas lequel. Sans cette règle, le seul menu « Mes documents
// communiqués » ouvrait la lecture, le commentaire et le retour du prêt de n'importe qui en
// devinant son identifiant (ANO-ARC-T3-05).
import { ARCHIVES_MENUS } from '../archives.menus';

/** Geste sur un prêt identifié. */
export type LendingAction = 'read' | 'comment' | 'return';

/**
 * `all` : tout prêt ; `own` : seulement les prêts dont l'appelant est le bénéficiaire (même filtre
 * que `listMine`) ; `none` : aucun (le garde aurait dû refuser — défense en profondeur).
 */
export type LendingAccess = 'all' | 'own' | 'none';

/**
 * Menus d'archiviste qui ouvrent un geste sur TOUT prêt, geste par geste.
 *
 * Ce sont exactement les menus de la route concernée autres que « Mes documents communiqués » :
 * cumuler ce menu avec un autre ne donne jamais plus que ce que l'autre donne seul. Ainsi
 * « Historique » (consultation seule) ouvre la lecture de tout prêt, mais ni son retour ni son
 * commentaire ; « Communiquer » n'ouvre aucune de ces routes et n'élargit donc rien.
 */
export const LENDING_FULL_SCOPE_MENUS: Record<LendingAction, readonly string[]> = {
  read: [ARCHIVES_MENUS.lentDocuments, ARCHIVES_MENUS.lendingHistory],
  comment: [ARCHIVES_MENUS.lentDocuments],
  return: [ARCHIVES_MENUS.lentDocuments],
};

/**
 * Périmètre d'un geste selon les menus EFFECTIFS de l'appelant (`effectiveMenuKeys` : l'admin et
 * le rôle système actif ont tous les menus, donc `all`).
 */
export function lendingAccess(menuKeys: readonly string[], action: LendingAction): LendingAccess {
  if (LENDING_FULL_SCOPE_MENUS[action].some((key) => menuKeys.includes(key))) return 'all';
  if (menuKeys.includes(ARCHIVES_MENUS.myLentDocuments)) return 'own';
  return 'none';
}
