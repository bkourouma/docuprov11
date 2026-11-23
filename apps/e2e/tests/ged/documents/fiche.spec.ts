/**
 * GED — fiche document (`/documents/:id`) : consultation, onglets, erreurs de saisie d'identifiant.
 * Scénarios GED-20 et GED-21 (docs/e2e/scenarios-ged.md).
 */
import { test, expect } from '../../../fixtures';
import { createPdfDocument, type GedDocsApi } from '../_helpers/documents';

/** Onglets de la fiche pour un utilisateur de niveau ≥ Modification (l'administrateur : 5). */
const ALL_TABS = [
  'Information',
  'Indexation',
  'Cycle de vie',
  'Accès par utilisateur',
  'Accès par profil',
  'Sécurité et conformité',
  'Versions',
  'Historique',
];

test.describe('Fiche document', () => {
  test('GED-20 consulter la fiche : en-tête, droits effectifs, onglets, métadonnées, aperçu et historique', async ({
    page,
    api,
    uniq,
  }) => {
    const doc = await createPdfDocument(api as GedDocsApi, uniq('GED-20 fiche'));

    await page.goto(`/documents/${doc.documentId}`);

    // En-tête stable (numéro, pas libellé) et niveau EFFECTIF de l'administrateur.
    await expect(page.getByRole('heading', { name: `Document #${doc.documentId}` })).toBeVisible();
    await expect(page.getByText('Vos droits : Archivistique')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retour à la recherche' })).toBeVisible();

    for (const name of ALL_TABS) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }

    // Onglet « Information » (actif par défaut) : libellé et absence de type => pas de métadonnée.
    await expect(page.getByRole('tab', { name: 'Information', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText(doc.label, { exact: true })).toBeVisible();
    await expect(
      page.getByText('Ce document n’a pas de type : aucune métadonnée n’est attendue.'),
    ).toBeVisible();

    // Aperçu : le binaire de la version courante est servi (200) et le tiroir s'ouvre.
    const content = page.waitForResponse(
      (r) =>
        r.url().includes(`/documents/${doc.documentId}/files/${doc.fileId}/content`) &&
        r.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Visualiser le document' }).click();
    expect((await content).status()).toBe(200);
    const drawer = page.getByRole('dialog', { name: 'Aperçu du document' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // Historique : l'ouverture de la fiche est journalisée (consultation, au nom de l'acteur).
    await page.getByRole('tab', { name: 'Historique', exact: true }).click();
    await expect(page.getByText('Consultation du document').first()).toBeVisible();
  });

  test('GED-21 identifiant de document inexistant ou invalide : sortie propre, jamais de 500', async ({
    page,
    api,
  }) => {
    const absent = 999_999_999; // dans les bornes d'un INT4, mais aucun document ne le porte

    // --- API : refus propres ---
    const missing = await api.raw.get(`/documents/${absent}`);
    expect(missing.status()).toBe(404);
    expect((await missing.json()).message).toBe('Document introuvable');

    for (const tab of ['versions', 'permissions', 'seal', 'integrity', 'history', 'life-cycle']) {
      const res = await api.raw.get(`/documents/${absent}/${tab}`);
      expect({ tab, status: res.status() }).toEqual({ tab, status: 404 });
    }

    const notNumeric = await api.raw.get('/documents/abc');
    expect(notNumeric.status()).toBe(400);

    // --- Écran : « Document introuvable » et retour à la recherche ---
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));

    await page.goto(`/documents/${absent}`);
    await expect(page.getByRole('heading', { name: 'Document introuvable' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Versions', exact: true })).toHaveCount(0);

    await page.goto('/documents/abc');
    await expect(page.getByRole('heading', { name: 'Document introuvable' })).toBeVisible();

    await page.getByRole('button', { name: 'Retour à la recherche' }).click();
    await expect(page).toHaveURL(/\/search(\?|$)/);
    expect(pageErrors).toEqual([]);
  });

  test('GED-21 identifiant au-delà d’un INT4 : refus propre (400 ou 404), jamais de 500', async ({ api }) => {
    // ANO-GED-07 confirmée sur la pile (2026-11-22) : GET /documents/99999999999 → 500.
    // `ParseIntPipe` (transverse) laisse passer la valeur, Prisma la refuse en erreur serveur.
    test.fixme(true, 'lot transverse : ANO-GED-07');
    const overflow = await api.raw.get('/documents/99999999999');
    expect(overflow.status()).toBeLessThan(500);
    expect([400, 404]).toContain(overflow.status());
  });
});
