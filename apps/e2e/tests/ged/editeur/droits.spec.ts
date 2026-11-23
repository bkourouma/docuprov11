/**
 * GED — éditeur : droits. Le serveur est l'autorité (collab-access.service.ts, collab-documents.service.ts) :
 *  - niveau effectif < 3 (Consultation) : session `read`, écritures REST 403, éditeur non modifiable ;
 *  - document invisible (restreint sans droit), inexistant ou non texte : le MÊME 404, jamais 403 ;
 *  - un droit retiré pendant la session ferme la connexion (4401) au balayage suivant (15 s).
 */
import { test, expect } from '../../../fixtures';
import {
  COLLAB_TIMEOUT,
  MISSING_DOCUMENT_ID,
  PERMISSION,
  connectionStatus,
  createEditorUser,
  createSpaceAndDocument,
  editorBox,
  grantDocument,
  listVersions,
  openEditor,
  openUserPage,
  type RawApi,
} from '../_helpers/editeur';
import { createRestrictedUser } from '../_helpers/users';

test.describe('Éditeur — droits', () => {
  test('GED-37 lecture seule : un lecteur (Consultation) voit le document sans pouvoir le modifier', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const { documentId, label } = await createSpaceAndDocument(api, uniq, 'ged37r');
    const reader = await createEditorUser(api, apiAs, uniq('ged37r'));
    await grantDocument(api, documentId, reader.userGroupId, PERMISSION.Consultation);
    const v1 = (await listVersions(api, documentId))[0]!;

    // API : session en lecture, écritures refusées en 403 (le document est visible), export permis.
    const session = await reader.api.get<{ mode: string; label: string }>(`/collab/documents/${documentId}/session`);
    expect(session).toMatchObject({ mode: 'read', label });
    expect((await reader.api.raw.post(`/collab/documents/${documentId}/versions`, {})).status()).toBe(403);
    expect(
      (await reader.api.raw.post(`/collab/documents/${documentId}/restore`, { versionId: v1.documentVersionId })).status(),
    ).toBe(403);
    expect((await reader.api.raw.post(`/collab/documents/${documentId}/import`, {})).status()).toBe(403);
    expect((await reader.api.raw.get(`/collab/documents/${documentId}/export.docx`)).status()).toBe(200);

    // Écran : éditeur non modifiable, pas d'action d'écriture proposée.
    const { page, context } = await openUserPage(browser, loginAs, reader, test.info().project.use.baseURL);
    try {
      const box = await openEditor(page, expect, documentId, { readOnly: true });
      await expect(box).toHaveAttribute('contenteditable', 'false');
      await expect(page.getByText('Lecture seule', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enregistrer une version' })).toHaveCount(0);
      // Pas d'indicateur d'enregistrement en lecture seule.
      await expect(connectionStatus(page)).not.toContainText('Enregistr');
      await page.getByRole('button', { name: 'Importer ou exporter un DOCX' }).click();
      await expect(page.getByRole('menuitem', { name: 'Importer un DOCX…' })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByRole('menuitem', { name: 'Exporter en DOCX' })).not.toHaveAttribute('aria-disabled', 'true');
      await page.getByRole('button', { name: 'Historique' }).click();
      const history = page.getByRole('complementary', { name: 'Historique des versions' });
      await expect(history.getByText('Version 1', { exact: true })).toBeVisible();
      await expect(history.getByRole('button', { name: /^Restaurer la version/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('GED-37 refus : document restreint sans droit -> 404 uniforme et écran « Document inaccessible »', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged37d');
    const me = await api.get<{ userGroupId: number }>('/auth/me');
    // Droit nominatif à l'administrateur seul : le document devient restreint.
    await grantDocument(api, documentId, me.userGroupId, PERMISSION.Modification);
    const intruder = await createEditorUser(api, apiAs, uniq('ged37d'));
    const v1 = (await listVersions(api, documentId))[0]!;

    const paths: Array<['get' | 'post', string, unknown?]> = [
      ['get', `/collab/documents/${documentId}/session`],
      ['post', `/collab/documents/${documentId}/versions`, {}],
      ['post', `/collab/documents/${documentId}/restore`, { versionId: v1.documentVersionId }],
      ['post', `/collab/documents/${documentId}/import`, {}],
      ['get', `/collab/documents/${documentId}/export.docx`],
      ['get', `/collab/documents/${documentId}/mention-candidates?q=ad`],
    ];
    for (const [verb, path, body] of paths) {
      const res = verb === 'get' ? await intruder.api.raw.get(path) : await intruder.api.raw.post(path, body);
      expect(res.status(), `${verb.toUpperCase()} ${path}`).toBe(404);
      expect((await res.json()).message, `${verb.toUpperCase()} ${path}`).toBe('Document introuvable');
    }

    const { page, context } = await openUserPage(browser, loginAs, intruder, test.info().project.use.baseURL);
    try {
      await page.goto(`/editeur/${documentId}`);
      await expect(page.getByRole('heading', { name: 'Document inaccessible', level: 2 })).toBeVisible();
      await expect(editorBox(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('GED-37 document inexistant ou identifiant invalide : « Document inaccessible »', async ({ page, api }) => {
    const raw = (api as unknown as RawApi).raw;
    const missing = await raw.get(`/collab/documents/${MISSING_DOCUMENT_ID}/session`);
    expect(missing.status()).toBe(404);
    expect((await missing.json()).message).toBe('Document introuvable');
    expect((await raw.get('/collab/documents/abc/session')).status()).toBe(400);

    for (const id of [String(MISSING_DOCUMENT_ID), 'abc', '0']) {
      await page.goto(`/editeur/${id}`);
      await expect(page.getByRole('heading', { name: 'Document inaccessible', level: 2 }), `/editeur/${id}`).toBeVisible();
      await expect(editorBox(page)).toHaveCount(0);
    }
  });

  test('GED-37 compte sans profil par défaut : éditeur refusé (403) sans exposer d’erreur technique', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged37p');
    const noProfile = await createRestrictedUser(api, apiAs, uniq('ged37p'));
    const client = (await apiAs(noProfile.username, noProfile.password)) as unknown as RawApi;
    const res = await client.raw.get(`/collab/documents/${documentId}/session`);
    expect(res.status()).toBe(403);
    expect((await res.json()).message).toBe("Aucun profil actif n'est associé à ce compte");
  });

  test('GED-37 droit retiré pendant la session : la connexion est fermée et l’écran devient inaccessible', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    test.setTimeout(120_000);
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged37x');
    const reader = await createEditorUser(api, apiAs, uniq('ged37x'));
    const { page, context } = await openUserPage(browser, loginAs, reader, test.info().project.use.baseURL);
    try {
      // Document non restreint : le compte l'ouvre (lecture, niveau de base 2).
      await openEditor(page, expect, documentId, { readOnly: true });
      // Restriction à l'administrateur seul : au balayage suivant (15 s), fermeture 4401.
      const me = await api.get<{ userGroupId: number }>('/auth/me');
      await grantDocument(api, documentId, me.userGroupId, PERMISSION.Modification);
      await expect(page.getByRole('heading', { name: 'Document inaccessible', level: 2 })).toBeVisible({
        timeout: 15_000 + COLLAB_TIMEOUT + 10_000,
      });
    } finally {
      await context.close();
    }
  });
});
