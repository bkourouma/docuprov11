/**
 * Sécurité Documentaire — « Sécurité type document par rôle » (`/admin/securite/type-par-profil`,
 * clé historique « profil » conservée). Droits par TYPE accordés à un RÔLE entier
 * (`document_type_permission.role_id`), écran commun `components/security/TypeSecurityPage.tsx`.
 *
 * Chaque test crée SES types de document : un droit en vigueur sur un type restreint TOUS les
 * documents de ce type aux seuls bénéficiaires (`DocumentsService.isVisibleByPermissions`) —
 * accorder un droit sur un type du seed changerait ce que voient les autres tests.
 */
import { test, expect } from '../../../fixtures';
import { createRole } from '../_helpers/accounts';
import {
  LEVEL,
  UNKNOWN_ID,
  closeDropdown,
  confirmPopover,
  createActorUser,
  createDocumentType,
  dropDocumentType,
  dropdownOption,
  dropdownOptions,
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

async function newType(api: Parameters<typeof createDocumentType>[0], label: string) {
  const t = await createDocumentType(api, label);
  types.push(t.documentTypeId);
  return t;
}

test('SOC-53 accorder un niveau à un rôle sur deux types : une ligne par bénéficiaire, deux droits', async ({
  page,
  api,
  uniq,
}) => {
  const role = await createRole(api, { name: uniq('soc53-role'), menuKeys: [] });
  const t1 = await newType(api, uniq('SOC53 type A'));
  const t2 = await newType(api, uniq('SOC53 type B'));

  await openTypePage(page, 'role');
  await pickOption(page, page.getByLabel('Rôles', { exact: true }), role.name);
  await closeDropdown(page);
  await pickOption(page, page.getByLabel('Types de document', { exact: true }), t1.label);
  await pickOption(page, page.getByLabel('Types de document', { exact: true }), t2.label);
  await closeDropdown(page);
  await pickOption(page, page.getByLabel('Niveau de permission', { exact: true }), 'Consultation', {
    search: false,
  });

  const reloaded = waitApi(page, 'GET', '/referentials/document-type-permissions');
  await page.getByRole('button', { name: 'Accorder' }).click();
  await expect(page.getByText('Droit accordé (1 × 2).')).toBeVisible();
  await reloaded;

  const group = await revealRow(page, role.name);
  await expect(group).toContainText('2 droits');
  await group.getByRole('button', { name: 'Développer la ligne' }).click();
  for (const t of [t1, t2]) {
    // `.last()` : la ligne d'expansion qui ENGLOBE la table interne porte aussi ce texte.
    const inner = page.getByRole('row', { name: rx(t.label) }).last();
    await expect(inner).toContainText('Consultation');
    await expect(inner).toContainText('Sans limite');
  }

  const rows = (await listTypePermissions(api)).filter((r) => r.roleId === role.roleId);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.documentTypeId))).toEqual(new Set([t1.documentTypeId, t2.documentTypeId]));
  for (const r of rows) {
    expect(r).toMatchObject({ scope: 'role', permissionLevelId: LEVEL.CONSULTATION, userGroupId: null });
  }
});

test('SOC-54 retirer un droit, puis « Tout retirer » : seuls les droits de ce rôle partent', async ({
  page,
  api,
  uniq,
}) => {
  const role = await createRole(api, { name: uniq('soc54-role'), menuKeys: [] });
  const witness = await createRole(api, { name: uniq('soc54-temoin'), menuKeys: [] });
  const [t1, t2, t3] = [
    await newType(api, uniq('SOC54 type A')),
    await newType(api, uniq('SOC54 type B')),
    await newType(api, uniq('SOC54 type C')),
  ];
  for (const t of [t1, t2, t3]) {
    await grantType(api, { documentTypeId: t.documentTypeId, permissionLevelId: LEVEL.MODIFICATION, roleId: role.roleId });
  }
  await grantType(api, { documentTypeId: t1.documentTypeId, permissionLevelId: LEVEL.CONSULTATION, roleId: witness.roleId });

  await openTypePage(page, 'role');
  const group = await revealRow(page, role.name);
  await expect(group).toContainText('3 droits');
  await group.getByRole('button', { name: 'Développer la ligne' }).click();

  await page.getByRole('button', { name: `Retirer le droit sur ${t1.label}` }).click();
  const one = waitApi(page, 'DELETE', /\/api\/referentials\/document-type-permissions\/\d+$/);
  await confirmPopover(page, 'Retirer');
  expect((await one).status()).toBe(200);
  await expect(page.getByText('Droit retiré.')).toBeVisible();
  await expect(group).toContainText('2 droits');
  let mine = (await listTypePermissions(api)).filter((r) => r.roleId === role.roleId);
  expect(mine.map((r) => r.documentTypeId).sort()).toEqual([t2.documentTypeId, t3.documentTypeId].sort());

  await group.getByRole('button', { name: 'Tout retirer' }).click();
  await confirmPopover(page, 'Tout retirer');
  await expect(page.getByText('2 droits retirés.')).toBeVisible();
  await expect(page.getByRole('row', { name: rx(role.name) })).toHaveCount(0);

  const all = await listTypePermissions(api);
  mine = all.filter((r) => r.roleId === role.roleId);
  expect(mine).toHaveLength(0);
  // Le témoin, sur un type commun, est intact.
  expect(all.filter((r) => r.roleId === witness.roleId)).toHaveLength(1);
});

test('SOC-55 saisies incomplètes ou invalides : avertissement à l’écran, 400/404 par l’API, rien d’écrit', async ({
  page,
  api,
  apiAs,
  uniq,
}) => {
  const role = await createRole(api, { name: uniq('soc55-role'), menuKeys: [] });
  const actor = await createActorUser(api, apiAs, uniq);
  const t = await newType(api, uniq('SOC55 type'));
  const off = await newType(api, uniq('SOC55 type désactivé'));
  await api.del(`/referentials/document-types/${off.documentTypeId}`);

  await openTypePage(page, 'role');
  await page.getByRole('button', { name: 'Accorder' }).click();
  await expect(page.getByText('Choisissez au moins un bénéficiaire, un type et un niveau.')).toBeVisible();

  const ok = { documentTypeId: t.documentTypeId, permissionLevelId: LEVEL.CONSULTATION };
  const cases: Array<[string, unknown]> = [
    ['sans bénéficiaire', ok],
    ['deux bénéficiaires', { ...ok, roleId: role.roleId, userGroupId: actor.userGroupId }],
    // Recette du plan sécurité : « un appel API direct avec le niveau 1 est refusé » (corrigé).
    ['niveau Denied', { ...ok, permissionLevelId: LEVEL.DENIED, roleId: role.roleId }],
    // Les cas suivants violaient une clé étrangère → 500 avant correctif.
    ['type inconnu', { ...ok, documentTypeId: UNKNOWN_ID, roleId: role.roleId }],
    ['type désactivé', { ...ok, documentTypeId: off.documentTypeId, roleId: role.roleId }],
    ['niveau inconnu', { ...ok, permissionLevelId: 99, roleId: role.roleId }],
    ['rôle inconnu', { ...ok, roleId: UNKNOWN_ID }],
    ['acteur inconnu', { ...ok, userGroupId: UNKNOWN_ID }],
    // Dates : format AAAA-MM-JJ, jour réel, fin ≥ début (date illisible → 500 avant correctif).
    ['date illisible', { ...ok, roleId: role.roleId, startDate: 'demain' }],
    ['jour inexistant', { ...ok, roleId: role.roleId, startDate: '2026-02-31' }],
    ['fin avant début', { ...ok, roleId: role.roleId, startDate: '2026-06-02', endDate: '2026-06-01' }],
  ];
  for (const [name, body] of cases) {
    expect((await api.raw.post('/referentials/document-type-permissions', body)).status(), name).toBe(400);
  }
  expect((await api.raw.del(`/referentials/document-type-permissions/${UNKNOWN_ID}`)).status()).toBe(404);

  const written = (await listTypePermissions(api)).filter(
    (r) => r.documentTypeId === t.documentTypeId || r.documentTypeId === off.documentTypeId,
  );
  expect(written).toHaveLength(0);
});

test('SOC-56 « Denied » n’est jamais proposé à l’octroi', async ({ page, api }) => {
  const levels: Array<{ permissionLevelId: number; name: string }> = await api.get('/referentials/permission-levels');
  expect(levels.map((l) => l.permissionLevelId)).toEqual([2, 3, 4, 5]);

  await openTypePage(page, 'role');
  await page.getByLabel('Niveau de permission', { exact: true }).click();
  for (const name of ['Consultation', 'Modification', 'Administration', 'Archivistique']) {
    await expect(dropdownOption(page, name)).toBeVisible();
  }
  await expect(dropdownOption(page, 'Denied')).toHaveCount(0);
  await expect(dropdownOptions(page)).toHaveCount(4);
});

test('SOC-57 cloisonnement des écrans : droits « par rôle » et « par utilisateur » ne se mélangent pas', async ({
  page,
  api,
  apiAs,
  uniq,
}) => {
  const role = await createRole(api, { name: uniq('soc57-role'), menuKeys: [] });
  const actor = await createActorUser(api, apiAs, uniq);
  const t = await newType(api, uniq('SOC57 type'));
  await grantType(api, { documentTypeId: t.documentTypeId, permissionLevelId: LEVEL.CONSULTATION, roleId: role.roleId });
  await grantType(api, { documentTypeId: t.documentTypeId, permissionLevelId: LEVEL.CONSULTATION, userGroupId: actor.userGroupId });

  // Le filtre de l'écran porte sur `scope` : chaque ligne doit porter le bon.
  const rows = (await listTypePermissions(api)).filter((r) => r.documentTypeId === t.documentTypeId);
  expect(rows.find((r) => r.roleId === role.roleId)?.scope).toBe('role');
  expect(rows.find((r) => r.userGroupId === actor.userGroupId)?.scope).toBe('user');

  await openTypePage(page, 'role');
  await revealRow(page, role.name);
  await expect(page.getByRole('row', { name: rx(actor.fullName) })).toHaveCount(0);

  await openTypePage(page, 'user');
  await revealRow(page, actor.fullName);
  await expect(page.getByRole('row', { name: rx(role.name) })).toHaveCount(0);
});
