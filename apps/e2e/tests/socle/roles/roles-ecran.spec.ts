/**
 * Écran « Rôles » (`apps/web/app/admin/roles/page.tsx`) — scénarios SOC-30 à SOC-35.
 *
 * Libellés repris du code : carte « Nouveau rôle » / « Modifier le rôle » / « Permissions du rôle
 * (lecture seule) », champ « Nom du rôle », cases à cocher = libellés du catalogue
 * (`apps/api/src/modules/roles/menu-catalog.ts`, ex. « Recherche », « Utilisateurs », « Dossiers »),
 * boutons « Créer le rôle » / « Enregistrer » / « Annuler » / « Fermer », actions de ligne
 * « Permissions » / « Voir » / « Supprimer » (aria-label), confirmation « Supprimer ».
 *
 * La table n'a pas de recherche et pagine par 10 (tri par nom) : les rôles de ce fichier sont
 * préfixés « 0 » pour passer en tête (voir `roleName`) et supprimés après chaque test.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { createRole, createUser } from '../_helpers/accounts';
import { revealRow } from '../_helpers/securite';
import {
  afterReload,
  escapeRe,
  getRole,
  getUser,
  roleName,
  systemRole,
  type ApiLike,
  type Me,
  type RoleRow,
} from '../_helpers/tache-a';

/** Rôles créés par le test en cours, supprimés en fin de test (la table n'a pas de recherche). */
let created: number[] = [];

test.beforeEach(() => {
  created = [];
});

test.afterEach(async ({ api }) => {
  for (const roleId of created) {
    await (api as ApiLike).raw.del(`/roles/${roleId}`);
  }
});

async function openRoles(page: Page) {
  const menus = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/roles/menus',
  );
  await afterReload(page, '/roles', () => page.goto('/admin/roles'));
  await menus;
  await expect(page.getByRole('heading', { name: 'Rôles', exact: true })).toBeVisible();
}

const rowOf = (page: Page, name: string) =>
  page.getByRole('row', { name: new RegExp(escapeRe(name)) });

/**
 * Ligne d'un rôle, rendue visible en parcourant la pagination (10 par page, tri par nom) : la base
 * de la pile n'est pas remise à zéro et d'autres specs créent des rôles en parallèle, on ne peut
 * donc pas supposer que la ligne est en page 1.
 */
const revealRole = (page: Page, name: string) => revealRow(page, name);

/** Carte de droite (formulaire), repérée par son titre. */
const formCard = (page: Page, title: string) =>
  page.locator('.ant-card').filter({ has: page.getByText(title, { exact: true }) });

const menuBox = (page: Page, label: string) => page.getByRole('checkbox', { name: label, exact: true });

test.describe('Écran Rôles', () => {
  test('SOC-30 création d’un rôle avec ses menus', async ({ page, api, uniq, apiAs }) => {
    const name = roleName(uniq, 'SOC30');
    await openRoles(page);

    const card = formCard(page, 'Nouveau rôle');
    const submit = card.getByRole('button', { name: 'Créer le rôle' });
    await expect(submit).toBeDisabled(); // nom obligatoire
    await card.getByLabel('Nom du rôle').fill('   ');
    await expect(submit).toBeDisabled(); // espaces seuls refusés
    await card.getByLabel('Nom du rôle').fill(name);
    await menuBox(page, 'Recherche').check();
    await menuBox(page, 'Utilisateurs').check();

    const post = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/roles',
    );
    await submit.click();
    const res = await post;
    expect(res.status()).toBe(201);
    const role = (await res.json()) as RoleRow;
    created.push(role.roleId);
    await expect(page.getByText('Rôle créé')).toBeVisible();
    await expect(await revealRole(page, name)).toBeVisible();
    // Formulaire remis à zéro.
    await expect(card.getByLabel('Nom du rôle')).toHaveValue('');

    expect([...(await getRole(api, role.roleId))!.menuKeys].sort()).toEqual(['/admin/users', '/search']);

    // Un utilisateur portant ce rôle reçoit exactement ces menus, plus l'accueil.
    const user = await createUser(api, { roleId: role.roleId });
    const me: Me = await (await apiAs(user.username, user.password)).get('/auth/me');
    expect([...me.menuKeys].sort()).toEqual(['/', '/admin/users', '/search']);
  });

  test('SOC-31 modification des menus : effet immédiat sur /auth/me et sur les droits API', async ({
    page,
    api,
    uniq,
    apiAs,
  }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC31'), menuKeys: ['/search'] });
    created.push(role.roleId);
    const user = await createUser(api, { roleId: role.roleId });
    const client = (await apiAs(user.username, user.password)) as ApiLike;
    expect((await client.raw.get('/users')).status()).toBe(403);

    await openRoles(page);
    await (await revealRole(page, role.name)).getByRole('button', { name: 'Permissions' }).click();
    const card = formCard(page, 'Modifier le rôle');
    await expect(card.getByLabel('Nom du rôle')).toHaveValue(role.name);
    await expect(menuBox(page, 'Recherche')).toBeChecked();
    await menuBox(page, 'Recherche').uncheck();
    await menuBox(page, 'Utilisateurs').check();

    const patch = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/roles/${role.roleId}`,
    );
    await card.getByRole('button', { name: 'Enregistrer' }).click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByText('Rôle mis à jour')).toBeVisible();

    // Même jeton, sans reconnexion : les menus sont relus à chaque requête.
    const me: Me = await client.get('/auth/me');
    expect(me.menuKeys).toContain('/admin/users');
    expect(me.menuKeys).not.toContain('/search');
    expect((await client.raw.get('/users')).status()).toBe(200);
  });

  test('SOC-31 abandon d’une saisie : confirmation avant de vider le formulaire', async ({ page, api, uniq }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC31b'), menuKeys: ['/search'] });
    created.push(role.roleId);

    await openRoles(page);
    await (await revealRole(page, role.name)).getByRole('button', { name: 'Permissions' }).click();
    const card = formCard(page, 'Modifier le rôle');
    await menuBox(page, 'Dossiers').check();
    await card.getByRole('button', { name: 'Annuler' }).click();

    const confirm = page.getByRole('dialog').filter({ hasText: 'Abandonner les modifications non enregistrées ?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Abandonner' }).click();
    await expect(formCard(page, 'Nouveau rôle')).toBeVisible();

    // Rien n'a été enregistré.
    expect((await getRole(api, role.roleId))!.menuKeys).toEqual(['/search']);
  });

  test('SOC-32 désactivation d’un rôle : ses menus sont retirés, puis rendus', async ({ api, uniq, apiAs }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC32'), menuKeys: ['/admin/users', '/search'] });
    created.push(role.roleId);
    const user = await createUser(api, { roleId: role.roleId });
    const client = (await apiAs(user.username, user.password)) as ApiLike;
    expect((await client.raw.get('/users')).status()).toBe(200);

    // L'écran n'a pas d'interrupteur « Actif » : la désactivation passe par l'API (voir fixme).
    await api.patch(`/roles/${role.roleId}`, { isActive: false });
    let me: Me = await client.get('/auth/me');
    expect(me.menuKeys).toEqual(['/']);
    expect((await client.raw.get('/users')).status()).toBe(403);

    await api.patch(`/roles/${role.roleId}`, { isActive: true });
    me = await client.get('/auth/me');
    expect([...me.menuKeys].sort()).toEqual(['/', '/admin/users', '/search']);
    expect((await client.raw.get('/users')).status()).toBe(200);
  });

  // Écart / question métier : l'API accepte `isActive` (PATCH /roles/:id) mais l'écran Rôles n'expose
  // aucun interrupteur. Faut-il l'ajouter (libellé et emplacement à décider) ?
  test.fixme('SOC-32 (question métier) désactiver un rôle depuis l’écran Rôles', async ({ page, api, uniq }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC32b'), menuKeys: ['/search'] });
    created.push(role.roleId);
    await openRoles(page);
    await (await revealRole(page, role.name)).getByRole('button', { name: 'Permissions' }).click();
    await formCard(page, 'Modifier le rôle').getByRole('switch', { name: 'Rôle actif' }).click();
    await formCard(page, 'Modifier le rôle').getByRole('button', { name: 'Enregistrer' }).click();
    expect((await getRole(api, role.roleId))!.isActive).toBe(false);
  });

  test('SOC-33 rôle système : consultation seule, API refuse modification et suppression', async ({ page, api }) => {
    const sys = await systemRole(api);
    await openRoles(page);

    const row = await revealRole(page, sys.name);
    await expect(row.getByText('Système', { exact: true })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Permissions' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Supprimer' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Voir' }).click();

    const card = formCard(page, 'Permissions du rôle (lecture seule)');
    await expect(card.getByLabel('Nom du rôle')).toBeDisabled();
    await expect(menuBox(page, 'Utilisateurs')).toBeChecked();
    await expect(menuBox(page, 'Utilisateurs')).toBeDisabled();
    await expect(card.getByText('Rôle système : accès complet, non modifiable et non supprimable.')).toBeVisible();
    await expect(card.getByRole('button', { name: /Enregistrer|Créer le rôle/ })).toHaveCount(0);
    await card.getByRole('button', { name: 'Fermer' }).click();
    await expect(formCard(page, 'Nouveau rôle')).toBeVisible();

    const raw = (api as ApiLike).raw;
    for (const body of [{ menuKeys: [] }, { isActive: false }, { name: 'Renommé' }]) {
      const res = await raw.patch(`/roles/${sys.roleId}`, body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe(
        'Le rôle système par défaut ne peut pas être modifié.',
      );
    }
    const del = await raw.del(`/roles/${sys.roleId}`);
    expect(del.status()).toBe(400);
    expect(((await del.json()) as { message: string }).message).toBe(
      'Le rôle système par défaut ne peut pas être supprimé.',
    );
    const after = (await getRole(api, sys.roleId))!;
    expect(after.name).toBe(sys.name);
    expect(after.isActive).toBe(true);
  });

  test('SOC-34 suppression d’un rôle utilisé : confirmation, utilisateurs ramenés à l’accueil', async ({
    page,
    api,
    uniq,
    apiAs,
  }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC34'), menuKeys: ['/admin/users'] });
    created.push(role.roleId);
    const user = await createUser(api, { roleId: role.roleId });
    const client = (await apiAs(user.username, user.password)) as ApiLike;
    expect((await client.raw.get('/users')).status()).toBe(200);

    await openRoles(page);
    await (await revealRole(page, role.name)).getByRole('button', { name: 'Supprimer' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: role.name });
    await expect(
      confirm.getByText("1 utilisateur(s) perdront ce rôle (ils ne verront plus que l'accueil)."),
    ).toBeVisible();
    const del = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/api/roles/${role.roleId}`,
    );
    await confirm.getByRole('button', { name: 'Supprimer' }).click();
    expect((await del).status()).toBe(200);
    await expect(page.getByText('Rôle supprimé')).toBeVisible();
    await expect(rowOf(page, role.name)).toHaveCount(0);

    expect((await getUser(api, user.userId)).roleId).toBeNull();
    const me: Me = await client.get('/auth/me');
    expect(me.role).toBeNull();
    expect(me.menuKeys).toEqual(['/']);
    expect((await client.raw.get('/users')).status()).toBe(403);

    expect((await (api as ApiLike).raw.del(`/roles/${role.roleId}`)).status()).toBe(404);
  });

  // Nécessite un courrier adressé au rôle (`mail.destinataire_role_id`, FK ON DELETE NO ACTION) :
  // fixture courrier à fournir en phase B. Avant correctif : 500 ; après : 400 lisible (couvert par
  // `roles.service.spec.ts`).
  test.fixme('SOC-34 rôle destinataire d’un courrier : suppression refusée avec un message lisible', async ({
    api,
    uniq,
  }) => {
    const role = await createRole(api, { name: roleName(uniq, 'SOC34b'), menuKeys: [] });
    created.push(role.roleId);
    // TODO phase B : créer un courrier dont le destinataire est `role.roleId`.
    const res = await (api as ApiLike).raw.del(`/roles/${role.roleId}`);
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('des courriers sont adressés à ce rôle');
  });

  test('SOC-35 validation du rôle : nom obligatoire, borné, menus hors catalogue ignorés', async ({ api, uniq }) => {
    const raw = (api as ApiLike).raw;
    for (const name of ['', '   ', 'x'.repeat(201)]) {
      expect((await raw.post('/roles', { name, menuKeys: [] })).status(), `nom « ${name.slice(0, 10)} »`).toBe(400);
    }

    // Clés inconnues, accueil et écrans réservés à l'admin (`/connecteurs`) ne s'attribuent pas.
    const role: RoleRow = await api.post('/roles', {
      name: roleName(uniq, 'SOC35'),
      menuKeys: ['/inexistant', '/', '/connecteurs', '/search', '/search'],
    });
    created.push(role.roleId);
    expect(role.menuKeys).toEqual(['/search']);

    // Renommer en espaces : 400, nom conservé.
    expect((await raw.patch(`/roles/${role.roleId}`, { name: '   ' })).status()).toBe(400);
    expect((await getRole(api, role.roleId))!.name).toBe(role.name);
    // Rôle inexistant : 404.
    expect((await raw.patch('/roles/2147483000', { name: 'x' })).status()).toBe(404);
  });

  // Question métier : `role.name` n'est pas unique (ni en base ni dans l'API) ; deux rôles homonymes
  // sont indiscernables dans les listes déroulantes (Utilisateurs, Sécurité par rôle). Refuser (409) ?
  test.fixme('SOC-35 (question métier) nom de rôle déjà utilisé : refus 409', async ({ api, uniq }) => {
    const name = roleName(uniq, 'SOC35b');
    const first: RoleRow = await api.post('/roles', { name, menuKeys: [] });
    created.push(first.roleId);
    const res = await (api as ApiLike).raw.post('/roles', { name, menuKeys: [] });
    if (res.ok()) created.push(((await res.json()) as RoleRow).roleId);
    expect(res.status()).toBe(409);
  });
});
