/**
 * Parcours complet Docu-Archive (ARC-01), de la feuille d'intercalaires à l'intégrité :
 * génération à l'écran → lot scanné fabriqué → acquisition à l'écran → worker (découpage QR) →
 * indexation et validation → recherche multicritère à l'écran → export dans les quatre formats à
 * l'écran → communication puis retour → DUA échue → épuration à l'écran → intégrité.
 *
 * Seule entorse au « tout par l'écran » : le mode « avec intercalaires » n'y est plus proposé
 * (sélecteur retiré le 2026-09-16) ; `activerModeIntercalaires` bascule ce seul drapeau dans la
 * requête de création du lot, tout le reste passe par l'écran réel. La préparation (référentiels,
 * motif de prêt, cycle de vie échu) et les contrôles de fond passent par l'API.
 */
import { test, expect } from '../../fixtures';
import {
  estUnPdf,
  estUnZip,
  fabriquerLot,
  fichierPdf,
  nombreDePages,
  pdfContientTexte,
  texteOffice,
} from './_helpers/lot-pdf';
import {
  DELAI_WORKER,
  STATUT_LOT,
  activerModeIntercalaires,
  choisirDansListe,
  creerDossier,
  creerPlan,
  creerTypeDocument,
  dateIso,
  documentsDuLot,
  fenetreIndexation,
  genererIntercalairesParEcran,
  lancerAcquisitionParEcran,
  libelleDocument,
  motUnique,
  parametrerType,
  statutDuLot,
  telecharger,
  validerDepuisIndexation,
  type DocumentDuLot,
} from './_helpers/lots';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

interface LignePret {
  lendingDocumentDetailId: number;
  documentId: number;
  returnedDate: string | null;
}
interface LigneConformite {
  documentId: number;
  label: string;
}
interface Page_<T> {
  total: number;
  rows: T[];
}

const q = (texte: string) => encodeURIComponent(texte);

test('ARC-01 parcours complet : intercalaires, acquisition QR, recherche, exports, prêt, DUA, épuration, intégrité', async ({
  page,
  api,
  uniq,
}) => {
  test.setTimeout(300_000);
  const u = uniq('ARC-01');
  const mots = { a1: motUnique(`${u}-a1`), a3: motUnique(`${u}-a3`), b1: motUnique(`${u}-b1`) };

  // --- Préparation (API) : deux types, la destination du type A, un motif de prêt. ---
  const typeA = await creerTypeDocument(api, `${u} type A`);
  const typeB = await creerTypeDocument(api, `${u} type B`);
  const dossier = await creerDossier(api, `${u} dossier`);
  const plan = await creerPlan(api, `${u} plan`);
  await parametrerType(api, typeA.id, { dossierId: dossier.id, planId: plan.id });
  const motif = `${u} motif`;
  await api.post('/archives/settings/lending-motives', { labels: [motif] });
  const motifs = (await api.get('/archives/settings/lending-motives')) as Array<{
    lendingMotiveId: number;
    label: string;
  }>;
  const lendingMotiveId = motifs.find((m) => m.label === motif)?.lendingMotiveId;
  expect(lendingMotiveId, 'motif de prêt créé').toBeDefined();

  // --- 1. Feuilles d'intercalaires, générées à l'écran. ---
  const { feuillesTypes, feuilleVierge } =
    await test.step('génération des intercalaires', async () => {
      await page.goto('/intercalaires');
      await expect(page.getByRole('heading', { name: 'Génération d’intercalaires' })).toBeVisible();
      await page.getByRole('button', { name: 'Type de document', exact: true }).click();
      await page.getByPlaceholder('Filtrer les éléments…').fill(u);
      await expect(page.getByText(typeA.label, { exact: true })).toBeVisible();
      await expect(page.getByText(typeB.label, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Tout sélectionner' }).click();
      await expect(page.getByText('2 élément(s) sélectionné(s)')).toBeVisible();
      const types = await genererIntercalairesParEcran(page);
      expect(types.corps).toEqual({ category: 'TYPE_DOCUMENT', itemIds: [typeA.id, typeB.id] });
      expect(await nombreDePages(types.pdf)).toBe(2);

      await page.getByRole('button', { name: 'Séparateur vierge', exact: true }).click();
      const vierge = await genererIntercalairesParEcran(page);
      expect(vierge.corps).toEqual({ category: 'BLANK', itemIds: [] });
      return { feuillesTypes: types.pdf, feuilleVierge: vierge.pdf };
    });

  // --- 2. Le lot tel que le scanner le rendrait : intercalaires imprimés + pages de contenu. ---
  const liasse = await fabriquerLot([
    { feuille: feuillesTypes, page: 0 },
    { contenu: `Contrat type A, premiere page, ${mots.a1}.` },
    { contenu: 'Contrat type A, seconde page, annexes.' },
    { feuille: feuilleVierge },
    { contenu: `Avenant type A, page unique, ${mots.a3}.` },
    { feuille: feuillesTypes, page: 1 },
    { contenu: `Courrier type B, page unique, ${mots.b1}.` },
  ]);

  // --- 3. Acquisition à l'écran, traitement par le worker, indexation et validation. ---
  const { batchId, documents } = await test.step('acquisition et validation', async () => {
    await activerModeIntercalaires(page);
    const creation = await lancerAcquisitionParEcran(page, typeA.label, [
      fichierPdf(`${u}-liasse`, liasse),
    ]);
    expect(creation.status()).toBe(201);
    const { batchId } = (await creation.json()) as { batchId: number };
    const fenetre = fenetreIndexation(page, batchId);
    await expect(fenetre).toBeVisible({ timeout: DELAI_WORKER });
    await expect(fenetre).toHaveAccessibleName(`Indexation du lot #${batchId} — 3 documents`);
    for (let rang = 1; rang <= 3; rang += 1) {
      await expect(
        fenetre.getByRole('cell', { name: libelleDocument(batchId, rang), exact: true }),
      ).toBeVisible();
    }
    // Types différents dans le lot : le rappel de classement le dit au lieu d'en choisir un.
    await expect(fenetre.getByText('Plusieurs types dans ce lot')).toBeVisible();
    await validerDepuisIndexation(page, 3);

    expect(await statutDuLot(api, batchId)).toMatchObject({
      status: STATUT_LOT.traite,
      useIntercalaires: true,
      fileCount: 1,
      documentCount: 3,
    });
    const documents = await documentsDuLot(api, batchId);
    // Type : QR, puis type du lot en repli ; dossier et plan : ceux du lot (aucune feuille DOSSIER
    // ni PLAN dans la liasse) ; la feuille d'intercalaire n'est jamais une page du document.
    expect(
      documents.map((d: DocumentDuLot) => ({
        label: d.label,
        type: d.documentTypeId,
        dossier: d.dossierId,
        plan: d.planId,
        pages: d.file?.pageCount ?? null,
        archive: d.isArchived,
      })),
    ).toEqual([
      {
        label: libelleDocument(batchId, 1),
        type: typeA.id,
        dossier: dossier.id,
        plan: plan.id,
        pages: 2,
        archive: true,
      },
      {
        label: libelleDocument(batchId, 2),
        type: typeA.id,
        dossier: dossier.id,
        plan: plan.id,
        pages: 1,
        archive: true,
      },
      {
        label: libelleDocument(batchId, 3),
        type: typeB.id,
        dossier: dossier.id,
        plan: plan.id,
        pages: 1,
        archive: true,
      },
    ]);
    return { batchId, documents };
  });
  const [doc1] = documents as [DocumentDuLot, DocumentDuLot, DocumentDuLot];
  const libelle1 = libelleDocument(batchId, 1);
  const libelle2 = libelleDocument(batchId, 2);

  // --- 4. Recherche multicritère à l'écran : texte OCR + type de document. ---
  await test.step('recherche multicritère', async () => {
    await page.goto('/search');
    await page.getByRole('textbox', { name: 'Recherche plein texte' }).fill(mots.a1);
    await page.getByRole('button', { name: /Filtres avancés/ }).click();
    await choisirDansListe(
      page,
      page.getByRole('combobox', { name: 'Type de document', exact: true }),
      typeA.label,
    );
    const recherche = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/api/documents/search') &&
        (r.request().postDataJSON() as { fullText?: string }).fullText === mots.a1,
    );
    await page.getByRole('button', { name: 'Rechercher' }).click();
    const reponse = await recherche;
    expect(reponse.request().postDataJSON()).toMatchObject({
      fullText: mots.a1,
      documentTypeId: typeA.id,
    });
    expect(
      ((await reponse.json()) as Page_<{ documentId: number }>).rows.map((r) => r.documentId),
    ).toEqual([doc1.documentId]);

    await expect(page.getByText(`Texte : « ${mots.a1} »`)).toBeVisible();
    await expect(page.getByText(`Type : ${typeA.label}`)).toBeVisible();
    await expect(page.getByText('1 document(s)')).toBeVisible();
    await expect(page.getByRole('link', { name: libelle1, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: libelle2, exact: true })).toHaveCount(0);
  });

  // --- 5. Export des résultats dans chaque format, à l'écran ; contenu relu. ---
  await test.step('exports', async () => {
    const exporter = (menu: string) =>
      telecharger(page, async () => {
        await page.getByRole('button', { name: /Exporter/ }).hover();
        await page.getByRole('menuitem', { name: menu }).click();
      });

    const xlsx = await exporter('Excel');
    expect(xlsx.nom).toBe('documents.xlsx');
    expect(estUnZip(xlsx.contenu)).toBe(true);
    const texteXlsx = texteOffice(xlsx.contenu);
    expect(texteXlsx).toContain('Libellé');
    expect(texteXlsx).toContain(libelle1);
    expect(texteXlsx).toContain(typeA.label);
    expect(texteXlsx).not.toContain(libelle2);

    const csv = await exporter('CSV');
    expect(csv.nom).toBe('documents.csv');
    const lignes = csv.contenu
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    expect(lignes[0]).toBe(
      'Libellé,Type de document,N° pièce,Date document,Dossier,Plan de classement,Localisation',
    );
    // Exactement la ligne du document trouvé, avec son classement.
    expect(lignes).toHaveLength(2);
    expect(lignes[1]).toContain(libelle1);
    expect(lignes[1]).toContain(typeA.label);
    expect(lignes[1]).toContain(dossier.label);
    expect(lignes[1]).toContain(plan.label);

    const pdf = await exporter('PDF');
    expect(pdf.nom).toBe('documents.pdf');
    expect(estUnPdf(pdf.contenu)).toBe(true);
    // Police standard (WinAnsi) : le tiret demi-cadratin est encodé à part, on lit autour.
    expect(pdfContientTexte(pdf.contenu, `Lot ${batchId}`)).toBe(true);
    expect(pdfContientTexte(pdf.contenu, 'document 1')).toBe(true);
    expect(pdfContientTexte(pdf.contenu, 'document 2')).toBe(false);

    const docx = await exporter('Word');
    expect(docx.nom).toBe('documents.docx');
    expect(estUnZip(docx.contenu)).toBe(true);
    const texteDocx = texteOffice(docx.contenu);
    expect(texteDocx).toContain(libelle1);
    expect(texteDocx).toContain(typeA.label);
    expect(texteDocx).not.toContain(libelle2);
  });

  // --- 6. Communication (prêt) du document. ---
  const detailId = await test.step('communication', async () => {
    const acteurs = (await api.get('/courriers/actors')) as Array<{ userGroupId: number }>;
    const beneficiaire = acteurs[0];
    expect(beneficiaire, 'au moins un acteur bénéficiaire').toBeDefined();
    const pret = (await api.post('/archives/lendings', {
      documentIds: [doc1.documentId],
      userGroupId: beneficiaire!.userGroupId,
      lendingMotiveId,
      startDate: dateIso(0),
      projectedReturnDate: dateIso(7),
    })) as { details: Array<{ lendingDocumentDetailId: number; documentId: number }> };
    expect(pret.details.map((d) => d.documentId)).toEqual([doc1.documentId]);
    const enCours = (await api.get(
      `/archives/lendings/out?search=${q(libelle1)}`,
    )) as Page_<LignePret>;
    expect(enCours.rows.map((r) => [r.documentId, r.returnedDate])).toEqual([
      [doc1.documentId, null],
    ]);
    // Un document déjà communiqué ne peut pas l'être une seconde fois.
    const double = await api.raw.post('/archives/lendings', {
      documentIds: [doc1.documentId],
      userGroupId: beneficiaire!.userGroupId,
      lendingMotiveId,
      startDate: dateIso(0),
      projectedReturnDate: dateIso(7),
    });
    expect(double.status()).toBe(409);
    return pret.details[0]!.lendingDocumentDetailId;
  });

  // --- 7. DUA échue (préparée par l'API), épuration bloquée tant que le document est prêté. ---
  await test.step('DUA échue et retour du prêt', async () => {
    await api.put(`/documents/${doc1.documentId}/life-cycle`, {
      usefulnessLifespan: dateIso(-2),
      complianceLifespan: dateIso(-1),
    });
    const echus = (await api.get(
      `/archives/dua-expired?search=${q(libelle1)}`,
    )) as Page_<LigneConformite>;
    expect(echus.rows.map((r) => r.documentId)).toEqual([doc1.documentId]);

    const bloque = await api.post('/archives/dua-expired/purge', {
      documentIds: [doc1.documentId],
    });
    expect(bloque).toEqual({
      purged: 0,
      blocked: [{ documentId: doc1.documentId, label: libelle1 }],
    });

    await api.post(`/archives/lendings/details/${detailId}/return`, {});
    const enCours = (await api.get(
      `/archives/lendings/out?search=${q(libelle1)}`,
    )) as Page_<LignePret>;
    expect(enCours.rows).toEqual([]);
    const historique = (await api.get(
      `/archives/lendings/history?search=${q(libelle1)}`,
    )) as Page_<LignePret>;
    expect(historique.rows).toHaveLength(1);
    expect(historique.rows[0]).toMatchObject({ documentId: doc1.documentId });
    expect(historique.rows[0]!.returnedDate).not.toBeNull();
  });

  // --- 8. Épuration à l'écran « DUA expirés ». ---
  await test.step('épuration', async () => {
    await page.goto('/archives/dua-expirees');
    await expect(page.getByRole('heading', { name: 'DUA expirés' })).toBeVisible();
    const liste = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith('/api/archives/dua-expired') &&
        new URL(r.url()).searchParams.get('search') === libelle1,
    );
    const champ = page.getByPlaceholder('Rechercher un document, un n° de pièce, un type…');
    await champ.fill(libelle1);
    await champ.press('Enter');
    expect((await liste).status()).toBe(200);
    const ligne = page.getByRole('row').filter({ hasText: libelle1 });
    await expect(ligne).toHaveCount(1);
    await ligne.getByRole('checkbox').check();
    await expect(page.getByText('1 document(s) sélectionné(s)')).toBeVisible();
    await page.getByRole('button', { name: 'Épurer la sélection' }).click();
    await page.getByRole('button', { name: 'Épurer', exact: true }).click();
    await expect(page.getByText('1 document(s) épuré(s)')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: libelle1 })).toHaveCount(0);

    const epures = (await api.get(
      `/archives/purged?search=${q(libelle1)}`,
    )) as Page_<LigneConformite>;
    expect(epures.rows.map((r) => r.documentId)).toEqual([doc1.documentId]);
    const echus = (await api.get(
      `/archives/dua-expired?search=${q(libelle1)}`,
    )) as Page_<LigneConformite>;
    expect(echus.rows).toEqual([]);
    // Un document épuré n'est plus communicable.
    const pret = await api.raw.post('/archives/lendings', {
      documentIds: [doc1.documentId],
      userGroupId: ((await api.get('/courriers/actors')) as Array<{ userGroupId: number }>)[0]!
        .userGroupId,
      lendingMotiveId,
      startDate: dateIso(0),
      projectedReturnDate: dateIso(7),
    });
    expect(pret.status()).toBe(409);
  });

  // --- 9. Intégrité : l'épuration est un état, le binaire et son cachet restent probants. ---
  await test.step('intégrité', async () => {
    for (const d of documents) {
      const verif = (await api.post(`/documents/${d.documentId}/integrity/verify`, {})) as {
        integrityOk: boolean | null;
        files: Array<{ status: string }>;
      };
      expect(verif.integrityOk, `document ${d.documentId}`).toBe(true);
      // Empreinte posée par le worker à la création : « ok », jamais « imprinted ».
      expect(verif.files.map((f) => f.status)).toEqual(['ok']);

      const etat = (await api.get(`/documents/${d.documentId}/integrity`)) as {
        integrityOk: boolean | null;
        seal: { algorithm: string } | null;
        files: Array<{ hash: string | null }>;
      };
      expect(etat.integrityOk).toBe(true);
      expect(etat.files).toHaveLength(1);
      expect(etat.files[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(etat.seal, 'cachet apposé à l’ingestion').not.toBeNull();

      expect(await api.get(`/documents/${d.documentId}/seal`)).toMatchObject({
        sealed: true,
        knownKey: true,
        signatureValid: true,
        contentMatches: true,
      });
    }
  });
});
