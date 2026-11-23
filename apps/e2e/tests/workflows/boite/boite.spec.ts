// Docu-Flow : boîte de tâches (scénarios WF-34 à WF-46).
//
// La boîte n'a pas de menu : le périmètre est l'assignation (utilisateur, groupe, rôle). Les identifiants d'action
// sont ceux des ÉLÉMENTS de boîte. Sélecteurs : apps/web/app/workflows/boite/** (voir _helpers/ui.ts).

import { test, expect } from '../../../fixtures';
import {
  WF_INSTANCE_STATUS,
  WF_MENUS,
  WF_TASK_STATUS,
  claimItem,
  completeItem,
  createPublishedDefinition,
  findInboxEntry,
  getInstance,
  launchInstance,
  listInbox,
  singleFormGraph,
  suspendInstance,
  waitForInstanceStatus,
  type WfGraph,
} from '../_helpers/wf-api';
import { adminUserGroupId, createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import {
  chooseSelectOption,
  delegateFromDrawer,
  gotoInbox,
  inboxCard,
  openCompleteForm,
  openInboxItem,
  submitForm,
  toast,
} from '../_helpers/ui';

test.describe('Docu-Flow : boîte de tâches', () => {
  test('WF-34 La boîte liste l’élément assigné ; filtres de statut et de texte', async ({ page, api, uniq }) => {
    const name = uniq('WF-34 Boîte');
    const other = uniq('WF-34 Autre');
    const a = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const b = await createPublishedDefinition(api, { name: other, graph: singleFormGraph() });
    const open = await launchInstance(api, a.definition.wfDefinitionId);
    const done = await launchInstance(api, b.definition.wfDefinitionId);
    const doneEntry = await findInboxEntry(api, done.wfInstanceId, 'saisie');
    await completeItem(api, doneEntry.item.wfInboxItemId, { values: { objet: 'Clos' } });
    await findInboxEntry(api, open.wfInstanceId, 'saisie');

    await gotoInbox(page);
    await expect(inboxCard(page, 'Saisie de la demande', name)).toBeVisible();
    await expect(inboxCard(page, 'Saisie de la demande', other)).toHaveCount(0); // terminé : hors « À traiter »

    // Statut « Terminées » (envoyé à l'API : status=2).
    const reloaded = page.waitForResponse((r) => /\/api\/workflows\/inbox\?.*status=2/.test(r.url()));
    await chooseSelectOption(page, 'Statut', 'Terminées');
    await reloaded;
    await expect(inboxCard(page, 'Saisie de la demande', other)).toBeVisible();
    await expect(inboxCard(page, 'Saisie de la demande', name)).toHaveCount(0);

    // Recherche texte (côté client) puis réinitialisation.
    await page.getByRole('textbox', { name: 'Recherche', exact: true }).fill('aucun-resultat-wf34');
    await expect(page.getByText('Aucun résultat pour ces filtres')).toBeVisible();
    await page.getByRole('button', { name: 'Réinitialiser' }).first().click();
    await expect(inboxCard(page, 'Saisie de la demande', name)).toBeVisible();
  });

  test('WF-35 Prendre en charge puis terminer un formulaire aux champs déclarés ; champ obligatoire manquant signalé', async ({
    page,
    api,
    uniq,
  }) => {
    const name = uniq('WF-35 Formulaire');
    const { definition } = await createPublishedDefinition(api, {
      name,
      graph: singleFormGraph({ fields: [{ key: 'objet', label: 'Objet', required: true }, { key: 'service', label: 'Service' }] }),
    });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    await findInboxEntry(api, instance.wfInstanceId, 'saisie');

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Saisie de la demande', name);
    await drawer.getByRole('button', { name: 'Prendre en charge' }).click();
    await expect(toast(page, 'Tâche prise en charge.')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Prendre en charge' })).toHaveCount(0);

    // L'administrateur a le menu conception : les champs déclarés sont affichés avec leur libellé.
    const form = await openCompleteForm(drawer);
    await form.getByLabel('Service').fill('Courrier');
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(form.getByText('Le champ « Objet » est obligatoire.')).toBeVisible();
    await form.getByRole('button', { name: 'Annuler' }).click();

    await submitForm(page, drawer, { objet: 'Demande WF-35', service: 'Courrier' }, 'declared', { objet: 'Objet', service: 'Service' });
    const detail = await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
    expect(detail.tasks[0]?.result).toEqual({ values: { objet: 'Demande WF-35', service: 'Courrier' } });
    expect(detail.events.map((e) => e.eventType)).toContain('task.claimed');
  });

  test('WF-36 Checklist : les éléments obligatoires doivent être cochés', async ({ page, api, uniq }) => {
    const name = uniq('WF-36 Checklist');
    const graph: WfGraph = {
      schemaVersion: 1,
      start: 'controle',
      steps: [
        {
          key: 'controle',
          name: 'Contrôle des pièces',
          type: 'checklist',
          assignee: { kind: 'initiator' },
          config: {
            items: [
              { key: 'signature', label: 'Signature présente', required: true },
              { key: 'annexe', label: 'Annexe jointe' },
            ],
          },
          next: [],
        },
      ],
    };
    const { definition } = await createPublishedDefinition(api, { name, graph });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    await findInboxEntry(api, instance.wfInstanceId, 'controle');

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Contrôle des pièces', name);
    const form = await openCompleteForm(drawer);
    await form.getByRole('checkbox', { name: 'Annexe jointe' }).check();
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(form.getByText('L’élément « Signature présente » doit être coché.')).toBeVisible();
    await form.getByRole('checkbox', { name: 'Signature présente (obligatoire)' }).check();
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(toast(page, 'Tâche terminée.')).toBeVisible();
    const detail = await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
    expect((detail.tasks[0]?.result as { checked: string[] }).checked.sort()).toEqual(['annexe', 'signature']);
  });

  test('WF-37 Décision manuelle : le choix saisi oriente vers la branche correspondante', async ({ page, api, uniq }) => {
    const name = uniq('WF-37 Décision');
    const graph: WfGraph = {
      schemaVersion: 1,
      start: 'orienter',
      steps: [
        {
          key: 'orienter',
          name: 'Orienter le dossier',
          type: 'decision',
          assignee: { kind: 'initiator' },
          // Contrat de l'API (interpreter.ts, étape « decision ») : `choices` est une liste de chaînes.
          config: { manual: true, choices: ['juridique', 'finances'] },
          next: [
            { to: 'juridique', label: 'Juridique', condition: { field: 'last.choice', op: 'eq', value: 'juridique' } },
            { to: 'finances', label: 'Finances', condition: { field: 'last.choice', op: 'eq', value: 'finances' } },
          ],
        },
        { key: 'juridique', name: 'Avis juridique', type: 'formulaire', assignee: { kind: 'initiator' }, next: [] },
        { key: 'finances', name: 'Avis financier', type: 'formulaire', assignee: { kind: 'initiator' }, next: [] },
      ],
    };
    const { definition } = await createPublishedDefinition(api, { name, graph });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    await findInboxEntry(api, instance.wfInstanceId, 'orienter');

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Orienter le dossier', name);
    const form = await openCompleteForm(drawer);
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(form.getByText('Choisissez une décision.')).toBeVisible();
    await form.getByRole('radio', { name: 'finances', exact: true }).check();
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(toast(page, 'Tâche terminée.')).toBeVisible();

    const next = await findInboxEntry(api, instance.wfInstanceId, 'finances');
    expect(next.item.title).toBe('Avis financier');
    const detail = await getInstance(api, instance.wfInstanceId);
    expect(detail.tasks.some((t) => t.stepKey === 'juridique')).toBe(false);
  });

  test('WF-38 Déléguer une tâche à un autre utilisateur par l’écran', async ({ page, api, apiAs, browser, loginAs, uniq }) => {
    const name = uniq('WF-38 Délégation');
    const delegate = await createWfUser(api, { prefix: uniq('wf38-delegataire'), menus: [] });
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const entry = await findInboxEntry(api, instance.wfInstanceId, 'saisie');

    // Délégation à soi-même refusée (422) : la tâche reste à l'administrateur.
    const self = await api.raw.post(`/workflows/inbox/${entry.item.wfInboxItemId}/delegate`, {
      toUserGroupId: await adminUserGroupId(api),
    });
    expect(self.status()).toBe(422);

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Saisie de la demande', name);
    await delegateFromDrawer(page, drawer, delegate.userGroupId, 'Merci de traiter.');
    await expect(inboxCard(page, 'Saisie de la demande', name)).toHaveCount(0);

    const asDelegate = await apiAs(delegate.username, delegate.password);
    const received = await findInboxEntry(asDelegate, instance.wfInstanceId, 'saisie');
    expect(received.item.assigneeUserGroupId).toBe(delegate.userGroupId);
    const detail = await getInstance(api, instance.wfInstanceId);
    expect(detail.events.map((e) => e.eventType)).toContain('task.delegated');

    // Le délégataire (sans menu conception) termine par le formulaire générique.
    const s = await openSessionAs(browser, loginAs, delegate);
    try {
      await gotoInbox(s.page);
      const d = await openInboxItem(s.page, 'Saisie de la demande', name);
      await submitForm(s.page, d, { objet: 'Traité par délégation' }, 'generic');
    } finally {
      await s.close();
    }
    await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
  });

  test('WF-39 Délégation : destinataire vide ou inconnu signalé dans la modale', async ({ page, api, uniq }) => {
    const name = uniq('WF-39 Délégation invalide');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    await findInboxEntry(api, instance.wfInstanceId, 'saisie');

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Saisie de la demande', name);
    await drawer.getByRole('button', { name: 'Déléguer' }).click();
    const modal = page.getByRole('dialog', { name: 'Déléguer cette tâche' });
    await modal.getByRole('button', { name: 'Déléguer', exact: true }).click();
    await expect(modal.getByText('Saisissez le numéro d’utilisateur du destinataire.')).toBeVisible();
    await expect(modal.getByLabel('Numéro d’utilisateur du destinataire (obligatoire)')).toHaveAttribute('aria-invalid', 'true');
    await modal.getByLabel('Numéro d’utilisateur du destinataire (obligatoire)').fill('2147483000');
    const refused = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/delegate$/.test(r.url()));
    await modal.getByRole('button', { name: 'Déléguer', exact: true }).click();
    expect((await refused).status()).toBe(422);
    await expect(modal.getByText('Le destinataire de la délégation doit être un utilisateur actif.') /* inbox.service.ts:71 */).toBeVisible();
  });

  test('WF-40 La tâche d’autrui est invisible et inaccessible (404), y compris pour l’administrateur', async ({ api, apiAs, uniq }) => {
    const owner = await createWfUser(api, { prefix: uniq('wf40-titulaire'), menus: [] });
    const stranger = await createWfUser(api, { prefix: uniq('wf40-tiers'), menus: [WF_MENUS.launch] });
    const { definition } = await createPublishedDefinition(api, {
      name: uniq('WF-40 Périmètre'),
      graph: singleFormGraph({ assignee: { kind: 'user', id: owner.userGroupId } }),
    });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const asOwner = await apiAs(owner.username, owner.password);
    const entry = await findInboxEntry(asOwner, instance.wfInstanceId, 'saisie');
    const itemId = entry.item.wfInboxItemId;

    const asStranger = await apiAs(stranger.username, stranger.password);
    expect((await listInbox(asStranger)).items.some((e) => e.item.instanceId === instance.wfInstanceId)).toBe(false);
    for (const client of [asStranger, api]) {
      expect((await client.raw.post(`/workflows/inbox/${itemId}/claim`, {})).status()).toBe(404);
      expect((await client.raw.post(`/workflows/inbox/${itemId}/complete`, { result: { values: { objet: 'x' } } })).status()).toBe(404);
      expect((await client.raw.post(`/workflows/inbox/${itemId}/reject`, {})).status()).toBe(404);
    }
    // Le tiers ne lit pas non plus l'instance (ni lanceur, ni assigné).
    expect((await asStranger.raw.get(`/workflows/instances/${instance.wfInstanceId}`)).status()).toBe(404);
    const detail = await getInstance(api, instance.wfInstanceId);
    expect(detail.tasks[0]?.status).toBe(WF_TASK_STATUS.open);
  });

  test('WF-41 Tâche assignée à un rôle : visible par chaque membre ; prise par l’un, refusée à l’autre (409)', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const m1 = await createWfUser(api, { prefix: uniq('wf41-membre1'), menus: [] });
    // Second membre sur le MÊME rôle : on lui donne le rôle du premier.
    const m2 = await createWfUser(api, { prefix: uniq('wf41-membre2'), menus: [] });
    await api.patch(`/users/${m2.userId}`, { roleId: m1.roleId });
    const name = uniq('WF-41 Rôle');
    const { definition } = await createPublishedDefinition(api, {
      name,
      graph: singleFormGraph({ assignee: { kind: 'role', id: m1.roleId } }),
    });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const as1 = await apiAs(m1.username, m1.password);
    const as2 = await apiAs(m2.username, m2.password);
    const e1 = await findInboxEntry(as1, instance.wfInstanceId, 'saisie');
    const e2 = await findInboxEntry(as2, instance.wfInstanceId, 'saisie');
    expect(e2.item.wfInboxItemId).toBe(e1.item.wfInboxItemId);

    const s1 = await openSessionAs(browser, loginAs, m1);
    try {
      await gotoInbox(s1.page);
      const drawer = await openInboxItem(s1.page, 'Saisie de la demande', name);
      await drawer.getByRole('button', { name: 'Prendre en charge' }).click();
      await expect(toast(s1.page, 'Tâche prise en charge.')).toBeVisible();
    } finally {
      await s1.close();
    }
    const refused = await as2.raw.post(`/workflows/inbox/${e2.item.wfInboxItemId}/complete`, { result: { values: { objet: 'x' } } });
    expect(refused.status()).toBe(409);
    await completeItem(as1, e1.item.wfInboxItemId, { values: { objet: 'Traité par le membre 1' } });
    await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
  });

  test('WF-42 Instance suspendue : la boîte n’offre plus d’action et l’API refuse (409)', async ({ page, api, uniq }) => {
    const name = uniq('WF-42 Suspendue');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const entry = await findInboxEntry(api, instance.wfInstanceId, 'saisie');
    await suspendInstance(api, instance.wfInstanceId, 'Pause E2E');

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Saisie de la demande', name);
    await expect(drawer.getByText('Le workflow est suspendu : aucune action n’est possible tant qu’il n’est pas repris.')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Terminer', exact: true })).toHaveCount(0);
    const refused = await api.raw.post(`/workflows/inbox/${entry.item.wfInboxItemId}/complete`, { result: { values: { objet: 'x' } } });
    expect(refused.status()).toBe(409);
  });

  test('WF-43 État périmé : une clôture avec une version d’instance dépassée est refusée (409) puis réussit après actualisation', async ({
    page,
    api,
    uniq,
  }) => {
    const name = uniq('WF-43 Conflit');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    await findInboxEntry(api, instance.wfInstanceId, 'saisie');

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Saisie de la demande', name);
    const form = await openCompleteForm(drawer);
    // Pendant la saisie, l'état serveur change (prise en charge par l'API) : rowVersion du tiroir périmée.
    const entry = await findInboxEntry(api, instance.wfInstanceId, 'saisie');
    await claimItem(api, entry.item.wfInboxItemId);
    await form.getByLabel(/^Objet/).fill('Conflit');
    const refused = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/complete$/.test(r.url()));
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    // Le tiroir relit l'instance (nouvelle rowVersion) après l'actualisation déclenchée par le 409.
    const reread = page.waitForResponse(
      (r) => r.url().endsWith(`/api/workflows/instances/${instance.wfInstanceId}`) && r.request().method() === 'GET',
    );
    expect((await refused).status()).toBe(409);
    await expect(toast(page, 'Actualisation…')).toBeVisible();
    await reread;
    // La saisie est conservée ; la nouvelle tentative aboutit.
    await expect(form.getByLabel(/^Objet/)).toHaveValue('Conflit');
    const accepted = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/complete$/.test(r.url()));
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    expect((await accepted).status()).toBe(200);
    await expect(toast(page, 'Tâche terminée.')).toBeVisible();
    await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
  });

  test('WF-44 Validation d’agent : sans IA, l’étape agent revient à son bénéficiaire humain dans la boîte', async ({ page, api, uniq }) => {
    const name = uniq('WF-44 Agent');
    const graph: WfGraph = {
      schemaVersion: 1,
      start: 'analyse',
      steps: [
        {
          key: 'analyse',
          name: 'Analyse du dossier',
          type: 'agent',
          assignee: { kind: 'initiator' },
          agent: { objective: 'Résumer le dossier et proposer une suite.', tools: [], confidenceThreshold: 0.8, autonomy: 'suggere' },
          next: [],
        },
      ],
    };
    const { definition } = await createPublishedDefinition(api, { name, graph });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const entry = await findInboxEntry(api, instance.wfInstanceId, 'analyse');
    expect(entry.item.kind).toBe(0); // tâche humaine, pas une proposition d'agent

    await gotoInbox(page);
    const drawer = await openInboxItem(page, 'Analyse du dossier', name);
    await expect(drawer.getByText('Tâche humaine')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Accepter la proposition' })).toHaveCount(0);
    const form = await openCompleteForm(drawer);
    await form.getByLabel('Résultat (objet JSON)').fill('{"suite": "classer"}');
    await form.getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(toast(page, 'Tâche terminée.')).toBeVisible();
    const detail = await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.completed);
    expect(detail.events.map((e) => e.eventType)).toContain('agent.escalated');
  });

  test('WF-45 Échéance dépassée : carte « En retard de … » mise en évidence', async ({ page, api, uniq }) => {
    // L'échéance minimale d'une étape est d'une heure (dueInHours >= 1) et le retard est calculé avec l'horloge du
    // navigateur (_lib/format.ts, dueInfo) : on fixe l'heure de la page trois heures plus tard. `setFixedTime` ne fige
    // que Date, les minuteries et le réseau de la page continuent normalement.
    const name = uniq('WF-45 Retard');
    const graph: WfGraph = {
      schemaVersion: 1,
      start: 'saisie',
      steps: [
        { key: 'saisie', name: 'Saisie à échéance', type: 'formulaire', assignee: { kind: 'initiator' }, dueInHours: 1, next: [] },
      ],
    };
    const { definition } = await createPublishedDefinition(api, { name, graph });
    const instance = await launchInstance(api, definition.wfDefinitionId);
    const entry = await findInboxEntry(api, instance.wfInstanceId, 'saisie');
    expect(entry.item.dueAt).not.toBeNull();

    await page.clock.setFixedTime(new Date(Date.parse(entry.item.dueAt as string) + 2 * 3600_000 + 60_000));
    await gotoInbox(page);
    const card = inboxCard(page, 'Saisie à échéance', name);
    await expect(card).toHaveClass(/wfb-card--overdue/);
    await expect(card.getByText(/^En retard de 2 h$/)).toBeVisible();
  });

  test.fixme('WF-46 Relance et escalade d’une tâche par le worker', async () => {
    // P3. Les minuteries (relance, échéance, escalade) sont consommées par le worker toutes les 15 s et s'arment au
    // plus tôt une heure après l'entrée dans l'étape : non reproductible sans manipuler wf_timer.fire_at en base,
    // ce que le contrat des fixtures n'offre pas. Couvert par les tests d'intégration du worker.
  });
});
