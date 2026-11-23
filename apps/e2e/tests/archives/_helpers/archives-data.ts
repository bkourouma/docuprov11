/**
 * Données des écrans opérationnels Docu-Archives (tâche T3, lot 2) : prêts / communications,
 * DUA échues et épuration, intégrité du fonds.
 *
 * Tout passe par l'API administrateur, sans worker ni OCR :
 *  - un document « prêtable » = un document archivé (voie de `documents.ts` : espace GED privé,
 *    document collaboratif, indexation validée) rangé dans un DOSSIER propre au test — l'écran
 *    « Communiquer » liste les documents par dossier ;
 *  - une DUA échue = un cycle de vie PROPRE au document (dates), qui l'emporte sur la règle de son
 *    type (`ArchivesComplianceService`). Route `PUT /documents/:id/life-cycle` (onglet « Cycle de
 *    vie » de la fiche, niveau Archivistique — l'administrateur l'a), la même qu'ARC-01 ;
 *  - un motif de prêt = `POST /archives/settings/lending-motives` (création en masse), relu par la
 *    liste pour obtenir son identifiant.
 */
import { expect, type Page, type Response } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';
import { creerDocumentArchive, creerDossier, type DocumentArchive } from './documents';

/** Le client renvoie le JSON sans type : on le nomme à l'endroit où on le lit. */
async function json<T>(p: Promise<unknown>): Promise<T> {
  return (await p) as T;
}

/** Date civile UTC `AAAA-MM-JJ`, décalée de `jours` (même définition que `lots.ts`). */
export function jourIso(jours = 0): string {
  return new Date(Date.now() + jours * 86_400_000).toISOString().slice(0, 10);
}

/** `AAAA-MM-JJ` → `JJ/MM/AAAA`, format de saisie et d'affichage des écrans. */
export function jourFr(iso: string): string {
  const [a, m, j] = iso.split('-');
  return `${j}/${m}/${a}`;
}

/**
 * Date LOCALE du navigateur décalée de `jours`, en `AAAA-MM-JJ` : l'écran « Communiquer » raisonne
 * en dayjs local (date de début ≤ aujourd'hui), pas en UTC. Le navigateur de test tourne sur la
 * même machine que le lanceur, donc le fuseau de Node est le sien.
 */
export function jourLocal(jours = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + jours);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const enc = (texte: string) => encodeURIComponent(texte);

/** Clés de menu des écrans opérationnels (miroir de `ARCHIVES_MENUS`, apps/api). */
export const MENUS = {
  duaExpirees: '/archives/dua-expirees',
  epures: '/archives/documents-epures',
  communiquer: '/archives/communiquer',
  communiques: '/archives/documents-communiques',
  mesCommuniques: '/archives/mes-documents-communiques',
  historique: '/archives/historique-communications',
  integrite: '/archives/integrite',
  /** Menu sans rapport avec ces écrans : un compte qui n'a que lui n'a aucun des sept. */
  autre: '/search',
} as const;

// ---------------------------------------------------------------------------
// Référentiels et documents
// ---------------------------------------------------------------------------

export interface MotifPret {
  lendingMotiveId: number;
  label: string;
}

export async function creerMotifPret(api: ApiClient, label: string): Promise<MotifPret> {
  await api.post('/archives/settings/lending-motives', { labels: [label] });
  const motifs = await json<MotifPret[]>(api.get('/archives/settings/lending-motives'));
  const motif = motifs.find((m) => m.label === label);
  if (!motif) throw new Error(`Motif de prêt « ${label} » absent de la liste après création`);
  return motif;
}

/** Dossier propre au test et `n` documents archivés dedans, libellés `${prefixe} doc 1…n`. */
export async function dossierAvecDocuments(
  api: ApiClient,
  prefixe: string,
  n = 1,
): Promise<{ dossierId: number; dossierLabel: string; documents: DocumentArchive[] }> {
  const dossierLabel = `${prefixe} dossier`;
  const dossierId = await creerDossier(api, dossierLabel);
  const documents: DocumentArchive[] = [];
  for (let i = 1; i <= n; i += 1) {
    documents.push(await creerDocumentArchive(api, { label: `${prefixe} doc ${i}`, dossierId }));
  }
  return { dossierId, dossierLabel, documents };
}

// ---------------------------------------------------------------------------
// Acteurs (bénéficiaires)
// ---------------------------------------------------------------------------

export interface Acteur {
  userGroupId: number;
  /** Libellé serveur « Nom — Groupe ». */
  label: string;
  /** Ce que l'écran « Communiquer » affiche : le nom seul (`label.split(' — ')[0]`). */
  nom: string;
}

/**
 * L'acteur `userGroupId` tel que l'écran le propose. Vérifie que son nom affiché est UNIQUE parmi
 * les acteurs : l'écran ne montre que le nom, deux homonymes y seraient indiscernables.
 */
export async function acteur(api: ApiClient, userGroupId: number): Promise<Acteur> {
  const tous = await json<Array<{ userGroupId: number; label: string }>>(
    api.get('/courriers/actors'),
  );
  const nomDe = (label: string) => label.split(' — ')[0]?.trim() || label;
  const trouve = tous.find((a) => a.userGroupId === userGroupId);
  if (!trouve) throw new Error(`Acteur ${userGroupId} absent de /courriers/actors`);
  const nom = nomDe(trouve.label);
  expect(
    tous.filter((a) => nomDe(a.label) === nom).length,
    `nom d'acteur « ${nom} » unique dans la liste des bénéficiaires`,
  ).toBe(1);
  return { userGroupId, label: trouve.label, nom };
}

// ---------------------------------------------------------------------------
// Prêts
// ---------------------------------------------------------------------------

export interface PretCree {
  lendingDocumentId: number;
  details: Array<{
    lendingDocumentDetailId: number;
    documentId: number;
    returnedDate: string | null;
  }>;
}

export interface CorpsPret {
  documentIds: number[];
  userGroupId: number;
  lendingMotiveId: number;
  startDate?: string;
  projectedReturnDate?: string;
}

export function corpsPret(c: CorpsPret): Required<CorpsPret> {
  return { startDate: jourIso(0), projectedReturnDate: jourIso(7), ...c };
}

export function creerPret(client: ApiClient, c: CorpsPret): Promise<PretCree> {
  return json<PretCree>(client.post('/archives/lendings', corpsPret(c)));
}

export interface LignePret {
  lendingDocumentId: number;
  lendingDocumentDetailId: number;
  documentId: number;
  documentLabel: string;
  fullName: string;
  lendingMotiveName: string | null;
  startDate: string;
  projectedReturnDate: string | null;
  returnedDate: string | null;
  isOverdue: boolean;
}

export type PorteePret = 'out' | 'mine' | 'history';

export async function pretsListes(
  client: ApiClient,
  portee: PorteePret,
  recherche: string,
): Promise<LignePret[]> {
  const r = await json<{ rows: LignePret[] }>(
    client.get(`/archives/lendings/${portee}?search=${enc(recherche)}&pageSize=200`),
  );
  return r.rows;
}

export function documentsCommunicables(
  client: ApiClient,
  dossierId: number,
): Promise<Array<{ documentId: number; label: string }>> {
  return json(client.get(`/archives/lendings/dossiers/${dossierId}/documents`));
}

export function rendre(client: ApiClient, lendingDocumentDetailId: number) {
  return json<{ lendingClosed: boolean; returnedDate: string }>(
    client.post(`/archives/lendings/details/${lendingDocumentDetailId}/return`, {}),
  );
}

// ---------------------------------------------------------------------------
// DUA et épuration
// ---------------------------------------------------------------------------

/**
 * Cycle de vie propre au document : DUA au jour `duaDans` (négatif = échue), conformité un an
 * plus tard (le service refuse une conformité antérieure à la DUA).
 */
export async function poserDua(api: ApiClient, documentId: number, duaDans: number): Promise<void> {
  await api.put(`/documents/${documentId}/life-cycle`, {
    usefulnessLifespan: jourIso(duaDans),
    complianceLifespan: jourIso(duaDans + 365),
  });
}

export interface LigneConformite {
  documentId: number;
  label: string;
  usefulnessLifespan: string | null;
  documentState: number;
}

export async function echus(
  client: ApiClient,
  recherche: string,
  monthsAhead = 0,
): Promise<LigneConformite[]> {
  const r = await json<{ rows: LigneConformite[] }>(
    client.get(
      `/archives/dua-expired?search=${enc(recherche)}&monthsAhead=${monthsAhead}&pageSize=200`,
    ),
  );
  return r.rows;
}

export async function epures(client: ApiClient, recherche: string): Promise<LigneConformite[]> {
  const r = await json<{ rows: LigneConformite[] }>(
    client.get(`/archives/purged?search=${enc(recherche)}&pageSize=200`),
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Gestes d'écran
// ---------------------------------------------------------------------------

/** Message du `MenuPermissionGuard`, relayé tel quel par `apiJson` dans un toast d'erreur. */
export const REFUS_MENU = "Vous n'avez pas accès à cette section.";

/** Réponse GET d'une liste de l'écran, filtrée sur son chemin et, si donné, sa recherche. */
export function attendreListe(page: Page, chemin: string, recherche?: string): Promise<Response> {
  return page.waitForResponse((r) => {
    if (r.request().method() !== 'GET') return false;
    const url = new URL(r.url());
    if (!url.pathname.endsWith(`/api${chemin}`)) return false;
    return recherche === undefined || url.searchParams.get('search') === recherche;
  });
}

/**
 * Saisit `texte` dans la recherche d'une liste (Input.Search AntD, repéré par son invite) et attend
 * la réponse filtrée du serveur.
 */
export async function rechercherDansListe(
  page: Page,
  invite: string,
  chemin: string,
  texte: string,
): Promise<void> {
  const reponse = attendreListe(page, chemin, texte);
  const champ = page.getByPlaceholder(invite);
  await champ.fill(texte);
  await champ.press('Enter');
  expect((await reponse).status()).toBe(200);
}

export const INVITE_PRETS = 'Rechercher un document, un bénéficiaire, un motif…';
export const INVITE_CONFORMITE = 'Rechercher un document, un n° de pièce, un type…';

/** Saisit une date (JJ/MM/AAAA) dans un DatePicker AntD repéré par son libellé. */
export async function saisirDate(page: Page, libelle: string, iso: string): Promise<void> {
  const champ = page.getByLabel(libelle);
  await champ.click();
  await champ.fill(jourFr(iso));
  await champ.press('Enter');
  await expect(champ).toHaveValue(jourFr(iso));
}
