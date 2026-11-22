// Docu-Flow : plafonds de consommation et arrêt d'urgence des agents (scénarios WF-65 à WF-69 ; WF-78, qui active l'arrêt
// GLOBAL, est dans plafonds.global.spec.ts, exécuté seul par le projet `etat-global`).
// Sélecteurs : apps/web/app/workflows/administration/_components/budget/** (BudgetView, BudgetEditModal,
// EmergencyStopConfirm, ConsumptionCard, StatusBanner).
//
// État partagé : le plafond GLOBAL et l'arrêt d'urgence GLOBAL valent pour toute la pile (et le répartiteur des
// déclencheurs lit l'arrêt global). Ces tests ne les modifient jamais : ils agissent sur des plafonds et des arrêts
// PAR WORKFLOW, propres à une définition créée par le test.

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { WF_MENUS, createPublishedDefinition } from '../_helpers/wf-api';
import { agentGraph, getBudget, setWorkflowBudget } from '../_helpers/agents';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';

const PAGE_TITLE = 'Plafonds et arrêt d’urgence';

async function gotoBudget(page: Page): Promise<void> {
  const loaded = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/budget') && r.request().method() === 'GET');
  await page.goto('/workflows/administration/plafonds');
  await loaded;
  await expect(page.getByRole('heading', { name: 'État des agents' })).toBeVisible();
}

/** Carte de consommation (article nommé par son titre). */
function card(page: Page, title: string) {
  return page.getByRole('article', { name: title, exact: true });
}

test.describe('Docu-Flow : plafonds et arrêt d’urgence', () => {
  test('WF-65 L’écran présente l’état des agents sans IA et le plafond global', async ({ page, api }) => {
    const status = await api.get<{ aiEnabled: boolean; aiMode: number; emergencyStopGlobal: boolean }>('/workflows/agents/status');
    // Pile E2E hermétique : aucun fournisseur IA configuré.
    expect(status.aiEnabled).toBe(false);

    await gotoBudget(page);
    await expect(page.getByRole('heading', { name: PAGE_TITLE, exact: true })).toBeVisible();
    await expect(page.getByText(/^IA désactivée \(mode : /)).toBeVisible();
    await expect(page.getByText(status.emergencyStopGlobal ? 'Arrêt global : actif' : 'Arrêt global : inactif')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plafond global', level: 2 })).toBeVisible();
    const global = card(page, 'Plafond global');
    await expect(global).toBeVisible();
    await expect(global.getByRole('button', { name: 'Modifier le plafond' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plafonds par workflow' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Définir un plafond pour un workflow' })).toBeVisible();
  });

  test('WF-66 Définir le plafond d’un workflow : erreurs de saisie puis enregistrement', async ({ page, api, uniq }) => {
    const name = uniq('WF-66 Plafond');
    const { definition } = await createPublishedDefinition(api, { name, graph: agentGraph() });
    const id = definition.wfDefinitionId;

    await gotoBudget(page);
    await page.getByLabel('Workflow', { exact: true }).click();
    await page.getByLabel('Workflow', { exact: true }).fill(name);
    await page.getByTitle(name, { exact: true }).click();
    await page.getByRole('button', { name: 'Définir un plafond' }).click();

    const modal = page.getByRole('dialog', { name: `Modifier le plafond : ${name}` });
    await expect(modal).toBeVisible();
    let puts = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/workflows/agents/budget') && r.method() === 'PUT') puts += 1;
    });

    await modal.getByLabel(/^Plafond \(.+\), vide = pas de plafond$/).fill('douze');
    await modal.getByLabel('Seuil d’alerte (en %)').fill('150');
    await modal.getByLabel('Devise (3 lettres)').fill('EU');
    await modal.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(
      modal.getByText('Saisissez un montant positif (par exemple 5000 ou 12,5), ou laissez vide pour retirer le plafond.'),
    ).toBeVisible();
    await expect(modal.getByText('Le seuil doit être compris entre 0 et 100 %.')).toBeVisible();
    await expect(modal.getByText('Devise attendue : 3 lettres (par exemple XOF).')).toBeVisible();
    expect(puts).toBe(0);

    await modal.getByLabel(/^Plafond \(.+\), vide = pas de plafond$/).fill('5000');
    await modal.getByLabel('Seuil d’alerte (en %)').fill('75');
    await modal.getByLabel('Devise (3 lettres)').fill('XOF');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/budget') && r.request().method() === 'PUT');
    await modal.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText(`Plafond enregistré : ${name}.`)).toBeVisible();
    await expect(modal).toBeHidden();

    const row = card(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByText('Niveau ok : Dans le budget')).toBeVisible();
    const overview = await getBudget(api);
    const budget = overview.workflows.find((w) => w.definitionId === id);
    expect(Number(budget?.capAmount)).toBe(5000);
    expect(Number(budget?.alertThreshold)).toBeCloseTo(0.75, 3);
    expect(budget?.currency).toBe('XOF');

    // L'API refuse aussi une devise mal formée (schéma strict).
    expect((await api.raw.put('/workflows/agents/budget', { definitionId: id, capAmount: 10, periodKind: 0, alertThreshold: 0.8, currency: 'eur' })).status()).toBe(400);
  });

  test('WF-67 Arrêt d’urgence d’un workflow : mot de confirmation exigé, activation puis levée', async ({ page, api, uniq }) => {
    const name = uniq('WF-67 Arrêt');
    const { definition } = await createPublishedDefinition(api, { name, graph: agentGraph() });
    const id = definition.wfDefinitionId;
    await setWorkflowBudget(api, id, { capAmount: null, currency: 'XOF', alertThreshold: 0.8, periodKind: 0 });

    await gotoBudget(page);
    const row = card(page, name);
    await row.getByRole('button', { name: 'Arrêt d’urgence', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activer l’arrêt d’urgence' });
    await expect(dialog.getByText(`Workflow n° ${id} « ${name} »`)).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Activer l’arrêt d’urgence' });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel('Pour confirmer, saisissez le mot « ARRÊT »').fill('STOP');
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(/^Motif \(recommandé, 500 caractères au plus\)$/).fill('Test E2E WF-67');
    await dialog.getByLabel('Pour confirmer, saisissez le mot « ARRÊT »').fill('arret');
    await expect(confirm).toBeEnabled();

    const stopped = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/emergency-stop'));
    await confirm.click();
    expect((await stopped).status()).toBe(200);
    await expect(page.getByText(`Arrêt d’urgence activé. Portée : Workflow n° ${id} « ${name} ».`)).toBeVisible();
    await expect(row.getByText('Arrêt d’urgence actif.')).toBeVisible();
    await expect(row.getByText(/Motif : Test E2E WF-67/)).toBeVisible();
    let budget = (await getBudget(api)).workflows.find((w) => w.definitionId === id);
    expect(budget?.emergencyStop).toBe(true);
    expect(budget?.emergencyStopReason).toBe('Test E2E WF-67');
    // L'arrêt d'un workflow ne touche pas l'arrêt global.
    expect((await getBudget(api)).global.emergencyStop).toBe(false);

    await row.getByRole('button', { name: 'Lever l’arrêt d’urgence' }).click();
    const lift = page.getByRole('dialog', { name: 'Lever l’arrêt d’urgence' });
    const lifted = page.waitForResponse((r) => r.url().endsWith('/api/workflows/agents/emergency-stop'));
    await lift.getByRole('button', { name: 'Lever l’arrêt d’urgence' }).click();
    expect((await lifted).status()).toBe(200);
    await expect(
      page.getByText(`Arrêt d’urgence levé. Portée : Workflow n° ${id} « ${name} ». Les agents reprennent.`),
    ).toBeVisible();
    budget = (await getBudget(api)).workflows.find((w) => w.definitionId === id);
    expect(budget?.emergencyStop).toBe(false);
  });

  test('WF-68 Arrêt d’urgence global : la confirmation reste bloquée sans le mot exact, l’annulation n’écrit rien', async ({
    page,
    api,
  }) => {
    await gotoBudget(page);
    let posted = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/workflows/agents/emergency-stop')) posted += 1;
    });
    await card(page, 'Plafond global').getByRole('button', { name: 'Arrêt d’urgence', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Activer l’arrêt d’urgence' });
    await expect(dialog.getByText('Tous les workflows (arrêt global)')).toBeVisible();
    await dialog.getByLabel('Pour confirmer, saisissez le mot « ARRÊT »').fill('ARRET DEFINITIF');
    await expect(dialog.getByRole('button', { name: 'Activer l’arrêt d’urgence' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toBeHidden();
    expect(posted).toBe(0);
    expect((await getBudget(api)).global.emergencyStop).toBe(false);
  });

  test('WF-69 Sans le menu administration : écran refusé, budget et arrêt d’urgence refusés par l’API (403)', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const designer = await createWfUser(api, { prefix: uniq('wf69-concepteur'), menus: [WF_MENUS.design, WF_MENUS.launch] });
    const asDesigner = await apiAs(designer.username, designer.password);
    expect((await asDesigner.raw.get('/workflows/agents/status')).status()).toBe(403);
    expect((await asDesigner.raw.get('/workflows/agents/budget')).status()).toBe(403);
    expect(
      (await asDesigner.raw.put('/workflows/agents/budget', { capAmount: 1, periodKind: 0, alertThreshold: 0.8, currency: 'XOF' })).status(),
    ).toBe(403);
    expect((await asDesigner.raw.post('/workflows/agents/emergency-stop', { active: true })).status()).toBe(403);
    expect((await getBudget(api)).global.emergencyStop).toBe(false);

    const s = await openSessionAs(browser, loginAs, designer);
    try {
      await s.page.goto('/workflows/administration/plafonds');
      await expect(
        s.page.getByText(
          'Accès refusé. Votre rôle ne donne pas accès à l’administration des workflows : les plafonds et l’arrêt d’urgence des agents lui sont réservés.',
        ),
      ).toBeVisible();
      await expect(s.page.getByRole('button', { name: 'Arrêt d’urgence', exact: true })).toHaveCount(0);
    } finally {
      await s.close();
    }
  });
});
