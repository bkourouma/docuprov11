/**
 * Référentiel « Types de document » (`/admin/document-types`) : liste plate, libellé unique parmi
 * les actifs (index partiel `ux_document_type_label_active`, libellé BRUT), suppression = désactivation.
 */
import { test, expect } from '../../../fixtures';
import { SCREENS, createRef, dropCreated, openRef, listRef, refTextbox, type Created } from '../_helpers/referentiels';
import { UNKNOWN_ID, confirmPopover, editInline, revealRow, rx, waitApi } from '../_helpers/securite';

const S = SCREENS.documentTypes;
const DUP = 'Un type de document actif porte déjà ce libellé';
type Row = { documentTypeId: number; label: string };

const created: Created[] = [];
test.afterEach(async ({ api }) => dropCreated(api, created));

test('SOC-62 créer, renommer en ligne puis supprimer un type de document', async ({ page, api, uniq }) => {
  const label = uniq('SOC62 type');
  const renamed = uniq('SOC62 renommé');
  await openRef(page, S);

  await refTextbox(page, 'Libellé').fill(label);
  const posted = waitApi(page, 'POST', '/referentials/document-types');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  const res = await posted;
  expect(res.status()).toBe(201);
  const { documentTypeId } = (await res.json()) as Row;
  created.push({ screen: S, id: documentTypeId });
  await expect(page.getByText('Type de document créé')).toBeVisible();
  await expect(refTextbox(page, 'Libellé')).toHaveValue('');

  let row = await revealRow(page, label);
  const patched = waitApi(page, 'PATCH', `/referentials/document-types/${documentTypeId}`);
  await editInline(row, label, renamed);
  expect((await patched).status()).toBe(200);
  await expect(page.getByText('Modifié')).toBeVisible();
  expect((await listRef<Row>(api, S)).find((r) => r.documentTypeId === documentTypeId)?.label).toBe(renamed);

  row = await revealRow(page, renamed);
  await row.getByRole('button', { name: 'Supprimer ce type de document' }).click();
  const deleted = waitApi(page, 'DELETE', `/referentials/document-types/${documentTypeId}`);
  await confirmPopover(page, 'Supprimer');
  expect((await deleted).status()).toBe(200);
  await expect(page.getByText('Type de document supprimé')).toBeVisible();
  await expect(page.getByRole('row', { name: rx(renamed) })).toHaveCount(0);
  expect((await listRef<Row>(api, S)).some((r) => r.documentTypeId === documentTypeId)).toBe(false);

  // Libellé libéré par la désactivation : réutilisable.
  const again = await createRef<Row>(api, created, S, { label: renamed });
  expect(again.documentTypeId).not.toBe(documentTypeId);
});

test('SOC-63 libellé requis, doublon refusé avec un message lisible, identifiant inconnu en 404', async ({
  page,
  api,
  uniq,
}) => {
  const a = await createRef<Row>(api, created, S, { label: uniq('SOC63 type A') });
  const b = await createRef<Row>(api, created, S, { label: uniq('SOC63 type B') });
  await openRef(page, S);

  // Requis : bouton inactif tant que le libellé est vide ou blanc.
  const add = page.getByRole('button', { name: 'Ajouter' });
  await expect(add).toBeDisabled();
  await refTextbox(page, 'Libellé').fill('   ');
  await expect(add).toBeDisabled();

  // Doublon à la création.
  await refTextbox(page, 'Libellé').fill(a.label);
  const posted = waitApi(page, 'POST', '/referentials/document-types');
  await add.click();
  expect((await posted).status()).toBe(409);
  await expect(page.getByText(DUP)).toBeVisible();
  // Le même message revient au renommage ci-dessous : attendre la fin de ce toast (3 s) pour que
  // la vérification suivante porte bien sur le NOUVEAU message, et sans ambiguïté stricte.
  await expect(page.getByText(DUP)).toHaveCount(0);

  // Doublon au renommage : message, valeur d'origine rétablie après rechargement.
  const row = await revealRow(page, b.label);
  const patched = waitApi(page, 'PATCH', `/referentials/document-types/${b.documentTypeId}`);
  await editInline(row, b.label, a.label);
  expect((await patched).status()).toBe(409);
  await expect(page.getByText(DUP)).toBeVisible();
  await revealRow(page, b.label);

  // Libellé vidé en ligne : champ requis, valeur restaurée sans appel.
  const rowB = await revealRow(page, b.label);
  await editInline(rowB, b.label, '');
  await expect(rowB.getByRole('button', { name: b.label, exact: true })).toBeVisible();

  // API : libellé blanc refusé (accepté avant le `trim()` du schéma), doublon, inconnus.
  expect((await api.raw.post('/referentials/document-types', { label: '   ' })).status()).toBe(400);
  expect((await api.raw.post('/referentials/document-types', {})).status()).toBe(400);
  const dup = await api.raw.post('/referentials/document-types', { label: a.label });
  expect(dup.status()).toBe(409);
  expect(((await dup.json()) as { message: string }).message).toBe(DUP);
  expect((await api.raw.patch(`/referentials/document-types/${UNKNOWN_ID}`, { label: uniq('x') })).status()).toBe(404);
  // Désactivation d'un identifiant inconnu : 404 (P2025 brut → 500 avant correctif).
  expect((await api.raw.del(`/referentials/document-types/${UNKNOWN_ID}`)).status()).toBe(404);
});
