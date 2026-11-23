/**
 * GED — onglet « Versions » de la fiche : liste, dépôt, restauration, téléchargement du contenu.
 * Scénarios GED-22, GED-23, GED-24 (docs/e2e/scenarios-ged.md).
 */
import { test, expect } from '../../../fixtures';
import {
  createPdfDocument,
  createVersion,
  listVersions,
  minimalPdf,
  nth,
  pdfFile,
  versionContentPath,
  type GedDocsApi,
  type RawResponse,
} from '../_helpers/documents';

/** Ligne de la chronologie des versions portant le titre « Version n ». */
const versionItem = (page: import('@playwright/test').Page, n: number) =>
  page
    .locator('.ant-timeline-item')
    .filter({ has: page.getByText(`Version ${n}`, { exact: true }) });

/** Envoi multipart brut (statut lisible) : `api.raw.upload` des fixtures. */
function rawUpload(
  api: GedDocsApi,
  path: string,
  file: ReturnType<typeof pdfFile>,
): Promise<RawResponse> {
  return api.raw.upload(path, { field: 'file', file });
}

test.describe('Versions d’un document', () => {
  test('GED-22 lister les versions et déposer une nouvelle version depuis l’onglet', async ({
    page,
    api,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-22 versions'));

    // API : une seule version, courante, de nature « Création », avec son empreinte.
    const initial = await listVersions(api, doc.documentId);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ versionNumber: 1, isCurrent: true });
    expect(nth(nth(initial, 0).files, 0).fileId).toBe(doc.fileId);

    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Versions', exact: true }).click();
    await expect(versionItem(page, 1)).toContainText('Courante');
    await expect(versionItem(page, 1)).toContainText('Création');

    // Dépôt d'une nouvelle version par la modale.
    await page.getByRole('button', { name: 'Nouvelle version' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle version' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Créer la version' })).toBeDisabled();
    await dialog
      .locator('input[type="file"]')
      .setInputFiles(pdfFile('v2.pdf', minimalPdf(`${doc.label} v2`)));
    await dialog.getByPlaceholder('Ex. : pages 3 et 4 remplacées après correction').fill('Page 2 corrigée');

    const created = page.waitForResponse(
      (r) => r.url().endsWith(`/documents/${doc.documentId}/versions`) && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Créer la version' }).click();
    expect((await created).status()).toBe(201);
    await expect(page.locator('.ant-message')).toContainText('Version 2 créée');
    await expect(dialog).toBeHidden();

    await expect(versionItem(page, 2)).toContainText('Courante');
    await expect(versionItem(page, 2)).toContainText('Modification');
    await expect(versionItem(page, 2)).toContainText('Page 2 corrigée');
    await expect(versionItem(page, 1)).not.toContainText('Courante');

    const after = await listVersions(api, doc.documentId);
    expect(after.map((v) => [v.versionNumber, v.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(nth(after, 0).changeSummary).toBe('Page 2 corrigée');
    expect(nth(after, 0).contentHash).not.toBe(nth(after, 1).contentHash);

    // Le journal du document trace le dépôt (valeur d'audit `version-created:v2`). Son libellé à
    // l'écran reste le code technique : cf. ANO-GED-T1-6 (libellé lisible manquant).
    const history = (await api.get(`/documents/${doc.documentId}/history`)) as Array<{
      kind: string;
      action: string;
      details: string | null;
    }>;
    expect(
      history.some((e) => e.kind === 'change' && `${e.action} ${e.details}`.includes('version-created:v2')),
    ).toBe(true);
  });

  test('GED-22 erreurs de dépôt : contenu identique, fichier non PDF, aucun fichier, document inconnu', async ({
    page,
    api,
    uniq,
  }) => {
    const docsApi = api as GedDocsApi;
    const doc = await createPdfDocument(docsApi, uniq('GED-22 erreurs'));
    const path = `/documents/${doc.documentId}/versions`;

    const same = await rawUpload(docsApi, path, pdfFile('identique.pdf', doc.pdf));
    expect(same.status()).toBe(409);
    expect((await same.json()).message).toBe('Contenu identique à la version courante');

    const notPdf = await rawUpload(
      docsApi,
      path,
      { name: 'faux.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pas un pdf') },
    );
    expect(notPdf.status()).toBe(400);
    expect((await notPdf.json()).message).toBe('Seuls les fichiers PDF sont acceptés');

    // Corps JSON sans fichier : multer ne voit aucune pièce.
    const noFile = await api.raw.post(path, {});
    expect(noFile.status()).toBe(400);
    expect((await noFile.json()).message).toBe('Aucun fichier reçu (ou fichier vide)');

    const unknownDoc = await rawUpload(docsApi, '/documents/999999999/versions', pdfFile('x.pdf', minimalPdf('x')));
    expect(unknownDoc.status()).toBe(404);

    // Rien n'a bougé : toujours une seule version.
    expect(await listVersions(api, doc.documentId)).toHaveLength(1);

    // Écran : le refus « contenu identique » remonte en message lisible, la modale reste ouverte.
    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Versions', exact: true }).click();
    await page.getByRole('button', { name: 'Nouvelle version' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle version' });
    await dialog.locator('input[type="file"]').setInputFiles(pdfFile('identique.pdf', doc.pdf));
    await dialog.getByRole('button', { name: 'Créer la version' }).click();
    await expect(page.locator('.ant-message')).toContainText('Contenu identique à la version courante');
    await expect(dialog).toBeVisible();
  });

  test('GED-23 restaurer une version antérieure crée une nouvelle version courante', async ({
    page,
    api,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-23 restauration'));
    await createVersion(api as GedDocsApi, doc.documentId, { changeSummary: 'v2 par API' });

    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Versions', exact: true }).click();
    await expect(versionItem(page, 2)).toContainText('Courante');
    // Pas de bouton « Restaurer » sur la version courante.
    await expect(page.getByRole('button', { name: 'Restaurer la version 2' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Restaurer la version 1' }).click();
    await expect(page.getByText('Restaurer la version 1 ?')).toBeVisible();
    const restored = page.waitForResponse(
      (r) => r.url().includes(`/documents/${doc.documentId}/versions/${doc.versionId}/restore`),
    );
    await page.getByRole('button', { name: 'Restaurer', exact: true }).click();
    expect((await restored).status()).toBe(201);
    await expect(page.locator('.ant-message')).toContainText('Version 1 restaurée en version 3');

    await expect(versionItem(page, 3)).toContainText('Courante');
    await expect(versionItem(page, 3)).toContainText('Restauration');
    await expect(versionItem(page, 3)).toContainText('Restaurée depuis la v1');

    // L'historique est conservé (3 versions) et le contenu restauré est celui de la v1.
    const rows = await listVersions(api, doc.documentId);
    expect(rows.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    expect(rows[0]).toMatchObject({ isCurrent: true, restoredFromVersionNumber: 1 });
    const v3 = nth(rows, 0);
    expect(v3.contentHash).toBe(nth(rows, 2).contentHash);
    const bytes = await api.raw.get(versionContentPath(doc.documentId, v3.documentVersionId, nth(v3.files, 0).fileId));
    expect(bytes.status()).toBe(200);
    expect(Buffer.compare(await bytes.body(), doc.pdf)).toBe(0);
  });

  test('GED-23 erreurs de restauration : version courante, version inconnue, version d’un autre document', async ({
    api,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-23 erreurs A'));
    const other = await createPdfDocument(api as GedDocsApi, uniq('GED-23 erreurs B'));

    const current = await api.raw.post(`/documents/${doc.documentId}/versions/${doc.versionId}/restore`, {});
    expect(current.status()).toBe(409);
    expect((await current.json()).message).toBe('Cette version est déjà la version courante');

    const unknown = await api.raw.post(`/documents/${doc.documentId}/versions/999999999/restore`, {});
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).message).toBe('Version introuvable');

    const foreign = await api.raw.post(`/documents/${doc.documentId}/versions/${other.versionId}/restore`, {});
    expect(foreign.status()).toBe(404);

    // Champ inconnu dans le corps : refus de validation (schéma strict), pas une restauration.
    await createVersion(api as GedDocsApi, doc.documentId);
    const strict = await api.raw.post(`/documents/${doc.documentId}/versions/${doc.versionId}/restore`, {
      inattendu: true,
    });
    expect(strict.status()).toBe(400);
    expect(await listVersions(api, doc.documentId)).toHaveLength(2);
  });

  test('GED-24 télécharger le contenu d’une version : octets exacts, versions immuables, refus propres', async ({
    page,
    api,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-24 contenu'));
    const pdf2 = minimalPdf(`${doc.label} v2`);
    const v2 = await createVersion(api as GedDocsApi, doc.documentId, { pdf: pdf2, name: 'v2.pdf' });

    const v1Res = await api.raw.get(versionContentPath(doc.documentId, doc.versionId, doc.fileId));
    expect(v1Res.status()).toBe(200);
    expect(v1Res.headers()['content-type']).toContain('application/pdf');
    expect(v1Res.headers()['content-disposition']).toContain('inline;');
    expect(Buffer.compare(await v1Res.body(), doc.pdf)).toBe(0);

    const v2Res = await api.raw.get(versionContentPath(doc.documentId, v2.documentVersionId, nth(v2.files, 0).fileId));
    expect(v2Res.status()).toBe(200);
    expect(Buffer.compare(await v2Res.body(), pdf2)).toBe(0);

    // Fichier de la v1 demandé sous la v2, fichier inconnu, document inconnu : 404.
    for (const p of [
      versionContentPath(doc.documentId, v2.documentVersionId, doc.fileId),
      versionContentPath(doc.documentId, doc.versionId, 999999999),
      versionContentPath(999999999, doc.versionId, doc.fileId),
    ]) {
      const res = await api.raw.get(p);
      expect({ p, status: res.status() }).toEqual({ p, status: 404 });
    }

    // Écran : « Ouvrir » sur la v1 récupère le binaire avec le jeton et l'ouvre dans un onglet.
    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Versions', exact: true }).click();
    const popup = page.waitForEvent('popup');
    const fetched = page.waitForResponse((r) =>
      r.url().includes(versionContentPath(doc.documentId, doc.versionId, doc.fileId)),
    );
    await page.getByRole('button', { name: `Ouvrir ${doc.label}.pdf (version 1)` }).click();
    expect((await fetched).status()).toBe(200);
    const tab = await popup;
    await expect(page.locator('.ant-message-notice-error')).toHaveCount(0);
    await tab.close();
  });
});
