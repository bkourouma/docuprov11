import { MENU_SUIVI, MENU_SUIVI_DC } from '../roles/menu-catalog';

/**
 * Menus des écrans qui OUVRENT un courrier en affichant les actions de workflow (§03.2 : marquer
 * traité, validation DG, décharger, enregistrer la réponse).
 *
 * Ces écrans partagent un seul composant côté front (`useMailWorkflow`, via `MailDetailPage` et
 * `MailViewer`) : les boutons y sont proposés selon l'ÉTAT du courrier, jamais selon le menu par
 * lequel on est arrivé. L'autorisation doit donc être partagée elle aussi — la réserver au seul
 * Parapheur affichait le bouton puis le refusait en 403 (« Vous n'avez pas accès à cette section »)
 * depuis Suivi et Validation.
 *
 * `MENU_SUIVI_DC` accompagne toujours `MENU_SUIVI` : c'est le même écran, à périmètre réduit.
 */
export const MAIL_WORKFLOW_MENUS = [
  '/courriers/parapheur',
  MENU_SUIVI,
  MENU_SUIVI_DC,
  '/courriers/validation',
] as const;
