/**
 * Aides de la tâche C (lot 5) — Sécurité Documentaire.
 *
 * Écrites contre le contrat de fixtures du lot (phase A). `Api` = le client `ApiClient` de
 * `apps/e2e/support` (lot 0), atteint par le point d'import unique `./admin` via `./accounts`.
 * Chemins relatifs à `/api`, avec ou sans « / » initial (normalisés par le client).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { createUser, type ApiClient } from './accounts';

export type Api = ApiClient;
export type ApiAs = (username: string, password: string) => Promise<Api>;
export type Uniq = (prefix: string) => string;

/** Clés de menu « Sécurité Documentaire » (miroir de `access-inquiries/security.menus.ts`). */
export const SECURITY_MENU = {
  typeByUser: '/admin/securite/type-par-utilisateur',
  typeByRole: '/admin/securite/type-par-profil',
  userConfidentiality: '/admin/securite/confidentialite-utilisateurs',
  confidentialites: '/admin/securite/confidentialites',
} as const;

/** Message du `MenuPermissionGuard` (403), affiché tel quel par les écrans via `message.error`. */
export const FORBIDDEN_MESSAGE = "Vous n'avez pas accès à cette section.";

/**
 * Écran cible d'une page ouverte par son adresse SANS le menu correspondant (décision utilisateur,
 * phase B) : la coquille commune (`AuthShell`) doit l'afficher dès l'ouverture. Le correctif
 * appartient au lot transverse ; les tests qui le vérifient restent en `test.fixme` d'ici là.
 */
export const ACCESS_DENIED_TEXT = 'Accès refusé';
export const ACCESS_DENIED_FIXME = 'en attente du lot transverse : écran Accès refusé';

/** Niveaux de permission figés (seed `permission_level`). */
export const LEVEL = {
  DENIED: 1,
  CONSULTATION: 2,
  MODIFICATION: 3,
  ADMINISTRATION: 4,
  ARCHIVISTIQUE: 5,
} as const;

/** Identifiant certainement absent (entier positif valide pour Zod, hors de toute séquence réaliste). */
export const UNKNOWN_ID = 2_000_000_000;

export function rx(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// ---------------------------------------------------------------------------------------------
// UI : attentes réseau, Popconfirm, Select AntD, lignes paginées
// ---------------------------------------------------------------------------------------------

/** Attend la réponse d'un appel `/api<path>` (chemin exact, sans query) pour un verbe donné. */
export function waitApi(page: Page, method: string, path: string | RegExp) {
  return page.waitForResponse((r) => {
    if (r.request().method() !== method) return false;
    const pathname = new URL(r.url()).pathname;
    return typeof path === 'string' ? pathname === `/api${path}` : path.test(pathname);
  });
}

/**
 * Valide la Popconfirm ouverte. Ciblée par sa classe AntD v5 (`.ant-popconfirm`) : son bouton OK
 * porte souvent le même libellé que le déclencheur (« Tout retirer »), un `getByRole` global serait
 * ambigu.
 */
export async function confirmPopover(page: Page, okText: string): Promise<void> {
  const pop = page.locator('.ant-popconfirm:visible');
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: okText, exact: true }).click();
}

/** Options rendues (cliquables) de la liste déroulante AntD ouverte. */
export function dropdownOptions(page: Page): Locator {
  return page.locator('.ant-select-dropdown:visible .ant-select-item-option');
}

/**
 * Option rendue de la liste ouverte, par son libellé. AntD pose `title` sur l'élément
 * `.ant-select-item-option` LUI-MÊME : `options.getByTitle()` ne chercherait que dans ses
 * descendants (aucun ne porte de titre) et ne trouverait jamais rien. D'où l'intersection `and()`.
 * (La liste `role="option"` d'AntD est un doublon d'accessibilité, sans libellé ni clic.)
 */
export function dropdownOption(page: Page, optionLabel: string): Locator {
  return dropdownOptions(page).and(page.getByTitle(optionLabel, { exact: true }));
}

/**
 * Choisit une option d'un Select AntD (`field` = l'input porteur de l'id, atteint par `getByLabel`).
 * Pour un Select `showSearch`, la saisie filtre d'abord la liste : elle est virtualisée, une option
 * hors fenêtre n'est pas rendue. Un Select sans recherche a un input en lecture seule (`search: false`).
 */
export async function pickOption(
  page: Page,
  field: Locator,
  optionLabel: string,
  { search = true }: { search?: boolean } = {},
): Promise<void> {
  await field.click();
  if (search) await field.fill(optionLabel);
  await dropdownOption(page, optionLabel).click();
}

/** Ferme un Select multiple resté ouvert après sélection. */
export async function closeDropdown(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
}

/**
 * Rend visible la ligne de table qui contient `text`, en parcourant la pagination AntD si besoin
 * (pages de 10 triées côté serveur : une ligne neuve peut tomber sur une page suivante).
 * Le bouton « suivant » de la locale fr_FR porte le titre « Page suivante ».
 */
export async function revealRow(page: Page, text: string): Promise<Locator> {
  const row = page.getByRole('row', { name: rx(text) }).first();
  for (let i = 0; i < 100; i++) {
    try {
      // Attente d'ÉTAT bornée : la page courante a fini de se rendre, la ligne y est ou non.
      await expect(row).toBeVisible({ timeout: 1_500 });
      return row;
    } catch {
      const next = page.getByTitle('Page suivante').first();
      if ((await next.count()) === 0 || (await next.getAttribute('aria-disabled')) === 'true')
        break;
      await next.click();
    }
  }
  throw new Error(`Ligne introuvable dans la table : ${text}`);
}

export const TYPE_ROLE_PAGE = '/admin/securite/type-par-profil';
export const TYPE_USER_PAGE = '/admin/securite/type-par-utilisateur';

/** Ouvre un écran « Sécurité type document par… » et attend ses quatre chargements. */
export async function openTypePage(page: Page, scope: 'role' | 'user'): Promise<void> {
  const loads = [
    waitApi(page, 'GET', '/referentials/document-type-permissions'),
    waitApi(page, 'GET', '/referentials/document-types'),
    waitApi(page, 'GET', '/referentials/permission-levels'),
    waitApi(page, 'GET', scope === 'role' ? '/roles' : '/courriers/actors'),
  ];
  await page.goto(scope === 'role' ? TYPE_ROLE_PAGE : TYPE_USER_PAGE);
  for (const res of await Promise.all(loads)) expect(res.status()).toBe(200);
}

/** Édition inline (`EditableText`) : clic sur la valeur, saisie, Entrée. */
export async function editInline(scope: Locator, current: string, next: string): Promise<void> {
  await scope.getByRole('button', { name: current, exact: true }).click();
  // Le champ prend le focus (`autoFocus`). On le vise par le focus et non sous `scope` : `scope` est
  // en général une ligne retrouvée par son texte, et ce texte change pendant la saisie.
  const input = scope.page().locator('input:focus');
  await expect(input).toBeVisible();
  await input.fill(next);
  await input.press('Enter');
}

// ---------------------------------------------------------------------------------------------
// Données
// ---------------------------------------------------------------------------------------------

export interface ConfidentialiteRow {
  confidentialiteId: number;
  label: string;
  rank: number;
}

export async function listConfidentialites(api: Api): Promise<ConfidentialiteRow[]> {
  return api.get('/referentials/confidentialites');
}

export async function createConfidentialite(api: Api, label: string): Promise<ConfidentialiteRow> {
  return api.post('/referentials/confidentialites', { label });
}

/** Nettoyage : ignore un niveau déjà désactivé ou absent. */
export async function dropConfidentialite(api: Api, id: number | undefined): Promise<void> {
  if (id != null) await api.raw.del(`/referentials/confidentialites/${id}`);
}

export interface DocTypeRow {
  documentTypeId: number;
  label: string;
}

export async function createDocumentType(api: Api, label: string): Promise<DocTypeRow> {
  return api.post('/referentials/document-types', { label });
}

/**
 * Nettoyage d'un type créé par un test : retire d'abord ses droits par type (un droit en vigueur
 * restreint TOUS les documents du type — cf. `DocumentsService.isVisibleByPermissions`), puis le
 * désactive.
 */
export async function dropDocumentType(
  api: Api,
  documentTypeId: number | undefined,
): Promise<void> {
  if (documentTypeId == null) return;
  const grants = await listTypePermissions(api);
  for (const g of grants.filter((r) => r.documentTypeId === documentTypeId)) {
    await api.raw.del(`/referentials/document-type-permissions/${g.documentTypePermissionId}`);
  }
  await api.raw.del(`/referentials/document-types/${documentTypeId}`);
}

export interface TypePermissionRow {
  documentTypePermissionId: number;
  documentTypeId: number;
  documentTypeLabel: string;
  permissionLevelId: number;
  permissionLevelName: string;
  scope: 'user' | 'role';
  roleId: number | null;
  userGroupId: number | null;
  label: string;
  startDate: string | null;
  endDate: string | null;
}

export async function listTypePermissions(api: Api): Promise<TypePermissionRow[]> {
  return api.get('/referentials/document-type-permissions');
}

export async function grantType(
  api: Api,
  body: {
    documentTypeId: number;
    permissionLevelId: number;
    roleId?: number;
    userGroupId?: number;
    startDate?: string;
    endDate?: string;
  },
): Promise<{ documentTypePermissionId: number }> {
  return api.post('/referentials/document-type-permissions', body);
}

export interface UserListRow {
  userId: number;
  username: string;
  fullName: string | null;
  isAdmin: boolean;
  roleId: number | null;
  confidentialiteId: number | null;
}

export async function findUser(api: Api, userId: number): Promise<UserListRow> {
  const users: UserListRow[] = await api.get('/users');
  const u = users.find((r) => r.userId === userId);
  if (!u) throw new Error(`Utilisateur ${userId} absent de GET /users`);
  return u;
}

/**
 * Utilisateur doté d'un ACTEUR (`app_user_group`) : sans lui, il n'apparaît pas dans la liste des
 * bénéficiaires de « Sécurité type document par utilisateur » (`GET /courriers/actors`), et un
 * droit nominatif n'a personne à viser. `createUser` (tâche B) ne pose pas de profil : on en crée
 * un, on l'affecte comme défaut, puis on relit `userGroupId` dans un jeton émis APRÈS l'affectation.
 *
 * Le PRÉNOM est unique : `createUser` nomme sinon tout le monde « Test E2E », et la liste des
 * bénéficiaires n'affiche que le nom de la personne — les options seraient indiscernables.
 */
export async function createActorUser(
  api: Api,
  apiAs: ApiAs,
  uniq: Uniq,
  opts: { roleId?: number | null; confidentialiteId?: number | null } = {},
): Promise<{
  userId: number;
  username: string;
  password: string;
  userGroupId: number;
  fullName: string;
}> {
  const user = await createUser(api, {
    roleId: opts.roleId ?? null,
    confidentialiteId: opts.confidentialiteId ?? null,
    username: uniq('acteur'),
    firstName: uniq('Acteur'),
    lastName: 'E2E',
  });
  const group: { groupId: number } = await api.post('/users/groups/all', {
    name: uniq('e2e-profil'),
  });
  await api.post(`/users/${user.userId}/groups`, { groupId: group.groupId, isDefault: true });
  const as = await apiAs(user.username, user.password);
  const me: { userGroupId: number | null } = await as.get('/auth/me');
  if (me.userGroupId == null)
    throw new Error('Acteur non porté par le jeton après affectation du profil');
  return { ...user, userGroupId: me.userGroupId };
}
