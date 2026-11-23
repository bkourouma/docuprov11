/**
 * Aides propres aux specs du paramétrage Docu-Courriers (exécutant T4) et à la spec transverse
 * des permissions de menu. Les aides partagées du module (acteurs, référentiels, courriers)
 * vivent dans `./index` (T1) : ce fichier ne les duplique pas.
 *
 * Conventions de l'écran (lues dans le code) :
 *  - pages de référentiel = `RefLayout` : tableau à gauche, carte « <formTitle> » à droite au
 *    format desktop (≥ lg) — Playwright tourne en 1280 px, la carte est donc toujours affichée ;
 *  - édition en place = `EditableText` / `EditableSelect` / `EditableLocation`
 *    (`components/editable.tsx`) : une cellule `role="button"` (titre « Cliquer pour modifier »)
 *    qui devient un champ, validé par Entrée ou à la perte de focus ;
 *  - désactivation = bouton danger `aria-label="Désactiver …"` + Popconfirm (« Désactiver ») ;
 *  - retours = `message.success/error` d'AntD (`.ant-message`).
 */
import type { Locator, Page, Response } from '@playwright/test';
import { expect } from '../../../fixtures';
import type { ApiClient } from '../../../fixtures';
import { FORBIDDEN_MESSAGE, openDropdown } from './ui';

// ---------------------------------------------------------------------------------------------
// Routes API (relatives à /api)
// ---------------------------------------------------------------------------------------------

export const REF_API = {
  natures: '/courriers/referentials/natures',
  objets: '/courriers/referentials/objets',
  confidentialites: '/courriers/referentials/confidentialites',
  departTypes: '/courriers/referentials/depart-types',
  inputationTypes: '/courriers/referentials/inputation-types',
  externalEntityTypes: '/courriers/referentials/external-entity-types',
  externalEntities: '/courriers/referentials/external-entities',
  customProperties: '/courriers/referentials/custom-properties',
  customValues: '/courriers/referentials/custom-values',
  organigramme: '/courriers/organigramme',
  roleAssignments: '/courriers/organigramme/role-assignments',
} as const;

/** Message du `MenuPermissionGuard` et liste déroulante ouverte : définis une seule fois (T1). */
export { FORBIDDEN_MESSAGE, openDropdown };

/** Identifiant qui n'existe dans aucune table (int4 positif). */
export const UNKNOWN_ID = 2_000_000_000;

// ---------------------------------------------------------------------------------------------
// Outils génériques
// ---------------------------------------------------------------------------------------------

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Attend la réponse d'un appel API du navigateur (`/api<path>`), méthode et chemin exacts.
 * Le préfixe `/api` est EXIGÉ : plusieurs écrans ont la même URL que leur endpoint de
 * chargement (`/courriers/suivi`, `/courriers/parapheur`…) ; sans lui, la navigation du
 * document (HTML, 200) satisferait l'attente à la place de l'appel API.
 */
export function waitApi(
  page: Page,
  method: string,
  path: string | RegExp,
  status?: number,
  timeout?: number,
): Promise<Response> {
  return page.waitForResponse(
    (r) => {
      if (r.request().method() !== method) return false;
      const full = new URL(r.url()).pathname;
      if (!full.startsWith('/api/')) return false;
      const pathname = full.slice('/api'.length);
      const okPath = typeof path === 'string' ? pathname === path : path.test(pathname);
      return okPath && (status === undefined || r.status() === status);
    },
    timeout === undefined ? undefined : { timeout },
  );
}

/** Délai de navigation de la configuration Playwright (`navigationTimeout`). */
const NAVIGATION_TIMEOUT = 45_000;

/**
 * Ouvre un écran et attend l'appel de chargement qu'il déclenche au montage : sans cela, la
 * réponse du chargement initial pourrait satisfaire l'attente d'un rechargement ultérieur.
 * L'appel de chargement fait partie de la navigation (chargement du document, hydratation,
 * premier GET) : il reçoit donc le délai de navigation, pas le délai d'action de 15 s, que la
 * machine chargée par les autres lots dépasse.
 */
export async function gotoAndWait(
  page: Page,
  url: string,
  method: string,
  path: string | RegExp,
): Promise<Response> {
  const loaded = waitApi(page, method, path, undefined, NAVIGATION_TIMEOUT);
  await page.goto(url);
  return loaded;
}

/** Notification AntD (`message.success/error`) portant ce texte. */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator('.ant-message').getByText(text).first()).toBeVisible();
}

/** Carte AntD par son titre (ex. « Nouvelle nature », « Organigramme »). */
export function card(page: Page, title: string): Locator {
  return page
    .locator('.ant-card')
    .filter({ has: page.locator('.ant-card-head-title').getByText(title, { exact: true }) });
}

/** Lignes de données d'un tableau AntD dont une cellule porte EXACTEMENT ce texte. */
function rowsWithText(scope: Page | Locator, text: string): Locator {
  return scope
    .locator('.ant-table-tbody tr.ant-table-row')
    .filter({ has: scope.getByText(text, { exact: true }) });
}

/**
 * Trouve la ligne d'un tableau paginé côté client en parcourant ses pages : la base E2E
 * accumule les référentiels de tous les tests, la ligne cherchée n'est pas forcément en page 1.
 */
/** Attend la table (ou l'état vide du patron) puis revient en page 1. `false` = pas de table. */
async function tableAtFirstPage(scope: Page | Locator): Promise<boolean> {
  // Table rendue, ou état vide du patron (MailRefPage remplace la table par « Aucun élément »).
  await expect(
    scope
      .locator('.ant-table')
      .or(scope.getByText(/^(Aucun élément|Ce référentiel est vide)$/))
      .first(),
  ).toBeVisible();
  if ((await scope.locator('.ant-table').count()) === 0) return false;
  const first = scope.locator('.ant-pagination-item-1').first();
  if ((await first.count()) > 0 && !(await first.getAttribute('class'))?.includes('active')) {
    await first.click();
    await expect(first).toHaveClass(/ant-pagination-item-active/);
  }
  return true;
}

/** Passe à la page suivante ; `false` s'il n'y en a pas. */
async function nextPage(scope: Page | Locator, current: number): Promise<boolean> {
  const next = scope.locator('.ant-pagination-next').first();
  if ((await next.count()) === 0 || (await next.getAttribute('aria-disabled')) === 'true') {
    return false;
  }
  await next.click();
  await expect(scope.locator('.ant-pagination-item-active').first()).toHaveText(
    String(current + 1),
  );
  return true;
}

export async function findRow(
  scope: Page | Locator,
  text: string,
  opts: { maxPages?: number; settleMs?: number } = {},
): Promise<Locator> {
  const row = rowsWithText(scope, text);
  if (!(await tableAtFirstPage(scope))) {
    throw new Error(`Ligne « ${text} » introuvable dans le tableau (référentiel vide)`);
  }
  for (let n = 1; n <= (opts.maxPages ?? 100); n++) {
    // Page 1 : attente courte et bornée, un rechargement de liste en vol (après une écriture)
    // remplace les lignes quelques instants plus tard ; un simple `count()` lirait l'état
    // précédent. Pages suivantes : la pagination est côté client et `nextPage` a déjà attendu
    // l'activation de la page, les lignes sont donc rendues — un `count()` suffit. Sans cela, la
    // base E2E accumulant les données d'un lancement à l'autre, le parcours coûtait 2 s par page
    // et dépassait le délai du test.
    const present =
      n === 1
        ? await row
            .first()
            .waitFor({ state: 'visible', timeout: opts.settleMs ?? 2_000 })
            .then(() => true)
            .catch(() => false)
        : (await row.count()) > 0;
    if (present) return row.first();
    if (!(await nextPage(scope, n))) break;
  }
  throw new Error(`Ligne « ${text} » introuvable dans le tableau`);
}

/**
 * Vérifie qu'AUCUNE page du tableau ne porte une ligne avec ce texte. Sur chaque page,
 * l'assertion se répète (toHaveCount) le temps qu'un rechargement en vol retire la ligne.
 */
export async function expectNoRow(scope: Page | Locator, text: string): Promise<void> {
  const row = rowsWithText(scope, text);
  if (!(await tableAtFirstPage(scope))) return;
  for (let n = 1; n <= 100; n++) {
    await expect(row).toHaveCount(0);
    if (!(await nextPage(scope, n))) return;
  }
}

/**
 * Même ligne, désignée par sa clé AntD (`data-row-key` = `rowKey` de la Table) plutôt que par
 * son texte. Une ligne trouvée par `findRow(page, libellé)` ne se résout plus dès que la cellule
 * de ce libellé passe en édition (le texte devient la valeur d'un `<input>`, que `getByText`
 * ne lit pas). Sans clé, la ligne d'origine est rendue telle quelle.
 */
export async function pinRow(row: Locator): Promise<Locator> {
  const key = await row.getAttribute('data-row-key');
  if (key === null) return row;
  return row
    .page()
    .locator(`.ant-table-tbody tr.ant-table-row[data-row-key="${key.replace(/["\\]/g, '\\$&')}"]`);
}

/** Édition en place d'une cellule `EditableText` : clic, saisie, Entrée → PATCH attendu. */
export async function editInline(
  page: Page,
  row: Locator,
  current: string,
  next: string,
  patchPath: string | RegExp,
): Promise<Response> {
  const pinned = await pinRow(row);
  await pinned.getByRole('button', { name: current, exact: true }).click();
  const input = pinned.getByRole('textbox');
  await expect(input).toBeFocused();
  await input.fill(next);
  const res = waitApi(page, 'PATCH', patchPath);
  await input.press('Enter');
  return res;
}

/** Désactivation par le bouton de ligne + confirmation du Popconfirm → DELETE attendu. */
export async function deactivateRow(
  page: Page,
  row: Locator,
  buttonName: string | RegExp,
  deletePath: string | RegExp,
): Promise<Response> {
  await row.getByRole('button', { name: buttonName }).click();
  const pop = page.locator('.ant-popover:visible, .ant-popconfirm:visible').last();
  await expect(pop).toBeVisible();
  const res = waitApi(page, 'DELETE', deletePath);
  await pop.getByRole('button', { name: 'Désactiver', exact: true }).click();
  return res;
}

/**
 * Choisit une option d'un `Select` AntD à recherche (`showSearch`) : ouverture, saisie du
 * libellé (filtre), clic sur l'option portant exactement ce titre.
 */
export async function pickOption(page: Page, combobox: Locator, label: string): Promise<void> {
  const option = await optionsMatching(page, combobox, label);
  await option.first().click();
}

/**
 * Options d'un Select ouvert puis filtré par ce libellé (0 = le référentiel ne le propose pas).
 * AntD rend chaque option `div.ant-select-item-option` avec le libellé pour texte.
 */
export async function optionsMatching(page: Page, combobox: Locator, label: string): Promise<Locator> {
  await combobox.click();
  await page.keyboard.type(label);
  await expect(openDropdown(page)).toBeVisible();
  return openDropdown(page)
    .locator('.ant-select-item-option')
    .filter({ hasText: new RegExp(`^${escapeRe(label)}$`) });
}

/** Choisit un nœud d'un `TreeSelect` AntD déjà ouvert et focalisé (recherche puis clic). */
export async function pickTreeNode(page: Page, title: string): Promise<void> {
  await page.keyboard.type(title);
  await openDropdown(page)
    .locator('.ant-select-tree-node-content-wrapper')
    .filter({ hasText: new RegExp(`^${escapeRe(title)}$`) })
    .first()
    .click();
}

// ---------------------------------------------------------------------------------------------
// Barre latérale (AuthShell + nav.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Compteur de badge AntD éventuel après un libellé. Le `ScrollNumber` d'AntD rend chaque
 * chiffre dans son propre élément : le nom accessible d'un compteur à deux chiffres vaut
 * « Suivi des courriers 3 1 » (et non « 31 »), d'où les espaces admis entre les chiffres.
 */
const BADGE_SUFFIX = '(?:\\s*\\d(?:\\s*\\d)*\\+?)?';

/**
 * Section de la barre latérale (sous-menu AntD inline). La section de la route courante est
 * ouverte d'office par `AuthShell` (`sectionOf(pathname)`) : il suffit d'être sur un écran de la
 * section pour que ses entrées soient rendues.
 */
export function navSection(page: Page, sectionLabel: string): Locator {
  return page
    .locator('.ant-layout-sider li.ant-menu-submenu')
    .filter({
      has: page.locator('.ant-menu-submenu-title').filter({
        hasText: new RegExp(`^${escapeRe(sectionLabel)}${BADGE_SUFFIX}$`),
      }),
    });
}

/** Entrée de menu par son libellé exact (un compteur de badge éventuel est toléré). */
export function navEntry(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('menuitem', {
    name: new RegExp(`^${escapeRe(label)}${BADGE_SUFFIX}$`),
  });
}

// ---------------------------------------------------------------------------------------------
// Données de test via l'API (préconditions)
// ---------------------------------------------------------------------------------------------

export interface OrgNode {
  organigrammeId: number;
  parentId: number | null;
  label: string;
  depth: number;
  path: string;
  isActive?: boolean;
}

export async function createOrgNode(
  api: ApiClient,
  label: string,
  parentId?: number,
): Promise<OrgNode> {
  return (await api.post(REF_API.organigramme, parentId ? { label, parentId } : { label })) as OrgNode;
}

export async function listOrgNodes(api: ApiClient): Promise<OrgNode[]> {
  return (await api.get(REF_API.organigramme)) as OrgNode[];
}

/** Libellés actifs d'un référentiel plat (lookup des formulaires). */
export async function activeLabels(api: ApiClient, path: string): Promise<string[]> {
  return ((await api.get(path)) as Array<{ label: string }>).map((r) => r.label);
}
