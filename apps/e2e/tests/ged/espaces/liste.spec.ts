/**
 * GED — liste des espaces (`/espaces`, `apps/web/app/espaces/page.tsx`).
 * Scénarios GED-10 (liste, recherche, filtre de type) et GED-11 (état vide).
 */
import { test, expect } from '../../../fixtures';
import { SpaceKind, createSpace, createSpaceUser, userPage } from '../_helpers/espaces';

test.describe('GED espaces — liste', () => {
  test('GED-10 liste des espaces : ligne complète, recherche, filtre de type et lien vers le détail', async ({
    page,
    api,
    uniq,
  }) => {
    const prefix = uniq('ged10');
    const shared = await createSpace(api, { label: `${prefix} partage`, kind: SpaceKind.Partage, description: 'Pièces du comité' });
    const collab = await createSpace(api, { label: `${prefix} collab`, kind: SpaceKind.Collaboration });

    await page.goto('/espaces');
    await expect(page.getByRole('heading', { name: 'Espaces', exact: true })).toBeVisible();

    const search = page.getByPlaceholder('Rechercher un espace');
    await search.fill(prefix);

    const sharedRow = page.getByRole('row').filter({ hasText: shared.label });
    const collabRow = page.getByRole('row').filter({ hasText: collab.label });
    await expect(sharedRow).toBeVisible();
    await expect(collabRow).toBeVisible();
    // Colonnes du tableau : type, publication, droit de l'administrateur propriétaire.
    await expect(sharedRow).toContainText('Partagé');
    await expect(sharedRow).toContainText('Non publié');
    await expect(sharedRow).toContainText('Propriétaire');
    await expect(sharedRow).toContainText('Pièces du comité');
    await expect(collabRow).toContainText('Collaboration');

    // Filtre de type, local à l'écran.
    await page.getByRole('combobox', { name: 'Filtrer par type' }).click();
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: /^Collaboration$/ })
      .click();
    await expect(collabRow).toBeVisible();
    await expect(sharedRow).toHaveCount(0);

    // Recherche sans résultat : état vide de filtre, distinct de l'état « aucun espace ».
    await search.fill(`${prefix}-introuvable`);
    await expect(page.getByText('Aucun espace ne correspond à ce filtre.')).toBeVisible();

    // Le libellé mène au détail.
    await search.fill(collab.label);
    await page.getByRole('link', { name: collab.label }).click();
    await expect(page).toHaveURL(new RegExp(`/espaces/${collab.gedSpaceId}$`));
    await expect(page.getByRole('heading', { name: collab.label })).toBeVisible();
  });

  test('GED-11 liste vide : un utilisateur sans espace voit l’invitation à en créer un', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    const user = await createSpaceUser(api, apiAs, uniq('ged11'));
    const self = await apiAs(user.username, user.password);
    expect(await self.get('/spaces')).toEqual([]);

    const { context, page } = await userPage(browser, testInfo, loginAs, user);
    try {
      await page.goto('/espaces');
      await expect(
        page.getByText("Aucun espace pour l'instant : créez-en un pour regrouper des documents."),
      ).toBeVisible();
      // En-tête + état vide : deux boutons de création, tous deux actifs.
      await expect(page.getByRole('button', { name: 'Nouvel espace' })).toHaveCount(2);
      await page.getByRole('button', { name: 'Nouvel espace' }).last().click();
      await expect(page.getByRole('dialog', { name: 'Nouvel espace' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
