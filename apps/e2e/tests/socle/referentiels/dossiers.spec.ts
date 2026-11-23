/**
 * Référentiel « Gestion des dossiers » (`/admin/dossiers`) : arborescence (chemin matérialisé),
 * nom ET code exigés par l'écran, libellé unique parmi les actifs (`ux_dossier_label_active`),
 * suppression = désactivation de toute la branche.
 */
import { test, expect } from '../../../fixtures';
import {
  SCREENS,
  createRef,
  dropCreated,
  listRef,
  openRef,
  refParentField,
  refTextbox,
  pickTreeNode,
  type Created,
} from '../_helpers/referentiels';
import { UNKNOWN_ID, confirmPopover, editInline, revealRow, rx, waitApi } from '../_helpers/securite';

const S = SCREENS.dossiers;
const DUP = 'Un dossier actif porte déjà ce libellé';
type Row = { dossierId: number; parentId: number | null; label: string; code: string | null; depth: number; path: string };

const created: Created[] = [];
test.afterEach(async ({ api }) => dropCreated(api, created));

async function addViaForm(page: import('@playwright/test').Page, label: string, code: string, parent?: string) {
  await refTextbox(page, "Nom de l'élément").fill(label);
  await refTextbox(page, 'Code').fill(code);
  if (parent) await pickTreeNode(page, refParentField(page), parent);
  const posted = waitApi(page, 'POST', '/referentials/dossiers');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  return posted;
}

test('SOC-65 créer un dossier racine puis un sous-dossier, modifier le code, supprimer la branche', async ({
  page,
  api,
  uniq,
}) => {
  const rootLabel = uniq('SOC65 racine');
  const childLabel = uniq('SOC65 sous-dossier');
  const childCode = uniq('C65');
  await openRef(page, S);

  const resRoot = await addViaForm(page, rootLabel, uniq('R65'));
  expect(resRoot.status()).toBe(201);
  const root = (await resRoot.json()) as Row;
  created.push({ screen: S, id: root.dossierId });
  await expect(page.getByText('Dossier créé')).toBeVisible();
  expect(root).toMatchObject({ parentId: null, depth: 0, path: `/${root.dossierId}/` });

  const resChild = await addViaForm(page, childLabel, childCode, rootLabel);
  expect(resChild.status()).toBe(201);
  const child = (await resChild.json()) as Row;
  created.push({ screen: S, id: child.dossierId });
  expect(child).toMatchObject({
    parentId: root.dossierId,
    depth: 1,
    path: `/${root.dossierId}/${child.dossierId}/`,
  });

  // Arbre déplié : le sous-dossier est rendu sous sa racine.
  await revealRow(page, rootLabel);
  const childRow = page.getByRole('row', { name: rx(childLabel) });
  await expect(childRow).toBeVisible();

  const newCode = uniq('C65b');
  const patched = waitApi(page, 'PATCH', `/referentials/dossiers/${child.dossierId}`);
  await editInline(childRow, childCode, newCode);
  expect((await patched).status()).toBe(200);
  await expect(page.getByText('Modifié')).toBeVisible();
  expect((await listRef<Row>(api, S)).find((r) => r.dossierId === child.dossierId)?.code).toBe(newCode);

  // Code vidé en ligne : champ requis à l'écran, valeur restaurée.
  await editInline(page.getByRole('row', { name: rx(childLabel) }), newCode, '');
  await expect(page.getByRole('row', { name: rx(childLabel) }).getByRole('button', { name: newCode })).toBeVisible();

  const rootRow = await revealRow(page, rootLabel);
  await rootRow.getByRole('button', { name: 'Supprimer ce dossier' }).click();
  const deleted = waitApi(page, 'DELETE', `/referentials/dossiers/${root.dossierId}`);
  await confirmPopover(page, 'Supprimer');
  expect((await deleted).status()).toBe(200);
  await expect(page.getByText('Dossier supprimé')).toBeVisible();
  await expect(page.getByRole('row', { name: rx(childLabel) })).toHaveCount(0);

  const ids = (await listRef<Row>(api, S)).map((r) => r.dossierId);
  expect(ids).not.toContain(root.dossierId);
  expect(ids).not.toContain(child.dossierId); // cascade sur la branche
});

test('SOC-66 saisies invalides et doublons : messages lisibles, 4xx, jamais 500', async ({ page, api, uniq }) => {
  const a = await createRef<Row>(api, created, S, { label: uniq('SOC66 A'), code: uniq('A66') });
  const b = await createRef<Row>(api, created, S, { label: uniq('SOC66 B'), code: uniq('B66'), parentId: a.dossierId });
  const off = await createRef<Row>(api, created, S, { label: uniq('SOC66 désactivé'), code: uniq('D66') });
  await api.del(`/referentials/dossiers/${off.dossierId}`);

  await openRef(page, S);
  const add = page.getByRole('button', { name: 'Ajouter' });
  await refTextbox(page, "Nom de l'élément").fill(uniq('SOC66 sans code'));
  await expect(add).toBeDisabled(); // le code est exigé par l'écran

  const dup = await addViaForm(page, a.label, uniq('X66'));
  expect(dup.status()).toBe(409);
  await expect(page.getByText(DUP)).toBeVisible();
  // Le même message revient au renommage ci-dessous : attendre la fin de ce toast (3 s) pour que
  // la vérification suivante porte bien sur le NOUVEAU message, et sans ambiguïté stricte.
  await expect(page.getByText(DUP)).toHaveCount(0);

  // Renommage en doublon : message, valeur rétablie.
  const rowB = await revealRow(page, b.label);
  const patched = waitApi(page, 'PATCH', `/referentials/dossiers/${b.dossierId}`);
  await editInline(rowB, b.label, a.label);
  expect((await patched).status()).toBe(409);
  await expect(page.getByText(DUP)).toBeVisible();
  await revealRow(page, b.label);

  const post = (body: unknown) => api.raw.post('/referentials/dossiers', body);
  expect((await post({ label: '   ' })).status(), 'libellé blanc').toBe(400);
  const unknownParent = await post({ label: uniq('SOC66 orphelin'), parentId: UNKNOWN_ID });
  expect(unknownParent.status()).toBe(400);
  expect(((await unknownParent.json()) as { message: string }).message).toBe('Élément parent introuvable');
  // Parent désactivé : refusé (accepté avant correctif → enfant affiché en racine orpheline).
  expect((await post({ label: uniq('SOC66 sous désactivé'), parentId: off.dossierId })).status()).toBe(400);

  const patch = (id: number, body: unknown) => api.raw.patch(`/referentials/dossiers/${id}`, body);
  expect((await patch(b.dossierId, {})).status(), 'aucun champ').toBe(400);
  expect((await patch(b.dossierId, { code: '' })).status(), 'code vide').toBe(400);
  expect((await patch(UNKNOWN_ID, { label: uniq('x') })).status()).toBe(404);
  expect((await api.raw.del(`/referentials/dossiers/${UNKNOWN_ID}`)).status()).toBe(404);

  // Déplacement : cyclique refusé, parent désactivé refusé, déplacement valide recalcule le chemin.
  const move = (id: number, parentId: number | null) => api.raw.patch(`/referentials/dossiers/${id}/parent`, { parentId });
  const cyclic = await move(a.dossierId, b.dossierId);
  expect(cyclic.status()).toBe(400);
  expect(((await cyclic.json()) as { message: string }).message).toBe('Déplacement cyclique interdit');
  expect((await move(b.dossierId, off.dossierId)).status()).toBe(400);
  expect((await move(b.dossierId, null)).status()).toBe(200);
  expect((await listRef<Row>(api, S)).find((r) => r.dossierId === b.dossierId)).toMatchObject({
    parentId: null,
    depth: 0,
    path: `/${b.dossierId}/`,
  });
});
