import type { Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  MENUS,
  createArrivee,
  createCourrierActor,
  createCourrierRefs,
  sidebarItem,
  toast,
} from './_helpers';
import {
  MAIL_TYPE,
  arriveeArchivee,
  departDecharge,
  pickOption,
  searchArchives,
  tableRow,
  waitForApi,
} from './_helpers/flux-t3';

/**
 * Écran « Recherche courrier » (§11) — `apps/web/app/courriers/recherche/page.tsx` et le détail en
 * lecture seule `recherche/[mailId]/page.tsx` (`MailDetailPage`, `canAddImputations={false}`,
 * `allowArchive={false}`, onglet Fichiers).
 *
 * Lu dans le code (phase A) :
 *  - la recherche ne porte que sur les courriers ARCHIVÉS (`date_traited IS NOT NULL`), non supprimés ;
 *  - les filtres ne s'appliquent qu'au clic « Rechercher » (ou Entrée dans le champ texte) ; chaque
 *    critère appliqué devient une puce retirable, « Tout effacer » remet tout à zéro ;
 *  - les filtres portent un `aria-label` (« Texte recherché », « Sens », « Statut »,
 *    « Correspondant », « Nature ») ; la plage de dates est un RangePicker « Du » / « Au » ;
 *  - l'en-tête de résultat est un `CountBadge` « N résultat(s) ».
 *
 * La base est partagée entre tests parallèles : chaque recherche porte un préfixe `uniq()` présent
 * dans l'objet des seuls courriers du test.
 */

const COURRIER_DATE_ISO = '2026-03-15';
const COURRIER_DATE_FR = '15/03/2026';

const resultCount = (page: Page) =>
  page.locator('.ant-card-head-title').filter({ hasText: /résultats?$/ });
const chip = (page: Page, text: string) => page.locator('.ant-tag').filter({ hasText: text });
const errorToasts = (page: Page) => page.locator('.ant-message .ant-message-error');
/**
 * Liste de filtre par son `aria-label`. `getByLabel` seul est ambigu : AntD recopie l'aria-label
 * sur le conteneur `.ant-select` ET sur l'input combobox, et l'en-tête de colonne triable du
 * même nom (« Sens », « Statut », « Correspondant ») le porte aussi.
 */
const filterCombo = (page: Page, label: string) => page.getByRole('combobox', { name: label, exact: true });

/** Attend la réponse d'une recherche dont le corps vérifie `match`. */
function waitSearch(page: Page, match: (body: Record<string, unknown>) => boolean): Promise<Response> {
  return page.waitForResponse((r: Response) => {
    if (r.request().method() !== 'POST') return false;
    if (!/\/api\/courriers\/recherche$/.test(new URL(r.url()).pathname)) return false;
    try {
      return match((r.request().postDataJSON() ?? {}) as Record<string, unknown>);
    } catch {
      return false;
    }
  });
}

/** Saisit le texte et lance la recherche par Entrée ; renvoie la réponse. */
async function searchText(page: Page, text: string): Promise<Response> {
  const done = waitSearch(page, (b) => b.fullText === text);
  await page.getByLabel('Texte recherché').fill(text);
  await page.getByLabel('Texte recherché').press('Enter');
  const res = await done;
  expect(res.status()).toBe(200);
  return res;
}

async function openRecherche(page: Page): Promise<Response> {
  const first = waitForApi(page, '/courriers/recherche', 'POST');
  await page.goto(MENUS.recherche);
  await expect(page.getByRole('heading', { level: 2, name: 'Recherche courrier' })).toBeVisible();
  return first;
}

test.describe('Recherche courrier (§11)', () => {
  test('COU-48 — plein texte sur un courrier archivé, puis consultation en lecture seule', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const refs = await createCourrierRefs(api, uniq('COU-48'));
    const agent = await createCourrierActor(api, { prefix: uniq('cou48-agent'), menus: [MENUS.recherche] });
    const prefix = uniq('COU-48');
    const mail = await arriveeArchivee(api, {
      title: `${prefix} Objet archivé`,
      destinataireRoleId: agent.roleId,
      externalEntityId: refs.externalEntityId,
      date: COURRIER_DATE_ISO,
    });

    await loginAs(page, agent.username, agent.password);
    expect((await openRecherche(page)).status()).toBe(200);
    await expect(sidebarItem(page, 'Recherche courrier')).toBeVisible();

    await searchText(page, prefix);
    await expect(resultCount(page)).toHaveText(/^1\s*résultat$/);
    await expect(chip(page, `Texte : « ${prefix} »`)).toBeVisible();
    const row = tableRow(page, mail.title);
    await expect(row).toBeVisible();
    if (mail.nReference) await expect(row).toContainText(mail.nReference);
    await expect(row).toContainText('Arrivée');
    await expect(row).toContainText(refs.externalEntityLabel);
    await expect(row).toContainText(agent.roleName); // destinataire d'une Arrivée = un rôle
    await expect(row).toContainText(COURRIER_DATE_FR);

    await row.getByText(mail.title, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${MENUS.recherche}/${mail.mailId}$`));
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Fichiers (1)' })).toBeVisible();

    // Lecture seule : ni action de workflow, ni archivage, ni ajout d'imputation.
    for (const name of ['Marquer traité', 'Validation DG', 'Décharger', 'Enregistrer la réponse', 'Archiver']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await page.getByRole('tab', { name: /^Imputations \(\d+\)$/ }).click();
    await expect(page.getByRole('button', { name: 'Ajouter une imputation' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Fichiers (1)' }).click();
    await expect(page.locator('.ant-tag').filter({ hasText: /^Courrier$/ })).toBeVisible();
  });

  test('COU-49 — filtres combinés, puces retirables, courriers en cours jamais remontés', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const refs = await createCourrierRefs(api, uniq('COU-49'));
    const agent = await createCourrierActor(api, { prefix: uniq('cou49-agent'), menus: [MENUS.recherche] });
    const redac = await createCourrierActor(api, { prefix: uniq('cou49-redac'), menus: [MENUS.depart] });
    const prefix = uniq('COU-49');
    const archivee = await arriveeArchivee(api, {
      title: `${prefix} arrivée archivée`,
      destinataireRoleId: agent.roleId,
      externalEntityId: refs.externalEntityId,
    });
    const enCours = await createArrivee(api, {
      title: `${prefix} arrivée en cours`,
      destinataireRoleId: agent.roleId,
      externalEntityId: refs.externalEntityId,
    });
    const depart = await departDecharge(await apiAs(redac.username, redac.password), api, {
      title: `${prefix} départ déchargé`,
      externalEntityId: refs.externalEntityId,
    });

    await loginAs(page, agent.username, agent.password);
    await openRecherche(page);
    await searchText(page, prefix);
    await expect(resultCount(page)).toHaveText(/^2\s*résultats$/);
    await expect(tableRow(page, archivee.title)).toBeVisible();
    await expect(tableRow(page, depart.title)).toBeVisible();
    await expect(tableRow(page, enCours.title)).toHaveCount(0);

    // Sens = Départ.
    await pickOption(page, filterCombo(page, 'Sens'), 'Départ', { search: false });
    let done = waitSearch(page, (b) => b.fullText === prefix && b.mailType === MAIL_TYPE.depart);
    await page.getByRole('button', { name: 'Rechercher' }).click();
    await done;
    await expect(resultCount(page)).toHaveText(/^1\s*résultat$/);
    await expect(tableRow(page, depart.title)).toContainText('Départ');
    await expect(chip(page, 'Sens : Départ')).toBeVisible();

    // + Statut = Déchargé et Correspondant.
    await pickOption(page, filterCombo(page, 'Statut'), 'Déchargé', { search: false });
    await pickOption(page, filterCombo(page, 'Correspondant'), refs.externalEntityLabel);
    done = waitSearch(page, (b) => b.status === 2 && b.externalEntityId === refs.externalEntityId);
    await page.getByRole('button', { name: 'Rechercher' }).click();
    await done;
    await expect(resultCount(page)).toHaveText(/^1\s*résultat$/);
    await expect(chip(page, 'Statut : Déchargé')).toBeVisible();
    await expect(chip(page, `Correspondant : ${refs.externalEntityLabel}`)).toBeVisible();

    // Retirer la puce « Sens » relance la recherche sans ce critère : l'arrivée (Rédaction) reste
    // exclue par le statut Déchargé.
    done = waitSearch(page, (b) => b.mailType === undefined && b.status === 2);
    await chip(page, 'Sens : Départ').locator('.ant-tag-close-icon').click();
    await done;
    await expect(chip(page, 'Sens : Départ')).toHaveCount(0);
    await expect(resultCount(page)).toHaveText(/^1\s*résultat$/);

    done = waitSearch(page, (b) => b.status === undefined && b.fullText === prefix);
    await chip(page, 'Statut : Déchargé').locator('.ant-tag-close-icon').click();
    await done;
    await expect(resultCount(page)).toHaveText(/^2\s*résultats$/);
    await expect(tableRow(page, enCours.title)).toHaveCount(0);

    // « Tout effacer » : puces et champs remis à zéro.
    done = waitSearch(page, (b) => b.fullText === undefined && b.externalEntityId === undefined);
    await page.getByText('Tout effacer', { exact: true }).click();
    await done;
    await expect(page.locator('.ant-tag-close-icon')).toHaveCount(0);
    await expect(page.getByLabel('Texte recherché')).toHaveValue('');
    await expect(page.locator('.ant-select:has([aria-label="Sens"]) .ant-select-selection-item')).toHaveCount(0);

    // Côté API, même exclusion du courrier en cours.
    const api2 = await searchArchives(api, { fullText: prefix });
    expect(api2.rows.map((r) => r.mailId).sort()).toEqual([archivee.mailId, depart.mailId].sort());
  });

  test('COU-50 — aucun résultat : état vide explicite, aucune erreur', async ({ page, api, loginAs, uniq }) => {
    const agent = await createCourrierActor(api, { prefix: uniq('cou50-agent'), menus: [MENUS.recherche] });
    await loginAs(page, agent.username, agent.password);
    await openRecherche(page);

    await searchText(page, uniq('COU-50 introuvable'));
    await expect(resultCount(page)).toHaveText(/^0\s*résultat$/);
    await expect(page.getByText('Aucun courrier archivé ne correspond')).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
    await expect(errorToasts(page)).toHaveCount(0);
  });

  test('COU-51 — plage de dates inversée et dates invalides', async ({ page, api, loginAs, uniq }) => {
    const agent = await createCourrierActor(api, { prefix: uniq('cou51-agent'), menus: [MENUS.recherche] });
    const prefix = uniq('COU-51');
    const mail = await arriveeArchivee(api, {
      title: `${prefix} daté`,
      destinataireRoleId: agent.roleId,
      date: COURRIER_DATE_ISO,
    });

    // API : bornes encadrantes → trouvé ; plage inversée → 200 et vide (pas d'erreur) ;
    // date invalide → 400 explicite (corrigé : atteignait le cast SQL et finissait en 500).
    expect((await searchArchives(api, { fullText: prefix, dateFrom: '2026-03-01', dateTo: '2026-03-31' })).total).toBe(1);
    const inverted = await api.raw.post('/courriers/recherche', {
      fullText: prefix,
      dateFrom: '2026-03-31',
      dateTo: '2026-03-01',
    });
    expect(inverted.status()).toBe(200);
    expect(((await inverted.json()) as { total: number }).total).toBe(0);
    for (const [champ, valeur] of [
      ['dateFrom', 'abc'],
      ['dateFrom', '2026-13-01'],
      ['dateTo', '2026-02-31'],
      ['dateTo', '31/03/2026'],
    ] as const) {
      const res = await api.raw.post('/courriers/recherche', { fullText: prefix, [champ]: valeur });
      expect(res.status(), `${champ}=${valeur}`).toBe(400);
    }

    // Écran : « Du » postérieur à « Au ». Quel que soit le traitement du RangePicker (réordonner ou
    // transmettre tel quel), la recherche aboutit sans erreur et son résultat est cohérent avec les
    // bornes réellement envoyées.
    await loginAs(page, agent.username, agent.password);
    await openRecherche(page);
    await page.getByLabel('Texte recherché').fill(prefix);
    const du = page.getByPlaceholder('Du');
    await du.click();
    await du.fill('31/03/2026');
    await du.press('Enter');
    const au = page.getByPlaceholder('Au');
    await au.fill('01/03/2026');
    await au.press('Enter');
    const done = waitSearch(page, (b) => b.fullText === prefix);
    await page.getByRole('button', { name: 'Rechercher' }).click();
    const res = await done;
    expect(res.status()).toBe(200);
    await expect(errorToasts(page)).toHaveCount(0);
    const sent = res.request().postDataJSON() as { dateFrom?: string; dateTo?: string };
    // Au moins une borne a été retenue par le champ (sinon la saisie aurait été perdue en silence).
    expect(sent.dateFrom ?? sent.dateTo).toBeDefined();
    // Rien de caché : les bornes envoyées sont exactement celles qu'affichent les champs et la
    // puce. (Constaté le 2026-11-22 avec antd 5.29 / rc-picker 4.11 : « Au » antérieur à « Du » est
    // refusé par le RangePicker, qui y recopie « Du » ⇒ 31/03 → 31/03. Ce que DOIT faire l'écran
    // d'une plage inversée est une question ouverte : voir le test.fixme COU-51 ci-dessous.)
    const fr = (iso?: string) => (iso ? iso.split('-').reverse().join('/') : '');
    await expect(du).toHaveValue(fr(sent.dateFrom));
    await expect(au).toHaveValue(fr(sent.dateTo));
    if (sent.dateFrom && sent.dateTo) {
      await expect(chip(page, `Date : ${fr(sent.dateFrom)} → ${fr(sent.dateTo)}`)).toBeVisible();
    }
    const inRange =
      (!sent.dateFrom || sent.dateFrom <= COURRIER_DATE_ISO) &&
      (!sent.dateTo || COURRIER_DATE_ISO <= sent.dateTo);
    if (inRange) {
      await expect(resultCount(page)).toHaveText(/^1\s*résultat$/);
      await expect(tableRow(page, mail.title)).toBeVisible();
    } else {
      await expect(resultCount(page)).toHaveText(/^0\s*résultat$/);
      await expect(page.getByText('Aucun courrier archivé ne correspond')).toBeVisible();
    }
  });

  // Question métier (remontée au chef de lot) : une plage saisie à l'envers au clavier doit-elle
  // être réordonnée (01/03 → 31/03, attente initiale de la phase A), refusée avec un message, ou
  // ramenée à un seul jour comme le fait aujourd'hui le RangePicker (31/03 → 31/03, la borne
  // saisie dans « Au » étant remplacée sans avertissement) ?
  test('COU-51 — plage saisie à l’envers au clavier : les deux jours saisis sont conservés (réordonnés)', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    test.fixme(true, 'question métier : traitement attendu d’une plage de dates saisie à l’envers');
    const agent = await createCourrierActor(api, { prefix: uniq('cou51b-agent'), menus: [MENUS.recherche] });
    const prefix = uniq('COU-51b');
    await loginAs(page, agent.username, agent.password);
    await openRecherche(page);
    await page.getByLabel('Texte recherché').fill(prefix);
    const du = page.getByPlaceholder('Du');
    await du.click();
    await du.fill('31/03/2026');
    await du.press('Enter');
    const au = page.getByPlaceholder('Au');
    await au.fill('01/03/2026');
    await au.press('Enter');
    const done = waitSearch(page, (b) => b.fullText === prefix);
    await page.getByRole('button', { name: 'Rechercher' }).click();
    const res = await done;
    expect(res.request().postDataJSON()).toMatchObject({ dateFrom: '2026-03-01', dateTo: '2026-03-31' });
    await expect(chip(page, 'Date : 01/03/2026 → 31/03/2026')).toBeVisible();
  });

  test('COU-52 — sans le menu Recherche : entrée masquée, recherche refusée (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const sans = await createCourrierActor(api, { prefix: uniq('cou52-sans'), menus: [MENUS.depart] });
    const sansApi = await apiAs(sans.username, sans.password);
    const res = await sansApi.raw.post('/courriers/recherche', { fullText: 'COU-52' });
    expect(res.status()).toBe(403);
    expect(((await res.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);

    await loginAs(page, sans.username, sans.password);
    await page.goto(MENUS.depart);
    await expect(sidebarItem(page, 'Courrier de départ')).toBeVisible();
    await expect(sidebarItem(page, 'Recherche courrier')).toHaveCount(0);

    expect((await openRecherche(page)).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
  });
});
