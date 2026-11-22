// Docu-Flow : parcours de bout en bout (scénarios WF-01 à WF-04, docs/e2e/scenarios-workflows.md).
//
// Acteurs (créés par test, avec uniq()) :
// - l'administrateur (fixture `page`/`api`) conçoit et publie ;
// - le lanceur (menu « Lancer ») lance, saisit et corrige ;
// - deux valideurs SANS menu Docu-Flow : la boîte n'exige aucun menu, l'assignation suffit
//   (docs/workflow-moteur.md section 5).
// Graphe : approvalCircuitGraph (saisie -> validation -> visa, voie de correction sur refus).

import { test, expect } from '../../../fixtures';
import {
  WF_INSTANCE_STATUS,
  WF_MENUS,
  WF_TASK_STATUS,
  approvalCircuitGraph,
  createDefinition,
  createPublishedDefinition,
  findInboxEntry,
  getInstance,
  completeItem,
  launchInstance,
  listInbox,
  rejectItem,
  waitForInstanceStatus,
} from '../_helpers/wf-api';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import {
  checkRadioButton,
  eventJournal,
  gotoEditor,
  gotoInbox,
  gotoInstance,
  instanceFact,
  openInboxItem,
  publishFromEditor,
  rejectFromDrawer,
  stepsTimeline,
  submitApproval,
  submitForm,
  toast,
} from '../_helpers/ui';

test.describe('Docu-Flow : parcours de bout en bout', () => {
  test('WF-01 Concevoir, publier, lancer, traiter à deux valideurs avec renvoi en correction, suivre jusqu’au terme', async ({
    page,
    api,
    browser,
    loginAs,
    uniq,
  }) => {
    test.slow(); // trois sessions, une douzaine d'écrans
    const launcher = await createWfUser(api, { prefix: uniq('wf01-lanceur'), menus: [WF_MENUS.launch] });
    const v1 = await createWfUser(api, { prefix: uniq('wf01-valideur1'), menus: [] });
    const v2 = await createWfUser(api, { prefix: uniq('wf01-valideur2'), menus: [] });
    const name = uniq('WF-01 Demande d’achat');

    // 1. Conception : définition créée par l'API (brouillon), publiée PAR L'ÉCRAN.
    const created = await createDefinition(api, {
      name,
      description: 'Parcours E2E : saisie, validation, correction, visa.',
      graph: approvalCircuitGraph({
        validator: { kind: 'user', id: v1.userGroupId },
        secondValidator: { kind: 'user', id: v2.userGroupId },
      }),
    });
    const definitionId = created.definition.wfDefinitionId;
    await gotoEditor(page, definitionId);
    await publishFromEditor(page, 1, 'Première version (E2E)');
    // Version publiée = lecture seule : le palette signale la lecture seule.
    await expect(page.getByText('Version en lecture seule')).toBeVisible();

    // 2. Lancement par l'écran (lanceur).
    const l = await openSessionAs(browser, loginAs, launcher);
    const v1s = await openSessionAs(browser, loginAs, v1);
    const v2s = await openSessionAs(browser, loginAs, v2);
    try {
      await l.page.goto('/workflows/lancer');
      await l.page.getByRole('button', { name: `Lancer le workflow ${name}` }).click();
      const modal = l.page.getByRole('dialog', { name: `Lancer « ${name} »` });
      await expect(modal).toBeVisible();
      await modal.getByRole('button', { name: 'Lancer', exact: true }).click();
      await expect(toast(l.page, 'Workflow lancé.')).toBeVisible();
      await expect(l.page).toHaveURL(/\/workflows\/instances\/\d+$/);
      const instanceId = l.page.url().split('/').pop() as string;

      // 3. Saisie par le lanceur (sans menu conception : formulaire générique nom / valeur).
      await gotoInbox(l.page);
      let drawer = await openInboxItem(l.page, 'Saisie de la demande', name);
      await submitForm(l.page, drawer, { objet: 'Achat de 3 scanners', montant: '1200' }, 'generic');

      // 4. Premier valideur : refus => renvoi en correction (voie conditionnée last.approved = false).
      await gotoInbox(v1s.page);
      drawer = await openInboxItem(v1s.page, 'Validation du responsable', name);
      await rejectFromDrawer(v1s.page, drawer, 'Merci de préciser le fournisseur.');
      await expect(v1s.page.getByRole('button', { name: /^Validation du responsable, Workflow / })).toHaveCount(0);

      // 5. Correction par le lanceur.
      await gotoInbox(l.page);
      drawer = await openInboxItem(l.page, 'Correction de la demande', name);
      await submitForm(l.page, drawer, { objet: 'Achat de 3 scanners (fournisseur X)', montant: '1200' }, 'generic');

      // 6. Premier valideur : second passage, approuvé.
      await gotoInbox(v1s.page);
      drawer = await openInboxItem(v1s.page, 'Validation du responsable (passage 2)', name);
      await submitApproval(v1s.page, drawer, true, 'Conforme.');

      // 7. Second valideur : visa final, approuvé => fin du workflow.
      await gotoInbox(v2s.page);
      drawer = await openInboxItem(v2s.page, 'Visa final', name);
      await submitApproval(v2s.page, drawer, true);

      // 8. Suivi par le lanceur : statut « Terminée », étapes franchies, journal lisible.
      await waitForInstanceStatus(api, instanceId, WF_INSTANCE_STATUS.completed);
      await gotoInstance(l.page, instanceId);
      await expect(instanceFact(l.page, 'Statut')).toHaveText('Terminée');
      await expect(instanceFact(l.page, 'Workflow')).toHaveText(name);
      await expect(instanceFact(l.page, 'Version')).toHaveText('Version n° 1');
      const steps = stepsTimeline(l.page);
      for (const title of [
        'Saisie de la demande',
        'Validation du responsable',
        'Correction de la demande',
        'Validation du responsable (passage 2)',
        'Visa final',
      ]) {
        await expect(steps.getByText(title, { exact: true })).toBeVisible();
      }
      const journal = eventJournal(l.page);
      await expect(journal.getByText('a démarré le workflow')).toBeVisible();
      await expect(journal.getByText('a refusé la tâche')).toBeVisible();
      await expect(journal.getByText('a terminé le workflow')).toBeVisible();
      // Filtre par famille : seules les validations restent.
      await checkRadioButton(l.page, 'Validations');
      await expect(journal.getByText('a terminé le workflow')).toHaveCount(0);
      await expect(journal.getByText('a accepté la validation')).toHaveCount(2);

      // 9. Liste « Suivi des workflows » : l'instance est terminée, au nom du workflow.
      await l.page.goto('/workflows/instances');
      const row = l.page.getByRole('row').filter({ has: l.page.getByRole('link', { name: instanceId, exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.getByRole('cell', { name, exact: true })).toBeVisible();
      await expect(row.getByText('Terminée')).toBeVisible();

      // 10. Contrôle API : journal complet et acteurs justes.
      const detail = await getInstance(api, instanceId);
      const types = detail.events.map((e) => e.eventType);
      expect(types).toContain('task.rejected');
      expect(types.filter((t) => t === 'validation.accepted')).toHaveLength(2);
      expect(types).toContain('instance.completed');
      const visa = detail.tasks.find((t) => t.stepKey === 'visa');
      expect(visa?.completedBy).toBe(v2.userGroupId);
      expect(detail.tasks.filter((t) => t.stepKey === 'validation').map((t) => t.attempt).sort()).toEqual([1, 2]);
    } finally {
      await Promise.all([l.close(), v1s.close(), v2s.close()]);
    }
  });

  test('WF-02 Refus sans voie de correction : instance suspendue, puis reprise par le lanceur', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const launcher = await createWfUser(api, { prefix: uniq('wf02-lanceur'), menus: [WF_MENUS.launch] });
    const v = await createWfUser(api, { prefix: uniq('wf02-valideur'), menus: [] });
    const name = uniq('WF-02 Visa');
    const { definition } = await createPublishedDefinition(api, {
      name,
      graph: approvalCircuitGraph({ validator: { kind: 'user', id: v.userGroupId } }),
    });
    const asLauncher = await apiAs(launcher.username, launcher.password);
    const asV = await apiAs(v.username, v.password);
    const instance = await launchInstance(asLauncher, definition.wfDefinitionId);

    // Avance jusqu'au visa par l'API.
    const saisie = await findInboxEntry(asLauncher, instance.wfInstanceId, 'saisie');
    await completeItem(asLauncher, saisie.item.wfInboxItemId, { values: { objet: 'Visa' } });
    const validation = await findInboxEntry(asV, instance.wfInstanceId, 'validation');
    await completeItem(asV, validation.item.wfInboxItemId, { approved: true });
    // Refus du visa (étape finale, aucune arête conditionnée) => suspension (docs/workflow-moteur.md 3.8).
    const visa = await findInboxEntry(asV, instance.wfInstanceId, 'visa');
    await rejectItem(asV, visa.item.wfInboxItemId, 'Pièce manquante.');
    await waitForInstanceStatus(api, instance.wfInstanceId, WF_INSTANCE_STATUS.suspended);

    const l = await openSessionAs(browser, loginAs, launcher);
    try {
      await gotoInstance(l.page, instance.wfInstanceId);
      await expect(instanceFact(l.page, 'Statut')).toHaveText('Suspendue');
      await expect(eventJournal(l.page).getByText('a suspendu le workflow')).toBeVisible();
      await l.page.getByRole('button', { name: 'Reprendre', exact: true }).click();
      const modal = l.page.getByRole('dialog', { name: 'Reprendre cette instance ?' });
      await modal.getByRole('button', { name: 'Reprendre l’instance' }).click();
      await expect(toast(l.page, 'Instance reprise.')).toBeVisible();
      await expect(instanceFact(l.page, 'Statut')).toHaveText('En attente');
    } finally {
      await l.close();
    }
    // La dernière étape est rouverte (passage 2) dans la boîte du valideur.
    const reopened = await findInboxEntry(asV, instance.wfInstanceId, 'visa');
    expect(reopened.task.attempt).toBe(2);
    expect(reopened.item.title).toBe('Visa final (passage 2)');
  });

  test('WF-03 Annulation par le lanceur : tâches annulées, boîte du valideur vidée', async ({ api, apiAs, browser, loginAs, uniq }) => {
    const launcher = await createWfUser(api, { prefix: uniq('wf03-lanceur'), menus: [WF_MENUS.launch] });
    const v = await createWfUser(api, { prefix: uniq('wf03-valideur'), menus: [] });
    const name = uniq('WF-03 Annulation');
    const { definition } = await createPublishedDefinition(api, {
      name,
      graph: approvalCircuitGraph({ validator: { kind: 'user', id: v.userGroupId } }),
    });
    const asLauncher = await apiAs(launcher.username, launcher.password);
    const asV = await apiAs(v.username, v.password);
    const instance = await launchInstance(asLauncher, definition.wfDefinitionId);
    const saisie = await findInboxEntry(asLauncher, instance.wfInstanceId, 'saisie');
    await completeItem(asLauncher, saisie.item.wfInboxItemId, { values: { objet: 'À annuler' } });
    await findInboxEntry(asV, instance.wfInstanceId, 'validation');

    const l = await openSessionAs(browser, loginAs, launcher);
    try {
      await gotoInstance(l.page, instance.wfInstanceId);
      await l.page.getByRole('button', { name: 'Annuler', exact: true }).click();
      const modal = l.page.getByRole('dialog', { name: 'Annuler cette instance ?' });
      await modal.getByLabel('Motif (facultatif)').fill('Demande retirée.');
      await modal.getByRole('button', { name: 'Annuler l’instance' }).click();
      await expect(toast(l.page, 'Instance annulée.')).toBeVisible();
      await expect(instanceFact(l.page, 'Statut')).toHaveText('Annulée');
      // État terminal : plus aucune action proposée.
      await expect(l.page.getByRole('button', { name: 'Suspendre', exact: true })).toHaveCount(0);
      await expect(l.page.getByRole('button', { name: 'Reprendre', exact: true })).toHaveCount(0);
    } finally {
      await l.close();
    }
    const detail = await getInstance(api, instance.wfInstanceId);
    expect(detail.tasks.find((t) => t.stepKey === 'validation')?.status).toBe(WF_TASK_STATUS.cancelled);
    const { items } = await listInbox(asV);
    expect(items.filter((e) => e.item.instanceId === instance.wfInstanceId)).toHaveLength(0);
  });

  test('WF-04 « Ne pas approuver » termine la validation et suit la voie conditionnée (renvoi), distinct du refus', async ({
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    const launcher = await createWfUser(api, { prefix: uniq('wf04-lanceur'), menus: [WF_MENUS.launch] });
    const v = await createWfUser(api, { prefix: uniq('wf04-valideur'), menus: [] });
    const name = uniq('WF-04 Avis négatif');
    const { definition } = await createPublishedDefinition(api, {
      name,
      graph: approvalCircuitGraph({ validator: { kind: 'user', id: v.userGroupId } }),
    });
    const asLauncher = await apiAs(launcher.username, launcher.password);
    const instance = await launchInstance(asLauncher, definition.wfDefinitionId);
    const saisie = await findInboxEntry(asLauncher, instance.wfInstanceId, 'saisie');
    await completeItem(asLauncher, saisie.item.wfInboxItemId, { values: { objet: 'Avis' } });

    const vs = await openSessionAs(browser, loginAs, v);
    try {
      await gotoInbox(vs.page);
      const drawer = await openInboxItem(vs.page, 'Validation du responsable', name);
      await submitApproval(vs.page, drawer, false, 'Montant trop élevé.');
    } finally {
      await vs.close();
    }
    // Clôture « approved: false » : validation.rejected au journal, tâche TERMINÉE (pas « rejetée »), correction ouverte.
    const correction = await findInboxEntry(asLauncher, instance.wfInstanceId, 'correction');
    expect(correction.item.title).toBe('Correction de la demande');
    const detail = await getInstance(api, instance.wfInstanceId);
    const types = detail.events.map((e) => e.eventType);
    expect(types).toContain('validation.rejected');
    expect(types).not.toContain('task.rejected');
    const validation = detail.tasks.find((t) => t.stepKey === 'validation');
    expect(validation?.status).toBe(WF_TASK_STATUS.completed);
    expect(validation?.result).toEqual({ approved: false, comment: 'Montant trop élevé.' });
  });
});
