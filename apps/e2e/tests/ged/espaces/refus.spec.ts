/**
 * GED — refus d'accès aux espaces. Scénario GED-19 :
 *  - utilisateur SANS le menu « Espaces » : écran en échec explicite + API 403 sur toutes les routes ;
 *  - membre en LECTURE : voit l'espace, ne peut rien y modifier (écran et API) ;
 *  - NON-membre (avec le menu) : ne voit ni l'espace partagé ni l'espace privé d'autrui (404).
 */
import { test, expect } from '../../../fixtures';
import {
  SpaceKind,
  SpacePermission,
  addUserMember,
  createEditorDocument,
  createSpace,
  createSpaceUser,
  descriptionValue,
  publishSpace,
  toSlug,
  userPage,
} from '../_helpers/espaces';

const NO_SECTION = "Vous n'avez pas accès à cette section.";

test.describe('GED espaces — refus', () => {
  test('GED-19 sans le menu « Espaces » : écran refusé et API 403', async ({ browser, api, apiAs, loginAs, uniq }, testInfo) => {
    // Rôle portant un autre menu seulement : l'utilisateur est authentifié mais sans `/espaces`.
    const user = await createSpaceUser(api, apiAs, uniq('ged19-sans-menu'), ['/search']);
    const self = await apiAs(user.username, user.password);
    const space = await createSpace(api, { label: uniq('ged19-cible') });
    const slug = toSlug(uniq('ged19-pub'));
    await publishSpace(api, space.gedSpaceId, slug);

    // Le menu est la première barrière, avant toute règle d'espace — y compris la lecture par slug.
    const calls: Array<[string, () => Promise<{ status(): number }>]> = [
      ['GET /spaces', () => self.raw.get('/spaces')],
      ['POST /spaces', () => self.raw.post('/spaces', { label: 'interdit', kind: 1 })],
      ['GET /spaces/:id', () => self.raw.get(`/spaces/${space.gedSpaceId}`)],
      ['GET /spaces/published/:slug', () => self.raw.get(`/spaces/published/${slug}`)],
      ['GET /spaces/member-candidates', () => self.raw.get('/spaces/member-candidates')],
    ];
    for (const [what, call] of calls) {
      expect((await call()).status(), what).toBe(403);
    }

    const { context, page } = await userPage(browser, testInfo, loginAs, user);
    try {
      await page.goto('/espaces');
      await expect(page.locator('.ant-message').getByText(NO_SECTION)).toBeVisible();
      // Un refus n'est pas une liste vide (ANO-GED-T2-1, corrigé) : état d'échec, aucune invitation à créer.
      await expect(page.getByText("La liste des espaces n'a pas pu être chargée.")).toBeVisible();
      await expect(page.getByText("Aucun espace pour l'instant", { exact: false })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Nouvel espace' })).toHaveCount(0);

      await page.goto(`/espaces/${space.gedSpaceId}`);
      await expect(page.getByText('Cet espace est introuvable ou inaccessible.')).toBeVisible();
      await expect(page.locator('.ant-alert-error')).toContainText(NO_SECTION);
      await expect(page.getByRole('heading', { name: space.label })).toHaveCount(0);

      await page.goto(`/espaces/publie/${slug}`);
      await expect(page.getByText("Cet espace n'existe pas ou n'est plus publié.")).toBeVisible();
      await expect(page.getByRole('heading', { name: space.label })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('GED-19 membre en lecture : consulte l’espace sans pouvoir le modifier', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    const reader = await createSpaceUser(api, apiAs, uniq('ged19-lecteur'));
    const readerApi = await apiAs(reader.username, reader.password);
    const space = await createSpace(api, { label: uniq('ged19-lecture'), kind: SpaceKind.Collaboration });
    const docLabel = uniq('ged19-doc');
    const doc = await createEditorDocument(api, space.gedSpaceId, docLabel);
    await addUserMember(api, space.gedSpaceId, reader.userGroupId, SpacePermission.Lecture);

    // API : chaque écriture est refusée avec le droit manquant (403), la lecture passe.
    const detail = await readerApi.get<{ myAccess: unknown; canManage: boolean; canContribute: boolean; members: unknown[] }>(
      `/spaces/${space.gedSpaceId}`,
    );
    expect(detail).toMatchObject({ myAccess: SpacePermission.Lecture, canManage: false, canContribute: false, members: [] });
    const writes: Array<[string, () => Promise<{ status(): number; json(): Promise<unknown> }>, string]> = [
      ['PATCH espace', () => readerApi.raw.patch(`/spaces/${space.gedSpaceId}`, { label: 'x' }), 'Droit de gestion requis'],
      ['DELETE espace', () => readerApi.raw.del(`/spaces/${space.gedSpaceId}`), 'Seul le propriétaire'],
      ['GET membres', () => readerApi.raw.get(`/spaces/${space.gedSpaceId}/members`), 'Droit de gestion requis'],
      ['POST publish', () => readerApi.raw.post(`/spaces/${space.gedSpaceId}/publish`, {}), 'Droit de gestion requis'],
      [
        'DELETE document',
        () => readerApi.raw.del(`/spaces/${space.gedSpaceId}/documents/${doc.documentId}`),
        'Droit de contribution requis',
      ],
      [
        'POST document éditeur',
        () => readerApi.raw.post('/collab/documents', { spaceId: space.gedSpaceId, label: 'interdit' }),
        'Droit de contribution requis',
      ],
    ];
    for (const [what, call, msg] of writes) {
      const res = await call();
      expect(res.status(), what).toBe(403);
      expect(JSON.stringify(await res.json()), what).toContain(msg);
    }
    expect((await readerApi.get<Array<{ documentId: number }>>(`/spaces/${space.gedSpaceId}/documents`)).map((d) => d.documentId)).toEqual([
      doc.documentId,
    ]);

    const { context, page } = await userPage(browser, testInfo, loginAs, reader);
    try {
      await page.goto(`/espaces/${space.gedSpaceId}`);
      await expect(page.getByRole('heading', { name: space.label })).toBeVisible();
      await expect(descriptionValue(page, 'Mon droit')).toHaveText('Lecture');
      for (const name of ['Modifier', 'Publier', 'Dépublier', 'Supprimer', 'Nouveau document', 'Rattacher un document']) {
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
      await expect(page.getByRole('link', { name: docLabel })).toBeVisible();
      await expect(page.getByRole('button', { name: `Détacher ${docLabel}` })).toHaveCount(0);
      await page.getByRole('tab', { name: 'Membres' }).click();
      await expect(
        page.getByText('La liste des membres est réservée au propriétaire et aux membres en gestion.'),
      ).toBeVisible();

      // L'espace figure dans SA liste, avec son droit.
      await page.goto('/espaces');
      await expect(page.getByRole('row').filter({ hasText: space.label })).toContainText('Lecture');

      // Le formulaire « Nouveau document » ne propose pas l'espace en écriture.
      await page.goto(`/editeur/nouveau?spaceId=${space.gedSpaceId}`);
      await page.getByLabel('Espace', { exact: true }).click();
      await expect(
        page
          .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-disabled')
          .filter({ hasText: `${space.label} (lecture seule)` }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('GED-19 non-membre : l’espace partagé et l’espace privé d’autrui restent invisibles', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    const outsider = await createSpaceUser(api, apiAs, uniq('ged19-tiers'));
    const outsiderApi = await apiAs(outsider.username, outsider.password);
    const shared = await createSpace(api, { label: uniq('ged19-partage'), kind: SpaceKind.Partage });
    const priv = await createSpace(api, { label: uniq('ged19-prive'), kind: SpaceKind.Prive });

    const list = await outsiderApi.get<Array<{ gedSpaceId: number }>>('/spaces');
    expect(list.map((s) => s.gedSpaceId)).not.toContain(shared.gedSpaceId);
    expect(list.map((s) => s.gedSpaceId)).not.toContain(priv.gedSpaceId);
    for (const id of [shared.gedSpaceId, priv.gedSpaceId]) {
      for (const path of [`/spaces/${id}`, `/spaces/${id}/documents`]) {
        const res = await outsiderApi.raw.get(path);
        expect(res.status(), path).toBe(404);
        expect(JSON.stringify(await res.json())).toContain('Espace introuvable');
      }
      // Écrire sur un espace invisible : 404 aussi (son existence n'est pas révélée par un 403).
      expect((await outsiderApi.raw.patch(`/spaces/${id}`, { label: 'x' })).status()).toBe(404);
    }

    const { context, page } = await userPage(browser, testInfo, loginAs, outsider);
    try {
      await page.goto('/espaces');
      await expect(page.getByText(shared.label)).toHaveCount(0);
      await page.goto(`/espaces/${shared.gedSpaceId}`);
      await expect(page.getByText('Cet espace est introuvable ou inaccessible.')).toBeVisible();
      await expect(page.locator('.ant-alert-error')).toContainText('Espace introuvable');
      await expect(page.getByRole('heading', { name: shared.label })).toHaveCount(0);
    } finally {
      await context.close();
    }

    // L'administrateur non propriétaire ne voit pas non plus l'espace privé d'autrui.
    const hisPrivate = await createSpace(outsiderApi, { label: uniq('ged19-prive-tiers'), kind: SpaceKind.Prive });
    expect((await api.raw.get(`/spaces/${hisPrivate.gedSpaceId}`)).status()).toBe(404);
    // … mais lit son espace partagé, sans droit de gestion (lecture seule de supervision).
    const hisShared = await createSpace(outsiderApi, { label: uniq('ged19-partage-tiers'), kind: SpaceKind.Partage });
    const asAdmin = await api.get<{ myAccess: unknown; canManage: boolean }>(`/spaces/${hisShared.gedSpaceId}`);
    expect(asAdmin).toMatchObject({ myAccess: null, canManage: false });
    expect((await api.raw.patch(`/spaces/${hisShared.gedSpaceId}`, { label: 'x' })).status()).toBe(403);
  });
});
