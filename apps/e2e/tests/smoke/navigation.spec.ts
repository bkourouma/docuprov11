/**
 * Smoke — chaque module s'ouvre sans réponse 5xx, sans exception ni erreur console, et sans
 * renvoi vers la connexion (page administrateur par défaut).
 */
import { expect, test } from '../../fixtures';
import { watchPage } from './_helpers/page-guard';

const MODULE_PAGES: Array<{ id: string; name: string; path: string }> = [
  { id: 'SMK-10', name: 'tableaux de bord', path: '/dashboards' },
  { id: 'SMK-11', name: 'courriers : tableau de bord', path: '/courriers/tableau-de-bord' },
  { id: 'SMK-12', name: 'courriers : suivi', path: '/courriers/suivi' },
  { id: 'SMK-13', name: 'archives : acquisition', path: '/acquisition' },
  { id: 'SMK-14', name: 'archives : intercalaires', path: '/intercalaires' },
  { id: 'SMK-15', name: 'archives : recherche', path: '/search' },
  { id: 'SMK-16', name: 'archives : communiquer', path: '/archives/communiquer' },
  { id: 'SMK-17', name: 'GED : espaces documentaires', path: '/espaces' },
  { id: 'SMK-18', name: 'workflows', path: '/workflows' },
  { id: 'SMK-19', name: 'administration', path: '/admin' },
];

for (const { id, name, path } of MODULE_PAGES) {
  test(`${id} ouverture du module ${name} (${path})`, async ({ page }) => {
    const problems = watchPage(page);
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}`));
    await expect(page.getByRole('button', { name: 'Menu utilisateur' })).toBeVisible();
    await expect(page.locator('.da-page')).toBeVisible();
    await expect(page.locator('.da-page')).not.toBeEmpty();
    expect(problems.serverErrors, 'réponses 5xx').toEqual([]);
    expect(problems.pageErrors, 'exceptions non rattrapées').toEqual([]);
    expect(problems.consoleErrors, 'erreurs console').toEqual([]);
  });
}
