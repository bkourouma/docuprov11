// Docu-Flow : liste des définitions, création, archivage, droits (scénarios WF-10 à WF-14).

import type { Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import {
  WF_DEFINITION_STATUS,
  WF_MENUS,
  createDefinition,
  createPublishedDefinition,
  singleFormGraph,
  type WfDefinitionDto,
} from '../_helpers/wf-api';
import { createWfUser } from '../_helpers/users';
import { openSessionAs } from '../_helpers/session';
import { chooseSelectOption, confirmDialog, toast } from '../_helpers/ui';

/** Ouvre la liste et attend GET /workflows/definitions. */
async function gotoDefinitions(page: Page): Promise<void> {
  const loaded = page.waitForResponse((r) => /\/api\/workflows\/definitions(\?|$)/.test(r.url()) && r.request().method() === 'GET');
  await page.goto('/workflows/conception');
  await loaded;
}

/** Ligne du tableau des définitions (vue bureau) portant ce nom. */
function definitionRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name: `Ouvrir le workflow ${name}` }) });
}

test.describe('Docu-Flow : conception, liste des définitions', () => {
  test('WF-10 La liste affiche les définitions avec leur statut, la recherche et le filtre de statut', async ({ page, api, uniq }) => {
    const draftName = uniq('WF-10 Brouillon');
    const publishedName = uniq('WF-10 Publié');
    await createDefinition(api, { name: draftName, description: 'Description WF-10', graph: singleFormGraph() });
    await createPublishedDefinition(api, { name: publishedName, graph: singleFormGraph() });

    await gotoDefinitions(page);
    await expect(page.getByRole('heading', { name: 'Conception des workflows' })).toBeVisible();
    await expect(definitionRow(page, draftName).getByText('Brouillon', { exact: true })).toBeVisible();
    await expect(definitionRow(page, draftName).getByText('Description WF-10')).toBeVisible();
    await expect(definitionRow(page, publishedName).getByText('Publié', { exact: true })).toBeVisible();

    // Recherche par nom (côté client).
    await page.getByLabel('Rechercher un workflow').fill(draftName);
    await expect(definitionRow(page, draftName)).toBeVisible();
    await expect(definitionRow(page, publishedName)).toHaveCount(0);
    await page.getByLabel('Rechercher un workflow').fill('');

    // Filtre de statut « Publié ».
    await chooseSelectOption(page, 'Statut', 'Publié');
    await expect(definitionRow(page, publishedName)).toBeVisible();
    await expect(definitionRow(page, draftName)).toHaveCount(0);
  });

  test('WF-11 Créer un workflow par l’écran ouvre l’éditeur sur un brouillon', async ({ page, api, uniq }) => {
    const name = uniq('WF-11 Nouveau');
    await gotoDefinitions(page);
    await page.getByRole('button', { name: 'Nouveau workflow' }).click();
    const modal = page.getByRole('dialog', { name: 'Nouveau workflow' });
    await modal.getByLabel('Nom du workflow').fill(name);
    await modal.getByLabel('Description (facultative)').fill('Créé par le test WF-11');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/workflows/definitions') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Créer et ouvrir' }).click();
    expect((await created).status()).toBe(201);
    // L'éditeur reporte la version ouverte dans l'URL (`?version=n`).
    await expect(page).toHaveURL(/\/workflows\/conception\/\d+(\?version=1)?$/);
    await expect(page.getByRole('toolbar', { name: 'Actions de l’éditeur' })).toBeVisible();

    const id = Number(new URL(page.url()).pathname.split('/').pop());
    const list = await api.get<WfDefinitionDto[]>('/workflows/definitions');
    const def = list.find((d) => d.wfDefinitionId === id);
    expect(def?.name).toBe(name);
    expect(def?.status).toBe(WF_DEFINITION_STATUS.draft);
  });

  test('WF-12 Création : nom obligatoire et nom déjà utilisé sont signalés sans rien créer', async ({ page, api, uniq }) => {
    const taken = uniq('WF-12 Pris');
    await createDefinition(api, { name: taken, graph: singleFormGraph() });
    // D'autres specs créent des définitions en parallèle : on trace les POST de l'écran au lieu de compter la liste.
    const posts: number[] = [];
    page.on('response', (r) => {
      if (r.url().endsWith('/api/workflows/definitions') && r.request().method() === 'POST') posts.push(r.status());
    });

    await gotoDefinitions(page);
    await page.getByRole('button', { name: 'Nouveau workflow' }).click();
    const modal = page.getByRole('dialog', { name: 'Nouveau workflow' });
    await modal.getByLabel('Nom du workflow').fill('   ');
    await modal.getByRole('button', { name: 'Créer et ouvrir' }).click();
    await expect(modal.getByText('Le nom est obligatoire (1 à 200 caractères).')).toBeVisible();
    expect(posts).toEqual([]); // nom vide : refusé avant tout appel

    await modal.getByLabel('Nom du workflow').fill(taken);
    const refused = page.waitForResponse((r) => r.url().endsWith('/api/workflows/definitions') && r.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Créer et ouvrir' }).click();
    expect((await refused).status()).toBe(409);
    await expect(modal.getByText('Ce nom est déjà utilisé par un autre workflow. Choisissez-en un autre.')).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/conception$/);
    expect(posts).toEqual([409]);
    expect((await api.get<WfDefinitionDto[]>('/workflows/definitions')).filter((d) => d.name === taken)).toHaveLength(1);
  });

  test('WF-13 Archiver depuis la liste : statut « Archivé », le workflow n’est plus lançable', async ({ page, api, uniq }) => {
    const name = uniq('WF-13 À archiver');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });

    await gotoDefinitions(page);
    await page.getByRole('button', { name: `Archiver le workflow ${name}` }).click();
    const confirm = confirmDialog(page, `Archiver « ${name} » ?`);
    await confirm.getByRole('button', { name: 'Archiver', exact: true }).click();
    await expect(toast(page, `Workflow « ${name} » archivé.`)).toBeVisible();
    await expect(definitionRow(page, name).getByText('Archivé')).toBeVisible();

    const launchable = await api.get<WfDefinitionDto[]>('/workflows/definitions/launchable');
    expect(launchable.some((d) => d.wfDefinitionId === definition.wfDefinitionId)).toBe(false);
    const launch = await api.raw.post('/workflows/instances', { definitionId: definition.wfDefinitionId });
    expect(launch.status()).toBe(409); // DEFINITION_NOT_PUBLISHED
  });

  test('WF-14 Sans le menu conception : écran refusé et API 403', async ({ api, apiAs, browser, loginAs, uniq }) => {
    const user = await createWfUser(api, { prefix: uniq('wf14-lanceur'), menus: [WF_MENUS.launch] });
    const { definition } = await createDefinition(api, { name: uniq('WF-14 Caché'), graph: singleFormGraph() });

    const asUser = await apiAs(user.username, user.password);
    expect((await asUser.raw.get('/workflows/definitions')).status()).toBe(403);
    expect((await asUser.raw.get(`/workflows/definitions/${definition.wfDefinitionId}`)).status()).toBe(403);
    expect((await asUser.raw.post('/workflows/definitions', { name: uniq('WF-14 Interdit'), graph: singleFormGraph() })).status()).toBe(403);
    expect((await asUser.raw.post(`/workflows/definitions/${definition.wfDefinitionId}/publish`, {})).status()).toBe(403);

    const s = await openSessionAs(browser, loginAs, user);
    try {
      await s.page.goto('/workflows/conception');
      await expect(
        s.page.getByText('Accès refusé. Votre rôle ne permet pas de concevoir des workflows. Demandez l’accès à un administrateur.'),
      ).toBeVisible();
      await expect(s.page.getByRole('button', { name: 'Nouveau workflow' })).toHaveCount(0);
    } finally {
      await s.close();
    }
  });
});
