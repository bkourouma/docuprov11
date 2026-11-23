/**
 * Connexion et session — au-delà du smoke du lot 0 (connexion réussie/refusée, déconnexion).
 *
 * Écran : apps/web/app/login/page.tsx ; garde : components/AuthShell.tsx ; 401 : lib/api.ts.
 */
import { test, expect } from '../../../fixtures';
import { createUser, disableUser, loginToken, rawGet, rawLogin } from '../_helpers/accounts';
import { E2E_JWT_SECRET, expiredToken, forgedToken, freshTokenForControl } from '../_helpers/jwt';
import {
  loginForm,
  logoutFromTopBar,
  sidebar,
  storedToken,
  submitLogin,
} from '../_helpers/session';

const INVALID_CREDENTIALS =
  'Identifiants invalides — vérifiez votre nom d’utilisateur et votre mot de passe.';

const isLoginCall = (url: string) => url.endsWith('/api/auth/login');

test.describe('sans session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('SOC-01 champs vides : validations du formulaire, aucun appel à l’API', async ({ page }) => {
    let loginCalls = 0;
    page.on('request', (r) => {
      if (isLoginCall(r.url())) loginCalls += 1;
    });
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Connexion', exact: true })).toBeVisible();
    const form = loginForm(page);

    await form.submit.click();
    await expect(page.getByText('Saisissez votre nom d’utilisateur.')).toBeVisible();
    await expect(page.getByText('Saisissez votre mot de passe.')).toBeVisible();

    await form.username.fill('quelqu.un');
    await form.submit.click();
    await expect(page.getByText('Saisissez votre nom d’utilisateur.')).toBeHidden();
    await expect(page.getByText('Saisissez votre mot de passe.')).toBeVisible();

    await expect(page).toHaveURL(/\/login$/);
    expect(loginCalls).toBe(0);
  });

  test('SOC-02 identifiants faux refusés avec message ; espaces de fin tolérés', async ({
    page,
    api,
    uniq,
  }) => {
    const user = await createUser(api, { username: uniq('soc02') });

    const attempts: Array<[string, string, string]> = [
      ['mot de passe faux', user.username, 'mauvais-mdp'],
      ['utilisateur inconnu', uniq('inconnu'), user.password],
    ];
    for (const [label, username, password] of attempts) {
      await test.step(label, async () => {
        const resp = page.waitForResponse((r) => isLoginCall(r.url()));
        await submitLogin(page, username, password);
        expect((await resp).status()).toBe(401);
        await expect(page.getByText(INVALID_CREDENTIALS)).toBeVisible();
        await expect(page).toHaveURL(/\/login$/);
        expect(await storedToken(page)).toBeNull();
      });
    }

    await test.step('espaces de fin (autofill) retirés : la connexion aboutit', async () => {
      await submitLogin(page, `${user.username}  `, `${user.password} `);
      await expect(page).toHaveURL(/\/dashboards$/);
      expect(await storedToken(page)).not.toBeNull();
    });
  });

  test('SOC-03 compte désactivé : connexion refusée (écran et API)', async ({
    page,
    api,
    uniq,
  }) => {
    const user = await createUser(api, { username: uniq('soc03') });
    await disableUser(api, user.userId);

    expect((await rawLogin(user.username, user.password)).status).toBe(401);

    const resp = page.waitForResponse((r) => isLoginCall(r.url()));
    await submitLogin(page, user.username, user.password);
    expect((await resp).status()).toBe(401);
    // Même message que des identifiants faux : on ne révèle pas que le compte existe.
    await expect(page.getByText(INVALID_CREDENTIALS)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(await storedToken(page)).toBeNull();
  });

  test('SOC-04 jeton absent ou altéré : écran → /login (jeton effacé), API → 401', async ({
    page,
  }) => {
    await test.step('sans jeton, une page protégée renvoie vers /login', async () => {
      // « /dashboards » est couvert par le smoke SMK-03.
      for (const path of ['/admin/users', '/profil']) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/login$/);
      }
    });

    await test.step('jeton mal signé : /auth/me répond 401, jeton effacé, retour à /login', async () => {
      await page.goto('/login');
      await page.evaluate((t) => window.localStorage.setItem('token', t), forgedToken());
      const me = page.waitForResponse((r) => r.url().endsWith('/api/auth/me'));
      await page.goto('/admin/users');
      expect((await me).status()).toBe(401);
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('heading', { name: 'Connexion', exact: true })).toBeVisible();
      expect(await storedToken(page)).toBeNull();
    });

    await test.step('API sans jeton ou avec un jeton forgé « administrateur » → 401', async () => {
      for (const path of ['/auth/me', '/auth/profile', '/users', '/roles']) {
        expect((await rawGet(path)).status, `${path} sans jeton`).toBe(401);
        expect((await rawGet(path, forgedToken())).status, `${path} jeton forgé`).toBe(401);
      }
    });
  });

  test('SOC-05 jeton expiré : API → 401, écran → /login', async ({ page, api, uniq }) => {
    test.fixme(
      !E2E_JWT_SECRET,
      'secret JWT de la pile introuvable (support/env.ts JWT_SECRET ou E2E_JWT_SECRET) : un jeton réellement expiré ne se fabrique pas sans lui',
    );
    // Témoin : le même secret, sans expiration, est accepté — le refus tient donc à l'expiration.
    const witness = await createUser(api, { username: uniq('soc05') });
    expect(
      (await rawGet('/auth/me', freshTokenForControl(E2E_JWT_SECRET!, witness.userId, witness.username))).status,
    ).toBe(200);
    const token = expiredToken(E2E_JWT_SECRET!);
    expect((await rawGet('/auth/me', token)).status).toBe(401);

    await page.goto('/login');
    await page.evaluate((t) => window.localStorage.setItem('token', t), token);
    await page.goto('/dashboards');
    await expect(page).toHaveURL(/\/login$/);
    expect(await storedToken(page)).toBeNull();
  });

  // ANO FAILLE F1 (corrigée) : la stratégie JWT relit désormais le compte à chaque requête
  // (apps/api/src/modules/auth/jwt.strategy.ts) ; un jeton émis avant la désactivation est refusé.
  test('SOC-06 jeton émis avant la désactivation du compte : refusé ensuite', async ({
    api,
    uniq,
  }) => {
    const user = await createUser(api, { username: uniq('soc06') });
    const { accessToken } = await loginToken(user.username, user.password);
    expect((await rawGet('/auth/me', accessToken)).status).toBe(200);
    await disableUser(api, user.userId);
    expect((await rawGet('/auth/me', accessToken)).status).toBe(401);
  });
});

test.describe('avec la session administrateur', () => {
  test('SOC-07 session déjà active : /login renvoie vers /dashboards', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboards$/);
    await expect(sidebar(page)).toBeVisible();
  });

  test('SOC-08 après déconnexion, le retour arrière ne rouvre pas la session', async ({ page }) => {
    await page.goto('/dashboards');
    await expect(sidebar(page)).toBeVisible();
    // Deuxième entrée d'historique : la déconnexion REMPLACE l'entrée courante par /login.
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: 'Recherche', exact: true })).toBeVisible();

    await logoutFromTopBar(page);
    await expect(page).toHaveURL(/\/login$/);
    expect(await storedToken(page)).toBeNull();

    await page.goBack();
    await expect(page).toHaveURL(/\/login$/);
    await expect(sidebar(page)).toHaveCount(0);
    expect(await storedToken(page)).toBeNull();
  });
});
