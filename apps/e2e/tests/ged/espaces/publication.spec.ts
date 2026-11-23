/**
 * GED — publication d'un espace (`PublishModal`, bouton « Dépublier », page
 * `/espaces/publie/[slug]`). Scénarios GED-16 (publier, lire, dépublier) et GED-17 (erreurs).
 *
 * Rappel de la règle codée (docs/ged-espaces.md §4.2) : la lecture d'une publication exige une
 * session ET le menu « Espaces » ; le « public » d'une publication est donc l'ensemble des
 * utilisateurs authentifiés porteurs du menu, sans appartenance à l'espace.
 */
import { test, expect } from '../../../fixtures';
import {
  SpaceKind,
  antMessage,
  createEditorDocument,
  createSpace,
  createSpaceUser,
  descriptionValue,
  popconfirmButton,
  publicPath,
  publishSpace,
  toSlug,
  userPage,
  type SpaceDetail,
  type SpaceDocumentRow,
} from '../_helpers/espaces';

test.describe('GED espaces — publication', () => {
  test('GED-16 publier un espace, le lire en non-membre authentifié, puis le dépublier', async ({
    page,
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }, testInfo) => {
    const space = await createSpace(api, { label: uniq('ged16'), kind: SpaceKind.Partage, description: 'Rapport public' });
    const docLabel = uniq('ged16-doc');
    const doc = await createEditorDocument(api, space.gedSpaceId, docLabel);
    const slug = toSlug(uniq('ged16-pub'));
    const reader = await createSpaceUser(api, apiAs, uniq('ged16-lecteur'));
    const readerApi = await apiAs(reader.username, reader.password);

    // --- Publication par l'écran, slug choisi.
    await page.goto(`/espaces/${space.gedSpaceId}`);
    await page.getByRole('button', { name: 'Publier' }).click();
    const dialog = page.getByRole('dialog', { name: "Publier l'espace" });
    await expect(dialog).toContainText('Ceux dont la confidentialité est posée restent invisibles.');
    await dialog.getByPlaceholder('mon-espace').fill(slug);
    const published = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/spaces/${space.gedSpaceId}/publish`,
    );
    await dialog.getByRole('button', { name: 'Publier' }).click();
    expect((await published).status()).toBe(200);
    await expect(antMessage(page, 'Espace publié')).toBeVisible();
    await expect(page.getByText("Espace publié sous l'adresse")).toBeVisible();
    await expect(page.getByRole('link', { name: publicPath(slug) })).toHaveAttribute('href', publicPath(slug));
    await expect(descriptionValue(page, 'Type')).toHaveText('Publication');
    await expect(descriptionValue(page, 'Publication')).toHaveText('Publié');
    await expect(page.getByRole('button', { name: 'Dépublier' })).toBeVisible();

    // --- Lecture par un utilisateur authentifié, porteur du menu, NON membre.
    const pub = await readerApi.get<SpaceDetail>(`/spaces/published/${slug}`);
    expect(pub).toMatchObject({ gedSpaceId: space.gedSpaceId, myAccess: null, canManage: false, canContribute: false });
    // Lecteur de publication : lecture seule, aucune écriture.
    expect((await readerApi.raw.patch(`/spaces/${space.gedSpaceId}`, { label: 'pirate' })).status()).toBe(403);
    expect(
      (await readerApi.raw.post(`/spaces/${space.gedSpaceId}/documents`, { documentId: doc.documentId })).status(),
    ).toBe(403);
    // Une publication d'autrui ne figure pas dans SON listing (elle se lit par le slug).
    const readerList = await readerApi.get<Array<{ gedSpaceId: number }>>('/spaces');
    expect(readerList.map((s) => s.gedSpaceId)).not.toContain(space.gedSpaceId);

    const { context, page: readerPage } = await userPage(browser, testInfo, loginAs, reader);
    try {
      await readerPage.goto(publicPath(slug));
      await expect(readerPage.getByRole('heading', { name: space.label })).toBeVisible();
      await expect(readerPage.getByText('Rapport public')).toBeVisible();
      await expect(descriptionValue(readerPage, 'Publié le')).not.toHaveText('—');
      // Document sans confidentialité ni droit restrictif : visible du public de la publication.
      const visible = await readerApi.get<SpaceDocumentRow[]>(`/spaces/${space.gedSpaceId}/documents`);
      expect(visible.map((d) => d.documentId)).toEqual([doc.documentId]);
      await expect(readerPage.getByRole('link', { name: docLabel })).toBeVisible();
      // Lecture seule : aucune action d'espace ni de document.
      for (const name of ['Modifier', 'Publier', 'Dépublier', 'Supprimer', 'Nouveau document', 'Rattacher un document']) {
        await expect(readerPage.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
      await expect(readerPage.getByRole('button', { name: `Détacher ${docLabel}` })).toHaveCount(0);

      // --- Dépublication par le propriétaire.
      await page.getByRole('button', { name: 'Dépublier' }).click();
      await expect(page.getByText(`Le lien ${publicPath(slug)} cessera de fonctionner.`)).toBeVisible();
      await popconfirmButton(page, 'Dépublier').click();
      await expect(antMessage(page, 'Espace dépublié')).toBeVisible();
      await expect(descriptionValue(page, 'Publication')).toHaveText('Non publié');
      await expect(descriptionValue(page, 'Type')).toHaveText('Partagé');

      // Le lien ne sert plus rien, ni à l'écran ni par l'API.
      await readerPage.reload();
      await expect(readerPage.getByText("Cet espace n'existe pas ou n'est plus publié.")).toBeVisible();
      await expect(readerPage.getByRole('heading', { name: space.label })).toHaveCount(0);
      expect((await readerApi.raw.get(`/spaces/published/${slug}`)).status()).toBe(404);
      // Redevenu « Partagé », l'espace est invisible pour le non-membre.
      expect((await readerApi.raw.get(`/spaces/${space.gedSpaceId}`)).status()).toBe(404);
    } finally {
      await context.close();
    }

    // Le slug libéré est réutilisable par une autre publication.
    const other = await createSpace(api, { label: uniq('ged16-autre') });
    expect((await publishSpace(api, other.gedSpaceId, slug)).publicationSlug).toBe(slug);
  });

  test('GED-17 publier un espace privé est refusé proprement', async ({ page, api, uniq }) => {
    const space = await createSpace(api, { label: uniq('ged17-prive'), kind: SpaceKind.Prive });
    await page.goto(`/espaces/${space.gedSpaceId}`);
    // Le bouton est proposé même pour un espace privé (docs/ged-espaces.md §9.1) : l'API tranche.
    await page.getByRole('button', { name: 'Publier' }).click();
    const dialog = page.getByRole('dialog', { name: "Publier l'espace" });
    await dialog.getByRole('button', { name: 'Publier' }).click();
    await expect(
      antMessage(page, "Un espace privé ne peut pas être publié : partagez-le d'abord (nature Partage ou Collaboration)"),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    const after = await api.get<SpaceDetail>(`/spaces/${space.gedSpaceId}`);
    expect(after).toMatchObject({ kind: SpaceKind.Prive, publicationSlug: null });
  });

  test('GED-17 slug déjà pris par une autre publication : refus 409 lisible', async ({ page, api, uniq }) => {
    const slug = toSlug(uniq('ged17-pris'));
    const holder = await createSpace(api, { label: uniq('ged17-a') });
    await publishSpace(api, holder.gedSpaceId, slug);
    const space = await createSpace(api, { label: uniq('ged17-b') });

    await page.goto(`/espaces/${space.gedSpaceId}`);
    await page.getByRole('button', { name: 'Publier' }).click();
    const dialog = page.getByRole('dialog', { name: "Publier l'espace" });
    await dialog.getByPlaceholder('mon-espace').fill(slug);
    await dialog.getByRole('button', { name: 'Publier' }).click();
    await expect(antMessage(page, 'Ce slug est déjà utilisé par une autre publication')).toBeVisible();
    expect((await api.get<SpaceDetail>(`/spaces/${space.gedSpaceId}`)).publicationSlug).toBeNull();
  });

  test('GED-17 slug invalide : refus 400 par l’API, rien n’est publié', async ({ api, uniq }) => {
    const space = await createSpace(api, { label: uniq('ged17-c') });
    for (const slug of ['Mon Slug', 'ab', 'a--b', '-abc', 'abc-', 'é-accent', 'x'.repeat(121)]) {
      const res = await api.raw.post(`/spaces/${space.gedSpaceId}/publish`, { slug });
      expect(res.status(), slug).toBe(400);
    }
    const res = await api.raw.post(`/spaces/${space.gedSpaceId}/publish`, { slug: 'Mon Slug' });
    expect(JSON.stringify(await res.json())).toContain('Slug attendu : minuscules, chiffres et tirets');
    expect((await api.get<SpaceDetail>(`/spaces/${space.gedSpaceId}`)).publicationSlug).toBeNull();
  });

  test('GED-17 slug invalide saisi à l’écran : le message d’erreur explique la règle (ANO-GED-T2-3)', async ({
    page,
    api,
    uniq,
  }) => {
    // Attendu : le message zod (« Slug attendu : minuscules, chiffres et tirets… »). Constat à la
    // lecture : l'API renvoie `message` sous forme de TABLEAU (ZodValidationPipe) et `apiJson`
    // (apps/web/app/lib/api.ts:27) n'exploite qu'une chaîne, d'où « HTTP 400 » à l'écran.
    // Confirmé en phase B (POST publish 400, message affiché « HTTP 400 ») ; api.ts est transverse.
    test.fixme(true, 'lot transverse : ANO-GED-09');
    const space = await createSpace(api, { label: uniq('ged17-d') });
    await page.goto(`/espaces/${space.gedSpaceId}`);
    await page.getByRole('button', { name: 'Publier' }).click();
    const dialog = page.getByRole('dialog', { name: "Publier l'espace" });
    await dialog.getByPlaceholder('mon-espace').fill('Mon Slug!');
    await dialog.getByRole('button', { name: 'Publier' }).click();
    await expect(antMessage(page, /Slug attendu : minuscules, chiffres et tirets/)).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('GED-17 publication sans slug : adresse dérivée du libellé, suffixée si déjà prise', async ({ api, uniq }) => {
    const label = `${uniq('Ged17 Été')} Rapport`;
    const first = await createSpace(api, { label });
    const second = await createSpace(api, { label });
    const a = await publishSpace(api, first.gedSpaceId);
    const b = await publishSpace(api, second.gedSpaceId);
    expect(a.publicationSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(a.publicationSlug).toContain('ete');
    expect(b.publicationSlug).toBe(`${a.publicationSlug}-2`);
  });
});
