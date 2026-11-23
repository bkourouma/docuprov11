/**
 * GED — création, modification et suppression d'un espace (formulaire `SpaceFormModal`, détail
 * `/espaces/[spaceId]`). Scénarios GED-12 (cycle de vie nominal) et GED-13 (erreurs de saisie).
 */
import { test, expect } from '../../../fixtures';
import {
  SpaceKind,
  antMessage,
  createSpace,
  descriptionValue,
  idFromUrl,
  type SpaceDetail,
} from '../_helpers/espaces';

test.describe('GED espaces — création', () => {
  test('GED-12 créer un espace par l’interface, le modifier puis le supprimer', async ({ page, api, uniq }) => {
    const label = uniq('ged12');
    const renamed = `${label} renommé`;

    await page.goto('/espaces');
    await page.getByRole('button', { name: 'Nouvel espace' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel espace' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Libellé').fill(label);
    await dialog.getByLabel('Description').fill('Espace de travail du comité de rédaction');
    await dialog.getByRole('radio', { name: 'Collaboration' }).check();
    // Aide propre au type choisi (`KIND_HELP`).
    await expect(dialog.getByText(/Espace de travail commun : les membres contributeurs/)).toBeVisible();

    const created = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/spaces' && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: "Créer l'espace" }).click();
    expect((await created).status()).toBe(201);

    await expect(antMessage(page, 'Espace créé')).toBeVisible();
    await expect(page).toHaveURL(/\/espaces\/\d+$/);
    const spaceId = idFromUrl(page.url(), 'espaces');
    await expect(page.getByRole('heading', { name: label })).toBeVisible();
    await expect(page.getByText('Espace de travail du comité de rédaction')).toBeVisible();
    await expect(descriptionValue(page, 'Type')).toHaveText('Collaboration');
    await expect(descriptionValue(page, 'Mon droit')).toHaveText('Propriétaire');
    await expect(descriptionValue(page, 'Publication')).toHaveText('Non publié');

    const detail = await api.get<SpaceDetail>(`/spaces/${spaceId}`);
    expect(detail).toMatchObject({ label, kind: SpaceKind.Collaboration, myAccess: 'owner', canManage: true });

    // Modification du libellé.
    await page.getByRole('button', { name: 'Modifier' }).click();
    const edit = page.getByRole('dialog', { name: "Modifier l'espace" });
    await expect(edit.getByLabel('Libellé')).toHaveValue(label);
    await edit.getByLabel('Libellé').fill(renamed);
    await edit.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(antMessage(page, 'Espace modifié')).toBeVisible();
    await expect(page.getByRole('heading', { name: renamed })).toBeVisible();
    expect((await api.get<SpaceDetail>(`/spaces/${spaceId}`)).label).toBe(renamed);

    // Suppression (logique) par le propriétaire, avec confirmation.
    await page.getByRole('button', { name: 'Supprimer' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: `Supprimer l'espace « ${renamed} » ?` });
    await expect(confirm).toContainText('Les documents rattachés ne sont pas supprimés.');
    await confirm.getByRole('button', { name: 'Supprimer' }).click();
    await expect(antMessage(page, 'Espace supprimé')).toBeVisible();
    await expect(page).toHaveURL(/\/espaces$/);

    const gone = await api.raw.get(`/spaces/${spaceId}`);
    expect(gone.status()).toBe(404);
  });

  test('GED-13 erreurs de saisie : libellé vide refusé par l’écran, corps invalides refusés par l’API', async ({
    page,
    api,
    uniq,
  }) => {
    let posted = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/spaces' && r.method() === 'POST') posted += 1;
    });

    await page.goto('/espaces');
    await page.getByRole('button', { name: 'Nouvel espace' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel espace' });

    // Libellé absent, puis libellé fait d'espaces : la règle `required + whitespace` bloque l'envoi.
    await dialog.getByRole('button', { name: "Créer l'espace" }).click();
    await expect(dialog.getByText('Saisissez un libellé')).toBeVisible();
    await dialog.getByLabel('Libellé').fill('   ');
    await dialog.getByRole('button', { name: "Créer l'espace" }).click();
    await expect(dialog.getByText('Saisissez un libellé')).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(posted).toBe(0);

    // Annuler ferme sans rien créer.
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toBeHidden();
    expect(posted).toBe(0);

    // Règles du DTO (`createSpaceSchema`, zod strict) : 400 et rien n'est créé.
    const label = uniq('ged13');
    const invalid: Array<[string, unknown]> = [
      ['libellé vide', { label: '', kind: 1 }],
      ['libellé blanc', { label: '   ', kind: 1 }],
      ['libellé trop long', { label: 'x'.repeat(201), kind: 1 }],
      ['nature Publication interdite à la création', { label, kind: 3 }],
      ['nature inconnue', { label, kind: 7 }],
      ['nature absente', { label }],
      ['slug fourni à la création (champ inconnu)', { label, kind: 1, publicationSlug: 'mon-espace' }],
    ];
    for (const [why, body] of invalid) {
      const res = await api.raw.post('/spaces', body);
      expect(res.status(), why).toBe(400);
    }
    const mine = await api.get<Array<{ label: string }>>('/spaces');
    expect(mine.some((s) => s.label === label)).toBe(false);

    // Modification sans aucun champ : 400 « Aucune modification fournie ».
    const space = await createSpace(api, { label: `${label} ok` });
    const empty = await api.raw.patch(`/spaces/${space.gedSpaceId}`, {});
    expect(empty.status()).toBe(400);
    expect(JSON.stringify(await empty.json())).toContain('Aucune modification fournie');
  });
});
