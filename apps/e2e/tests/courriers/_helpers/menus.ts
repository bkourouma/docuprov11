/**
 * Clés de menu Docu-Courriers (routes des écrans) et types d'imputation système.
 *
 * Sources lues :
 *  - `apps/api/src/modules/roles/menu-catalog.ts` (MENU_CATALOG, MENU_SUIVI_DC = '/courriers/suivi-dc') ;
 *  - `apps/web/app/components/nav.ts` (routes affichées dans la barre latérale) ;
 *  - `packages/types/src/courriers.ts` (MailInputationTypeId) et `packages/db/prisma/seed.ts`.
 *
 * Hypothèses à vérifier en phase B :
 *  - `MENU_SUIVI_DC` n'est PAS une route : c'est une permission de périmètre (même écran que le
 *    Suivi, données réduites aux courriers où l'utilisateur porte une imputation). Elle se donne
 *    à un rôle comme les autres clés ; on ne l'ouvre jamais par `page.goto`.
 *  - Les menus masqués (`/admin/courriers/natures|objets|confidentialites`) ne sont pas
 *    assignables à un rôle (`sanitizeMenuKeys` les retire) : ils ne figurent donc pas ici.
 *  - Les identifiants 5/10/14/17 sont figés par le seed de base (upsert par id).
 */
export const MENUS = {
  tableauDeBord: '/courriers/tableau-de-bord',
  enregistrement: '/courriers/enregistrement',
  controle: '/courriers/controle',
  documentsScannes: '/courriers/documents-scannes',
  parapheur: '/courriers/parapheur',
  suivi: '/courriers/suivi',
  /** MENU_SUIVI_DC réel (menu-catalog.ts) — permission de périmètre, pas une route. */
  suiviDC: '/courriers/suivi-dc' as string,
  validation: '/courriers/validation',
  recherche: '/courriers/recherche',
  depart: '/courriers/depart',
  integrationDecharge: '/courriers/integration-decharge',
  adminOrganigrammes: '/admin/courriers/organigrammes',
  adminRoleOrganigramme: '/admin/courriers/role-organigramme',
  adminEntitesExternes: '/admin/courriers/entites-externes',
  adminTypesImputation: '/admin/courriers/types-imputation',
  adminTypesDepart: '/admin/courriers/types-depart',
  adminTypesEntitesExternes: '/admin/courriers/types-entites-externes',
} as const;

/** Toutes les clés courrier assignables à un rôle (opérationnel + paramétrage). */
export const ALL_COURRIER_MENUS: string[] = Object.values(MENUS);

/** Types d'imputation « système » aux identifiants figés (§03.6, seed de base). */
export const INPUTATION_TYPE = {
  validationDG: 5,
  pourSuivi: 10,
  validationDirection: 14,
  enCopie: 17,
} as const;
