/**
 * Aides GED : création d'utilisateurs restreints pour les tests de permissions.
 *
 * Écrites contre le contrat des fixtures (`apps/e2e/fixtures`, lot 0) : `api` est un client REST
 * administrateur (chemins relatifs à `/api`), `apiAs(username, password)` un client pour un autre
 * utilisateur, `uniq(prefix)` un identifiant unique par test.
 *
 * Un compte créé par `POST /users` porte `mustChangePwd: true` : l'API ne bloque rien, mais l'écran
 * web redirige vers le changement de mot de passe. On le lève donc par `POST /auth/change-password`
 * au nom de l'utilisateur, pour que `loginAs(page, …)` arrive directement sur l'application.
 */

import type { ApiClient } from '../../../fixtures';

/** Client REST des fixtures (`apps/e2e/support/api-client.ts`), `raw` et `upload` compris. */
export type GedApi = ApiClient;

/** Fixture `apiAs` : client REST complet d'un autre utilisateur. */
export type ApiAs = (username: string, password: string) => Promise<ApiClient>;

export interface GedUser {
  userId: number;
  username: string;
  password: string;
  roleId: number | null;
}

/** Mot de passe initial (remplacé aussitôt) et final des comptes de test, >= 6 caractères. */
const INITIAL_PASSWORD = 'E2e-initial-1';
export const GED_TEST_PASSWORD = 'E2e-ged-pass-1';

/**
 * Crée un rôle portant exactement `menuKeys` (clés de menu RBAC, ex. `/espaces`, `/gouvernance`,
 * `/recherche-ia`). Les clés non assignables (ex. `/connecteurs`, réservée à l'administrateur) sont
 * silencieusement écartées par l'API.
 */
export async function createRole(api: GedApi, name: string, menuKeys: string[]): Promise<number> {
  const role = await api.post<{ roleId: number }>('/roles', { name, menuKeys });
  return role.roleId;
}

/**
 * Crée un utilisateur NON administrateur, avec un rôle portant `menuKeys` (aucun rôle si la liste
 * est vide), et lève l'obligation de changer de mot de passe. Renvoie ses identifiants.
 */
export async function createRestrictedUser(
  api: GedApi,
  apiAs: ApiAs,
  prefix: string,
  menuKeys: string[] = [],
  extra: { confidentialiteId?: number | null } = {},
): Promise<GedUser> {
  const username = prefix.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 60);
  const roleId = menuKeys.length ? await createRole(api, `Rôle ${username}`, menuKeys) : null;
  const created = await api.post<{ userId: number; username: string }>('/users', {
    username,
    firstName: 'E2E',
    lastName: username,
    email: `${username}@e2e.invalid`,
    password: INITIAL_PASSWORD,
    isAdmin: false,
    roleId,
    ...(extra.confidentialiteId !== undefined ? { confidentialiteId: extra.confidentialiteId } : {}),
  });
  const self = await apiAs(username, INITIAL_PASSWORD);
  await self.post('/auth/change-password', {
    currentPassword: INITIAL_PASSWORD,
    newPassword: GED_TEST_PASSWORD,
  });
  return { userId: created.userId, username, password: GED_TEST_PASSWORD, roleId };
}
