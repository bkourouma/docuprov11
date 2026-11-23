/**
 * Référentiel « Gestion de la géolocalisation » (`/admin/geolocalisation`) : NOM et CODE requis,
 * parent facultatif, suppression en cascade. Écran MASQUÉ (`HIDDEN_MENU_KEYS`) : absent de la barre
 * latérale et non assignable à un rôle, donc administrable par les seuls administrateurs ; les
 * lectures restent ouvertes (filtres de recherche, exports, intercalaires).
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

const S = SCREENS.locations;
type Row = { locationId: number; parentId: number | null; label: string; code: string | null; depth: number };

const created: Created[] = [];
test.afterEach(async ({ api }) => dropCreated(api, created));

test('SOC-68 créer un site et un sous-emplacement, modifier le code, supprimer la branche', async ({
  page,
  api,
  uniq,
}) => {
  const rootLabel = uniq('SOC68 site');
  const childLabel = uniq('SOC68 magasin');
  const childCode = uniq('M68');
  await openRef(page, S);

  const add = page.getByRole('button', { name: 'Ajouter' });
  await refTextbox(page, "Nom de l'élément").fill(rootLabel);
  await expect(add).toBeDisabled(); // code requis
  await refTextbox(page, 'Code').fill(uniq('S68'));
  let posted = waitApi(page, 'POST', '/referentials/locations');
  await add.click();
  let res = await posted;
  expect(res.status()).toBe(201);
  const root = (await res.json()) as Row;
  created.push({ screen: S, id: root.locationId });
  await expect(page.getByText('Élément créé')).toBeVisible();

  await refTextbox(page, "Nom de l'élément").fill(childLabel);
  await refTextbox(page, 'Code').fill(childCode);
  await pickTreeNode(page, refParentField(page), rootLabel);
  posted = waitApi(page, 'POST', '/referentials/locations');
  await add.click();
  res = await posted;
  expect(res.status()).toBe(201);
  const child = (await res.json()) as Row;
  created.push({ screen: S, id: child.locationId });
  expect(child).toMatchObject({ parentId: root.locationId, depth: 1, code: childCode });

  await revealRow(page, rootLabel);
  const childRow = () => page.getByRole('row', { name: rx(childLabel) });
  const newCode = uniq('M68b');
  const patched = waitApi(page, 'PATCH', `/referentials/locations/${child.locationId}`);
  await editInline(childRow(), childCode, newCode);
  expect((await patched).status()).toBe(200);
  await expect(page.getByText('Modifié')).toBeVisible();
  // Code requis : le vider le restaure sans appel.
  await editInline(childRow(), newCode, '');
  await expect(childRow().getByRole('button', { name: newCode })).toBeVisible();
  expect((await listRef<Row>(api, S)).find((r) => r.locationId === child.locationId)?.code).toBe(newCode);

  const rootRow = await revealRow(page, rootLabel);
  await rootRow.getByRole('button', { name: 'Supprimer cet élément' }).click();
  const deleted = waitApi(page, 'DELETE', `/referentials/locations/${root.locationId}`);
  await confirmPopover(page, 'Supprimer');
  expect((await deleted).status()).toBe(200);
  await expect(page.getByText('Élément supprimé')).toBeVisible();
  await expect(childRow()).toHaveCount(0);
  const ids = (await listRef<Row>(api, S)).map((r) => r.locationId);
  expect(ids).not.toContain(root.locationId);
  expect(ids).not.toContain(child.locationId);
});

test('SOC-68 saisies invalides : 400/404, jamais 500 ; menu non assignable', async ({ api, uniq }) => {
  const off = await createRef<Row>(api, created, S, { label: uniq('SOC68 désactivé'), code: uniq('D68') });
  await api.del(`/referentials/locations/${off.locationId}`);

  const post = (body: unknown) => api.raw.post('/referentials/locations', body);
  expect((await post({ label: uniq('x') })).status(), 'code absent').toBe(400);
  expect((await post({ label: uniq('x'), code: '  ' })).status(), 'code blanc').toBe(400);
  expect((await post({ label: ' ', code: uniq('c') })).status(), 'nom blanc').toBe(400);
  expect((await post({ label: uniq('x'), code: uniq('c'), parentId: UNKNOWN_ID })).status()).toBe(400);
  expect((await post({ label: uniq('x'), code: uniq('c'), parentId: off.locationId })).status(), 'parent désactivé').toBe(400);

  const ok = await createRef<Row>(api, created, S, { label: uniq('SOC68 cible'), code: uniq('K68') });
  expect((await api.raw.patch(`/referentials/locations/${ok.locationId}`, {})).status()).toBe(400);
  expect((await api.raw.patch(`/referentials/locations/${ok.locationId}`, { code: '' })).status()).toBe(400);
  expect((await api.raw.patch(`/referentials/locations/${UNKNOWN_ID}`, { code: uniq('c') })).status()).toBe(404);
  expect((await api.raw.del(`/referentials/locations/${UNKNOWN_ID}`)).status()).toBe(404);

  // Écran masqué : sa clé ne figure pas au catalogue des menus assignables.
  const menus: Array<{ key: string }> = await api.get('/roles/menus');
  expect(menus.map((m) => m.key)).not.toContain(S.page);
});
