/**
 * Écran de connexion, étape « Nouveau mot de passe », session par jeton et barre latérale.
 *
 * Pourquoi pas le fixture `loginAs` ? Il ne connaît pas (en phase A) l'étape de changement imposé
 * à la première connexion : ces aides pilotent le formulaire elles-mêmes et laissent le test
 * vérifier où l'on arrive.
 *
 * Libellés lus dans `apps/web/app/login/page.tsx`, `login/FirstLoginStep.tsx`,
 * `components/AuthShell.tsx` et `components/TopBar.tsx`.
 */
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/** Échappe une chaîne pour l'insérer dans une RegExp (identifiants produits par `uniq`). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Champs et bouton de l'écran de connexion. */
export function loginForm(page: Page) {
  return {
    username: page.getByLabel("Nom d'utilisateur", { exact: true }),
    password: page.getByLabel('Mot de passe', { exact: true }),
    submit: page.getByRole('button', { name: 'Se connecter' }),
  };
}

/** Ouvre /login, saisit les identifiants et valide. N'attend AUCUNE destination. */
export async function submitLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  const f = loginForm(page);
  await f.username.fill(username);
  await f.password.fill(password);
  await f.submit.click();
}

/** Étape imposée de première connexion (`FirstLoginStep`). */
export function firstLoginStep(page: Page) {
  return {
    heading: page.getByRole('heading', { name: 'Nouveau mot de passe' }),
    newPassword: page.getByLabel('Nouveau mot de passe', { exact: true }),
    confirm: page.getByLabel('Confirmer le nouveau mot de passe', { exact: true }),
    submit: page.getByRole('button', { name: 'Valider et continuer' }),
    cancel: page.getByRole('button', { name: 'Revenir à la connexion' }),
  };
}

/** Remplit et valide l'étape « Nouveau mot de passe », puis attend l'accueil. */
export async function completeFirstLogin(page: Page, newPassword: string): Promise<void> {
  const step = firstLoginStep(page);
  await expect(step.heading).toBeVisible();
  await step.newPassword.fill(newPassword);
  await step.confirm.fill(newPassword);
  const changed = page.waitForResponse(
    (r) => r.url().endsWith('/api/auth/change-password') && r.request().method() === 'POST',
  );
  await step.submit.click();
  expect((await changed).status()).toBe(200);
  await expect(page).toHaveURL(/\/dashboards$/);
}

/** Jeton de session lu dans le navigateur (`localStorage['token']`). */
export function storedToken(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem('token'));
}

/**
 * Nouveau contexte navigateur dont la session est le jeton fourni (posé dans `localStorage` de
 * l'origine de l'application), ou sans session si `token` est `null`.
 */
export async function contextWithToken(
  browser: Browser,
  baseURL: string | undefined,
  token: string | null,
): Promise<{ context: BrowserContext; page: Page }> {
  if (!baseURL) throw new Error('baseURL requis pour poser le jeton sur la bonne origine');
  const origin = new URL(baseURL).origin;
  const context = await browser.newContext({
    baseURL,
    storageState: {
      cookies: [],
      origins: token ? [{ origin, localStorage: [{ name: 'token', value: token }] }] : [],
    },
  });
  return { context, page: await context.newPage() };
}

/** Barre latérale desktop (`Layout.Sider` de `AuthShell`, rendu en `<aside>`). */
export function sidebar(page: Page): Locator {
  return page.locator('aside');
}

/**
 * Menus VISIBLES de la barre latérale, par section : `{ 'Docu-Archives': ['Tableaux de bord', …] }`.
 *
 * Sections = sous-menus AntD (titre `role=menuitem` porteur d'`aria-expanded`) ; l'accordéon n'en
 * ouvre qu'une à la fois, on les ouvre donc tour à tour. Les entrées d'une section fermée sont
 * masquées et ignorées par les requêtes par rôle.
 */
export async function visibleMenus(page: Page): Promise<Record<string, string[]>> {
  const sider = sidebar(page);
  const titles = sider
    .getByRole('menuitem', { expanded: true })
    .or(sider.getByRole('menuitem', { expanded: false }));
  await expect(titles.first()).toBeVisible();
  const sections = (await titles.allInnerTexts()).map((s) => s.trim());
  const result: Record<string, string[]> = {};
  for (const name of sections) {
    const title = sider.getByRole('menuitem', { name, exact: true });
    if ((await title.getAttribute('aria-expanded')) !== 'true') await title.click();
    await expect(title).toHaveAttribute('aria-expanded', 'true');
    // <li class="ant-menu-submenu"> parent du titre : porte la sous-liste de la section.
    const items = title.locator('xpath=..').getByRole('menu').getByRole('menuitem');
    await expect(items.first()).toBeVisible();
    result[name] = (await items.allInnerTexts()).map((s) => s.trim());
  }
  return result;
}

/** Ouvre le menu utilisateur de la barre supérieure et clique « Déconnexion ». */
export async function logoutFromTopBar(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu utilisateur' }).click();
  await page.getByRole('menuitem', { name: 'Déconnexion' }).click();
}
