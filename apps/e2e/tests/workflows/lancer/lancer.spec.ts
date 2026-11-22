// Docu-Flow : catalogue des workflows lançables et lancement manuel (scénarios WF-30 à WF-33).
// Sélecteurs : apps/web/app/workflows/lancer/page.tsx et lancer/_components/LaunchModal.tsx.

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import {
  WF_INSTANCE_STATUS,
  WF_MENUS,
  archiveDefinition,
  createDefinition,
  createPublishedDefinition,
  getInstance,
  launchInstance,
  singleFormGraph,
} from '../_helpers/wf-api';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import { instanceFact, toast } from '../_helpers/ui';

async function gotoLaunch(page: Page): Promise<void> {
  const loaded = page.waitForResponse((r) => r.url().endsWith('/api/workflows/definitions/launchable'));
  await page.goto('/workflows/lancer');
  await loaded;
  await expect(page.getByRole('heading', { name: 'Lancer un workflow' })).toBeVisible();
}

async function openLaunchModal(page: Page, name: string) {
  await page.getByRole('button', { name: `Lancer le workflow ${name}` }).click();
  const modal = page.getByRole('dialog', { name: `Lancer « ${name} »` });
  await expect(modal).toBeVisible();
  return modal;
}

test.describe('Docu-Flow : lancement manuel', () => {
  test('WF-30 Seuls les workflows publiés sont proposés ; le lancement crée l’instance et ouvre son suivi', async ({ page, api, uniq }) => {
    const published = uniq('WF-30 Publié');
    const draft = uniq('WF-30 Brouillon');
    const archived = uniq('WF-30 Archivé');
    const { definition } = await createPublishedDefinition(api, { name: published, description: 'Lançable', graph: singleFormGraph() });
    await createDefinition(api, { name: draft, graph: singleFormGraph() });
    const toArchive = await createPublishedDefinition(api, { name: archived, graph: singleFormGraph() });
    await archiveDefinition(api, toArchive.definition.wfDefinitionId);

    await gotoLaunch(page);
    await page.getByLabel('Rechercher un workflow').fill('WF-30');
    await expect(page.getByRole('article', { name: published })).toBeVisible();
    await expect(page.getByRole('article', { name: draft })).toHaveCount(0);
    await expect(page.getByRole('article', { name: archived })).toHaveCount(0);

    const modal = await openLaunchModal(page, published);
    await modal.getByLabel('Données de lancement (JSON, facultatif)').fill('{"priorite": "haute", "montant": 1200}');
    const launched = page.waitForResponse((r) => r.url().endsWith('/api/workflows/instances') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
    expect((await launched).status()).toBe(201);
    await expect(toast(page, 'Workflow lancé.')).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/instances\/\d+$/);
    await expect(instanceFact(page, 'Workflow')).toHaveText(published);
    await expect(instanceFact(page, 'Statut')).toHaveText('En attente');

    const instanceId = page.url().split('/').pop() as string;
    const detail = await getInstance(api, instanceId);
    expect(detail.instance.definitionId).toBe(definition.wfDefinitionId);
    expect(detail.instance.status).toBe(WF_INSTANCE_STATUS.waitingHuman);
    expect((detail.instance.context as { input?: unknown }).input).toEqual({ priorite: 'haute', montant: 1200 });
  });

  test('WF-31 Erreurs de saisie du lancement : JSON invalide, objet lié incomplet, clé vide', async ({ page, api, uniq }) => {
    const name = uniq('WF-31 Saisie');
    await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    await gotoLaunch(page);
    const modal = await openLaunchModal(page, name);
    let posted = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/workflows/instances') && r.method() === 'POST') posted += 1;
    });

    await modal.getByLabel('Données de lancement (JSON, facultatif)').fill('{"priorite": ');
    await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
    await expect(modal.getByText('Syntaxe JSON invalide : vérifiez les guillemets, les virgules et les accolades.')).toBeVisible();

    await modal.getByLabel('Données de lancement (JSON, facultatif)').fill('[1, 2]');
    await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
    await expect(modal.getByText('Les données de lancement doivent être un objet JSON, par exemple {"clé": "valeur"}.')).toBeVisible();

    await modal.getByLabel('Données de lancement (JSON, facultatif)').fill('');
    await modal.getByLabel('Identifiant de l’objet lié').fill('42');
    await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
    await expect(modal.getByText('Renseignez le type ET l’identifiant de l’objet lié, ou laissez les deux vides.')).toBeVisible();

    await modal.getByLabel('Identifiant de l’objet lié').fill('');
    await modal.getByLabel('Clé d’idempotence').fill('');
    await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
    await expect(modal.getByText('La clé d’idempotence est obligatoire (1 à 200 caractères).')).toBeVisible();

    expect(posted).toBe(0);
    await expect(modal).toBeVisible();
  });

  test('WF-32 Clé d’idempotence : rejouer montre l’instance existante ; la même clé par un autre lanceur est refusée', async ({
    page,
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const name = uniq('WF-32 Idempotence');
    const key = uniq('cle-wf32');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const first = await launchInstance(api, definition.wfDefinitionId, { idempotencyKey: key });

    await gotoLaunch(page);
    const modal = await openLaunchModal(page, name);
    await modal.getByLabel('Clé d’idempotence').fill(key);
    const replay = page.waitForResponse((r) => r.url().endsWith('/api/workflows/instances') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
    expect((await replay).status()).toBe(200);
    await expect(toast(page, 'Une instance existe déjà pour cette clé : la voici.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/workflows/instances/${first.wfInstanceId}$`));

    // Un autre lanceur avec la même clé : 409 IDEMPOTENCY_CONFLICT, message dédié, l'instance n'est pas révélée.
    const other = await createWfUser(api, { prefix: uniq('wf32-autre'), menus: [WF_MENUS.launch] });
    const asOther = await apiAs(other.username, other.password);
    const conflict = await asOther.raw.post('/workflows/instances', { definitionId: definition.wfDefinitionId, idempotencyKey: key });
    expect(conflict.status()).toBe(409);
    expect(JSON.stringify(await conflict.json())).not.toContain(first.wfInstanceId);

    const s = await openSessionAs(browser, loginAs, other);
    try {
      await gotoLaunch(s.page);
      const m = await openLaunchModal(s.page, name);
      await m.getByLabel('Clé d’idempotence').fill(key);
      await m.getByRole('button', { name: 'Lancer', exact: true }).click();
      await expect(
        m.getByText('Cette clé d’idempotence est déjà utilisée par un autre lanceur. Cliquez sur « Régénérer » pour en obtenir une nouvelle.'),
      ).toBeVisible();
      // « Régénérer » propose une nouvelle clé : le lancement aboutit.
      await m.getByRole('button', { name: 'Régénérer' }).click();
      await expect(m.getByLabel('Clé d’idempotence')).not.toHaveValue(key);
      await m.getByRole('button', { name: 'Lancer', exact: true }).click();
      await expect(s.page).toHaveURL(/\/workflows\/instances\/\d+$/);
    } finally {
      await s.close();
    }
  });

  test('WF-33 Sans le menu lancer : écran refusé et lancement refusé par l’API (403)', async ({ api, apiAs, browser, loginAs, uniq }) => {
    const designer = await createWfUser(api, { prefix: uniq('wf33-concepteur'), menus: [WF_MENUS.design] });
    const nobody = await createWfUser(api, { prefix: uniq('wf33-aucun'), menus: [] });
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-33 Réservé'), graph: singleFormGraph() });

    const asDesigner = await apiAs(designer.username, designer.password);
    // La conception lit le catalogue lançable, mais ne lance pas.
    expect((await asDesigner.raw.get('/workflows/definitions/launchable')).status()).toBe(200);
    expect((await asDesigner.raw.post('/workflows/instances', { definitionId: definition.wfDefinitionId })).status()).toBe(403);
    const asNobody = await apiAs(nobody.username, nobody.password);
    expect((await asNobody.raw.get('/workflows/definitions/launchable')).status()).toBe(403);
    expect((await asNobody.raw.post('/workflows/instances', { definitionId: definition.wfDefinitionId })).status()).toBe(403);

    for (const user of [designer, nobody]) {
      const s = await openSessionAs(browser, loginAs, user);
      try {
        await s.page.goto('/workflows/lancer');
        await expect(
          s.page.getByText('Accès refusé. Votre rôle ne permet pas de lancer des workflows. Demandez l’accès à un administrateur.'),
        ).toBeVisible();
        await expect(s.page.getByRole('button', { name: /^Lancer le workflow / })).toHaveCount(0);
      } finally {
        await s.close();
      }
    }
  });
});
