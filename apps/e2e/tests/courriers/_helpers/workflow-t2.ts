import { expect, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';
import { FORBIDDEN_MESSAGE, escapeRegExp, openDropdown } from './ui';
import { uniqueSuffix } from './unique';

/**
 * Aides propres aux écrans Parapheur / Suivi / Validation et au visualiseur commun
 * (`apps/web/app/components/mail/*`). Complètent les aides figées du module sans les modifier.
 *
 * Lu dans le code (phase A) :
 *  - Les worklists (`MailWorklist`) sont des `Table` AntD paginées côté serveur (25 lignes par
 *    défaut, tri `createdAt desc`). Le titre est un `<a onClick>` SANS `href` : il n'a donc pas le
 *    rôle `link`, on le vise par son texte.
 *  - Le détail plein écran (`MailDetailPage`) : boutons d'action (« Marquer traité », « Validation
 *    DG », « Décharger », « Enregistrer la réponse », « Archiver ») sous l'en-tête ; onglets
 *    « Courrier » / « Imputations (N) » ; formulaire d'imputation à libellés reliés (`#imp-role`,
 *    `#imp-actors`, `#imp-type`, `#imp-deadline`, `#imp-instructions`).
 *  - Le visualiseur popup (`MailViewer`, Validation) : mêmes actions dans le pied de la modale.
 *
 * Hypothèses à vérifier en phase B :
 *  - Le changeur de taille de page AntD (locale fr_FR) propose l'option « 100 / page ».
 *  - Le compteur d'un `Badge` AntD porte `title=<nombre>` sur `.ant-badge-count`.
 */

/** Chemins (pathname, sans query) des files appelées par les écrans. */
export const QUEUE_API = {
  parapheur: /\/api\/courriers\/parapheur$/,
  suivi: /\/api\/courriers\/suivi$/,
  validation: /\/api\/courriers\/validation-direction$/,
} as const;

/** `GET /api/courriers/:id` (détail, avec ou sans `?imputations=mine`). */
export const mailDetailApi = (mailId: number): RegExp => new RegExp(`/api/courriers/${mailId}$`);

/** `POST /api/courriers/:id/imputations/lecture` (validation automatique à l'ouverture). */
export const lectureApi = (mailId: number): RegExp =>
  new RegExp(`/api/courriers/${mailId}/imputations/lecture$`);

/** Une réponse d'API brute est le refus du `MenuPermissionGuard` (403 + message standard). */
export async function expectForbidden(res: APIResponse): Promise<void> {
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
}

/** Réponse d'API (préfixe `/api` du proxy Next) dont le chemin correspond à `path`. */
export function waitApi(page: Page, method: string, path: RegExp): Promise<Response> {
  return page.waitForResponse(
    (r) => r.request().method() === method && path.test(new URL(r.url()).pathname),
  );
}

/** Ouvre une worklist et attend sa première page (renvoie la réponse : 200 ou 403). */
export async function gotoWorklist(page: Page, route: string, apiPath: RegExp): Promise<Response> {
  const loaded = waitApi(page, 'GET', apiPath);
  await page.goto(route);
  return loaded;
}

/**
 * Passe la worklist à 100 lignes par page : les files globales (Suivi permanent, Validation)
 * reçoivent les courriers de TOUS les tests parallèles, le nôtre peut sortir de la 1re page à 25.
 */
export async function showHundredRows(page: Page, apiPath: RegExp): Promise<void> {
  const reloaded = page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      r.request().method() === 'GET' &&
      apiPath.test(url.pathname) &&
      url.searchParams.get('pageSize') === '100'
    );
  });
  await page.locator('.ant-pagination-options .ant-select-selector').first().click();
  await openDropdown(page).getByTitle('100 / page', { exact: true }).click();
  await reloaded;
}

/** Ligne d'une worklist portant ce titre de courrier. */
export function worklistRow(page: Page, title: string): Locator {
  return page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: title });
}

/** Toutes les lignes de données d'une worklist. */
export function worklistRows(page: Page): Locator {
  return page.locator('.ant-table-tbody tr.ant-table-row');
}

/** Ouvre le courrier depuis sa ligne (clic sur l'objet). */
export async function openFromWorklist(page: Page, title: string): Promise<void> {
  await worklistRow(page, title).getByText(title, { exact: true }).click();
}

/** Bouton d'action de workflow (libellé exact, cf. `useMailWorkflow.actions`). */
export function actionButton(scope: Page | Locator, label: string): Locator {
  return scope.getByRole('button', { name: label, exact: true });
}

/** Badge de statut du courrier (`MailStatusTag`), libellé exact (« Traité », « Rédaction »…). */
export function statusTag(scope: Page | Locator, label: string): Locator {
  return scope.locator('.ant-tag').filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`) });
}

/** Onglet « Imputations (N) » du détail / du visualiseur. */
export function imputationsTab(scope: Page | Locator): Locator {
  return scope.getByRole('tab', { name: /^Imputations \(\d+\)$/ });
}

/** Élément de la liste d'imputations contenant `text` (nom de l'imputé, libellé du type…). */
export function imputationItem(scope: Page | Locator, text: string): Locator {
  return scope.locator('.ant-list-item').filter({ hasText: text });
}

/**
 * Élément de la liste d'imputations dont l'IMPUTÉ est `assignee` (titre de l'élément : type +
 * imputé). À préférer à `imputationItem` pour viser une personne : son nom figure aussi dans
 * l'historique (« Créée le … par <nom> ») des imputations qu'elle a créées.
 */
export function imputationItemOf(scope: Page | Locator, assignee: string): Locator {
  const page = 'keyboard' in scope ? scope : scope.page();
  return scope
    .locator('.ant-list-item')
    .filter({ has: page.locator('.ant-list-item-meta-title', { hasText: assignee }) });
}

// ---- Ant Design : saisie ----------------------------------------------------------------------

/**
 * Conteneur `.ant-select` d'un Select AntD, à partir de son input `combobox`. Quand une valeur est
 * déjà choisie, sa pastille `.ant-select-selection-item` recouvre l'input : un clic sur l'input est
 * intercepté (Playwright réessaie jusqu'au délai). Le clic sur le conteneur ouvre la liste.
 */
export function selectBox(combobox: Locator): Locator {
  return combobox.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
  );
}

/**
 * Comme `selectOption` (ui.ts), mais sûr quand le Select porte DÉJÀ une valeur (changement de
 * choix) : la liste est ouverte par le conteneur (cf. `selectBox`).
 */
export async function chooseOption(
  page: Page,
  combobox: Locator,
  optionLabel: string,
  opts: { multiple?: boolean; search?: boolean } = {},
): Promise<void> {
  await selectBox(combobox).click();
  if (opts.search !== false) await combobox.fill(optionLabel);
  const option = openDropdown(page).getByTitle(optionLabel, { exact: true });
  await expect(option).toBeVisible();
  await option.click();
  if (opts.multiple) await combobox.press('Escape');
}

/**
 * Saisit une date `JJ/MM/AAAA` dans un DatePicker AntD SANS appuyer sur Entrée : rc-picker ne
 * bloque pas l'Entrée, qui déclenche aussi la soumission implicite du `<form>` englobant (sur
 * l'écran Départ, objet et date suffisent : le courrier était créé à mi-saisie). La date tapée est
 * retenue à la sortie du champ (Tab).
 */
export async function typeDate(input: Locator, ddmmyyyy: string): Promise<void> {
  await input.click();
  await input.fill(ddmmyyyy);
  await input.press('Tab');
  await expect(input).toHaveValue(ddmmyyyy);
}

/** Compteur (`Badge`) porté par un élément : `.ant-badge-count` avec `title=<n>`. */
export function badgeCount(scope: Locator): Locator {
  return scope.locator('.ant-badge-count');
}

// ---- API ---------------------------------------------------------------------------------

export interface InputationTypeRef {
  mailInputationTypeId: number;
  label: string;
  suivi: boolean;
}

/**
 * Type d'imputation unique au test (`POST /courriers/referentials/inputation-types`, menu
 * Types d'imputation — l'admin passe). Le seed ne fournit qu'un type « ordinaire » non auto-traité
 * à la lecture qui ait un sens métier ambigu (14 = Validation Direction) : un type neuf `suivi=false`
 * évite que l'ouverture du parapheur ne traite l'imputation à l'insu du test.
 */
export async function createInputationType(
  api: ApiClient,
  label: string,
  suivi = false,
): Promise<InputationTypeRef> {
  const row = (await api.post('/courriers/referentials/inputation-types', { label, suivi })) as {
    mailInputationTypeId: number;
    label: string;
    suivi: boolean;
  };
  return { mailInputationTypeId: row.mailInputationTypeId, label: row.label, suivi: row.suivi };
}

/**
 * Rôle actif, non système, SANS porteur (`POST /roles`, admin). Il figure dans le lookup
 * `GET /courriers/destinataire-roles` (`userCount = 0`) : le sélecteur « Imputer à » reste vide.
 */
export async function createEmptyRole(api: ApiClient, prefix: string): Promise<{ roleId: number; name: string }> {
  const role = (await api.post('/roles', {
    name: `${prefix} ${uniqueSuffix()}`,
    description: 'Rôle sans porteur créé par les tests E2E Docu-Courriers',
    menuKeys: [],
  })) as { roleId: number; name: string };
  return { roleId: role.roleId, name: role.name };
}

export interface InputationRow {
  mailInputationId: number;
  userId: number;
  mailInputationTypeId: number;
  instructions: string | null;
  deadline: string | null;
  dateTreated: string | null;
  createdBy: number | null;
  type: { label: string; suivi: boolean } | null;
}

/** Imputations d'un détail `GET /courriers/:id`, éventuellement filtrées sur l'imputé. */
export function inputationsOf(mail: { inputations: InputationRow[] }, userGroupId?: number): InputationRow[] {
  return userGroupId == null
    ? mail.inputations
    : mail.inputations.filter((i) => i.userId === userGroupId);
}

/** Ids des courriers d'une file (`GET <path>?page=1&pageSize=200`), et son total. */
export async function queueIds(
  client: ApiClient,
  path: string,
): Promise<{ total: number; ids: number[] }> {
  const res = (await client.get(`${path}?page=1&pageSize=200`)) as {
    total: number;
    rows: Array<{ mailId: number }>;
  };
  return { total: res.total, ids: res.rows.map((r) => r.mailId) };
}

export interface BadgeCounts {
  controle: number;
  validation: number;
  suivi: number;
  parapheur: number;
  decharge: number;
  scans: number;
}

export function getBadges(client: ApiClient): Promise<BadgeCounts> {
  return client.get('/courriers/badges') as Promise<BadgeCounts>;
}

export interface NotificationRow {
  notificationId: number;
  message: string;
  targetType: string | null;
  targetId: number | null;
  isRead: boolean;
}

/** Inbox de l'appelant (`GET /notifications`), 100 dernières. */
export async function notificationsOf(
  client: ApiClient,
  opts: { unreadOnly?: boolean } = {},
): Promise<{ total: number; unread: number; rows: NotificationRow[] }> {
  return (await client.get(
    `/notifications?page=1&pageSize=100${opts.unreadOnly ? '&unreadOnly=true' : ''}`,
  )) as { total: number; unread: number; rows: NotificationRow[] };
}

/** Notifications de l'appelant portant exactement ce message. */
export async function notificationsWithMessage(
  client: ApiClient,
  message: string,
): Promise<NotificationRow[]> {
  const { rows } = await notificationsOf(client);
  return rows.filter((n) => n.message === message);
}

// ---- Dates ---------------------------------------------------------------------------------

/** Date locale du jour + `days`, au format `JJ/MM/AAAA` des DatePicker de l'application. */
export function frDateInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** Vérifie qu'un instant ISO tombe, dans le fuseau du NAVIGATEUR, au jour `JJ/MM/AAAA`. */
export async function expectSameLocalDay(page: Page, iso: string | null, ddmmyyyy: string): Promise<void> {
  expect(iso, 'échéance enregistrée').not.toBeNull();
  const local = await page.evaluate((v) => {
    const d = new Date(v as string);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }, iso);
  expect(local).toBe(ddmmyyyy);
}

/** L'instant ISO est-il à `hours` heures de `from` (± `toleranceMin` minutes) ? */
export function expectHoursAfter(iso: string | null, from: number, hours: number, toleranceMin = 10): void {
  expect(iso, 'échéance enregistrée').not.toBeNull();
  const delta = new Date(iso as string).getTime() - (from + hours * 3600_000);
  expect(Math.abs(delta)).toBeLessThan(toleranceMin * 60_000);
}
