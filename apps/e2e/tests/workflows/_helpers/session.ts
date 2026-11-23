// Docu-Flow E2E : ouvrir l'application sous un AUTRE utilisateur que l'administrateur, dans un contexte de
// navigateur séparé (la fixture `page` reste l'administrateur). Utile aux parcours à deux personnes.

import { test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { WfTestUser } from './users';

export type LoginAsFn = (page: Page, username: string, password: string) => Promise<void>;

export interface UserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/**
 * Nouveau contexte SANS l'état de connexion de l'administrateur, puis connexion par l'écran (`loginAs` de la
 * fixture). Reprend l'URL de base et la locale du projet Playwright. Pensez à `close()` en fin de test.
 */
export async function openSessionAs(browser: Browser, loginAs: LoginAsFn, user: Pick<WfTestUser, 'username' | 'password'>): Promise<UserSession> {
  const use = test.info().project.use;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    locale: use.locale,
    timezoneId: use.timezoneId,
    viewport: use.viewport ?? undefined,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await loginAs(page, user.username, user.password);
  return { context, page, close: () => context.close() };
}
