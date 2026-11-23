/**
 * Fixtures du module courriers : celles du lot 0, avec un `loginAs` tolérant à une navigation
 * interrompue.
 *
 * Défaut constaté dans `apps/e2e/fixtures/index.ts` (lot 0, non modifiable ici) : `loginAs` enchaîne
 * deux `page.goto('/login')`. Quand la page administrateur est encore en train de naviguer (rendu
 * client de la première visite), le second `goto` échoue par intermittence en
 * `net::ERR_ABORTED`, sans rapport avec l'application testée. On rejoue alors la connexion UNE fois ;
 * toute autre erreur remonte telle quelle. Aucune assertion n'est concernée.
 */
import type { Page } from '@playwright/test';
import { test as base, expect, loginAs as baseLoginAs } from '../../../fixtures';
import type { ApiClient } from '../../../fixtures';

export { expect };

async function loginAsTolerant(page: Page, username: string, password: string): Promise<void> {
  try {
    await baseLoginAs(page, username, password);
  } catch (e) {
    if (!/net::ERR_ABORTED/.test(String(e))) throw e;
    await baseLoginAs(page, username, password);
  }
}

/**
 * Second défaut d'infrastructure : le serveur Node de l'API ferme une connexion keep-alive
 * inactive après 5 s (`keepAliveTimeout` par défaut, `main.ts` transverse) ; si le contexte
 * de requêtes Playwright réutilise ce socket au même instant, l'appel échoue en
 * `read ECONNRESET` sans avoir été traité par l'API. On le rejoue UNE fois, sur ce seul code ;
 * toute réponse HTTP (y compris 4xx/5xx) et toute autre erreur remontent telles quelles.
 */
function retryOnReset<A extends unknown[], R>(fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
  return async (...a: A) => {
    try {
      return await fn(...a);
    } catch (e) {
      if (!/\bECONNRESET\b/.test(String(e))) throw e;
      return fn(...a);
    }
  };
}

function resilient(client: ApiClient): ApiClient {
  const raw = client.raw;
  return {
    ...client,
    raw: {
      get: retryOnReset(raw.get),
      post: retryOnReset(raw.post),
      put: retryOnReset(raw.put),
      patch: retryOnReset(raw.patch),
      del: retryOnReset(raw.del),
      upload: retryOnReset(raw.upload),
    },
    get: retryOnReset(client.get),
    post: retryOnReset(client.post),
    put: retryOnReset(client.put),
    patch: retryOnReset(client.patch),
    del: retryOnReset(client.del),
    upload: retryOnReset(client.upload),
  };
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- fixture sans dépendance
  loginAs: async ({}, use) => {
    await use(loginAsTolerant);
  },
  api: async ({ api }, use) => {
    await use(resilient(api));
  },
  apiAs: async ({ apiAs }, use) => {
    await use(async (username: string, password: string) => resilient(await apiAs(username, password)));
  },
});
