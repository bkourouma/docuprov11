/**
 * Contrôle d'accès de l'API du socle (utilisateurs, rôles, référentiels sensibles).
 * Scénarios SOC-36 à SOC-39. Refus attendus : 401 sans session valide, 403 sans le droit.
 *
 * Correctifs couverts : F1 (jeton d'un compte désactivé/rétrogradé, voir aussi
 * `users/utilisateurs-session.spec.ts`), F2 (statut administrateur réservé aux administrateurs),
 * F3 (`POST /referentials/document-permissions` réservé aux administrateurs).
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser, createUser, TEST_PASSWORD } from '../_helpers/accounts';
import {
  callWithToken,
  forgedAdminToken,
  login,
  newUserBody,
  protectedAdminId,
  rawLogin,
  systemRole,
  unsignedAdminToken,
  type ApiLike,
  type Me,
} from '../_helpers/tache-a';

type Verb = 'get' | 'post' | 'patch' | 'del';
interface Route {
  verb: Verb;
  path: string;
  body?: unknown;
}

const send = (client: ApiLike, r: Route) =>
  r.verb === 'get' || r.verb === 'del' ? client.raw[r.verb](r.path) : client.raw[r.verb](r.path, r.body);

test.describe('API du socle — permissions', () => {
  test('SOC-36 utilisateur sans menu d’administration : 403 sur les routes du socle', async ({
    api,
    uniq,
    apiAs,
    request,
  }) => {
    // Rôle limité à « Recherche » : authentifié, mais sans « Utilisateurs » ni « Rôles ».
    const agent = await createRestrictedUser(api, uniq, ['/search']);
    const other = await createUser(api, {});
    const client = (await apiAs(agent.username, agent.password)) as ApiLike;

    // Témoin : la session est valide et porte bien ses seuls menus.
    const me: Me = await client.get('/auth/me');
    expect([...me.menuKeys].sort()).toEqual(['/', '/search']);

    const routes: Route[] = [
      // Utilisateurs (@RequireMenu('/admin/users'))
      { verb: 'get', path: '/users' },
      { verb: 'post', path: '/users', body: newUserBody(uniq) },
      { verb: 'patch', path: `/users/${other.userId}`, body: { isDisabled: true } },
      { verb: 'patch', path: `/users/${agent.userId}`, body: { isAdmin: true } },
      { verb: 'post', path: `/users/${other.userId}/reset-password`, body: { newPassword: 'Pirate-123!' } },
      { verb: 'del', path: `/users/${other.userId}` },
      { verb: 'post', path: `/users/${other.userId}/groups`, body: { groupId: 1 } },
      { verb: 'get', path: '/users/groups/all' },
      { verb: 'post', path: '/users/groups/all', body: { name: uniq('profil') } },
      { verb: 'patch', path: '/users/confidentialite', body: { userIds: [other.userId], confidentialiteId: null } },
      // Rôles (@RequireMenu('/admin/roles'), liste élargie à Utilisateurs / Sécurité par rôle)
      { verb: 'get', path: '/roles' },
      { verb: 'get', path: '/roles/menus' },
      { verb: 'post', path: '/roles', body: { name: uniq('role-pirate'), menuKeys: ['/admin/users'] } },
      { verb: 'patch', path: `/roles/${agent.roleId}`, body: { menuKeys: ['/admin/users', '/admin/roles'] } },
      { verb: 'del', path: `/roles/${agent.roleId}` },
      // Référentiels sensibles
      { verb: 'post', path: '/referentials/document-permissions', body: { documentId: 1, userGroupId: 1, permissionLevelId: 1 } },
      { verb: 'post', path: '/referentials/file-types', body: { extension: 'zzz', friendlyName: 'Pirate', isMedia: false } },
      { verb: 'post', path: '/referentials/confidentialites', body: { label: uniq('conf-pirate') } },
    ];
    for (const r of routes) {
      const res = await send(client, r);
      expect.soft(res.status(), `${r.verb.toUpperCase()} ${r.path}`).toBe(403);
    }

    // Rien n'a bougé.
    const after: Me = await client.get('/auth/me');
    expect(after.isAdmin).toBe(false);
    expect([...after.menuKeys].sort()).toEqual(['/', '/search']);
    // Le compte visé n'a été ni désactivé, ni supprimé, ni changé de mot de passe.
    expect((await rawLogin(request, other.username, other.password)).status()).toBe(201);
  });

  test.describe('SOC-37 titulaire du seul menu « Utilisateurs » (FAILLE F2)', () => {
    test('SOC-37 ne peut ni créer un administrateur ni se promouvoir', async ({ api, uniq, apiAs }) => {
      const manager = await createRestrictedUser(api, uniq, ['/admin/users']);
      const client = (await apiAs(manager.username, manager.password)) as ApiLike;

      const body = newUserBody(uniq, { isAdmin: true });
      expect((await client.raw.post('/users', body)).status()).toBe(403);
      const users: { username: string }[] = await api.get('/users');
      expect(users.some((u) => u.username === body.username)).toBe(false);

      expect((await client.raw.patch(`/users/${manager.userId}`, { isAdmin: true })).status()).toBe(403);
      const me: Me = await client.get('/auth/me');
      expect(me.isAdmin).toBe(false);
    });

    test('SOC-37 ne peut ni réinitialiser, ni modifier, ni désactiver, ni supprimer un administrateur', async ({
      api,
      uniq,
      apiAs,
      request,
    }) => {
      const manager = await createRestrictedUser(api, uniq, ['/admin/users']);
      const chef = await createUser(api, { isAdmin: true });
      const adminId = await protectedAdminId(api);
      const client = (await apiAs(manager.username, manager.password)) as ApiLike;

      for (const targetId of [chef.userId, adminId]) {
        const routes: Route[] = [
          { verb: 'post', path: `/users/${targetId}/reset-password`, body: { newPassword: 'Pirate-123!' } },
          { verb: 'patch', path: `/users/${targetId}`, body: { isDisabled: true } },
          { verb: 'patch', path: `/users/${targetId}`, body: { email: 'pirate@exemple.test' } },
          { verb: 'post', path: `/users/${targetId}/groups`, body: { groupId: 1, isDefault: true } },
          { verb: 'del', path: `/users/${targetId}` },
        ];
        for (const r of routes) {
          const status = (await send(client, r)).status();
          // Le compte `admin` garde son refus historique (400) sur PATCH/DELETE ; un autre
          // administrateur reçoit 403. Les deux sont des refus — jamais 2xx.
          const expected = targetId === adminId && r.path === `/users/${adminId}` ? 400 : 403;
          expect.soft(status, `${r.verb.toUpperCase()} ${r.path}`).toBe(expected);
        }
      }

      // L'administrateur visé garde son mot de passe et son statut.
      const session = await login(request, chef.username, chef.password);
      expect(session.isAdmin).toBe(true);
    });

    test('SOC-37 ne peut pas attribuer le rôle système', async ({ api, uniq, apiAs }) => {
      const manager = await createRestrictedUser(api, uniq, ['/admin/users']);
      const target = await createUser(api, {});
      const sys = await systemRole(api);
      const client = (await apiAs(manager.username, manager.password)) as ApiLike;

      expect((await client.raw.patch(`/users/${manager.userId}`, { roleId: sys.roleId })).status()).toBe(403);
      expect((await client.raw.patch(`/users/${target.userId}`, { roleId: sys.roleId })).status()).toBe(403);
      expect((await client.raw.post('/users', newUserBody(uniq, { roleId: sys.roleId }))).status()).toBe(403);
      const me: Me = await client.get('/auth/me');
      expect(me.role?.roleId).toBe(manager.roleId);
    });

    test('SOC-37 gère toujours les comptes ordinaires (le correctif ne sur-bloque pas)', async ({
      api,
      uniq,
      apiAs,
      request,
    }) => {
      const manager = await createRestrictedUser(api, uniq, ['/admin/users']);
      const client = (await apiAs(manager.username, manager.password)) as ApiLike;

      const body = newUserBody(uniq, { isAdmin: false });
      const created: { userId: number } = await client.post('/users', body);
      await client.patch(`/users/${created.userId}`, { isAdmin: false, email: `${body.username}@autre.test` });
      expect(await client.post(`/users/${created.userId}/reset-password`, { newPassword: 'Reset-5678!' })).toEqual({
        reset: true,
      });
      expect((await login(request, body.username, 'Reset-5678!')).mustChangePwd).toBe(true);
      await client.patch(`/users/${created.userId}`, { isDisabled: true });
      expect((await rawLogin(request, body.username, 'Reset-5678!')).status()).toBe(401);
      expect(await client.del(`/users/${created.userId}`)).toEqual({ deleted: true });
    });

    // Règle confirmée par l'utilisateur (2026-11-22) : un administrateur délégué (menu « Utilisateurs »)
    // peut s'attribuer un rôle non système plus large que le sien. Seuls `isAdmin`, les comptes
    // administrateurs et le rôle système lui restent interdits (F2).
    test('SOC-37 peut s’attribuer un rôle non système plus large que le sien (règle confirmée)', async ({
      api,
      uniq,
      apiAs,
    }) => {
      const manager = await createRestrictedUser(api, uniq, ['/admin/users']);
      const wide: { roleId: number } = await api.post('/roles', {
        name: `0 ${uniq('e2e-SOC37-large')}`,
        menuKeys: ['/admin/users', '/admin/roles', '/admin/dossiers'],
      });
      const client = (await apiAs(manager.username, manager.password)) as ApiLike;
      expect((await client.raw.patch(`/users/${manager.userId}`, { roleId: wide.roleId })).status()).toBe(200);
      const me: { menuKeys: string[] } = await client.get('/auth/me');
      expect(me.menuKeys).toEqual(expect.arrayContaining(['/admin/roles', '/admin/dossiers']));
      expect((await client.raw.get('/roles/menus')).status()).toBe(200);
      await api.del(`/users/${manager.userId}`);
      await api.del(`/roles/${wide.roleId}`);
    });
  });

  // Règle confirmée par l'utilisateur (2026-11-22) : le titulaire du menu « Rôles » peut élargir son
  // propre rôle (ici : s'ouvrir « Utilisateurs »).
  test('SOC-37 un titulaire de « Rôles » peut élargir son propre rôle (règle confirmée)', async ({
    api,
    uniq,
    apiAs,
  }) => {
    const roleAdmin = await createRestrictedUser(api, uniq, ['/admin/roles']);
    const client = (await apiAs(roleAdmin.username, roleAdmin.password)) as ApiLike;
    expect((await client.raw.get('/users')).status()).toBe(403);
    const res = await client.raw.patch(`/roles/${roleAdmin.roleId}`, { menuKeys: ['/admin/roles', '/admin/users'] });
    expect(res.status()).toBe(200);
    expect((await client.raw.get('/users')).status()).toBe(200);
  });

  test('SOC-38 FAILLE F3 droit sur un document : réservé aux administrateurs', async ({ api, uniq, apiAs }) => {
    // Même un titulaire des menus de sécurité documentaire n'octroie pas de droit par document par
    // cette route : la voie normale est l'onglet « Accès » de la fiche (POST /documents/:id/permissions).
    const agent = await createRestrictedUser(api, uniq, [
      '/search',
      '/admin/securite/type-par-utilisateur',
      '/admin/securite/type-par-profil',
    ]);
    const client = (await apiAs(agent.username, agent.password)) as ApiLike;
    const res = await client.raw.post('/referentials/document-permissions', {
      documentId: 1,
      userGroupId: 1,
      permissionLevelId: 4,
    });
    expect(res.status()).toBe(403);
  });

  // FAILLE corrigée (décision de l'utilisateur du 2026-11-22) : octroi, retrait et liste des droits
  // par TYPE réservés aux titulaires des menus « Type par utilisateur » / « Type par profil ».
  test('SOC-38 droits par type : octroi, retrait et liste refusés sans menu de sécurité', async ({
    api,
    uniq,
    apiAs,
  }) => {
    const agent = await createRestrictedUser(api, uniq, ['/search']);
    const client = (await apiAs(agent.username, agent.password)) as ApiLike;
    const type: { documentTypeId: number } = await api.post('/referentials/document-types', {
      label: uniq('SOC38 type'),
    });
    const victim: { roleId: number } = await api.post('/roles', { name: `0 ${uniq('e2e-SOC38')}`, menuKeys: [] });
    const adminGrant: { documentTypePermissionId: number } = await api.post(
      '/referentials/document-type-permissions',
      { documentTypeId: type.documentTypeId, permissionLevelId: 2, roleId: victim.roleId },
    );
    try {
      const grant = await client.raw.post('/referentials/document-type-permissions', {
        documentTypeId: type.documentTypeId,
        permissionLevelId: 4,
        roleId: agent.roleId,
      });
      expect(grant.status()).toBe(403);
      expect((await client.raw.get('/referentials/document-type-permissions')).status()).toBe(403);
      const revoke = await client.raw.del(`/referentials/document-type-permissions/${adminGrant.documentTypePermissionId}`);
      expect(revoke.status()).toBe(403);
      const rows: { documentTypeId: number; documentTypePermissionId: number }[] = await api.get(
        '/referentials/document-type-permissions',
      );
      expect(rows.filter((r) => r.documentTypeId === type.documentTypeId).map((r) => r.documentTypePermissionId)).toEqual([
        adminGrant.documentTypePermissionId,
      ]);
    } finally {
      await api.raw.del(`/referentials/document-type-permissions/${adminGrant.documentTypePermissionId}`);
      await api.raw.del(`/referentials/document-types/${type.documentTypeId}`);
      await api.raw.del(`/roles/${victim.roleId}`);
    }
  });

  test('SOC-39 session absente ou invalide : 401 sur les routes protégées', async ({ request }) => {
    const tokens: [string, string | null][] = [
      ['sans en-tête', null],
      ['jeton quelconque', 'abc'],
      ['signature fausse (charge admin)', forgedAdminToken()],
      ['alg none (charge admin)', unsignedAdminToken()],
    ];
    for (const path of ['/auth/me', '/users', '/roles', '/referentials/document-types']) {
      for (const [label, token] of tokens) {
        const res = await callWithToken(request, 'GET', path, token);
        expect.soft(res.status(), `${path} — ${label}`).toBe(401);
      }
    }
    // Écriture aussi : un jeton forgé ne crée pas de compte.
    const res = await callWithToken(request, 'POST', '/users', forgedAdminToken(), {
      username: 'forge',
      firstName: 'F',
      lastName: 'F',
      email: 'f@exemple.test',
      password: TEST_PASSWORD,
    });
    expect(res.status()).toBe(401);
    // La connexion reste publique : mauvais identifiants = 401, pas 403.
    expect((await rawLogin(request, 'inconnu-e2e', 'faux-mot-de-passe')).status()).toBe(401);
  });

  test('SOC-39 jeton invalide dans le navigateur : retour à l’écran de connexion', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => window.localStorage.setItem('token', 'jeton-invalide'));
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/login$/);
  });
});
