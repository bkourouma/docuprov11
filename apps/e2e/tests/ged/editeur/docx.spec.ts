/**
 * GED — éditeur : export DOCX (GET /collab/documents/:id/export.docx) et import DOCX (dans un document
 * existant : POST /collab/documents/:id/import ; à la création : POST /collab/documents/import).
 * Le DOCX d'entrée est fabriqué en mémoire (`minimalDocx`, ZIP stocké lu par mammoth).
 * Sources : EditorShell.tsx (menu DOCX, onPickFile, doExport), lib/editeur.ts (exportDocx),
 * nouveau/page.tsx, collab-documents.service.ts (validateDocx, applyImport).
 */
import { readFile } from 'node:fs/promises';
import { test, expect } from '../../../fixtures';
import type { Page } from '@playwright/test';
import {
  DOCX_MIME,
  createSpace,
  createSpaceAndDocument,
  docxText,
  editorBox,
  listVersions,
  minimalDocx,
  openEditor,
  pickSpace,
  statusBarVersion,
  typeAtEnd,
  waitConnected,
} from '../_helpers/editeur';

/** Ouvre le menu « DOCX » de l'en-tête de l'éditeur. */
async function openDocxMenu(page: Page) {
  await page.getByRole('button', { name: 'Importer ou exporter un DOCX' }).click();
}

/** Choisit un fichier par « Importer un DOCX… » (le menu déclenche le sélecteur de fichiers). */
async function chooseImportFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await openDocxMenu(page);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Importer un DOCX…' }).click();
  await (await chooser).setFiles(file);
}

test.describe('Éditeur — échanges DOCX', () => {
  test('GED-34 exporter en DOCX télécharge un fichier Word contenant le texte saisi', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId, label } = await createSpaceAndDocument(api, uniq, 'ged34');
    const text = `Texte à exporter ${uniq('ged34')}`;
    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, text);

    await openDocxMenu(page);
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Exporter en DOCX' }).click();
    const file = await download;

    expect(file.suggestedFilename()).toBe(`${label}.docx`);
    const path = await file.path();
    expect(path, 'fichier téléchargé').toBeTruthy();
    const buffer = await readFile(path!);
    expect(buffer.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(docxText(buffer)).toContain(text);
  });

  test('GED-35 importer un DOCX remplace le contenu et crée les versions « Avant import » et « Import »', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged35');
    const before = `Texte remplacé ${uniq('ged35')}`;
    const imported = `Paragraphe importé ${uniq('ged35')}`;
    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, before);

    await chooseImportFile(page, { name: 'import.docx', mimeType: DOCX_MIME, buffer: minimalDocx([imported]) });
    const confirm = page.getByRole('dialog').filter({ hasText: 'Remplacer le contenu du document ?' });
    await expect(confirm).toContainText('« import.docx »');
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/collab/documents/${documentId}/import`),
    );
    await confirm.getByRole('button', { name: 'Remplacer le contenu' }).click();
    expect((await response).status()).toBe(201);
    await expect(page.getByText('Le fichier DOCX a été importé.')).toBeVisible();

    // Salle vivante : le contenu importé arrive par le temps réel, sans rechargement.
    await expect(box).toContainText(imported);
    await expect(box).not.toContainText(before);

    const versions = await listVersions(api, documentId);
    const summaries = versions.map((v) => v.changeSummary);
    expect(summaries).toContain('Avant import DOCX');
    expect(summaries).toContain('Import DOCX');
    // Barre d'état à jour (ANO-GED-T3-1) : numéro de la version courante après l'import.
    const current = versions.find((v) => v.isCurrent)!;
    await expect(statusBarVersion(page, current.versionNumber)).toBeVisible();
  });

  test('GED-35 créer un document par import DOCX depuis /editeur/nouveau (titre repris du fichier)', async ({
    page,
    api,
    uniq,
  }) => {
    const space = await createSpace(api, `Espace ${uniq('ged35n')}`);
    const base = `Rapport-${uniq('ged35n')}`;
    const imported = `Corps du rapport ${uniq('ged35n')}`;

    await page.goto('/editeur/nouveau');
    await pickSpace(page, space.label);
    await page.getByRole('checkbox', { name: 'Importer un DOCX' }).check();
    // Modèle indisponible avec l'import (le contenu vient du fichier).
    await expect(page.getByText('Indisponible avec l’import DOCX : le contenu vient du fichier.')).toBeVisible();
    await expect(page.getByText('Choisir un fichier')).toBeVisible();
    // Seul champ fichier de la page (Upload Ant Design : le bouton enveloppe un input masqué).
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: `${base}.docx`, mimeType: DOCX_MIME, buffer: minimalDocx([imported]) });
    await expect(page.getByText(`${base}.docx`)).toBeVisible();
    await page.getByRole('button', { name: 'Créer le document' }).click();

    await expect(page).toHaveURL(/\/editeur\/\d+$/);
    await expect(page.getByRole('heading', { name: base, level: 2 })).toBeVisible();
    await waitConnected(page, expect);
    await expect(editorBox(page)).toContainText(imported);
  });

  test('GED-35 refus propres : extension autre que .docx, faux DOCX ; le contenu reste intact', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged35r');
    const text = `Contenu intact ${uniq('ged35r')}`;
    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, text);
    const versionsBefore = (await listVersions(api, documentId)).length;

    // Extension refusée côté écran, avant tout appel.
    await chooseImportFile(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour') });
    await expect(page.getByText('Choisissez un fichier au format DOCX.')).toBeVisible();

    // Nom en .docx mais contenu non ZIP : refus serveur 400, message lisible.
    await chooseImportFile(page, { name: 'faux.docx', mimeType: DOCX_MIME, buffer: Buffer.from('pas un zip') });
    const confirm = page.getByRole('dialog').filter({ hasText: 'Remplacer le contenu du document ?' });
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/collab/documents/${documentId}/import`),
    );
    await confirm.getByRole('button', { name: 'Remplacer le contenu' }).click();
    expect((await response).status()).toBe(400);
    await expect(page.getByText("Le fichier n'est pas un document Word (.docx) valide")).toBeVisible();

    await expect(box).toContainText(text);
    expect(await listVersions(api, documentId)).toHaveLength(versionsBefore);
  });
});
