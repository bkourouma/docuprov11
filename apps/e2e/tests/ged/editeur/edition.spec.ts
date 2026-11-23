/**
 * GED — éditeur : saisie, enregistrement automatique (autosave temps réel) et persistance.
 * Sources : apps/web/app/components/editeur/EditorShell.tsx (barre d'état), collab-server.service.ts
 * (onStoreDocument -> état de travail), collab-persistence.service.ts (loadDocument).
 */
import { test, expect } from '../../../fixtures';
import {
  createSpaceAndDocument,
  docxText,
  openEditor,
  reloadAccepting,
  typeAtEnd,
  waitConnected,
  editorBox,
  type RawApi,
} from '../_helpers/editeur';

test.describe('Éditeur — saisie et persistance', () => {
  test('GED-32 le texte saisi est enregistré automatiquement et retrouvé après rechargement', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged32');
    const first = `Premier paragraphe ${uniq('ged32')}`;
    const second = `Suite ${uniq('ged32')}`;

    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, first);
    await page.keyboard.press('Enter');
    await typeAtEnd(page, expect, box, second);

    // Rechargement complet : nouvelle session, nouveau Y.Doc, contenu relu depuis le serveur.
    await reloadAccepting(page);
    await expect(editorBox(page)).toBeVisible();
    await waitConnected(page, expect);
    await expect(editorBox(page)).toContainText(first);
    await expect(editorBox(page)).toContainText(second);
    // Deux paragraphes distincts (la touche Entrée crée un bloc, pas un simple espace).
    await expect(editorBox(page).locator('p').filter({ hasText: first })).toHaveCount(1);
    await expect(editorBox(page).locator('p').filter({ hasText: second })).toHaveCount(1);

    // L'état est bien côté serveur : l'export (lu depuis la salle ou la persistance) le contient.
    const res = await (api as unknown as RawApi).raw.get(`/collab/documents/${documentId}/export.docx`);
    expect(res.status()).toBe(200);
    const text = docxText(await res.body());
    expect(text).toContain(first);
    expect(text).toContain(second);
  });

  test('GED-32 un second onglet du même utilisateur relit le contenu enregistré', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged32b');
    const text = `Texte partagé ${uniq('ged32b')}`;
    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, text);

    // Même session (même stockage local) dans un nouvel onglet : la salle vivante est relue.
    const other = await page.context().newPage();
    try {
      const box2 = await openEditor(other, expect, documentId);
      await expect(box2).toContainText(text);
    } finally {
      await other.close();
    }
  });
});
