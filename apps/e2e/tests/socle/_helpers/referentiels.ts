/**
 * Aides de la tâche C (lot 5) — écrans de référentiels (types de document, dossiers, plan de
 * classement, géolocalisation), tous bâtis sur `components/RefLayout.tsx` : table à gauche, carte
 * « Nouvel élément » à droite (viewport ≥ lg, cas de la config par défaut), boutons Excel / PDF.
 */
import { expect, type Download, type Locator, type Page } from '@playwright/test';
import { waitApi, type Api } from './securite';

export interface RefScreen {
  /** Route de l'écran (= clé de menu, sauf la géolocalisation, masquée du catalogue). */
  page: string;
  /** Titre de la page (`PageHeader`, h2). */
  title: string;
  /** Ressource REST sous `/referentials`. */
  resource: 'document-types' | 'dossiers' | 'plans' | 'locations';
  /** Nom de fichier des exports (`RefLayout.exportFilename`). */
  exportFilename: string;
  /** Champ identifiant de la ressource. */
  idKey: 'documentTypeId' | 'dossierId' | 'planId' | 'locationId';
}

export const SCREENS = {
  documentTypes: {
    page: '/admin/document-types',
    title: 'Types de document',
    resource: 'document-types',
    exportFilename: 'types-document',
    idKey: 'documentTypeId',
  },
  dossiers: {
    page: '/admin/dossiers',
    title: 'Gestion des dossiers',
    resource: 'dossiers',
    exportFilename: 'dossiers',
    idKey: 'dossierId',
  },
  plans: {
    page: '/admin/classification-plans',
    title: 'Plan de classement',
    resource: 'plans',
    exportFilename: 'plan-classement',
    idKey: 'planId',
  },
  locations: {
    page: '/admin/geolocalisation',
    title: 'Gestion de la géolocalisation',
    resource: 'locations',
    exportFilename: 'geolocalisation',
    idKey: 'locationId',
  },
} as const satisfies Record<string, RefScreen>;

/** Ouvre l'écran et attend le chargement de sa liste. */
export async function openRef(page: Page, screen: RefScreen): Promise<void> {
  const listed = waitApi(page, 'GET', `/referentials/${screen.resource}`);
  await page.goto(screen.page);
  expect((await listed).status()).toBe(200);
  await expect(page.getByRole('heading', { name: screen.title, exact: true })).toBeVisible();
}

/**
 * Champ texte du formulaire « Nouvel élément », par son NOM ACCESSIBLE. Pas de `getByLabel(…,
 * { exact: true })` : `NewItemField` ajoute au `<label>` une astérisque `aria-hidden` pour les champs
 * requis, que `getByLabel` compte dans le texte (« Libellé* ») alors que le nom accessible du champ,
 * lui, l'exclut (« Libellé »).
 */
export function refTextbox(page: Page, name: string): Locator {
  return page.getByRole('textbox', { name, exact: true });
}

/** Sélecteur d'arbre « Élément parent » (TreeSelect `showSearch` : un combobox). */
export function refParentField(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Élément parent', exact: true });
}

/** Clique un bouton d'export et rend le téléchargement (événement `download`, fichier blob). */
export async function exportVia(page: Page, button: 'Excel' | 'PDF'): Promise<Download> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  return download;
}

/**
 * Choisit le parent dans un TreeSelect AntD `showSearch` (`treeNodeFilterProp="title"`). Le titre
 * d'un nœud vaut « libellé (code) » pour le plan et la géolocalisation : correspondance partielle.
 * Le `title` est porté par `.ant-select-tree-node-content-wrapper` LUI-MÊME (pas par un descendant) :
 * intersection `and()` plutôt qu'un `getByTitle` chaîné, qui ne cherche que dans les descendants.
 */
export async function pickTreeNode(page: Page, field: Locator, label: string): Promise<void> {
  await field.click();
  await field.fill(label);
  await page
    .locator('.ant-select-dropdown:visible .ant-select-tree-node-content-wrapper')
    .and(page.getByTitle(label))
    .first()
    .click();
}

/** Liste active d'une ressource (lecture partagée). */
export async function listRef<T = Record<string, unknown>>(api: Api, screen: RefScreen): Promise<T[]> {
  return api.get(`/referentials/${screen.resource}`);
}

export interface Created {
  screen: RefScreen;
  id: number;
}

/**
 * Nettoyage (à appeler dans `afterEach`) : désactive ce que le test a créé, enfants d'abord.
 * Les réponses ne sont pas vérifiées — un élément déjà désactivé par le test rend 200 lui aussi.
 */
export async function dropCreated(api: Api, items: Created[]): Promise<void> {
  for (const { screen, id } of [...items].reverse()) {
    await api.raw.del(`/referentials/${screen.resource}/${id}`);
  }
  items.length = 0;
}

/** Création par API, inscrite au nettoyage. */
export async function createRef<T extends Record<string, unknown>>(
  api: Api,
  items: Created[],
  screen: RefScreen,
  body: Record<string, unknown>,
): Promise<T> {
  const row = (await api.post(`/referentials/${screen.resource}`, body)) as T;
  items.push({ screen, id: row[screen.idKey] as number });
  return row;
}
