// Docu-Flow : suivi des instances, détail, administration des instances (scénarios WF-50 à WF-57).
// Sélecteurs : apps/web/app/workflows/instances/** et administration/page.tsx (InstancesView scope « all »).

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import {
  WF_INSTANCE_STATUS,
  WF_MENUS,
  approvalCircuitGraph,
  completeItem,
  createPublishedDefinition,
  findInboxEntry,
  launchInstance,
  singleFormGraph,
  waitForInstanceStatus,
  type WfInstanceDto,
} from '../_helpers/wf-api';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import { checkRadioButton, chooseSelectOption, eventJournal, gotoInstance, instanceFact, toast } from '../_helpers/ui';

/** Ligne du tableau des instances (vue bureau) dont le lien « N° » est l'identifiant. */
function instanceRow(page: Page, instanceId: string) {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name: instanceId, exact: true }) });
}

async function gotoList(page: Page, path: '/workflows/instances' | '/workflows/administration'): Promise<void> {
  const loaded = page.waitForResponse((r) => /\/api\/workflows\/instances\?/.test(r.url()) && r.request().method() === 'GET');
  await page.goto(path);
  await loaded;
}

test.describe('Docu-Flow : suivi des instances', () => {
  test('WF-50 « Suivi des workflows » ne montre que mes instances, avec le nom du workflow et le filtre de statut', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const launcher = await createWfUser(api, { prefix: uniq('wf50-lanceur'), menus: [WF_MENUS.launch] });
    const name = uniq('WF-50 Suivi');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const asLauncher = await apiAs(launcher.username, launcher.password);
    const mineOpen = await launchInstance(asLauncher, definition.wfDefinitionId);
    const mineDone = await launchInstance(asLauncher, definition.wfDefinitionId);
    const entry = await findInboxEntry(asLauncher, mineDone.wfInstanceId, 'saisie');
    await completeItem(asLauncher, entry.item.wfInboxItemId, { values: { objet: 'Clos' } });
    await waitForInstanceStatus(api, mineDone.wfInstanceId, WF_INSTANCE_STATUS.completed);
    const notMine = await launchInstance(api, definition.wfDefinitionId); // lancée par l'administrateur

    const s = await openSessionAs(browser, loginAs, launcher);
    try {
      await gotoList(s.page, '/workflows/instances');
      await expect(s.page.getByRole('heading', { name: 'Suivi des workflows' })).toBeVisible();
      await expect(instanceRow(s.page, mineOpen.wfInstanceId).getByRole('cell', { name, exact: true })).toBeVisible();
      await expect(instanceRow(s.page, mineOpen.wfInstanceId).getByText('En attente')).toBeVisible();
      await expect(instanceRow(s.page, mineDone.wfInstanceId).getByText('Terminée')).toBeVisible();
      await expect(instanceRow(s.page, notMine.wfInstanceId)).toHaveCount(0);

      const filtered = s.page.waitForResponse((r) => /\/api\/workflows\/instances\?.*status=2/.test(r.url()));
      await chooseSelectOption(s.page, 'Statut', 'Terminée');
      await filtered;
      await expect(instanceRow(s.page, mineDone.wfInstanceId)).toBeVisible();
      await expect(instanceRow(s.page, mineOpen.wfInstanceId)).toHaveCount(0);

      // Le lien « Détail » ouvre le suivi de l'instance.
      await instanceRow(s.page, mineDone.wfInstanceId).getByRole('link', { name: mineDone.wfInstanceId, exact: true }).click();
      await expect(s.page).toHaveURL(new RegExp(`/workflows/instances/${mineDone.wfInstanceId}$`));
      await expect(instanceFact(s.page, 'Statut')).toHaveText('Terminée');
    } finally {
      await s.close();
    }

    // Côté API : sans menu d'administration, la liste est restreinte aux instances du lanceur.
    const { items } = await asLauncher.get<{ items: WfInstanceDto[] }>(`/workflows/instances?definitionId=${definition.wfDefinitionId}`);
    expect(items.map((i) => i.wfInstanceId).sort()).toEqual([mineOpen.wfInstanceId, mineDone.wfInstanceId].sort());
  });

  test('WF-51 Sans menu lancer ni administration : suivi refusé (écran et API 403)', async ({ api, apiAs, browser, loginAs, uniq }) => {
    const designer = await createWfUser(api, { prefix: uniq('wf51-concepteur'), menus: [WF_MENUS.design] });
    const asDesigner = await apiAs(designer.username, designer.password);
    expect((await asDesigner.raw.get('/workflows/instances?mine=true')).status()).toBe(403);
    const s = await openSessionAs(browser, loginAs, designer);
    try {
      await s.page.goto('/workflows/instances');
      await expect(s.page.getByText('Accès refusé. Votre rôle ne donne pas accès à Docu-Flow. Demandez l’accès à un administrateur.')).toBeVisible();
      await s.page.goto('/workflows/administration');
      await expect(
        s.page.getByText(
          'Accès refusé. Votre rôle ne donne pas accès à l’administration des workflows. Demandez l’accès à un administrateur.',
        ),
      ).toBeVisible();
    } finally {
      await s.close();
    }
  });

  test('WF-52 Détail : l’assigné non lanceur lit sans pouvoir agir ; un tiers reçoit « introuvable » (404)', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const launcher = await createWfUser(api, { prefix: uniq('wf52-lanceur'), menus: [WF_MENUS.launch] });
    const assignee = await createWfUser(api, { prefix: uniq('wf52-assigne'), menus: [WF_MENUS.launch] });
    const stranger = await createWfUser(api, { prefix: uniq('wf52-tiers'), menus: [WF_MENUS.launch] });
    const name = uniq('WF-52 Détail');
    const { definition } = await createPublishedDefinition(api, {
      name,
      graph: approvalCircuitGraph({ validator: { kind: 'user', id: assignee.userGroupId } }),
    });
    const asLauncher = await apiAs(launcher.username, launcher.password);
    const instance = await launchInstance(asLauncher, definition.wfDefinitionId);
    const saisie = await findInboxEntry(asLauncher, instance.wfInstanceId, 'saisie');
    await completeItem(asLauncher, saisie.item.wfInboxItemId, { values: { objet: 'Détail' } });

    const asAssignee = await apiAs(assignee.username, assignee.password);
    expect((await asAssignee.raw.get(`/workflows/instances/${instance.wfInstanceId}`)).status()).toBe(200);
    expect((await asAssignee.raw.post(`/workflows/instances/${instance.wfInstanceId}/cancel`, {})).status()).toBe(403);
    const asStranger = await apiAs(stranger.username, stranger.password);
    expect((await asStranger.raw.get(`/workflows/instances/${instance.wfInstanceId}`)).status()).toBe(404);
    expect((await asStranger.raw.post(`/workflows/instances/${instance.wfInstanceId}/cancel`, {})).status()).toBe(404);

    const a = await openSessionAs(browser, loginAs, assignee);
    try {
      await gotoInstance(a.page, instance.wfInstanceId);
      await expect(instanceFact(a.page, 'Workflow')).toHaveText(name);
      await expect(a.page.getByRole('list', { name: 'Étapes franchies' }).getByText('Validation du responsable', { exact: true })).toBeVisible();
      for (const label of ['Annuler', 'Suspendre', 'Reprendre']) {
        await expect(a.page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
      }
    } finally {
      await a.close();
    }
    const t = await openSessionAs(browser, loginAs, stranger);
    try {
      await gotoInstance(t.page, instance.wfInstanceId);
      await expect(t.page.getByText('Instance introuvable ou hors de votre périmètre.')).toBeVisible();
      await expect(t.page.getByText(name)).toHaveCount(0);
    } finally {
      await t.close();
    }
  });

  test('WF-53 Identifiant d’instance invalide : « Instance introuvable » sans appel à l’API', async ({ page }) => {
    let called = false;
    page.on('request', (r) => {
      if (/\/api\/workflows\/instances\/[^?]/.test(r.url())) called = true;
    });
    await page.goto('/workflows/instances/abc');
    await expect(page.getByRole('heading', { name: 'Instance introuvable' })).toBeVisible();
    await expect(page.getByText('Instance introuvable ou hors de votre périmètre.')).toBeVisible();
    expect(called).toBe(false);
  });

  test('WF-54 Administration : toutes les instances, suspension puis reprise de l’instance d’un autre utilisateur', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const launcher = await createWfUser(api, { prefix: uniq('wf54-lanceur'), menus: [WF_MENUS.launch] });
    const name = uniq('WF-54 Administration');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const asLauncher = await apiAs(launcher.username, launcher.password);
    const instance = await launchInstance(asLauncher, definition.wfDefinitionId);
    await findInboxEntry(asLauncher, instance.wfInstanceId, 'saisie');

    await gotoList(page, '/workflows/administration');
    await expect(page.getByRole('heading', { name: 'Administration des workflows' })).toBeVisible();
    const row = instanceRow(page, instance.wfInstanceId);
    await expect(row.getByRole('cell', { name, exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Suspendre', exact: true }).click();
    const suspendModal = page.getByRole('dialog', { name: 'Suspendre cette instance ?' });
    await suspendModal.getByLabel('Motif (facultatif)').fill('Contrôle administratif');
    await suspendModal.getByRole('button', { name: 'Suspendre l’instance' }).click();
    await expect(toast(page, 'Instance suspendue.')).toBeVisible();
    await expect(row.getByText('Suspendue')).toBeVisible();
    await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.suspended);

    await row.getByRole('button', { name: 'Reprendre', exact: true }).click();
    await page.getByRole('dialog', { name: 'Reprendre cette instance ?' }).getByRole('button', { name: 'Reprendre l’instance' }).click();
    await expect(toast(page, 'Instance reprise.')).toBeVisible();
    await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.waitingHuman);

    // Le journal de l'instance garde la trace des deux actions et de leur auteur.
    await gotoInstance(page, instance.wfInstanceId);
    await expect(eventJournal(page).getByText('a suspendu le workflow')).toBeVisible();
    await expect(eventJournal(page).getByText('a repris le workflow')).toBeVisible();
  });

  test('WF-55 Un lanceur ne pilote pas l’instance d’un autre lanceur (API 404) et n’accède pas à l’administration', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const l1 = await createWfUser(api, { prefix: uniq('wf55-lanceur1'), menus: [WF_MENUS.launch] });
    const l2 = await createWfUser(api, { prefix: uniq('wf55-lanceur2'), menus: [WF_MENUS.launch] });
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-55 Pilotage'), graph: singleFormGraph() });
    const as1 = await apiAs(l1.username, l1.password);
    const as2 = await apiAs(l2.username, l2.password);
    const instance = await launchInstance(as1, definition.wfDefinitionId);
    for (const action of ['cancel', 'suspend']) {
      expect((await as2.raw.post(`/workflows/instances/${instance.wfInstanceId}/${action}`, {})).status()).toBe(404);
    }
    // Liste complète demandée sans menu administration : restreinte aux instances du demandeur.
    const { items } = await as2.get<{ items: WfInstanceDto[] }>(`/workflows/instances?definitionId=${definition.wfDefinitionId}`);
    expect(items).toHaveLength(0);

    const s = await openSessionAs(browser, loginAs, l2);
    try {
      await s.page.goto('/workflows/administration');
      await expect(
        s.page.getByText(
          'Accès refusé. Votre rôle ne donne pas accès à l’administration des workflows. Demandez l’accès à un administrateur.',
        ),
      ).toBeVisible();
    } finally {
      await s.close();
    }
  });

  test('WF-56 /workflows redirige vers la boîte de tâches', async ({ page }) => {
    await page.goto('/workflows');
    await expect(page).toHaveURL(/\/workflows\/boite$/);
    await expect(page.getByRole('heading', { name: 'Boîte de tâches' })).toBeVisible();
  });

  test('WF-57 Journal : compteur d’événements et ordre « Plus récent d’abord »', async ({ page, api, uniq }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-57 Journal'), graph: singleFormGraph() });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const entry = await findInboxEntry(api, instance.wfInstanceId, 'saisie');
    await completeItem(api, entry.item.wfInboxItemId, { values: { objet: 'Journal' } });
    const detail = await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
    const total = detail.events.length;

    await gotoInstance(page, instance.wfInstanceId);
    await expect(page.getByText(`${total} événements affichés sur ${total}.`)).toBeVisible();
    const items = eventJournal(page).locator('li');
    await expect(items.first()).toContainText('a démarré le workflow');
    await page.getByRole('switch', { name: 'Plus récent d’abord' }).click();
    await expect(items.first()).toContainText('a terminé le workflow');
    await checkRadioButton(page, 'Instance');
    await expect(items).toHaveCount(detail.events.filter((e) => e.eventType.startsWith('instance.')).length);
  });
});
