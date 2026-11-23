/**
 * Acquisition par lot : écran `/acquisition`, routes `/batches`, traitement par le worker BullMQ
 * (découpage QR, fusion, échec, retraitement). Spécification : spec.md FR-008 à FR-020.
 *
 * L'écran n'expose plus que le mode « sans intercalaire » (tous les PDF fusionnés en un document) ;
 * le découpage par QR se pilote par l'API (`useIntercalaires: true`) — c'est ainsi qu'il est testé
 * ici. Le parcours ARC-01 (parcours-complet.spec.ts) le fait traverser à l'écran réel.
 */
import type { Request } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import {
  fabriquerLot,
  fichierPdf,
  fichierPdfIllisible,
  fichierTexte,
  genererIntercalaires,
  nomDeFichier,
  pdfDeContenu,
} from './_helpers/lot-pdf';
import {
  DELAI_WORKER,
  STATUT_LOT,
  acquerirParApi,
  attendreFinDuTraitement,
  choisirOption,
  creerDossier,
  creerLocalisation,
  creerLot,
  creerPlan,
  creerTypeDocument,
  creerTypeParametre,
  deposerFichiers,
  documentsDuLot,
  fenetreIndexation,
  lancerAcquisitionParEcran,
  libelleDocument,
  motUnique,
  rechercher,
  selectParInvite,
  statutDuLot,
  validerDepuisIndexation,
  validerDocuments,
  type DocumentDuLot,
} from './_helpers/lots';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

const resume = (d: DocumentDuLot) => ({
  label: d.label,
  type: d.documentTypeId,
  dossier: d.dossierId,
  plan: d.planId,
  pages: d.file?.pageCount ?? null,
});

test.describe('Acquisition par lot — écran', () => {
  test('ARC-06 acquiert 11 PDF par l’écran, envoyés par paquets, fusionnés puis validés', async ({
    page,
    api,
    uniq,
  }) => {
    test.setTimeout(DELAI_WORKER + 60_000);
    const u = uniq('ARC-06');
    const { type, dossier, plan } = await creerTypeParametre(api, u);
    const bases = Array.from({ length: 11 }, (_, i) => `${u}-${String(i + 1).padStart(2, '0')}`);
    const fichiers = await Promise.all(
      bases.map(async (b, i) =>
        fichierPdf(b, await pdfDeContenu([`Piece numero ${i + 1} du lot, page unique.`])),
      ),
    );

    // L'écran envoie par paquets de 10 : seul le dernier envoi déclenche le traitement.
    const envois: string[] = [];
    const surRequete = (r: Request) => {
      const url = new URL(r.url());
      if (r.method() === 'POST' && /\/api\/batches\/\d+\/files$/.test(url.pathname)) {
        envois.push(url.searchParams.get('finalize') ?? '');
      }
    };
    page.on('request', surRequete);

    const creation = await lancerAcquisitionParEcran(page, type.label, fichiers);
    expect(creation.status()).toBe(201);
    // Destination préremplie par le paramétrage du type ; mode normal (seul mode de l'écran).
    expect(creation.request().postDataJSON()).toMatchObject({
      documentTypeId: type.id,
      dossierId: dossier.id,
      planId: plan.id,
      useIntercalaires: false,
    });
    const { batchId } = (await creation.json()) as { batchId: number };
    await expect(page.getByText(`Lot #${batchId}`)).toBeVisible();

    // Fin du traitement : la fenêtre d'indexation s'ouvre seule, sur l'unique document fusionné.
    const fenetre = fenetreIndexation(page, batchId);
    await expect(fenetre).toBeVisible({ timeout: DELAI_WORKER });
    await expect(fenetre.getByText('Indexation du document')).toBeVisible();
    await expect(fenetre.getByText(type.label, { exact: true })).toBeVisible();
    await expect(fenetre.getByText(plan.label, { exact: true })).toBeVisible();
    await expect(fenetre.getByText(dossier.label, { exact: true })).toBeVisible();
    page.off('request', surRequete);
    expect(envois).toEqual(['false', 'true']);

    await validerDepuisIndexation(page, 1);

    expect(await statutDuLot(api, batchId)).toMatchObject({
      status: STATUT_LOT.traite,
      fileCount: 11,
      processedFiles: 11,
      documentCount: 1,
      useIntercalaires: false,
    });
    const docs = await documentsDuLot(api, batchId);
    expect(docs.map(resume)).toEqual([
      {
        // Libellé repris du premier fichier (préfixe de tri retiré), 11 pages dans l'ordre.
        label: nomDeFichier(bases[0]!, ''),
        type: type.id,
        dossier: dossier.id,
        plan: plan.id,
        pages: 11,
      },
    ]);
    expect(docs[0]!.isArchived).toBe(true);
  });

  test('ARC-10 signale à l’écran l’échec d’un lot dont le seul PDF est illisible', async ({
    page,
    api,
    uniq,
  }) => {
    test.setTimeout(DELAI_WORKER + 60_000);
    const u = uniq('ARC-10');
    const { type } = await creerTypeParametre(api, u);

    // Fichier nommé et typé PDF, mais sans contenu PDF : l'écran l'accepte, le worker non.
    const reponse = await lancerAcquisitionParEcran(page, type.label, [
      fichierPdfIllisible(`${u}-faux`),
    ]);
    expect(reponse.status()).toBe(201);
    const { batchId } = (await reponse.json()) as { batchId: number };

    // Avant ANO-ARC-T1-02, un document à zéro page était créé et le lot marqué « traité ».
    await expect(page.getByText('Le traitement du lot a échoué', { exact: true })).toBeVisible({
      timeout: DELAI_WORKER,
    });
    await expect(page.getByRole('button', { name: 'Relancer le traitement' })).toBeVisible();
    await expect(fenetreIndexation(page, batchId)).toHaveCount(0);
    expect((await statutDuLot(api, batchId)).status).toBe(STATUT_LOT.echec);
    expect(await documentsDuLot(api, batchId)).toEqual([]);

    // « Nouveau lot » remet l'écran à la première étape, type à choisir de nouveau.
    await page.getByRole('button', { name: 'Nouveau lot' }).click();
    await expect(
      page.getByRole('heading', { name: 'Quels documents allez-vous numériser ?' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continuer' })).toBeDisabled();
  });

  test('ARC-10 écarte un fichier non PDF dès l’ajout à l’écran', async ({ page, api, uniq }) => {
    const u = uniq('ARC-10-txt');
    const { type } = await creerTypeParametre(api, u);
    await page.goto('/acquisition');
    await expect(page.getByRole('heading', { name: 'Acquisition par lot' })).toBeVisible();
    await choisirOption(
      page,
      selectParInvite(page, 'Sélectionnez le type de document du lot'),
      type.label,
    );
    const continuer = page.getByRole('button', { name: 'Continuer' });
    await expect(continuer).toBeEnabled();
    await continuer.click();

    const creations: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/batches$/.test(new URL(r.url()).pathname)) {
        creations.push(r.url());
      }
    });
    await page.locator('input[type="file"]').setInputFiles([fichierTexte(`${u}-note`)]);
    await expect(page.getByText('Seuls les fichiers PDF sont acceptés.')).toBeVisible();
    await expect(page.getByText(/fichier\(s\) sélectionné\(s\)/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lancer le traitement' })).toBeDisabled();
    expect(creations).toEqual([]);
  });

  test('ARC-12 refuse l’acquisition à un compte sans le menu Acquisition par lot', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-12');
    const { type } = await creerTypeParametre(api, u);
    const sans = await creerUtilisateurAvecMenus(api, { prefix: `${u}-sans`, menus: ['/search'] });
    const avec = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-avec`,
      menus: ['/acquisition'],
    });
    const lotAdmin = await creerLot(api, {});

    // API : chaque route du lot est refusée sans le menu (ANO-ARC-T1-01) — y compris la lecture
    // des documents d'un lot d'autrui et le retraitement, qui supprime et recrée ces documents.
    const clientSans = await apiAs(sans.username, sans.password);
    expect((await clientSans.raw.post('/batches', {})).status()).toBe(403);
    expect((await clientSans.raw.get(`/batches/${lotAdmin.batchId}`)).status()).toBe(403);
    expect((await clientSans.raw.get(`/batches/${lotAdmin.batchId}/documents`)).status()).toBe(403);
    expect((await clientSans.raw.post(`/batches/${lotAdmin.batchId}/reprocess`, {})).status()).toBe(
      403,
    );
    expect((await clientSans.raw.post(`/batches/${lotAdmin.batchId}/files`, {})).status()).toBe(
      403,
    );

    // Contrôle positif : le menu suffit, sans être administrateur.
    const clientAvec = await apiAs(avec.username, avec.password);
    const cree = await clientAvec.raw.post('/batches', {});
    expect(cree.status()).toBe(201);
    const { batchId } = (await cree.json()) as { batchId: number };
    expect((await clientAvec.raw.get(`/batches/${batchId}`)).status()).toBe(200);

    // Écran : le compte sans menu va jusqu'au lancement, qui est refusé et expliqué.
    await loginAs(page, sans.username, sans.password);
    const pdf = await pdfDeContenu(["Contenu d'un lot qui ne doit pas être créé."]);
    const refus = await lancerAcquisitionParEcran(page, type.label, [fichierPdf(`${u}-lot`, pdf)]);
    expect(refus.status()).toBe(403);
    await expect(page.getByText("Vous n'avez pas accès à cette section.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lancer le traitement' })).toBeVisible();
  });
});

test.describe('Acquisition par lot — découpage QR par le worker', () => {
  test('ARC-07 découpe un lot selon ses intercalaires TYPE, BLANK, DOSSIER, PLAN et LOCALISATION', async ({
    api,
    uniq,
  }) => {
    test.setTimeout(DELAI_WORKER + 60_000);
    const u = uniq('ARC-07');
    const typeA = await creerTypeDocument(api, `${u} type A`);
    const typeB = await creerTypeDocument(api, `${u} type B`);
    const dossierLot = await creerDossier(api, `${u} dossier du lot`);
    const dossierQr = await creerDossier(api, `${u} dossier QR`);
    const planQr = await creerPlan(api, `${u} plan QR`);
    const lieu = await creerLocalisation(api, `${u} localisation`, `${u}-L`);
    const mots = {
      avant: motUnique(`${u}-avant`),
      un: motUnique(`${u}-un`),
      deux: motUnique(`${u}-deux`),
      trois: motUnique(`${u}-trois`),
    };

    const types = await genererIntercalaires(api, 'TYPE_DOCUMENT', [typeA.id, typeB.id]);
    const vierge = await genererIntercalaires(api, 'BLANK');
    const dossierF = await genererIntercalaires(api, 'DOSSIER', [dossierQr.id]);
    const planF = await genererIntercalaires(api, 'PLAN', [planQr.id]);
    const lieuF = await genererIntercalaires(api, 'LOCALISATION', [lieu.id]);
    const lot = await fabriquerLot([
      { contenu: `Page lue avant tout intercalaire, ${mots.avant}.` },
      { feuille: types, page: 0 },
      { contenu: `Premier document type A, page une, ${mots.un}.` },
      { contenu: 'Premier document type A, page deux, suite.' },
      { feuille: vierge },
      { contenu: `Document suivant le separateur vierge, ${mots.deux}.` },
      { feuille: dossierF },
      { feuille: planF },
      { feuille: lieuF },
      { feuille: types, page: 1 },
      { contenu: `Document du type B dans le dossier QR, ${mots.trois}.` },
    ]);

    const {
      lot: cree,
      statut,
      documents,
    } = await acquerirParApi(api, { dossierId: dossierLot.id, useIntercalaires: true }, [
      fichierPdf(`${u}-liasse`, lot),
    ]);
    const id = cree.batchId;
    expect(statut).toMatchObject({
      status: STATUT_LOT.traite,
      fileCount: 1,
      processedFiles: 1,
      documentCount: 4,
      useIntercalaires: true,
    });
    expect(documents.map(resume)).toEqual([
      // Edge case « pages avant le premier intercalaire » + FR-015 : document distinct, sans type.
      {
        label: libelleDocument(id, 1, true),
        type: null,
        dossier: dossierLot.id,
        plan: null,
        pages: 1,
      },
      // FR-013 : le type s'applique ; les feuilles d'intercalaires ne sont pas des pages du document.
      {
        label: libelleDocument(id, 2),
        type: typeA.id,
        dossier: dossierLot.id,
        plan: null,
        pages: 2,
      },
      // FR-014 : le séparateur vierge clôt le document sans changer d'attribut (type conservé).
      {
        label: libelleDocument(id, 3),
        type: typeA.id,
        dossier: dossierLot.id,
        plan: null,
        pages: 1,
      },
      // FR-016 : le dossier encodé prévaut sur celui du lot ; plan et type suivent leurs feuilles.
      {
        label: libelleDocument(id, 4),
        type: typeB.id,
        dossier: dossierQr.id,
        plan: planQr.id,
        pages: 1,
      },
    ]);
    // FR-018 : en attente de validation qualité.
    expect(documents.every((d) => !d.isArchived)).toBe(true);

    // Le texte de chaque page de contenu est rattaché au bon document (couche texte, sans OCR) :
    // la recherche plein texte, une fois les documents validés, le retrouve exactement.
    await validerDocuments(
      api,
      documents.map((d) => d.documentId),
    );
    const attendu: Array<[string, number]> = [
      [mots.avant, 0],
      [mots.un, 1],
      [mots.deux, 2],
      [mots.trois, 3],
    ];
    for (const [mot, rang] of attendu) {
      const res = await rechercher(api, { fullText: mot });
      expect(
        res.rows.map((r) => r.documentId),
        mot,
      ).toEqual([documents[rang]!.documentId]);
    }
    const dernier = await rechercher(api, { fullText: mots.trois });
    expect(dernier.rows[0]).toMatchObject({
      documentType: typeB.label,
      dossier: dossierQr.label,
      plan: planQr.label,
      location: lieu.label,
    });
  });

  test('ARC-08 retraite un lot sans créer de doublon', async ({ api, uniq }) => {
    test.setTimeout(2 * DELAI_WORKER + 30_000);
    const u = uniq('ARC-08');
    const type = await creerTypeDocument(api, `${u} type`);
    const dossier = await creerDossier(api, `${u} dossier`);
    const types = await genererIntercalaires(api, 'TYPE_DOCUMENT', [type.id]);
    const vierge = await genererIntercalaires(api, 'BLANK');
    const lot = await fabriquerLot([
      { feuille: types },
      { contenu: 'Premier document a retraiter, page une.' },
      { feuille: vierge },
      { contenu: 'Second document a retraiter, page une.' },
    ]);
    const { lot: cree, documents: avant } = await acquerirParApi(
      api,
      { dossierId: dossier.id, useIntercalaires: true },
      [fichierPdf(`${u}-liasse`, lot)],
    );
    expect(avant).toHaveLength(2);
    const anciens = new Set(avant.map((d) => d.documentId));

    expect(await api.post(`/batches/${cree.batchId}/reprocess`, {})).toEqual({
      batchId: cree.batchId,
      requeued: true,
    });

    // Le retraitement supprime puis recrée : on attend des documents NEUFS, lot terminé.
    await expect
      .poll(
        async () => {
          const [s, docs] = await Promise.all([
            statutDuLot(api, cree.batchId),
            documentsDuLot(api, cree.batchId),
          ]);
          return (
            s.status === STATUT_LOT.traite &&
            docs.length > 0 &&
            docs.every((d) => !anciens.has(d.documentId))
          );
        },
        { message: 'documents recréés par le retraitement', timeout: DELAI_WORKER },
      )
      .toBe(true);

    const apres = await documentsDuLot(api, cree.batchId);
    // FR-020 : même résultat, aucun doublon.
    expect(apres.map(resume)).toEqual(avant.map(resume));
    expect((await statutDuLot(api, cree.batchId)).documentCount).toBe(2);
  });

  test.fixme('ARC-08 retraitement d’un lot dont les documents sont déjà validés (archivés)', async () => {
    // Question métier (rapport T1) : aujourd'hui `processBatch` supprime les documents du lot
    // — même validés, prêtés, dotés d'un cycle de vie ou épurés — puis les recrée « en attente
    // de validation ». Faut-il refuser (409) le retraitement d'un lot validé, ou ne recréer que
    // les documents non validés ? Le test sera écrit selon la règle retenue.
  });

  test('ARC-09 range un lot sans aucun QR en un seul document « sans type »', async ({
    api,
    uniq,
  }) => {
    test.setTimeout(DELAI_WORKER + 30_000);
    const u = uniq('ARC-09');
    const dossier = await creerDossier(api, `${u} dossier`);
    const pdf = await pdfDeContenu([
      'Premiere page sans intercalaire du lot.',
      'Deuxieme page sans intercalaire du lot.',
      'Troisieme page sans intercalaire du lot.',
    ]);
    const { lot, statut, documents } = await acquerirParApi(
      api,
      { dossierId: dossier.id, useIntercalaires: true },
      [fichierPdf(`${u}-sans-qr`, pdf)],
    );
    expect(statut).toMatchObject({ status: STATUT_LOT.traite, documentCount: 1 });
    expect(documents.map(resume)).toEqual([
      {
        label: libelleDocument(lot.batchId, 1, true),
        type: null,
        dossier: dossier.id,
        plan: null,
        pages: 3,
      },
    ]);
  });

  test('ARC-09 applique le type du lot en repli quand aucun intercalaire ne le donne', async ({
    api,
    uniq,
  }) => {
    test.setTimeout(DELAI_WORKER + 30_000);
    const u = uniq('ARC-09-type');
    const dossier = await creerDossier(api, `${u} dossier`);
    const type = await creerTypeDocument(api, `${u} type`);
    const pdf = await pdfDeContenu(['Page unique sans intercalaire, type de repli.']);
    const { lot, documents } = await acquerirParApi(
      api,
      { dossierId: dossier.id, documentTypeId: type.id, useIntercalaires: true },
      [fichierPdf(`${u}-sans-qr`, pdf)],
    );
    expect(documents.map(resume)).toEqual([
      {
        label: libelleDocument(lot.batchId, 1),
        type: type.id,
        dossier: dossier.id,
        plan: null,
        pages: 1,
      },
    ]);
  });

  test('ARC-10 fait échouer le lot dont aucun fichier n’est un PDF lisible', async ({
    api,
    uniq,
  }) => {
    test.setTimeout(3 * DELAI_WORKER);
    const u = uniq('ARC-10-api');
    const dossier = await creerDossier(api, `${u} dossier`);

    // Fichier texte : déposé, mais aucun PDF à traiter → échec, rien de créé.
    for (const useIntercalaires of [true, false]) {
      const lot = await creerLot(api, { dossierId: dossier.id, useIntercalaires });
      await deposerFichiers(api, lot.batchId, [fichierTexte(`${u}-note`)]);
      expect(
        (await attendreFinDuTraitement(api, lot.batchId)).status,
        `texte, QR=${useIntercalaires}`,
      ).toBe(STATUT_LOT.echec);
      expect(await documentsDuLot(api, lot.batchId)).toEqual([]);
    }

    // PDF illisible en mode QR : le chargement échoue → échec.
    const lotQr = await creerLot(api, { dossierId: dossier.id, useIntercalaires: true });
    await deposerFichiers(api, lotQr.batchId, [fichierPdfIllisible(`${u}-faux`)]);
    expect((await attendreFinDuTraitement(api, lotQr.batchId)).status).toBe(STATUT_LOT.echec);
    expect(await documentsDuLot(api, lotQr.batchId)).toEqual([]);
  });

  test.fixme('ARC-10 lot normal mêlant PDF lisibles et un PDF illisible', async () => {
    // Question métier (rapport T1) : la fusion ignore EN SILENCE un fichier illisible quand
    // d'autres le sont (`mergePdfBytes`, « meilleur effort ») ; le lot passe « traité » sans
    // aucun signal, et des pages manquent au document archivé. Faut-il faire échouer le lot,
    // ou le traiter en signalant le fichier écarté (et où) ?
  });
});

test.describe('Acquisition par lot — saisies invalides', () => {
  test('ARC-11 refuse les créations et dépôts de lot invalides', async ({ api, uniq }) => {
    const u = uniq('ARC-11');
    const dossier = await creerDossier(api, `${u} dossier`);
    const inconnu = 2_000_000_000;

    const deuxDossiers = await api.raw.post('/batches', {
      dossierId: dossier.id,
      newDossier: { label: `${u} autre` },
    });
    expect(deuxDossiers.status()).toBe(400);

    const dossierInconnu = await api.raw.post('/batches', { dossierId: inconnu });
    expect(dossierInconnu.status()).toBe(400);
    expect(await dossierInconnu.text()).toContain('Dossier cible introuvable');

    const typeInconnu = await api.raw.post('/batches', { documentTypeId: inconnu });
    expect(typeInconnu.status()).toBe(400);
    expect(await typeInconnu.text()).toContain('Type de document introuvable');

    const planInconnu = await api.raw.post('/batches', { planId: inconnu });
    expect(planInconnu.status()).toBe(400);
    expect(await planInconnu.text()).toContain('Plan de classement introuvable');

    // FR-009 : anti-doublon sur le libellé d'un nouveau dossier actif.
    const nouveau = { newDossier: { label: `${u} nouveau dossier` } };
    expect((await api.raw.post('/batches', nouveau)).status()).toBe(201);
    const doublon = await api.raw.post('/batches', nouveau);
    expect(doublon.status()).toBe(409);
    expect(await doublon.text()).toContain('Un dossier actif porte déjà ce libellé');

    const lot = await creerLot(api, { dossierId: dossier.id });
    const sansFichier = await api.raw.post(`/batches/${lot.batchId}/files`, {});
    expect(sansFichier.status()).toBe(400);
    expect(await sansFichier.text()).toContain('Aucun fichier reçu');
    // Un dépôt refusé ne met rien en file : le lot reste ouvert, sans traitement.
    expect(await statutDuLot(api, lot.batchId)).toMatchObject({
      status: STATUT_LOT.enCours,
      fileCount: 0,
    });

    expect((await api.raw.get(`/batches/${inconnu}`)).status()).toBe(404);
    expect((await api.raw.get(`/batches/${inconnu}/documents`)).status()).toBe(404);
    expect((await api.raw.post(`/batches/${inconnu}/reprocess`, {})).status()).toBe(404);
    expect((await api.raw.post(`/batches/${inconnu}/files`, {})).status()).toBe(404);
  });
});
