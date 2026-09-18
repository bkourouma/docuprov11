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
    id: 'dossier',
    titre: 'Répartition par dossier',
    description: 'Documents par dossier de classement.',
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
] as const;

export const WIDGETS_PAR_ID: ReadonlyMap<string, WidgetDefinition> = new Map(
  WIDGET_CATALOG.map((w) => [w.id, w]),
);

/**
 * Agencement par défaut : chiffres clés, puis les répartitions. `plan` occupe toute la largeur
 * plutôt que la moitié gauche — sans binôme depuis le retrait de « localisation », un demi-widget
 * laisserait un trou à sa droite.
 */
export const AGENCEMENT_PAR_DEFAUT: readonly PlacementWidget[] = [
  { id: 'kpis', x: 0, y: 0, w: 12, h: 5 },
  { id: 'type', x: 0, y: 5, w: 6, h: 9 },
  { id: 'dossier', x: 6, y: 5, w: 6, h: 9 },
  { id: 'plan', x: 0, y: 14, w: 12, h: 9 },
  { id: 'evolution', x: 0, y: 23, w: 12, h: 9 },
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
