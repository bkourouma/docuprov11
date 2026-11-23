/**
 * Écran « Utilisateurs » (`apps/web/app/admin/users/page.tsx`) — parcours d'un administrateur.
 * Scénarios SOC-20 à SOC-28 (le smoke de connexion est au lot 0).
 *
 * Libellés repris du code de la page : bouton « Ajouter un utilisateur », modale « Nouvel
 * utilisateur » / « Modifier « <identifiant> » », boutons « Créer » / « Enregistrer », champs
 * « Nom d’utilisateur » (apostrophe typographique), « Prénom », « Nom », « Adresse e-mail »,
 * « Mot de passe (…) », « Rôle », « Habilitation de confidentialité », interrupteur « Compte
 * désactivé », actions de ligne « Modifier » / « Supprimer » (aria-label).
 */
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { createRole, createUser, TEST_PASSWORD } from '../_helpers/accounts';
import {
  afterReload,
  anyConfidentialite,
  escapeRe,
  getUser,
  login,
  rawLogin,
  roleName,
  pickOption,
  type ApiLike,
  type Me,
} from '../_helpers/tache-a';

/** Ouvre l'écran et attend la liste des comptes. */
async function openUsers(page: Page) {
  await afterReload(page, '/users', () => page.goto('/admin/users'));
  await expect(page.getByRole('heading', { name: 'Utilisateurs' })).toBeVisible();
}

/** Filtre l'annuaire (paginé par 10) sur un identifiant et renvoie sa ligne. */
async function rowOf(page: Page, username: string) {
  await page.getByRole('textbox', { name: 'Rechercher un compte' }).fill(username);
  return page.getByRole('row', { name: new RegExp(escapeRe(username)) });
}

/** Ouvre la fiche « Modifier » d'un compte. */
async function openEdit(page: Page, username: string) {
  const row = await rowOf(page, username);
  await row.getByRole('button', { name: 'Modifier' }).click();
  const dialog = page.getByRole('dialog', { name: `Modifier « ${username} »` });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Enregistre la fiche ouverte et attend la réponse du PATCH. */
async function saveEdit(page: Page, dialog: Locator, userId: number) {
  const patched = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/users/${userId}`,
  );
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  expect((await patched).status()).toBe(200);
  // `.last()` : un test peut enregistrer deux fois de suite, le premier message n'a pas encore disparu.
  await expect(page.getByText('Utilisateur modifié').last()).toBeVisible();
  await expect(dialog).toBeHidden();
}

test.describe('Écran Utilisateurs', () => {
  test('SOC-20 liste des comptes : colonnes, recherche et compte admin masqué', async ({ page, api, uniq }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC20'), menuKeys: ['/search'] });
    const user = await createUser(api, { roleId: role.roleId, mustChangePwd: 'keep' });

    await openUsers(page);
    for (const col of ['Nom d’utilisateur', 'Nom', 'Adresse e-mail', 'Rôle']) {
      await expect(page.getByRole('columnheader', { name: col, exact: true })).toBeVisible();
    }

    const row = await rowOf(page, user.username);
    await expect(row).toHaveCount(1);
    await expect(row.getByText(role.name)).toBeVisible();

    // Le compte `admin` protégé n'est jamais listé (ni modifiable ni supprimable depuis l'écran).
    await page.getByRole('textbox', { name: 'Rechercher un compte' }).fill('admin');
    await expect(page.getByRole('cell', { name: 'admin', exact: true })).toHaveCount(0);

    // Recherche sans résultat : état vide explicite.
    await page.getByRole('textbox', { name: 'Rechercher un compte' }).fill(uniq('introuvable'));
    await expect(page.getByText('Aucun compte trouvé')).toBeVisible();
  });

  test('SOC-21 création nominale : le compte se connecte et doit changer son mot de passe', async ({
    page,
    api,
    uniq,
    request,
  }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC21'), menuKeys: ['/search'] });
    const username = uniq('e2e-soc21');

    await openUsers(page);
    await page.getByRole('button', { name: 'Ajouter un utilisateur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel utilisateur' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Nom d’utilisateur').fill(username);
    await dialog.getByLabel('Prénom').fill('Awa');
    await dialog.getByLabel(/^Nom\W*$/).fill('Koné');
    await dialog.getByLabel('Adresse e-mail').fill(`${username}@exemple.test`);
    await dialog.getByLabel('Mot de passe (6 caractères min.)').fill(TEST_PASSWORD);
    await pickOption(page, dialog.getByLabel('Rôle', { exact: true }), role.name);

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/users',
    );
    await dialog.getByRole('button', { name: 'Créer' }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByText('Utilisateur créé')).toBeVisible();
    await expect(dialog).toBeHidden();

    const row = await rowOf(page, username);
    await expect(row).toHaveCount(1);
    await expect(row.getByText(role.name)).toBeVisible();
    await expect(row.getByText(`${username}@exemple.test`)).toBeVisible();

    // Connexion : mot de passe provisoire, changement exigé. (L'étape de changement imposée à la
    // première connexion côté écran — `login/FirstLoginStep.tsx` — relève des specs de l'écran de
    // connexion, pas de celles-ci.)
    const session = await login(request, username, TEST_PASSWORD);
    expect(session.mustChangePwd).toBe(true);
    expect(session.isAdmin).toBe(false);
    const me = await request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const self = (await me.json()) as Me;
    expect(self.mustChangePwd).toBe(true);
    expect((await getUser(api, self.userId)).mustChangePwd).toBe(true);
  });

  // Règle confirmée par l'utilisateur (2026-11-22) : le mot de passe provisoire n'est bloqué qu'à
  // l'écran de connexion, pas par l'API. Un jeton obtenu par POST /auth/login sert les routes.
  test('SOC-21 mot de passe provisoire : l’API n’est pas bloquée (seul l’écran de connexion l’impose)', async ({
    request,
    api,
  }) => {
    const user = await createUser(api, { mustChangePwd: 'keep' });
    const body = await login(request, user.username, user.password);
    expect(body.mustChangePwd).toBe(true);
    const res = await request.get('/api/referentials/document-types', {
      headers: { Authorization: `Bearer ${body.accessToken}` },
    });
    expect(res.status()).toBe(200);
    const me = await request.get('/api/auth/me', { headers: { Authorization: `Bearer ${body.accessToken}` } });
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { mustChangePwd: boolean }).mustChangePwd).toBe(true);
  });

  test('SOC-22 erreurs de saisie : e-mail invalide ou absent, mot de passe trop court', async ({
    page,
    api,
    uniq,
  }) => {
    const username = uniq('e2e-soc22');
    await openUsers(page);
    await page.getByRole('button', { name: 'Ajouter un utilisateur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel utilisateur' });
    const create = dialog.getByRole('button', { name: 'Créer' });
    const email = dialog.getByLabel('Adresse e-mail');
    const password = dialog.getByLabel('Mot de passe (6 caractères min.)');

    await dialog.getByLabel('Nom d’utilisateur').fill(username);
    await dialog.getByLabel('Prénom').fill('Awa');
    await dialog.getByLabel(/^Nom\W*$/).fill('Koné');
    await password.fill(TEST_PASSWORD);

    // E-mail absent.
    await expect(create).toBeDisabled();
    // E-mail invalide : champ en erreur, bouton inactif.
    await email.fill('pas-une-adresse');
    await expect(email).toHaveClass(/ant-input-status-error/);
    await expect(create).toBeDisabled();
    // E-mail valide, mot de passe de 5 caractères.
    await email.fill(`${username}@exemple.test`);
    await password.fill('12345');
    await expect(create).toBeDisabled();
    // Espace en bordure : refusé (l'écran de connexion rogne la saisie, le compte serait verrouillé).
    await password.fill(' 123456');
    await expect(dialog.getByText('Le mot de passe ne doit ni commencer ni finir par une espace.')).toBeVisible();
    await expect(create).toBeDisabled();
    // 6 caractères : accepté.
    await password.fill('123456');
    await expect(create).toBeEnabled();
    // Locale Ant Design fr_FR (`components/Providers.tsx`) : « Annuler ».
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toBeHidden();

    // Même règles côté API (l'écran n'est pas la seule porte) : 400, aucun compte créé.
    const base = {
      username,
      firstName: 'Awa',
      lastName: 'Koné',
      email: `${username}@exemple.test`,
      password: TEST_PASSWORD,
    };
    for (const body of [
      { ...base, email: 'pas-une-adresse' },
      { ...base, email: undefined },
      { ...base, password: '12345' },
      { ...base, password: ` ${TEST_PASSWORD}` },
      { ...base, username: '   ' },
      { ...base, firstName: 'x'.repeat(51) },
    ]) {
      const res = await (api as ApiLike).raw.post('/users', body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
    }
    const users: { username: string }[] = await api.get('/users');
    expect(users.some((u) => u.username === username)).toBe(false);
  });

  test('SOC-23 identifiant déjà utilisé : message lisible, modale conservée', async ({ page, api, uniq }) => {
    const existing = await createUser(api, { mustChangePwd: 'keep' });

    await openUsers(page);
    await page.getByRole('button', { name: 'Ajouter un utilisateur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel utilisateur' });
    await dialog.getByLabel('Nom d’utilisateur').fill(existing.username);
    await dialog.getByLabel('Prénom').fill('Awa');
    await dialog.getByLabel(/^Nom\W*$/).fill('Koné');
    await dialog.getByLabel('Adresse e-mail').fill(`${uniq('dup')}@exemple.test`);
    await dialog.getByLabel('Mot de passe (6 caractères min.)').fill(TEST_PASSWORD);

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/users',
    );
    await dialog.getByRole('button', { name: 'Créer' }).click();
    expect((await created).status()).toBe(409);
    await expect(page.getByText('Cet identifiant est déjà utilisé')).toBeVisible();
    await expect(dialog).toBeVisible();

    // API : identifiant identique, puis identique à un espace final près (rogné) → 409.
    for (const username of [existing.username, ` ${existing.username} `]) {
      const res = await (api as ApiLike).raw.post('/users', {
        username,
        firstName: 'Awa',
        lastName: 'Koné',
        email: `${uniq('dup')}@exemple.test`,
        password: TEST_PASSWORD,
      });
      expect(res.status(), `identifiant « ${username} »`).toBe(409);
    }
  });

  test('SOC-24 modification du rôle et de l’habilitation de confidentialité', async ({
    page,
    api,
    uniq,
    apiAs,
  }) => {
    const roleA = await createRole(api, { name: roleName(uniq, 'SOC24a'), menuKeys: ['/search'] });
    const roleB = await createRole(api, { name: roleName(uniq, 'SOC24b'), menuKeys: ['/admin/dossiers'] });
    const conf = await anyConfidentialite(api, uniq);
    const user = await createUser(api, { roleId: roleA.roleId });

    await openUsers(page);
    const dialog = await openEdit(page, user.username);
    await pickOption(page, dialog.getByLabel('Rôle', { exact: true }), roleB.name);
    await pickOption(page, dialog.getByLabel('Habilitation de confidentialité'), conf.label, { search: false });
    await saveEdit(page, dialog, user.userId);

    const row = await rowOf(page, user.username);
    await expect(row.getByText(roleB.name)).toBeVisible();

    const saved = await getUser(api, user.userId);
    expect(saved.roleId).toBe(roleB.roleId);
    expect(saved.confidentialiteId).toBe(conf.confidentialiteId);

    // Effet immédiat sur les menus de l'utilisateur, sans reconnexion.
    const me: Me = await (await apiAs(user.username, user.password)).get('/auth/me');
    expect(me.role?.roleId).toBe(roleB.roleId);
    expect(me.menuKeys).toContain('/admin/dossiers');
    expect(me.menuKeys).not.toContain('/search');
  });

  test('SOC-25 désactivation depuis la fiche : badge, connexion refusée, réactivation', async ({
    page,
    api,
    request,
  }) => {
    const user = await createUser(api, {});

    await openUsers(page);
    let dialog = await openEdit(page, user.username);
    await dialog.getByRole('switch', { name: 'Compte désactivé' }).click();
    await saveEdit(page, dialog, user.userId);

    const row = await rowOf(page, user.username);
    await expect(row.getByText('Désactivé', { exact: true })).toBeVisible();
    expect((await getUser(api, user.userId)).isDisabled).toBe(true);
    expect((await rawLogin(request, user.username, user.password)).status()).toBe(401);

    // Réversible : réactivé, le compte se reconnecte.
    dialog = await openEdit(page, user.username);
    await expect(dialog.getByRole('switch', { name: 'Compte désactivé' })).toBeChecked();
    await dialog.getByRole('switch', { name: 'Compte désactivé' }).click();
    await saveEdit(page, dialog, user.userId);
    await expect(row.getByText('Désactivé', { exact: true })).toHaveCount(0);
    expect((await rawLogin(request, user.username, user.password)).status()).toBe(201);
  });

  test('SOC-27 nouveau mot de passe saisi dans la fiche : l’ancien est refusé', async ({ page, api, request }) => {
    const user = await createUser(api, {});
    const next = 'Fiche-9876!';

    await openUsers(page);
    const dialog = await openEdit(page, user.username);
    await dialog.getByLabel('Mot de passe (laisser vide pour ne pas changer)').fill(next);
    await saveEdit(page, dialog, user.userId);

    expect((await rawLogin(request, user.username, user.password)).status()).toBe(401);
    expect((await rawLogin(request, user.username, next)).status()).toBe(201);
  });

  // Hypothèse métier appliquée (option prudente, voir rapport) : le mot de passe saisi dans la fiche
  // (`PATCH /users/:id { password }`, seul chemin de l'écran) est provisoire, comme
  // `POST /users/:id/reset-password` (users.service.ts, updateUser).
  test('SOC-27 mot de passe changé depuis la fiche : changement exigé à la connexion', async ({
    page,
    api,
    request,
  }) => {
    const user = await createUser(api, {});
    await openUsers(page);
    const dialog = await openEdit(page, user.username);
    await dialog.getByLabel('Mot de passe (laisser vide pour ne pas changer)').fill('Fiche-9876!');
    await saveEdit(page, dialog, user.userId);
    expect((await login(request, user.username, 'Fiche-9876!')).mustChangePwd).toBe(true);
  });

  test('SOC-28 suppression : confirmation, compte retiré, connexion refusée', async ({ page, api, request }) => {
    const user = await createUser(api, {});

    await openUsers(page);
    let row = await rowOf(page, user.username);

    // Annuler ne supprime rien.
    await row.getByRole('button', { name: 'Supprimer' }).click();
    let confirm = page.getByRole('dialog').filter({ hasText: user.username });
    await expect(confirm.getByText('Cette action est définitive.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    await expect(confirm).toBeHidden();
    await expect(row).toHaveCount(1);

    // Confirmer supprime.
    await row.getByRole('button', { name: 'Supprimer' }).click();
    confirm = page.getByRole('dialog').filter({ hasText: user.username });
    const deleted = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/users/${user.userId}`,
    );
    await confirm.getByRole('button', { name: 'Supprimer' }).click();
    expect((await deleted).status()).toBe(200);
    await expect(page.getByText('Utilisateur supprimé')).toBeVisible();

    row = await rowOf(page, user.username);
    await expect(row).toHaveCount(0);
    expect((await rawLogin(request, user.username, user.password)).status()).toBe(401);
  });
});
