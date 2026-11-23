/**
 * Redirections d'accueil : apps/web/app/page.tsx (« / » → /dashboards) et
 * apps/web/app/admin/page.tsx (« /admin » → première entrée visible de « Paramétrage Archives »).
 */
import { test, expect } from '../../../fixtures';

test('SOC-09 accueil : « / » ouvre /dashboards et « /admin » ouvre le plan de classement', async ({
  page,
}) => {
  await test.step('« / » → /dashboards', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboards$/);
  });

  await test.step('« /admin » → /admin/classification-plans', async () => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/classification-plans$/);
    await expect(page.getByRole('heading', { name: 'Plan de classement' })).toBeVisible();
  });
});

test.describe('sans session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('SOC-09 (sans session) « / » aboutit à la connexion', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});
