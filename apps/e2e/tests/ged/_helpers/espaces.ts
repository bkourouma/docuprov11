/**
 * Aides GED « espaces » (lot 3, tâche T2) : données d'espace créées par l'API, comptes de test
 * dotés d'un compte-groupe, contextes navigateur dédiés (autre utilisateur, anonyme) et gestes
 * Ant Design répétés (choix dans un Select, confirmation d'un Popconfirm).
 *
 * Écrites contre le contrat des fixtures (`apps/e2e/fixtures`, lot 0) : `api` est un client REST
 * administrateur, chemins relatifs à `/api`, qui lève sur un statut >= 400.
 *
 * Volontairement autonomes : elles n'importent ni `documents.ts` ni `editeur.ts` (écrits en
 * parallèle par d'autres exécutants).
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createRestrictedUser, type ApiAs, type GedApi, type GedUser } from './users';

/** Clé de menu RBAC de l'écran « Espaces » (`apps/api/src/modules/spaces/spaces.menus.ts`). */
export const SPACES_MENU = '/espaces';

/** Natures d'espace (`packages/types/src/ged.ts`, `GedSpaceKind`). */
export const SpaceKind = { Prive: 0, Partage: 1, Collaboration: 2, Publication: 3 } as const;
export type SpaceKindValue = (typeof SpaceKind)[keyof typeof SpaceKind];

/** Droits de membre (`GedSpacePermission`) et leurs libellés affichés. */
export const SpacePermission = { Lecture: 0, Contribution: 1, Gestion: 2 } as const;
export type SpacePermissionValue = (typeof SpacePermission)[keyof typeof SpacePermission];
export const PERMISSION_LABEL: Record<SpacePermissionValue, string> = {
  0: 'Lecture',
  1: 'Contribution',
  2: 'Gestion',
};
export const KIND_LABEL: Record<SpaceKindValue, string> = {
  0: 'Privé',
  1: 'Partagé',
  2: 'Collaboration',
  3: 'Publication',
};

/** Forme utile de `GedSpaceSummary` / `GedSpaceDetail` (`packages/types/src/ged-spaces.ts`). */
export interface SpaceSummary {
  gedSpaceId: number;
  label: string;
  description: string | null;
  kind: SpaceKindValue;
  isActive: boolean;
  ownerUserGroupId: number;
  ownerName: string | null;
  publicationSlug: string | null;
  publishedAt: string | null;
  documentCount: number | null;
  memberCount: number;
  myAccess: 'owner' | SpacePermissionValue | null;
}
export interface SpaceDetail extends SpaceSummary {
  members: Array<{
    gedSpaceMemberId: number;
    userGroupId: number | null;
    roleId: number | null;
    granteeLabel: string;
    granteeType: 'user' | 'role';
    permission: SpacePermissionValue;
  }>;
  canManage: boolean;
  canContribute: boolean;
}
export interface SpaceDocumentRow {
  documentId: number;
  label: string;
  documentTypeLabel: string | null;
  addedAt: string;
}

/**
 * Slug de publication valide (`SLUG_PATTERN` = `^[a-z0-9]+(-[a-z0-9]+)*$`, 3 à 120 caractères ;
 * l'écran borne la saisie à 80) dérivé d'une chaîne quelconque, typiquement `uniq('pub')`.
 */
export function toSlug(raw: string): string {
  const s = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return s.length >= 3 ? s : `esp-${s || 'x'}`;
}

/** Chemin de la page publique d'un espace (`publicPath` de `apps/web/app/lib/espaces.ts`). */
export const publicPath = (slug: string) => `/espaces/publie/${slug}`;

// ------------------------------------------------------------------------------------- données

/** Crée un espace (nature 0 à 2) au nom du client donné ; le propriétaire est son groupe par défaut. */
export function createSpace(
  api: GedApi,
  input: { label: string; kind?: 0 | 1 | 2; description?: string | null },
): Promise<SpaceSummary> {
  return api.post<SpaceSummary>('/spaces', {
    label: input.label,
    kind: input.kind ?? SpaceKind.Partage,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
}

/** Publie un espace partagé (slug facultatif : dérivé du libellé sinon). */
export async function publishSpace(api: GedApi, spaceId: number, slug?: string): Promise<SpaceSummary> {
  const res = await api.post<{ space: SpaceSummary; nonPublishableCount: number }>(
    `/spaces/${spaceId}/publish`,
    slug ? { slug } : {},
  );
  return res.space;
}

/** Ajoute un utilisateur (par son compte-groupe) comme membre d'un espace partagé. */
export function addUserMember(
  api: GedApi,
  spaceId: number,
  userGroupId: number,
  permission: SpacePermissionValue,
) {
  return api.post<{ gedSpaceMemberId: number }>(`/spaces/${spaceId}/members`, { userGroupId, permission });
}

/**
 * Document texte natif créé par l'API de l'éditeur (`POST /collab/documents`) : il est rattaché
 * d'office à l'espace `spaceId` (le client doit y avoir le droit de contribution).
 */
export function createEditorDocument(
  api: GedApi,
  spaceId: number,
  label: string,
): Promise<{ documentId: number; label: string }> {
  return api.post<{ documentId: number; label: string; warnings: string[] }>('/collab/documents', {
    spaceId,
    label,
  });
}

/**
 * Valide (archive) un document : `PATCH /documents/:id/indexation { validate: true }` bascule
 * `is_archived = true`. Nécessaire pour qu'il apparaisse dans `POST /documents/search`, la
 * recherche utilisée par la modale « Rattacher un document » (elle ne porte que sur l'archive).
 * Effet de bord connu : la validation appose aussi le cachet serveur (`sealIfNeeded`).
 */
export function archiveDocument(api: GedApi, documentId: number) {
  return api.patch(`/documents/${documentId}/indexation`, { validate: true });
}

// -------------------------------------------------------------------------------------- comptes

export interface SpaceUser extends GedUser {
  /** Compte-groupe par défaut : c'est l'identité d'un membre d'espace (`userGroupId`). */
  userGroupId: number;
}

/**
 * Utilisateur NON administrateur portant `menuKeys`, AVEC un compte-groupe par défaut.
 *
 * `createRestrictedUser` (users.ts) crée un compte sans groupe : il ne peut alors ni créer
 * d'espace (403 « pas de groupe par défaut ») ni être ajouté comme membre (`userGroupId`). On lui
 * crée donc un profil dédié, affecté par défaut ; le jeton ne porte le compte-groupe qu'à la
 * connexion SUIVANTE, d'où la relecture de `/auth/me` par un nouveau client.
 */
export async function createSpaceUser(
  api: GedApi,
  apiAs: ApiAs,
  prefix: string,
  menuKeys: string[] = [SPACES_MENU],
): Promise<SpaceUser> {
  const user = await createRestrictedUser(api, apiAs, prefix, menuKeys);
  const group = await api.post<{ groupId: number }>('/users/groups/all', { name: `E2E ${user.username}` });
  await api.post(`/users/${user.userId}/groups`, { groupId: group.groupId, isDefault: true });
  const self = await apiAs(user.username, user.password);
  const me = await self.get<{ userGroupId?: number | null }>('/auth/me');
  if (me.userGroupId == null) {
    throw new Error(`createSpaceUser : aucun compte-groupe par défaut pour ${user.username}`);
  }
  return { ...user, userGroupId: me.userGroupId };
}

// ----------------------------------------------------------------------------------- navigateurs

/** URL de base du projet Playwright : `browser.newContext()` n'hérite PAS des options `use`. */
function baseURLOf(testInfo: TestInfo): string | undefined {
  return testInfo.project.use.baseURL;
}

/** Contexte navigateur SANS aucune session (ni cookie ni localStorage `token`). */
export function anonymousContext(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: baseURLOf(testInfo),
    storageState: { cookies: [], origins: [] },
  });
}

/**
 * Page d'un AUTRE utilisateur, dans un contexte isolé de celui de l'administrateur, connectée par
 * l'écran de connexion (`loginAs` des fixtures). Fermer le contexte en fin de test.
 */
export async function userPage(
  browser: Browser,
  testInfo: TestInfo,
  loginAs: (page: Page, username: string, password: string) => Promise<unknown>,
  user: { username: string; password: string },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await anonymousContext(browser, testInfo);
  const page = await context.newPage();
  await loginAs(page, user.username, user.password);
  return { context, page };
}

// ------------------------------------------------------------------------------- gestes Ant Design

/** Messages globaux AntD (`message.success/error`), rendus dans `.ant-message`. */
export const antMessage = (page: Page, text: string | RegExp): Locator =>
  page.locator('.ant-message').getByText(text);

/**
 * Zone cliquable d'un Select AntD à partir de son combobox accessible. Quand une valeur est
 * choisie, son libellé (`.ant-select-selection-item`) recouvre l'`<input>` du combobox et
 * intercepte le clic : on clique donc le sélecteur qui les contient tous deux.
 */
export function antSelectTrigger(combobox: Locator): Locator {
  return combobox.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ant-select-selector ")][1]',
  );
}

/**
 * Ouvre un Select AntD (cible : son combobox accessible) et choisit l'option dont le texte
 * contient `optionText`. `search` : texte tapé d'abord dans un Select `showSearch`.
 */
export async function pickAntOption(
  page: Page,
  combobox: Locator,
  optionText: string | RegExp,
  search?: string,
): Promise<void> {
  await antSelectTrigger(combobox).click();
  if (search !== undefined) await combobox.fill(search);
  const option = page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: optionText })
    .first();
  await expect(option).toBeVisible();
  await option.click();
}

/** Valeur d'une ligne « libellé : valeur » d'un `Descriptions` AntD (en-tête du détail d'espace). */
export function descriptionValue(page: Page, label: string): Locator {
  const exact = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  return page
    .locator('.ant-descriptions-item')
    .filter({ has: page.locator('.ant-descriptions-item-label', { hasText: exact }) })
    .locator('.ant-descriptions-item-content');
}

/** Bouton de confirmation du Popconfirm AntD actuellement ouvert. */
export const popconfirmButton = (page: Page, name: string): Locator =>
  page.locator('.ant-popconfirm:not(.ant-popover-hidden)').getByRole('button', { name, exact: true });

/** Identifiant numérique d'une URL `/espaces/<id>` ou `/editeur/<id>`. */
export function idFromUrl(url: string, segment: 'espaces' | 'editeur' | 'documents'): number {
  const m = new URL(url).pathname.match(new RegExp(`/${segment}/(\\d+)`));
  if (!m) throw new Error(`Aucun identifiant /${segment}/<id> dans ${url}`);
  return Number(m[1]);
}
