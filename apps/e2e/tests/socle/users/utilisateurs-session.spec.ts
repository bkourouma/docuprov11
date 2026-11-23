/**
 * Cycle de vie d'un compte côté API : jeton déjà émis après désactivation, suppression ou
 * rétrogradation (correctif F1 : `JwtStrategy.validate` relit le compte à chaque requête),
 * réinitialisation du mot de passe, protection du compte `admin`.
 * Scénarios SOC-26, SOC-27 (réinitialisation par l'API), SOC-28 (jeton d'un compte supprimé), SOC-29.
 */
import { test, expect } from '../../../fixtures';
import { createUser, disableUser } from '../_helpers/accounts';
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  login,
  protectedAdminId,
  rawLogin,
  type ApiLike,
  type Me,
} from '../_helpers/tache-a';

test.describe('Comptes — sessions et mots de passe', () => {
  test('SOC-26 FAILLE F1 compte désactivé : le jeton déjà émis est refusé (401)', async ({ api, apiAs }) => {
    const user = await createUser(api, {});
    const client = (await apiAs(user.username, user.password)) as ApiLike;
    // Session ouverte et fonctionnelle avant la désactivation.
    const me: Me = await client.get('/auth/me');
    expect(me.userId).toBe(user.userId);

    await disableUser(api, user.userId);

    expect((await client.raw.get('/auth/me')).status()).toBe(401);
    expect((await client.raw.get('/auth/profile')).status()).toBe(401);
    expect((await client.raw.post('/auth/change-password', { currentPassword: user.password, newPassword: 'Autre-1234!' })).status()).toBe(401);
  });

  test('SOC-26 FAILLE F1 administrateur rétrogradé : perd aussitôt le contournement admin', async ({ api, apiAs }) => {
    const chef = await createUser(api, { isAdmin: true });
    const client = (await apiAs(chef.username, chef.password)) as ApiLike;
    expect((await client.raw.get('/users')).status()).toBe(200);
    expect((await client.raw.get('/roles/menus')).status()).toBe(200);

    await api.patch(`/users/${chef.userId}`, { isAdmin: false });

    // Aucun rôle : seuls l'accueil et les lectures partagées restent, avec le MÊME jeton.
    expect((await client.raw.get('/users')).status()).toBe(403);
    expect((await client.raw.get('/roles/menus')).status()).toBe(403);
    const me: Me = await client.get('/auth/me');
    expect(me.isAdmin).toBe(false);
    expect(me.menuKeys).toEqual(['/']);
  });

  test('SOC-28 FAILLE F1 compte supprimé : le jeton déjà émis est refusé (401)', async ({ api, apiAs }) => {
    const user = await createUser(api, {});
    const client = (await apiAs(user.username, user.password)) as ApiLike;
    expect((await client.raw.get('/auth/me')).status()).toBe(200);

    await api.del(`/users/${user.userId}`);

    // Avant F1 : `/auth/me` répondait 200 avec un corps vide.
    expect((await client.raw.get('/auth/me')).status()).toBe(401);
    expect((await client.raw.get('/auth/profile')).status()).toBe(401);
  });

  test('SOC-27 réinitialisation du mot de passe par l’API : ancien refusé, nouveau provisoire', async ({
    api,
    request,
  }) => {
    const user = await createUser(api, {});
    const next = 'Reset-5678!';

    expect(await api.post(`/users/${user.userId}/reset-password`, { newPassword: next })).toEqual({ reset: true });

    expect((await rawLogin(request, user.username, user.password)).status()).toBe(401);
    const session = await login(request, user.username, next);
    expect(session.mustChangePwd).toBe(true);

    const raw = (api as ApiLike).raw;
    // Mot de passe trop court : 400.
    expect((await raw.post(`/users/${user.userId}/reset-password`, { newPassword: '12345' })).status()).toBe(400);
    // Compte inexistant : 404 (et non 500 P2025 — corrigé).
    expect((await raw.post('/users/2147483000/reset-password', { newPassword: next })).status()).toBe(404);
  });

  test('SOC-29 compte admin protégé : ni modifiable, ni désactivable, ni supprimable', async ({ api, request }) => {
    const adminId = await protectedAdminId(api);
    const raw = (api as ApiLike).raw;

    for (const body of [{ email: 'autre@exemple.test' }, { isDisabled: true }, { isAdmin: false }, { roleId: null }]) {
      const res = await raw.patch(`/users/${adminId}`, body);
      expect(res.status(), JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe(
        'Le compte administrateur par défaut ne peut pas être modifié.',
      );
    }
    const del = await raw.del(`/users/${adminId}`);
    expect(del.status()).toBe(400);
    expect(((await del.json()) as { message: string }).message).toBe(
      'Le compte administrateur par défaut ne peut pas être supprimé.',
    );

    // L'affectation en masse de confidentialité l'ignore (0 ligne modifiée).
    expect(await api.patch('/users/confidentialite', { userIds: [adminId], confidentialiteId: null })).toEqual({
      updated: 0,
    });

    // Toujours administrateur, toujours actif.
    const session = await login(request, ADMIN_USER, ADMIN_PASSWORD);
    expect(session.isAdmin).toBe(true);
  });
});
