/**
 * Lots d'acquisition : référentiels de test, création d'un lot et dépôt de ses fichiers par l'API,
 * attente du worker BullMQ, lecture des documents produits, et gestes d'écran partagés.
 *
 * Contrat API (apps/api/src/modules/acquisition) :
 *  - POST /batches → { batchId, batchGuid, dossierId, status, scanDate } ;
 *  - POST /batches/:id/files?finalize=<bool> (multipart, champ `files`), envois successifs ;
 *  - GET /batches/:id → statut 0 en cours, 1 traité, 2 échec ;
 *  - GET /batches/:id/documents ; POST /batches/:id/reprocess.
 */
import { readFile } from 'node:fs/promises';
import type { Locator, Page, Response } from '@playwright/test';
import { expect, type ApiClient } from '../../../fixtures';
import type { FichierTest } from './lot-pdf';

export const STATUT_LOT = { enCours: 0, traite: 1, echec: 2 } as const;

/** Délai d'attente du worker (rendu des pages + décodage QR) : large, la pile E2E est partagée. */
export const DELAI_WORKER = 120_000;

export interface LotCree {
  batchId: number;
  batchGuid: string;
  dossierId: number | null;
  status: number;
  scanDate: string;
}

export interface StatutLot {
  batchId: number;
  status: number;
  fileCount: number;
  documentCount: number;
  processedFiles: number;
  useIntercalaires: boolean;
}

export interface DocumentDuLot {
  documentId: number;
  label: string;
  cote: string | null;
  documentTypeId: number | null;
  planId: number | null;
  dossierId: number | null;
  confidentialiteId: number | null;
  documentDate: string | null;
  isArchived: boolean;
  file: { fileId: number; fileExtension: string; pageCount: number | null } | null;
}

export interface CorpsLot {
  dossierId?: number;
  newDossier?: { label: string; parentId?: number };
  documentTypeId?: number;
  planId?: number;
  confidentialiteId?: number;
  sourceLabel?: string;
  useIntercalaires?: boolean;
}

/** Lecture typée d'une réponse JSON du client `api` (le contrat des fixtures renvoie le JSON). */
async function json<T>(appel: Promise<unknown>): Promise<T> {
  return (await appel) as T;
}

// ---------------------------------------------------------------------------
// Référentiels
// ---------------------------------------------------------------------------

export interface Element {
  id: number;
  label: string;
}

export async function creerTypeDocument(api: ApiClient, label: string): Promise<Element> {
  const r = await json<{ documentTypeId: number }>(
    api.post('/referentials/document-types', { label }),
  );
  return { id: r.documentTypeId, label };
}

export async function creerDossier(
  api: ApiClient,
  label: string,
  parentId?: number,
): Promise<Element> {
  const r = await json<{ dossierId: number }>(
    api.post('/referentials/dossiers', parentId != null ? { label, parentId } : { label }),
  );
  return { id: r.dossierId, label };
}

export async function creerPlan(api: ApiClient, label: string): Promise<Element> {
  const r = await json<{ planId: number }>(api.post('/referentials/plans', { label }));
  return { id: r.planId, label };
}

export async function creerLocalisation(
  api: ApiClient,
  label: string,
  code: string,
): Promise<Element> {
  const r = await json<{ locationId: number }>(
    api.post('/referentials/locations', { label, code }),
  );
  return { id: r.locationId, label };
}

/**
 * Paramétrage d'un type : dossier et plan par défaut. L'écran d'acquisition les préremplit dès
 * que ce type est choisi — c'est ce qui permet de passer l'étape « Destination ».
 */
export async function parametrerType(
  api: ApiClient,
  documentTypeId: number,
  defauts: { dossierId: number; planId: number },
): Promise<void> {
  await api.put('/archives/settings/document-types', { documentTypeId, ...defauts });
}

/** Type de document paramétré (dossier + plan par défaut), prêt pour l'écran d'acquisition. */
export async function creerTypeParametre(
  api: ApiClient,
  prefixe: string,
): Promise<{ type: Element; dossier: Element; plan: Element }> {
  const type = await creerTypeDocument(api, `${prefixe} type`);
  const dossier = await creerDossier(api, `${prefixe} dossier`);
  const plan = await creerPlan(api, `${prefixe} plan`);
  await parametrerType(api, type.id, { dossierId: dossier.id, planId: plan.id });
  return { type, dossier, plan };
}

// ---------------------------------------------------------------------------
// Lots par l'API
// ---------------------------------------------------------------------------

export function creerLot(api: ApiClient, corps: CorpsLot): Promise<LotCree> {
  return json<LotCree>(api.post('/batches', corps));
}

/**
 * Dépose les fichiers UN par envoi, comme l'écran le fait par paquets : seul le dernier envoi
 * (`finalize=true`) met le traitement en file.
 */
export async function deposerFichiers(
  api: ApiClient,
  batchId: number,
  fichiers: FichierTest[],
): Promise<void> {
  for (let i = 0; i < fichiers.length; i += 1) {
    const finalize = i === fichiers.length - 1;
    await api.upload(`/batches/${batchId}/files?finalize=${finalize}`, {
      field: 'files',
      file: fichiers[i]!,
    });
  }
}

export function statutDuLot(api: ApiClient, batchId: number): Promise<StatutLot> {
  return json<StatutLot>(api.get(`/batches/${batchId}`));
}

export function documentsDuLot(api: ApiClient, batchId: number): Promise<DocumentDuLot[]> {
  return json<DocumentDuLot[]>(api.get(`/batches/${batchId}/documents`));
}

/** Attend la fin du traitement par le worker (statut ≠ 0) et renvoie le statut final. */
export async function attendreFinDuTraitement(
  api: ApiClient,
  batchId: number,
  delai = DELAI_WORKER,
): Promise<StatutLot> {
  await expect
    .poll(async () => (await statutDuLot(api, batchId)).status, {
      message: `fin du traitement du lot ${batchId} par le worker`,
      timeout: delai,
      intervals: [500, 1_000, 2_000],
    })
    .not.toBe(STATUT_LOT.enCours);
  return statutDuLot(api, batchId);
}

/** Crée un lot, dépose ses fichiers et attend le worker. */
export async function acquerirParApi(
  api: ApiClient,
  corps: CorpsLot,
  fichiers: FichierTest[],
): Promise<{ lot: LotCree; statut: StatutLot; documents: DocumentDuLot[] }> {
  const lot = await creerLot(api, corps);
  await deposerFichiers(api, lot.batchId, fichiers);
  const statut = await attendreFinDuTraitement(api, lot.batchId);
  return { lot, statut, documents: await documentsDuLot(api, lot.batchId) };
}

/** Validation qualité (archivage) — sans elle, un document n'apparaît pas dans la recherche. */
export async function validerDocuments(api: ApiClient, documentIds: number[]): Promise<void> {
  for (const id of documentIds) {
    await api.patch(`/documents/${id}/indexation`, { validate: true });
  }
}

export interface LigneRecherche {
  documentId: number;
  label: string;
  documentType: string | null;
  dossier: string | null;
  plan: string | null;
  location: string | null;
}

export async function rechercher(
  api: ApiClient,
  criteres: Record<string, unknown>,
): Promise<{ total: number; rows: LigneRecherche[] }> {
  return json<{ total: number; rows: LigneRecherche[] }>(
    api.post('/documents/search', { pageSize: 50, ...criteres }),
  );
}

/** Libellé posé par le worker à un document découpé (`ingestion.ts`, `buildLabel`). */
export function libelleDocument(batchId: number, rang: number, sansType = false): string {
  return `Lot ${batchId} – document ${rang}${sansType ? ' (sans type)' : ''}`;
}

// ---------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------

/**
 * Mot unique, en lettres minuscules seulement, pour la recherche plein texte : la configuration
 * `french` de PostgreSQL découpe sur les tirets et les chiffres, et racinise les fins de mot. Les
 * chiffres de la graine (issue de `uniq()`) deviennent des lettres ; le `q` final ne se racinise pas.
 */
export function motUnique(graine: string): string {
  const lettres = graine
    .toLowerCase()
    .replace(/[0-9]/g, (c) => String.fromCharCode(103 + Number(c))) // 0→g … 9→p
    .replace(/[^a-z]/g, '');
  return `mot${lettres}q`;
}

/** Date civile UTC `AAAA-MM-JJ`, décalée de `jours`. */
export function dateIso(jours = 0): string {
  return new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10);
}

export function echapperRegex(texte: string): string {
  return texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Gestes d'écran partagés
// ---------------------------------------------------------------------------

/**
 * Choisit une option d'un Select Ant Design à recherche : saisie du libellé, puis clic sur
 * l'option filtrée (les options AntD portent leur libellé en `title`, dans un portail). Le contrôle
 * final vise la valeur affichée par un Select (`.ant-select-selection-item`) : `select` peut être
 * repéré par son invite, qui disparaît justement une fois la valeur choisie.
 */
export function choisirOption(page: Page, select: Locator, libelle: string): Promise<void> {
  return choisirDansListe(page, select.getByRole('combobox'), libelle);
}

/** Même geste, à partir du champ `combobox` lui-même (Select nommé par un libellé `<label for>`). */
export async function choisirDansListe(page: Page, champ: Locator, libelle: string): Promise<void> {
  await champ.click();
  await champ.fill(libelle);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .getByTitle(libelle, { exact: true })
    .click();
  await expect(page.locator('.ant-select-selection-item', { hasText: libelle })).toBeVisible();
}

/**
 * Select AntD repéré par son texte d'invite (aucun libellé n'y est associé dans les écrans). À
 * n'utiliser qu'AVANT le choix : l'invite disparaît dès qu'une valeur est sélectionnée.
 */
export function selectParInvite(page: Page, invite: string | RegExp): Locator {
  return page.locator('.ant-select').filter({ hasText: invite });
}

export function estCreationDeLot(r: Response): boolean {
  return r.request().method() === 'POST' && /\/api\/batches$/.test(new URL(r.url()).pathname);
}

/**
 * Écran « Acquisition par lot », de l'étape Destination au lancement : choix du type (paramétré,
 * donc dossier et plan préremplis), dépôt des fichiers, « Lancer le traitement ». Renvoie la
 * réponse de création du lot (201 attendu, 403 pour un compte sans le menu).
 */
export async function lancerAcquisitionParEcran(
  page: Page,
  typeLabel: string,
  fichiers: FichierTest[],
): Promise<Response> {
  await page.goto('/acquisition');
  await expect(page.getByRole('heading', { name: 'Acquisition par lot' })).toBeVisible();
  await choisirOption(
    page,
    selectParInvite(page, 'Sélectionnez le type de document du lot'),
    typeLabel,
  );
  // Le dossier et le plan arrivent du paramétrage du type (appel asynchrone) : « Continuer »
  // ne s'active qu'une fois la destination complète.
  const continuer = page.getByRole('button', { name: 'Continuer' });
  await expect(continuer).toBeEnabled();
  await continuer.click();

  await expect(page.getByRole('heading', { name: 'Ajoutez les fichiers scannés' })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(fichiers);
  await expect(page.getByText(`${fichiers.length} fichier(s) sélectionné(s)`)).toBeVisible();

  const creation = page.waitForResponse(estCreationDeLot);
  await page.getByRole('button', { name: 'Lancer le traitement' }).click();
  return creation;
}

/**
 * Le mode « avec intercalaires » (découpage QR + OCR) n'est plus proposé par l'écran depuis le
 * 2026-09-16 : `useIntercalaires` y est figé à `false`, le mode restant pilotable par l'API (cf.
 * commentaire de `apps/web/app/acquisition/page.tsx`). Pour faire traverser à l'écran RÉEL
 * (envoi par paquets, suivi, indexation, validation) un lot découpé par QR, on bascule ce seul
 * drapeau dans la requête de création du lot. Si le sélecteur est rétabli, remplacer cet appel par
 * le clic sur l'option (question métier remontée dans le rapport T1).
 */
export async function activerModeIntercalaires(page: Page): Promise<void> {
  await page.route('**/api/batches', async (route) => {
    const requete = route.request();
    if (requete.method() !== 'POST') return route.continue();
    const corps = (requete.postDataJSON() ?? {}) as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...corps, useIntercalaires: true }) });
  });
}

/** Fenêtre d'indexation ouverte automatiquement à la fin du traitement d'un lot. */
export function fenetreIndexation(page: Page, batchId: number): Locator {
  return page.getByRole('dialog', { name: new RegExp(`^Indexation du lot #${batchId} —`) });
}

/** Valide le lot depuis la fenêtre d'indexation, confirmation comprise. */
export async function validerDepuisIndexation(page: Page, nombre: number): Promise<void> {
  const seul = nombre === 1;
  await page
    .getByRole('button', { name: seul ? 'Valider le document' : 'Valider tout le lot' })
    .click();
  const confirmation = page.getByRole('dialog').filter({
    hasText: seul ? 'Le document sera archivé. Continuer ?' : 'Tous les documents seront archivés',
  });
  await confirmation
    .getByRole('button', { name: seul ? 'Valider le document' : 'Valider le lot' })
    .click();
  await expect(page.getByText('Acquisition finalisée — prêt pour un nouveau lot.')).toBeVisible();
}

export interface GenerationEcran {
  /** PDF renvoyé par l'API à l'écran (celui que l'écran ouvre pour impression). */
  pdf: Buffer;
  /** Corps envoyé par l'écran : catégorie active et éléments cochés, dans l'ordre d'envoi. */
  corps: { category: string; itemIds: number[] };
}

/**
 * Écran « Intercalaires » : clic sur « Générer le PDF ». L'écran récupère le PDF par `fetch` puis
 * l'ouvre dans un nouvel onglet (`window.open` d'une URL `blob:`) : aucun événement de
 * téléchargement, on contrôle donc la réponse elle-même et l'ouverture de l'onglet.
 */
export async function genererIntercalairesParEcran(page: Page): Promise<GenerationEcran> {
  const reponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname.endsWith('/api/intercalaires/generate'),
  );
  const onglet = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Générer le PDF' }).click();
  const r = await reponse;
  expect(r.status(), await r.text().catch(() => '')).toBe(200);
  expect(r.headers()['content-type']).toContain('application/pdf');
  await (await onglet).close();
  return {
    pdf: Buffer.from(await r.body()),
    corps: r.request().postDataJSON() as GenerationEcran['corps'],
  };
}

/** Contenu d'un téléchargement déclenché par `declencher`. */
export async function telecharger(
  page: Page,
  declencher: () => Promise<void>,
): Promise<{ nom: string; contenu: Buffer }> {
  const attente = page.waitForEvent('download');
  await declencher();
  const dl = await attente;
  const chemin = await dl.path();
  if (!chemin) throw new Error(`Téléchargement ${dl.suggestedFilename()} sans fichier local`);
  return { nom: dl.suggestedFilename(), contenu: await readFile(chemin) };
}
