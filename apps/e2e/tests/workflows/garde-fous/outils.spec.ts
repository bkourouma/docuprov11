// Docu-Flow : outils autorisés des étapes agent (scénarios WF-70 à WF-73).
// Sélecteurs : apps/web/app/workflows/conception/_components/tools/** (ToolGrantsView, ToolsList) et le panneau
// des problèmes de l'éditeur (_lib/graph-issues.ts).
//
// Règle testée : un outil utilisé par une étape agent doit être autorisé pour CE workflow, sinon la publication est
// refusée (422, code AGENT_TOOL_NOT_GRANTED). Aucun appel à l'IA : seule la publication est en jeu.

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { WF_DEFINITION_STATUS, WF_MENUS, createDefinition, type WfDefinitionDto } from '../_helpers/wf-api';
import { READ_TOOL, agentGraph, getToolGrants } from '../_helpers/agents';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import { confirmDialog, editorToolbar, gotoEditor, publishFromEditor } from '../_helpers/ui';

const STEP_NAME = 'Analyse du dossier';
const CHECKBOX = `Autoriser l'outil ${READ_TOOL.label}`;
const MAX_CALLS = `Plafond d'appels par instance pour ${READ_TOOL.label} (vide : illimité)`;

async function gotoTools(page: Page, definitionId: number): Promise<void> {
  const loaded = page.waitForResponse((r) => r.url().endsWith(`/api/workflows/agents/definitions/${definitionId}/tool-grants`));
  await page.goto(`/workflows/conception/${definitionId}/outils`);
  await loaded;
  await expect(page.getByRole('heading', { name: 'Outils utilisés par ce workflow' })).toBeVisible();
}

test.describe('Docu-Flow : outils autorisés', () => {
  test('WF-70 Outil non autorisé : publication refusée, autorisation depuis l’écran, puis publication acceptée', async ({
    page,
    api,
    uniq,
  }) => {
    const name = uniq('WF-70 Outils');
    const { definition } = await createDefinition(api, { name, graph: agentGraph({ tools: [READ_TOOL.key] }) });
    const id = definition.wfDefinitionId;

    const refused = await api.raw.post(`/workflows/definitions/${id}/publish`, {});
    expect(refused.status()).toBe(422);
    const body = (await refused.json()) as { issues: Array<{ code: string; stepKey?: string }> };
    expect(body.issues).toContainEqual(expect.objectContaining({ code: 'AGENT_TOOL_NOT_GRANTED', stepKey: 'analyse' }));

    await gotoTools(page, id);
    await expect(page.getByRole('heading', { name: `Outils autorisés : ${name}` })).toBeVisible();
    await expect(page.getByText(`Étape « ${STEP_NAME} » : ${READ_TOOL.key}`)).toBeVisible();
    await expect(
      page.getByText('Des outils utilisés ne sont pas autorisés : la publication sera refusée avec AGENT_TOOL_NOT_GRANTED'),
    ).toBeVisible();
    await expect(page.getByText(`${READ_TOOL.key} : utilisé par l'étape « ${STEP_NAME} »`)).toBeVisible();
    await expect(page.getByLabel(CHECKBOX)).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Enregistrer les autorisations' })).toBeDisabled();

    await page.getByRole('button', { name: 'Autoriser les outils utilisés par ce workflow' }).click();
    await expect(page.getByLabel(CHECKBOX)).toBeChecked();
    await expect(page.getByText(`Outils cochés : ${READ_TOOL.key}. Pensez à enregistrer.`)).toBeVisible();
    await expect(page.getByText('Modifications non enregistrées')).toBeVisible();
    await page.getByLabel(MAX_CALLS).fill('3');

    await page.getByRole('button', { name: 'Enregistrer les autorisations' }).click();
    const dialog = confirmDialog(page, 'Enregistrer les autorisations ?');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/workflows/agents/definitions/${id}/tool-grants`) && r.request().method() === 'PUT',
    );
    await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText('Autorisations enregistrées : 1 outil(s) autorisé(s).')).toBeVisible();
    await expect(
      page.getByText('Des outils utilisés ne sont pas autorisés : la publication sera refusée avec AGENT_TOOL_NOT_GRANTED'),
    ).toHaveCount(0);
    expect(await getToolGrants(api, id)).toEqual([expect.objectContaining({ toolKey: READ_TOOL.key, maxCallsPerInstance: 3 })]);

    // Retour à l'éditeur : la publication passe désormais.
    await page.getByRole('link', { name: "Retour à l'éditeur pour publier" }).click(); // ToolGrantsView.tsx:370
    await expect(editorToolbar(page)).toBeVisible();
    await publishFromEditor(page, 1);
    const defs = await api.get<WfDefinitionDto[]>('/workflows/definitions');
    expect(defs.find((d) => d.wfDefinitionId === id)?.status).toBe(WF_DEFINITION_STATUS.published);
  });

  test('WF-71 L’éditeur explique le refus AGENT_TOOL_NOT_GRANTED et mène à l’écran des outils', async ({ page, api, uniq }) => {
    const name = uniq('WF-71 Explication');
    const { definition } = await createDefinition(api, { name, graph: agentGraph({ tools: [READ_TOOL.key] }) });
    const id = definition.wfDefinitionId;

    await gotoEditor(page, id);
    const verified = page.waitForResponse((r) => r.url().endsWith(`/api/workflows/definitions/${id}/validate`));
    await editorToolbar(page).getByRole('button', { name: 'Vérifier', exact: true }).click();
    expect((await verified).status()).toBe(200);
    const issues = page.getByRole('region', { name: 'Problèmes du workflow' });
    await expect(issues.getByRole('heading', { name: 'Outil non autorisé pour ce workflow' })).toBeVisible();
    await expect(issues.getByText(/n'est pas autorisé pour CE workflow/)).toBeVisible();

    await editorToolbar(page).getByRole('link', { name: 'Outils autorisés', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/conception/${id}/outils$`));
    await expect(page.getByRole('heading', { name: `Outils autorisés : ${name}` })).toBeVisible();
  });

  test('WF-72 Plafond d’appels invalide : la ligne est signalée et l’enregistrement bloqué', async ({ page, api, uniq }) => {
    const { definition } = await createDefinition(api, { name: uniq('WF-72 Plafond appels'), graph: agentGraph({ tools: [READ_TOOL.key] }) });
    const id = definition.wfDefinitionId;
    let puts = 0;
    page.on('request', (r) => {
      if (r.url().endsWith(`/tool-grants`) && r.method() === 'PUT') puts += 1;
    });

    await gotoTools(page, id);
    await page.getByLabel(CHECKBOX).check();
    await page.getByLabel(MAX_CALLS).fill('0');
    await expect(page.getByText('La limite doit être au moins 1 (laissez vide pour ne pas limiter).')).toBeVisible();
    await expect(
      page.getByText('Corrigez les lignes signalées avant d\'enregistrer (plafond invalide, outil désactivé ou absent du catalogue).'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enregistrer les autorisations' })).toBeDisabled();

    await page.getByLabel(MAX_CALLS).fill('2,5');
    await expect(page.getByText('Saisissez un nombre entier positif, ou laissez vide pour ne pas limiter.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enregistrer les autorisations' })).toBeDisabled();

    // « Annuler les modifications » revient à l'état enregistré.
    await page.getByRole('button', { name: 'Annuler les modifications' }).click();
    await expect(page.getByLabel(CHECKBOX)).not.toBeChecked();
    await expect(page.getByText('Aucune modification en attente.')).toBeVisible();
    expect(puts).toBe(0);
    expect(await getToolGrants(api, id)).toEqual([]);

    // L'API refuse aussi un plafond nul.
    const raw = await api.raw.put(`/workflows/agents/definitions/${id}/tool-grants`, {
      grants: [{ toolKey: READ_TOOL.key, maxCallsPerInstance: 0 }],
    });
    expect(raw.status()).toBe(400);
  });

  test('WF-73 Concepteur sans administration : écran des outils refusé, lecture des autorisations refusée (403)', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const designer = await createWfUser(api, { prefix: uniq('wf73-concepteur'), menus: [WF_MENUS.design] });
    const { definition } = await createDefinition(api, { name: uniq('WF-73 Outils'), graph: agentGraph({ tools: [READ_TOOL.key] }) });
    const asDesigner = await apiAs(designer.username, designer.password);
    expect((await asDesigner.raw.get('/workflows/agents/tools')).status()).toBe(403);
    expect((await asDesigner.raw.get(`/workflows/agents/definitions/${definition.wfDefinitionId}/tool-grants`)).status()).toBe(403);

    const s = await openSessionAs(browser, loginAs, designer);
    try {
      await s.page.goto(`/workflows/conception/${definition.wfDefinitionId}/outils`);
      await expect(
        s.page.getByText('Cet écran est réservé aux administrateurs des workflows. Demandez l\'accès à un administrateur.'),
      ).toBeVisible();
      await expect(s.page.getByRole('link', { name: 'Retour à l\'éditeur du workflow' })).toBeVisible();
      await expect(s.page.getByRole('button', { name: 'Enregistrer les autorisations' })).toHaveCount(0);
    } finally {
      await s.close();
    }
  });
});
