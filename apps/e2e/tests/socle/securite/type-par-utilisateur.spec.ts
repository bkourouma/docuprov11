/**
 * Sécurité Documentaire — « Sécurité type document par utilisateur »
 * (`/admin/securite/type-par-utilisateur`) : droits par TYPE accordés à un acteur nommé
 * (`document_type_permission.user_group_id`), avec période de validité facultative.
 *
 * Fuseau : la config Playwright fixe `timezoneId: 'UTC'`, l'affichage des dates est donc stable.
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser, createRole } from '../_helpers/accounts';
import {
  LEVEL,
  SECURITY_MENU,
  closeDropdown,
  confirmPopover,
  createActorUser,
  createDocumentType,
  dropDocumentType,
  grantType,
  listTypePermissions,
  openTypePage,
  pickOption,
  revealRow,
  rx,
  waitApi,
} from '../_helpers/securite';

let types: number[] = [];
test.afterEach(async ({ api }) => {
  for (const id of types) await dropDocumentType(api, id);
  types = [];
});

test('SOC-58 accorder un droit daté à un utilisateur, le lire, puis le retirer', async ({
  page,
  api,
  apiAs,
  uniq,
}) => {
  const actor = await createActorUser(api, apiAs, uniq);
  const t = await createDocumentType(api, uniq('SOC58 type'));
  types.push(t.documentTypeId);

  await openTypePage(page, 'user');
  await pickOption(page, page.getByLabel('Utilisateurs', { exact: true }), actor.fullName);
  await closeDropdown(page);
  await pickOption(page, page.getByLabel('Types de document', { exact: true }), t.label);
  await closeDropdown(page);
  await pickOption(page, page.getByLabel('Niveau de permission', { exact: true }), 'Modification', {
    search: false,
  });
  const start = page.getByLabel(/^Début/);
  await start.fill('01/01/2026');
  await start.press('Enter');
  const end = page.getByLabel(/^Fin/);
  await end.fill('31/12/2026');
  await end.press('Enter');

  const posted = waitApi(page, 'POST', '/referentials/document-type-permissions');
  await page.getByRole('button', { name: 'Accorder' }).click();
  const res = await posted;
  expect(res.status()).toBe(201);
  expect(res.request().postDataJSON()).toEqual({
    documentTypeId: t.documentTypeId,
    permissionLevelId: LEVEL.MODIFICATION,
    userGroupId: actor.userGroupId,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  await expect(page.getByText('Droit accordé (1 × 1).')).toBeVisible();

  const group = await revealRow(page, actor.fullName);
  await expect(group).toContainText('1 droit');
  await group.getByRole('button', { name: 'Développer la ligne' }).click();
  const inner = page.getByRole('row', { name: rx(t.label) }).last();
  await expect(inner).toContainText('Modification');
  await expect(inner).toContainText('01/01/2026 → 31/12/2026');

  const rows = (await listTypePermissions(api)).filter((r) => r.documentTypeId === t.documentTypeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ scope: 'user', userGroupId: actor.userGroupId, roleId: null });
  expect(rows[0]!.startDate?.slice(0, 10)).toBe('2026-01-01');
  expect(rows[0]!.endDate?.slice(0, 10)).toBe('2026-12-31');

  await page.getByRole('button', { name: `Retirer le droit sur ${t.label}` }).click();
  await confirmPopover(page, 'Retirer');
  await expect(page.getByText('Droit retiré.')).toBeVisible();
  await expect(page.getByRole('row', { name: rx(actor.fullName) })).toHaveCount(0);
  expect((await listTypePermissions(api)).filter((r) => r.documentTypeId === t.documentTypeId)).toHaveLength(0);
});

/**
 * Règle (décision de l'utilisateur du 2026-11-22) : octroyer, retirer et lister les droits par type
 * est réservé aux titulaires des écrans « Type par utilisateur » / « Type par profil »
 * (`referentials.controller.ts`, `@RequireMenu`). Un compte sans ces menus reçoit 403 et ne change rien ;
 * un titulaire de l'un d'eux gère les droits, y compris ceux d'autrui.
 */
test('SOC-59 droits par type : refus sans menu de sécurité, gestion par le titulaire du menu', async ({
  api,
  apiAs,
  uniq,
}) => {
  const t = await createDocumentType(api, uniq('SOC59 type'));
  types.push(t.documentTypeId);
  const otherRole = await createRole(api, { name: uniq('soc59-autrui'), menuKeys: [] });
  const adminGrant = await grantType(api, {
    documentTypeId: t.documentTypeId,
    permissionLevelId: LEVEL.CONSULTATION,
    roleId: otherRole.roleId,
  });

  // Sans menu de sécurité par type : lecture, octroi et retrait refusés, rien n'est écrit.
  const outsider = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
  const as = await apiAs(outsider.username, outsider.password);
  const refused = await as.raw.post('/referentials/document-type-permissions', {
    documentTypeId: t.documentTypeId,
    permissionLevelId: LEVEL.ADMINISTRATION,
    roleId: outsider.roleId,
  });
  expect(refused.status()).toBe(403);
  expect((await as.raw.get('/referentials/document-type-permissions')).status()).toBe(403);
  expect(
    (await as.raw.del(`/referentials/document-type-permissions/${adminGrant.documentTypePermissionId}`)).status(),
  ).toBe(403);
  const afterRefusal = (await listTypePermissions(api)).filter((r) => r.documentTypeId === t.documentTypeId);
  expect(afterRefusal.map((r) => r.documentTypePermissionId)).toEqual([adminGrant.documentTypePermissionId]);

  // Titulaire du seul menu « Type par utilisateur » : il lit, accorde et retire (y compris le droit d'autrui).
  const holder = await createRestrictedUser(api, uniq, [SECURITY_MENU.typeByUser]);
  const hs = await apiAs(holder.username, holder.password);
  expect((await hs.raw.get('/referentials/document-type-permissions')).status()).toBe(200);
  const granted = await hs.raw.post('/referentials/document-type-permissions', {
    documentTypeId: t.documentTypeId,
    permissionLevelId: LEVEL.ADMINISTRATION,
    roleId: holder.roleId,
  });
  expect(granted.status()).toBe(201);
  const { documentTypePermissionId } = (await granted.json()) as { documentTypePermissionId: number };
  expect(
    (await hs.raw.del(`/referentials/document-type-permissions/${adminGrant.documentTypePermissionId}`)).status(),
  ).toBe(200);
  expect((await hs.raw.del(`/referentials/document-type-permissions/${documentTypePermissionId}`)).status()).toBe(200);
  expect((await listTypePermissions(api)).filter((r) => r.documentTypeId === t.documentTypeId)).toHaveLength(0);
});
