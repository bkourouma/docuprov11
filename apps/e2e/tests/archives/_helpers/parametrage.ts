/**
 * Paramétrage Docu-Archives (tâche T4, lot 2) : appels REST de `/archives/settings/*` et gestes
 * d'écran communs aux huit écrans `/admin/archives/*`.
 *
 * Contrat API (apps/api/src/modules/archives/archives-settings.controller.ts) :
 *  - référentiels plats (`destruction-modes`, `final-fates`, `lending-motives`) :
 *    GET → lignes ACTIVES triées par libellé ; POST { labels } → { created, skipped } (doublons
 *    ignorés, insensibles à la casse et aux espaces) ; PATCH /:id { label } (409 si doublon) ;
 *    DELETE { ids } → { deactivated } (désactivation, jamais de suppression physique) ;
 *  - `metadatas` : POST { metaDatas: [{ label, dataType }] } → { created, skipped } ;
 *  - `metadata-list-items` : POST { metaDataId, labels } → { created, skipped } ;
 *  - `metadata-document-types` : POST { documentTypeIds, metaDataIds } → { created, alreadyLinked },
 *    PUT { documentTypeId, metaDataIds }, DELETE { ids }, GET /:documentTypeId/fields ;
 *  - `document-types` (paramétrage) et `life-cycles` : PUT = création OU mise à jour (un par type).
 * LECTURES ouvertes à tout compte authentifié ; ÉCRITURES sous `@RequireMenu` (menu de l'écran).
 */
import { expect, request, type Locator, type Page, type Response } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';

export const SETTINGS = '/archives/settings';

/** Le client renvoie le JSON sans type : on le nomme là où on le lit. */
async function json<T>(p: Promise<unknown>): Promise<T> {
  return (await p) as T;
}

export interface ResultatMasse {
  created: number;
  skipped: string[];
}

// ---------------------------------------------------------------------------
// Référentiels plats : modes de destruction, sorts finaux, motifs de prêt
// ---------------------------------------------------------------------------

export interface Referentiel {
  /** Segment d'API sous `/archives/settings`. */
  chemin: 'destruction-modes' | 'final-fates' | 'lending-motives';
  /** Clé d'identifiant des lignes renvoyées. */
  cleId: 'destructionModeId' | 'finalFateId' | 'lendingMotiveId';
  /** Route de l'écran = clé de menu (`ARCHIVES_MENUS`). */
  ecran: string;
  titre: string;
  /** Titre de la carte du formulaire (saisie unitaire). */
  titreFormulaire: string;
  /** Titre de la carte du tableau (`tableTitle`). */
  titreTableau: string;
  /** Nom nu, tel que le message de création l'accorde (« 1 mode de destruction créé »). */
  nom: string;
  /** Avec démonstratif, tel que les confirmations le citent (« ce mode de destruction »). */
  demonstratif: string;
  /** Pluriel, tel que la confirmation de lot le cite (« Désactiver ces 2 modes de destruction ? »). */
  pluriel: string;
  /** Message du 409 de renommage (`archives-settings.service.ts`). */
  messageDoublon: string;
}

/** Les trois écrans du patron `BulkRefPage` (props lues dans leurs `page.tsx`). */
export const REFERENTIELS: Record<'modes' | 'sorts' | 'motifs', Referentiel> = {
  modes: {
    chemin: 'destruction-modes',
    cleId: 'destructionModeId',
    ecran: '/admin/archives/modes-destruction',
    titre: 'Modes de destruction',
    titreFormulaire: 'Nouveau mode de destruction',
    titreTableau: 'Modes enregistrés',
    nom: 'mode de destruction',
    demonstratif: 'ce mode de destruction',
    pluriel: 'modes de destruction',
    messageDoublon: 'Un mode de destruction actif porte déjà ce libellé',
  },
  sorts: {
    chemin: 'final-fates',
    cleId: 'finalFateId',
    ecran: '/admin/archives/sorts-finaux',
    titre: 'Sorts finaux',
    titreFormulaire: 'Nouveau sort final',
    titreTableau: 'Sorts enregistrés',
    nom: 'sort final',
    demonstratif: 'ce sort final',
    pluriel: 'sorts finaux',
    messageDoublon: 'Un sort final actif porte déjà ce libellé',
  },
  motifs: {
    chemin: 'lending-motives',
    cleId: 'lendingMotiveId',
    ecran: '/admin/archives/motifs-pret',
    titre: 'Motifs de prêt',
    titreFormulaire: 'Nouveau motif',
    titreTableau: 'Motifs enregistrés',
    nom: 'motif',
    demonstratif: 'ce motif',
    pluriel: 'motifs',
    messageDoublon: 'Un motif de prêt actif porte déjà ce libellé',
  },
};

export interface LigneReferentiel {
  id: number;
  label: string;
}

export async function listerReferentiel(
  client: ApiClient,
  ref: Referentiel,
): Promise<LigneReferentiel[]> {
  const rows = await json<Array<Record<string, unknown>>>(client.get(`${SETTINGS}/${ref.chemin}`));
  return rows.map((r) => ({ id: Number(r[ref.cleId]), label: String(r.label) }));
}

export function creerDansReferentiel(
  client: ApiClient,
  ref: Referentiel,
  labels: string[],
): Promise<ResultatMasse> {
  return json<ResultatMasse>(client.post(`${SETTINGS}/${ref.chemin}`, { labels }));
}

/** Crée UN libellé et renvoie sa ligne (le POST de masse ne rend que des compteurs). */
export async function creerElementReferentiel(
  client: ApiClient,
  ref: Referentiel,
  label: string,
): Promise<LigneReferentiel> {
  const r = await creerDansReferentiel(client, ref, [label]);
  expect(r, `création de « ${label} » dans ${ref.chemin}`).toEqual({ created: 1, skipped: [] });
  return trouverDansReferentiel(client, ref, label);
}

export async function trouverDansReferentiel(
  client: ApiClient,
  ref: Referentiel,
  label: string,
): Promise<LigneReferentiel> {
  const ligne = (await listerReferentiel(client, ref)).find((r) => r.label === label);
  if (!ligne) throw new Error(`« ${label} » absent de ${ref.chemin} (lignes actives)`);
  return ligne;
}

// ---------------------------------------------------------------------------
// DELETE avec corps
// ---------------------------------------------------------------------------

/**
 * Les suppressions du paramétrage prennent leurs identifiants dans le CORPS (`DELETE { ids }`).
 * Le client commun (`support/api-client.ts`) n'envoie AUCUN corps sur `del` (signature
 * `del(path, opts)`) : l'API répondait 400 « (root): Required ». Contournement local en phase B
 * (support/** interdit) : requête DELETE émise par un contexte Playwright portant le même jeton.
 * Lève une erreur lisible si le statut est >= 400, comme `api.del`.
 */
export async function supprimerParApi(
  client: ApiClient,
  chemin: string,
  ids: number[],
): Promise<unknown> {
  const ctx = await request.newContext({
    baseURL: client.baseURL,
    extraHTTPHeaders: client.token ? { Authorization: `Bearer ${client.token}` } : {},
  });
  try {
    const res = await ctx.delete(chemin.replace(/^\/+/, ''), {
      data: { ids },
      failOnStatusCode: false,
    });
    const texte = await res.text();
    if (res.status() >= 400) throw new Error(`DELETE /api${chemin} → ${res.status()} ${texte}`);
    return texte ? (JSON.parse(texte) as unknown) : undefined;
  } finally {
    await ctx.dispose();
  }
}

// ---------------------------------------------------------------------------
// Métadonnées, valeurs de liste, associations
// ---------------------------------------------------------------------------

/** `MetaDataType` (@archivage/types) et ses libellés d'écran (`METADATA_TYPE_LABELS`). */
export const TYPE_SAISIE = {
  texte: { valeur: 1, libelle: 'Texte' },
  entier: { valeur: 2, libelle: 'Nombre entier' },
  date: { valeur: 3, libelle: 'Date' },
  texteLong: { valeur: 4, libelle: 'Texte long' },
  booleen: { valeur: 5, libelle: 'Oui / Non' },
  liste: { valeur: 6, libelle: 'Liste de valeurs' },
} as const;

export interface MetaDonnee {
  metaDataId: number;
  label: string;
  dataType: number;
  listItemCount: number;
}

export function listerMetaDonnees(client: ApiClient): Promise<MetaDonnee[]> {
  return json<MetaDonnee[]>(client.get(`${SETTINGS}/metadatas`));
}

export async function creerMetaDonnee(
  client: ApiClient,
  label: string,
  dataType: number,
): Promise<MetaDonnee> {
  const r = await json<ResultatMasse>(
    client.post(`${SETTINGS}/metadatas`, { metaDatas: [{ label, dataType }] }),
  );
  expect(r, `création de la métadonnée « ${label} »`).toEqual({ created: 1, skipped: [] });
  const m = (await listerMetaDonnees(client)).find((x) => x.label === label);
  if (!m) throw new Error(`Métadonnée « ${label} » introuvable après création`);
  return m;
}

export interface ValeurListe {
  metaDataListItemId: number;
  metaDataId: number;
  label: string;
}

export function listerValeurs(client: ApiClient, metaDataId: number): Promise<ValeurListe[]> {
  return json<ValeurListe[]>(
    client.get(`${SETTINGS}/metadata-list-items?metaDataId=${metaDataId}`),
  );
}

export function creerValeurs(
  client: ApiClient,
  metaDataId: number,
  labels: string[],
): Promise<ResultatMasse> {
  return json<ResultatMasse>(
    client.post(`${SETTINGS}/metadata-list-items`, { metaDataId, labels }),
  );
}

export interface Association {
  metaDataDocumentTypeId: number;
  documentTypeId: number;
  metaDataId: number;
}

export async function associationsDuType(
  client: ApiClient,
  documentTypeId: number,
): Promise<Association[]> {
  const rows = await json<Association[]>(client.get(`${SETTINGS}/metadata-document-types`));
  return rows.filter((r) => r.documentTypeId === documentTypeId);
}

export function associer(
  client: ApiClient,
  documentTypeIds: number[],
  metaDataIds: number[],
): Promise<{ created: number; alreadyLinked: number }> {
  return json(client.post(`${SETTINGS}/metadata-document-types`, { documentTypeIds, metaDataIds }));
}

export interface ChampFormulaire {
  metaDataId: number;
  label: string;
  dataType: number;
  options: Array<{ metaDataListItemId: number; label: string }>;
}

/** Champs du formulaire dynamique d'indexation d'un type — l'usage aval de tout ce paramétrage. */
export function champsDuType(
  client: ApiClient,
  documentTypeId: number,
): Promise<ChampFormulaire[]> {
  return json<ChampFormulaire[]>(
    client.get(`${SETTINGS}/metadata-document-types/${documentTypeId}/fields`),
  );
}

// ---------------------------------------------------------------------------
// Paramétrage des types et cycles de vie
// ---------------------------------------------------------------------------

export interface ParametrageType {
  documentTypeSettingId: number;
  documentTypeId: number;
  dossierId: number | null;
  planId: number | null;
  confidentialiteId: number | null;
}

/**
 * Paramétrage d'un type, lu dans la LISTE plutôt que par `GET …/:id/defaults` : ce dernier renvoie
 * `null` pour un type non paramétré, que Nest sert en corps VIDE — illisible par un client JSON.
 */
export async function parametrageDuType(
  client: ApiClient,
  documentTypeId: number,
): Promise<ParametrageType | null> {
  const rows = await json<ParametrageType[]>(client.get(`${SETTINGS}/document-types`));
  return rows.find((r) => r.documentTypeId === documentTypeId) ?? null;
}

export interface CycleDeVie {
  documentTypeLifeCycleId: number;
  documentTypeId: number;
  usefulnessLifespan: number;
  complianceLifespan: number;
  finalFateId: number | null;
  destructionModeId: number | null;
  finalFate: { label: string } | null;
  destructionMode: { label: string } | null;
}

export async function cycleDuType(
  client: ApiClient,
  documentTypeId: number,
): Promise<CycleDeVie | null> {
  const rows = await json<CycleDeVie[]>(client.get(`${SETTINGS}/life-cycles`));
  return rows.find((r) => r.documentTypeId === documentTypeId) ?? null;
}

export function enregistrerCycle(
  client: ApiClient,
  corps: {
    documentTypeId: number;
    usefulnessLifespan: number;
    complianceLifespan: number;
    finalFateId?: number | null;
    destructionModeId?: number | null;
  },
): Promise<CycleDeVie> {
  return json<CycleDeVie>(client.put(`${SETTINGS}/life-cycles`, corps));
}

// ---------------------------------------------------------------------------
// Gestes d'écran
// ---------------------------------------------------------------------------

/** Message renvoyé par `MenuPermissionGuard` et affiché tel quel par les écrans. */
export const MESSAGE_REFUS = "Vous n'avez pas accès à cette section.";

/** Prédicat de réponse : verbe + chemin d'API se terminant par `suffixe` (requête éventuelle ôtée). */
export function estAppel(methode: string, suffixe: string): (r: Response) => boolean {
  return (r) =>
    r.request().method() === methode && new URL(r.url()).pathname.endsWith(`/api${suffixe}`);
}

/** Attend l'appel déclenché par `geste` et le renvoie (statut contrôlé par l'appelant). */
export async function apresAppel(
  page: Page,
  methode: string,
  suffixe: string,
  geste: () => Promise<void>,
): Promise<Response> {
  const reponse = page.waitForResponse(estAppel(methode, suffixe));
  await geste();
  return reponse;
}

/**
 * Ouvre un écran de paramétrage et attend sa première lecture (`GET` de son référentiel), pour que
 * les gestes suivants portent sur un tableau chargé.
 */
export async function ouvrirEcran(
  page: Page,
  route: string,
  titre: string,
  lecture: string,
): Promise<void> {
  // Première lecture d'un écran : même délai qu'une navigation (45 s), l'écran pouvant être
  // compilé et servi lentement quand plusieurs piles tournent sur la machine.
  const charge = page.waitForResponse(estAppel('GET', lecture), { timeout: 45_000 });
  await page.goto(route);
  expect((await charge).status()).toBe(200);
  await expect(page.getByRole('heading', { name: titre, exact: true })).toBeVisible();
}

/**
 * Champ d'un formulaire de paramétrage par son libellé (`NewItemField` : vrai `<label for>`,
 * suivi d'une astérisque `aria-hidden` quand il est requis — tolérée par l'expression).
 */
export function champ(conteneur: Page | Locator, libelle: string): Locator {
  return conteneur.getByLabel(new RegExp(`^\\s*${echapper(libelle)}\\s*\\*?\\s*$`));
}

/** Carte AntD repérée par son titre (formulaire ou tableau). */
export function carte(page: Page, titre: string): Locator {
  return page.locator('.ant-card').filter({
    has: page.locator('.ant-card-head-title', { hasText: new RegExp(`^${echapper(titre)}$`) }),
  });
}

/**
 * Bouton AntD à état `loading` (Ajouter, Associer, Enregistrer…), repéré par son libellé.
 *
 * Quand l'appel est très court (≈ 60 ms sur la pile), l'animation d'entrée de l'icône de
 * chargement est interrompue par celle de sortie, qui part d'une largeur déjà nulle : aucune
 * transition, donc aucun `transitionend`, et rc-motion laisse l'`<img aria-label="loading">`
 * (invisible, largeur 0) dans le bouton. Son nom accessible reste « loading Ajouter » alors qu'il
 * n'est plus en chargement (constaté au 2e passage d'ARC-35). On tolère donc ce préfixe résiduel,
 * mais on exige l'absence de `.ant-btn-loading` : un bouton réellement en chargement n'est pas pris.
 */
export function boutonAntd(conteneur: Page | Locator, libelle: string): Locator {
  return conteneur
    .getByRole('button', { name: new RegExp(`^(?:loading )?${echapper(libelle)}$`) })
    .and(conteneur.locator('button:not(.ant-btn-loading)'));
}

export function echapper(texte: string): string {
  return texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Ligne d'un tableau paginé (10 lignes par page, données de toute la pile E2E) contenant `texte`.
 * Repart de la page 1 puis avance de page en page jusqu'à la trouver ; renvoie le localisateur
 * (vide si la ligne n'existe nulle part — l'assertion de l'appelant échoue alors lisiblement).
 */
export async function ligneDansTable(conteneur: Locator, texte: string): Promise<Locator> {
  const ligne = conteneur.getByRole('row').filter({ hasText: texte });
  const pagination = conteneur.locator('.ant-pagination').first();
  if ((await pagination.count()) === 0) return ligne;

  const premiere = pagination.locator('.ant-pagination-item-1');
  if ((await premiere.count()) > 0 && !(await premiere.getAttribute('class'))?.includes('active')) {
    await premiere.click();
    await expect(pagination.locator('.ant-pagination-item-active')).toHaveText('1');
  }
  for (let n = 1; n < 200; n += 1) {
    if ((await ligne.count()) > 0) return ligne;
    const suivante = pagination.locator('.ant-pagination-next');
    if ((await suivante.getAttribute('aria-disabled')) === 'true') return ligne;
    await suivante.click();
    await expect(pagination.locator('.ant-pagination-item-active')).toHaveText(String(n + 1));
  }
  return ligne;
}

/** Confirme le Popconfirm ouvert par son bouton de validation. */
export async function confirmer(page: Page, bouton: string): Promise<void> {
  await page
    .locator('.ant-popconfirm:not(.ant-popover-hidden)')
    .getByRole('button', { name: bouton, exact: true })
    .click();
}

/**
 * Ligne de tableau AntD repérée par sa clé (`data-row-key`) plutôt que par son texte. Nécessaire
 * dès que le texte qui a servi à la trouver va disparaître : en édition en place, le libellé passe
 * dans la VALEUR d'un `<input>`, qui ne compte pas dans le texte de la ligne — un localisateur
 * `filter({ hasText })` ne la retrouverait plus.
 */
export async function figerLigne(page: Page, ligne: Locator): Promise<Locator> {
  await expect(ligne).toHaveCount(1);
  const cle = await ligne.getAttribute('data-row-key');
  if (!cle) throw new Error('Ligne de tableau sans attribut data-row-key');
  const fixe = page.locator(`tr.ant-table-row[data-row-key="${cle}"]`);
  await expect(fixe, `clé de ligne « ${cle} » unique sur la page`).toHaveCount(1);
  return fixe;
}

/**
 * Passe une cellule « cliquer pour modifier » (`EditableText`) en édition et renvoie son champ
 * (le seul `textbox` de la ligne), sur une ligne figée par sa clé.
 */
export async function editerEnPlace(page: Page, ligne: Locator, actuel: string): Promise<Locator> {
  const fixe = await figerLigne(page, ligne);
  await fixe.getByRole('button', { name: actuel, exact: true }).click();
  const saisie = fixe.getByRole('textbox');
  await expect(saisie).toBeFocused();
  return saisie;
}

/**
 * Renomme en place une cellule « cliquer pour modifier » (`EditableText`) : clic sur la valeur,
 * saisie, Entrée. Renvoie la réponse du `PATCH` attendu.
 */
export async function renommerEnPlace(
  page: Page,
  ligne: Locator,
  actuel: string,
  nouveau: string,
  suffixePatch: string,
): Promise<Response> {
  const saisie = await editerEnPlace(page, ligne, actuel);
  await saisie.fill(nouveau);
  return apresAppel(page, 'PATCH', suffixePatch, () => saisie.press('Enter'));
}

/** Liste déroulante AntD visible (portail). */
export function listeOuverte(page: Page): Locator {
  return page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
}

/**
 * Ouvre un Select / TreeSelect AntD SIMPLE à partir de son `<input role="combobox">` (ce que
 * `getByLabel` désigne). Quand le champ a déjà une valeur, AntD pose par-dessus l'input la
 * valeur affichée (`.ant-select-selection-item`), qui intercepte le clic : on clique donc la zone
 * `.ant-select-selector` qui les contient tous deux (même geste qu'un utilisateur). À NE PAS
 * employer sur un Select multiple : le centre de la zone peut tomber sur la croix d'une étiquette.
 */
export async function ouvrirSelect(champ: Locator): Promise<void> {
  await champ
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select-selector ")][1]',
    )
    .click();
  await expect(champ).toHaveAttribute('aria-expanded', 'true');
}

/** Select AntD SANS recherche (`Type de saisie`) : ouverture puis clic sur l'option. */
export async function choisirSansRecherche(
  page: Page,
  champ: Locator,
  libelle: string,
): Promise<void> {
  await ouvrirSelect(champ);
  await listeOuverte(page).getByTitle(libelle, { exact: true }).click();
}

/**
 * Select / TreeSelect AntD à recherche, simple ou multiple : saisie, clic sur l'option filtrée
 * (libellé porté en `title` par rc-select et rc-tree). En mode multiple la liste reste ouverte :
 * Échap la referme pour ne pas masquer le champ suivant. Simple : ouverture par `ouvrirSelect`
 * (la valeur déjà choisie couvre l'input) ; multiple : l'input de recherche n'est jamais couvert.
 */
export async function choisirAvecRecherche(
  page: Page,
  champ: Locator,
  libelle: string,
  multiple = false,
): Promise<void> {
  if (multiple) await champ.click();
  else await ouvrirSelect(champ);
  await champ.fill(libelle);
  await listeOuverte(page).getByTitle(libelle, { exact: true }).click();
  if (multiple) await champ.press('Escape');
}

/** Valeur affichée d'un Select (simple ou étiquettes du multiple) contenant `libelle`. */
export function valeurAffichee(champ: Locator, libelle: string): Locator {
  return champ
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-select ")][1]',
    )
    .locator('.ant-select-selection-item', { hasText: libelle });
}
