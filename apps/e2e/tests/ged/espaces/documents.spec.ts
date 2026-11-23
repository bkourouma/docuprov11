/**
 * GED — documents d'un espace (onglet « Documents », modale « Rattacher un document »,
 * `SpaceDocumentsTable`). Scénario GED-15 : rattacher puis détacher, le document restant intact.
 */
import { test, expect } from '../../../fixtures';
import {
  SpaceKind,
  antMessage,
  archiveDocument,
  createEditorDocument,
  createSpace,
  popconfirmButton,
  type SpaceDetail,
  type SpaceDocumentRow,
} from '../_helpers/espaces';

test.describe('GED espaces — documents', () => {
  test('GED-15 rattacher un document à un espace puis le détacher', async ({ page, api, uniq }) => {
    // Document source : créé par l'éditeur dans un premier espace, puis VALIDÉ (archivé), car la
    // modale de rattachement cherche par `POST /documents/search`, qui ne porte que sur l'archive
    // (cf. ANO-GED-T2-2 : un document de l'éditeur non validé n'y est jamais proposé).
    const source = await createSpace(api, { label: uniq('ged15-source'), kind: SpaceKind.Partage });
    const docLabel = uniq('ged15-doc');
    const doc = await createEditorDocument(api, source.gedSpaceId, docLabel);
    await archiveDocument(api, doc.documentId);

    const target = await createSpace(api, { label: uniq('ged15-cible'), kind: SpaceKind.Collaboration });
    await page.goto(`/espaces/${target.gedSpaceId}`);
    await expect(page.getByRole('tab', { name: 'Documents (0)' })).toBeVisible();
    await expect(page.getByText('Aucun document dans cet espace.')).toBeVisible();

    await page.getByRole('button', { name: 'Rattacher un document' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rattacher un document' });
    await expect(dialog.getByRole('button', { name: 'Rattacher' })).toBeDisabled();

    const searched = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/documents/search' && r.request().method() === 'POST',
    );
    const picker = dialog.getByLabel('Rechercher un document par son libellé');
    await picker.click();
    await picker.fill(docLabel);
    expect((await searched).ok()).toBe(true);
    const option = page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
      .filter({ hasText: docLabel });
    await expect(option).toBeVisible();
    await option.click();
    await dialog.getByRole('button', { name: 'Rattacher' }).click();

    await expect(antMessage(page, 'Document rattaché')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Documents (1)' })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: docLabel });
    await expect(row.getByRole('link', { name: docLabel })).toHaveAttribute('href', `/documents/${doc.documentId}`);

    let docs = await api.get<SpaceDocumentRow[]>(`/spaces/${target.gedSpaceId}/documents`);
    expect(docs.map((d) => d.documentId)).toEqual([doc.documentId]);
    expect((await api.get<SpaceDetail>(`/spaces/${target.gedSpaceId}`)).documentCount).toBe(1);

    // Un second rattachement du même document est refusé (409).
    const again = await api.raw.post(`/spaces/${target.gedSpaceId}/documents`, { documentId: doc.documentId });
    expect(again.status()).toBe(409);
    // Document inexistant : 404 sans révéler quoi que ce soit.
    const missing = await api.raw.post(`/spaces/${target.gedSpaceId}/documents`, { documentId: 2147483000 });
    expect(missing.status()).toBe(404);

    // Détacher, avec confirmation : le document quitte l'espace mais n'est pas supprimé.
    await row.getByRole('button', { name: `Détacher ${docLabel}` }).click();
    await popconfirmButton(page, 'Détacher').click();
    await expect(antMessage(page, 'Document détaché')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Documents (0)' })).toBeVisible();
    await expect(page.getByText('Aucun document dans cet espace.')).toBeVisible();

    docs = await api.get<SpaceDocumentRow[]>(`/spaces/${target.gedSpaceId}/documents`);
    expect(docs).toEqual([]);
    expect((await api.raw.get(`/documents/${doc.documentId}`)).status()).toBe(200);
    const stillInSource = await api.get<SpaceDocumentRow[]>(`/spaces/${source.gedSpaceId}/documents`);
    expect(stillInSource.map((d) => d.documentId)).toContain(doc.documentId);
  });

  test('GED-15 seuls les documents archivés se rattachent : un document non validé est refusé', async ({
    page,
    api,
    uniq,
  }) => {
    // Règle confirmée par l'utilisateur (2026-11-22, Q4). ANO-GED-12 : l'API acceptait le
    // rattachement d'un document non archivé (corrigé dans SpacesService.attachDocument : 409).
    const source = await createSpace(api, { label: uniq('ged15b-source') });
    const docLabel = uniq('ged15b-doc');
    const doc = await createEditorDocument(api, source.gedSpaceId, docLabel);
    const target = await createSpace(api, { label: uniq('ged15b-cible') });

    // API : 409 explicite, rien n'est rattaché.
    const refused = await api.raw.post(`/spaces/${target.gedSpaceId}/documents`, { documentId: doc.documentId });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).message).toBe(
      'Seuls les documents archivés (validés) peuvent être rattachés à un espace',
    );
    expect(await api.get<SpaceDocumentRow[]>(`/spaces/${target.gedSpaceId}/documents`)).toEqual([]);

    // Écran : la recherche de la modale ne le propose pas (elle ne porte que sur l'archive).
    await page.goto(`/espaces/${target.gedSpaceId}`);
    await page.getByRole('button', { name: 'Rattacher un document' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rattacher un document' });
    const searched = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/documents/search' && r.request().method() === 'POST',
    );
    const picker = dialog.getByLabel('Rechercher un document par son libellé');
    await picker.click();
    await picker.fill(docLabel);
    const res = await searched;
    expect(res.ok()).toBe(true);
    const rows = ((await res.json()) as { rows?: Array<{ documentId: number }> }).rows ?? [];
    expect(rows.map((r) => r.documentId)).not.toContain(doc.documentId);
    await expect(
      page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: docLabel }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Rattacher' })).toBeDisabled();

    // Une fois validé (archivé), le même document se rattache.
    await archiveDocument(api, doc.documentId);
    const attached = await api.raw.post(`/spaces/${target.gedSpaceId}/documents`, { documentId: doc.documentId });
    expect(attached.status()).toBe(201);
  });
});
