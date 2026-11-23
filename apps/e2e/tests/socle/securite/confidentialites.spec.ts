/**
 * Sécurité Documentaire — écran « Confidentialités » (`/admin/securite/confidentialites`).
 * Référentiel ORDONNÉ : libellé saisi, rang auto (`max + 10`), désactivation douce.
 * Garde d'écriture : menu `/admin/securite/confidentialites` (ou admin) ; lecture partagée.
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser, createUser } from '../_helpers/accounts';
import {
  ACCESS_DENIED_FIXME,
  ACCESS_DENIED_TEXT,
  SECURITY_MENU,
  UNKNOWN_ID,
  confirmPopover,
  createConfidentialite,
  dropConfidentialite,
  editInline,
  findUser,
  listConfidentialites,
  revealRow,
  rx,
  waitApi,
} from '../_helpers/securite';

// Les créations calculent `max(rang) + 10` sans verrou : deux créations simultanées se disputent
// le même rang (409 depuis le correctif, 500 avant). Ce fichier tourne donc en séquence, dans un
// seul worker, sans que l'échec d'un test n'annule les suivants.
test.describe.configure({ mode: 'default' });

const PAGE = '/admin/securite/confidentialites';
const DUP_MESSAGE = 'Un niveau de confidentialité actif porte déjà ce libellé';

let created: number[] = [];
test.afterEach(async ({ api }) => {
  for (const id of created) await dropConfidentialite(api, id);
  created = [];
});

async function openPage(page: import('@playwright/test').Page) {
  const listed = waitApi(page, 'GET', '/referentials/confidentialites');
  await page.goto(PAGE);
  expect((await listed).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Confidentialités' }).first()).toBeVisible();
}

test('SOC-40 créer un niveau depuis l’écran : rang automatique au-dessus des niveaux actifs', async ({
  page,
  api,
  uniq,
}) => {
  const label = uniq('SOC40 niveau');
  const before = await listConfidentialites(api);
  await openPage(page);

  await page.getByLabel('Libellé').fill(label);
  const posted = waitApi(page, 'POST', '/referentials/confidentialites');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  const res = await posted;
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { confidentialiteId: number; rank: number; label: string };
  created.push(body.confidentialiteId);

  await expect(page.getByText('Élément créé')).toBeVisible();
  const row = await revealRow(page, label);
  await expect(row).toContainText(String(body.rank));
  // Rang auto : multiple de 10, strictement au-dessus de tout niveau actif lu avant la création.
  expect(body.rank % 10).toBe(0);
  for (const r of before) expect(body.rank).toBeGreaterThan(r.rank);
  // Le champ est vidé après création.
  await expect(page.getByLabel('Libellé')).toHaveValue('');

  const after = await listConfidentialites(api);
  expect(after.find((r) => r.confidentialiteId === body.confidentialiteId)).toMatchObject({
    label,
    rank: body.rank,
  });
});

test('SOC-41 libellé vide refusé ; le rang n’est pas saisissable', async ({ page, api, uniq }) => {
  await openPage(page);
  const add = page.getByRole('button', { name: 'Ajouter' });
  await expect(add).toBeDisabled();
  await page.getByLabel('Libellé').fill('   ');
  await expect(add).toBeDisabled();

  expect((await api.raw.post('/referentials/confidentialites', { label: '   ' })).status()).toBe(400);
  expect((await api.raw.post('/referentials/confidentialites', {})).status()).toBe(400);

  // Un `rank` fourni est ignoré (schéma strict sur le libellé) : le rang reste automatique.
  const label = uniq('SOC41 niveau');
  const res = await api.raw.post('/referentials/confidentialites', { label, rank: 5 });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { confidentialiteId: number; rank: number };
  created.push(body.confidentialiteId);
  expect(body.rank).not.toBe(5);
  expect(body.rank % 10).toBe(0);
});

test('SOC-42 doublon de libellé (à la casse et aux espaces près) : 409 lisible, jamais 500', async ({
  page,
  api,
  uniq,
}) => {
  const label = uniq('SOC42 niveau');
  const existing = await createConfidentialite(api, label);
  created.push(existing.confidentialiteId);

  await openPage(page);
  await page.getByLabel('Libellé').fill(label);
  const posted = waitApi(page, 'POST', '/referentials/confidentialites');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  expect((await posted).status()).toBe(409);
  await expect(page.getByText(DUP_MESSAGE)).toBeVisible();

  // L'index SQL compare `lower(replace(label, ' ', ''))` : ces variantes rendaient un 500
  // (anomalie corrigée dans ReferentialsService.assertConfidentialiteLabelFree).
  for (const variant of [label.toUpperCase(), label.toLowerCase(), label.replace(/ /g, '')]) {
    const res = await api.raw.post('/referentials/confidentialites', { label: variant });
    expect(res.status(), `variante « ${variant} »`).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe(DUP_MESSAGE);
  }

  // Un libellé libéré par désactivation est réutilisable (unicité parmi les ACTIFS).
  await api.del(`/referentials/confidentialites/${existing.confidentialiteId}`);
  const again = await api.raw.post('/referentials/confidentialites', { label });
  expect(again.status()).toBe(201);
  created.push(((await again.json()) as { confidentialiteId: number }).confidentialiteId);
});

test('SOC-43 modifier le libellé en ligne : rang inchangé, doublon refusé', async ({ page, api, uniq }) => {
  const a = await createConfidentialite(api, uniq('SOC43 niveau A'));
  const b = await createConfidentialite(api, uniq('SOC43 niveau B'));
  created.push(a.confidentialiteId, b.confidentialiteId);
  const renamed = uniq('SOC43 renommé');

  await openPage(page);
  let row = await revealRow(page, a.label);
  const patched = waitApi(page, 'PATCH', `/referentials/confidentialites/${a.confidentialiteId}`);
  await editInline(row, a.label, renamed);
  expect((await patched).status()).toBe(200);
  await expect(page.getByText('Modifié')).toBeVisible();
  await revealRow(page, renamed);

  let rows = await listConfidentialites(api);
  expect(rows.find((r) => r.confidentialiteId === a.confidentialiteId)).toMatchObject({
    label: renamed,
    rank: a.rank,
  });

  // Renommer en le libellé (casse modifiée) d'un AUTRE niveau : message, valeur rétablie.
  row = await revealRow(page, renamed);
  const refused = waitApi(page, 'PATCH', `/referentials/confidentialites/${a.confidentialiteId}`);
  await editInline(row, renamed, b.label.toUpperCase());
  expect((await refused).status()).toBe(409);
  await expect(page.getByText(DUP_MESSAGE)).toBeVisible();
  await revealRow(page, renamed);

  // API : le rang ne se modifie pas ; libellé vide et identifiant inconnu refusés proprement.
  await api.patch(`/referentials/confidentialites/${a.confidentialiteId}`, { label: renamed, rank: 999 });
  rows = await listConfidentialites(api);
  expect(rows.find((r) => r.confidentialiteId === a.confidentialiteId)?.rank).toBe(a.rank);
  expect(
    (await api.raw.patch(`/referentials/confidentialites/${a.confidentialiteId}`, { label: ' ' })).status(),
  ).toBe(400);
  expect(
    (await api.raw.patch(`/referentials/confidentialites/${UNKNOWN_ID}`, { label: uniq('x') })).status(),
  ).toBe(404);
});

test('SOC-44 désactiver un niveau : il disparaît des listes, les habilitations sont conservées', async ({
  page,
  api,
  uniq,
}) => {
  const level = await createConfidentialite(api, uniq('SOC44 niveau'));
  created.push(level.confidentialiteId);
  const holder = await createUser(api, { confidentialiteId: level.confidentialiteId });

  await openPage(page);
  const row = await revealRow(page, level.label);
  await row.getByRole('button', { name: 'Désactiver ce niveau de confidentialité' }).click();
  const deleted = waitApi(page, 'DELETE', `/referentials/confidentialites/${level.confidentialiteId}`);
  await confirmPopover(page, 'Désactiver');
  expect((await deleted).status()).toBe(200);
  await expect(page.getByText('Élément désactivé')).toBeVisible();
  await expect(page.getByRole('row', { name: rx(level.label) })).toHaveCount(0);

  const rows = await listConfidentialites(api);
  expect(rows.some((r) => r.confidentialiteId === level.confidentialiteId)).toBe(false);
  // Le compte qui portait le niveau le garde (désactivation ≠ suppression).
  expect((await findUser(api, holder.userId)).confidentialiteId).toBe(level.confidentialiteId);

  // Identifiant inconnu : 404 (P2025 brut → 500 avant correctif).
  expect((await api.raw.del(`/referentials/confidentialites/${UNKNOWN_ID}`)).status()).toBe(404);
});

test('SOC-45 sans le menu : lecture permise, toute écriture refusée en 403', async ({ api, apiAs, uniq }) => {
  const level = await createConfidentialite(api, uniq('SOC45 niveau'));
  created.push(level.confidentialiteId);
  const restricted = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
  const as = await apiAs(restricted.username, restricted.password);

  expect((await as.raw.get('/referentials/confidentialites')).status()).toBe(200);
  expect((await as.raw.post('/referentials/confidentialites', { label: uniq('SOC45 intrus') })).status()).toBe(403);
  expect(
    (await as.raw.patch(`/referentials/confidentialites/${level.confidentialiteId}`, { label: uniq('x') })).status(),
  ).toBe(403);
  expect((await as.raw.del(`/referentials/confidentialites/${level.confidentialiteId}`)).status()).toBe(403);

  const rows = await listConfidentialites(api);
  expect(rows.find((r) => r.confidentialiteId === level.confidentialiteId)?.label).toBe(level.label);
});

test('SOC-46 titulaire du seul menu « Confidentialités » : il administre ce référentiel, rien d’autre', async ({
  api,
  apiAs,
  uniq,
}) => {
  const holder = await createRestrictedUser(api, uniq, [SECURITY_MENU.confidentialites]);
  const as = await apiAs(holder.username, holder.password);

  const res = await as.raw.post('/referentials/confidentialites', { label: uniq('SOC46 niveau') });
  expect(res.status()).toBe(201);
  const level = (await res.json()) as { confidentialiteId: number };
  created.push(level.confidentialiteId);
  expect(
    (await as.raw.patch(`/referentials/confidentialites/${level.confidentialiteId}`, { label: uniq('SOC46 b') })).status(),
  ).toBe(200);
  expect((await as.raw.del(`/referentials/confidentialites/${level.confidentialiteId}`)).status()).toBe(200);

  // Le menu voisin « Confidentialité des utilisateurs » n'est pas inclus.
  expect(
    (await as.raw.patch('/users/confidentialite', { userIds: [holder.userId], confidentialiteId: null })).status(),
  ).toBe(403);
});

test.describe('SOC-45 interface pour un utilisateur sans le menu', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('SOC-45 menu absent de la barre latérale', async ({ page, api, loginAs, uniq }) => {
    const restricted = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
    await loginAs(page, restricted.username, restricted.password);

    // Témoin positif : la section du menu accordé (« Dossiers » vit sous « Paramétrage Archives »)
    // est rendue, celle de la sécurité ne l'est pas.
    await expect(page.getByRole('menuitem', { name: 'Paramétrage Archives', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /Sécurité Documentaire/ })).toHaveCount(0);
  });

  // L'écriture est refusée par l'API (403, test « SOC-45 sans le menu » ci-dessus). L'écran, lui,
  // ne doit même pas s'ouvrir sans le menu : décision utilisateur, correctif dans `AuthShell`.
  test.fixme(`SOC-45 écran ouvert par URL sans le menu : « Accès refusé » dès l'ouverture (${ACCESS_DENIED_FIXME})`, async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const restricted = await createRestrictedUser(api, uniq, ['/admin/dossiers']);
    await loginAs(page, restricted.username, restricted.password);
    await page.goto(PAGE);
    await expect(page.getByText(ACCESS_DENIED_TEXT)).toBeVisible();
  });
});
