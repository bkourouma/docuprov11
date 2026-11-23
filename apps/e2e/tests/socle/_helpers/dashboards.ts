import type { Page, Request, Response } from '@playwright/test';

/**
 * Aides des scénarios « Tableaux de bord » (SOC-78..88).
 *
 * Miroir du catalogue serveur `apps/api/src/modules/analytics/dashboard-widgets.ts` : si un widget
 * y est ajouté ou retiré, ces constantes sont à aligner (les tests le signaleront).
 */

/** Clé de menu de l'écran ET permission des endpoints `/analytics/layout`. */
export const MENU_DASHBOARDS = '/dashboards';

export const LAYOUT_PATH = '/analytics/layout';
export const OVERVIEW_PATH = '/analytics/overview';
export const EXPORT_PATH = '/analytics/export';

/** Titres affichés dans l'en-tête de chaque widget (catalogue serveur, champ `titre`). */
export const WIDGET_TITRES = {
  kpis: 'Chiffres clés',
  type: 'Répartition par type',
  dossier: 'Répartition par dossier',
  plan: 'Répartition par plan de classement',
  evolution: 'Croissance du fonds',
} as const;

export type WidgetId = keyof typeof WIDGET_TITRES;

/** Agencement livré (`AGENCEMENT_PAR_DEFAUT`), dans l'ordre du serveur. */
export const AGENCEMENT_DEFAUT: readonly Placement[] = [
  { id: 'kpis', x: 0, y: 0, w: 12, h: 5 },
  { id: 'type', x: 0, y: 5, w: 6, h: 9 },
  { id: 'dossier', x: 6, y: 5, w: 6, h: 9 },
  { id: 'plan', x: 0, y: 14, w: 12, h: 9 },
  { id: 'evolution', x: 0, y: 23, w: 12, h: 9 },
];

export const IDS_DEFAUT: readonly string[] = AGENCEMENT_DEFAUT.map((w) => w.id);

export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Forme de `GET|PUT|DELETE /analytics/layout` (miroir de `AgencementResponse`). */
export interface Agencement {
  colonnes: number;
  widgets: Array<Placement & { titre: string; description: string; minW: number; minH: number }>;
  disponibles: Array<{
    id: string;
    titre: string;
    description: string;
    minW: number;
    minH: number;
  }>;
  parDefaut: boolean;
}

/** Position seule d'un widget résolu — pour comparer à ce qui a été envoyé. */
export const position = ({ id, x, y, w, h }: Placement): Placement => ({ id, x, y, w, h });

/**
 * Prédicats d'appel API, par CHEMIN (et non par URL complète) : l'API peut être servie via le proxy
 * Next (`/api/...` sur l'hôte web) ou adressée directement — le chemin reste `/api/...`.
 */
const surChemin = (url: string, path: string): boolean => new URL(url).pathname === `/api${path}`;

export const reponseApi =
  (path: string, method: string) =>
  (r: Response): boolean =>
    surChemin(r.url(), path) && r.request().method() === method;

export const requeteApi =
  (path: string, method: string) =>
  (r: Request): boolean =>
    surChemin(r.url(), path) && r.method() === method;

/**
 * Ouvre `/dashboards` et attend les DEUX chargements de l'écran : l'agencement (`GET layout`) et
 * l'agrégat (`POST overview`). Renvoie l'agencement reçu et le corps de l'agrégat demandé.
 */
export async function ouvrirTableauDeBord(
  page: Page,
): Promise<{ agencement: Agencement; filtre: Record<string, unknown> }> {
  // Le corps est lu dès l'arrivée de la réponse : lu plus tard, il peut déjà avoir été libéré par
  // le navigateur (« No resource with given identifier »).
  const layout = page
    .waitForResponse(reponseApi(LAYOUT_PATH, 'GET'))
    .then(async (r) => ({ status: r.status(), body: r.status() === 200 ? ((await r.json()) as Agencement) : null }));
  const overview = page.waitForResponse(reponseApi(OVERVIEW_PATH, 'POST'));
  await page.goto('/dashboards');
  const [l, o] = await Promise.all([layout, overview]);
  if (l.status !== 200 || !l.body) throw new Error(`GET ${LAYOUT_PATH} → ${l.status}`);
  if (o.status() !== 200) throw new Error(`POST ${OVERVIEW_PATH} → ${o.status()}`);
  return {
    agencement: l.body,
    filtre: o.request().postDataJSON() as Record<string, unknown>,
  };
}

/** Cadre d'un widget dans la grille (`data-testid` posé par `GrilleWidgets`). */
export const widget = (page: Page, id: string) => page.getByTestId(`widget-${id}`);

/** Nombre de jours entre deux dates ISO `AAAA-MM-JJ` (bornes du filtre de période). */
export function joursEntre(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
