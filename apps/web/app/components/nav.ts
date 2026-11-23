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
      // Lot 5 : gouvernance (doublons, données personnelles, sensibilité).
      {
        key: '/gouvernance',
        label: 'Gouvernance',
        icon: 'roles',
        keywords: ['doublon', 'données personnelles', 'rgpd', 'sensibilité', 'confidentialité', 'nettoyage', 'ia'],
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
  // Docu-Flow (lot W4). Les clés de menu SONT les routes ET les permissions du catalogue des rôles
  // (apps/api/src/modules/roles/menu-catalog.ts, section « Docu-Flow »). La boîte de tâches et le suivi n'ont
  // pas de menu propre : ils s'ouvrent dès que l'utilisateur détient l'un des menus Docu-Flow (altKeys).
  {
    label: 'Docu-Flow',
    icon: 'organigramme',
    items: [
      {
        key: '/workflows/boite',
        label: 'Boîte de tâches',
        icon: 'validated',
        keywords: ['workflow', 'tâche', 'validation', 'à faire', 'agent', 'docu-flow'],
        altKeys: ['/workflows/lancer', '/workflows/conception', '/workflows/administration'],
      },
      {
        key: '/workflows/instances',
        label: 'Suivi des workflows',
        icon: 'pending',
        keywords: ['workflow', 'instance', 'suivi', 'journal', 'docu-flow'],
        altKeys: ['/workflows/lancer', '/workflows/administration'],
      },
      {
        key: '/workflows/lancer',
        label: 'Lancer un workflow',
        icon: 'send',
        keywords: ['workflow', 'démarrer', 'lancement', 'docu-flow'],
      },
      {
        key: '/workflows/conception',
        label: 'Conception des workflows',
        icon: 'tune',
        keywords: ['workflow', 'éditeur', 'graphe', 'définition', 'publier', 'docu-flow'],
      },
      {
        key: '/workflows/administration',
        label: 'Administration des workflows',
        icon: 'admin',
        keywords: ['workflow', 'toutes les instances', 'annuler', 'suspendre', 'docu-flow'],
      },
      // Sans menu propre dans le catalogue des rôles : visible exactement quand l'utilisateur détient le menu
      // « administration » (le filtre accepte altKeys), qui est celui qu'exigent les routes de budget de l'API.
      {
        key: '/workflows/administration/plafonds',
        label: 'Plafonds et arrêt d’urgence',
        icon: 'alert',
        keywords: ['workflow', 'agent', 'plafond', 'budget', 'coût', 'arrêt d’urgence', 'stop', 'docu-flow'],
        altKeys: ['/workflows/administration'],
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
      {
        key: '/connecteurs',
        label: 'Connecteurs',
        icon: 'download',
        keywords: ['source', 'import', 'synchronisation', 'messagerie', 'dossier partagé', 'ged'],
      },
    ],
  },
];

/** Tous les items à plat (palette de commandes, résolution de titre/fil d'Ariane). */
export const NAV_FLAT: NavItem[] = NAV.flatMap((s) => s.items);

/**
 * Modules du rail de navigation (design « Registre »).
 *
 * Le rail ne porte que quatre modules ; le panneau liste les écrans du module courant,
 * regroupés par GESTE (Traiter, Suivre, Expédier…) plutôt qu'à plat. `NAV` reste la source
 * unique des écrans — libellé, icône, mots-clés, permissions : un module ne fait que RANGER
 * des écrans existants, il n'en déclare aucun, et ne touche ni aux routes ni aux droits.
 * `nav.test.ts` vérifie que chaque écran de `NAV` est rangé une fois et une seule.
 */
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface NavModule {
  id: string;
  /** Libellé court, sous l'icône du rail. */
  short: string;
  /** Libellé complet : fil d'Ariane, info-bulle, lecteurs d'écran. */
  label: string;
  icon: IconName;
  groups: NavGroup[];
}

const ITEM_BY_KEY = new Map(NAV_FLAT.map((i) => [i.key, i]));

/** Écrans de `NAV` désignés par leur route, dans l'ordre voulu pour le groupe. */
function pick(keys: string[]): NavItem[] {
  return keys.map((k) => {
    const item = ITEM_BY_KEY.get(k);
    if (!item) throw new Error(`nav : écran inconnu « ${k} »`);
    return item;
  });
}

/** Groupe reprenant TELLE QUELLE une section de `NAV` (réglages : le titre de section suffit). */
function sectionGroup(label: string): NavGroup {
  const section = NAV.find((s) => s.label === label);
  if (!section) throw new Error(`nav : section inconnue « ${label} »`);
  return { label, items: section.items };
}

export const MODULES: NavModule[] = [
  {
    id: 'archives',
    short: 'Archives',
    label: 'Docu-Archives',
    icon: 'archive',
    groups: [
      { label: 'Consulter', items: pick(['/dashboards', '/search', '/recherche-ia', '/espaces']) },
      { label: 'Verser', items: pick(['/acquisition']) },
      {
        label: 'Contrôler',
        items: pick([
          '/gouvernance',
          '/archives/integrite',
          '/archives/dua-expirees',
          '/archives/documents-epures',
        ]),
      },
      {
        label: 'Communiquer',
        items: pick([
          '/archives/communiquer',
          '/archives/documents-communiques',
          '/archives/mes-documents-communiques',
          '/archives/historique-communications',
        ]),
      },
    ],
  },
  {
    id: 'flow',
    short: 'Flow',
    label: 'Docu-Flow',
    icon: 'organigramme',
    groups: [
      { label: 'Traiter', items: pick(['/workflows/boite', '/workflows/lancer']) },
      { label: 'Suivre', items: pick(['/workflows/instances']) },
      { label: 'Concevoir', items: pick(['/workflows/conception']) },
      {
        label: 'Administrer',
        items: pick(['/workflows/administration', '/workflows/administration/plafonds']),
      },
    ],
  },
  {
    id: 'courriers',
    short: 'Courriers',
    label: 'Docu-Courriers',
    icon: 'mail',
    groups: [
      {
        label: 'Traiter',
        items: pick([
          '/courriers/enregistrement',
          '/courriers/controle',
          '/courriers/documents-scannes',
          '/courriers/parapheur',
          '/courriers/validation',
        ]),
      },
      {
        label: 'Suivre',
        items: pick(['/courriers/suivi', '/courriers/tableau-de-bord', '/courriers/recherche']),
      },
      { label: 'Expédier', items: pick(['/courriers/depart', '/courriers/integration-decharge']) },
    ],
  },
  {
    id: 'reglages',
    short: 'Réglages',
    label: 'Réglages',
    icon: 'settings',
    groups: [
      sectionGroup('Paramétrage Archives'),
      sectionGroup('Paramétrage Courrier'),
      sectionGroup('Sécurité Documentaire'),
      sectionGroup('Administration'),
    ],
  },
];

export interface NavPlace {
  module: NavModule;
  group: NavGroup;
  item: NavItem;
}

/** Emplacement (module, geste) d'un écran de `NAV`, désigné par sa route. */
export function placeOf(key: string): NavPlace | undefined {
  for (const module of MODULES) {
    for (const group of module.groups) {
      const item = group.items.find((i) => i.key === key);
      if (item) return { module, group, item };
    }
  }
  return undefined;
}

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

/** Emplacement (module, geste, écran) du chemin courant ; `undefined` hors menu (« Mon profil »). */
export function placeOfPath(pathname: string): NavPlace | undefined {
  const item = activeItem(pathname);
  return item ? placeOf(item.key) : undefined;
}
