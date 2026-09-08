import type { DefinitionWidget, PlacementWidget } from '../../common/agencement.service';
import { MENU_DASHBOARD_ARCHIVES } from '../roles/menu-catalog';

/**
 * Catalogue STATIQUE des widgets du tableau de bord Docu-Archives — même principe que celui de
 * Docu-Courriers (`modules/courriers/dashboard-widgets.ts`), et pour les mêmes raisons :
 *
 *   **Le catalogue dit ce qui EXISTE ; l'agencement utilisateur dit ce qui est PLACÉ.**
 *
 * Le catalogue vit dans le code (permissions, tailles par défaut, contraintes) ; l'agencement vit
 * dans `user_setting` et ne contient qu'un identifiant plus une position. Un widget retiré du
 * catalogue disparaît donc des tableaux de bord existants sans migration de données.
 *
 * Différence assumée avec Docu-Courriers : ici, **aucune notion de périmètre**. L'accès aux
 * données d'analyse est déjà filtré par ACL dans `AnalyticsService`, et tous les widgets se
 * nourrissent du même agrégat `POST /analytics/overview`. La seule condition est donc l'accès à
 * l'écran lui-même.
 */
/** Clé de réglage sous laquelle l'agencement est rangé (convention ABP : préfixe fonctionnel). */
export const CLE_AGENCEMENT = 'dashboard.archives.layout';

/**
 * Définition d'un widget : le contrat commun (identifiant, libellés, tailles) plus ce qui est
 * propre à ce module. Ici, une seule chose — la clé de menu exigée.
 */
export interface WidgetDefinition extends DefinitionWidget {
  menuRequis: string;
}

export const WIDGET_CATALOG: readonly WidgetDefinition[] = [
  {
    id: 'kpis',
    titre: 'Chiffres clés',
    description: "Documents archivés, en attente d'indexation, lots en cours et taux d'indexation.",
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 12,
    h: 5,
    minW: 6,
    minH: 4,
  },
  {
    id: 'anomalies',
    titre: 'Anomalies de qualité',
    description: 'Documents sans type, sans dossier, sans date ou sans cote.',
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 12,
    h: 4,
    minW: 6,
    minH: 3,
  },
  {
    id: 'type',
    titre: 'Répartition par type',
    description: 'Composition du fonds par type de document.',
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 6,
    h: 9,
    minW: 4,
    minH: 7,
  },
  {
    id: 'programme',
    titre: 'Concentration par programme',
    description: 'Documents par sous-arbre de dossiers (treemap).',
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 6,
    h: 9,
    minW: 4,
    minH: 7,
  },
  {
    id: 'localisation',
    titre: 'Répartition par localisation',
    description: 'Où se trouve physiquement le fonds.',
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 6,
    h: 9,
    minW: 4,
    minH: 7,
  },
  {
    id: 'plan',
    titre: 'Répartition par plan de classement',
    description: 'Ventilation selon le plan de classement.',
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 6,
    h: 9,
    minW: 4,
    minH: 7,
  },
  {
    id: 'evolution',
    titre: 'Croissance du fonds',
    description: 'Production de la période et fonds cumulé dans le temps.',
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 12,
    h: 9,
    minW: 6,
    minH: 7,
  },
  {
    id: 'objectif',
    titre: 'Objectif vs réalisé',
    description: "Avancement de l'objectif du mois et rythme quotidien nécessaire.",
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 6,
    h: 7,
    minW: 4,
    minH: 6,
  },
  {
    id: 'pipeline',
    titre: "Lots d'acquisition",
    description: "Lots terminés, ouverts, en échec et taux d'échec.",
    menuRequis: MENU_DASHBOARD_ARCHIVES,
    w: 6,
    h: 7,
    minW: 4,
    minH: 6,
  },
] as const;

export const WIDGETS_PAR_ID: ReadonlyMap<string, WidgetDefinition> = new Map(
  WIDGET_CATALOG.map((w) => [w.id, w]),
);

/**
 * Agencement par défaut. Il **reproduit la mise en page historique de l'écran** — chiffres clés,
 * anomalies, puis les quatre répartitions deux par deux — pour que l'ouverture du mode
 * personnalisable ne déplace rien de ce que les utilisateurs connaissent déjà. Les trois derniers
 * widgets exploitent des blocs que l'API calculait sans que l'écran ne les affiche.
 */
export const AGENCEMENT_PAR_DEFAUT: readonly PlacementWidget[] = [
  { id: 'kpis', x: 0, y: 0, w: 12, h: 5 },
  { id: 'anomalies', x: 0, y: 5, w: 12, h: 4 },
  { id: 'type', x: 0, y: 9, w: 6, h: 9 },
  { id: 'programme', x: 6, y: 9, w: 6, h: 9 },
  { id: 'localisation', x: 0, y: 18, w: 6, h: 9 },
  { id: 'plan', x: 6, y: 18, w: 6, h: 9 },
  { id: 'evolution', x: 0, y: 27, w: 12, h: 9 },
  { id: 'objectif', x: 0, y: 36, w: 6, h: 7 },
  { id: 'pipeline', x: 6, y: 36, w: 6, h: 7 },
] as const;

/**
 * Un utilisateur peut-il voir ce widget ? Appliqué à la LECTURE comme à l'écriture.
 *
 * Le contrôle à la lecture n'est pas redondant : un droit peut être retiré après qu'un
 * utilisateur a composé son tableau de bord. Le widget doit alors disparaître de l'affichage
 * **sans être supprimé de son agencement** — si le droit lui est rendu, il le retrouve en place.
 */
export function widgetAutorise(
  def: WidgetDefinition,
  menuKeys: readonly string[],
  isAdmin: boolean,
): boolean {
  return isAdmin || menuKeys.includes(def.menuRequis);
}

/** Catalogue filtré pour un utilisateur — alimente la modale « Ajouter un widget ». */
export function catalogueAutorise(
  menuKeys: readonly string[],
  isAdmin: boolean,
): WidgetDefinition[] {
  return WIDGET_CATALOG.filter((d) => widgetAutorise(d, menuKeys, isAdmin));
}
