import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  INPUTATION_TYPE,
  MENUS,
  arriveeImputee,
  createCourrierActor,
  sidebarItem,
  toast,
} from './_helpers';
import {
  agencement,
  countRequests,
  dashboardFiles,
  dashboardSynthese,
  tdbValue,
  waitForApi,
} from './_helpers/flux-t3';

/**
 * Tableau de bord Docu-Courriers personnalisable — `apps/web/app/courriers/tableau-de-bord/**`,
 * `components/dashboard/{GrilleWidgets,ModaleAjoutWidget}.tsx`, API `dashboard*.ts`.
 *
 * Lu dans le code (phase A) :
 *  - le périmètre (`MailScope`) découle des menus : Suivi permanent → `all`, Suivi DC → `imputed`,
 *    aucun → `none` (alerte, aucun widget, pas de « Personnaliser ») ;
 *  - l'agencement est PAR UTILISATEUR (`user_setting`) : chaque test utilise un acteur neuf, dont
 *    l'agencement est celui livré (9 widgets, dont « Charge de travail » réservé à `all`) ;
 *  - en édition, chaque widget porte un bouton `aria-label="Retirer <titre>"` : leur nombre est celui
 *    des widgets placés ; « Annuler » abandonne le brouillon, « Enregistrer » fait `PUT layout`,
 *    « Réinitialiser » fait `DELETE layout` ;
 *  - seules les données des widgets placés sont demandées (`dataKeys`) ;
 *  - tuiles et chiffres clés portent un `data-testid` (`tdb-file-<clé>`, `tdb-kpi-<clé>`), le
 *    libellé seul étant ambigu (« En cours » figure dans les deux zones).
 */

const WIDGETS_PAR_DEFAUT = [
  'alertes',
  'files',
  'synthese',
  'flux',
  'repartition',
  'retards',
  'delais',
  'charge',
  'hygiene',
];

const retirerButtons = (page: Page) => page.getByRole('button', { name: /^Retirer / });
const retirer = (page: Page, titre: string) => page.getByRole('button', { name: `Retirer ${titre}`, exact: true });
const addDialog = (page: Page) => page.getByRole('dialog', { name: 'Ajouter un widget' });

/** Ouvre l'écran ; renvoie la réponse de `GET layout`. */
async function openTdb(page: Page): Promise<Response> {
  const layout = waitForApi(page, '/courriers/dashboard/layout');
  await page.goto(MENUS.tableauDeBord);
  await expect(page.getByRole('heading', { level: 2, name: 'Tableau de bord courrier' })).toBeVisible();
  return layout;
}

async function personnaliser(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Personnaliser' }).click();
  await expect(page.getByRole('button', { name: 'Enregistrer', exact: true })).toBeVisible();
}

async function enregistrer(page: Page): Promise<void> {
  const saved = waitForApi(page, '/courriers/dashboard/layout', 'PUT');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(toast(page, 'Tableau de bord enregistré')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Personnaliser' })).toBeVisible();
}

test.describe('Tableau de bord courrier', () => {
  test('COU-53 — périmètre global : agencement livré, tuiles et chiffres clés chargés', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const chef = await createCourrierActor(api, {
      prefix: uniq('cou53-chef'),
      menus: [MENUS.tableauDeBord, MENUS.suivi],
    });
    const chefApi = await apiAs(chef.username, chef.password);
    const layout = await agencement(chefApi);
    expect(layout).toMatchObject({ scope: 'all', parDefaut: true });
    expect(layout.widgets.map((w) => w.id)).toEqual(WIDGETS_PAR_DEFAUT);
    expect(layout.disponibles.map((w) => w.id).sort()).toEqual([...WIDGETS_PAR_DEFAUT].sort());

    await loginAs(page, chef.username, chef.password);
    const files = waitForApi(page, '/courriers/dashboard/files', 'POST');
    const synthese = waitForApi(page, '/courriers/dashboard/synthese', 'POST');
    const charge = waitForApi(page, '/courriers/dashboard/charge', 'POST');
    expect((await openTdb(page)).status()).toBe(200);
    expect((await files).status()).toBe(200);
    expect((await synthese).status()).toBe(200);
    expect((await charge).status()).toBe(200); // servi en périmètre global

    await expect(sidebarItem(page, 'Tableau de bord')).toBeVisible();
    await expect(page.getByText('Périmètre : tous les courriers')).toBeVisible();
    await expect(page.getByText('Bienvenue sur Docu-Courriers')).toBeVisible();
    for (const id of ['tdb-file-aControler', 'tdb-file-parapheur', 'tdb-file-validationDirection', 'tdb-file-decharge', 'tdb-file-enCours']) {
      await expect(tdbValue(page, id), id).toHaveText(/^\d[\d\s]*$/);
    }
    // En périmètre global, les deux files personnelles sont des compteurs « tous services ».
    await expect(page.getByTestId('tdb-file-aControler')).toContainText('Tous services');
    await expect(page.getByTestId('tdb-file-parapheur')).toContainText('Tous services');
    for (const id of ['tdb-kpi-enregistres', 'tdb-kpi-archives', 'tdb-kpi-en-cours']) {
      await expect(tdbValue(page, id), id).toHaveText(/^\d[\d\s]*$/);
    }

    await personnaliser(page);
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length);
    await expect(retirer(page, 'Charge de travail')).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(retirerButtons(page)).toHaveCount(0);
  });

  test('COU-54 — retirer un widget, enregistrer, persister, puis réinitialiser', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const chef = await createCourrierActor(api, {
      prefix: uniq('cou54-chef'),
      menus: [MENUS.tableauDeBord, MENUS.suivi],
    });
    const chefApi = await apiAs(chef.username, chef.password);

    await loginAs(page, chef.username, chef.password);
    await openTdb(page);
    await personnaliser(page);
    await retirer(page, 'Hygiène des données').click();
    await expect(retirer(page, 'Hygiène des données')).toHaveCount(0);
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length - 1);
    await enregistrer(page);

    const saved = await agencement(chefApi);
    expect(saved.parDefaut).toBe(false);
    expect(saved.widgets.map((w) => w.id)).toEqual(WIDGETS_PAR_DEFAUT.filter((id) => id !== 'hygiene'));
    expect(saved.dataKeys).not.toContain('hygiene');

    // Après rechargement : widget toujours absent, et sa requête n'est plus émise.
    const hygieneCalls = countRequests(page, '/courriers/dashboard/hygiene', 'POST');
    const files = waitForApi(page, '/courriers/dashboard/files', 'POST');
    await page.reload();
    await files;
    await personnaliser(page);
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length - 1);
    await expect(retirer(page, 'Hygiène des données')).toHaveCount(0);
    expect(hygieneCalls()).toBe(0);

    // Réinitialiser : retour à l'agencement livré (le réglage est supprimé).
    const reset = waitForApi(page, '/courriers/dashboard/layout', 'DELETE');
    await page.getByRole('button', { name: 'Réinitialiser' }).click();
    expect((await reset).status()).toBe(200);
    await expect(toast(page, 'Agencement par défaut rétabli')).toBeVisible();
    await personnaliser(page);
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length);
    await expect(retirer(page, 'Hygiène des données')).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();

    const restored = await agencement(chefApi);
    expect(restored.parDefaut).toBe(true);
    expect(restored.widgets.map((w) => w.id)).toEqual(WIDGETS_PAR_DEFAUT);
  });

  test('COU-55 — ajouter un widget depuis le catalogue ; « Annuler » abandonne le brouillon', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const chef = await createCourrierActor(api, {
      prefix: uniq('cou55-chef'),
      menus: [MENUS.tableauDeBord, MENUS.suivi],
    });
    const chefApi = await apiAs(chef.username, chef.password);
    const initial = await agencement(chefApi);
    await chefApi.put('/courriers/dashboard/layout', {
      widgets: initial.widgets
        .filter((w) => w.id !== 'retards')
        .map(({ id, x, y, w, h }) => ({ id, x, y, w, h })),
    });

    await loginAs(page, chef.username, chef.password);
    await openTdb(page);
    await personnaliser(page);
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length - 1);

    // La modale ne propose que le catalogue autorisé MOINS les widgets placés : « Retards » seul.
    await page.getByRole('button', { name: 'Ajouter un widget' }).click();
    const dialog = addDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.ant-list-item')).toHaveCount(1);
    await expect(dialog.locator('.ant-list-item')).toContainText('Retards');
    await dialog.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(retirer(page, 'Retards')).toBeVisible();
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length);

    // Tout est placé : la modale le dit.
    await page.getByRole('button', { name: 'Ajouter un widget' }).click();
    await expect(addDialog(page)).toContainText('Tous les widgets sont déjà affichés');
    await addDialog(page).getByRole('button', { name: 'Fermer' }).click();
    await expect(addDialog(page)).toBeHidden();

    // « Annuler » : rien n'a été enregistré.
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    expect((await agencement(chefApi)).widgets.map((w) => w.id)).not.toContain('retards');
    await personnaliser(page);
    await expect(retirer(page, 'Retards')).toHaveCount(0);

    // Ajout puis enregistrement : persistant.
    await page.getByRole('button', { name: 'Ajouter un widget' }).click();
    await addDialog(page).getByRole('button', { name: 'Ajouter', exact: true }).click();
    await enregistrer(page);
    const after = await agencement(chefApi);
    expect(after.parDefaut).toBe(false);
    expect(after.widgets.map((w) => w.id)).toContain('retards');
    expect(after.widgets).toHaveLength(WIDGETS_PAR_DEFAUT.length);
  });

  test('COU-56 — périmètre « mes imputations » (Suivi DC) : chiffres propres, charge refusée', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const agent = await createCourrierActor(api, {
      prefix: uniq('cou56-agent'),
      menus: [MENUS.tableauDeBord, MENUS.suiviDC, MENUS.parapheur],
    });
    const dest = await createCourrierActor(api, { prefix: uniq('cou56-dest'), menus: [MENUS.controle] });
    // Imputation « Validation Direction » (suivi=false) : non traitée à la lecture.
    await arriveeImputee(api, {
      prefix: uniq('COU-56'),
      dest,
      impute: agent,
      typeId: INPUTATION_TYPE.validationDirection,
    });
    const agentApi = await apiAs(agent.username, agent.password);

    const layout = await agencement(agentApi);
    expect(layout.scope).toBe('imputed');
    expect(layout.widgets.map((w) => w.id)).toEqual(WIDGETS_PAR_DEFAUT.filter((id) => id !== 'charge'));
    expect(layout.disponibles.map((w) => w.id)).not.toContain('charge');
    expect((await agentApi.raw.post('/courriers/dashboard/charge', {})).status()).toBe(403);
    // Ses chiffres sont ceux de SES courriers (rôle et acteur neufs : un seul courrier).
    const files = await dashboardFiles(agentApi);
    expect(files).toMatchObject({
      scope: 'imputed',
      aControler: { count: 0 },
      parapheur: { count: 1 },
      validationDirection: { count: 1 },
      enCours: { count: 1 },
    });
    expect((await dashboardSynthese(agentApi)).enCours).toBe(1);

    await loginAs(page, agent.username, agent.password);
    const chargeCalls = countRequests(page, '/courriers/dashboard/charge', 'POST');
    const filesLoaded = waitForApi(page, '/courriers/dashboard/files', 'POST');
    await openTdb(page);
    await filesLoaded;
    await expect(page.getByText('Périmètre : les courriers où vous êtes imputé')).toBeVisible();
    await expect(tdbValue(page, 'tdb-file-enCours')).toHaveText('1');
    await expect(tdbValue(page, 'tdb-file-parapheur')).toHaveText('1');
    await expect(tdbValue(page, 'tdb-file-aControler')).toHaveText('0');
    await expect(page.getByTestId('tdb-file-enCours')).toContainText('Mon périmètre');
    await expect(tdbValue(page, 'tdb-kpi-en-cours')).toHaveText('1');
    expect(chargeCalls()).toBe(0);

    await personnaliser(page);
    await expect(retirerButtons(page)).toHaveCount(WIDGETS_PAR_DEFAUT.length - 1);
    await expect(retirer(page, 'Charge de travail')).toHaveCount(0);
    await page.getByRole('button', { name: 'Ajouter un widget' }).click();
    await expect(addDialog(page)).toContainText('Tous les widgets sont déjà affichés');
    await addDialog(page).getByRole('button', { name: 'Fermer' }).click();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();

    // Un agencement qui contient « charge » est enregistré SANS lui (jamais servi hors `all`).
    const saved = (await agentApi.put('/courriers/dashboard/layout', {
      widgets: [
        { id: 'charge', x: 0, y: 0, w: 12, h: 10 },
        { id: 'files', x: 0, y: 10, w: 12, h: 4 },
      ],
    })) as { widgets: Array<{ id: string }> };
    expect(saved.widgets.map((w) => w.id)).toEqual(['files']);
  });

  test('COU-57 — aucun périmètre de suivi : alerte, aucun widget, données à zéro', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const agent = await createCourrierActor(api, { prefix: uniq('cou57-agent'), menus: [MENUS.tableauDeBord] });
    const agentApi = await apiAs(agent.username, agent.password);
    const layout = await agencement(agentApi);
    expect(layout).toMatchObject({ scope: 'none', widgets: [], disponibles: [], dataKeys: [] });
    const files = await dashboardFiles(agentApi);
    expect(files).toMatchObject({
      scope: 'none',
      aControler: { count: 0 },
      parapheur: { count: 0 },
      validationDirection: { count: 0 },
      decharge: { count: 0 },
      enCours: { count: 0 },
    });
    expect(await dashboardSynthese(agentApi)).toMatchObject({
      scope: 'none',
      enregistres: { valeur: 0 },
      traites: { valeur: 0 },
      enCours: 0,
    });

    await loginAs(page, agent.username, agent.password);
    const dataCalls = countRequests(page, /^\/courriers\/dashboard\/(?!layout)/, 'POST');
    expect((await openTdb(page)).status()).toBe(200);
    await expect(page.getByRole('alert').filter({ hasText: 'Aucun périmètre de suivi ne vous est accordé' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Personnaliser' })).toHaveCount(0);
    await expect(page.getByText('Bienvenue sur Docu-Courriers')).toHaveCount(0);
    expect(dataCalls()).toBe(0); // aucun widget placé : aucune donnée demandée
  });

  test('COU-58 — sans le menu Tableau de bord : entrée masquée, agencement et données refusés (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const agent = await createCourrierActor(api, { prefix: uniq('cou58-agent'), menus: [MENUS.suivi] });
    const agentApi = await apiAs(agent.username, agent.password);
    const layout = await agentApi.raw.get('/courriers/dashboard/layout');
    expect(layout.status()).toBe(403);
    expect(((await layout.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
    for (const zone of ['files', 'synthese', 'alertes', 'flux', 'retards', 'charge', 'hygiene']) {
      expect((await agentApi.raw.post(`/courriers/dashboard/${zone}`, {})).status(), zone).toBe(403);
    }
    expect((await agentApi.raw.post('/courriers/dashboard/repartition', { dimension: 'type' })).status()).toBe(403);
    expect((await agentApi.raw.put('/courriers/dashboard/layout', { widgets: [] })).status()).toBe(403);

    await loginAs(page, agent.username, agent.password);
    await page.goto(MENUS.suivi);
    await expect(sidebarItem(page, 'Suivi des courriers')).toBeVisible();
    await expect(sidebarItem(page, 'Tableau de bord')).toHaveCount(0);

    expect((await openTdb(page)).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
  });

  test('COU-59 — filtres invalides refusés en 400 (dont date inexistante, auparavant 500)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['mois 13', 'synthese', { dateFrom: '2026-13-01' }],
      ['31 février', 'synthese', { dateTo: '2026-02-31' }],
      ['29 février non bissextile', 'flux', { dateFrom: '2025-02-29' }],
      ['format français', 'files', { dateFrom: '01/02/2026' }],
      ['champ inconnu', 'files', { scope: 'all' }],
      ['granularité hors liste', 'flux', { granularity: 'hour' }],
      ['dimension hors liste blanche', 'repartition', { dimension: 'm.title; --' }],
      ['dimension absente', 'repartition', {}],
      ['type de courrier hors bornes', 'synthese', { mailType: 9 }],
    ];
    for (const [label, zone, body] of cases) {
      expect((await api.raw.post(`/courriers/dashboard/${zone}`, body)).status(), label).toBe(400);
    }
    const ok = await api.raw.post('/courriers/dashboard/synthese', { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect(ok.status()).toBe(200);
    expect(((await ok.json()) as { periode: { from: string; to: string } }).periode).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });

    // Agencement : forme stricte (clé inconnue → 400) ; sur un acteur neuf, pas l'admin partagé.
    const chef = await createCourrierActor(api, {
      prefix: uniq('cou59-chef'),
      menus: [MENUS.tableauDeBord, MENUS.suivi],
    });
    const chefApi = await apiAs(chef.username, chef.password);
    expect(
      (
        await chefApi.raw.put('/courriers/dashboard/layout', {
          widgets: [{ id: 'files', x: 0, y: 0, w: 12, h: 4, couleur: 'rouge' }],
        })
      ).status(),
    ).toBe(400);
    expect((await chefApi.raw.put('/courriers/dashboard/layout', { widgets: 'files' })).status()).toBe(400);
    expect((await agencement(chefApi)).parDefaut).toBe(true);
  });
});
