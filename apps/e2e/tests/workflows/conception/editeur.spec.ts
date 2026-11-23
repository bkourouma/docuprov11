// Docu-Flow : éditeur de définitions, canevas @xyflow/react et vue liste (scénarios WF-15 à WF-22).
//
// Stratégie : la définition est créée par l'API ; l'écran ne sert qu'aux manipulations ciblées (ajout d'une étape
// par la palette, liaison par la vue liste puis par le canevas, erreurs de graphe expliquées, enregistrement,
// publication, version figée). Sélecteurs : apps/web/app/workflows/conception/_components/**.

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import {
  WF_DEFINITION_STATUS,
  WF_MENUS,
  createDefinition,
  createPublishedDefinition,
  singleFormGraph,
  unreachableStepGraph,
  type WfDefinitionVersionDto,
} from '../_helpers/wf-api';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import { confirmDialog, editorToolbar, escapeRegExp, gotoEditor, publishFromEditor, toast } from '../_helpers/ui';

interface DefinitionDetail {
  definition: { wfDefinitionId: number; status: number; name: string };
  versions: Array<{ versionNumber: number; status: number }>;
}

/** Bouton de la palette « Ajouter une étape » (nom accessible = libellé du type + description). */
function paletteButton(page: Page, typeLabel: string) {
  return page
    .getByRole('region', { name: 'Ajouter une étape' })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(typeLabel)}`) });
}

/** Passe en vue liste (Segmented antd « Mode d'affichage »). */
async function showListView(page: Page): Promise<void> {
  await page.getByRole('radiogroup', { name: 'Mode d’affichage' }).getByText('Vue liste', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Étapes du workflow' })).toBeVisible();
}

/** Élément de la vue liste pour une étape (nom accessible « Étape « X », type … »). */
function outlineStep(page: Page, stepName: string) {
  return page
    .locator('li.wfc-outline-step')
    .filter({ has: page.getByRole('button', { name: new RegExp(`^Étape « ${escapeRegExp(stepName)} »`) }) });
}

/** Relie deux étapes depuis la vue liste (« Ajouter une transition » puis « Relier »). */
async function linkInOutline(page: Page, fromName: string, toName: string): Promise<void> {
  const item = outlineStep(page, fromName);
  await item.getByRole('combobox', { name: 'Ajouter une transition' }).click();
  await page.locator('.ant-select-dropdown:visible').getByTitle(toName, { exact: true }).click();
  await item.getByRole('button', { name: 'Relier' }).click();
  await expect(item.getByRole('list', { name: `Transitions sortantes de « ${fromName} »` }).getByText(toName)).toBeVisible();
}

async function saveDraft(page: Page): Promise<void> {
  const saved = page.waitForResponse((r) => /\/api\/workflows\/definitions\/\d+\/draft$/.test(r.url()) && r.request().method() === 'PUT');
  await editorToolbar(page).getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText(/^Brouillon enregistré à \d{2}:\d{2}\.$/)).toBeVisible();
}

test.describe('Docu-Flow : éditeur de définitions', () => {
  test('WF-15 Ajouter une étape par la palette, la relier en vue liste, enregistrer puis publier', async ({ page, api, uniq }) => {
    const name = uniq('WF-15 Éditeur');
    const { definition } = await createDefinition(api, { name, graph: singleFormGraph() });
    await gotoEditor(page, definition.wfDefinitionId);

    // Ajout d'une étape « Validation » : non reliée, elle est signalée et bloque la publication.
    await paletteButton(page, 'Validation').click();
    await expect(page.getByRole('heading', { name: 'Étape jamais utilisée' })).toBeVisible();
    await expect(page.getByText('Publication impossible : Enregistrez le brouillon avant de publier.')).toBeVisible();
    await expect(editorToolbar(page).getByRole('button', { name: 'Publier', exact: true })).toBeDisabled();

    // Liaison « Saisie de la demande » -> « Validation » par la vue liste (équivalent accessible du canevas).
    await showListView(page);
    await linkInOutline(page, 'Saisie de la demande', 'Validation');
    await expect(page.getByRole('heading', { name: 'Étape jamais utilisée' })).toHaveCount(0);

    await saveDraft(page);
    await publishFromEditor(page, 1);

    const detail = await api.get<DefinitionDetail>(`/workflows/definitions/${definition.wfDefinitionId}`);
    expect(detail.definition.status).toBe(WF_DEFINITION_STATUS.published);
    const v1 = await api.get<WfDefinitionVersionDto>(`/workflows/definitions/${definition.wfDefinitionId}/versions/1`);
    expect(v1.graph.steps.map((s) => s.type)).toEqual(['formulaire', 'validation']);
    expect(v1.graph.steps[0]?.next?.map((e) => e.to)).toEqual([v1.graph.steps[1]?.key]);
  });

  test('WF-16 Relier deux étapes en glissant d’une poignée à l’autre dans le canevas', async ({ page, api, uniq }) => {
    const name = uniq('WF-16 Canevas');
    const { definition } = await createDefinition(api, {
      name,
      graph: {
        schemaVersion: 1,
        start: 'debut',
        steps: [
          { key: 'debut', name: 'Début', type: 'formulaire', assignee: { kind: 'initiator' }, next: [] },
          { key: 'controle', name: 'Contrôle', type: 'checklist', assignee: { kind: 'initiator' }, next: [] },
        ],
      },
    });
    await gotoEditor(page, definition.wfDefinitionId);
    const source = page.locator('.react-flow__node[data-id="debut"] .react-flow__handle.source');
    const target = page.locator('.react-flow__node[data-id="controle"] .react-flow__handle.target');
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    await source.dragTo(target);
    await expect(page.locator('[aria-label^="Transition de « Début » vers « Contrôle »"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Étape jamais utilisée' })).toHaveCount(0);

    await saveDraft(page);
    const draft = await api.get<WfDefinitionVersionDto>(`/workflows/definitions/${definition.wfDefinitionId}/versions/1`);
    expect(draft.graph.steps.find((s) => s.key === 'debut')?.next?.map((e) => e.to)).toEqual(['controle']);
  });

  test('WF-17 Graphe non publiable : problème expliqué en français, publication bloquée à l’écran et refusée par l’API (422)', async ({
    page,
    api,
    uniq,
  }) => {
    const { definition } = await createDefinition(api, { name: uniq('WF-17 Orpheline'), graph: unreachableStepGraph() });
    await gotoEditor(page, definition.wfDefinitionId);
    const issues = page.getByRole('region', { name: 'Problèmes du workflow' });
    await expect(issues.getByRole('heading', { name: 'Étape jamais utilisée' })).toBeVisible();
    await expect(issues.getByText(/Aucun chemin ne mène à l'étape .*Étape orpheline/)).toBeVisible();
    await expect(page.getByText('Publication impossible : Corrigez les problèmes signalés avant de publier.')).toBeVisible();
    await expect(editorToolbar(page).getByRole('button', { name: 'Publier', exact: true })).toBeDisabled();

    // « Aller à l'étape » sélectionne l'étape fautive dans le panneau de propriétés.
    await issues.getByRole('button', { name: 'Aller à l’étape « Étape orpheline »' }).click();
    await expect(page.getByRole('region', { name: 'Propriétés de l\'étape' }).getByLabel("Nom de l'étape")).toHaveValue('Étape orpheline');

    const refused = await api.raw.post(`/workflows/definitions/${definition.wfDefinitionId}/publish`, {});
    expect(refused.status()).toBe(422);
    const body = (await refused.json()) as { issues?: Array<{ code: string; stepKey?: string }> };
    expect(body.issues?.some((i) => i.code === 'UNREACHABLE_STEP' && i.stepKey === 'orpheline')).toBe(true);
  });

  test('WF-18 « Vérifier » un brouillon correct annonce qu’il est publiable', async ({ page, api, uniq }) => {
    const { definition } = await createDefinition(api, { name: uniq('WF-18 Vérifier'), graph: singleFormGraph() });
    await gotoEditor(page, definition.wfDefinitionId);
    const verified = page.waitForResponse((r) => /\/api\/workflows\/definitions\/\d+\/validate$/.test(r.url()));
    await editorToolbar(page).getByRole('button', { name: 'Vérifier', exact: true }).click();
    expect((await verified).status()).toBe(200);
    await expect(toast(page, 'Vérification réussie : aucun problème, le workflow peut être publié.')).toBeVisible();
  });

  test('WF-19 Nom d’étape vide : l’enregistrement est bloqué avant l’envoi, avec une explication', async ({ page, api, uniq }) => {
    const { definition } = await createDefinition(api, { name: uniq('WF-19 Nom vide'), graph: singleFormGraph() });
    await gotoEditor(page, definition.wfDefinitionId);
    await showListView(page);
    await outlineStep(page, 'Saisie de la demande').getByRole('button', { name: /^Étape « Saisie de la demande »/ }).click();
    const panel = page.getByRole('region', { name: 'Propriétés de l\'étape' });
    await panel.getByLabel("Nom de l'étape").fill('');
    await expect(panel.getByText("Le nom de l'étape est obligatoire.")).toBeVisible();

    let draftCalls = 0;
    page.on('request', (r) => {
      if (/\/api\/workflows\/definitions\/\d+\/draft$/.test(r.url()) && r.method() === 'PUT') draftCalls += 1;
    });
    await editorToolbar(page).getByRole('button', { name: 'Enregistrer le brouillon' }).click();
    await expect(toast(page, /^Enregistrement impossible, complétez d’abord : /)).toBeVisible();
    expect(draftCalls).toBe(0);
    const draft = await api.get<WfDefinitionVersionDto>(`/workflows/definitions/${definition.wfDefinitionId}/versions/1`);
    expect(draft.graph.steps[0]?.name).toBe('Saisie de la demande');
  });

  test('WF-20 Version publiée en lecture seule ; « Créer un brouillon à partir de cette version » ouvre la version 2', async ({
    page,
    api,
    uniq,
  }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-20 Immuable'), graph: singleFormGraph() });
    await gotoEditor(page, definition.wfDefinitionId);
    await expect(page.getByText('Version en lecture seule')).toBeVisible();
    await expect(editorToolbar(page).getByRole('button', { name: 'Enregistrer le brouillon' })).toBeDisabled();
    await expect(paletteButton(page, 'Validation')).toBeDisabled();

    await editorToolbar(page).getByRole('button', { name: 'Plus' }).click();
    const created = page.waitForResponse((r) => /\/api\/workflows\/definitions\/\d+\/draft$/.test(r.url()) && r.request().method() === 'PUT');
    await page.getByRole('menuitem', { name: 'Créer un brouillon à partir de cette version' }).click();
    expect((await created).status()).toBe(200);
    await expect(toast(page, 'Brouillon (version n° 2) créé à partir de la version n° 1.')).toBeVisible();
    await expect(paletteButton(page, 'Validation')).toBeEnabled();

    const versions = page.getByRole('region', { name: 'Versions' });
    await expect(versions.getByText('Version n° 1')).toBeVisible();
    await expect(versions.getByText('Version n° 2')).toBeVisible();
    const detail = await api.get<DefinitionDetail>(`/workflows/definitions/${definition.wfDefinitionId}`);
    expect(detail.versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
  });

  test('WF-21 Quitter l’éditeur avec des modifications non enregistrées demande confirmation', async ({ page, api, uniq }) => {
    const { definition } = await createDefinition(api, { name: uniq('WF-21 Sortie'), graph: singleFormGraph() });
    await gotoEditor(page, definition.wfDefinitionId);
    await paletteButton(page, 'Checklist').click();

    await page.locator('.ant-breadcrumb').getByRole('link', { name: 'Conception des workflows' }).click();
    const confirm = confirmDialog(page, 'Quitter sans enregistrer ?');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Rester', exact: true }).click();
    // L'éditeur reporte la version ouverte dans l'URL (`?version=n`, EditorView.tsx setUrlVersion).
    await expect(page).toHaveURL(new RegExp(`/workflows/conception/${definition.wfDefinitionId}(\\?version=1)?$`));

    await page.locator('.ant-breadcrumb').getByRole('link', { name: 'Conception des workflows' }).click();
    await confirmDialog(page, 'Quitter sans enregistrer ?').getByRole('button', { name: 'Quitter sans enregistrer' }).click();
    await expect(page).toHaveURL(/\/workflows\/conception$/);
    const draft = await api.get<WfDefinitionVersionDto>(`/workflows/definitions/${definition.wfDefinitionId}/versions/1`);
    expect(draft.graph.steps).toHaveLength(1);
  });

  test('WF-22 Concepteur non administrateur : ni lien « Outils autorisés », ni marquage faible risque ; API 403', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const designer = await createWfUser(api, { prefix: uniq('wf22-concepteur'), menus: [WF_MENUS.design] });
    const { definition } = await createDefinition(api, { name: uniq('WF-22 Concepteur'), graph: singleFormGraph() });
    const asDesigner = await apiAs(designer.username, designer.password);
    expect((await asDesigner.raw.post(`/workflows/definitions/${definition.wfDefinitionId}/low-risk`, { isLowRisk: true })).status()).toBe(403);
    expect((await asDesigner.raw.get(`/workflows/agents/definitions/${definition.wfDefinitionId}/tool-grants`)).status()).toBe(403);

    const s = await openSessionAs(browser, loginAs, designer);
    try {
      await gotoEditor(s.page, definition.wfDefinitionId);
      await expect(editorToolbar(s.page).getByRole('link', { name: 'Outils autorisés' })).toHaveCount(0);
      await expect(s.page.getByRole('switch', { name: 'Workflow à faible risque' })).toHaveCount(0);
      // Le concepteur peut tout de même enregistrer et vérifier son brouillon.
      await expect(editorToolbar(s.page).getByRole('button', { name: 'Vérifier', exact: true })).toBeEnabled();
    } finally {
      await s.close();
    }
  });
});
