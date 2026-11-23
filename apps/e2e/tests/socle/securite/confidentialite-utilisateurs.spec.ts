/**
 * Sécurité Documentaire — « Confidentialité des utilisateurs »
 * (`/admin/securite/confidentialite-utilisateurs`) : affectation EN MASSE de l'habilitation via
 * `PATCH /users/confidentialite`, ouverte au menu « Utilisateurs » OU à ce menu-ci. Le compte
 * `admin` protégé est exclu par la requête elle-même.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { anyConfidentialite, createRestrictedUser, createRole, createUser } from '../_helpers/accounts';
import {
  ACCESS_DENIED_FIXME,
  ACCESS_DENIED_TEXT,
  SECURITY_MENU,
  UNKNOWN_ID,
  confirmPopover,
  findUser,
  pickOption,
  waitApi,
  type UserListRow,
} from '../_helpers/securite';

const PAGE = '/admin/securite/confidentialite-utilisateurs';
/** Compte super-admin du seed, protégé par `UsersService` (nom codé en dur côté API). */
const PROTECTED_ADMIN = 'admin';

async function openPage(page: Page) {
  const users = waitApi(page, 'GET', '/users');
  await page.goto(PAGE);
  expect((await users).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Confidentialité des utilisateurs' })).toBeVisible();
}

/** Restreint la table aux deux comptes du test (préfixe commun) et les coche. */
async function selectPair(page: Page, prefix: string, usernames: string[]) {
  await page.getByLabel('Rechercher').fill(prefix);
  for (const username of usernames) {
    const row = page.getByRole('row', { name: new RegExp(username) });
    await expect(row).toBeVisible();
    await row.getByRole('checkbox').check();
  }
  await expect(page.getByRole('button', { name: `Appliquer (${usernames.length})` })).toBeEnabled();
}

test('SOC-47 affecter un niveau à plusieurs utilisateurs en une fois', async ({ page, api, uniq }) => {
  const level = await anyConfidentialite(api, uniq);
  const prefix = uniq('soc47');
  const a = await createUser(api, { username: `${prefix}-a` });
  const b = await createUser(api, { username: `${prefix}-b` });

  await openPage(page);
  await selectPair(page, prefix, [a.username, b.username]);
  await pickOption(page, page.getByLabel('Niveau à appliquer'), level.label);
  await page.getByRole('button', { name: 'Appliquer (2)' }).click();
  const patched = waitApi(page, 'PATCH', '/users/confidentialite');
  await confirmPopover(page, 'Appliquer');
  expect((await patched).status()).toBe(200);
  await expect(page.getByText('Niveau appliqué à 2 utilisateur(s).')).toBeVisible();
  // Sélection remise à zéro, colonne « Confidentialité actuelle » à jour.
  await expect(page.getByRole('button', { name: 'Appliquer (0)' })).toBeDisabled();
  await expect(page.getByRole('row', { name: new RegExp(a.username) })).toContainText(level.label);

  for (const u of [a, b]) {
    expect((await findUser(api, u.userId)).confidentialiteId).toBe(level.confidentialiteId);
  }
});

test('SOC-48 retirer l’habilitation (aucun niveau) : avertissement puis retrait effectif', async ({
  page,
  api,
  uniq,
}) => {
  const level = await anyConfidentialite(api, uniq);
  const prefix = uniq('soc48');
  const a = await createUser(api, { username: `${prefix}-a`, confidentialiteId: level.confidentialiteId });
  const b = await createUser(api, { username: `${prefix}-b`, confidentialiteId: level.confidentialiteId });

  await openPage(page);
  await selectPair(page, prefix, [a.username, b.username]);
  await expect(page.getByText('Aucun niveau sélectionné')).toBeVisible();
  await expect(page.getByText(/RETIRERA l’habilitation de 2 utilisateur\(s\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Appliquer (2)' }).click();
  const patched = waitApi(page, 'PATCH', '/users/confidentialite');
  await confirmPopover(page, 'Retirer');
  expect((await patched).status()).toBe(200);
  await expect(page.getByText('Niveau appliqué à 2 utilisateur(s).')).toBeVisible();

  for (const u of [a, b]) expect((await findUser(api, u.userId)).confidentialiteId).toBeNull();
});

test('SOC-49 le compte admin protégé est exclu, à l’écran comme par l’API', async ({ page, api, uniq }) => {
  const level = await anyConfidentialite(api, uniq);
  const users: UserListRow[] = await api.get('/users');
  const admin = users.find((u) => u.username === PROTECTED_ADMIN);
  expect(admin, 'compte « admin » du seed').toBeDefined();

  await openPage(page);
  await page.getByLabel('Rechercher').fill(PROTECTED_ADMIN);
  await expect(page.getByRole('cell', { name: PROTECTED_ADMIN, exact: true })).toHaveCount(0);

  // Appel direct : la requête elle-même l'écarte (0 compte modifié), son habilitation ne bouge pas.
  const other = admin!.confidentialiteId === level.confidentialiteId ? null : level.confidentialiteId;
  const res = await api.patch('/users/confidentialite', { userIds: [admin!.userId], confidentialiteId: other });
  expect(res).toEqual({ updated: 0 });
  expect((await findUser(api, admin!.userId)).confidentialiteId).toBe(admin!.confidentialiteId);
});

test('SOC-50 titulaire du seul menu de cet écran : il habilite, sans pouvoir toucher isAdmin ni le rôle', async ({
  api,
  apiAs,
  uniq,
}) => {
  const level = await anyConfidentialite(api, uniq);
  const holder = await createRestrictedUser(api, uniq, [SECURITY_MENU.userConfidentiality]);
  const otherRole = await createRole(api, { name: uniq('soc50-role'), menuKeys: [] });
  const target = await createUser(api, { username: uniq('soc50-cible') });
  const as = await apiAs(holder.username, holder.password);

  // Lecture de l'annuaire : permise par ce menu (l'écran en a besoin).
  expect((await as.raw.get('/users')).status()).toBe(200);

  // Champs étrangers au schéma (`bulkConfidentialiteSchema`) : ignorés, jamais appliqués.
  const res = await as.raw.patch('/users/confidentialite', {
    userIds: [target.userId, holder.userId],
    confidentialiteId: level.confidentialiteId,
    isAdmin: true,
    roleId: otherRole.roleId,
    password: 'Pirate-1234!',
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ updated: 2 });

  const t = await findUser(api, target.userId);
  expect(t).toMatchObject({ isAdmin: false, roleId: null, confidentialiteId: level.confidentialiteId });
  const h = await findUser(api, holder.userId);
  expect(h).toMatchObject({ isAdmin: false, roleId: holder.roleId });
  // Le mot de passe n'a pas changé : l'ancien fonctionne toujours.
  await expect(apiAs(target.username, target.password)).resolves.toBeTruthy();

  // Les écritures du menu « Utilisateurs » lui restent fermées.
  expect((await as.raw.patch(`/users/${target.userId}`, { isAdmin: true })).status()).toBe(403);
  expect((await as.raw.patch(`/users/${holder.userId}`, { roleId: otherRole.roleId })).status()).toBe(403);
  expect(
    (
      await as.raw.post('/users', {
        username: uniq('soc50-intrus'),
        firstName: 'Intrus',
        lastName: 'E2E',
        email: 'intrus@e2e.test',
        password: 'Init-1234!',
        isAdmin: true,
      })
    ).status(),
  ).toBe(403);
});

test('SOC-51 saisies invalides : refus en 400, jamais de 500', async ({ api, uniq }) => {
  const target = await createUser(api, { username: uniq('soc51') });
  const cases: Array<[string, unknown]> = [
    ['liste vide', { userIds: [], confidentialiteId: null }],
    ['niveau absent (le null doit être explicite)', { userIds: [target.userId] }],
    ['identifiant non entier', { userIds: ['x'], confidentialiteId: null }],
    ['niveau non entier', { userIds: [target.userId], confidentialiteId: 'Secret' }],
  ];
  for (const [name, body] of cases) {
    expect((await api.raw.patch('/users/confidentialite', body)).status(), name).toBe(400);
  }
});

// ANO-SOC (corrigée) : `setConfidentialite` vérifie désormais que le niveau existe et est actif
// (users.service.ts) ; avant, la clé étrangère échouait en P2003 → 500.
test('SOC-51 niveau inexistant : refus 400 lisible, pas de violation de clé étrangère en 500', async ({
  api,
  uniq,
}) => {
  const target = await createUser(api, { username: uniq('soc51-fk') });
  const res = await api.raw.patch('/users/confidentialite', {
    userIds: [target.userId],
    confidentialiteId: UNKNOWN_ID,
  });
  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('Niveau de confidentialité introuvable');
  expect((await findUser(api, target.userId)).confidentialiteId).toBeNull();
});

test('SOC-52 sans le menu : annuaire et affectation refusés (403)', async ({ api, apiAs, uniq }) => {
  const restricted = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
  const as = await apiAs(restricted.username, restricted.password);
  expect((await as.raw.get('/users')).status()).toBe(403);
  expect(
    (await as.raw.patch('/users/confidentialite', { userIds: [restricted.userId], confidentialiteId: null })).status(),
  ).toBe(403);
});

test.describe('SOC-52 interface pour un utilisateur sans le menu', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('SOC-52 menu absent de la barre latérale', async ({ page, api, loginAs, uniq }) => {
    const restricted = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
    await loginAs(page, restricted.username, restricted.password);
    await expect(page.getByRole('menuitem', { name: 'Paramétrage Archives', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Sécurité Documentaire/ })).toHaveCount(0);
  });

  // L'annuaire et l'affectation sont refusés par l'API (403, test précédent). L'écran ouvert par son
  // adresse doit afficher le refus dès l'ouverture plutôt qu'une liste vide : décision utilisateur,
  // correctif dans `AuthShell`.
  test.fixme(`SOC-52 écran ouvert par URL sans le menu : « Accès refusé » dès l'ouverture (${ACCESS_DENIED_FIXME})`, async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const restricted = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
    await loginAs(page, restricted.username, restricted.password);
    await page.goto(PAGE);
    await expect(page.getByText(ACCESS_DENIED_TEXT)).toBeVisible();
  });
});
