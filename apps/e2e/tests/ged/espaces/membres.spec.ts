/**
 * GED — membres d'un espace (onglet « Membres » du détail, `MembersPanel`).
 * Scénario GED-14 : ajout d'un utilisateur, changement de droit, retrait, et leur effet réel sur
 * l'accès du membre (vérifié par l'API à son nom).
 */
import { test, expect } from '../../../fixtures';
import {
  PERMISSION_LABEL,
  SpaceKind,
  SpacePermission,
  antMessage,
  createSpace,
  createSpaceUser,
  pickAntOption,
  popconfirmButton,
  type SpaceDetail,
} from '../_helpers/espaces';

test.describe('GED espaces — membres', () => {
  test('GED-14 ajouter un membre, changer son droit puis le retirer', async ({ page, api, apiAs, uniq }) => {
    const member = await createSpaceUser(api, apiAs, uniq('ged14'));
    const memberApi = await apiAs(member.username, member.password);
    const space = await createSpace(api, { label: uniq('ged14-esp'), kind: SpaceKind.Partage });
    // Libellé du bénéficiaire : `fullName` = « E2E <username> » (createRestrictedUser).
    const grantee = `E2E ${member.username}`;

    // Avant : le non-membre ne voit pas l'espace partagé (404, existence non révélée).
    expect((await memberApi.raw.get(`/spaces/${space.gedSpaceId}`)).status()).toBe(404);

    await page.goto(`/espaces/${space.gedSpaceId}`);
    await page.getByRole('tab', { name: 'Membres' }).click();
    await expect(page.getByText("Aucun membre : seul le propriétaire accède à l'espace.")).toBeVisible();

    // Ajout : un utilisateur, droit « Lecture ».
    await page.getByRole('radio', { name: 'Un utilisateur' }).check();
    await pickAntOption(
      page,
      page.getByRole('combobox', { name: 'Utilisateur à ajouter' }),
      `(${member.username})`,
      member.username,
    );
    await pickAntOption(page, page.getByRole('combobox', { name: 'Droit accordé' }), PERMISSION_LABEL[0]);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(antMessage(page, 'Membre ajouté')).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: grantee });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Utilisateur');
    await expect(row.getByRole('combobox', { name: `Droit de ${grantee}` })).toBeVisible();
    await expect(row.locator('.ant-select-selection-item')).toHaveText('Lecture');

    let seen = await memberApi.get<SpaceDetail>(`/spaces/${space.gedSpaceId}`);
    expect(seen.myAccess).toBe(SpacePermission.Lecture);
    expect(seen.canContribute).toBe(false);
    expect(seen.canManage).toBe(false);

    // Doublon refusé par l'API (409), sans seconde ligne à l'écran.
    const dup = await api.raw.post(`/spaces/${space.gedSpaceId}/members`, {
      userGroupId: member.userGroupId,
      permission: SpacePermission.Gestion,
    });
    expect(dup.status()).toBe(409);

    // Changement de droit : Lecture → Gestion.
    await pickAntOption(page, row.getByRole('combobox', { name: `Droit de ${grantee}` }), /^Gestion$/);
    await expect(antMessage(page, 'Droit modifié')).toBeVisible();
    await expect(row.locator('.ant-select-selection-item')).toHaveText('Gestion');
    seen = await memberApi.get<SpaceDetail>(`/spaces/${space.gedSpaceId}`);
    expect(seen.myAccess).toBe(SpacePermission.Gestion);
    expect(seen.canManage).toBe(true);

    // Le compteur « Membres » de l'en-tête suit.
    expect((await api.get<SpaceDetail>(`/spaces/${space.gedSpaceId}`)).memberCount).toBe(1);

    // Retrait, avec confirmation.
    await row.getByRole('button', { name: `Retirer ${grantee}` }).click();
    await popconfirmButton(page, 'Retirer').click();
    await expect(antMessage(page, 'Membre retiré')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: grantee })).toHaveCount(0);

    // Après : l'ancien membre ne voit plus l'espace.
    expect((await memberApi.raw.get(`/spaces/${space.gedSpaceId}`)).status()).toBe(404);
  });

  test('GED-14 espace privé : pas de gestion des membres (écran et API)', async ({ page, api, apiAs, uniq }) => {
    const member = await createSpaceUser(api, apiAs, uniq('ged14p'));
    const space = await createSpace(api, { label: uniq('ged14-prive'), kind: SpaceKind.Prive });

    await page.goto(`/espaces/${space.gedSpaceId}`);
    await page.getByRole('tab', { name: 'Membres' }).click();
    await expect(page.getByText('Un espace privé est réservé à son propriétaire.')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Utilisateur à ajouter' })).toHaveCount(0);

    const res = await api.raw.post(`/spaces/${space.gedSpaceId}/members`, {
      userGroupId: member.userGroupId,
      permission: SpacePermission.Lecture,
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('Un espace privé est réservé à son propriétaire');
  });
});
