/**
 * GED — éditeur : création d'un document texte depuis `/editeur/nouveau`.
 * Sources : apps/web/app/editeur/nouveau/page.tsx, apps/api/src/modules/collab/documents/*.
 */
import { test, expect } from '../../../fixtures';
import {
  MISSING_DOCUMENT_ID,
  createEditorUser,
  createSpace,
  editorBox,
  listVersions,
  pickSpace,
  statusBarVersion,
  waitConnected,
  type RawApi,
} from '../_helpers/editeur';

test.describe('Éditeur — création de document', () => {
  test('GED-30 créer un document vide depuis /editeur/nouveau puis l’ouvrir dans l’éditeur', async ({
    page,
    api,
    uniq,
  }) => {
    const space = await createSpace(api, `Espace ${uniq('ged30')}`);
    const label = `Compte rendu ${uniq('ged30')}`;

    await page.goto('/editeur/nouveau');
    await expect(page.getByRole('heading', { name: 'Nouveau document', level: 2 })).toBeVisible();
    await pickSpace(page, space.label);
    await page.getByLabel('Titre', { exact: true }).fill(label);
    // Le modèle par défaut est « Document vide » : pas de panneau d'assistance à l'ouverture.
    await page.getByRole('button', { name: 'Créer le document' }).click();

    await expect(page).toHaveURL(/\/editeur\/\d+$/);
    const documentId = Number(new URL(page.url()).pathname.split('/').pop());
    await expect(page.getByRole('heading', { name: label, level: 2 })).toBeVisible();
    await expect(editorBox(page)).toBeVisible();
    await expect(editorBox(page)).toHaveAttribute('contenteditable', 'true');
    await waitConnected(page, expect);
    await expect(statusBarVersion(page, 1)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enregistrer une version' })).toBeVisible();

    // Côté serveur : document texte rattaché à l'espace, une seule version « Création ».
    const session = await api.get<{ label: string; mode: string }>(`/collab/documents/${documentId}/session`);
    expect(session).toMatchObject({ label, mode: 'write' });
    const versions = await listVersions(api, documentId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ versionNumber: 1, isCurrent: true, changeKind: 0 });
  });

  test('GED-31 erreurs de saisie à l’écran : espace manquant, titre vide, import sans fichier', async ({
    page,
    api,
    uniq,
  }) => {
    const space = await createSpace(api, `Espace ${uniq('ged31')}`);
    let created = false;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/(collab|drafting)\/documents/.test(r.url())) created = true;
    });

    await page.goto('/editeur/nouveau');
    const submit = page.getByRole('button', { name: 'Créer le document' });
    await expect(submit).toBeVisible();

    // 1. Rien de saisi : la règle du formulaire exige un espace.
    await submit.click();
    await expect(page.getByText('Choisissez un espace.')).toBeVisible();

    // 2. Espace choisi, titre blanc : refus côté écran, aucune requête de création.
    await pickSpace(page, space.label);
    await page.getByLabel('Titre', { exact: true }).fill('   ');
    await submit.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Saisissez un titre.' })).toBeVisible();

    // 3. Import coché sans fichier.
    await page.getByRole('checkbox', { name: 'Importer un DOCX' }).check();
    await submit.click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Choisissez le fichier DOCX à importer, ou décochez l’option.' }),
    ).toBeVisible();

    await expect(page).toHaveURL(/\/editeur\/nouveau/);
    expect(created, 'aucune création ne doit partir vers l’API').toBe(false);
  });

  test('GED-31 erreurs de saisie côté API : libellé vide ou trop long, champ inconnu, espace inexistant ou invisible', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const raw = (api as unknown as RawApi).raw;
    const space = await createSpace(api, `Espace ${uniq('ged31api')}`);

    const empty = await raw.post('/collab/documents', { spaceId: space.gedSpaceId, label: '   ' });
    expect(empty.status()).toBe(400);

    const tooLong = await raw.post('/collab/documents', { spaceId: space.gedSpaceId, label: 'x'.repeat(501) });
    expect(tooLong.status()).toBe(400);

    const unknownField = await raw.post('/collab/documents', {
      spaceId: space.gedSpaceId,
      label: 'Champ en trop',
      documentTypeId: 1,
    });
    expect(unknownField.status()).toBe(400);

    const noSpace = await raw.post('/collab/documents', { spaceId: MISSING_DOCUMENT_ID, label: 'Sans espace' });
    expect(noSpace.status()).toBe(404);

    // Espace privé de l'administrateur : invisible pour un autre compte -> 404 (pas 403).
    const other = await createEditorUser(api, apiAs, uniq('ged31u'));
    const invisible = await other.api.raw.post('/collab/documents', { spaceId: space.gedSpaceId, label: 'Intrus' });
    expect(invisible.status()).toBe(404);
  });
});
