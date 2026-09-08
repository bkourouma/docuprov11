import type { DefinitionWidget, PlacementWidget } from '../../common/agencement.service';
import { MENU_DASHBOARD_COURRIERS } from '../roles/menu-catalog';
import type { MailScope } from './domain';

/**
 * Catalogue STATIQUE des widgets du tableau de bord courrier — transposition du
 * `DashboardConfiguration` d'AspNetZero (`WidgetDefinition` / `DashboardDefinition`).
 *
 * Principe structurant, repris tel quel du pattern ABP :
 *
 *   **Le catalogue dit ce qui EXISTE ; l'agencement utilisateur dit ce qui est PLACÉ.**
 *
 * Le catalogue vit dans le code (permissions, tailles par défaut, contraintes) et évolue avec les
 * livraisons ; l'agencement vit dans `user_setting` et ne contient qu'un identifiant plus une
 * position. Un widget retiré du catalogue disparaît donc des tableaux de bord existants sans
 * migration de données, et un widget ajouté est immédiatement proposé à l'ajout.
 *
 * Les tailles sont exprimées en unités de grille sur `GRILLE_COLONNES` colonnes.
 */

/** Clé de réglage sous laquelle l'agencement est rangé (convention ABP : préfixe fonctionnel). */
export const CLE_AGENCEMENT = 'dashboard.courriers.layout';

/**
 * Source de données d'un widget. La page ne récupère QUE les jeux réellement nécessaires à
 * l'agencement affiché — un widget retiré cesse aussitôt de coûter une requête.
 */
export type WidgetDataKey =
  | 'alertes'
  | 'files'
  | 'synthese'
  | 'flux'
  | 'repartition'
  | 'retards'
  | 'delais'
  | 'charge'
  | 'hygiene';

/**
 * Définition d'un widget : le contrat commun (identifiant, libellés, tailles) plus ce qui est
 * propre à ce module — le jeu de données, la permission de menu et le périmètre.
 */
export interface WidgetDefinition extends DefinitionWidget {
  dataKey: WidgetDataKey;
  /** Clé de menu exigée. Tous exigent au minimum l'accès à l'écran. */
  menuRequis: string;
  /**
   * Périmètre minimal. `all` réserve le widget au suivi permanent : la charge nominative ne doit
   * pas être exposée à un agent, quelle que soit la mise en page qu'il se compose.
   */
  scopeRequis?: MailScope;
}

export const WIDGET_CATALOG: readonly WidgetDefinition[] = [
  {
    id: 'alertes',
    titre: 'Alertes',
    description: 'Retards courriers et imputations, courriers sans imputation.',
    dataKey: 'alertes',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 4,
    minW: 4,
    minH: 3,
  },
  {
    id: 'files',
    titre: 'Files de travail',
    description: "Compteurs des files, avec l'ancienneté du plus vieil élément.",
    dataKey: 'files',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 4,
    minW: 4,
    minH: 3,
  },
  {
    id: 'synthese',
    titre: 'Chiffres clés',
    description: 'Enregistrés, archivés, en cours et délai de traitement sur la période.',
    dataKey: 'synthese',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 8,
    minW: 6,
    minH: 6,
  },
  {
    id: 'flux',
    titre: 'Flux et encours',
    description: 'Entrées/sorties par période et courbe d’encours cumulé.',
    dataKey: 'flux',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 8,
    minW: 6,
    minH: 6,
  },
  {
    id: 'repartition',
    titre: 'Répartition',
    description: 'Ventilation par type, statut, correspondant, service…',
    dataKey: 'repartition',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 9,
    minW: 6,
    minH: 7,
  },
  {
    id: 'retards',
    titre: 'Retards',
    description: 'Paliers d’échéance, ancienneté du backlog et retards les plus anciens.',
    dataKey: 'retards',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 12,
    minW: 6,
    minH: 8,
  },
  {
    id: 'delais',
    titre: 'Délais et engagements',
    description: 'Délais de prise en charge et de traitement, respect du SLA.',
    dataKey: 'delais',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 7,
    minW: 6,
    minH: 6,
  },
  {
    id: 'charge',
    titre: 'Charge de travail',
    description: 'Charge par agent et par service. Réservé au suivi permanent.',
    dataKey: 'charge',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    // Restitution nominative : jamais servie hors périmètre global (l'API renvoie 403).
    scopeRequis: 'all',
    w: 12,
    h: 10,
    minW: 6,
    minH: 8,
  },
  {
    id: 'hygiene',
    titre: 'Hygiène des données',
    description: 'Défauts de saisie et de paramétrage qui dégradent les autres indicateurs.',
    dataKey: 'hygiene',
    menuRequis: MENU_DASHBOARD_COURRIERS,
    w: 12,
    h: 4,
    minW: 4,
    minH: 3,
  },
] as const;

export const WIDGETS_PAR_ID: ReadonlyMap<string, WidgetDefinition> = new Map(
  WIDGET_CATALOG.map((w) => [w.id, w]),
);

/**
 * Agencement par défaut — l'équivalent de la valeur servie par `AppSettingProvider` quand aucun
 * réglage utilisateur n'existe. Reproduit l'ordre de lecture voulu : l'alerte d'abord, l'analyse
 * ensuite, l'hygiène en dernier.
 */
export const AGENCEMENT_PAR_DEFAUT: readonly PlacementWidget[] = (() => {
  const ordre = [
    'alertes',
    'files',
    'synthese',
    'flux',
    'repartition',
    'retards',
    'delais',
    'charge',
    'hygiene',
  ];
  let y = 0;
  return ordre.map((id) => {
    const def = WIDGETS_PAR_ID.get(id) as WidgetDefinition;
    const placement = { id, x: 0, y, w: def.w, h: def.h };
    y += def.h;
    return placement;
  });
})();

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
  scope: MailScope,
  isAdmin: boolean,
): boolean {
  if (!isAdmin && !menuKeys.includes(def.menuRequis)) return false;
  if (def.scopeRequis === 'all' && scope !== 'all') return false;
  if (scope === 'none') return false;
  return true;
}

/** Catalogue filtré pour un utilisateur — alimente la modale « Ajouter un widget ». */
export function catalogueAutorise(
  menuKeys: readonly string[],
  scope: MailScope,
  isAdmin: boolean,
): WidgetDefinition[] {
  return WIDGET_CATALOG.filter((d) => widgetAutorise(d, menuKeys, scope, isAdmin));
}
