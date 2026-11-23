import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  MENUS,
  createArrivee,
  createCourrierActor,
  createCourrierRefs,
  createDepart,
  createExternalEntity,
  fieldError,
  getMail,
  openDropdown,
  sidebarItem,
  toast,
  todayIso,
} from './_helpers';
import {
  MAIL_STATUS,
  MAIL_TYPE,
  countRequests,
  dechargesEnAttente,
  frDay,
  pdf,
  pickOption,
  textFile,
  waitForApi,
} from './_helpers/flux-t3';
// `typeDate` et non `fillDate` : l'Entrée de `fillDate` soumet aussi le formulaire du Départ
// (objet + date suffisent), qui était alors créé à mi-saisie puis vidé.
import { typeDate } from './_helpers/workflow-t2';

/**
 * Écran « Courrier de départ » (§12) — `apps/web/app/courriers/depart/page.tsx`.
 *
 * Lu dans le code (phase A) :
 *  - Form.Item nommés → `getByLabel` fonctionne (« Objet du courrier », « Date du courrier »,
 *    « Type de courrier départ », « N° de référence », « Destinataire externe », « Lié au courrier »).
 *    La zone de dépôt n'a pas de `name` : on vise l'unique `input[type=file]` de l'écran.
 *  - Le choix du type appelle `GET next-reference/depart/:typeId` (numérotation PAR type).
 *  - « Lié au courrier » est désactivé tant qu'aucun correspondant n'est choisi ; changer de
 *    correspondant vide la sélection.
 *  - À l'envoi : dépôt du PDF dans la file §07 (`POST documents-scannes`), PUIS `POST depart`.
 *  - L'émetteur n'est pas saisi : c'est le rédacteur connecté (son `userGroupId`).
 */

/** Date du jour au format API, dans le fuseau du NAVIGATEUR (celui du DatePicker). */
function todayLocalIso(): string {
  const [d, m, y] = frDay().split('/');
  return `${y}-${m}-${d}`;
}

const submitButton = (page: Page) => page.getByRole('button', { name: 'Créer le courrier de départ' });
const parentSelected = (page: Page) =>
  page.locator('.ant-select:has(#parentMailId) .ant-select-selection-item');

async function openDepart(page: Page): Promise<void> {
  const types = waitForApi(page, '/courriers/referentials/depart-types');
  await page.goto(MENUS.depart);
  await types;
  await expect(page.getByRole('heading', { level: 2, name: 'Courrier de départ' })).toBeVisible();
}

/** Choisit le type de départ et attend le n° proposé. */
async function chooseType(page: Page, typeId: number, typeLabel: string): Promise<void> {
  const next = waitForApi(page, `/courriers/next-reference/depart/${typeId}`);
  await pickOption(page, page.getByLabel('Type de courrier départ'), typeLabel);
  expect((await next).status()).toBe(200);
}

/** Envoie le formulaire ; renvoie l'id créé (dépôt du PDF puis création attendus en 201). */
async function submitDepart(page: Page, withPdf: boolean): Promise<number> {
  const scan = withPdf ? waitForApi(page, '/courriers/documents-scannes', 'POST') : null;
  const created = waitForApi(page, '/courriers/depart', 'POST');
  await submitButton(page).click();
  if (scan) expect((await scan).status()).toBe(201);
  const res = await created;
  expect(res.status()).toBe(201);
  await expect(toast(page, 'Courrier de départ créé.')).toBeVisible();
  return ((await res.json()) as { mailId: number }).mailId;
}

test.describe('Courrier de départ (§12)', () => {
  test('COU-40 — création nominale : type, n° proposé, correspondant, PDF, émetteur = rédacteur', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const refs = await createCourrierRefs(api, uniq('COU-40'));
    const redac = await createCourrierActor(api, { prefix: uniq('cou40-redac'), menus: [MENUS.depart] });
    const title = uniq('COU-40 Réponse');

    await loginAs(page, redac.username, redac.password);
    await openDepart(page);
    await expect(sidebarItem(page, 'Courrier de départ')).toBeVisible();

    await chooseType(page, refs.departTypeId, refs.departTypeLabel);
    // Type neuf : premier n° de SA séquence.
    await expect(page.getByLabel('N° de référence')).toHaveValue('00001');

    await page.getByLabel('Objet du courrier').fill(title);
    await typeDate(page.getByLabel('Date du courrier'), frDay());
    await expect(page.getByLabel('Lié au courrier')).toBeDisabled();
    await pickOption(page, page.getByLabel('Destinataire externe'), refs.externalEntityLabel);
    await expect(page.getByLabel('Lié au courrier')).toBeEnabled();

    const fileName = `${uniq('cou40')}.pdf`;
    await page.locator('input[type="file"]').setInputFiles(pdf(fileName));
    await expect(page.getByText(fileName, { exact: true })).toBeVisible();

    const scanUpload = waitForApi(page, '/courriers/documents-scannes', 'POST');
    const mailId = await submitDepart(page, true);
    const scanId = ((await (await scanUpload).json()) as { mailScannedDocumentId: number })
      .mailScannedDocumentId;

    // Formulaire vidé (champs ET pièce retenue).
    await expect(page.getByLabel('Objet du courrier')).toHaveValue('');
    await expect(page.getByLabel('N° de référence')).toHaveValue('');
    await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);

    const mail = await getMail(api, mailId);
    expect(mail).toMatchObject({
      title,
      mailType: MAIL_TYPE.depart,
      status: MAIL_STATUS.redige,
      nReference: '00001',
      mailDepartTypeId: refs.departTypeId,
      externalEntityId: refs.externalEntityId,
      destinataireExpediteur: redac.userGroupId,
      destinataireRoleId: null,
      mailParent: null,
      dateTraited: null,
      isDeleted: false,
    });
    expect(String(mail.date)).toMatch(new RegExp(`^${todayLocalIso()}`));
    expect(mail.dateDecharge).not.toBeNull(); // §12 : date d'archivage du Départ posée à la rédaction
    expect(mail.documents).toHaveLength(1);
    expect(mail.documents[0]).toMatchObject({ decharge: false });

    // Le départ attend désormais sa décharge (§13) ; le scan a quitté la file §07.
    expect(await dechargesEnAttente(api)).toContain(mailId);
    const scan = (await api.get(`/courriers/documents-scannes/${scanId}`)) as {
      isTraite: boolean;
      mailId: number | null;
    };
    expect(scan).toMatchObject({ isTraite: true, mailId });
  });

  test('COU-41 — départ lié : sélection par correspondant, réinitialisée au changement, parent archivé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const refs = await createCourrierRefs(api, uniq('COU-41'));
    const autre = await createExternalEntity(api, uniq('COU-41 autre'));
    const redac = await createCourrierActor(api, { prefix: uniq('cou41-redac'), menus: [MENUS.depart] });
    const dest = await createCourrierActor(api, { prefix: uniq('cou41-dest'), menus: [MENUS.controle] });
    const arrivee = await createArrivee(api, {
      title: uniq('COU-41 Demande'),
      destinataireRoleId: dest.roleId,
      externalEntityId: refs.externalEntityId,
    });
    // Un premier départ du même type : l'écran doit proposer le n° SUIVANT de la séquence.
    const redacApi = await apiAs(redac.username, redac.password);
    const premier = await createDepart(redacApi, {
      title: uniq('COU-41 premier'),
      mailDepartTypeId: refs.departTypeId,
    });
    expect(premier.nReference).toBe('00001');
    const title = uniq('COU-41 Réponse');

    await loginAs(page, redac.username, redac.password);
    await openDepart(page);
    await chooseType(page, refs.departTypeId, refs.departTypeLabel);
    await expect(page.getByLabel('N° de référence')).toHaveValue('00002');
    await page.getByLabel('Objet du courrier').fill(title);
    await typeDate(page.getByLabel('Date du courrier'), frDay());

    const linkables = waitForApi(page, `/courriers/by-external-entity/${refs.externalEntityId}`);
    await pickOption(page, page.getByLabel('Destinataire externe'), refs.externalEntityLabel);
    expect((await linkables).status()).toBe(200);
    await pickOption(page, page.getByLabel('Lié au courrier'), arrivee.title);
    await expect(parentSelected(page)).toContainText(arrivee.title);

    // Changer de correspondant invalide la sélection (elle pointerait sur le courrier d'un tiers).
    const others = waitForApi(page, `/courriers/by-external-entity/${autre.externalEntityId}`);
    await pickOption(page, page.getByLabel('Destinataire externe'), autre.label);
    await others;
    await expect(parentSelected(page)).toHaveCount(0);
    await page.getByLabel('Lié au courrier').click();
    // Filtrée : la liste du correspondant, tout juste refermée, est encore là (animation de sortie).
    await expect(
      openDropdown(page).filter({ hasText: 'Aucun courrier enregistré pour ce correspondant' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await pickOption(page, page.getByLabel('Destinataire externe'), refs.externalEntityLabel);
    await pickOption(page, page.getByLabel('Lié au courrier'), arrivee.title);
    await page.locator('input[type="file"]').setInputFiles(pdf(`${uniq('cou41')}.pdf`));
    const mailId = await submitDepart(page, true);

    const depart = await getMail(api, mailId);
    expect(depart).toMatchObject({
      mailParent: arrivee.mailId,
      nReference: '00002',
      externalEntityId: refs.externalEntityId,
      status: MAIL_STATUS.redige,
    });
    expect(depart.documents).toHaveLength(1);

    // §12 : le courrier auquel on répond est archivé et reçoit la pièce de la réponse.
    const parent = await getMail(api, arrivee.mailId);
    expect(parent.dateTraited).not.toBeNull();
    expect(parent.status).toBe(MAIL_STATUS.redaction); // statut d'origine conservé
    expect(parent.documents.map((d: { documentId: number }) => d.documentId)).toContain(
      depart.documents[0].documentId,
    );
  });

  test('COU-42 — erreurs de saisie : objet et date obligatoires, PDF seul, aucun envoi', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const redac = await createCourrierActor(api, { prefix: uniq('cou42-redac'), menus: [MENUS.depart] });
    await loginAs(page, redac.username, redac.password);
    await openDepart(page);
    const posted = countRequests(page, '/courriers/depart', 'POST');
    const uploaded = countRequests(page, '/courriers/documents-scannes', 'POST');

    await submitButton(page).click();
    await expect(fieldError(page, "L'objet est obligatoire")).toBeVisible();
    await expect(fieldError(page, 'La date est obligatoire')).toBeVisible();

    // Fichier non PDF : refusé avant tout envoi, rien n'est retenu.
    await page.locator('input[type="file"]').setInputFiles(textFile('note.txt'));
    await expect(toast(page, 'Seuls les fichiers PDF sont acceptés.')).toBeVisible();
    await expect(page.getByText('note.txt', { exact: true })).toHaveCount(0);

    // L'objet saisi lève sa seule erreur.
    await page.getByLabel('Objet du courrier').fill(uniq('COU-42 Objet'));
    await submitButton(page).click();
    await expect(fieldError(page, "L'objet est obligatoire")).toHaveCount(0);
    await expect(fieldError(page, 'La date est obligatoire')).toBeVisible();

    // « Réinitialiser » vide le formulaire.
    await page.getByRole('button', { name: 'Réinitialiser' }).click();
    await expect(page.getByLabel('Objet du courrier')).toHaveValue('');

    expect(posted()).toBe(0);
    expect(uploaded()).toBe(0);

    // Côté API (au nom d'un rédacteur doté d'une identité effective, sinon le 400 serait celui de
    // l'émetteur manquant et ne prouverait rien).
    const redacApi = await apiAs(redac.username, redac.password);
    const date = todayIso();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['objet absent', { date }],
      ['objet blanc', { title: '   ', date }],
      ['date absente', { title: 'COU-42' }],
      ['date invalide', { title: 'COU-42', date: 'pas-une-date' }],
    ];
    for (const [label, body] of cases) {
      expect((await redacApi.raw.post('/courriers/depart', body)).status(), label).toBe(400);
    }
  });

  test('COU-42 — objet composé d’espaces : refusé sous le champ, sans dépôt orphelin', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    // Anomalie suspectée (depart/page.tsx, règle `required` sans `whitespace`) : « ␣␣␣ » passe la
    // validation de l'écran, le PDF est DÉPOSÉ (file §07), puis l'API refuse l'objet (400) et
    // l'écran n'affiche que « HTTP 400 ». Le scan reste orphelin dans la file des documents scannés.
    const redac = await createCourrierActor(api, { prefix: uniq('cou42b-redac'), menus: [MENUS.depart] });
    await loginAs(page, redac.username, redac.password);
    await openDepart(page);
    const posted = countRequests(page, '/courriers/depart', 'POST');
    const uploaded = countRequests(page, '/courriers/documents-scannes', 'POST');

    await page.getByLabel('Objet du courrier').fill('   ');
    await typeDate(page.getByLabel('Date du courrier'), frDay());
    await page.locator('input[type="file"]').setInputFiles(pdf(`${uniq('cou42b')}.pdf`));
    await submitButton(page).click();

    await expect(fieldError(page, "L'objet est obligatoire")).toBeVisible();
    expect(uploaded()).toBe(0);
    expect(posted()).toBe(0);
  });

  test('COU-42 — courrier lié inexistant : refus explicite (4xx), jamais 500', async ({ api, apiAs, uniq }) => {
    // Anomalie suspectée (mails.service.ts createDepart) : `parentMailId` n'est pas vérifié avant
    // l'insertion ; la clé étrangère `mail_parent` échoue en base → 500 au lieu d'un 400/404.
    const redac = await createCourrierActor(api, { prefix: uniq('cou42c-redac'), menus: [MENUS.depart] });
    const redacApi = await apiAs(redac.username, redac.password);
    const res = await redacApi.raw.post('/courriers/depart', {
      title: uniq('COU-42 parent fantôme'),
      date: todayIso(),
      parentMailId: 2_147_483_000,
    });
    expect([400, 404]).toContain(res.status());
  });

  test('COU-43 — sans le menu Départ : entrée masquée, lookups et création refusés (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const refs = await createCourrierRefs(api, uniq('COU-43'));
    const sans = await createCourrierActor(api, { prefix: uniq('cou43-sans'), menus: [MENUS.recherche] });
    const sansApi = await apiAs(sans.username, sans.password);

    const post = await sansApi.raw.post('/courriers/depart', { title: 'COU-43', date: todayIso() });
    expect(post.status()).toBe(403);
    expect(((await post.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
    expect((await sansApi.raw.get(`/courriers/by-external-entity/${refs.externalEntityId}`)).status()).toBe(403);
    expect((await sansApi.raw.get(`/courriers/next-reference/depart/${refs.departTypeId}`)).status()).toBe(403);
    expect((await sansApi.raw.get('/courriers/depart')).status()).toBe(403);

    await loginAs(page, sans.username, sans.password);
    await page.goto(MENUS.recherche);
    await expect(sidebarItem(page, 'Recherche courrier')).toBeVisible();
    await expect(sidebarItem(page, 'Courrier de départ')).toHaveCount(0);

    // URL directe : l'écran s'affiche (pas de garde de route côté web), l'envoi est refusé.
    await openDepart(page);
    await page.getByLabel('Objet du courrier').fill(uniq('COU-43 Objet'));
    await typeDate(page.getByLabel('Date du courrier'), frDay());
    const created = waitForApi(page, '/courriers/depart', 'POST');
    await submitButton(page).click();
    expect((await created).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
  });
});
