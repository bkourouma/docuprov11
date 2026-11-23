// Docu-Flow E2E : création d'utilisateurs de test aux menus choisis.
//
// Docu-Flow agit au nom d'un `user_group_id` (lien utilisateur-profil) : un compte SANS profil a un
// `userGroupId` nul et l'API workflow le refuse (403). On crée donc, pour chaque utilisateur :
//   1. un rôle portant exactement les menus voulus (POST /roles, menu administrateur « Rôles ») ;
//   2. un profil dédié (POST /users/groups/all) ;
//   3. le compte, rattaché au profil par défaut et au rôle (POST /users) ;
//   4. le changement de mot de passe imposé à la création (POST /auth/change-password, avec le jeton du
//      nouvel utilisateur), pour que la connexion par l'écran n'affiche pas l'écran de changement forcé.
// Le `userGroupId` est relu par GET /auth/me.
//
// Le client `api` est celui de l'administrateur (fixture `api`). Les appels non authentifiés passent par un
// contexte de requête Playwright dédié, sur l'URL de l'API de la pile E2E.

import { request } from '@playwright/test';
import type { ApiLike } from './wf-api';

export interface WfTestUser {
  username: string;
  password: string;
  userId: number;
  userGroupId: number;
  roleId: number;
  groupId: number;
  fullName: string;
}

/**
 * URL de base de l'API (préfixe `/api` compris). Le lot 0 peut l'exposer autrement : en cas d'écart, le
 * README de `apps/e2e` fait foi et cette fonction s'aligne en phase B.
 */
export function e2eApiBaseUrl(): string {
  if (process.env.E2E_API_URL) return process.env.E2E_API_URL.replace(/\/$/, '');
  const port = process.env.E2E_API_PORT ?? '6140';
  return `http://127.0.0.1:${port}/api`;
}

/** Mot de passe de test (jamais un vrai secret) : >= 6 caractères (MIN_PASSWORD_LENGTH). */
const TEST_PASSWORD = 'E2e-Workflow-1';

/**
 * Crée un utilisateur de test portant exactement `menus` (clés du catalogue, ex. `WF_MENUS.launch`).
 * `prefix` doit venir de `uniq()` pour isoler les tests.
 */
export async function createWfUser(
  api: ApiLike,
  opts: { prefix: string; menus: string[]; firstName?: string; lastName?: string },
): Promise<WfTestUser> {
  const safe = opts.prefix.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 60);
  const role = await api.post<{ roleId: number }>('/roles', {
    name: `Rôle ${safe}`,
    description: 'Rôle créé par les tests E2E Docu-Flow',
    menuKeys: opts.menus,
  });
  const group = await api.post<{ groupId: number }>('/users/groups/all', { name: `Profil ${safe}` });
  const firstName = opts.firstName ?? 'Test';
  const lastName = opts.lastName ?? safe;
  const initialPassword = `${TEST_PASSWORD}-init`;
  const created = await api.post<{ userId: number; username: string }>('/users', {
    username: safe,
    firstName,
    lastName,
    email: `${safe}@e2e.test`,
    password: initialPassword,
    groupId: group.groupId,
    roleId: role.roleId,
  });

  const ctx = await request.newContext({ baseURL: `${e2eApiBaseUrl()}/` });
  try {
    const login = await ctx.post('auth/login', { data: { username: safe, password: initialPassword } });
    if (!login.ok()) throw new Error(`connexion de ${safe} impossible : HTTP ${login.status()}`);
    const { accessToken } = (await login.json()) as { accessToken: string };
    const headers = { Authorization: `Bearer ${accessToken}` };
    const change = await ctx.post('auth/change-password', {
      headers,
      data: { currentPassword: initialPassword, newPassword: TEST_PASSWORD },
    });
    if (!change.ok()) throw new Error(`changement de mot de passe de ${safe} impossible : HTTP ${change.status()}`);
    const me = await ctx.get('auth/me', { headers });
    if (!me.ok()) throw new Error(`GET /auth/me pour ${safe} : HTTP ${me.status()}`);
    const meBody = (await me.json()) as { userGroupId: number | null };
    if (!meBody.userGroupId) throw new Error(`${safe} n'a pas de userGroupId`);
    return {
      username: safe,
      password: TEST_PASSWORD,
      userId: created.userId,
      userGroupId: meBody.userGroupId,
      roleId: role.roleId,
      groupId: group.groupId,
      fullName: `${firstName} ${lastName}`,
    };
  } finally {
    await ctx.dispose();
  }
}

/** `userGroupId` de l'administrateur (fixture `api`), pour l'assigner ou le comparer. */
export async function adminUserGroupId(api: ApiLike): Promise<number> {
  const me = await api.get<{ userGroupId: number | null }>('/auth/me');
  if (!me.userGroupId) throw new Error("l'administrateur n'a pas de userGroupId");
  return me.userGroupId;
}
