// Docu-Flow : évaluation des agents et éligibilité à l'autonomie, SANS IA (scénarios WF-74 à WF-77).
// Sélecteurs : apps/web/app/workflows/conception/_components/evaluation/** (EvaluationView, EvalSetModal, RunsList).
//
// Sans fournisseur IA, un run d'évaluation s'interrompt dès le premier cas (statut « en erreur », jamais « réussi ») :
// aucune étape ne peut donc devenir autonome. Les tests vérifient ces refus, jamais un succès d'agent.

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { createDefinition, createPublishedDefinition } from '../_helpers/wf-api';
import {
  agentGraph,
  createEvalCase,
  createEvalSet,
  setLowRisk,
  validateDraft,
  type WfEvalRunDto,
  type WfEvalSetDto,
} from '../_helpers/agents';
import { confirmDialog, editorToolbar, gotoEditor } from '../_helpers/ui';

const STEP_OPTION = 'Analyse du dossier (analyse)';

async function gotoEvaluation(page: Page, definitionId: number): Promise<void> {
  const sets = page.waitForResponse((r) => r.url().includes('/api/workflows/agents/eval-sets?') && r.request().method() === 'GET');
  await page.goto(`/workflows/conception/${definitionId}/evaluation`);
  await sets;
  await expect(page.getByRole('heading', { name: 'Évaluation des agents' })).toBeVisible();
  await expect(page.getByLabel('Étape agent à évaluer')).toBeVisible();
}

test.describe('Docu-Flow : évaluation et autonomie des agents', () => {
  test('WF-74 Créer un jeu d’évaluation : nom obligatoire, précision sous le plancher refusée', async ({ page, api, uniq }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-74 Évaluation'), graph: agentGraph() });
    const id = definition.wfDefinitionId;
    const setName = uniq('Jeu WF-74');

    await gotoEvaluation(page, id);
    await expect(page.getByText(STEP_OPTION)).toBeVisible();
    await page.getByRole('button', { name: 'Nouveau jeu d’évaluation' }).click();
    const modal = page.getByRole('dialog', { name: 'Nouveau jeu d’évaluation' });
    let posted = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/workflows/agents/eval-sets') && r.method() === 'POST') posted += 1;
    });

    await modal.getByRole('button', { name: 'Créer le jeu' }).click();
    await expect(modal.getByText('Le nom est obligatoire (1 à 200 caractères).')).toBeVisible();

    await modal.getByLabel('Nom du jeu').fill(setName);
    await modal.getByLabel('Précision minimale requise').fill('70 %');
    await modal.getByRole('button', { name: 'Créer le jeu' }).click();
    await expect(modal.getByText(/^Le seuil ne peut pas être inférieur au plancher de /)).toBeVisible();
    expect(posted).toBe(0);

    await modal.getByLabel('Précision minimale requise').fill('90 %');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/eval-sets') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Créer le jeu' }).click();
    expect((await created).status()).toBe(201);
    await expect(modal).toBeHidden();
    await expect(page.getByRole('list', { name: 'Jeux d’évaluation de l’étape' }).getByText(setName)).toBeVisible();

    const sets = await api.get<Array<WfEvalSetDto & { minAccuracy: string }>>(`/workflows/agents/eval-sets?definitionId=${id}`);
    const set = sets.find((s) => s.name === setName);
    expect(set?.stepKey).toBe('analyse');
    expect(Number(set?.minAccuracy)).toBeCloseTo(0.9, 3);

    // Le plancher est aussi imposé par l'API (contrôle du service : 422).
    const low = await api.raw.post('/workflows/agents/eval-sets', { definitionId: id, stepKey: 'analyse', name: uniq('Jeu bas'), minAccuracy: 0.5 });
    expect(low.status()).toBe(422);
  });

  test('WF-75 Lancer une évaluation sans IA : le run s’interrompt « en erreur » et ne rend pas l’étape éligible', async ({
    page,
    api,
    uniq,
  }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-75 Run'), graph: agentGraph() });
    const id = definition.wfDefinitionId;
    const setName = uniq('Jeu WF-75');
    const set = await createEvalSet(api, { definitionId: id, stepKey: 'analyse', name: setName, minAccuracy: 0.8 });
    await createEvalCase(api, set.wfEvalSetId, 'Dossier complet');

    await gotoEvaluation(page, id);
    await expect(page.getByRole('heading', { name: 'Évaluations (runs)' })).toBeVisible();
    await expect(page.getByText('Aucune évaluation lancée pour ce jeu.')).toBeVisible();
    await page.getByRole('button', { name: 'Lancer une évaluation' }).click();
    const dialog = confirmDialog(page, 'Lancer une évaluation ?');
    await expect(dialog.getByText(`Le jeu « ${setName} » sera exécuté sur l’étape « analyse »`, { exact: false })).toBeVisible();
    const launched = page.waitForResponse(
      (r) => r.url().endsWith(`/api/workflows/agents/eval-sets/${set.wfEvalSetId}/runs`) && r.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Lancer l’évaluation' }).click();
    const response = await launched;
    expect(response.status()).toBe(202);
    const run = (await response.json()) as WfEvalRunDto;

    await expect
      .poll(async () => (await api.get<WfEvalRunDto>(`/workflows/agents/eval-runs/${run.wfEvalRunId}`)).status, { timeout: 15_000 })
      .toBe(2);
    const done = await api.get<WfEvalRunDto>(`/workflows/agents/eval-runs/${run.wfEvalRunId}`);
    expect(done.passed).toBe(false);
    expect(done.errorMessage).toBe('IA désactivée : run interrompu au cas n° 1.');

    // Projet desktop : l'historique est un tableau (cartes sous 768 px).
    const history = page.getByRole('table', { name: 'Historique des évaluations, du plus récent au plus ancien' });
    await expect(history.getByText('En erreur', { exact: true })).toBeVisible();
    await expect(history.getByText('Message d’erreur : IA désactivée : run interrompu au cas n° 1.')).toBeVisible();

    const status = await api.get<{ steps: Array<{ stepKey: string; eligible: boolean }> }>(
      `/workflows/agents/eval-status?definitionId=${id}`,
    );
    expect(status.steps.find((s) => s.stepKey === 'analyse')?.eligible).toBe(false);
  });

  test('WF-76 Niveau « autonome » : refusé sans marquage faible risque, puis sans évaluation réussie', async ({ page, api, uniq }) => {
    const { definition } = await createDefinition(api, { name: uniq('WF-76 Autonome'), graph: agentGraph({ autonomy: 'autonome' }) });
    const id = definition.wfDefinitionId;

    let check = await validateDraft(api, id);
    expect(check.ok).toBe(false);
    expect(check.issues.map((i) => i.code)).toContain('AUTONOMY_REQUIRES_LOW_RISK');
    expect((await api.raw.post(`/workflows/definitions/${id}/publish`, {})).status()).toBe(422);

    // Marqué « faible risque » (administrateur) : reste exigée une évaluation réussie de cette version.
    await setLowRisk(api, id, true);
    check = await validateDraft(api, id);
    const codes = check.issues.map((i) => i.code);
    expect(codes).not.toContain('AUTONOMY_REQUIRES_LOW_RISK');
    expect(codes).toContain('AGENT_AUTONOMY_NOT_ELIGIBLE');
    expect(check.issues.find((i) => i.code === 'AGENT_AUTONOMY_NOT_ELIGIBLE')?.message).toContain(
      'aucun jeu d’évaluation n’est lié à l’étape.',
    );
    expect((await api.raw.post(`/workflows/definitions/${id}/publish`, {})).status()).toBe(422);

    await gotoEditor(page, id);
    const verified = page.waitForResponse((r) => r.url().endsWith(`/api/workflows/definitions/${id}/validate`));
    await editorToolbar(page).getByRole('button', { name: 'Vérifier', exact: true }).click();
    expect((await verified).status()).toBe(200);
    await expect(
      page.getByRole('region', { name: 'Problèmes du workflow' }).getByRole('heading', { name: 'Niveau autonome non éligible' }),
    ).toBeVisible();

    // Aucune configuration autonome n'a été publiée : le marquage peut être retiré, et le premier refus revient.
    await setLowRisk(api, id, false);
    check = await validateDraft(api, id);
    expect(check.issues.map((i) => i.code)).toContain('AUTONOMY_REQUIRES_LOW_RISK');
  });

  test.fixme('WF-77 Retirer le marquage « faible risque » est refusé tant qu’une étape autonome est publiée (409)', async () => {
    // P3. Publier une étape autonome exige un run d'évaluation RÉUSSI sur la version (déclencheur SQL
    // wf_agent_config_autonomy_guard) ; sans fournisseur IA, aucun run ne réussit, donc l'état de départ est
    // impossible à construire par l'API. À couvrir si un fournisseur factice d'E2E est ajouté (lot 0).
  });
});
