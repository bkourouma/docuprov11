/**
 * Permissions « Docu-Flow » (workflows). Accès refusé par défaut : aucune de ces clés n'est accordée sans
 * décision explicite. Déclarées AUSSI dans `roles/menu-catalog.ts` (permissions assignables à un rôle).
 *
 *  - CONCEVOIR : créer / modifier des brouillons, valider et publier une version, archiver ;
 *  - LANCER : démarrer une instance (jamais avec plus de droits que les siens) ;
 *  - ADMINISTRER : voir toutes les instances, annuler / suspendre / reprendre n'importe laquelle.
 *    N'ouvre AUCUN pouvoir d'action sur les tâches d'autrui (cf. `WorkflowInboxService`).
 *
 * Le marquage « faible risque » reste réservé aux administrateurs (`@RequireAdmin`), pas à un menu.
 * La boîte de tâches n'exige pas de menu : elle ne renvoie que ce qui est assigné à l'utilisateur.
 */
export const WORKFLOWS_MENUS = {
  design: '/workflows/conception',
  launch: '/workflows/lancer',
  admin: '/workflows/administration',
} as const;

export type WorkflowsMenuKey = (typeof WORKFLOWS_MENUS)[keyof typeof WORKFLOWS_MENUS];
