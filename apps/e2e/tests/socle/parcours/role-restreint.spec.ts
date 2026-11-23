/**
 * PARCOURS DE BOUT EN BOUT du lot 5 (P1) : rôle restreint de bout en bout, PAR L'INTERFACE.
 *
 * Administrateur : /admin/roles (création du rôle, puis ajout d'un menu) et /admin/users
 * (création du compte). Utilisateur, dans un contexte navigateur séparé : première connexion
 * avec changement imposé, barre latérale réduite à ses menus, refus 403 d'un écran non accordé
 * (URL directe et appel API), puis accès ouvert après ajout du menu.
 *
 * Libellés : admin/roles/page.tsx, admin/users/page.tsx, components/nav.ts (barre latérale),
 * API : roles.service.ts, users.service.ts, menu-permission.guard.ts.
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser, personalPasswordFor, TEST_PASSWORD } from '../_helpers/accounts';
import { completeFirstLogin, escapeRegExp, submitLogin, visibleMenus } from '../_helpers/session';

const isApi =
  (method: string, path: RegExp) => (r: { url(): string; request(): { method(): string } }) =>
    r.request().method() === method && path.test(new URL(r.url()).pathname);

test('SOC-19 parcours rôle restreint : création par l’interface, menus filtrés, 403, ouverture d’un menu', async ({
  page,
  browser,
  baseURL,
  api,
  apiAs,
  uniq,
}) => {
  test.slow(); // parcours long : deux contextes, plusieurs écrans.

  // Préfixe « 000 » : la table des rôles est triée par nom et paginée par 10 — le rôle doit
  // apparaître en première page pour être retrouvé à l'étape 7.
  const roleName = uniq('000 Parcours restreint');
  const username = uniq('parcours.restreint');
  const provisional = TEST_PASSWORD;
  const personal = personalPasswordFor(TEST_PASSWORD);
  let roleId = 0;

  await test.step('1. admin : créer le rôle (Tableaux de bord + Recherche + Types de document) dans /admin/roles', async () => {
    await page.goto('/admin/roles');
    await expect(page.getByRole('heading', { name: 'Rôles', exact: true })).toBeVisible();
    await page.getByLabel('Nom du rôle').fill(roleName);
    // Libellés du catalogue (`GET /roles/menus`) ; exacts : « Recherche IA » et « Recherche
    // courrier » existent aussi.
    // « Tableaux de bord » est accordé explicitement : c'est une permission assignable (statistiques
    // réservées à ses titulaires, décision du 2026-11-22), et la page d'arrivée après connexion.
    await page.getByRole('checkbox', { name: 'Tableaux de bord', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Recherche', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Types de document', exact: true }).check();

    const created = page.waitForResponse(isApi('POST', /\/api\/roles$/));
    await page.getByRole('button', { name: 'Créer le rôle' }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { roleId: number; menuKeys: string[] };
    roleId = body.roleId;
    expect(body.menuKeys.sort()).toEqual(['/admin/document-types', '/dashboards', '/search']);
    await expect(page.getByText('Rôle créé')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(escapeRegExp(roleName)) })).toBeVisible();
  });

  await test.step('2. admin : créer l’utilisateur de ce rôle dans /admin/users', async () => {
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Ajouter un utilisateur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel utilisateur' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Nom d’utilisateur').fill(username);
    await dialog.getByLabel('Prénom').fill('Parcours');
    await dialog.getByLabel(/^Nom\s*\*?$/).fill('Restreint');
    await dialog.getByLabel('Adresse e-mail').fill(`${username}@e2e.test`);
    await dialog.getByLabel('Mot de passe (6 caractères min.)').fill(provisional);
    // Select AntD avec recherche : on tape le nom, puis on clique l'option (attribut `title`).
    await dialog.getByLabel('Rôle').fill(roleName);
    await page.getByTitle(roleName, { exact: true }).click();

    const created = page.waitForResponse(isApi('POST', /\/api\/users$/));
    await dialog.getByRole('button', { name: 'Créer', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByText('Utilisateur créé')).toBeVisible();
    await page.getByLabel('Rechercher un compte').fill(username);
    await expect(page.getByRole('row', { name: new RegExp(escapeRegExp(username)) })).toContainText(
      roleName,
    );
  });

  const userCtx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const userPage = await userCtx.newPage();
  try {
    await test.step('3. utilisateur : première connexion, changement imposé', async () => {
      await submitLogin(userPage, username, provisional);
      await completeFirstLogin(userPage, personal);
    });

    await test.step('4. utilisateur : la barre latérale ne montre QUE ses menus', async () => {
      // Tous viennent du rôle (« Tableaux de bord » compris).
      expect(await visibleMenus(userPage)).toEqual({
        'Docu-Archives': ['Tableaux de bord', 'Recherche'],
        'Paramétrage Archives': ['Types de document'],
      });
    });

    await test.step('5. utilisateur : /admin/users par URL directe → 403, aucune donnée', async () => {
      const users = userPage.waitForResponse(isApi('GET', /\/api\/users$/));
      await userPage.goto('/admin/users');
      expect((await users).status()).toBe(403);
      // L'écran « Accès refusé » (comportement cible) est testé à part, en attente du lot transverse.
      await expect(
        userPage.getByRole('row', { name: new RegExp(escapeRegExp(username)) }),
      ).toHaveCount(0);
    });

    await test.step('6. utilisateur : GET /users par l’API → 403', async () => {
      const client = await apiAs(username, personal);
      expect((await client.raw.get('/users')).status()).toBe(403);
    });

    await test.step('7. admin : ajouter le menu « Utilisateurs » au rôle', async () => {
      await page.goto('/admin/roles');
      await page
        .getByRole('row', { name: new RegExp(escapeRegExp(roleName)) })
        .getByRole('button', { name: 'Permissions' })
        .click();
      await expect(page.getByText('Modifier le rôle')).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Recherche', exact: true })).toBeChecked();
      await page.getByRole('checkbox', { name: 'Utilisateurs', exact: true }).check();

      const saved = page.waitForResponse(isApi('PATCH', new RegExp(`/api/roles/${roleId}$`)));
      await page.getByRole('button', { name: 'Enregistrer' }).click();
      const res = await saved;
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { menuKeys: string[] }).menuKeys.sort()).toEqual([
        '/admin/document-types',
        '/admin/users',
        '/dashboards',
        '/search',
      ]);
      await expect(page.getByText('Rôle mis à jour')).toBeVisible();
    });

    await test.step('8. utilisateur : après rechargement, le menu apparaît et /admin/users charge', async () => {
      const users = userPage.waitForResponse(isApi('GET', /\/api\/users$/));
      await userPage.reload();
      expect((await users).status()).toBe(200);
      await userPage.getByLabel('Rechercher un compte').fill(username);
      await expect(
        userPage.getByRole('row', { name: new RegExp(escapeRegExp(username)) }),
      ).toBeVisible();

      expect(await visibleMenus(userPage)).toEqual({
        'Docu-Archives': ['Tableaux de bord', 'Recherche'],
        'Paramétrage Archives': ['Types de document'],
        Administration: ['Utilisateurs'],
      });

      const client = await apiAs(username, personal);
      expect((await client.raw.get('/users')).status()).toBe(200);
    });
  } finally {
    await userCtx.close();
    // Nettoyage : la table des rôles est paginée et partagée par les specs (base non remise à zéro).
    if (roleId) await api.raw.del(`/roles/${roleId}`);
  }
});

// Décision de l'utilisateur (2026-11-22) : un écran ouvert par son adresse sans le menu affiche
// « Accès refusé » dès l'ouverture. Correctif dans AuthShell (transverse), fait après ce lot.
test.fixme('SOC-19 en attente du lot transverse : écran Accès refusé sur /admin/users sans le menu', async ({
  api,
  uniq,
  browser,
  baseURL,
}) => {
  const restricted = await createRestrictedUser(api, uniq, ['/search']);
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const p = await ctx.newPage();
    await submitLogin(p, restricted.username, restricted.password);
    await expect(p).toHaveURL(/\/(dashboards|search)$/);
    await p.goto('/admin/users');
    await expect(p.getByText('Accès refusé').first()).toBeVisible();
    await expect(p.getByRole('button', { name: 'Ajouter un utilisateur' })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
