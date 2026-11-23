/**
 * Aides propres aux specs T3 (Départ, Intégration décharge, Recherche, Tableau de bord, parcours).
 *
 * Elles complètent les aides figées du module (`menus`, `actors`, `files`, `referentials`, `mails`,
 * `ui`) sans les dupliquer : sélection d'option par texte PARTIEL (libellés composés « n° — objet —
 * date »), attente des appels API d'un écran, et préparation par API des états « archivé » /
 * « déchargé » dont plusieurs écrans ont besoin.
 *
 * Hypothèses à vérifier en phase B :
 *  - le proxy Next expose l'API sous `/api/...` (même hypothèse que les specs T1/T2) ;
 *  - `api.raw.post(path, body)` renvoie la réponse Playwright sans lever ;
 *  - le changeur de taille de page AntD (locale fr_FR) affiche « 100 / page ».
 */
import { expect, type Locator, type Page, type Request, type Response } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';
import { pdfUpload } from './files';
import { createArrivee, createDepart, uploadScan, type MailRef } from './mails';
import { openDropdown } from './ui';
import { selectBox } from './workflow-t2';

/** Statuts et sens (packages/types/src/courriers.ts). */
export const MAIL_STATUS = { redaction: 0, redige: 1, decharge: 2, traite: 3, supprime: 4 } as const;
export const MAIL_TYPE = { arrivee: 0, depart: 1, interne: 2 } as const;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** Jour au format API `AAAA-MM-JJ` (UTC : l'API stocke les dates en UTC). */
export function isoDay(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Jour au format de saisie des DatePicker `JJ/MM/AAAA` (heure locale du navigateur). */
export function frDay(d: Date = new Date()): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Ant Design
// ---------------------------------------------------------------------------

/**
 * Bloc `Form.Item` repéré par son libellé. Indispensable quand le Form.Item n'a pas de `name`
 * (zone de dépôt du Départ) : AntD ne pose alors aucun `htmlFor`, et `getByLabel` ne trouve rien.
 */
export function formItem(scope: Page | Locator, label: string | RegExp): Locator {
  // Le localisateur interne de `has` est évalué RELATIVEMENT à chaque bloc : il doit partir de la
  // page, pas d'un localisateur déjà chaîné.
  const page = 'keyboard' in scope ? scope : scope.page();
  return scope
    .locator('.ant-form-item')
    .filter({ has: page.locator('.ant-form-item-label', { hasText: label }) });
}

/**
 * Sélectionne l'option d'un `Select` AntD dont le texte CONTIENT `optionText` (à la différence de
 * `selectOption`, qui exige le titre exact) : les options « Lié au courrier » et « Courrier » de la
 * décharge sont des libellés composés (n°, objet, correspondant, date).
 * `search` : texte tapé pour filtrer (`showSearch`) ; `false` pour un Select non filtrable.
 */
export async function pickOption(
  page: Page,
  combobox: Locator,
  optionText: string | RegExp,
  opts: { search?: string | false } = {},
): Promise<void> {
  // Par le conteneur : une valeur déjà choisie recouvre l'input et intercepterait le clic.
  await selectBox(combobox).click();
  if (opts.search !== false) {
    const typed = opts.search ?? (typeof optionText === 'string' ? optionText : undefined);
    if (typed) await combobox.fill(typed);
  }
  const option = openDropdown(page).locator('.ant-select-item-option').filter({ hasText: optionText });
  await expect(option).toHaveCount(1);
  await option.click();
}

/** Bulle de confirmation (Popconfirm) visible. */
export function popconfirm(page: Page): Locator {
  return page.locator('.ant-popconfirm:not(.ant-popover-hidden)');
}

/** Ligne d'un tableau AntD contenant ce texte (objet du courrier, unique par test). */
export function tableRow(scope: Page | Locator, text: string): Locator {
  return scope.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: text });
}

/** Valeur chiffrée d'une tuile / d'un KPI du tableau de bord (`data-testid` posé sur la colonne). */
export function tdbValue(page: Page, testId: string): Locator {
  return page.getByTestId(testId).locator('.da-mono').first();
}

/**
 * Passe une worklist à 100 lignes : la file Validation est GLOBALE (tous les tests parallèles y
 * déposent leurs courriers validés), le nôtre peut sortir de la 1re page à 25.
 */
export async function showHundredRows(page: Page, apiPath: RegExp): Promise<void> {
  const reloaded = page.waitForResponse((r: Response) => {
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

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------

/** Attend la réponse d'un appel de l'écran (`path` relatif à `/api`, ex. `/courriers/depart`). */
export function waitForApi(
  page: Page,
  path: string | RegExp,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
): Promise<Response> {
  return page.waitForResponse((r: Response) => {
    if (r.request().method() !== method) return false;
    const url = new URL(r.url()).pathname;
    if (!url.startsWith('/api/')) return false;
    const rel = url.slice('/api'.length);
    return typeof path === 'string' ? rel === path : path.test(rel);
  });
}

/**
 * Enregistre tout appel `method path` émis par la page (pour prouver qu'AUCUN envoi n'a eu lieu).
 * Renvoie une fonction de lecture du compteur.
 */
export function countRequests(
  page: Page,
  path: string | RegExp,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST',
): () => number {
  let n = 0;
  page.on('request', (r: Request) => {
    if (r.method() !== method) return;
    const url = new URL(r.url()).pathname;
    if (!url.startsWith('/api/')) return;
    const rel = url.slice('/api'.length);
    if (typeof path === 'string' ? rel === path : path.test(rel)) n += 1;
  });
  return () => n;
}

// ---------------------------------------------------------------------------
// Préparation et lecture par API
// ---------------------------------------------------------------------------

/** Ligne de la recherche §11. */
export interface SearchRow {
  mailId: number;
  title: string;
  nReference: string | null;
  mailType: number;
  status: number;
  date: string | null;
  externalEntity: string | null;
  destinataire: string | null;
}

/** Recherche §11 (archives seulement). */
export async function searchArchives(
  api: ApiClient,
  criteria: Record<string, unknown>,
): Promise<{ total: number; rows: SearchRow[] }> {
  return (await api.post('/courriers/recherche', { pageSize: 200, ...criteria })) as {
    total: number;
    rows: SearchRow[];
  };
}

/** Archive un courrier par l'API (§03.1 : `dateTraited`), comme le bouton « Archiver ». */
export async function archiver(api: ApiClient, mailId: number): Promise<void> {
  await api.post(`/courriers/${mailId}/archiver`, {});
}

/** Intègre une décharge signée par l'API : dépôt du PDF dans la file §07, puis rattachement. */
export async function integrerDecharge(api: ApiClient, mailId: number): Promise<{ scanId: number }> {
  const scan = await uploadScan(api, { name: 'decharge-signee.pdf' });
  await api.post(`/courriers/${mailId}/integration-decharge`, {
    scannedDocumentId: scan.mailScannedDocumentId,
  });
  return { scanId: scan.mailScannedDocumentId };
}

/** Arrivée ARCHIVÉE (visible en Recherche), avec PDF rattaché. */
export async function arriveeArchivee(
  api: ApiClient,
  input: Parameters<typeof createArrivee>[1],
): Promise<MailRef> {
  const scan = await uploadScan(api, { name: 'courrier-arrivee.pdf' });
  const mail = await createArrivee(api, { ...input, scannedDocumentId: scan.mailScannedDocumentId });
  await archiver(api, mail.mailId);
  return mail;
}

/**
 * Départ créé avec PDF par `redacteur` (client d'un acteur portant le menu Départ : l'émetteur d'un
 * départ est son rédacteur, qui doit avoir une identité effective — l'admin n'en a pas forcément).
 */
export async function departAvecPdf(
  redacteur: ApiClient,
  input: Parameters<typeof createDepart>[1],
): Promise<MailRef> {
  const scan = await uploadScan(redacteur, { name: 'courrier-depart.pdf' });
  return createDepart(redacteur, { ...input, scannedDocumentId: scan.mailScannedDocumentId });
}

/** Départ DÉCHARGÉ (donc archivé, visible en Recherche). */
export async function departDecharge(
  redacteur: ApiClient,
  admin: ApiClient,
  input: Parameters<typeof createDepart>[1],
): Promise<MailRef> {
  const depart = await departAvecPdf(redacteur, input);
  await integrerDecharge(admin, depart.mailId);
  return depart;
}

/** Ids des départs en attente de décharge (lookup §13). */
export async function dechargesEnAttente(api: ApiClient): Promise<number[]> {
  const rows = (await api.get('/courriers/decharges-en-attente')) as Array<{ mailId: number }>;
  return rows.map((r) => r.mailId);
}

export interface FileCompteur {
  count: number;
  oldestDays: number | null;
}

export interface DashboardFiles {
  scope: string;
  aControler: FileCompteur;
  parapheur: FileCompteur;
  validationDirection: FileCompteur;
  validationDg: FileCompteur;
  decharge: FileCompteur;
  scans: FileCompteur;
  enCours: FileCompteur;
}

/** Compteurs des files du tableau de bord (vue de l'appelant), éventuellement filtrés. */
export async function dashboardFiles(
  api: ApiClient,
  filtre: Record<string, unknown> = {},
): Promise<DashboardFiles> {
  return (await api.post('/courriers/dashboard/files', filtre)) as DashboardFiles;
}

export interface DashboardSynthese {
  scope: string;
  enregistres: { valeur: number };
  traites: { valeur: number };
  enCours: number;
}

export async function dashboardSynthese(
  api: ApiClient,
  filtre: Record<string, unknown> = {},
): Promise<DashboardSynthese> {
  return (await api.post('/courriers/dashboard/synthese', filtre)) as DashboardSynthese;
}

export interface Agencement {
  scope: 'all' | 'imputed' | 'none';
  parDefaut: boolean;
  widgets: Array<{ id: string; titre: string; x: number; y: number; w: number; h: number }>;
  disponibles: Array<{ id: string; titre: string }>;
  dataKeys: string[];
}

export async function agencement(api: ApiClient): Promise<Agencement> {
  return (await api.get('/courriers/dashboard/layout')) as Agencement;
}

/** Badges de menu de l'appelant. */
export async function badges(
  api: ApiClient,
): Promise<{ controle: number; validation: number; suivi: number; parapheur: number; decharge: number }> {
  return (await api.get('/courriers/badges')) as {
    controle: number;
    validation: number;
    suivi: number;
    parapheur: number;
    decharge: number;
  };
}

/** Messages des 100 dernières notifications de l'appelant. */
export async function notificationMessages(api: ApiClient): Promise<string[]> {
  const res = (await api.get('/notifications?page=1&pageSize=100')) as {
    rows: Array<{ message: string }>;
  };
  return res.rows.map((n) => n.message);
}

/** Ids d'une file (`GET <path>?page=1&pageSize=200`). */
export async function fileIds(api: ApiClient, path: string): Promise<number[]> {
  const res = (await api.get(`${path}?page=1&pageSize=200`)) as { rows: Array<{ mailId: number }> };
  return res.rows.map((r) => r.mailId);
}

/** PDF prêt pour `setInputFiles` (forme Playwright). */
export const pdf = (name: string, text?: string) => pdfUpload(name, text);

/** Fichier non PDF, pour vérifier le refus des zones de dépôt. */
export function textFile(name = 'note.txt'): { name: string; mimeType: string; buffer: Buffer } {
  return { name, mimeType: 'text/plain', buffer: Buffer.from('pas un PDF') };
}
