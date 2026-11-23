/**
 * GED-40 à GED-44 — Recherche IA (`/recherche-ia`, API `POST /semantic-search`, `/ask`, `/reindex`).
 *
 * Pile E2E : IA DÉSACTIVÉE (aucun fournisseur). La recherche et la question retombent sur la
 * recherche plein texte (`mode: 'fulltext'`) avec un message ; jamais d'erreur 500.
 * Menu RBAC `/recherche-ia` refusé par défaut.
 *
 * Limite de débit EN MÉMOIRE, PAR UTILISATEUR : 20 recherches et 6 questions par minute, comptées
 * AVANT la validation du corps (un 400 consomme aussi le quota). Pour ne pas épuiser le quota de
 * l'administrateur partagé par toute la suite (et par deux passes consécutives), chaque test qui
 * appelle `/semantic-search*` le fait avec SON utilisateur, neuf, portant le menu `/recherche-ia`.
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser, type GedUser } from '../_helpers/users';
import { createArchivedDocument, searchTerm } from '../_helpers/archives';
import {
  AI_DISABLED_MESSAGE,
  SEMANTIC_FALLBACK_MESSAGE,
  errorText,
  expectAiDisabled,
  isApiCall,
  openPageAs,
  asT4,
  asT4As,
  type T4Api,
  type T4ApiAs,
} from '../_helpers/ia';

const ASK_PATH = '/semantic-search/ask';
const SEARCH_PATH = '/semantic-search';
const FORBIDDEN_SECTION = "Vous n'avez pas accès à cette section.";
const RIA_MENU = '/recherche-ia';

/** Utilisateur neuf portant le menu « Recherche IA » (ou aucun menu), et son client REST. */
async function riaUser(
  api: T4Api,
  apiAs: T4ApiAs,
  prefix: string,
  menuKeys: string[] = [RIA_MENU],
): Promise<{ user: GedUser; self: T4Api }> {
  const user = await createRestrictedUser(api, apiAs, prefix, menuKeys);
  const self = await apiAs(user.username, user.password);
  return { user, self };
}

test.describe('Recherche IA — IA désactivée', () => {
  test('GED-40 IA désactivée : une question retombe proprement sur le plein texte', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    await expectAiDisabled(asT4(api));
    const { user } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-q'));
    const question = `Que prévoit la pièce ${uniq('ria-terme')} ?`;

    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const page = session.page;
      await page.goto('/recherche-ia');
      await expect(page.getByRole('heading', { name: 'Recherche IA' })).toBeVisible();
      await expect(page.getByText('Exemples de questions')).toBeVisible();

      await page.getByLabel('Votre question').fill(question);
      const responseP = page.waitForResponse(isApiCall('POST', ASK_PATH));
      await page.getByRole('button', { name: 'Poser la question' }).click();
      const res = await responseP;

      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({
        mode: 'fulltext',
        answered: false,
        answer: '',
        citations: [],
        hits: [],
        decisionId: null,
        message: SEMANTIC_FALLBACK_MESSAGE,
      });

      const banner = page.getByRole('alert').filter({ hasText: 'L’IA est désactivée' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(SEMANTIC_FALLBACK_MESSAGE);
      await expect(page.getByText('Aucun résultat pour cette recherche')).toBeVisible();
      // Aucun état de réponse générée : ni « Sources citées », ni « je ne sais pas ».
      await expect(page.getByText('Sources citées')).toHaveCount(0);
      await expect(page.getByText('Aucune réponse fiable trouvée')).toHaveCount(0);
    } finally {
      await session.close();
    }
  });

  test('GED-41 IA désactivée : « Rechercher » retombe sur le plein texte (interface et API)', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    await expectAiDisabled(asT4(api));
    const { user, self } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-s'));
    const query = uniq('ria-recherche');

    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const page = session.page;
      await page.goto('/recherche-ia');
      await page.getByLabel('Votre question').fill(query);
      const responseP = page.waitForResponse(isApiCall('POST', SEARCH_PATH));
      await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
      const res = await responseP;
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ mode: 'fulltext', message: SEMANTIC_FALLBACK_MESSAGE, hits: [] });

      await expect(page.getByRole('alert').filter({ hasText: 'L’IA est désactivée' })).toBeVisible();
      await expect(page.getByText('Aucun résultat pour cette recherche')).toBeVisible();
    } finally {
      await session.close();
    }

    // API directe : même contrat ; `limit` borné accepté.
    expect(await self.post(SEARCH_PATH, { query, limit: 5 })).toEqual({
      mode: 'fulltext',
      message: SEMANTIC_FALLBACK_MESSAGE,
      hits: [],
    });
    expect(await self.post(ASK_PATH, { question: `${query} ?` })).toMatchObject({
      mode: 'fulltext',
      answered: false,
      hits: [],
      decisionId: null,
    });
  });

  test('GED-41 IA désactivée : un document archivé est retrouvé par le repli plein texte', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    await expectAiDisabled(asT4(api));
    const term = searchTerm(uniq('riaarch'));
    const label = `Note archivee ${term}`;
    const doc = await createArchivedDocument(api, label);
    const { user, self } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-arch'));

    // API : le repli plein texte renvoie le document archivé, sans score (pas de sémantique).
    const found = await self.post<{ mode: string; hits: Array<Record<string, unknown>> }>(SEARCH_PATH, {
      query: term,
    });
    expect(found.mode).toBe('fulltext');
    expect(found.hits).toEqual([
      expect.objectContaining({ documentId: doc.documentId, documentLabel: label, score: null }),
    ]);

    // Écran : le résultat est listé et mène à la fiche du document.
    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const page = session.page;
      await page.goto('/recherche-ia');
      await page.getByLabel('Votre question').fill(term);
      const responseP = page.waitForResponse(isApiCall('POST', SEARCH_PATH));
      await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
      expect((await responseP).status()).toBe(200);
      const link = page.getByRole('link', { name: new RegExp(label) });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', new RegExp(`/documents/${doc.documentId}$`));
    } finally {
      await session.close();
    }
  });
});

test.describe('Recherche IA — saisie', () => {
  test('GED-42 saisie : minima, raccourcis clavier et exemple cliquable', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    await expectAiDisabled(asT4(api));
    const { user } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-saisie'));
    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const page = session.page;
      let askCalls = 0;
      page.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith(ASK_PATH)) askCalls += 1;
      });

      await page.goto('/recherche-ia');
      const box = page.getByLabel('Votre question');
      const ask = page.getByRole('button', { name: 'Poser la question' });
      const search = page.getByRole('button', { name: 'Rechercher', exact: true });

      await expect(ask).toBeDisabled();
      await expect(search).toBeDisabled();
      await box.fill('a');
      await expect(ask).toBeDisabled();
      await expect(search).toBeDisabled();
      await box.fill('ab');
      await expect(search).toBeEnabled();
      await expect(ask).toBeDisabled(); // la question exige 3 caractères
      await expect(page.getByText('2 / 1000')).toBeVisible();

      // Maj+Entrée : saut de ligne, aucun envoi ; Entrée seule : envoi de la question.
      await box.fill('abc');
      await box.press('Shift+Enter');
      await box.pressSequentially('def');
      await expect(box).toHaveValue('abc\ndef');
      const responseP = page.waitForResponse(isApiCall('POST', ASK_PATH));
      await box.press('Enter');
      expect((await responseP).status()).toBe(200);
      expect(askCalls).toBe(1);
      await expect(page.getByRole('alert').filter({ hasText: 'L’IA est désactivée' })).toBeVisible();

      // Exemple cliquable : remplit la zone et pose la question.
      await page.goto('/recherche-ia');
      const example = 'Quel est le délai de conservation des factures fournisseurs ?';
      const exampleP = page.waitForResponse(isApiCall('POST', ASK_PATH));
      await page.getByRole('button', { name: example }).click();
      expect((await exampleP).status()).toBe(200);
      await expect(page.getByLabel('Votre question')).toHaveValue(example);
      await expect(page.getByRole('alert').filter({ hasText: 'L’IA est désactivée' })).toBeVisible();
    } finally {
      await session.close();
    }
  });

  test('GED-42 saisie : corps invalides refusés par l’API (400), jamais de 500', async ({ api, apiAs, uniq }) => {
    // 5 questions + 6 recherches : sous les quotas (6 et 20) d'un utilisateur neuf.
    const { self } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-400'));
    const cases: Array<[string, string, unknown]> = [
      ['question trop courte', ASK_PATH, { question: 'ab' }],
      ['question réduite à 2 caractères après trim', ASK_PATH, { question: '   ab   ' }],
      ['question absente', ASK_PATH, {}],
      ['champ inconnu (question)', ASK_PATH, { question: 'Une vraie question ?', intrus: 1 }],
      ['question de 1001 caractères', ASK_PATH, { question: 'q'.repeat(1001) }],
      ['recherche d’un caractère', SEARCH_PATH, { query: 'a' }],
      ['recherche de 1001 caractères', SEARCH_PATH, { query: 'r'.repeat(1001) }],
      ['limite au-delà de 20', SEARCH_PATH, { query: 'contrat', limit: 21 }],
      ['limite nulle', SEARCH_PATH, { query: 'contrat', limit: 0 }],
      ['champ inconnu (recherche)', SEARCH_PATH, { query: 'contrat', page: 2 }],
    ];
    for (const [label, path, body] of cases) {
      const res = await self.raw.post(path, body);
      expect(res.status(), `${label} : ${await errorText(res)}`).toBe(400);
    }
    // Borne haute acceptée : 1000 caractères exactement, limite 20.
    const max = await self.raw.post(SEARCH_PATH, { query: 'm'.repeat(1000), limit: 20 });
    expect(max.status(), await errorText(max)).toBe(200);
  });
});

test.describe('Recherche IA — droits', () => {
  test('GED-43 sans le menu « Recherche IA » : API 403 et refus affiché à l’écran', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    const { user, self } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-sans-menu'), []);

    for (const [path, body] of [
      [SEARCH_PATH, { query: 'contrat' }],
      [ASK_PATH, { question: 'Quel contrat ?' }],
    ] as const) {
      const res = await self.raw.post(path, body);
      expect(res.status(), path).toBe(403);
      expect(await errorText(res)).toBe(FORBIDDEN_SECTION);
    }
    const me = await self.get<{ menuKeys?: string[] }>('/auth/me');
    expect(me.menuKeys ?? []).not.toContain(RIA_MENU);

    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const p = session.page;
      await p.goto('/recherche-ia');
      await p.getByLabel('Votre question').fill('Quel est le budget prévu ?');
      const responseP = p.waitForResponse(isApiCall('POST', ASK_PATH));
      await p.getByRole('button', { name: 'Poser la question' }).click();
      expect((await responseP).status()).toBe(403);
      await expect(
        p.getByRole('alert').filter({ hasText: 'Vous n’avez pas accès à la recherche IA.' }),
      ).toBeVisible();
    } finally {
      await session.close();
    }
  });

  test('GED-43 refus affiché dès l’ouverture de /recherche-ia sans le menu', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    // Décision de l'utilisateur (2026-11-22, Q5) : écran « Accès refusé » dès l'ouverture, posé par
    // la coquille commune (AuthShell) dans un lot transverse ultérieur. Le refus de l'API (403) est
    // vérifié dès maintenant par le test « sans le menu » ci-dessus.
    test.fixme(true, 'en attente du lot transverse : écran Accès refusé');
    const { user } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-ouverture'), []);
    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const p = session.page;
      await p.goto('/recherche-ia');
      await expect(p.getByText(/Accès refusé/)).toBeVisible();
      await expect(p.getByLabel('Votre question')).toHaveCount(0);
      await expect(p.getByRole('button', { name: 'Poser la question' })).toHaveCount(0);
    } finally {
      await session.close();
    }
  });

  test('GED-43 avec le menu : recherche permise, réindexation réservée aux administrateurs', async ({
    api,
    apiAs,
    uniq,
  }) => {
    await expectAiDisabled(asT4(api));
    const { self } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-avec-menu'));

    const res = await self.raw.post(SEARCH_PATH, { query: uniq('ria-u') });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ mode: 'fulltext', message: SEMANTIC_FALLBACK_MESSAGE, hits: [] });

    const reindexByUser = await self.raw.post('/semantic-search/reindex', {});
    expect(reindexByUser.status()).toBe(403);
    expect(await errorText(reindexByUser)).toBe('Réservé aux administrateurs');

    // Administrateur, IA désactivée : réponse explicite, rien n'est mis en file (route sans quota).
    const admin = asT4(api);
    expect(await admin.post('/semantic-search/reindex', {})).toEqual({ disabled: true, message: AI_DISABLED_MESSAGE });
    expect(await admin.post('/semantic-search/reindex', { documentId: 1 })).toEqual({
      disabled: true,
      message: AI_DISABLED_MESSAGE,
    });
    expect((await admin.raw.post('/semantic-search/reindex', { documentId: 0 })).status()).toBe(400);
    expect((await admin.raw.post('/semantic-search/reindex', { tout: true })).status()).toBe(400);
  });
});

test.describe('Recherche IA — limite de débit', () => {
  test('GED-44 6 questions par minute : la 7e est refusée (429, Retry-After) et l’écran le dit', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    // Utilisateur neuf : son compteur part de zéro.
    const { user, self } = await riaUser(asT4(api), asT4As(apiAs), uniq('ria-debit'));

    for (let i = 1; i <= 6; i += 1) {
      const ok = await self.raw.post(ASK_PATH, { question: `Question numéro ${i} ?` });
      expect(ok.status(), `question ${i}`).toBe(200);
    }
    const limited = await self.raw.post(ASK_PATH, { question: 'Question de trop ?' });
    expect(limited.status()).toBe(429);
    expect(await errorText(limited)).toMatch(
      /^Trop de requêtes : limite de 6 par minute atteinte\. Réessayez dans \d+ s\.$/,
    );
    const retryAfter = Number(limited.headers()['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // Compteurs séparés : la recherche reste permise.
    expect((await self.raw.post(SEARCH_PATH, { query: 'contrat' })).status()).toBe(200);

    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const p = session.page;
      await p.goto('/recherche-ia');
      await p.getByLabel('Votre question').fill('Encore une question ?');
      const responseP = p.waitForResponse(isApiCall('POST', ASK_PATH));
      await p.getByRole('button', { name: 'Poser la question' }).click();
      expect((await responseP).status()).toBe(429);
      await expect(
        p.getByRole('alert').filter({ hasText: /Trop de demandes en peu de temps\. Réessayez dans \d+ s\./ }),
      ).toBeVisible();
    } finally {
      await session.close();
    }
  });
});
