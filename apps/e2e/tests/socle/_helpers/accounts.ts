/**
 * Aide partagée du lot 5 (socle et administration) : comptes, rôles et menus de test.
 *
 * ## Branchement
 *
 * - Le client `api` (fixture) et le type `ApiClient` sont ceux de `apps/e2e/support` (lot 0),
 *   importés via `./admin` (point d'import unique).
 * - Lever `mustChangePwd` d'un compte créé exige d'agir EN TANT QUE ce compte : l'administrateur
 *   ne peut pas effacer l'indicateur (`PATCH /users/:id` ne l'accepte pas). `createUser` utilise
 *   pour cela `apiAs` de `support` (hors fixture, libéré aussitôt) ; qui préfère le fixture
 *   `apiAs` le passe en dernier argument (`deps`), il est alors utilisé et libéré par le fixture.
 * - Les appels « bruts » sans jeton ou avec un jeton arbitraire passent par
 *   `createApiClient({ token })` de `support` (directement sur l'API, pas par le proxy Next).
 * - Aucune suppression des données créées : chaque test crée les siennes, identifiants uniques.
 */
import { apiAs as supportApiAs, createApiClient, type ApiClient } from './admin';

export type { ApiClient };

/**
 * Sous-ensemble du client REST dont ces aides ont besoin. Structurel : le client `api` du fixture
 * (`ApiClient` de `support`) comme les types locaux des autres tâches lui sont assignables.
 */
export interface ApiLike {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
}

/** Forme du fixture `apiAs`. */
export type ApiAs = (username: string, password: string) => Promise<ApiLike>;

/** Forme du fixture `uniq` (préfixe toujours fourni ici). */
export type Uniq = (prefix: string) => string;

/** Dépendances optionnelles : `{ apiAs }` du fixture. */
export interface AccountDeps {
  apiAs?: ApiAs;
}

// ---------------------------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------------------------

/** Mot de passe initial (provisoire) des comptes créés par les tests. */
export const TEST_PASSWORD = 'Init-1234!';

/**
 * Mot de passe personnel choisi quand l'aide lève l'obligation de changement : distinct du
 * provisoire (l'étape de première connexion refuse de le reconduire), sans espace de bord.
 */
export function personalPasswordFor(provisional: string): string {
  return `${provisional}-perso`;
}

/**
 * Clés de menu usuelles = routes de la barre latérale = permissions du catalogue des rôles
 * (`apps/api/src/modules/roles/menu-catalog.ts`, `apps/web/app/components/nav.ts`).
 */
export const MENU = {
  home: '/',
  dashboards: '/dashboards',
  acquisition: '/acquisition',
  search: '/search',
  documentTypes: '/admin/document-types',
  classificationPlans: '/admin/classification-plans',
  dossiers: '/admin/dossiers',
  intercalaires: '/intercalaires',
  users: '/admin/users',
  roles: '/admin/roles',
  emailSettings: '/admin/parametres/email',
  typeSecurityByUser: '/admin/securite/type-par-utilisateur',
  typeSecurityByRole: '/admin/securite/type-par-profil',
  userConfidentiality: '/admin/securite/confidentialite-utilisateurs',
  confidentialites: '/admin/securite/confidentialites',
} as const;

/** Libellés de la barre latérale (nav.ts) pour les principales clés de `MENU`. */
export const NAV_LABEL: Record<string, string> = {
  [MENU.dashboards]: 'Tableaux de bord',
  [MENU.acquisition]: 'Acquisition par lot',
  [MENU.search]: 'Recherche',
  [MENU.documentTypes]: 'Types de document',
  [MENU.classificationPlans]: 'Plan de classement',
  [MENU.dossiers]: 'Dossiers',
  [MENU.intercalaires]: 'Intercalaires',
  [MENU.users]: 'Utilisateurs',
  [MENU.roles]: 'Rôles',
  [MENU.emailSettings]: 'Paramétrage e-mail',
};

// ---------------------------------------------------------------------------------------------
// Appels bruts (sans le client administrateur)
// ---------------------------------------------------------------------------------------------

/** Réponse lue avant la libération du client. */
export interface RawResult<T = unknown> {
  status: number;
  body: T;
}

async function rawCall<T>(
  token: string | null,
  run: (client: ApiClient) => Promise<{ status(): number; text(): Promise<string> }>,
): Promise<RawResult<T>> {
  const client = await createApiClient({ token });
  try {
    const res = await run(client);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // corps non JSON : laissé brut
    }
    return { status: res.status(), body: body as T };
  } finally {
    await client.dispose();
  }
}

/** Réponse de `POST /auth/login`. */
export interface LoginBody {
  accessToken: string;
  mustChangePwd: boolean;
  isAdmin: boolean;
}

/** `POST /auth/login` sans jeton, sans lever (le serveur répond 201 en cas de succès). */
export function rawLogin(username: string, password: string): Promise<RawResult<LoginBody>> {
  return rawCall<LoginBody>(null, (c) => c.raw.post('auth/login', { username, password }));
}

/** `GET` brut avec un jeton arbitraire (ou aucun) : tests de jeton absent, forgé, expiré. */
export function rawGet(path: string, token?: string | null): Promise<RawResult> {
  return rawCall(token ?? null, (c) => c.raw.get(path));
}

/** Connexion par l'API ; lève si refusée. Renvoie aussi `mustChangePwd`. */
export async function loginToken(username: string, password: string): Promise<LoginBody> {
  const res = await rawLogin(username, password);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Connexion refusée pour ${username} (HTTP ${res.status})`);
  }
  return res.body;
}

/** Change le mot de passe d'un compte EN TANT QUE ce compte (efface `mustChangePwd`). */
export async function changeOwnPassword(
  username: string,
  currentPassword: string,
  newPassword: string,
  deps: AccountDeps = {},
): Promise<void> {
  const body = { currentPassword, newPassword };
  if (deps.apiAs) {
    // Client du fixture : libéré par le fixture en fin de test.
    await (await deps.apiAs(username, currentPassword)).post('auth/change-password', body);
    return;
  }
  const client = await supportApiAs(username, currentPassword);
  try {
    await client.post('auth/change-password', body);
  } finally {
    await client.dispose();
  }
}

/** `GET /auth/me` pour un jeton donné. */
export interface MeBody {
  username: string;
  isAdmin: boolean;
  mustChangePwd: boolean;
  menuKeys: string[];
  role: { roleId: number; name: string } | null;
}

export async function meOf(token: string): Promise<MeBody> {
  const res = await rawGet('auth/me', token);
  if (res.status !== 200) throw new Error(`/auth/me : HTTP ${res.status}`);
  return res.body as MeBody;
}

// ---------------------------------------------------------------------------------------------
// Rôles et utilisateurs (via le client administrateur `api`)
// ---------------------------------------------------------------------------------------------

function randomSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Adresse e-mail valide pour `z.string().email()`, dérivée d'un identifiant quelconque. */
function emailFor(username: string): string {
  const local = username
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${local || 'e2e'}@e2e.test`;
}

export async function createRole(
  api: ApiLike,
  opts: { name?: string; menuKeys: string[]; description?: string },
): Promise<{ roleId: number; name: string; menuKeys: string[] }> {
  const role = (await api.post('roles', {
    name: opts.name ?? `e2e-role-${randomSuffix()}`,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    menuKeys: opts.menuKeys,
  })) as { roleId: number; name: string; menuKeys: string[] };
  return { roleId: role.roleId, name: role.name, menuKeys: role.menuKeys };
}

export interface CreateUserOptions {
  roleId?: number | null;
  isAdmin?: boolean;
  confidentialiteId?: number | null;
  username?: string;
  /** Mot de passe initial (provisoire). Défaut : `TEST_PASSWORD`. */
  password?: string;
  /** `'clear'` (défaut) : obligation levée, le mot de passe renvoyé est le NOUVEAU. */
  mustChangePwd?: 'keep' | 'clear';
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface CreatedUser {
  userId: number;
  username: string;
  /** Mot de passe UTILISABLE : provisoire si `keep`, personnel si `clear`. */
  password: string;
  /** Mot de passe donné à la création. */
  initialPassword: string;
  firstName: string;
  lastName: string;
  /** Recomposé ainsi par `UsersService.createUser`. */
  fullName: string;
  email: string;
}

export async function createUser(
  api: ApiLike,
  opts: CreateUserOptions = {},
  deps: AccountDeps = {},
): Promise<CreatedUser> {
  const username = opts.username ?? `e2e-user-${randomSuffix()}`;
  const initialPassword = opts.password ?? TEST_PASSWORD;
  const firstName = opts.firstName ?? 'Test';
  const lastName = opts.lastName ?? 'E2E';
  const email = opts.email ?? emailFor(username);
  const created = (await api.post('users', {
    username,
    firstName,
    lastName,
    email,
    password: initialPassword,
    ...(opts.isAdmin !== undefined ? { isAdmin: opts.isAdmin } : {}),
    ...(opts.roleId !== undefined ? { roleId: opts.roleId } : {}),
    ...(opts.confidentialiteId !== undefined ? { confidentialiteId: opts.confidentialiteId } : {}),
  })) as { userId: number; username: string };

  let password = initialPassword;
  if ((opts.mustChangePwd ?? 'clear') === 'clear') {
    password = personalPasswordFor(initialPassword);
    await changeOwnPassword(username, initialPassword, password, deps);
  }
  return {
    userId: created.userId,
    username,
    password,
    initialPassword,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    email,
  };
}

export async function createRestrictedUser(
  api: ApiLike,
  uniq: Uniq,
  menuKeys: string[],
  deps: AccountDeps = {},
): Promise<{
  roleId: number;
  roleName: string;
  userId: number;
  username: string;
  password: string;
}> {
  const role = await createRole(api, { name: uniq('role-restreint'), menuKeys });
  const user = await createUser(api, { roleId: role.roleId, username: uniq('restreint') }, deps);
  return {
    roleId: role.roleId,
    roleName: role.name,
    userId: user.userId,
    username: user.username,
    password: user.password,
  };
}

/** Remplace l'intégralité des menus du rôle (`PATCH /roles/:id`). */
export async function setRoleMenus(
  api: ApiLike,
  roleId: number,
  menuKeys: string[],
): Promise<void> {
  await api.patch(`roles/${roleId}`, { menuKeys });
}

export async function disableUser(api: ApiLike, userId: number): Promise<void> {
  await api.patch(`users/${userId}`, { isDisabled: true });
}

export async function enableUser(api: ApiLike, userId: number): Promise<void> {
  await api.patch(`users/${userId}`, { isDisabled: false });
}

/** Réinitialisation par l'administrateur (`POST /users/:id/reset-password`) : rétablit `mustChangePwd`. */
export async function resetPassword(
  api: ApiLike,
  userId: number,
  newPassword: string,
): Promise<void> {
  await api.post(`users/${userId}/reset-password`, { newPassword });
}

/**
 * Un niveau de confidentialité existant (le premier par rang), sinon un niveau créé. Les niveaux
 * sont un référentiel partagé : on n'en crée un que s'il n'en existe aucun.
 */
export async function anyConfidentialite(
  api: ApiLike,
  uniq: Uniq,
): Promise<{ confidentialiteId: number; label: string }> {
  type Level = { confidentialiteId: number; label: string };
  const list = (await api.get('referentials/confidentialites')) as Level[];
  const first = list[0];
  if (first) return first;
  return (await api.post('referentials/confidentialites', { label: uniq('Niveau e2e') })) as Level;
}
