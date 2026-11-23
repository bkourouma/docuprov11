/**
 * Communication (prêt) de documents — Docu-Archives §3 à §6 : « Communiquer un document »,
 * « Documents communiqués », « Mes documents communiqués », « Historique des documents
 * communiqués », retour et commentaires. Scénarios ARC-23 à ARC-28, ARC-33 et ARC-34.
 *
 * Préparation par l'API (dossier, documents archivés, motif de prêt, emprunteur), gestes par
 * l'écran ; les effets de fond (périmètres serveur, statuts HTTP) sont relus par l'API.
 */
import type { Page, Request, Response } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { compteGroupeDe } from './_helpers/documents';
import { choisirDansListe } from './_helpers/lots';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import {
  INVITE_PRETS,
  MENUS,
  REFUS_MENU,
  acteur,
  attendreListe,
  corpsPret,
  creerMotifPret,
  creerPret,
  documentsCommunicables,
  dossierAvecDocuments,
  jourIso,
  jourLocal,
  poserDua,
  pretsListes,
  rechercherDansListe,
  rendre,
  saisirDate,
} from './_helpers/archives-data';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

const estRequeteDeCreation = (r: Request) =>
  r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/api/archives/lendings');

const estCreationDePret = (r: Response) => estRequeteDeCreation(r.request());

/** Ouvre « Communiquer un document » et choisit le dossier ; attend sa liste de documents. */
async function ouvrirCommuniquer(page: Page, dossierId: number, dossierLabel: string) {
  await page.goto('/archives/communiquer');
  await expect(page.getByRole('heading', { name: 'Communiquer un document' })).toBeVisible();
  const documents = attendreListe(page, `/archives/lendings/dossiers/${dossierId}/documents`);
  await choisirDansListe(
    page,
    page.getByRole('combobox', { name: 'Dossier', exact: true }),
    dossierLabel,
  );
  return documents;
}

const boutonCommuniquer = (page: Page) =>
  page.getByRole('button', { name: 'Communiquer', exact: true });

/** Statut HTTP et corps texte d'un refus (le corps porte le message zod ou métier). */
async function refus(reponse: { status(): number; text(): Promise<string> }) {
  return { statut: reponse.status(), corps: await reponse.text() };
}

test.describe('Communiquer un document', () => {
  test('ARC-23 communique un document à l’écran ; l’emprunteur le voit dans « Mes documents communiqués » et le rend', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-23');
    const { dossierId, dossierLabel, documents } = await dossierAvecDocuments(api, u, 2);
    const [doc, voisin] = documents as [(typeof documents)[0], (typeof documents)[0]];
    const motif = await creerMotifPret(api, `${u} motif`);
    const emprunteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-emp`,
      menus: [MENUS.mesCommuniques],
    });
    const beneficiaire = await acteur(api, await compteGroupeDe(api, apiAs, emprunteur));

    await test.step('saisie et validation à l’écran', async () => {
      const liste = await ouvrirCommuniquer(page, dossierId, dossierLabel);
      expect((await liste).status()).toBe(200);
      await expect(page.getByText('2 document(s) communicable(s)')).toBeVisible();
      await expect(boutonCommuniquer(page)).toBeDisabled();

      await page.getByRole('row').filter({ hasText: doc.label }).getByRole('checkbox').check();
      await choisirDansListe(
        page,
        page.getByRole('combobox', { name: 'Bénéficiaire', exact: true }),
        beneficiaire.nom,
      );
      await choisirDansListe(
        page,
        page.getByRole('combobox', { name: 'Motif', exact: true }),
        motif.label,
      );
      await saisirDate(page, 'Retour prévu', jourLocal(10));
      await expect(
        page.getByText('Prêt à communiquer — 1 document(s) sélectionné(s)'),
      ).toBeVisible();

      const creation = page.waitForResponse(estCreationDePret);
      await boutonCommuniquer(page).click();
      const reponse = await creation;
      expect(reponse.status()).toBe(201);
      expect(reponse.request().postDataJSON()).toEqual({
        documentIds: [doc.documentId],
        userGroupId: beneficiaire.userGroupId,
        lendingMotiveId: motif.lendingMotiveId,
        startDate: jourLocal(0),
        projectedReturnDate: jourLocal(10),
      });
      await expect(page.getByText('Document communiqué', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/archives\/documents-communiques$/);
    });

    await test.step('visible dans « Documents communiqués »', async () => {
      await expect(page.getByRole('heading', { name: 'Documents communiqués' })).toBeVisible();
      await rechercherDansListe(page, INVITE_PRETS, '/archives/lendings/out', u);
      const ligne = page.getByRole('row').filter({ hasText: doc.label });
      await expect(ligne).toHaveCount(1);
      await expect(ligne).toContainText(beneficiaire.nom);
      await expect(ligne).toContainText(motif.label);
      await expect(ligne).toContainText('en cours');
      await expect(ligne.getByRole('button', { name: 'Retour' })).toBeVisible();
      // Le voisin non coché n'est pas sorti.
      await expect(page.getByRole('row').filter({ hasText: voisin.label })).toHaveCount(0);
      // Il n'est plus proposé à la communication, son voisin si.
      expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId)).toEqual([
        voisin.documentId,
      ]);
    });

    await test.step('l’emprunteur le voit et le rend', async () => {
      await loginAs(page, emprunteur.username, emprunteur.password);
      await page.goto('/archives/mes-documents-communiques');
      await expect(page.getByRole('heading', { name: 'Mes documents communiqués' })).toBeVisible();
      await rechercherDansListe(page, INVITE_PRETS, '/archives/lendings/mine', u);
      const ligne = page.getByRole('row').filter({ hasText: doc.label });
      await expect(ligne).toHaveCount(1);
      // Le bénéficiaire est toujours l'utilisateur connecté : la colonne est masquée.
      await expect(page.getByRole('columnheader', { name: 'Bénéficiaire' })).toHaveCount(0);

      const retour = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/lendings\/details\/\d+\/return$/.test(r.url()),
      );
      await ligne.getByRole('button', { name: 'Retour' }).click();
      await page.getByRole('button', { name: 'Enregistrer le retour' }).click();
      expect((await retour).status()).toBe(200);
      await expect(
        page.getByText('Document retourné — la communication est close', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: doc.label })).toHaveCount(0);
    });

    // Fond : le prêt est passé à l'historique, le document est de nouveau communicable.
    expect(await pretsListes(api, 'out', u)).toEqual([]);
    const historique = await pretsListes(api, 'history', u);
    expect(historique.map((r) => r.documentId)).toEqual([doc.documentId]);
    expect(historique[0]!.returnedDate).not.toBeNull();
    expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId).sort()).toEqual(
      [doc.documentId, voisin.documentId].sort(),
    );
  });

  test('ARC-26 refuse une saisie incomplète ou des dates incohérentes (écran et API)', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const u = uniq('ARC-26');
    const {
      dossierId,
      dossierLabel,
      documents: [doc],
    } = await dossierAvecDocuments(api, u, 1);
    const motif = await creerMotifPret(api, `${u} motif`);
    const emprunteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-emp`,
      menus: [MENUS.mesCommuniques],
    });
    const beneficiaire = await acteur(api, await compteGroupeDe(api, apiAs, emprunteur));

    const envois: string[] = [];
    page.on('request', (r) => {
      if (estRequeteDeCreation(r)) envois.push(r.url());
    });

    await test.step('écran : champs requis', async () => {
      await ouvrirCommuniquer(page, dossierId, dossierLabel);
      await expect(page.getByText('1 document(s) communicable(s)')).toBeVisible();
      await expect(boutonCommuniquer(page)).toBeDisabled();
      await page.getByRole('row').filter({ hasText: doc!.label }).getByRole('checkbox').check();
      await expect(boutonCommuniquer(page)).toBeDisabled();
      await choisirDansListe(
        page,
        page.getByRole('combobox', { name: 'Bénéficiaire', exact: true }),
        beneficiaire.nom,
      );
      await expect(boutonCommuniquer(page)).toBeDisabled();
      await choisirDansListe(
        page,
        page.getByRole('combobox', { name: 'Motif', exact: true }),
        motif.label,
      );
      await expect(boutonCommuniquer(page)).toBeEnabled();
      await expect(page.getByText(/^Prêt à communiquer/)).toBeVisible();
    });

    await test.step('écran : retour prévu antérieur au début', async () => {
      // Début il y a 10 jours, retour il y a 5 jours (cohérent), puis début ramené à aujourd'hui :
      // le retour prévu précède désormais le début.
      await saisirDate(page, 'Date de début', jourLocal(-10));
      await saisirDate(page, 'Retour prévu', jourLocal(-5));
      await expect(boutonCommuniquer(page)).toBeEnabled();
      await saisirDate(page, 'Date de début', jourLocal(0));
      await expect(boutonCommuniquer(page)).toBeDisabled();
      await expect(page.getByText(/^Prêt à communiquer/)).toHaveCount(0);
      await saisirDate(page, 'Retour prévu', jourLocal(1));
      await expect(boutonCommuniquer(page)).toBeEnabled();
      expect(envois, 'aucune création envoyée tant que la saisie est invalide').toEqual([]);
    });

    await test.step('API : mêmes règles quel que soit l’appelant', async () => {
      const valide = corpsPret({
        documentIds: [doc!.documentId],
        userGroupId: beneficiaire.userGroupId,
        lendingMotiveId: motif.lendingMotiveId,
      });
      const vide = await refus(await api.raw.post('/archives/lendings', {}));
      expect(vide.statut).toBe(400);
      for (const champ of [
        'documentIds',
        'userGroupId',
        'lendingMotiveId',
        'startDate',
        'projectedReturnDate',
      ]) {
        expect(vide.corps).toContain(champ);
      }

      const aucun = await refus(
        await api.raw.post('/archives/lendings', { ...valide, documentIds: [] }),
      );
      expect(aucun).toMatchObject({ statut: 400 });
      expect(aucun.corps).toContain('Sélectionnez au moins un document');

      const inverse = await refus(
        await api.raw.post('/archives/lendings', {
          ...valide,
          startDate: jourIso(0),
          projectedReturnDate: jourIso(-1),
        }),
      );
      expect(inverse.statut).toBe(400);
      expect(inverse.corps).toContain('La date de retour prévue doit suivre la date de début');

      const format = await refus(
        await api.raw.post('/archives/lendings', { ...valide, startDate: '21/11/2026' }),
      );
      expect(format.statut).toBe(400);
      expect(format.corps).toContain('Date attendue au format AAAA-MM-JJ');

      // ANO-ARC-T3-02 : la règle « début ≤ aujourd'hui » était annoncée côté serveur sans y être.
      const futur = await refus(
        await api.raw.post('/archives/lendings', {
          ...valide,
          startDate: jourIso(3),
          projectedReturnDate: jourIso(10),
        }),
      );
      expect(futur.statut).toBe(400);
      expect(futur.corps).toContain('La date de début ne peut pas être future');

      // ANO-ARC-T3-01 : un motif inconnu provoquait une 500 (clé étrangère).
      const motifInconnu = await refus(
        await api.raw.post('/archives/lendings', { ...valide, lendingMotiveId: 2_000_000_000 }),
      );
      expect(motifInconnu.statut).toBe(404);
      expect(motifInconnu.corps).toContain('Motif de prêt introuvable');

      const beneficiaireInconnu = await refus(
        await api.raw.post('/archives/lendings', { ...valide, userGroupId: 2_000_000_000 }),
      );
      expect(beneficiaireInconnu.statut).toBe(404);
      expect(beneficiaireInconnu.corps).toContain('Bénéficiaire introuvable');

      const documentInconnu = await refus(
        await api.raw.post('/archives/lendings', { ...valide, documentIds: [2_000_000_000] }),
      );
      expect(documentInconnu.statut).toBe(404);
      expect(documentInconnu.corps).toContain('introuvable');

      // Aucun de ces refus n'a laissé de prêt derrière lui.
      expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId)).toEqual([
        doc!.documentId,
      ]);
      expect(await pretsListes(api, 'out', u)).toEqual([]);
    });
  });

  test('ARC-27 un document déjà communiqué n’est plus proposé et ne peut pas l’être deux fois', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const u = uniq('ARC-27');
    const { dossierId, dossierLabel, documents } = await dossierAvecDocuments(api, u, 3);
    const [sorti, convoite, autre] = documents as [
      (typeof documents)[0],
      (typeof documents)[0],
      (typeof documents)[0],
    ];
    const motif = await creerMotifPret(api, `${u} motif`);
    const emprunteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-emp`,
      menus: [MENUS.mesCommuniques],
    });
    const beneficiaire = await acteur(api, await compteGroupeDe(api, apiAs, emprunteur));
    const base = {
      userGroupId: beneficiaire.userGroupId,
      lendingMotiveId: motif.lendingMotiveId,
    };
    await creerPret(api, { ...base, documentIds: [sorti.documentId] });

    await test.step('le document sorti n’est pas proposé', async () => {
      await ouvrirCommuniquer(page, dossierId, dossierLabel);
      await expect(page.getByText('2 document(s) communicable(s)')).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: sorti.label })).toHaveCount(0);
    });

    await test.step('sorti entre-temps par un autre agent : refus affiché, liste rafraîchie', async () => {
      await page.getByRole('row').filter({ hasText: convoite.label }).getByRole('checkbox').check();
      await choisirDansListe(
        page,
        page.getByRole('combobox', { name: 'Bénéficiaire', exact: true }),
        beneficiaire.nom,
      );
      await choisirDansListe(
        page,
        page.getByRole('combobox', { name: 'Motif', exact: true }),
        motif.label,
      );
      await expect(boutonCommuniquer(page)).toBeEnabled();

      await creerPret(api, { ...base, documentIds: [convoite.documentId] });

      const creation = page.waitForResponse(estCreationDePret);
      const relecture = attendreListe(page, `/archives/lendings/dossiers/${dossierId}/documents`);
      await boutonCommuniquer(page).click();
      expect((await creation).status()).toBe(409);
      await expect(
        page.getByText(`Document(s) déjà communiqué(s) et non rendu(s) : ${convoite.label}`),
      ).toBeVisible();
      expect((await relecture).status()).toBe(200);
      await expect(page.getByText('1 document(s) communicable(s)')).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: convoite.label })).toHaveCount(0);
      await expect(page).toHaveURL(/\/archives\/communiquer$/);
    });

    await test.step('API : second prêt refusé en bloc, doublon de sélection, document épuré', async () => {
      const double = await api.raw.post(
        '/archives/lendings',
        corpsPret({ ...base, documentIds: [autre.documentId, sorti.documentId] }),
      );
      expect(double.status()).toBe(409);
      expect(await double.text()).toContain(sorti.label);
      // Refus EN BLOC : le document libre de la même demande n'est pas sorti pour autant.
      expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId)).toEqual([
        autre.documentId,
      ]);

      // ANO-ARC-T3-04 : le même document deux fois dans une demande créait deux sorties.
      const pret = await creerPret(api, {
        ...base,
        documentIds: [autre.documentId, autre.documentId],
      });
      expect(pret.details.map((d) => d.documentId)).toEqual([autre.documentId]);
      expect(
        (await pretsListes(api, 'out', u)).filter((r) => r.documentId === autre.documentId),
      ).toHaveLength(1);

      // Un document épuré n'est pas communicable.
      const epure = (await dossierAvecDocuments(api, `${u}-epure`, 1)).documents[0]!;
      await poserDua(api, epure.documentId, -2);
      expect(
        await api.post('/archives/dua-expired/purge', { documentIds: [epure.documentId] }),
      ).toEqual({ purged: 1, blocked: [] });
      const refuse = await api.raw.post(
        '/archives/lendings',
        corpsPret({ ...base, documentIds: [epure.documentId] }),
      );
      expect(refuse.status()).toBe(409);
      expect(await refuse.text()).toContain('épuré');
    });
  });
});

test.describe('Listes de communications, retour et commentaires', () => {
  test('ARC-24 retour document par document depuis « Documents communiqués », puis historique', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const u = uniq('ARC-24');
    const { dossierId, documents } = await dossierAvecDocuments(api, u, 2);
    const [premier, second] = documents as [(typeof documents)[0], (typeof documents)[0]];
    const motif = await creerMotifPret(api, `${u} motif`);
    const emprunteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-emp`,
      menus: [MENUS.mesCommuniques],
    });
    const beneficiaire = await acteur(api, await compteGroupeDe(api, apiAs, emprunteur));
    const pret = await creerPret(api, {
      documentIds: [premier.documentId, second.documentId],
      userGroupId: beneficiaire.userGroupId,
      lendingMotiveId: motif.lendingMotiveId,
    });

    await page.goto('/archives/documents-communiques');
    await rechercherDansListe(page, INVITE_PRETS, '/archives/lendings/out', u);
    await expect(page.getByRole('row').filter({ hasText: u })).toHaveCount(2);

    const rendreALecran = async (label: string, message: string) => {
      const retour = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/lendings\/details\/\d+\/return$/.test(r.url()),
      );
      await page
        .getByRole('row')
        .filter({ hasText: label })
        .getByRole('button', { name: 'Retour' })
        .click();
      await page.getByRole('button', { name: 'Enregistrer le retour' }).click();
      expect((await retour).status()).toBe(200);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: label })).toHaveCount(0);
    };

    // Premier document rendu : la communication reste ouverte (un document encore dehors).
    await rendreALecran(premier.label, 'Document retourné');
    await expect(page.getByRole('row').filter({ hasText: second.label })).toHaveCount(1);
    const detail = (await api.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
      returnedDate: string | null;
      details: Array<{ documentId: number; returnedDate: string | null }>;
    };
    expect(detail.returnedDate).toBeNull();

    await rendreALecran(second.label, 'Document retourné — la communication est close');
    const clos = (await api.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
      returnedDate: string | null;
      details: Array<{ returnedDate: string | null }>;
    };
    expect(clos.returnedDate).not.toBeNull();
    expect(clos.details.every((d) => d.returnedDate != null)).toBe(true);

    // Historique : les deux documents, retour effectif daté, aucune action possible.
    await page.goto('/archives/historique-communications');
    await expect(
      page.getByRole('heading', { name: 'Historique des documents communiqués' }),
    ).toBeVisible();
    await rechercherDansListe(page, INVITE_PRETS, '/archives/lendings/history', u);
    const lignes = page.getByRole('row').filter({ hasText: u });
    await expect(lignes).toHaveCount(2);
    await expect(lignes.filter({ hasText: 'en cours' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retour' })).toHaveCount(0);
    await expect(lignes.first()).toContainText(beneficiaire.nom);

    // Retour d'un document déjà rendu : refusé, la date réelle de retour est préservée.
    const detailId = pret.details[0]!.lendingDocumentDetailId;
    const avant = (await pretsListes(api, 'history', premier.label))[0]!.returnedDate;
    const rejoue = await api.raw.post(`/archives/lendings/details/${detailId}/return`, {});
    expect(rejoue.status()).toBe(409);
    expect((await pretsListes(api, 'history', premier.label))[0]!.returnedDate).toBe(avant);
    expect((await api.raw.post('/archives/lendings/details/2000000000/return', {})).status()).toBe(
      404,
    );

    // Les deux documents sont de nouveau communicables.
    expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId).sort()).toEqual(
      [premier.documentId, second.documentId].sort(),
    );
  });

  test('ARC-25 commente une communication et relit ses commentaires (API)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = uniq('ARC-25');
    const {
      documents: [doc],
    } = await dossierAvecDocuments(api, u, 1);
    const motif = await creerMotifPret(api, `${u} motif`);
    // Un agent de la liste « Documents communiqués », avec un acteur (le commentaire est signé).
    const agent = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-agent`,
      menus: [MENUS.communiques],
    });
    const compteAgent = await compteGroupeDe(api, apiAs, agent);
    const clientAgent = await apiAs(agent.username, agent.password);
    const lecteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-histo`,
      menus: [MENUS.historique],
    });
    const clientLecteur = await apiAs(lecteur.username, lecteur.password);

    const pret = await creerPret(api, {
      documentIds: [doc!.documentId],
      userGroupId: compteAgent,
      lendingMotiveId: motif.lendingMotiveId,
    });
    const texte = `${u} : rappel envoyé, retour annoncé pour vendredi`;

    const cree = await clientAgent.raw.post('/archives/lendings/comments', {
      lendingDocumentId: pret.lendingDocumentId,
      comments: `  ${texte}  `,
    });
    expect(cree.status()).toBe(201);

    const lu = (await clientLecteur.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
      lendingDocumentId: number;
      motive: { label: string } | null;
      details: Array<{ documentId: number }>;
      comments: Array<{ comments: string; userGroupId: number }>;
    };
    expect(lu.motive?.label).toBe(motif.label);
    expect(lu.details.map((d) => d.documentId)).toEqual([doc!.documentId]);
    expect(lu.comments.map((c) => [c.comments, c.userGroupId])).toEqual([[texte, compteAgent]]);

    // Erreurs de saisie et cibles inexistantes.
    for (const comments of ['', '   ', 'x'.repeat(2001)]) {
      const r = await clientAgent.raw.post('/archives/lendings/comments', {
        lendingDocumentId: pret.lendingDocumentId,
        comments,
      });
      expect(r.status(), `commentaire de ${comments.length} caractère(s)`).toBe(400);
    }
    expect(
      (
        await clientAgent.raw.post('/archives/lendings/comments', {
          lendingDocumentId: 2_000_000_000,
          comments: texte,
        })
      ).status(),
    ).toBe(404);
    expect((await clientLecteur.raw.get('/archives/lendings/2000000000')).status()).toBe(404);

    // L'historique est en consultation seule : pas de commentaire depuis ce seul menu.
    expect(
      (
        await clientLecteur.raw.post('/archives/lendings/comments', {
          lendingDocumentId: pret.lendingDocumentId,
          comments: texte,
        })
      ).status(),
    ).toBe(403);
    const relu = (await api.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
      comments: unknown[];
    };
    expect(relu.comments).toHaveLength(1);
  });

  test.fixme('ARC-25 saisit et lit les commentaires d’une communication à l’écran', async () => {}); // l'agent doit-il saisir et lire les commentaires d'un prêt ? // `GET /archives/lendings/:id` (ni LendingListPage, ni l'onglet « Prêts » de la fiche). Où // Question métier : aucune page ne consomme `POST /archives/lendings/comments` ni

  test('ARC-28 « Mes documents communiqués » ne montre que les prêts de l’utilisateur connecté', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-28');
    const {
      documents: [doc],
    } = await dossierAvecDocuments(api, u, 1);
    const motif = await creerMotifPret(api, `${u} motif`);
    const titulaire = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-tit`,
      menus: [MENUS.mesCommuniques],
    });
    const voisin = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-vois`,
      menus: [MENUS.mesCommuniques],
    });
    await compteGroupeDe(api, apiAs, voisin);
    const compteTitulaire = await compteGroupeDe(api, apiAs, titulaire);
    await creerPret(api, {
      documentIds: [doc!.documentId],
      userGroupId: compteTitulaire,
      lendingMotiveId: motif.lendingMotiveId,
    });

    const clientTitulaire = await apiAs(titulaire.username, titulaire.password);
    const clientVoisin = await apiAs(voisin.username, voisin.password);
    expect((await pretsListes(clientTitulaire, 'mine', u)).map((r) => r.documentId)).toEqual([
      doc!.documentId,
    ]);
    expect(await pretsListes(clientVoisin, 'mine', u)).toEqual([]);
    // Le menu « Mes documents » n'ouvre pas la liste de tous les prêts.
    expect((await clientVoisin.raw.get('/archives/lendings/out')).status()).toBe(403);

    await loginAs(page, voisin.username, voisin.password);
    await page.goto('/archives/mes-documents-communiques');
    await rechercherDansListe(page, INVITE_PRETS, '/archives/lendings/mine', u);
    await expect(page.getByText('Aucune communication en cours')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: doc!.label })).toHaveCount(0);
  });

  test('ARC-28 avec le seul menu « Mes documents communiqués », on ne lit, ne commente et ne rend que ses propres prêts', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // ANO-ARC-T3-05 (corrigée) : `returnDetail`, `getLending` et `addComment` acceptaient le seul
    // menu « Mes documents communiqués » sans vérifier que le prêt était celui de l'appelant.
    // Décision : même périmètre que la liste `listMine` (la personne bénéficiaire) ; le prêt
    // d'autrui répond 404 « Prêt introuvable », comme un identifiant inexistant, pour ne pas
    // révéler son existence. « Documents communiqués » (archiviste) garde tout le périmètre.
    const u = uniq('ARC-28b');
    const {
      documents: [doc],
    } = await dossierAvecDocuments(api, u, 1);
    const motif = await creerMotifPret(api, `${u} motif`);
    const titulaire = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-tit`,
      menus: [MENUS.mesCommuniques],
    });
    const intrus = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-intr`,
      menus: [MENUS.mesCommuniques],
    });
    await compteGroupeDe(api, apiAs, intrus);
    const pret = await creerPret(api, {
      documentIds: [doc!.documentId],
      userGroupId: await compteGroupeDe(api, apiAs, titulaire),
      lendingMotiveId: motif.lendingMotiveId,
    });
    // Clients ouverts APRÈS l'affectation du compte-groupe : leur jeton porte l'acteur.
    const clientIntrus = await apiAs(intrus.username, intrus.password);
    const clientTitulaire = await apiAs(titulaire.username, titulaire.password);
    const detailId = pret.details[0]!.lendingDocumentDetailId;
    const message = async (r: { json(): Promise<unknown> }) =>
      ((await r.json()) as { message?: unknown }).message;

    await test.step('le prêt d’autrui est introuvable : ni rendu, ni lu, ni commenté', async () => {
      const retour = await clientIntrus.raw.post(
        `/archives/lendings/details/${detailId}/return`,
        {},
      );
      expect(retour.status()).toBe(404);
      expect(await message(retour)).toBe('Prêt introuvable');
      const lecture = await clientIntrus.raw.get(`/archives/lendings/${pret.lendingDocumentId}`);
      expect(lecture.status()).toBe(404);
      // Indiscernable d'un identifiant inexistant.
      const inexistant = await clientIntrus.raw.get('/archives/lendings/2000000000');
      expect(inexistant.status()).toBe(404);
      expect(await message(lecture)).toBe(await message(inexistant));
      const commentaire = await clientIntrus.raw.post('/archives/lendings/comments', {
        lendingDocumentId: pret.lendingDocumentId,
        comments: `${u} intrusion`,
      });
      expect(commentaire.status()).toBe(404);
      expect(await message(commentaire)).toBe('Prêt introuvable');

      // Rien n'a changé : toujours en sortie, aucun commentaire.
      expect((await pretsListes(api, 'out', u)).map((r) => r.returnedDate)).toEqual([null]);
      const relu = (await api.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
        comments: unknown[];
      };
      expect(relu.comments).toEqual([]);
    });

    await test.step('son propre prêt passe : le bénéficiaire le lit, le commente et le rend', async () => {
      const lu = (await clientTitulaire.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
        lendingDocumentId: number;
        details: Array<{ documentId: number }>;
      };
      expect(lu.lendingDocumentId).toBe(pret.lendingDocumentId);
      expect(lu.details.map((d) => d.documentId)).toEqual([doc!.documentId]);

      const texte = `${u} retour prévu vendredi`;
      const commente = await clientTitulaire.raw.post('/archives/lendings/comments', {
        lendingDocumentId: pret.lendingDocumentId,
        comments: texte,
      });
      expect(commente.status()).toBe(201);

      const rendu = await clientTitulaire.raw.post(
        `/archives/lendings/details/${detailId}/return`,
        {},
      );
      expect(rendu.status()).toBe(200);
      expect(((await rendu.json()) as { lendingClosed: boolean }).lendingClosed).toBe(true);

      const relu = (await api.get(`/archives/lendings/${pret.lendingDocumentId}`)) as {
        comments: Array<{ comments: string }>;
        details: Array<{ returnedDate: string | null }>;
      };
      expect(relu.comments.map((c) => c.comments)).toEqual([texte]);
      expect(relu.details.map((d) => d.returnedDate)).not.toContain(null);
      expect(await pretsListes(api, 'out', u)).toEqual([]);
    });
  });
});

test.describe('Communications — refus par permission', () => {
  /** Les quatre écrans de la communication, leur route de liste et leur libellé de navigation. */
  const ECRANS = [
    {
      menu: MENUS.communiques,
      url: '/archives/documents-communiques',
      route: '/archives/lendings/out',
      nav: 'Documents communiqués',
    },
    {
      menu: MENUS.mesCommuniques,
      url: '/archives/mes-documents-communiques',
      route: '/archives/lendings/mine',
      nav: 'Mes documents communiqués',
    },
    {
      menu: MENUS.historique,
      url: '/archives/historique-communications',
      route: '/archives/lendings/history',
      nav: 'Historique des communications',
    },
  ] as const;

  for (const ecran of ECRANS) {
    test(`ARC-33 sans le menu, l’écran ${ecran.url} et sa liste sont refusés`, async ({
      page,
      api,
      apiAs,
      loginAs,
      uniq,
    }) => {
      const u = uniq('ARC-33');
      const sans = await creerUtilisateurAvecMenus(api, {
        prefix: `${u}-sans`,
        menus: [MENUS.autre],
      });
      const avec = await creerUtilisateurAvecMenus(api, {
        prefix: `${u}-avec`,
        menus: [ecran.menu],
      });
      expect(
        (await (await apiAs(sans.username, sans.password)).raw.get(ecran.route)).status(),
      ).toBe(403);
      // Contrôle positif : le menu suffit, sans être administrateur.
      expect(
        (await (await apiAs(avec.username, avec.password)).raw.get(ecran.route)).status(),
      ).toBe(200);

      await loginAs(page, sans.username, sans.password);
      const liste = attendreListe(page, ecran.route);
      await page.goto(ecran.url);
      expect((await liste).status()).toBe(403);
      await expect(page.getByText(REFUS_MENU).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Retour' })).toHaveCount(0);
      await expect(page.getByRole('menuitem', { name: ecran.nav, exact: true })).toHaveCount(0);
    });
  }

  test('ARC-33 sans le menu, « Communiquer un document » refuse la liste du dossier et la création', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-33');
    const {
      dossierId,
      dossierLabel,
      documents: [doc],
    } = await dossierAvecDocuments(api, u, 1);
    const motif = await creerMotifPret(api, `${u} motif`);
    const sans = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-sans`,
      menus: [MENUS.autre],
    });
    const avec = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-avec`,
      menus: [MENUS.communiquer],
    });
    const compteSans = await compteGroupeDe(api, apiAs, sans);
    const corps = corpsPret({
      documentIds: [doc!.documentId],
      userGroupId: compteSans,
      lendingMotiveId: motif.lendingMotiveId,
    });

    const clientSans = await apiAs(sans.username, sans.password);
    expect(
      (await clientSans.raw.get(`/archives/lendings/dossiers/${dossierId}/documents`)).status(),
    ).toBe(403);
    expect((await clientSans.raw.post('/archives/lendings', corps)).status()).toBe(403);
    expect(await pretsListes(api, 'out', u)).toEqual([]);
    const clientAvec = await apiAs(avec.username, avec.password);
    expect(
      (await clientAvec.raw.get(`/archives/lendings/dossiers/${dossierId}/documents`)).status(),
    ).toBe(200);

    await loginAs(page, sans.username, sans.password);
    const liste = await ouvrirCommuniquer(page, dossierId, dossierLabel);
    expect(liste.status()).toBe(403);
    await expect(page.getByText(REFUS_MENU).first()).toBeVisible();
    await expect(page.getByText('Aucun document communicable dans ce dossier')).toBeVisible();
    await expect(boutonCommuniquer(page)).toBeDisabled();
    await expect(
      page.getByRole('menuitem', { name: 'Communiquer un document', exact: true }),
    ).toHaveCount(0);
  });

  test('ARC-34 les menus de consultation n’ouvrent ni la communication ni le retour', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const u = uniq('ARC-34');
    const {
      dossierId,
      documents: [doc, libre],
    } = await dossierAvecDocuments(api, u, 2);
    const motif = await creerMotifPret(api, `${u} motif`);
    // Toutes les listes, sauf l'écran « Communiquer ».
    const lecteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-lect`,
      menus: [MENUS.communiques, MENUS.mesCommuniques, MENUS.historique],
    });
    // L'écran « Communiquer » et l'historique, sans les deux listes de travail qui portent le retour.
    const guichet = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-guich`,
      menus: [MENUS.communiquer, MENUS.historique],
    });
    const compteLecteur = await compteGroupeDe(api, apiAs, lecteur);
    const pret = await creerPret(api, {
      documentIds: [doc!.documentId],
      userGroupId: compteLecteur,
      lendingMotiveId: motif.lendingMotiveId,
    });

    const clientLecteur = await apiAs(lecteur.username, lecteur.password);
    expect(
      (await clientLecteur.raw.get(`/archives/lendings/dossiers/${dossierId}/documents`)).status(),
    ).toBe(403);
    expect(
      (
        await clientLecteur.raw.post(
          '/archives/lendings',
          corpsPret({
            documentIds: [libre!.documentId],
            userGroupId: compteLecteur,
            lendingMotiveId: motif.lendingMotiveId,
          }),
        )
      ).status(),
    ).toBe(403);

    const clientGuichet = await apiAs(guichet.username, guichet.password);
    const detailId = pret.details[0]!.lendingDocumentDetailId;
    expect(
      (await clientGuichet.raw.post(`/archives/lendings/details/${detailId}/return`, {})).status(),
    ).toBe(403);

    // Rien n'a bougé : le document libre reste communicable, le prêt reste en cours.
    expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId)).toEqual([
      libre!.documentId,
    ]);
    expect((await pretsListes(api, 'out', u)).map((r) => [r.documentId, r.returnedDate])).toEqual([
      [doc!.documentId, null],
    ]);
    // Contrôle positif : le retour par la liste de travail fonctionne pour le même prêt.
    expect((await rendre(clientLecteur, detailId)).lendingClosed).toBe(true);
  });
});
