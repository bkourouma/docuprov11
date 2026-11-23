/**
 * GED — page publique d'un espace (`/espaces/publie/[slug]`) dans ses cas de refus.
 * Scénario GED-18 : slug inconnu, espace jamais publié, adresse mal formée, visiteur ANONYME.
 *
 * Règle codée (docs/ged-espaces.md §4.2, spaces.controller.ts:38-47) : aucune lecture anonyme ;
 * le garde JWT global refuse la requête et l'écran renvoie vers la connexion.
 */
import { test, expect } from '../../../fixtures';
import {
  anonymousContext,
  createEditorDocument,
  createSpace,
  publicPath,
  publishSpace,
  toSlug,
} from '../_helpers/espaces';

const GONE = "Cet espace n'existe pas ou n'est plus publié.";

test.describe('GED espaces — lecture publique (refus)', () => {
  test('GED-18 slug inconnu ou espace jamais publié : 404 propre, page sans contenu', async ({ page, api, uniq }) => {
    const unknown = toSlug(uniq('ged18-inconnu'));
    const res = await api.raw.get(`/spaces/published/${unknown}`);
    expect(res.status()).toBe(404);
    expect(JSON.stringify(await res.json())).toContain('Publication introuvable');

    await page.goto(publicPath(unknown));
    await expect(page.getByText(GONE)).toBeVisible();
    await expect(page.locator('.ant-alert-error')).toContainText('Publication introuvable');
    await expect(page.getByRole('button', { name: 'Retour aux espaces' })).toBeVisible();

    // Un espace partagé non publié n'a pas de slug : rien ne le sert à une adresse dérivée de son libellé.
    const label = uniq('ged18-non-publie');
    await createSpace(api, { label });
    const guessed = toSlug(label);
    expect((await api.raw.get(`/spaces/published/${guessed}`)).status()).toBe(404);
    await page.goto(publicPath(guessed));
    await expect(page.getByText(GONE)).toBeVisible();
    await expect(page.getByRole('heading', { name: label })).toHaveCount(0);
  });

  test('GED-18 adresse mal formée : message explicite, aucun appel à l’API', async ({ page }) => {
    let called = false;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api/spaces/published/')) called = true;
    });
    await page.goto(publicPath('-mauvaise'));
    await expect(page.getByText("L'adresse de l'espace publié est invalide.")).toBeVisible();
    await expect(page.getByText(GONE)).toBeVisible();
    expect(called).toBe(false);

    // Slug conforme pour l'écran mais refusé par l'API (majuscule, souligné) : 404 propre.
    await page.goto(publicPath('Mauvais_Slug'));
    await expect(page.locator('.ant-alert-error')).toContainText('Publication introuvable');
  });

  test('GED-18 visiteur anonyme : ni la page ni l’API ne servent une publication', async ({
    api,
    browser,
    uniq,
  }, testInfo) => {
    const space = await createSpace(api, { label: uniq('ged18-anon') });
    const docLabel = uniq('ged18-anon-doc');
    await createEditorDocument(api, space.gedSpaceId, docLabel);
    const slug = toSlug(uniq('ged18-anon-pub'));
    await publishSpace(api, space.gedSpaceId, slug);

    const anon = await anonymousContext(browser, testInfo);
    try {
      // API : le garde JWT global répond 401 avant toute règle d'espace.
      const res = await anon.request.get(`/api/spaces/published/${slug}`);
      expect(res.status()).toBe(401);
      const docs = await anon.request.get(`/api/spaces/${space.gedSpaceId}/documents`);
      expect(docs.status()).toBe(401);

      // Écran : sans jeton, la coque d'authentification renvoie vers la connexion.
      const page = await anon.newPage();
      await page.goto(publicPath(slug));
      await expect(page).toHaveURL(/\/login(\?|$)/);
      await expect(page.getByText(space.label)).toHaveCount(0);
      await expect(page.getByText(docLabel)).toHaveCount(0);
    } finally {
      await anon.close();
    }
  });
});
