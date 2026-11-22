/**
 * Fixtures communes de la suite E2E. Dans une spec :
 *
 *   import { test, expect } from '../../fixtures';
 *
 *   test('COU-01 enregistrer un courrier', async ({ page, api, uniq }) => { … });
 *
 * - `page`    : déjà connectée en administrateur (storageState du global setup).
 * - `api`     : client REST administrateur (chemins relatifs à /api) ; `api.raw.*` ne lève pas.
 * - `loginAs` : connexion par l'écran de connexion (`await loginAs(page, 'agent', 'secret')`).
 * - `apiAs`   : client REST d'un autre utilisateur (`const agent = await apiAs('agent', 'secret')`),
 *               libéré automatiquement en fin de test.
 * - `uniq`    : identifiant unique (`uniq('COU')`).
 * La référence complète est dans apps/e2e/README.md.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { readAdminToken } from '../support/admin';
import { createApiClient, loginApi, type ApiClient } from '../support/api-client';
import { ADMIN_PASSWORD, ADMIN_USER } from '../support/constants';
import { uniq as makeUniq } from '../support/uniq';

export { expect };
export { ADMIN_PASSWORD, ADMIN_USER } from '../support/constants';
export { ApiError, type ApiClient, type RawApi, type RequestOptions, type UploadFile, type UploadSpec } from '../support/api-client';
export type { GlobalSeedContext } from '../support/module-seeds';

/** Identifiant unique (utilisable aussi hors fixture, ex. dans un `beforeAll`). */
export const uniq = makeUniq;

/**
 * Connexion par l'écran de connexion. Vide d'abord la session courante (localStorage) : la page
 * passée en argument peut donc être la `page` admin par défaut. Attend la sortie de /login.
 */
export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.evaluate(() => window.localStorage.removeItem('token'));
  await page.goto('/login');
  await page.getByLabel("Nom d'utilisateur").fill(username);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Client REST d'un autre utilisateur (à libérer par `dispose()` hors fixture). */
export async function apiAs(username: string, password: string): Promise<ApiClient> {
  return createApiClient({ token: await loginApi(username, password) });
}

export interface E2EFixtures {
  /** Client REST administrateur, propre au test. */
  api: ApiClient;
  /** Connexion par l'écran de connexion. */
  loginAs: (page: Page, username: string, password: string) => Promise<void>;
  /** Client REST d'un autre utilisateur, libéré en fin de test. */
  apiAs: (username: string, password: string) => Promise<ApiClient>;
  /** Identifiant unique par appel. */
  uniq: (prefix?: string) => string;
}

interface E2EWorkerFixtures {
  /** Jeton administrateur partagé par le worker de test. */
  adminToken: string;
}

export const test = base.extend<E2EFixtures, E2EWorkerFixtures>({
  adminToken: [
    // eslint-disable-next-line no-empty-pattern -- fixture sans dépendance
    async ({}, use) => {
      await use(readAdminToken() ?? (await loginApi(ADMIN_USER, ADMIN_PASSWORD)));
    },
    { scope: 'worker' },
  ],
  api: async ({ adminToken }, use) => {
    const client = await createApiClient({ token: adminToken });
    await use(client);
    await client.dispose();
  },
  // eslint-disable-next-line no-empty-pattern -- fixture sans dépendance
  loginAs: async ({}, use) => {
    await use(loginAs);
  },
  // eslint-disable-next-line no-empty-pattern -- fixture sans dépendance
  apiAs: async ({}, use) => {
    const clients: ApiClient[] = [];
    await use(async (username, password) => {
      const client = await apiAs(username, password);
      clients.push(client);
      return client;
    });
    await Promise.all(clients.map((c) => c.dispose()));
  },
  // eslint-disable-next-line no-empty-pattern -- fixture sans dépendance
  uniq: async ({}, use) => {
    await use(makeUniq);
  },
});
