/**
 * GED — éditeur : « Enregistrer une version » (POST /collab/documents/:id/versions) et restauration
 * depuis le panneau « Historique » (POST /collab/documents/:id/restore, salle réinitialisée en 4410).
 * Sources : EditorShell.tsx (doSave, barre d'état), VersionHistoryPanel.tsx, collab-documents.service.ts.
 */
import { test, expect } from '../../../fixtures';
import type { Page } from '@playwright/test';
import {
  COLLAB_TIMEOUT,
  createSpaceAndDocument,
  editorBox,
  listVersions,
  openEditor,
  statusBarVersion,
  typeAtEnd,
  waitConnected,
} from '../_helpers/editeur';

const RESTAURATION = 3; // GedVersionChangeKind.Restauration

/** Ouvre la boîte « Enregistrer une version », saisit le résumé et valide ; renvoie le statut HTTP. */
async function saveVersion(page: Page, documentId: number, summary?: string): Promise<number> {
  await page.getByRole('button', { name: 'Enregistrer une version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Enregistrer une version' });
  if (summary) await dialog.getByLabel('Résumé des modifications (facultatif)').fill(summary);
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/collab/documents/${documentId}/versions`),
  );
  await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  const status = (await response).status();
  await expect(dialog).toBeHidden();
  return status;
}

test.describe('Éditeur — versions', () => {
  test('GED-33 enregistrer une version, refuser un doublon, puis restaurer une version antérieure', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged33');
    const kept = `Contenu conservé ${uniq('ged33')}`;
    const dropped = `Ajout versionné ${uniq('ged33')}`;
    const unsaved = `Ajout non versionné ${uniq('ged33')}`;
    const summary = `Relecture ${uniq('ged33')}`;

    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, kept);

    // 1. Version manuelle avec résumé -> version 2.
    expect(await saveVersion(page, documentId, summary)).toBe(201);
    await expect(page.getByText('Version 2 enregistrée.')).toBeVisible();
    let versions = await listVersions(api, documentId);
    expect(versions.find((v) => v.isCurrent)).toMatchObject({ versionNumber: 2, changeSummary: summary });

    // ANO-GED-T3-1 : la barre d'état gardait le numéro lu à l'ouverture de la session.
    await expect(statusBarVersion(page, 2), 'barre d’état à jour').toBeVisible();

    // 2. Contenu inchangé : aucune nouvelle version, message d'information.
    await saveVersion(page, documentId);
    await expect(
      page.getByText('Le contenu est identique à la version courante : aucune nouvelle version n’a été créée.'),
    ).toBeVisible();
    expect(await listVersions(api, documentId)).toHaveLength(2);

    // 3. Version 3 (ajout), puis une modification NON versionnée.
    await typeAtEnd(page, expect, box, ` ${dropped}`);
    expect(await saveVersion(page, documentId)).toBe(201);
    await expect(page.getByText('Version 3 enregistrée.')).toBeVisible();
    await expect(statusBarVersion(page, 3)).toBeVisible();
    await typeAtEnd(page, expect, box, ` ${unsaved}`);

    // 4. Restauration de la version 2 depuis l'historique.
    await page.getByRole('button', { name: 'Historique' }).click();
    const history = page.getByRole('complementary', { name: 'Historique des versions' });
    await expect(history.getByText('Version 3', { exact: true })).toBeVisible();
    await history.getByRole('button', { name: 'Restaurer la version 2' }).click();
    await expect(page.getByText('Restaurer la version 2 ?')).toBeVisible();
    const restored = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/collab/documents/${documentId}/restore`),
    );
    await page.getByRole('button', { name: 'Restaurer', exact: true }).click();
    expect((await restored).status()).toBe(201);
    // Garde-fou « Avant restauration » (version 4) puis restauration (version 5).
    await expect(page.getByText('Version 5 créée à partir de la restauration.')).toBeVisible();

    // La salle est réinitialisée : l'éditeur se recharge seul sur le contenu de la version 2.
    await waitConnected(page, expect);
    await expect(editorBox(page)).toContainText(kept, { timeout: COLLAB_TIMEOUT });
    await expect(editorBox(page)).not.toContainText(dropped, { timeout: COLLAB_TIMEOUT });
    await expect(editorBox(page)).not.toContainText(unsaved, { timeout: COLLAB_TIMEOUT });
    await expect(statusBarVersion(page, 5)).toBeVisible();

    versions = await listVersions(api, documentId);
    const byNumber = new Map(versions.map((v) => [v.versionNumber, v]));
    expect(byNumber.get(4)?.changeSummary).toBe('Avant restauration');
    expect(byNumber.get(5)).toMatchObject({
      isCurrent: true,
      changeKind: RESTAURATION,
      restoredFromVersionNumber: 2,
    });

    // Après rechargement complet, le contenu restauré est toujours celui affiché (pas d'état de
    // travail périmé rechargé : cf. ANO-GED-T3-2, course reconnexion / restauration).
    await page.reload();
    await waitConnected(page, expect);
    await expect(editorBox(page)).toContainText(kept);
    await expect(editorBox(page)).not.toContainText(unsaved);
  });
});
