/**
 * Smoke — connexion et déconnexion par l'écran (session vierge, sans storageState).
 */
import { ADMIN_PASSWORD, ADMIN_USER, expect, test } from '../../fixtures';
import { createApiClient } from '../../support';

test.describe('smoke : authentification', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('SMK-01 connexion réussie de l’administrateur', async ({ page, loginAs }) => {
    await loginAs(page, ADMIN_USER, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/dashboards/);
    await expect(page.getByRole('button', { name: 'Menu utilisateur' })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBeTruthy();
  });

  test('SMK-02 connexion refusée avec un mauvais mot de passe', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel("Nom d'utilisateur").fill(ADMIN_USER);
    await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
    const login = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
    await page.getByRole('button', { name: 'Se connecter' }).click();
    expect((await login).status()).toBe(401);
    // Filtré : Next pose aussi un role="alert" vide (__next-route-announcer__) sur chaque page.
    await expect(page.getByRole('alert').filter({ hasText: 'Identifiants invalides' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBeNull();
  });

  test('SMK-03 accès refusé sans session : redirection vers la connexion', async ({ page }) => {
    await page.goto('/dashboards');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible();
  });

  test('SMK-04 déconnexion', async ({ page, loginAs }) => {
    await loginAs(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Menu utilisateur' }).click();
    await page.getByRole('menuitem', { name: 'Déconnexion' }).click();
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => window.localStorage.getItem('token'))).toBeNull();
    // La session est bien close : une page protégée renvoie à la connexion.
    await page.goto('/dashboards');
    await expect(page).toHaveURL(/\/login/);
  });
});

test('SMK-05 API : santé, profil administrateur et refus sans jeton', async ({ api }) => {
  expect(await api.get('health')).toEqual({ status: 'ok' });
  const me = await api.get<{ username: string; isAdmin: boolean; mustChangePwd: boolean }>('auth/me');
  expect(me).toMatchObject({ username: ADMIN_USER, isAdmin: true, mustChangePwd: false });
  const anon = await createApiClient();
  try {
    expect((await anon.raw.get('auth/me')).status()).toBe(401);
  } finally {
    await anon.dispose();
  }
});
