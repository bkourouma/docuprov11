/**
 * Aides de la tâche A du lot 5 (écrans Utilisateurs et Rôles, permissions API du socle).
 *
 * Complète `accounts.ts` (tâche B) sans le modifier. Seul fichier de la tâche à importer
 * `support/` : en phase B, si le chemin de `ADMIN_USER` / `ADMIN_PASSWORD` change, c'est ici.
 *
 * Les appels « bruts » passent par le `request` de Playwright, dont la `baseURL` est supposée être
 * l'origine du web (Next réécrit `/api/*` vers l'API, voir `apps/web/next.config.mjs`).
 */
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';

export { ADMIN_USER, ADMIN_PASSWORD } from '../../../support';

/**
 * Forme minimale du client `api` / `apiAs` du contrat de fixtures. Non générique et en `any` pour
 * rester compatible avec le type réel du client quel qu'il soit (phase B : remplacer par
 * l'import du type exporté par `fixtures`).
 */
export interface ApiLike {
  get(path: string): Promise<any>;
  post(path: string, body?: unknown): Promise<any>;
  patch(path: string, body?: unknown): Promise<any>;
  del(path: string): Promise<any>;
  raw: {
    get(path: string): Promise<APIResponse>;
    post(path: string, body?: unknown): Promise<APIResponse>;
    patch(path: string, body?: unknown): Promise<APIResponse>;
    put(path: string, body?: unknown): Promise<APIResponse>;
    del(path: string): Promise<APIResponse>;
  };
}

export interface UserRow {
  userId: number;
  username: string;
  isAdmin: boolean;
  isDisabled: boolean;
  mustChangePwd: boolean;
  roleId: number | null;
  role: { roleId: number; name: string } | null;
  confidentialiteId: number | null;
}

export interface RoleRow {
  roleId: number;
  name: string;
  isActive: boolean;
  isSystem: boolean;
  menuKeys: string[];
  userCount: number;
}

export interface Me {
  userId: number;
  username: string;
  isAdmin: boolean;
  mustChangePwd: boolean;
  role: { roleId: number; name: string } | null;
  menuKeys: string[];
}

/** `POST /auth/login` sans lever : pour vérifier un refus (401). */
export function rawLogin(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<APIResponse> {
  return request.post('/api/auth/login', { data: { username, password } });
}

/** Connexion réussie obligatoire ; renvoie le corps `{ accessToken, mustChangePwd, isAdmin }`. */
export async function login(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<{ accessToken: string; mustChangePwd: boolean; isAdmin: boolean }> {
  const res = await rawLogin(request, username, password);
  expect(res.status(), `connexion de ${username}`).toBe(201);
  return res.json();
}

/** Appel brut avec un en-tête `Authorization` choisi (jeton absent, faux, ancien…). */
export function callWithToken(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  token: string | null,
  body?: unknown,
): Promise<APIResponse> {
  return request.fetch(`/api${path}`, {
    method,
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { data: body }),
  });
}

/** JWT bien formé mais signé avec une autre clé (et charge utile d'administrateur). */
export function forgedAdminToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 1,
    username: 'admin',
    isAdmin: true,
    userGroupId: 1,
    iat: now,
    exp: now + 3600,
  };
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.${Buffer.from('signature-fausse').toString('base64url')}`;
}

/** JWT sans signature (`alg: none`) : doit être refusé. */
export function unsignedAdminToken(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 1, username: 'admin', isAdmin: true, userGroupId: 1, exp: now + 3600 })}.`;
}

export async function findUser(api: ApiLike, username: string): Promise<UserRow | undefined> {
  const users: UserRow[] = await api.get('/users');
  return users.find((u) => u.username === username);
}

export async function getUser(api: ApiLike, userId: number): Promise<UserRow> {
  const users: UserRow[] = await api.get('/users');
  const u = users.find((x) => x.userId === userId);
  expect(u, `utilisateur ${userId} présent dans GET /users`).toBeDefined();
  return u as UserRow;
}

export async function getRole(api: ApiLike, roleId: number): Promise<RoleRow | undefined> {
  const roles: RoleRow[] = await api.get('/roles');
  return roles.find((r) => r.roleId === roleId);
}

export async function systemRole(api: ApiLike): Promise<RoleRow> {
  const roles: RoleRow[] = await api.get('/roles');
  const sys = roles.find((r) => r.isSystem);
  expect(sys, 'rôle système créé par le seed').toBeDefined();
  return sys as RoleRow;
}

/** Identifiant du compte `admin` protégé (absent de l'écran, présent dans l'API). */
export async function protectedAdminId(api: ApiLike): Promise<number> {
  const u = await findUser(api, 'admin');
  expect(u, 'compte admin du seed').toBeDefined();
  return (u as UserRow).userId;
}

/** Niveau de confidentialité actif (le premier, rang le plus bas), créé s'il n'en existe aucun. */
export async function anyConfidentialite(
  api: ApiLike,
  uniq: (p: string) => string,
): Promise<{ confidentialiteId: number; label: string }> {
  const list: { confidentialiteId: number; label: string; rank: number }[] = await api.get(
    '/referentials/confidentialites',
  );
  const first = list[0];
  if (first) return first;
  return api.post('/referentials/confidentialites', { label: uniq('Conf') });
}

/**
 * Nom de rôle trié en tête de la table « Rôles » (tri alphabétique, 10 par page, sans recherche) :
 * le préfixe « 0 » passe avant les rôles créés par les autres tests.
 */
export function roleName(uniq: (p: string) => string, scenario: string): string {
  return `0 ${uniq(`e2e-${scenario}`)}`;
}

/** Corps valide de `POST /users` (compte ordinaire), à compléter au besoin. */
export function newUserBody(
  uniq: (p: string) => string,
  over: Record<string, unknown> = {},
): {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
} & Record<string, unknown> {
  const username = uniq('e2e-user');
  return {
    username,
    firstName: 'Awa',
    lastName: 'Koné',
    email: `${username}@exemple.test`,
    password: 'Init-1234!',
    ...over,
  };
}

/** Échappe une chaîne pour l'insérer dans une RegExp (noms de lignes de table). */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Choisit une option d'un Select Ant Design (liste déroulante rendue hors du formulaire). */
export async function pickOption(
  page: Page,
  combobox: Locator,
  label: string,
  { search = true }: { search?: boolean } = {},
): Promise<void> {
  // L'input de recherche d'un Select AntD est recouvert par la valeur affichée (qui intercepte le
  // clic) : on ouvre la liste par son cadre `.ant-select-selector`.
  await combobox.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " ant-select-selector ")][1]').click();
  // Liste virtualisée : une option hors fenêtre n'est pas rendue. Les Select de la fiche utilisateur
  // « Rôle » a la recherche (`showSearch`) : la saisie filtre la liste jusqu'à l'option voulue.
  // « Habilitation » ne l'a pas (input en lecture seule) : `search: false`.
  if (search) await combobox.fill(label);
  // `title` est porté par l'option elle-même : `.and()`, pas un `getByTitle` chaîné (descendants).
  await page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .and(page.getByTitle(label, { exact: true }))
    .click();
}

/** Attend le rechargement de `GET /api/<chemin>` déclenché par l'action donnée. */
export async function afterReload(page: Page, path: string, action: () => Promise<unknown>) {
  const reloaded = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api${path}`,
  );
  await action();
  return reloaded;
}
