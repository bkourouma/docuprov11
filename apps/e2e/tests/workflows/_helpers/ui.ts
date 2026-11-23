// Docu-Flow E2E : objets de page partagés (boîte de tâches, détail d'instance, éditeur, toasts).
//
// Sélecteurs tirés du code des composants :
// - carte de boîte : bouton dont le nom accessible commence par « <titre>, Workflow <nom>, étape <clé> »
//   (`entryAriaLabel`, apps/web/app/workflows/_lib/inbox-logic.ts) ;
// - tiroir : Drawer antd titré par le titre de l'élément (InboxDrawer.tsx) ;
// - formulaire : TaskForm.tsx (« Terminer la tâche », « Approuver » / « Ne pas approuver ») ;
// - refus / délégation : ActionModals.tsx (« Confirmer le refus », « Déléguer »).

import { expect, type Locator, type Page } from '@playwright/test';

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boîte de confirmation `modal.confirm` d'antd, repérée par son titre (le titre d'une confirmation n'est pas
 * toujours relié au rôle dialog : on passe par la classe antd).
 */
export function confirmDialog(page: Page, title: string): Locator {
  return page.locator('.ant-modal-confirm').filter({ has: page.locator('.ant-modal-confirm-title', { hasText: title }) });
}

/**
 * Choisit une option d'un Select antd repéré par le libellé de son combobox. Quand une valeur est déjà
 * sélectionnée, l'élément `.ant-select-selection-item` recouvre le champ de recherche : on clique le Select
 * lui-même, puis l'option (titre exact) dans la liste déroulante visible.
 */
export async function chooseSelectOption(scope: Page | Locator, label: string, option: string): Promise<void> {
  const page = 'page' in scope ? scope.page() : scope;
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: label, exact: true }) }).click();
  await page.locator('.ant-select-dropdown:visible').getByTitle(option, { exact: true }).click();
}

/**
 * Coche une option d'un Radio.Group antd en boutons (`optionType="button"`) : l'input radio est masqué, on clique
 * son libellé puis on vérifie que le radio est coché.
 */
export async function checkRadioButton(scope: Page | Locator, label: string): Promise<void> {
  await scope.locator('label.ant-radio-button-wrapper').filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`) }).click();
  await expect(scope.getByRole('radio', { name: label, exact: true })).toBeChecked();
}

/** Message antd (toast) affiché en haut de page. */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.locator('.ant-message').getByText(text);
}

// ---------------------------------------------------------------------------
// Boîte de tâches
// ---------------------------------------------------------------------------

/** Ouvre la boîte et attend la fin du premier chargement (réponse de GET /workflows/inbox). */
export async function gotoInbox(page: Page): Promise<void> {
  const loaded = page.waitForResponse((r) => /\/api\/workflows\/inbox(\?|$)/.test(r.url()) && r.request().method() === 'GET');
  await page.goto('/workflows/boite');
  await loaded;
  await expect(page.getByRole('heading', { name: 'Boîte de tâches' })).toBeVisible();
}

/** Carte d'un élément de boîte, identifiée par son titre (nom de l'étape) et le nom du workflow. */
export function inboxCard(page: Page, title: string, definitionName: string): Locator {
  return page.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(title)}, Workflow ${escapeRegExp(definitionName)}, `),
  });
}

/** Tiroir de détail ouvert (Drawer antd) dont le titre est celui de l'élément. */
export function inboxDrawer(page: Page, title: string): Locator {
  return page.locator('.ant-drawer-content').filter({ has: page.locator('.ant-drawer-title', { hasText: title }) });
}

/** Ouvre le tiroir d'un élément depuis la boîte (la boîte doit être affichée). */
export async function openInboxItem(page: Page, title: string, definitionName: string): Promise<Locator> {
  await inboxCard(page, title, definitionName).click();
  const drawer = inboxDrawer(page, title);
  await expect(drawer).toBeVisible();
  return drawer;
}

/**
 * Ouvre le formulaire de clôture (« Terminer ») du tiroir. Le bouton est désactivé tant que le détail de
 * l'instance (rowVersion) n'est pas chargé : on attend qu'il soit actif.
 */
export async function openCompleteForm(drawer: Locator): Promise<Locator> {
  const button = drawer.getByRole('button', { name: 'Terminer', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  const form = drawer.locator('form.wfb-form');
  await expect(form).toBeVisible();
  return form;
}

/** Validation : choisit « Approuver » ou « Ne pas approuver », commente, puis « Terminer la tâche ». */
export async function submitApproval(page: Page, drawer: Locator, approved: boolean, comment?: string): Promise<void> {
  const form = await openCompleteForm(drawer);
  await form.getByRole('radio', { name: approved ? 'Approuver' : 'Ne pas approuver', exact: true }).check();
  if (comment) await form.getByLabel('Commentaire (facultatif, 4 000 caractères au plus)').fill(comment);
  const done = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/complete$/.test(r.url()));
  await form.getByRole('button', { name: 'Terminer la tâche' }).click();
  expect((await done).status()).toBeLessThan(400);
  await expect(toast(page, 'Tâche terminée.')).toBeVisible();
}

/**
 * Formulaire : renseigne les champs. Avec la configuration d'étape connue (menu conception), les champs ont
 * leur libellé (« Objet (obligatoire) ») ; sinon le formulaire générique « Nom du champ n / Valeur n » est utilisé.
 */
export async function submitForm(
  page: Page,
  drawer: Locator,
  values: Record<string, string>,
  mode: 'declared' | 'generic',
  labels: Record<string, string> = {},
): Promise<void> {
  const form = await openCompleteForm(drawer);
  const entries = Object.entries(values);
  if (mode === 'declared') {
    for (const [key, value] of entries) {
      const label = labels[key] ?? key;
      await form.getByLabel(new RegExp(`^${escapeRegExp(label)}( \\(obligatoire\\))?$`)).fill(value);
    }
  } else {
    for (const [i, [key, value]] of entries.entries()) {
      if (i > 0) await form.getByRole('button', { name: 'Ajouter une ligne' }).click();
      await form.getByLabel(`Nom du champ ${i + 1}`, { exact: true }).fill(key);
      await form.getByLabel(`Valeur ${i + 1}`, { exact: true }).fill(value);
    }
  }
  const done = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/complete$/.test(r.url()));
  await form.getByRole('button', { name: 'Terminer la tâche' }).click();
  expect((await done).status()).toBeLessThan(400);
  await expect(toast(page, 'Tâche terminée.')).toBeVisible();
}

/** Rejeter depuis le tiroir (modale « Rejeter cette tâche ? »). */
export async function rejectFromDrawer(page: Page, drawer: Locator, comment?: string): Promise<void> {
  await drawer.getByRole('button', { name: 'Rejeter' }).click();
  const modal = page.getByRole('dialog', { name: 'Rejeter cette tâche ?' });
  await expect(modal).toBeVisible();
  if (comment) await modal.getByLabel('Commentaire (facultatif, 4 000 caractères au plus)').fill(comment);
  const done = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/reject$/.test(r.url()));
  await modal.getByRole('button', { name: 'Confirmer le refus' }).click();
  expect((await done).status()).toBeLessThan(400);
  await expect(toast(page, 'Tâche rejetée.')).toBeVisible();
}

/** Déléguer depuis le tiroir (modale « Déléguer cette tâche », saisie du numéro d'utilisateur). */
export async function delegateFromDrawer(page: Page, drawer: Locator, toUserGroupId: number, comment?: string): Promise<void> {
  await drawer.getByRole('button', { name: 'Déléguer' }).click();
  const modal = page.getByRole('dialog', { name: 'Déléguer cette tâche' });
  await expect(modal).toBeVisible();
  await modal.getByLabel('Numéro d’utilisateur du destinataire (obligatoire)').fill(String(toUserGroupId));
  if (comment) await modal.getByLabel('Commentaire (facultatif, 4 000 caractères au plus)').fill(comment);
  const done = page.waitForResponse((r) => /\/api\/workflows\/inbox\/\d+\/delegate$/.test(r.url()));
  await modal.getByRole('button', { name: 'Déléguer', exact: true }).click();
  expect((await done).status()).toBeLessThan(400);
  await expect(toast(page, 'Tâche déléguée.')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Détail d'une instance
// ---------------------------------------------------------------------------

/** Ouvre le détail d'une instance et attend la réponse de GET /workflows/instances/:id. */
export async function gotoInstance(page: Page, instanceId: string): Promise<void> {
  const loaded = page.waitForResponse(
    (r) => r.url().endsWith(`/api/workflows/instances/${instanceId}`) && r.request().method() === 'GET',
  );
  await page.goto(`/workflows/instances/${instanceId}`);
  await loaded;
}

/** Valeur d'un fait de l'en-tête (« Statut », « Workflow », « Version »…). */
export function instanceFact(page: Page, label: string): Locator {
  // La carte antd porte `aria-label` sur une div (pas de rôle « region ») : sélecteur d'attribut.
  return page
    .locator('[aria-label="Informations de l’instance"]')
    .locator('.wfi-fact')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) })
    .locator('dd');
}

/** Liste « Étapes franchies » et « Journal des événements ». */
export function stepsTimeline(page: Page): Locator {
  return page.getByRole('list', { name: 'Étapes franchies' });
}

export function eventJournal(page: Page): Locator {
  return page.getByRole('list', { name: 'Journal des événements' });
}

// ---------------------------------------------------------------------------
// Éditeur de définitions
// ---------------------------------------------------------------------------

/** Ouvre l'éditeur d'une définition et attend son chargement (barre d'outils visible). */
export async function gotoEditor(page: Page, definitionId: number): Promise<void> {
  const loaded = page.waitForResponse(
    (r) => r.url().endsWith(`/api/workflows/definitions/${definitionId}`) && r.request().method() === 'GET',
  );
  await page.goto(`/workflows/conception/${definitionId}`);
  await loaded;
  await expect(page.getByRole('toolbar', { name: 'Actions de l’éditeur' })).toBeVisible();
}

/** Barre d'outils de l'éditeur. */
export function editorToolbar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'Actions de l’éditeur' });
}

/** Publie depuis l'éditeur : bouton « Publier », modale « Publier la version n° N ? », note facultative. */
export async function publishFromEditor(page: Page, versionNumber: number, note?: string): Promise<void> {
  const publishButton = editorToolbar(page).getByRole('button', { name: 'Publier', exact: true });
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  const modal = page.getByRole('dialog', { name: `Publier la version n° ${versionNumber} ?` });
  await expect(modal).toBeVisible();
  if (note !== undefined) await modal.getByLabel('Note de version (facultative)').fill(note);
  const published = page.waitForResponse((r) => /\/api\/workflows\/definitions\/\d+\/publish$/.test(r.url()));
  await modal.getByRole('button', { name: 'Publier', exact: true }).click();
  expect((await published).status()).toBe(200);
  await expect(toast(page, `Version n° ${versionNumber} publiée. Elle est désormais immuable.`)).toBeVisible();
}
