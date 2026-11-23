/**
 * GED — rédaction assistée SANS fournisseur IA (pile E2E hermétique : `ged_ai_setting` absent =>
 * mode « désactivée »). On teste ce qui fonctionne sans IA (catalogue, squelettes, création depuis un
 * modèle) et le refus propre de la génération (`{ disabled: true }`, jamais 5xx).
 * Sources : apps/api/src/modules/drafting/*, DraftingPanel.tsx, nouveau/page.tsx, lib/redaction.ts.
 */
import { test, expect } from '../../../fixtures';
import {
  createEditorUser,
  createSpace,
  createSpaceAndDocument,
  editorBox,
  listVersions,
  openEditor,
  pickSpace,
  waitConnected,
  waitSaved,
  type RawApi,
} from '../_helpers/editeur';
import { antSelectTrigger } from '../_helpers/espaces';

interface Catalog {
  aiEnabled: boolean;
  aiMessage?: string;
  templates: Array<{ id: string; label: string; description: string; category: string; skeletonHtml?: string }>;
}

test.describe('Rédaction assistée — sans IA', () => {
  test('GED-39 catalogue des modèles et détail d’un modèle, IA signalée désactivée', async ({ api }) => {
    const raw = (api as unknown as RawApi).raw;
    const catalog = await api.get<Catalog>('/drafting/templates');
    expect(catalog.aiEnabled, 'pile E2E sans fournisseur IA').toBe(false);
    expect(catalog.aiMessage).toBe('IA désactivée');
    const ids = catalog.templates.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['vide', 'courrier-officiel', 'compte-rendu-reunion', 'proces-verbal']));
    for (const t of catalog.templates) {
      expect(t.label.length, t.id).toBeGreaterThan(0);
      expect(t, `${t.id} : le catalogue ne transporte pas le squelette`).not.toHaveProperty('skeletonHtml');
    }

    const detail = await api.get<{ id: string; skeletonHtml: string }>('/drafting/templates/compte-rendu-reunion');
    expect(detail.skeletonHtml).toContain('<h1>Compte rendu de réunion</h1>');

    const unknown = await raw.get('/drafting/templates/inconnu');
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).message).toBe('Modèle introuvable');
  });

  test('GED-39 génération refusée proprement sans IA, validations et limite de débit', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // Compte dédié : la limite (5 demandes / minute) est comptée par utilisateur.
    const user = await createEditorUser(api, apiAs, uniq('ged39d'));
    const draft = (body: unknown) => user.api.raw.post('/drafting/draft', body);

    const ok = await draft({ templateId: 'courrier-officiel', instruction: 'Rédige un courrier de relance' });
    expect(ok.status()).toBe(200);
    expect(await ok.json()).toEqual({ disabled: true, message: 'IA désactivée' });

    expect((await draft({ templateId: 'courrier-officiel', instruction: '   ' })).status()).toBe(400);
    expect((await draft({ templateId: 'inconnu', instruction: 'Rédige un courrier' })).status()).toBe(404);
    expect(
      (await draft({ templateId: 'courrier-officiel', instruction: 'Rédige un courrier', model: 'x' })).status(),
    ).toBe(400);
    expect((await draft({ templateId: 'vide', instruction: 'Rédige une note' })).status()).toBe(200);

    // 6e demande dans la minute : 429 avec Retry-After (garde avant validation : tout compte).
    const limited = await draft({ templateId: 'vide', instruction: 'Rédige une note' });
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
  });

  test('GED-39 panneau « Rédiger avec l’IA » : IA désactivée, insertion d’un squelette de modèle', async ({
    page,
    api,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged39p');
    let drafted = false;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/drafting/draft')) drafted = true;
    });

    const box = await openEditor(page, expect, documentId);
    await page.getByRole('button', { name: 'Rédiger avec l’IA' }).click();
    const panel = page.getByRole('complementary', { name: 'Rédiger avec l’IA' });
    await expect(panel.getByText('L’IA est désactivée par l’administrateur.')).toBeVisible();
    const models = panel.getByRole('list', { name: 'Modèles à insérer' });
    await expect(models).toBeVisible();
    // « Document vide » n'a pas de squelette à insérer.
    await expect(models.getByText('Document vide', { exact: true })).toHaveCount(0);

    await box.click();
    await models.getByRole('button', { name: 'Insérer le modèle vide « Compte rendu de réunion » au curseur' }).click();
    await expect(box.getByRole('heading', { name: 'Compte rendu de réunion' })).toBeVisible();
    await expect(box.getByRole('heading', { name: 'Participants' })).toBeVisible();
    await expect(box.getByRole('table')).toBeVisible();
    await waitSaved(page, expect);
    expect(drafted, 'aucun appel de génération sans IA').toBe(false);
  });

  test('GED-39 créer un document depuis un modèle (écran) : squelette inséré, assistant ouvert', async ({
    page,
    api,
    uniq,
  }) => {
    const space = await createSpace(api, `Espace ${uniq('ged39c')}`);
    const label = `Réunion ${uniq('ged39c')}`;

    await page.goto('/editeur/nouveau');
    await pickSpace(page, space.label);
    await page.getByLabel('Titre', { exact: true }).fill(label);
    // Le Select AntD porte le libellé sur son combobox ET sur sa liste d'options : rôle explicite ;
    // la valeur affichée (« Document vide ») recouvre l'<input> : clic sur le sélecteur parent.
    const model = page.getByRole('combobox', { name: 'Modèle', exact: true });
    await antSelectTrigger(model).click();
    await page.getByTitle('Compte rendu de réunion', { exact: true }).click();
    await page.getByRole('button', { name: 'Créer le document' }).click();

    await expect(page).toHaveURL(/\/editeur\/\d+\?assist=1$/);
    const documentId = Number(new URL(page.url()).pathname.split('/').pop());
    await expect(page.getByRole('heading', { name: label, level: 2 })).toBeVisible();
    await waitConnected(page, expect);
    await expect(editorBox(page).getByRole('heading', { name: 'Compte rendu de réunion' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Rédiger avec l’IA' })).toBeVisible();

    const versions = await listVersions(api, documentId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.changeSummary).toBe('Création depuis un modèle');
  });

  test('GED-39 créer un document depuis un modèle (API) : nominal, modèle inconnu, libellé vide, espace invisible', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const raw = (api as unknown as RawApi).raw;
    const space = await createSpace(api, `Espace ${uniq('ged39a')}`);
    const label = `PV ${uniq('ged39a')}`;

    const created = await raw.post('/drafting/documents', { spaceId: space.gedSpaceId, templateId: 'proces-verbal', label });
    expect(created.status()).toBe(201);
    const body = (await created.json()) as { documentId: number; label: string };
    expect(body.label).toBe(label);
    const session = await api.get<{ mode: string }>(`/collab/documents/${body.documentId}/session`);
    expect(session.mode).toBe('write');

    expect(
      (await raw.post('/drafting/documents', { spaceId: space.gedSpaceId, templateId: 'inconnu', label })).status(),
    ).toBe(404);
    expect(
      (await raw.post('/drafting/documents', { spaceId: space.gedSpaceId, templateId: 'vide', label: ' ' })).status(),
    ).toBe(400);

    const other = await createEditorUser(api, apiAs, uniq('ged39a'));
    expect(
      (await other.api.raw.post('/drafting/documents', { spaceId: space.gedSpaceId, templateId: 'vide', label })).status(),
    ).toBe(404);
  });
});
