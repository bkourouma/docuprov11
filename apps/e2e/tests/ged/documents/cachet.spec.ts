/**
 * GED — onglet « Sécurité et conformité » : vérification d'intégrité et cachet serveur
 * (signature Ed25519 + horodatage interne). Scénarios GED-25 et GED-26 (docs/e2e/scenarios-ged.md).
 *
 * Clé de scellement : aucune configuration n'est requise — à défaut de `SEALING_KEY_PATH`, l'API
 * crée la clé au premier usage sous `<ARCHIVES_PATH>/.keys/` (`loadOrCreateSealingKey`). Il n'existe
 * donc PAS d'état « clé non configurée » à afficher ; GED-26 vérifie que la pile E2E, qui ne pose
 * pas cette variable, obtient bien une clé utilisable.
 */
import { createHash, createPublicKey } from 'node:crypto';
import { test, expect } from '../../../fixtures';
import {
  applySeal,
  createPdfDocument,
  createVersion,
  getSeal,
  getSealingPublicKey,
  verifyIntegrity,
  type GedDocsApi,
} from '../_helpers/documents';

test.describe('Sécurité et conformité', () => {
  test('GED-25 vérifier l’intégrité d’un document : conforme, tracé, refus propre sur document inconnu', async ({
    page,
    api,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-25 intégrité'));

    // État connu avant tout contrôle : empreinte posée à la création, jamais vérifié.
    const before = (await api.get(`/documents/${doc.documentId}/integrity`)) as {
      integrityOk: boolean | null;
      dateLastVerified: string | null;
      files: Array<{ fileId: number; hash: string | null }>;
    };
    expect(before.integrityOk).toBeNull();
    expect(before.dateLastVerified).toBeNull();
    expect(before.files).toHaveLength(1);
    expect(before.files[0]?.hash).toBe(createHash('sha256').update(doc.pdf).digest('hex'));

    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Sécurité et conformité', exact: true }).click();
    await expect(page.getByText('Jamais vérifié')).toBeVisible();
    await expect(page.getByText('Non scellé')).toBeVisible();

    const verified = page.waitForResponse(
      (r) => r.url().endsWith(`/documents/${doc.documentId}/integrity/verify`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Vérifier maintenant' }).click();
    expect((await verified).status()).toBe(200);
    await expect(page.locator('.ant-message')).toContainText('Intégrité conforme.');
    await expect(page.getByText('Conforme', { exact: true })).toBeVisible();
    await expect(page.getByText('Empreinte conforme')).toBeVisible();

    // API : le verdict est enregistré, et un second passage reste conforme.
    const again = await verifyIntegrity(api, doc.documentId);
    expect(again.integrityOk).toBe(true);
    expect(again.files).toEqual([expect.objectContaining({ fileId: doc.fileId, status: 'ok' })]);

    await page.getByRole('tab', { name: 'Historique', exact: true }).click();
    await expect(page.getByText('Intégrité vérifiée — conforme').first()).toBeVisible();

    const unknown = await api.raw.post('/documents/999999999/integrity/verify');
    expect(unknown.status()).toBe(404);
  });

  test('GED-26 apposer, vérifier et renouveler le cachet serveur ; clé publique disponible sans configuration', async ({
    page,
    api,
    uniq,
  }) => {
    const docsApi = api as GedDocsApi;
    const doc = await createPdfDocument(docsApi, uniq('GED-26 cachet'));

    // Clé de l'installation : créée au besoin, publiée au format PEM, empreinte = SHA-256 du DER.
    const key = await getSealingPublicKey(api);
    expect(key.algorithm).toBe('Ed25519');
    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    const der = createPublicKey(key.publicKeyPem).export({ type: 'spki', format: 'der' });
    expect(key.fingerprint).toBe(createHash('sha256').update(der).digest('hex'));

    expect(await getSeal(api, doc.documentId)).toEqual({ sealed: false });

    // Écran : apposer le cachet.
    await page.goto(`/documents/${doc.documentId}`);
    await page.getByRole('tab', { name: 'Sécurité et conformité', exact: true }).click();
    await expect(page.getByText('Non scellé')).toBeVisible();
    const sealed = page.waitForResponse(
      (r) => r.url().endsWith(`/documents/${doc.documentId}/seal`) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Apposer le cachet' }).click();
    expect((await sealed).status()).toBe(200);
    await expect(page.locator('.ant-message')).toContainText('Cachet apposé.');
    await expect(page.getByText('Scellé et intact')).toBeVisible();
    await expect(page.getByText('Authentique')).toBeVisible();
    await expect(page.getByText('Inchangées')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Renouveler le cachet' })).toBeVisible();

    // API : les quatre verdicts du cachet, signé par la clé publiée.
    const state = await getSeal(api, doc.documentId);
    expect(state).toMatchObject({
      sealed: true,
      algorithm: 'Ed25519',
      keyFingerprint: key.fingerprint,
      knownKey: true,
      signatureValid: true,
      contentMatches: true,
      timestampMatches: true,
    });

    // Nouvelle version : le cachet reste authentique mais n'atteste plus le contenu actuel.
    await createVersion(docsApi, doc.documentId, { changeSummary: 'après scellement' });
    expect(await getSeal(api, doc.documentId)).toMatchObject({
      signatureValid: true,
      contentMatches: false,
    });
    await page.reload();
    await page.getByRole('tab', { name: 'Sécurité et conformité', exact: true }).click();
    await expect(page.getByText('Contenu modifié depuis')).toBeVisible();
    await expect(page.getByText('Nouvelle version depuis le scellement')).toBeVisible();

    // Renouvellement : le cachet couvre de nouveau le contenu, et le journal garde l'ancien.
    const renewed = await applySeal(api, doc.documentId);
    expect(renewed.keyFingerprint).toBe(key.fingerprint);
    expect(await getSeal(api, doc.documentId)).toMatchObject({ contentMatches: true, signatureValid: true });

    await page.reload();
    await page.getByRole('tab', { name: 'Historique', exact: true }).click();
    await expect(page.getByText('Cachet serveur apposé').first()).toBeVisible();
    await expect(page.getByText('Cachet serveur renouvelé').first()).toBeVisible();
  });

  test('GED-26 refus propres du cachet : document inconnu, identifiant invalide', async ({ api }) => {
    for (const [verb, path] of [
      ['get', '/documents/999999999/seal'],
      ['post', '/documents/999999999/seal'],
    ] as const) {
      const res = verb === 'get' ? await api.raw.get(path) : await api.raw.post(path);
      expect({ verb, status: res.status() }).toEqual({ verb, status: 404 });
      expect((await res.json()).message).toBe('Document introuvable');
    }
    const invalid = await api.raw.post('/documents/abc/seal');
    expect(invalid.status()).toBe(400);
  });
});
