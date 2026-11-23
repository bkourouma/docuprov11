/**
 * Aides « documents archivés » pour la recherche, l'export et les accès (tâche T2, lot 2).
 *
 * VOIE DE CRÉATION RETENUE — sans worker, sans OCR, en trois appels REST administrateur :
 *  1. `POST /spaces` : un espace GED privé (mis en cache par client, un seul par test) ;
 *  2. `POST /collab/documents` : un document texte (version 1 et ses deux pièces `.ydoc`/`.html`
 *     écrites par l'API elle-même, aucune file d'attente) ;
 *  3. `PATCH /documents/:id/indexation` avec `validate: true` : classement (type, plan, dossier,
 *     date) et bascule `is_archived = true` — la recherche ne porte QUE sur l'archive validée
 *     (`SearchService.buildWhere`).
 * Puis, si demandé, `PUT /documents/:id/confidentialite`.
 *
 * Ce qu'elle ne sait PAS produire : une cote (`cote`, posée uniquement par le worker depuis le QR —
 * l'indexation la refuse depuis qu'aucun écran ne la saisit) et un texte OCR (`document_file.
 * ocr_text`). Les scénarios qui en dépendent passent par un lot d'acquisition (aides de T1).
 *
 * Le document est créé par l'ADMINISTRATEUR : son créateur n'est donc jamais l'utilisateur
 * restreint d'un test, et le passe-droit du créateur (`canAccess`) ne fausse aucune assertion.
 */
import { expect, type APIResponse, type Page, type Response } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';

/** Niveaux de `permission_level` (cf. `DocumentsService` : 1 Denied, 2 Consultation … 5 Archivistique). */
export const NIVEAU = {
  consultation: 2,
  modification: 3,
  administration: 4,
  archivistique: 5,
} as const;

/** Le client renvoie le JSON sans type : on le nomme à l'endroit où on le lit. */
async function json<T>(p: Promise<unknown>): Promise<T> {
  return (await p) as T;
}

// ---------------------------------------------------------------------------
// Référentiels
// ---------------------------------------------------------------------------

export async function creerTypeDocument(api: ApiClient, label: string): Promise<number> {
  const row = await json<{ documentTypeId: number }>(
    api.post('/referentials/document-types', { label }),
  );
  return row.documentTypeId;
}

export async function creerDossier(api: ApiClient, label: string): Promise<number> {
  const row = await json<{ dossierId: number }>(api.post('/referentials/dossiers', { label }));
  return row.dossierId;
}

export async function creerPlan(api: ApiClient, label: string): Promise<number> {
  const row = await json<{ planId: number }>(api.post('/referentials/plans', { label }));
  return row.planId;
}

export interface Confidentialite {
  confidentialiteId: number;
  label: string;
  rank: number;
}

/**
 * Crée un niveau de confidentialité. Le rang est attribué par l'API (+10 au-dessus du plus haut) :
 * deux niveaux créés L'UN APRÈS L'AUTRE dans un même test sont donc strictement ordonnés.
 */
export async function creerConfidentialite(
  api: ApiClient,
  label: string,
): Promise<Confidentialite> {
  return json<Confidentialite>(api.post('/referentials/confidentialites', { label }));
}

export interface TypeFichier {
  fileTypeId: number;
  extension: string;
  friendlyName: string;
}

/** Type de fichier par extension (ex. `.html`), tel que listé dans le filtre « Type de fichier ». */
export async function typeFichier(api: ApiClient, extension: string): Promise<TypeFichier> {
  const rows = await json<TypeFichier[]>(api.get('/referentials/file-types'));
  const found = rows.find((r) => r.extension === extension);
  if (!found)
    throw new Error(`Type de fichier ${extension} introuvable dans /referentials/file-types`);
  return found;
}

// ---------------------------------------------------------------------------
// Documents archivés
// ---------------------------------------------------------------------------

export interface OptionsDocument {
  label: string;
  documentTypeId?: number;
  dossierId?: number;
  planId?: number;
  /** Date métier du document, AAAA-MM-JJ (filtre « Date du document »). */
  documentDate?: string;
  /** Niveau de confidentialité exigé (`null`/absent : aucun). */
  confidentialiteId?: number;
}

export interface DocumentArchive {
  documentId: number;
  label: string;
}

/** Un espace privé par client : `WeakMap` pour ne rien retenir d'un test à l'autre. */
const espaces = new WeakMap<ApiClient, Promise<number>>();

function espaceDe(api: ApiClient): Promise<number> {
  let espace = espaces.get(api);
  if (!espace) {
    espace = json<{ gedSpaceId: number }>(
      api.post('/spaces', {
        label: `E2E recherche ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        kind: 0, // Privé
      }),
    ).then((s) => s.gedSpaceId);
    // Un échec ne doit pas empoisonner les appels suivants du même test.
    espace.catch(() => espaces.delete(api));
    espaces.set(api, espace);
  }
  return espace;
}

/** Crée un document ARCHIVÉ (validé), donc trouvable par `POST /documents/search`. */
export async function creerDocumentArchive(
  api: ApiClient,
  opts: OptionsDocument,
): Promise<DocumentArchive> {
  const spaceId = await espaceDe(api);
  const created = await json<{ documentId: number }>(
    api.post('/collab/documents', { spaceId, label: opts.label }),
  );
  const documentId = created.documentId;

  await api.patch(`/documents/${documentId}/indexation`, {
    ...(opts.documentTypeId !== undefined ? { documentTypeId: opts.documentTypeId } : {}),
    ...(opts.dossierId !== undefined ? { dossierId: opts.dossierId } : {}),
    ...(opts.planId !== undefined ? { planId: opts.planId } : {}),
    ...(opts.documentDate !== undefined ? { documentDate: opts.documentDate } : {}),
    validate: true,
  });

  if (opts.confidentialiteId !== undefined) {
    await api.put(`/documents/${documentId}/confidentialite`, {
      confidentialiteId: opts.confidentialiteId,
    });
  }
  return { documentId, label: opts.label };
}

// ---------------------------------------------------------------------------
// Habilitations et droits
// ---------------------------------------------------------------------------

/**
 * Habilitation de confidentialité d'un utilisateur (écran « Confidentialité des utilisateurs »),
 * posée ici plutôt que par l'option `confidentialite` de `creerUtilisateurAvecMenus` : la route
 * est sans ambiguïté (identifiant de niveau, pas rang) et `null` retire l'habilitation.
 */
export async function habiliter(
  api: ApiClient,
  userId: number,
  confidentialiteId: number | null,
): Promise<void> {
  await api.patch('/users/confidentialite', { userIds: [userId], confidentialiteId });
}

/** Client d'un autre utilisateur, quelle que soit la forme (synchrone ou non) de `apiAs`. */
export type ApiAs = (username: string, password: string) => ApiClient | Promise<ApiClient>;

/**
 * Compte-groupe par défaut (`app_user_group`) de l'utilisateur, bénéficiaire d'un droit
 * nominatif. Un compte créé sans profil n'en a pas : on lui en crée un, puis on relit son
 * identité par une NOUVELLE connexion (le jeton porte le compte-groupe par défaut).
 */
export async function compteGroupeDe(
  api: ApiClient,
  apiAs: ApiAs,
  user: { username: string; password: string; userId: number },
): Promise<number> {
  const lire = async () =>
    (
      await json<{ userGroupId?: number | null }>(
        (await apiAs(user.username, user.password)).get('/auth/me'),
      )
    ).userGroupId ?? null;

  const existant = await lire();
  if (existant != null) return existant;

  const groupe = await json<{ groupId: number }>(
    api.post('/users/groups/all', { name: `E2E profil ${user.username}` }),
  );
  await api.post(`/users/${user.userId}/groups`, { groupId: groupe.groupId, isDefault: true });
  const cree = await lire();
  if (cree == null) throw new Error(`Aucun compte-groupe pour ${user.username} après affectation`);
  return cree;
}

/**
 * Droit nominatif sur UN document (onglet « Accès par utilisateur »). Dès qu'un droit en vigueur
 * existe sur un document, celui-ci devient RESTREINT : seuls ses bénéficiaires (et le créateur,
 * et l'administrateur) le voient — c'est le « refus par défaut » tel qu'il est appliqué.
 * Un droit nominatif lève aussi l'exigence de confidentialité (`hasOwnDocumentGrant`).
 */
export async function accorderDroitDocument(
  api: ApiClient,
  documentId: number,
  userGroupId: number,
  niveau: number = NIVEAU.consultation,
): Promise<void> {
  await api.post(`/documents/${documentId}/permissions`, {
    userGroupId,
    permissionLevelId: niveau,
  });
}

// ---------------------------------------------------------------------------
// Recherche et export par l'API
// ---------------------------------------------------------------------------

export interface LigneRecherche {
  documentId: number;
  label: string;
  documentType: string | null;
  cote: string | null;
  documentDate: string | null;
  createdAt: string;
  dossier: string | null;
  plan: string | null;
  location: string | null;
}

export interface ResultatRecherche {
  total: number;
  page: number;
  pageSize: number;
  rows: LigneRecherche[];
}

export interface Criteres {
  fullText?: string;
  documentTypeId?: number;
  dossierId?: number;
  planId?: number;
  locationId?: number;
  fileTypeId?: number;
  createdByUserId?: number;
  documentDateFrom?: string;
  documentDateTo?: string;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  page?: number;
  pageSize?: number;
}

export function rechercher(client: ApiClient, criteres: Criteres): Promise<ResultatRecherche> {
  return json<ResultatRecherche>(client.post('/documents/search', criteres));
}

export type FormatExport = 'xlsx' | 'csv' | 'pdf' | 'docx';

/** Export brut (le client « JSON » ne sait pas lire un binaire) : la réponse HTTP telle quelle. */
export function exporterBrut(
  client: ApiClient,
  criteres: Criteres & { format: FormatExport },
): Promise<APIResponse> {
  return client.raw.post('/documents/export', criteres);
}

/** Lignes d'un export CSV (fast-csv : séparateur `,`, guillemets seulement si nécessaire). */
export function lignesCsv(contenu: string): string[][] {
  const lignes: string[][] = [];
  let champ = '';
  let ligne: string[] = [];
  let guillemets = false;
  const texte = contenu.charCodeAt(0) === 0xfeff ? contenu.slice(1) : contenu;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charAt(i);
    if (guillemets) {
      if (c === '"' && texte.charAt(i + 1) === '"') {
        champ += '"';
        i++;
      } else if (c === '"') {
        guillemets = false;
      } else {
        champ += c;
      }
    } else if (c === '"') {
      guillemets = true;
    } else if (c === ',') {
      ligne.push(champ);
      champ = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texte.charAt(i + 1) === '\n') i++;
      ligne.push(champ);
      lignes.push(ligne);
      ligne = [];
      champ = '';
    } else {
      champ += c;
    }
  }
  if (champ !== '' || ligne.length > 0) {
    ligne.push(champ);
    lignes.push(ligne);
  }
  return lignes;
}

/** En-têtes des exports de la grille (`EXPORT_COLUMNS` de `documents.controller.ts`), dans l'ordre. */
export const EN_TETES_EXPORT = [
  'Libellé',
  'Type de document',
  'N° pièce',
  'Date document',
  'Dossier',
  'Plan de classement',
  'Localisation',
] as const;

// ---------------------------------------------------------------------------
// Écran /search
// ---------------------------------------------------------------------------

/** Corps JSON envoyé par l'écran à `POST /documents/search` ou `/documents/export`. */
export type CorpsEnvoye = Record<string, unknown>;

function corpsDe(r: Response): CorpsEnvoye | null {
  try {
    return (r.request().postDataJSON() as CorpsEnvoye | null) ?? null;
  } catch {
    return null;
  }
}

/** Attend la réponse à une recherche de l'écran, éventuellement filtrée sur son corps. */
export function attendreRecherche(
  page: Page,
  critere?: (corps: CorpsEnvoye) => boolean,
): Promise<Response> {
  return page.waitForResponse((r) => {
    if (!r.url().endsWith('/documents/search') || r.request().method() !== 'POST') return false;
    if (!critere) return true;
    const corps = corpsDe(r);
    return corps != null && critere(corps);
  });
}

/** Attend la réponse à un export de l'écran. */
export function attendreExport(page: Page): Promise<Response> {
  return page.waitForResponse(
    (r) => r.url().endsWith('/documents/export') && r.request().method() === 'POST',
  );
}

/** Ouvre `/search` et attend la première recherche (sans critère) qu'il lance au chargement. */
export async function ouvrirRecherche(page: Page): Promise<void> {
  const premiere = attendreRecherche(page);
  await page.goto('/search');
  expect((await premiere).status()).toBe(200);
}

/** Saisit un texte dans la barre plein texte et lance la recherche (bouton « Rechercher »). */
export async function rechercherTexte(page: Page, texte: string): Promise<void> {
  await page.getByLabel('Recherche plein texte').fill(texte);
  const reponse = attendreRecherche(page, (c) => c.fullText === texte);
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  expect((await reponse).status()).toBe(200);
}

/** Lignes de résultat dont le texte contient `texte` (la ligne d'en-tête n'en contient jamais). */
export function lignesResultat(page: Page, texte: string) {
  return page.getByRole('row').filter({ hasText: texte });
}

/**
 * Choisit une valeur dans un Select / TreeSelect AntD des filtres avancés, par le libellé du champ.
 * La liste déroulante est rendue dans un portail : on la vise par son option (`title` = libellé,
 * posé par rc-select sur les options et par rc-tree sur les nœuds), dans la liste ouverte.
 */
export async function choisirFiltre(page: Page, champ: string, valeur: string): Promise<void> {
  const combo = page.getByRole('combobox', { name: champ, exact: true });
  await combo.click();
  await combo.fill(valeur);
  await page.locator('.ant-select-dropdown:visible').getByTitle(valeur, { exact: true }).click();
}

/** Saisit la plage « Date du document » (format d'affichage JJ/MM/AAAA). */
export async function saisirPlageDates(page: Page, du: string, au: string): Promise<void> {
  const debut = page.getByPlaceholder('Du', { exact: true });
  await debut.click();
  await debut.fill(du);
  await debut.press('Enter');
  const fin = page.getByPlaceholder('Au', { exact: true });
  await fin.fill(au);
  await fin.press('Enter');
}
