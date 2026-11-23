/**
 * Contrôle d'accès des référentiels (`referentials.controller.ts`) : LECTURE partagée par tout
 * utilisateur authentifié (acquisition, recherche), ÉCRITURE réservée au menu de l'écran
 * (`@RequireMenu`) ou à l'administrateur ; géolocalisation : administrateur seul (menu masqué).
 */
import { test, expect } from '../../../fixtures';
import { MENU, createRestrictedUser } from '../_helpers/accounts';
import { SCREENS, createRef, dropCreated, type Created } from '../_helpers/referentiels';
import { ACCESS_DENIED_FIXME, ACCESS_DENIED_TEXT } from '../_helpers/securite';

const created: Created[] = [];
test.afterEach(async ({ api }) => dropCreated(api, created));

test('SOC-69 utilisateur restreint aux dossiers : lit et exporte tout, n’écrit que les dossiers', async ({
  api,
  apiAs,
  uniq,
}) => {
  const restricted = await createRestrictedUser(api, uniq, [MENU.dossiers]);
  const as = await apiAs(restricted.username, restricted.password);

  // Cibles existantes pour PATCH / DELETE.
  const targets = {
    documentTypes: await createRef<{ documentTypeId: number }>(api, created, SCREENS.documentTypes, { label: uniq('SOC69 type') }),
    plans: await createRef<{ planId: number }>(api, created, SCREENS.plans, { label: uniq('SOC69 plan') }),
    locations: await createRef<{ locationId: number }>(api, created, SCREENS.locations, { label: uniq('SOC69 lieu'), code: uniq('L69') }),
  };

  for (const screen of Object.values(SCREENS)) {
    const r = screen.resource;
    expect((await as.raw.get(`/referentials/${r}`)).status(), `GET ${r}`).toBe(200);
    expect((await as.raw.get(`/referentials/${r}/export?format=xlsx`)).status(), `export ${r}`).toBe(200);
  }
  for (const path of ['/referentials/confidentialites', '/referentials/permission-levels', '/referentials/file-types']) {
    expect((await as.raw.get(path)).status(), `GET ${path}`).toBe(200);
  }

  const denied: Array<[string, () => Promise<{ status(): number }>]> = [
    ['POST document-types', () => as.raw.post('/referentials/document-types', { label: uniq('SOC69 intrus') })],
    ['PATCH document-types', () => as.raw.patch(`/referentials/document-types/${targets.documentTypes.documentTypeId}`, { label: uniq('x') })],
    ['DELETE document-types', () => as.raw.del(`/referentials/document-types/${targets.documentTypes.documentTypeId}`)],
    ['POST plans', () => as.raw.post('/referentials/plans', { label: uniq('SOC69 intrus') })],
    ['PATCH plans', () => as.raw.patch(`/referentials/plans/${targets.plans.planId}`, { label: uniq('x') })],
    ['DELETE plans', () => as.raw.del(`/referentials/plans/${targets.plans.planId}`)],
    ['POST locations', () => as.raw.post('/referentials/locations', { label: uniq('SOC69 intrus'), code: 'X' })],
    ['PATCH locations', () => as.raw.patch(`/referentials/locations/${targets.locations.locationId}`, { code: uniq('x') })],
    ['DELETE locations', () => as.raw.del(`/referentials/locations/${targets.locations.locationId}`)],
    ['POST file-types (admin seul)', () => as.raw.post('/referentials/file-types', { extension: uniq('e69'), friendlyName: 'x' })],
  ];
  for (const [name, call] of denied) expect((await call()).status(), name).toBe(403);

  // Les cibles n'ont pas bougé.
  const types: Array<{ documentTypeId: number }> = await api.get('/referentials/document-types');
  expect(types.some((t) => t.documentTypeId === targets.documentTypes.documentTypeId)).toBe(true);

  // Menu accordé : écriture des dossiers permise de bout en bout.
  const posted = await as.raw.post('/referentials/dossiers', { label: uniq('SOC69 dossier'), code: uniq('D69') });
  expect(posted.status()).toBe(201);
  const { dossierId } = (await posted.json()) as { dossierId: number };
  created.push({ screen: SCREENS.dossiers, id: dossierId });
  expect((await as.raw.patch(`/referentials/dossiers/${dossierId}`, { code: uniq('D69b') })).status()).toBe(200);
  expect((await as.raw.del(`/referentials/dossiers/${dossierId}`)).status()).toBe(200);
});

test.describe('SOC-69 interface pour un utilisateur restreint aux dossiers', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('SOC-69 barre latérale : « Dossiers » proposé, « Types de document » absent', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const restricted = await createRestrictedUser(api, uniq, [MENU.dossiers]);
    await loginAs(page, restricted.username, restricted.password);

    const section = page.getByRole('menuitem', { name: 'Paramétrage Archives', exact: true });
    await section.click();
    await expect(section).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Dossiers', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Types de document', exact: true })).toHaveCount(0);
  });

  // L'écriture est refusée par l'API (403, premier test). L'écran ouvert par son adresse ne doit
  // même pas s'ouvrir sans le menu : décision utilisateur, correctif dans `AuthShell`.
  test.fixme(`SOC-69 « Types de document » ouvert par URL sans le menu : « Accès refusé » dès l'ouverture (${ACCESS_DENIED_FIXME})`, async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const restricted = await createRestrictedUser(api, uniq, [MENU.dossiers]);
    await loginAs(page, restricted.username, restricted.password);
    await page.goto(SCREENS.documentTypes.page);
    await expect(page.getByText(ACCESS_DENIED_TEXT)).toBeVisible();
  });
});
