/**
 * Clés de menu du portage Docu-Archives, nommées une fois pour toutes.
 *
 * Elles sont AUSSI déclarées dans `roles/menu-catalog.ts` (permissions assignables) et dans
 * `apps/web/app/components/nav.ts` (barre latérale) : ce fichier évite d'en répéter les
 * littéraux dans chaque `@RequireMenu`, où une faute de frappe passerait silencieusement (le
 * garde refuserait simplement tout le monde sauf l'admin).
 */
export const ARCHIVES_MENUS = {
  // --- Paramétrage Archives ---
  documentTypeSettings: '/admin/archives/parametrage-types',
  lifeCycles: '/admin/archives/cycles-de-vie',
  destructionModes: '/admin/archives/modes-destruction',
  finalFates: '/admin/archives/sorts-finaux',
  lendingMotives: '/admin/archives/motifs-pret',
  metaDataDocumentTypes: '/admin/archives/metadonnees-types',
  metaDatas: '/admin/archives/metadonnees',
  metaDataListItems: '/admin/archives/elements-listes',

  // --- Docu-Archives (opérationnel) ---
  duaExpired: '/archives/dua-expirees',
  purged: '/archives/documents-epures',
  communicate: '/archives/communiquer',
  lentDocuments: '/archives/documents-communiques',
  myLentDocuments: '/archives/mes-documents-communiques',
  lendingHistory: '/archives/historique-communications',
  integrity: '/archives/integrite',
} as const;

export type ArchivesMenuKey = (typeof ARCHIVES_MENUS)[keyof typeof ARCHIVES_MENUS];
