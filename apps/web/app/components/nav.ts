/**
 * Configuration de navigation centrale — partagée par la barre latérale, le
 * drawer mobile et la palette de commandes. Source unique pour rester cohérent.
 */
import type { IconName } from '../theme/icons';

export interface NavItem {
  key: string; // route
  label: string;
  icon: IconName;
  keywords?: string[]; // synonymes pour la recherche dans la palette
  /**
   * Permissions ALTERNATIVES ouvrant la même entrée (§09) : une permission de périmètre restreint
   * n'est pas une route à part, elle donne accès au même écran avec moins de données. L'entrée est
   * donc visible si l'utilisateur détient `key` OU l'une de ces clés.
   */
  altKeys?: string[];
}

export interface NavSection {
  label: string;
  /**
   * Icône de la section. Indispensable au mode replié de la barre latérale : sans icône, AntD
   * n'a rien à afficher à la place du libellé et laisse le titre déborder du rail de 76 px.
   */
  icon: IconName;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    label: 'Docu-Archives',
    icon: 'archive',
    items: [
      {
        key: '/dashboards',
        label: 'Tableaux de bord',
        icon: 'dashboard',
        keywords: ['statistiques', 'kpi', 'graphiques', 'indicateurs', 'pilotage'],
      },
      {
        key: '/acquisition',
        label: 'Acquisition par lot',
        icon: 'acquisition',
        keywords: ['lot', 'scan', 'P2', 'OCR'],
      },
      {
        key: '/search',
        label: 'Recherche',
        icon: 'search',
        keywords: ['rechercher', 'export', 'P3'],
      },
      {
        key: '/espaces',
        label: 'Espaces',
        icon: 'dossier',
        keywords: ['espace', 'partage', 'collaboration', 'publication', 'membres', 'ged'],
      },
      {
        key: '/recherche-ia',
        label: 'Recherche IA',
        icon: 'sparkle',
        keywords: ['question', 'réponse', 'sémantique', 'ia', 'assistant', 'intelligence artificielle'],
      },
      {
        key: '/archives/integrite',
        label: 'Intégrité du fonds',
        icon: 'lock',
        keywords: ['intégrité', 'empreinte', 'sha-256', 'cachet', 'scellement', 'contrôle', 'coffre'],
      },
      // Cycle de vie documentaire et communication de documents (portage Docu-Archives).
      {
        key: '/archives/dua-expirees',
        label: 'DUA expirés',
        icon: 'alert',
        keywords: ['dua', 'échéance', 'conservation', 'épuration', 'cycle de vie'],
      },
      {
        key: '/archives/documents-epures',
        label: 'Documents épurés',
        icon: 'delete',
        keywords: ['épuré', 'purge', 'supprimé', 'dua'],
      },
      {
        key: '/archives/communiquer',
        label: 'Communiquer un document',
        icon: 'send',
        keywords: ['prêt', 'communication', 'sortie', 'emprunt'],
      },
      {
        key: '/archives/documents-communiques',
        label: 'Documents communiqués',
        icon: 'view',
        keywords: ['prêt', 'en cours', 'retour', 'sortis'],
      },
      {
        key: '/archives/mes-documents-communiques',
        label: 'Mes documents communiqués',
        icon: 'users',
        keywords: ['mes prêts', 'emprunt', 'retour'],
      },
      {
        key: '/archives/historique-communications',
        label: 'Historique des communications',
        icon: 'pending',
        keywords: ['historique', 'prêts rendus', 'retours'],
      },
    ],
  },
  {
    label: 'Docu-Courriers',
    icon: 'mail',
    items: [
      {
        key: '/courriers/tableau-de-bord',
        label: 'Tableau de bord',
        icon: 'analytics',
        keywords: ['statistiques', 'kpi', 'indicateurs', 'pilotage', 'retards', 'courrier'],
      },
      {
        key: '/courriers/enregistrement',
        label: 'Enregistrement',
        icon: 'add',
        keywords: ['courrier', 'arrivée', 'bureau ordre'],
      },
      {
        key: '/courriers/controle',
        label: 'Courriers arrivés',
        icon: 'mail',
        keywords: ['contrôle', 'arrivée'],
      },
      {
        key: '/courriers/documents-scannes',
        label: 'Documents scannés',
        icon: 'scan',
        keywords: ['scan', 'numérisé'],
      },
      {
        key: '/courriers/parapheur',
        label: 'Courriers Imputés',
        icon: 'validated',
        keywords: ['imputation', 'parapheur'],
      },
      {
        key: '/courriers/suivi',
        label: 'Suivi des courriers',
        icon: 'pending',
        keywords: ['suivi', 'échéance', 'relance'],
        altKeys: ['/courriers/suivi-dc'],
      },
      {
        key: '/courriers/validation',
        label: 'Validation',
        icon: 'check',
        keywords: ['validation', 'direction'],
      },
      {
        key: '/courriers/recherche',
        label: 'Recherche courrier',
        icon: 'search',
        keywords: ['recherche', 'courrier'],
      },
      {
        key: '/courriers/depart',
        label: 'Courrier de départ',
        icon: 'send',
        keywords: ['départ', 'sortant', 'réponse'],
      },
      {
        key: '/courriers/integration-decharge',
        label: 'Intégration décharge',
        icon: 'archive',
        keywords: ['décharge', 'signée'],
      },
    ],
  },
  {
    label: 'Paramétrage Archives',
    icon: 'settings',
    items: [
      // « Géolocalisation » et « Catégories de dossier » sont volontairement absents : écrans
      // masqués (cf. HIDDEN_MENU_KEYS dans apps/api/src/modules/roles/menu-catalog.ts). Les
      // routes existent toujours et restent atteignables par URL directe.
      // Ordre voulu : le TYPE d'abord, parce que c'est lui qui commande le reste — il porte le
      // rangement par défaut (dossier + plan), la règle de cycle de vie et les métadonnées à
      // saisir. On paramètre un type, puis on va voir où il range.
      {
        key: '/admin/document-types',
        label: 'Types de document',
        icon: 'documentType',
        keywords: ['type'],
      },
      {
        key: '/admin/classification-plans',
        label: 'Plan de classement',
        icon: 'classification',
        keywords: ['plan', 'cote'],
      },
      { key: '/admin/dossiers', label: 'Dossiers', icon: 'dossier', keywords: ['chemise'] },
      {
        key: '/intercalaires',
        label: 'Intercalaires',
        icon: 'intercalaires',
        keywords: ['QR', 'P1', 'feuilles'],
      },
      // Paramétrage du cycle de vie et des métadonnées (portage Docu-Archives). « Gestion des
      // dossiers » n'y figure pas : c'est l'entrée « Dossiers » ci-dessus.
      {
        key: '/admin/archives/parametrage-types',
        label: 'Paramétrage des types',
        icon: 'settings',
        keywords: ['défaut', 'ocr', 'cryptage', 'scanner', 'routine', 'compression'],
      },
      {
        key: '/admin/archives/cycles-de-vie',
        label: 'Cycles de vie',
        icon: 'refresh',
        keywords: ['dua', 'conservation', 'conformité', 'durée', 'échéance'],
      },
      {
        key: '/admin/archives/modes-destruction',
        label: 'Modes de destruction',
        icon: 'delete',
        keywords: ['destruction', 'broyage', 'effacement'],
      },
      {
        key: '/admin/archives/sorts-finaux',
        label: 'Sorts finaux',
        icon: 'archive',
        keywords: ['sort final', 'conservation définitive', 'versement'],
      },
      {
        key: '/admin/archives/motifs-pret',
        label: 'Motifs de prêt',
        icon: 'send',
        keywords: ['prêt', 'communication', 'consultation', 'litige'],
      },
      {
        key: '/admin/archives/metadonnees',
        label: 'Métadonnées',
        icon: 'document',
        keywords: ['champ', 'indexation', 'métadonnée'],
      },
      {
        key: '/admin/archives/metadonnees-types',
        label: 'Métadonnées par type',
        icon: 'classification',
        keywords: ['association', 'métadonnée', 'type de document'],
      },
      {
        key: '/admin/archives/elements-listes',
        label: 'Éléments des listes',
        icon: 'menu',
        keywords: ['liste', 'valeurs', 'options', 'métadonnée'],
      },
    ],
  },
  {
    label: 'Paramétrage Courrier',
    icon: 'tune',
    items: [
      {
        key: '/admin/courriers/organigrammes',
        label: 'Organigrammes',
        icon: 'organigramme',
        keywords: ['organigramme', 'service', 'direction'],
      },
      {
        key: '/admin/courriers/role-organigramme',
        label: 'Rôles ↔ organigramme',
        icon: 'roles',
        keywords: ['rôle', 'organigramme'],
      },
      {
        key: '/admin/courriers/types-entites-externes',
        label: "Types d'entité externe",
        icon: 'documentType',
        keywords: ['catégorie', 'correspondant'],
      },
      {
        key: '/admin/courriers/entites-externes',
        label: 'Entités externes',
        icon: 'users',
        keywords: ['correspondant', 'expéditeur'],
      },
      {
        key: '/admin/courriers/types-imputation',
        label: "Types d'imputation",
        icon: 'documentType',
      },
      { key: '/admin/courriers/types-depart', label: 'Types de courrier départ', icon: 'send' },
      // « Natures de courrier », « Objets de courrier » et « Confidentialités » sont volontairement
      // absents : écrans masqués (cf. HIDDEN_MENU_KEYS dans
      // apps/api/src/modules/roles/menu-catalog.ts). Les routes existent toujours et restent
      // atteignables par URL directe.
    ],
  },
  {
    label: 'Sécurité Documentaire',
    icon: 'roles',
    items: [
      // « Demandes d'accès document » et « Sécurité par classification » sont volontairement
      // absents : écrans retirés (2026-08-04). Les endpoints API et la table
      // `document_access_inquiry` restent en place, réactivables sans migration.
      {
        key: '/admin/securite/type-par-utilisateur',
        label: 'Sécurité type document par utilisateur',
        icon: 'users',
        keywords: ['droit', 'permission', 'type de document'],
      },
      {
        // Clé inchangée : c'est la route de la page ET la valeur stockée en base
        // (`role_menu_permission.menu_key`). Seul l'écran a changé d'axe (profil → rôle).
        key: '/admin/securite/type-par-profil',
        label: 'Sécurité type document par rôle',
        icon: 'roles',
        // « profil » reste un mot-clé : la route et l'ancien vocabulaire survivent
        // en base, un administrateur cherchera encore l'écran sous ce nom.
        keywords: ['droit', 'permission', 'rôle', 'role', 'profil'],
      },
      {
        key: '/admin/securite/confidentialite-utilisateurs',
        label: 'Confidentialité des utilisateurs',
        icon: 'lock',
        keywords: ['habilitation', 'niveau', 'utilisateur'],
      },
      {
        key: '/admin/securite/confidentialites',
        label: 'Confidentialités',
        icon: 'lock',
        keywords: ['niveau', 'référentiel'],
      },
    ],
  },
  {
    label: 'Administration',
    icon: 'admin',
    items: [
      { key: '/admin/users', label: 'Utilisateurs', icon: 'users', keywords: ['comptes', 'admin'] },
      {
        key: '/admin/roles',
        label: 'Rôles',
        icon: 'roles',
        keywords: ['rôle', 'permissions', 'accès', 'menus'],
      },
      {
        key: '/admin/parametres/email',
        label: 'Paramétrage e-mail',
        icon: 'mail',
        keywords: ['e-mail', 'email', 'notification', 'logo', 'gabarit', 'marque', 'identité'],
      },
    ],
  },
];

/** Tous les items à plat (palette de commandes, résolution de titre/fil d'Ariane). */
export const NAV_FLAT: NavItem[] = NAV.flatMap((s) => s.items);

/** Item actif pour un chemin donné (exact pour la racine, sinon préfixe). */
export function isActive(pathname: string, key: string): boolean {
  return key === '/' ? pathname === '/' : pathname.startsWith(key);
}

/** Item de navigation correspondant le mieux au chemin courant. */
/**
 * Titre de barre superieure des ecrans qui n'ont PAS d'entree de menu (« Mon profil », ouvert
 * depuis le menu utilisateur). Sans cette table `activeItem` ne trouve rien et la barre
 * retombe sur « Docu-Archives », ce qui donne un titre faux.
 */
export const OFF_MENU_TITLES: Record<string, string> = {
  '/profil': 'Mon profil',
};

export function activeItem(pathname: string): NavItem | undefined {
  // Le plus spécifique d'abord (clé la plus longue) pour éviter que '/' gagne.
  return [...NAV_FLAT]
    .sort((a, b) => b.key.length - a.key.length)
    .find((i) => isActive(pathname, i.key));
}
