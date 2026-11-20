/**
 * Catalogue des permissions de menu — miroir backend de la barre latérale
 * (`apps/web/app/components/nav.ts`). Une permission = un menu de la sidebar.
 *
 * Le tableau de bord (`/`) est volontairement TOUJOURS visible : il n'est donc
 * pas assignable (cf. ASSIGNABLE_MENU_KEYS) et est ajouté d'office aux menus
 * effectifs d'un utilisateur.
 */
import { ARCHIVES_MENUS } from '../archives/archives.menus';
import { SECURITY_MENUS } from '../access-inquiries/security.menus';
import { SEMANTIC_SEARCH_MENU } from '../semantic-search/semantic-search.menus';
import { SPACES_MENU } from '../spaces/spaces.menus';

export interface MenuPermission {
  key: string; // clé de route (ex. /admin/users)
  label: string;
  section: string;
}

/**
 * Suivi des courriers — deux permissions ALTERNATIVES (et non cumulatives) qui ouvrent les mêmes
 * écrans (Suivi §09, Validation §10) mais avec un périmètre de visibilité différent :
 *  - `MENU_SUIVI` (« Suivi permanent ») : tous les courriers ;
 *  - `MENU_SUIVI_DC` : uniquement ceux où l'utilisateur porte lui-même une imputation.
 *
 * `MENU_SUIVI_DC` n'est PAS une route : c'est une permission de périmètre, assignable en
 * paramétrage mais absente de la barre latérale (elle y réutilise l'entrée « Suivi des courriers »).
 * D'où une clé volontairement distincte de tout chemin de page réel.
 */
export const MENU_SUIVI = '/courriers/suivi';
export const MENU_SUIVI_DC = '/courriers/suivi-dc';

/**
 * Tableau de bord Docu-Courriers. Permission **assignable normale**, contrairement à
 * `/dashboards` (Docu-Archives) qui est forcé visible pour tous : le tableau de bord courrier
 * expose des volumes et des délais, et son contenu s'adapte au périmètre `MailScope`.
 */
export const MENU_DASHBOARD_COURRIERS = '/courriers/tableau-de-bord';

/**
 * Tableau de bord Docu-Archives. Comme son homologue courrier, il est personnalisable par
 * utilisateur : la clé sert donc aussi de permission aux endpoints d'agencement
 * (`/analytics/layout`), d'où une constante nommée plutôt qu'un littéral répété.
 */
export const MENU_DASHBOARD_ARCHIVES = '/dashboards';

export const MENU_CATALOG: MenuPermission[] = [
  { key: '/', label: 'Tableau de bord', section: 'Docu-Archives' },
  { key: MENU_DASHBOARD_ARCHIVES, label: 'Tableaux de bord', section: 'Docu-Archives' },
  { key: '/acquisition', label: 'Acquisition par lot', section: 'Docu-Archives' },
  { key: '/search', label: 'Recherche', section: 'Docu-Archives' },
  { key: SPACES_MENU, label: 'Espaces', section: 'Docu-Archives' },
  { key: SEMANTIC_SEARCH_MENU, label: 'Recherche IA', section: 'Docu-Archives' },
  { key: '/admin/geolocalisation', label: 'Géolocalisation', section: 'Paramétrage Archives' },
  { key: '/admin/classification-plans', label: 'Plan de classement', section: 'Paramétrage Archives' },
  // '/admin/dossier-categories' a été RETIRÉ du catalogue, pas seulement masqué : la table
  // `dossier_category` et l'écran n'existent plus (migration 20260731160000). Laisser la clé
  // aurait proposé une permission vers une page absente.
  { key: '/admin/dossiers', label: 'Dossiers', section: 'Paramétrage Archives' },
  { key: '/admin/document-types', label: 'Types de document', section: 'Paramétrage Archives' },
  { key: '/intercalaires', label: 'Intercalaires', section: 'Paramétrage Archives' },

  // --- Docu-Archives : cycle de vie, métadonnées et prêts ---
  // docs/DOCUMENTATION_MENUS_DOCU_ARCHIVES.md. Les clés sont nommées dans
  // `modules/archives/archives.menus.ts` (ARCHIVES_MENUS), source des `@RequireMenu`.
  // « Gestion des dossiers » du document source n'a pas de clé propre : c'est
  // `/admin/dossiers`, qui existe déjà.
  {
    key: ARCHIVES_MENUS.documentTypeSettings,
    label: 'Paramétrage des types de documents',
    section: 'Paramétrage Archives',
  },
  {
    key: ARCHIVES_MENUS.lifeCycles,
    label: 'Cycles de vie des documents',
    section: 'Paramétrage Archives',
  },
  {
    key: ARCHIVES_MENUS.destructionModes,
    label: 'Modes de destruction',
    section: 'Paramétrage Archives',
  },
  { key: ARCHIVES_MENUS.finalFates, label: 'Sorts finaux', section: 'Paramétrage Archives' },
  { key: ARCHIVES_MENUS.lendingMotives, label: 'Motifs de prêt', section: 'Paramétrage Archives' },
  { key: ARCHIVES_MENUS.metaDatas, label: 'Métadonnées', section: 'Paramétrage Archives' },
  {
    key: ARCHIVES_MENUS.metaDataDocumentTypes,
    label: 'Métadonnées par type de document',
    section: 'Paramétrage Archives',
  },
  {
    key: ARCHIVES_MENUS.metaDataListItems,
    label: 'Éléments des listes',
    section: 'Paramétrage Archives',
  },

  { key: ARCHIVES_MENUS.integrity, label: 'Intégrité du fonds', section: 'Docu-Archives' },
  { key: ARCHIVES_MENUS.duaExpired, label: 'DUA expirés', section: 'Docu-Archives' },
  { key: ARCHIVES_MENUS.purged, label: 'Documents épurés', section: 'Docu-Archives' },
  { key: ARCHIVES_MENUS.communicate, label: 'Communiquer un document', section: 'Docu-Archives' },
  {
    key: ARCHIVES_MENUS.lentDocuments,
    label: 'Documents communiqués (tous)',
    section: 'Docu-Archives',
  },
  {
    key: ARCHIVES_MENUS.myLentDocuments,
    label: 'Mes documents communiqués',
    section: 'Docu-Archives',
  },
  {
    key: ARCHIVES_MENUS.lendingHistory,
    label: 'Historique des documents communiqués',
    section: 'Docu-Archives',
  },
  // --- Sécurité Documentaire (réactivation du menu legacy DocumentSecurity) ---
  // Clés nommées dans `modules/access-inquiries/security.menus.ts` (SECURITY_MENUS).
  //
  // « Demandes d'accès document » et « Sécurité par classification » sont volontairement absentes
  // du catalogue (2026-08-04, écrans retirés — pas seulement masqués comme HIDDEN_MENU_KEYS plus
  // bas : leurs pages n'existent plus, contrairement à ce patron). Leurs endpoints API
  // (`AccessInquiriesController`, `GET .../plans-with-document-types`) et, pour le premier, la
  // table `document_access_inquiry`, restent en place et réactivables sans migration.
  {
    key: SECURITY_MENUS.typeSecurityByUser,
    label: 'Sécurité type document par utilisateur',
    section: 'Sécurité Documentaire',
  },
  {
    key: SECURITY_MENUS.typeSecurityByRole,
    label: 'Sécurité type document par rôle',
    section: 'Sécurité Documentaire',
  },
  {
    key: SECURITY_MENUS.userConfidentiality,
    label: 'Confidentialité des utilisateurs',
    section: 'Sécurité Documentaire',
  },
  {
    key: SECURITY_MENUS.confidentialites,
    label: 'Confidentialités',
    section: 'Sécurité Documentaire',
  },

  { key: '/admin/users', label: 'Utilisateurs', section: 'Administration' },
  { key: '/admin/roles', label: 'Rôles', section: 'Administration' },
  {
    key: '/admin/parametres/email',
    label: 'Paramétrage e-mail',
    section: 'Administration',
  },
  // Connecteurs de sources GED : administration pure (contrôleur `@RequireAdmin`). La clé est
  // listée dans HIDDEN_MENU_KEYS plus bas pour n'être PAS assignable à un rôle (une permission
  // accordée serait refusée par l'API) ; l'administrateur et le rôle système la voient via MENU_KEYS.
  { key: '/connecteurs', label: 'Connecteurs', section: 'Administration' },

  // --- Docu-Courriers (opérationnel) --- §04.3
  {
    key: MENU_DASHBOARD_COURRIERS,
    label: 'Tableau de bord courrier',
    section: 'Docu-Courriers',
  },
  { key: '/courriers/enregistrement', label: 'Enregistrement', section: 'Docu-Courriers' },
  { key: '/courriers/controle', label: 'Courriers arrivés', section: 'Docu-Courriers' },
  { key: '/courriers/documents-scannes', label: 'Documents scannés', section: 'Docu-Courriers' },
  { key: '/courriers/parapheur', label: 'Courriers Imputés', section: 'Docu-Courriers' },
  // Paire de permissions alternatives (cf. MENU_SUIVI / MENU_SUIVI_DC) : les libellés disent le
  // périmètre, faute de quoi rien à l'écran de paramétrage ne distingue les deux cases.
  {
    key: MENU_SUIVI,
    label: 'Suivi permanent courrier (tous les courriers)',
    section: 'Docu-Courriers',
  },
  {
    key: MENU_SUIVI_DC,
    label: 'Suivi des courriers DC (mes imputations uniquement)',
    section: 'Docu-Courriers',
  },
  { key: '/courriers/validation', label: 'Validation', section: 'Docu-Courriers' },
  { key: '/courriers/recherche', label: 'Recherche courrier', section: 'Docu-Courriers' },
  { key: '/courriers/depart', label: 'Courrier de départ', section: 'Docu-Courriers' },
  {
    key: '/courriers/integration-decharge',
    label: 'Intégration décharge',
    section: 'Docu-Courriers',
  },

  // --- Docu-Courriers (paramétrage / MailSettings) --- §04.5
  {
    key: '/admin/courriers/organigrammes',
    label: 'Organigrammes',
    section: 'Paramétrage Courrier',
  },
  {
    key: '/admin/courriers/role-organigramme',
    label: 'Rôles ↔ organigramme',
    section: 'Paramétrage Courrier',
  },
  {
    key: '/admin/courriers/types-entites-externes',
    label: "Types d'entité externe",
    section: 'Paramétrage Courrier',
  },
  {
    key: '/admin/courriers/entites-externes',
    label: 'Entités externes',
    section: 'Paramétrage Courrier',
  },
  {
    key: '/admin/courriers/types-imputation',
    label: "Types d'imputation",
    section: 'Paramétrage Courrier',
  },
  {
    key: '/admin/courriers/types-depart',
    label: 'Types de courrier départ',
    section: 'Paramétrage Courrier',
  },
  {
    key: '/admin/courriers/natures',
    label: 'Natures de courrier',
    section: 'Paramétrage Courrier',
  },
  { key: '/admin/courriers/objets', label: 'Objets de courrier', section: 'Paramétrage Courrier' },
  {
    key: '/admin/courriers/confidentialites',
    label: 'Confidentialités',
    section: 'Paramétrage Courrier',
  },
];

/**
 * Écrans MASQUÉS : retirés de la barre latérale (`nav.ts`) et de l'éditeur de rôle, mais toujours
 * présents dans MENU_CATALOG. Conséquence voulue : les routes et les endpoints `@RequireMenu`
 * continuent de fonctionner (l'admin et le rôle système gardent l'accès via MENU_KEYS), seule
 * l'exposition dans l'UI disparaît. Vider ce tableau suffit à ré-afficher les écrans.
 */
export const HIDDEN_MENU_KEYS: string[] = [
  '/admin/courriers/natures',
  '/admin/courriers/objets',
  '/admin/courriers/confidentialites',
  // Géolocalisation : masquée à la demande. Le référentiel `location` reste pleinement utilisé —
  // il porte la localisation du DOCUMENT, alimente le filtre de recherche, la colonne d'export,
  // les tableaux de bord, les intercalaires QR et le défaut du paramétrage des types. Seule son
  // ADMINISTRATION disparaît de l'interface ; les lectures (GET) n'ont jamais exigé ce menu.
  '/admin/geolocalisation',
  // Administration seule (cf. entrée `/connecteurs` du catalogue) : non assignable à un rôle.
  '/connecteurs',
];

/** Toutes les clés connues (y compris l'accueil et les écrans masqués). */
export const MENU_KEYS: string[] = MENU_CATALOG.map((m) => m.key);

/** Clés assignables à un rôle (l'accueil reste toujours visible ; hors écrans masqués). */
export const ASSIGNABLE_MENU_KEYS: string[] = MENU_KEYS.filter(
  (k) => k !== '/' && !HIDDEN_MENU_KEYS.includes(k),
);

/** Menus proposés dans l'éditeur de rôle (sans l'accueil, toujours accordé). */
export const ASSIGNABLE_MENU_CATALOG: MenuPermission[] = MENU_CATALOG.filter((m) =>
  ASSIGNABLE_MENU_KEYS.includes(m.key),
);

/** Dédoublonne et ne conserve que des clés réellement assignables. */
export function sanitizeMenuKeys(keys: string[]): string[] {
  return [...new Set(keys.filter((k) => ASSIGNABLE_MENU_KEYS.includes(k)))];
}
