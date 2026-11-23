/**
 * Écran « Génération d'intercalaires » (`/intercalaires`) et route `POST /intercalaires/generate`.
 * Spécification : specs/001-archivage-qr/spec.md, FR-001 à FR-007.
 */
import { test, expect } from '../../fixtures';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import { estUnPdf, nombreDePages, pdfContientTexte } from './_helpers/lot-pdf';
import { creerDossier, creerTypeDocument, genererIntercalairesParEcran } from './_helpers/lots';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

const TITRE = 'Génération d’intercalaires';

test.describe('Intercalaires QR', () => {
  test('ARC-02 génère une feuille par type de document sélectionné, avec catégorie et libellé', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-02');
    const typeA = await creerTypeDocument(api, `${u} type A`);
    const typeB = await creerTypeDocument(api, `${u} type B`);

    await page.goto('/intercalaires');
    await expect(page.getByRole('heading', { name: TITRE })).toBeVisible();
    const categorie = page.getByRole('button', { name: 'Type de document', exact: true });
    await categorie.click();
    await expect(categorie).toHaveAttribute('aria-pressed', 'true');

    await page.getByPlaceholder('Filtrer les éléments…').fill(u);
    await expect(page.getByText(typeA.label, { exact: true })).toBeVisible();
    await expect(page.getByText(typeB.label, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tout sélectionner' }).click();
    await expect(page.getByText('2 élément(s) sélectionné(s)')).toBeVisible();
    await expect(page.getByText('2 feuille(s) seront générées.')).toBeVisible();

    const { pdf, corps } = await genererIntercalairesParEcran(page);
    // Éléments triés par libellé à l'écran, envoyés dans cet ordre : A puis B.
    expect(corps).toEqual({ category: 'TYPE_DOCUMENT', itemIds: [typeA.id, typeB.id] });
    expect(estUnPdf(pdf)).toBe(true);
    // FR-004 : exactement une page par élément, portant la catégorie et le libellé de l'élément.
    expect(await nombreDePages(pdf)).toBe(2);
    expect(pdfContientTexte(pdf, 'TYPE DE DOCUMENT')).toBe(true);
    expect(pdfContientTexte(pdf, typeA.label)).toBe(true);
    expect(pdfContientTexte(pdf, typeB.label)).toBe(true);
  });

  test('ARC-03 présente les dossiers en arbre indenté et génère le séparateur vierge sans sélection', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-03');
    const parent = await creerDossier(api, `${u} parent`);
    await creerDossier(api, `${u} enfant`, parent.id);

    await page.goto('/intercalaires');
    await expect(page.getByRole('heading', { name: TITRE })).toBeVisible();

    // FR-002 : catégorie hiérarchique, l'enfant est décalé d'un niveau (20 px) sous son parent.
    await page.getByRole('button', { name: 'Dossier', exact: true }).click();
    await page.getByPlaceholder('Filtrer les éléments…').fill(u);
    const ligneParent = page.locator('label').filter({ hasText: `${u} parent` });
    const ligneEnfant = page.locator('label').filter({ hasText: `${u} enfant` });
    await expect(ligneParent).toBeVisible();
    await expect(ligneEnfant).toBeVisible();
    const retrait = async (l: typeof ligneParent) =>
      Number.parseFloat(await l.evaluate((el) => getComputedStyle(el).paddingLeft));
    expect((await retrait(ligneEnfant)) - (await retrait(ligneParent))).toBe(20);

    await page.getByText(`${u} enfant`, { exact: true }).click();
    await expect(page.getByText('1 élément(s) sélectionné(s)')).toBeVisible();
    const dossierPdf = await genererIntercalairesParEcran(page);
    expect(await nombreDePages(dossierPdf.pdf)).toBe(1);
    expect(pdfContientTexte(dossierPdf.pdf, 'DOSSIER')).toBe(true);
    expect(pdfContientTexte(dossierPdf.pdf, `${u} enfant`)).toBe(true);

    // FR-007 : le séparateur vierge ne demande aucune sélection et donne une feuille unique.
    await page.getByRole('button', { name: 'Séparateur vierge', exact: true }).click();
    await expect(
      page.getByText('Une feuille unique à QR code sera générée. Aucune sélection nécessaire.'),
    ).toBeVisible();
    await expect(page.getByText('Séparateur vierge — 1 feuille')).toBeVisible();
    const vierge = await genererIntercalairesParEcran(page);
    expect(vierge.corps).toEqual({ category: 'BLANK', itemIds: [] });
    expect(await nombreDePages(vierge.pdf)).toBe(1);
    expect(pdfContientTexte(vierge.pdf, 'SÉPARATEUR VIERGE')).toBe(true);
    expect(pdfContientTexte(vierge.pdf, '(séparateur vierge)')).toBe(true);
  });

  test('ARC-04 refuse une génération sans sélection ou sur des éléments invalides', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-04');
    const type = await creerTypeDocument(api, `${u} type`);

    await page.goto('/intercalaires');
    await expect(page.getByRole('heading', { name: TITRE })).toBeVisible();
    await page.getByRole('button', { name: 'Type de document', exact: true }).click();
    const generer = page.getByRole('button', { name: 'Générer le PDF' });

    // FR-006 : rien de coché → le bouton est inactif, aucun document vide ne peut partir.
    await expect(page.getByText('0 élément(s) sélectionné(s)')).toBeVisible();
    await expect(generer).toBeDisabled();
    await page.getByPlaceholder('Filtrer les éléments…').fill(u);
    await page.getByText(type.label, { exact: true }).click();
    await expect(generer).toBeEnabled();
    await page.getByRole('button', { name: 'Tout désélectionner' }).last().click();
    await expect(page.getByText('0 élément(s) sélectionné(s)')).toBeVisible();
    await expect(generer).toBeDisabled();

    // Filtre sans correspondance.
    await page.getByPlaceholder('Filtrer les éléments…').fill(`${u}-introuvable`);
    await expect(page.getByText('Aucun résultat')).toBeVisible();

    // Mêmes règles côté API, quel que soit l'appelant.
    const vide = await api.raw.post('/intercalaires/generate', {
      category: 'TYPE_DOCUMENT',
      itemIds: [],
    });
    expect(vide.status()).toBe(400);
    expect(await vide.text()).toContain('Sélection vide');

    const inexistant = await api.raw.post('/intercalaires/generate', {
      category: 'TYPE_DOCUMENT',
      itemIds: [2_000_000_000],
    });
    expect(inexistant.status()).toBe(400);
    expect(await inexistant.text()).toContain('Aucun élément valide');

    const categorieInconnue = await api.raw.post('/intercalaires/generate', {
      category: 'INCONNUE',
      itemIds: [type.id],
    });
    expect(categorieInconnue.status()).toBe(400);

    const idNul = await api.raw.post('/intercalaires/generate', {
      category: 'TYPE_DOCUMENT',
      itemIds: [0],
    });
    expect(idNul.status()).toBe(400);

    const listeInconnue = await api.raw.get('/intercalaires/items?category=INCONNUE');
    expect(listeInconnue.status()).toBe(400);
    expect(await listeInconnue.text()).toContain('Catégorie inconnue');
  });

  test('ARC-05 réserve la génération aux comptes ayant le menu Intercalaires', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const sans = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('ARC-05-sans'),
      menus: ['/search'],
    });
    const avec = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('ARC-05-avec'),
      menus: ['/intercalaires'],
    });

    // Refus côté API pour un compte sans le menu (ANO-ARC-T1-01).
    const clientSans = await apiAs(sans.username, sans.password);
    expect((await clientSans.raw.get('/intercalaires/categories')).status()).toBe(403);
    expect((await clientSans.raw.get('/intercalaires/items?category=TYPE_DOCUMENT')).status()).toBe(
      403,
    );
    expect(
      (
        await clientSans.raw.post('/intercalaires/generate', { category: 'BLANK', itemIds: [] })
      ).status(),
    ).toBe(403);

    // Contrôle positif : le menu suffit, sans être administrateur.
    const clientAvec = await apiAs(avec.username, avec.password);
    const ok = await clientAvec.raw.post('/intercalaires/generate', {
      category: 'BLANK',
      itemIds: [],
    });
    expect(ok.status()).toBe(200);
    expect(estUnPdf(await ok.body())).toBe(true);

    // À l'écran, le compte sans menu n'obtient aucune catégorie : rien ne peut être généré.
    await loginAs(page, sans.username, sans.password);
    const categories = page.waitForResponse((r) =>
      new URL(r.url()).pathname.endsWith('/api/intercalaires/categories'),
    );
    await page.goto('/intercalaires');
    expect((await categories).status()).toBe(403);
    await expect(page.getByRole('heading', { name: TITRE })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Séparateur vierge', exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('button', { name: 'Générer le PDF' })).toBeDisabled();
  });
});
