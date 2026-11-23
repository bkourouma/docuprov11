/**
 * Recherche multi-critères (P3, écran `/search`, `POST /documents/search`) — ARC-13 à ARC-17.
 *
 * Les documents sont créés par l'API, archivés et classés (`_helpers/documents.ts`), sans worker.
 * Chaque test porte un jeton unique dans le libellé de ses documents et commence par filtrer sur
 * ce jeton : les données des autres tests (même base) n'interfèrent jamais avec les assertions.
 */
import { test, expect } from '../../fixtures';
import {
  attendreRecherche,
  choisirFiltre,
  creerDocumentArchive,
  creerDossier,
  creerPlan,
  creerTypeDocument,
  lignesResultat,
  ouvrirRecherche,
  rechercher,
  rechercherTexte,
  saisirPlageDates,
  typeFichier,
} from './_helpers/documents';
import { fichierPdf, pdfDeContenu } from './_helpers/lot-pdf';
import {
  DELAI_WORKER,
  STATUT_LOT,
  acquerirParApi,
  creerDossier as creerDossierLot,
  motUnique,
  rechercher as rechercherLot,
  validerDocuments,
} from './_helpers/lots';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

test.describe('Recherche multi-critères', () => {
  test('ARC-13 plein texte sur le libellé : résultat unique, filtre affiché, ouverture de la fiche', async ({
    page,
    api,
    uniq,
  }) => {
    const jeton = uniq('ARC13');
    const cible = await creerDocumentArchive(api, { label: `${jeton} Facture fournisseur` });
    const autre = await creerDocumentArchive(api, { label: `${uniq('ARC13b')} Autre pièce` });

    await ouvrirRecherche(page);
    await rechercherTexte(page, jeton);

    const lignes = lignesResultat(page, jeton);
    await expect(lignes).toHaveCount(1);
    await expect(lignes.first()).toContainText(cible.label);
    await expect(lignesResultat(page, autre.label)).toHaveCount(0);
    await expect(page.getByText('1 document(s)', { exact: true })).toBeVisible();
    await expect(page.getByText(`Texte : « ${jeton} »`, { exact: true })).toBeVisible();

    // Le libellé est le lien d'ouverture (FR-024) : il mène à la fiche, qui s'ouvre (200).
    const fiche = page.waitForResponse(
      (r) => r.url().endsWith(`/documents/${cible.documentId}`) && r.request().method() === 'GET',
    );
    await lignes.first().getByRole('link', { name: cible.label }).click();
    await expect(page).toHaveURL(new RegExp(`/documents/${cible.documentId}$`));
    expect((await fiche).status()).toBe(200);
  });

  test('ARC-14 filtres avancés combinés (type, dossier, plan, type de fichier, dates), retrait d’un filtre, réinitialisation', async ({
    page,
    api,
    uniq,
  }) => {
    const jeton = uniq('ARC14');
    const typeLabel = uniq('ARC14 Type');
    const dossierLabel = uniq('ARC14 Dossier');
    const autreDossierLabel = uniq('ARC14 Dossier bis');
    const planLabel = uniq('ARC14 Plan');
    const documentTypeId = await creerTypeDocument(api, typeLabel);
    const dossierId = await creerDossier(api, dossierLabel);
    const autreDossierId = await creerDossier(api, autreDossierLabel);
    const planId = await creerPlan(api, planLabel);
    const commun = { documentTypeId, planId };

    const retenu = await creerDocumentArchive(api, {
      label: `${jeton} A retenu`,
      ...commun,
      dossierId,
      documentDate: '2019-06-15',
    });
    const horsPeriode = await creerDocumentArchive(api, {
      label: `${jeton} B hors période`,
      ...commun,
      dossierId,
      documentDate: '2021-03-01',
    });
    const autreDossier = await creerDocumentArchive(api, {
      label: `${jeton} C autre dossier`,
      ...commun,
      dossierId: autreDossierId,
      documentDate: '2019-06-15',
    });
    // Les documents de l'éditeur portent une pièce `.html` : critère « Type de fichier » satisfait.
    const html = await typeFichier(api, '.html');
    const htmlLabel = `${html.friendlyName} (${html.extension})`;

    await ouvrirRecherche(page);
    await page.getByLabel('Recherche plein texte').fill(jeton);
    await page.getByRole('button', { name: /Filtres avancés/ }).click();
    await choisirFiltre(page, 'Type de document', typeLabel);
    await choisirFiltre(page, 'Dossier', dossierLabel);
    await choisirFiltre(page, 'Plan de classement', planLabel);
    await choisirFiltre(page, 'Type de fichier', htmlLabel);
    await saisirPlageDates(page, '01/01/2019', '31/12/2019');

    const combinee = attendreRecherche(
      page,
      (c) =>
        c.fullText === jeton &&
        c.documentTypeId === documentTypeId &&
        c.dossierId === dossierId &&
        c.planId === planId &&
        c.fileTypeId === html.fileTypeId &&
        c.documentDateFrom === '2019-01-01' &&
        c.documentDateTo === '2019-12-31',
    );
    await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
    expect((await combinee).status()).toBe(200);

    await expect(lignesResultat(page, jeton)).toHaveCount(1);
    await expect(lignesResultat(page, retenu.label)).toHaveCount(1);
    await expect(lignesResultat(page, retenu.label)).toContainText(typeLabel);
    await expect(lignesResultat(page, retenu.label)).toContainText(dossierLabel);
    await expect(lignesResultat(page, retenu.label)).toContainText(planLabel);

    // Chaque critère appliqué est rappelé par une puce.
    await expect(page.getByText(`Type : ${typeLabel}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Dossier : ${dossierLabel}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Plan : ${planLabel}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`Type de fichier : ${htmlLabel}`, { exact: true })).toBeVisible();
    const puceDate = page.getByText('Date : 01/01/2019 → 31/12/2019', { exact: true });
    await expect(puceDate).toBeVisible();

    // Retirer la puce « Date » relance la recherche sans les dates : le document hors période revient.
    const sansDates = attendreRecherche(
      page,
      (c) =>
        c.fullText === jeton &&
        c.dossierId === dossierId &&
        c.documentDateFrom === undefined &&
        c.documentDateTo === undefined,
    );
    await puceDate.getByLabel('Fermer', { exact: true }).click();
    expect((await sansDates).status()).toBe(200);
    await expect(lignesResultat(page, jeton)).toHaveCount(2);
    await expect(lignesResultat(page, horsPeriode.label)).toHaveCount(1);
    await expect(lignesResultat(page, autreDossier.label)).toHaveCount(0);

    // « Réinitialiser » vide la saisie, les puces et relance sans aucun critère.
    const sansCritere = attendreRecherche(
      page,
      (c) =>
        c.fullText === undefined && c.documentTypeId === undefined && c.dossierId === undefined,
    );
    await page.getByRole('button', { name: 'Réinitialiser', exact: true }).click();
    expect((await sansCritere).status()).toBe(200);
    await expect(page.getByText('Filtres actifs :')).toHaveCount(0);
    await expect(page.getByLabel('Recherche plein texte')).toHaveValue('');
  });

  test('ARC-15 pagination (API) et tri par colonne (écran)', async ({ page, api, uniq }) => {
    const jeton = uniq('ARC15');
    for (const n of [2, 3, 1]) {
      await creerDocumentArchive(api, { label: `${jeton} ${n}` });
    }

    // Pagination : total constant, pages disjointes, dernière page partielle.
    const tri = [{ field: 'label', dir: 'asc' as const }];
    const page1 = await rechercher(api, { fullText: jeton, sort: tri, page: 1, pageSize: 2 });
    const page2 = await rechercher(api, { fullText: jeton, sort: tri, page: 2, pageSize: 2 });
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
    expect(page1.rows.map((r) => r.label)).toEqual([`${jeton} 1`, `${jeton} 2`]);
    expect(page2.rows.map((r) => r.label)).toEqual([`${jeton} 3`]);

    // Tri à l'écran : un clic sur « Libellé » trie en croissant, un second en décroissant.
    await ouvrirRecherche(page);
    await rechercherTexte(page, jeton);
    await expect(lignesResultat(page, jeton)).toHaveCount(3);
    const entete = page.getByRole('columnheader', { name: /Libellé/ });

    const croissant = attendreRecherche(
      page,
      (c) => JSON.stringify(c.sort) === JSON.stringify([{ field: 'label', dir: 'asc' }]),
    );
    await entete.click();
    expect((await croissant).status()).toBe(200);
    await expect(lignesResultat(page, jeton).first()).toContainText(`${jeton} 1`);
    await expect(lignesResultat(page, jeton).last()).toContainText(`${jeton} 3`);

    const decroissant = attendreRecherche(
      page,
      (c) => JSON.stringify(c.sort) === JSON.stringify([{ field: 'label', dir: 'desc' }]),
    );
    await entete.click();
    expect((await decroissant).status()).toBe(200);
    await expect(lignesResultat(page, jeton).first()).toContainText(`${jeton} 3`);
    await expect(lignesResultat(page, jeton).last()).toContainText(`${jeton} 1`);
  });

  test('ARC-16 aucun résultat : état vide et export désactivé', async ({ page, uniq }) => {
    await ouvrirRecherche(page);
    await rechercherTexte(page, `${uniq('ARC16')} introuvable`);

    await expect(page.getByText('Aucun document ne correspond à ces critères')).toBeVisible();
    await expect(page.getByRole('button', { name: /Exporter/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Tout effacer' })).toBeVisible();
  });

  test('ARC-16 erreurs de saisie refusées en 400 (jamais 500)', async ({ api }) => {
    const cas: Array<{ nom: string; corps: Record<string, unknown> }> = [
      {
        nom: 'plage de dates inversée',
        corps: { documentDateFrom: '2026-12-31', documentDateTo: '2026-01-01' },
      },
      { nom: 'date inexistante', corps: { documentDateFrom: '2026-02-30' } },
      { nom: 'date au format JJ/MM/AAAA', corps: { documentDateTo: '31/12/2026' } },
      { nom: 'taille de page au-delà de 500', corps: { pageSize: 501 } },
      { nom: 'page nulle', corps: { page: 0 } },
      { nom: 'colonne de tri inconnue', corps: { sort: [{ field: 'password', dir: 'asc' }] } },
      { nom: 'identifiant de type non numérique', corps: { documentTypeId: 'abc' } },
    ];
    for (const { nom, corps } of cas) {
      const recherche = await api.raw.post('/documents/search', corps);
      expect(recherche.status(), `recherche — ${nom}`).toBe(400);
      const exportation = await api.raw.post('/documents/export', { ...corps, format: 'csv' });
      expect(exportation.status(), `export — ${nom}`).toBe(400);
    }

    const inversee = await api.raw.post('/documents/search', {
      documentDateFrom: '2026-12-31',
      documentDateTo: '2026-01-01',
    });
    expect(JSON.stringify(await inversee.json())).toContain('date de fin');

    const formatInconnu = await api.raw.post('/documents/export', { format: 'odt' });
    expect(formatInconnu.status()).toBe(400);
  });

  test('ARC-17 plein texte sur le texte extrait des pages d’un document issu d’un lot', async ({
    page,
    api,
    uniq,
  }) => {
    test.setTimeout(DELAI_WORKER + 60_000);
    const u = uniq('ARC-17');
    // Mots uniques en lettres seules : la configuration `french` découpe sur chiffres et tirets.
    const motPage2 = motUnique(`${u}p2`);
    const absent = motUnique(`${u}absent`);
    const dossier = await creerDossierLot(api, `${u} dossier`);
    // Pages à couche texte réelle (≥ 12 caractères) : le worker les lit sans lancer Tesseract.
    const pdf = await pdfDeContenu([
      'Premiere page du dossier de recherche plein texte.',
      `Deuxieme page qui contient le terme ${motPage2} au milieu.`,
    ]);
    // Mode « intercalaires » sans aucun QR : un seul document, dont le texte des pages est extrait
    // (le mode sans intercalaire fusionne sans extraire de texte, `ocrText: null`).
    const { statut, documents } = await acquerirParApi(
      api,
      { dossierId: dossier.id, useIntercalaires: true },
      [fichierPdf(`${u}-texte`, pdf)],
    );
    expect(statut.status).toBe(STATUT_LOT.traite);
    expect(documents).toHaveLength(1);
    const doc = documents[0]!;
    await validerDocuments(api, [doc.documentId]);

    // API : le terme de la page 2 retrouve le document, un terme absent ne retrouve rien.
    const trouve = await rechercherLot(api, { fullText: motPage2 });
    expect(trouve.rows.map((r) => r.documentId)).toEqual([doc.documentId]);
    expect(trouve.total).toBe(1);
    expect((await rechercherLot(api, { fullText: absent })).total).toBe(0);

    // Écran : même recherche, la ligne du document apparaît.
    await ouvrirRecherche(page);
    await rechercherTexte(page, motPage2);
    await expect(lignesResultat(page, doc.label)).toHaveCount(1);
  });

  test.fixme('ARC-17 plein texte sur la cote (numéro de pièce)', async () => {
    // Question métier : la recherche interroge `d.cote` (search.service.ts), mais plus aucun
    // chemin ne l'écrit — ni le worker (QR), ni l'indexation (`cote` retiré du contrat,
    // documents.dto.ts), ni l'acquisition. La cote est-elle encore une donnée du produit (et qui
    // la saisit), ou la recherche doit-elle cesser de l'interroger ?
  });

  test.fixme('ARC-17 plein texte sur le texte reconnu par Tesseract (page scannée sans couche texte)', async () => {
    // Hors pile hermétique : la pile ne fournit pas `TESSERACT_DATA_PATH`, et tesseract.js
    // téléchargerait alors ses données de langue (tessdata) depuis Internet au premier usage.
    // À écrire quand la pile embarquera les `.traineddata.gz` (fra, eng).
  });
});
