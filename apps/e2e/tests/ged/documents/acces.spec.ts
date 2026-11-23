/**
 * GED — droits d'accès à un document : onglets « Accès par utilisateur / par profil », refus d'un
 * utilisateur sans droit, niveau Consultation en lecture seule. Scénarios GED-27, GED-28, GED-29
 * (docs/e2e/scenarios-ged.md).
 *
 * Règles (docs/PLAN-IMPLEMENTATION-SECURITE-DOCUMENTAIRE.md §4, §8, §9) : un document dont aucun
 * droit explicite n'existe est ouvert à tous ; dès qu'un droit existe, seuls ses bénéficiaires, le
 * créateur et l'administrateur l'ouvrent. Refus d'ouverture => 404 « introuvable », jamais 403.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { createRestrictedUser } from '../_helpers/users';
import { validateDocument } from '../_helpers/archives';
import {
  PERMISSION_LEVEL,
  createActorUser,
  createPdfDocument,
  createVersion,
  grantDocumentPermission,
  minimalPdf,
  pdfFile,
  restrictDocument,
  versionContentPath,
  type GedDocsApi,
  type RawResponse,
} from '../_helpers/documents';

type PermissionRow = {
  documentPermissionId: number;
  scope: 'user' | 'group';
  userGroupId: number | null;
  label: string;
  permissionLevelName: string;
};

/** Sélecteur AntD (`Select`) repéré par son texte indicatif, puis option choisie par son titre. */
async function pickOption(page: Page, placeholder: string, option: string, search?: string) {
  await page.locator('.ant-select').filter({ hasText: placeholder }).click();
  if (search) await page.keyboard.type(search);
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    .getByTitle(option, { exact: true })
    .click();
}

test.describe('Droits d’accès à un document', () => {
  test('GED-27 accorder puis retirer un droit nominatif depuis l’onglet « Accès par utilisateur »', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-27 accès'));
    const actor = await createActorUser(api as GedDocsApi, apiAs, uniq('ged27'));

    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Accès par utilisateur', exact: true }).click();
    await expect(page.getByText('Aucun droit explicite')).toBeVisible();

    await pickOption(page, 'Utilisateur…', actor.fullName, actor.username);
    await pickOption(page, 'Niveau…', 'Consultation');
    // « Denied » n'est jamais proposé : l'absence de droit EST le refus.
    await page.locator('.ant-select').filter({ hasText: 'Consultation' }).click();
    await expect(
      page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByTitle('Denied'),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    const granted = page.waitForResponse(
      (r) => r.url().endsWith(`/documents/${doc.documentId}/permissions`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Accorder' }).click();
    expect((await granted).status()).toBe(201);
    await expect(page.locator('.ant-message')).toContainText('Droit accordé.');
    const row = page.getByRole('row').filter({ hasText: actor.fullName });
    await expect(row).toContainText('Consultation');
    await expect(row).toContainText('Sans limite');

    const rows = (await api.get(`/documents/${doc.documentId}/permissions`)) as PermissionRow[];
    expect(rows).toEqual([
      expect.objectContaining({
        scope: 'user',
        userGroupId: actor.userGroupId,
        permissionLevelName: 'Consultation',
      }),
    ]);

    // Effet réel : le bénéficiaire ouvre la fiche, au niveau Consultation.
    const actorApi = (await apiAs(actor.username, actor.password)) as GedDocsApi;
    const seen = (await actorApi.get(`/documents/${doc.documentId}`)) as { effectivePermissionLevel: number };
    expect(seen.effectivePermissionLevel).toBe(PERMISSION_LEVEL.CONSULTATION);

    // Retrait (bouton icône de la ligne, confirmation).
    await row.getByRole('button').click();
    const confirmTitle = page.getByText('Retirer ce droit ?');
    await expect(confirmTitle).toBeVisible();
    // L'infobulle « Retirer ce droit » de l'icône reste ouverte tant que le pointeur est sur
    // l'icône et RECOUVRE le bouton « Retirer » de la confirmation (AccessTab.tsx, fichier hors
    // lot) : comme un utilisateur, on quitte l'icône (survol de la confirmation) avant de cliquer.
    await confirmTitle.hover();
    await expect(page.locator('.ant-tooltip:not(.ant-tooltip-hidden)')).toHaveCount(0);
    const revoked = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && /\/documents\/\d+\/permissions\/\d+$/.test(new URL(r.url()).pathname),
    );
    await page
      .locator('.ant-popconfirm:not(.ant-popover-hidden)')
      .getByRole('button', { name: 'Retirer', exact: true })
      .click();
    expect((await revoked).status()).toBe(200);
    await expect(page.locator('.ant-message')).toContainText('Droit retiré.');
    await expect(page.getByText('Aucun droit explicite')).toBeVisible();
    expect(await api.get(`/documents/${doc.documentId}/permissions`)).toEqual([]);
  });

  test('GED-27 droits par profil et erreurs de saisie de l’octroi', async ({ page, api, apiAs, uniq }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-27 profil'));
    const actor = await createActorUser(api as GedDocsApi, apiAs, uniq('ged27p'));
    const path = `/documents/${doc.documentId}/permissions`;

    // Profil : idempotent (réaccorder le même niveau ne duplique pas la ligne).
    const first = (await api.post(path, {
      groupId: actor.groupId,
      permissionLevelId: PERMISSION_LEVEL.MODIFICATION,
    })) as { documentPermissionId: number };
    const second = (await api.post(path, {
      groupId: actor.groupId,
      permissionLevelId: PERMISSION_LEVEL.MODIFICATION,
    })) as { documentPermissionId: number };
    expect(second.documentPermissionId).toBe(first.documentPermissionId);

    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Accès par profil', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: `Profil ${actor.username}` })).toContainText(
      'Modification',
    );

    const cases: Array<[string, unknown, number, string | null]> = [
      ['Denied', { userGroupId: actor.userGroupId, permissionLevelId: 1 }, 400,
        'Le niveau « Denied » ne peut pas être accordé explicitement'],
      ['niveau inconnu', { userGroupId: actor.userGroupId, permissionLevelId: 99 }, 400, 'Niveau de permission inconnu'],
      ['acteur inconnu', { userGroupId: 999999999, permissionLevelId: 2 }, 400, 'Utilisateur introuvable'],
      ['profil inconnu', { groupId: 999999999, permissionLevelId: 2 }, 400, 'Profil introuvable'],
      ['deux bénéficiaires', { userGroupId: actor.userGroupId, groupId: actor.groupId, permissionLevelId: 2 }, 400, null],
      ['aucun bénéficiaire', { permissionLevelId: 2 }, 400, null],
      ['date mal formée', { userGroupId: actor.userGroupId, permissionLevelId: 2, startDate: '01/01/2030' }, 400, null],
    ];
    for (const [name, body, status, message] of cases) {
      const res = await api.raw.post(path, body);
      expect({ name, status: res.status() }).toEqual({ name, status });
      if (message) expect((await res.json()).message).toBe(message);
    }

    const revokeUnknown = await api.raw.del(`${path}/999999999`);
    expect(revokeUnknown.status()).toBe(404);
    expect((await revokeUnknown.json()).message).toBe('Droit introuvable');

    const onUnknownDoc = await api.raw.post('/documents/999999999/permissions', {
      userGroupId: actor.userGroupId,
      permissionLevelId: 2,
    });
    expect(onUnknownDoc.status()).toBe(404);

    // Aucun des refus n'a laissé de trace : seul le droit par profil subsiste.
    expect(((await api.get(path)) as PermissionRow[]).map((r) => r.scope)).toEqual(['group']);
  });

  test('GED-28 utilisateur sans droit sur un document restreint : 404 partout, écran propre', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-28 restreint'));
    await restrictDocument(api, doc.documentId);
    const outsider = await createActorUser(api as GedDocsApi, apiAs, uniq('ged28'));
    const outsiderApi = (await apiAs(outsider.username, outsider.password)) as GedDocsApi;

    const id = doc.documentId;
    // Lectures : la fiche, ses versions, ses binaires ET ses onglets annexes (ANO-GED-T1-1, corrigée :
    // avant le correctif, permissions / historique / cachet / confidentialité répondaient 200).
    for (const p of [
      `/documents/${id}`,
      `/documents/${id}/versions`,
      versionContentPath(id, doc.versionId, doc.fileId),
      `/documents/${id}/files/${doc.fileId}/content`,
      `/documents/${id}/permissions`,
      `/documents/${id}/history`,
      `/documents/${id}/seal`,
      `/documents/${id}/integrity`,
      `/documents/${id}/confidentialite`,
      `/documents/${id}/life-cycle`,
      `/documents/${id}/lendings`,
      `/documents/${id}/scanning`,
    ]) {
      const res = await outsiderApi.raw.get(p);
      expect({ p, status: res.status() }).toEqual({ p, status: 404 });
    }

    // Écritures : s'octroyer un droit, déclassifier, sceller, déposer une version => 404, sans effet.
    const selfGrant = await outsiderApi.raw.post(`/documents/${id}/permissions`, {
      userGroupId: outsider.userGroupId,
      permissionLevelId: PERMISSION_LEVEL.ARCHIVISTIQUE,
    });
    expect(selfGrant.status()).toBe(404);
    const declassify = await outsiderApi.raw.put(`/documents/${id}/confidentialite`, { confidentialiteId: null });
    expect(declassify.status()).toBe(404);
    const seal = await outsiderApi.raw.post(`/documents/${id}/seal`);
    expect(seal.status()).toBe(404);
    const upload = await outsiderApi.raw.upload(`/documents/${id}/versions`, {
      field: 'file',
      file: pdfFile('intrus.pdf', minimalPdf('intrus')),
    });
    expect(upload.status()).toBe(404);

    const perms = (await api.get(`/documents/${id}/permissions`)) as PermissionRow[];
    expect(perms.some((r) => r.userGroupId === outsider.userGroupId)).toBe(false);
    expect((await api.get(`/documents/${id}/seal`)) as { sealed: boolean }).toEqual({ sealed: false });

    // La recherche ne le liste pas non plus (même règle que la fiche) ; témoin : l'admin le trouve.
    // La recherche documentaire ne porte que sur l'archive : le document est d'abord validé.
    await validateDocument(api, id);
    const search = { fullText: doc.label, pageSize: 50 };
    const ids = (r: unknown) => ((r as { rows: Array<{ documentId: number }> }).rows ?? []).map((x) => x.documentId);
    expect(ids(await api.post('/documents/search', search))).toContain(id);
    expect(ids(await outsiderApi.post('/documents/search', search))).not.toContain(id);

    // Écran : sortie « Document introuvable », sans plantage ni erreur JavaScript.
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    await loginAs(page, outsider.username, outsider.password);
    await page.goto(`/documents/${id}`);
    await expect(page.getByRole('heading', { name: 'Document introuvable' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Versions', exact: true })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test('GED-28 un document sans aucun droit explicite reste ouvert à tout utilisateur authentifié', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-28 ouvert'));
    const user = await createRestrictedUser(api, apiAs, uniq('ged28o'));
    const userApi = (await apiAs(user.username, user.password)) as GedDocsApi;
    const seen = (await userApi.get(`/documents/${doc.documentId}`)) as { effectivePermissionLevel: number };
    expect(seen.effectivePermissionLevel).toBe(PERMISSION_LEVEL.CONSULTATION);
    expect(await userApi.get(`/documents/${doc.documentId}/permissions`)).toEqual([]);
  });

  test('GED-29 niveau Consultation : fiche en lecture seule, écritures refusées en 403 par l’API', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const docsApi = api as GedDocsApi;
    const doc = await createPdfDocument(docsApi, uniq('GED-29 lecture'));
    await createVersion(docsApi, doc.documentId); // v1 devient restaurable… pour qui en a le droit
    const reader = await createActorUser(docsApi, apiAs, uniq('ged29'));
    await grantDocumentPermission(api, doc.documentId, {
      userGroupId: reader.userGroupId,
      permissionLevelId: PERMISSION_LEVEL.CONSULTATION,
    });
    const readerApi = (await apiAs(reader.username, reader.password)) as GedDocsApi;
    const id = doc.documentId;

    // API : lectures permises, écritures refusées (403 : le document est visible, le niveau manque).
    expect(((await readerApi.raw.get(`/documents/${id}/versions`)).status())).toBe(200);
    expect(((await readerApi.raw.get(`/documents/${id}/seal`)).status())).toBe(200);
    const refusals: Array<[string, () => Promise<RawResponse>, string]> = [
      ['restaurer', () => readerApi.raw.post(`/documents/${id}/versions/${doc.versionId}/restore`, {}),
        'Modification non autorisée sur ce document'],
      ['sceller', () => readerApi.raw.post(`/documents/${id}/seal`), 'Niveau Archivistique requis pour sceller ce document'],
      ['vérifier', () => readerApi.raw.post(`/documents/${id}/integrity/verify`),
        'Niveau Modification requis pour vérifier l’intégrité de ce document'],
      ['cycle de vie', () => readerApi.raw.put(`/documents/${id}/life-cycle`, {
        usefulnessLifespan: '2030-01-01', complianceLifespan: '2035-01-01' }),
        'Niveau Archivistique requis pour le cycle de vie de ce document'],
      ['indexer', () => readerApi.raw.patch(`/documents/${id}/indexation`, { label: 'pirate' }),
        'Modification non autorisée sur ce document'],
    ];
    for (const [name, call, message] of refusals) {
      const res = await call();
      expect({ name, status: res.status() }).toEqual({ name, status: 403 });
      expect((await res.json()).message).toBe(message);
    }
    const upload = await readerApi.raw.upload(`/documents/${id}/versions`, {
      field: 'file',
      file: pdfFile('lecteur.pdf', minimalPdf('lecteur')),
    });
    expect(upload.status()).toBe(403);

    // Écran : badge de droits, onglet Indexation absent, actions remplacées par leur raison.
    await loginAs(page, reader.username, reader.password);
    await page.goto(`/documents/${id}`);
    await expect(page.getByText('Vos droits : Consultation')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Indexation', exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Versions', exact: true }).click();
    await expect(page.getByText('Version 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nouvelle version' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Restaurer la version 1' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Sécurité et conformité', exact: true }).click();
    await expect(page.getByText('Niveau Modification requis pour lancer une vérification')).toBeVisible();
    await expect(page.getByText('Niveau Archivistique requis pour apposer un cachet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Vérifier maintenant' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Accès par utilisateur', exact: true }).click();
    await expect(page.getByRole('row').filter({ hasText: reader.fullName })).toContainText('Consultation');
    await expect(page.getByRole('button', { name: 'Accorder' })).toHaveCount(0);
  });

  test('GED-29 quiconque ouvre la fiche gère ses droits et sa confidentialité (règle confirmée)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // Décision de l'utilisateur (2026-11-22, Q2) : gère les droits et la confidentialité d'un
    // document quiconque peut ouvrir sa fiche (documents.controller.ts, décision du 2026-08-05),
    // y compris au niveau Consultation. Seule l'ouverture de la fiche est exigée (GED-28 : 404 sinon).
    const doc = await createPdfDocument(api, uniq('GED-29 gestion'));
    const reader = await createActorUser(api, apiAs, uniq('ged29e'));
    const other = await createActorUser(api, apiAs, uniq('ged29o'));
    await grantDocumentPermission(api, doc.documentId, {
      userGroupId: reader.userGroupId,
      permissionLevelId: PERMISSION_LEVEL.CONSULTATION,
    });
    const readerApi = await apiAs(reader.username, reader.password);
    const path = `/documents/${doc.documentId}/permissions`;

    // Le lecteur accorde un droit à un tiers, puis le retire.
    const granted = await readerApi.raw.post(path, {
      userGroupId: other.userGroupId,
      permissionLevelId: PERMISSION_LEVEL.CONSULTATION,
    });
    expect(granted.status()).toBe(201);
    const grantedId = ((await granted.json()) as { documentPermissionId: number }).documentPermissionId;
    let rows = (await api.get(path)) as PermissionRow[];
    expect(rows.some((r) => r.userGroupId === other.userGroupId)).toBe(true);
    const revoked = await readerApi.raw.del(`${path}/${grantedId}`);
    expect(revoked.status()).toBe(200);
    rows = (await api.get(path)) as PermissionRow[];
    expect(rows.some((r) => r.userGroupId === other.userGroupId)).toBe(false);

    // Il peut aussi relever son propre niveau : la règle ne pose aucun plafond.
    const raised = await readerApi.raw.post(path, {
      userGroupId: reader.userGroupId,
      permissionLevelId: PERMISSION_LEVEL.ARCHIVISTIQUE,
    });
    expect(raised.status()).toBe(201);
    rows = (await api.get(path)) as PermissionRow[];
    expect(
      rows.some((r) => r.userGroupId === reader.userGroupId && r.permissionLevelName === 'Archivistique'),
    ).toBe(true);

    // Confidentialité : modifiable par le même lecteur (déclassement explicite accepté).
    const declassify = await readerApi.raw.put(`/documents/${doc.documentId}/confidentialite`, {
      confidentialiteId: null,
    });
    expect(declassify.status()).toBe(200);
  });
});
