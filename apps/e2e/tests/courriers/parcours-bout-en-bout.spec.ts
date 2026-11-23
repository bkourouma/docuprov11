import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import type { ApiClient } from '../../fixtures';
import {
  INPUTATION_TYPE,
  MENUS,
  arriveeImputee,
  createArrivee,
  createCourrierActor,
  createCourrierRefs,
  fillDate,
  getMail,
  imputer,
  pdfUpload,
  selectOption,
  toast,
  uploadScan,
  type CourrierActor,
  type CourrierRefs,
} from './_helpers';
import {
  MAIL_STATUS,
  MAIL_TYPE,
  badges,
  dashboardFiles,
  dashboardSynthese,
  departAvecPdf,
  fileIds,
  frDay,
  integrerDecharge,
  notificationMessages,
  pdf,
  pickOption,
  popconfirm,
  searchArchives,
  showHundredRows,
  tableRow,
  tdbValue,
  waitForApi,
} from './_helpers/flux-t3';
import { typeDate } from './_helpers/workflow-t2';

/**
 * Parcours phare Docu-Courriers, de l'arrivée à l'archive :
 *   enregistrement → contrôle (imputation) → parapheur → suivi → validation (marquer traité)
 *   → réponse par un départ lié → intégration de la décharge → recherche → tableau de bord.
 *
 * Acteurs (rôles neufs, `createCourrierActor`) — chacun ne porte que les menus de son étape :
 *  - bureau d'ordre : Enregistrement, Départ, Intégration décharge, Recherche ;
 *  - destinataire   : Contrôle (destinataire principal par son rôle) ;
 *  - imputé         : Parapheur, Suivi DC (périmètre « mes imputations »), Tableau de bord ;
 *  - validateur     : Validation.
 * Imputation de type « Validation Direction » (14, `suivi=false`) : l'ouverture du parapheur ne la
 * traite pas, le courrier y reste jusqu'à la validation (un « Pour Suivi » en sortirait dès la lecture).
 *
 * Compteurs déterministes malgré les tests parallèles : le tableau de bord de l'IMPUTÉ (périmètre
 * `imputed`, ses seuls courriers) à l'écran, la vue globale FILTRÉE sur le correspondant unique du
 * test par l'API.
 */

interface Acteurs {
  bo: CourrierActor;
  dest: CourrierActor;
  impute: CourrierActor;
  valid: CourrierActor;
}

async function acteurs(api: ApiClient, uniq: (p: string) => string, id: string): Promise<Acteurs> {
  const [bo, dest, impute, valid] = await Promise.all([
    createCourrierActor(api, {
      prefix: uniq(`${id}-bo`),
      menus: [MENUS.enregistrement, MENUS.depart, MENUS.integrationDecharge, MENUS.recherche],
    }),
    createCourrierActor(api, { prefix: uniq(`${id}-dest`), menus: [MENUS.controle] }),
    createCourrierActor(api, {
      prefix: uniq(`${id}-impute`),
      menus: [MENUS.parapheur, MENUS.suiviDC, MENUS.tableauDeBord],
    }),
    createCourrierActor(api, { prefix: uniq(`${id}-valid`), menus: [MENUS.validation] }),
  ]);
  return { bo, dest, impute, valid };
}

// ---------------------------------------------------------------------------
// Étapes par l'interface
// ---------------------------------------------------------------------------

async function enregistrerParEcran(
  page: Page,
  v: { title: string; refs: CourrierRefs; dest: CourrierActor; pdfName: string },
): Promise<number> {
  await page.goto(MENUS.enregistrement);
  await expect(page.getByLabel("N° d'enregistrement")).toHaveValue(/^\d{5,}$/);
  await page.getByLabel('Objet du courrier').fill(v.title);
  await fillDate(page.getByLabel('Date du courrier'), frDay());
  await page.getByLabel('Référence expéditeur').fill('REF-E2E-60');
  await selectOption(page, page.locator('#externalEntityId'), v.refs.externalEntityLabel);
  await selectOption(page, page.getByLabel('Destinataire', { exact: true }), v.dest.roleName);
  await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(pdfUpload(v.pdfName));
  const created = waitForApi(page, '/courriers/arrivee', 'POST');
  await page.getByRole('button', { name: 'Enregistrer le courrier' }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  await expect(toast(page, 'Courrier enregistré.')).toBeVisible();
  return ((await res.json()) as { mailId: number }).mailId;
}

async function gotoList(page: Page, route: string, apiPath: string): Promise<void> {
  const loaded = waitForApi(page, apiPath);
  await page.goto(route);
  expect((await loaded).status()).toBe(200);
}

async function openTdb(page: Page): Promise<void> {
  const files = waitForApi(page, '/courriers/dashboard/files', 'POST');
  const synthese = waitForApi(page, '/courriers/dashboard/synthese', 'POST');
  await page.goto(MENUS.tableauDeBord);
  expect((await files).status()).toBe(200);
  expect((await synthese).status()).toBe(200);
  await expect(page.getByText('Périmètre : les courriers où vous êtes imputé')).toBeVisible();
}

// ---------------------------------------------------------------------------
// Même parcours piloté par l'API (COU-61/62)
// ---------------------------------------------------------------------------

type Etape = 'enregistre' | 'impute' | 'valide' | 'repondu' | 'decharge';

interface Prepa {
  refs: CourrierRefs;
  a: Acteurs;
  clients: Record<keyof Acteurs, ApiClient>;
  title: string;
  departTitle: string;
}

async function preparer(
  api: ApiClient,
  apiAs: (username: string, password: string) => Promise<ApiClient>,
  uniq: (p: string) => string,
  id: string,
): Promise<Prepa> {
  const refs = await createCourrierRefs(api, uniq(id));
  const a = await acteurs(api, uniq, id.toLowerCase());
  const [bo, dest, impute, valid] = await Promise.all([
    apiAs(a.bo.username, a.bo.password),
    apiAs(a.dest.username, a.dest.password),
    apiAs(a.impute.username, a.impute.password),
    apiAs(a.valid.username, a.valid.password),
  ]);
  return {
    refs,
    a,
    clients: { bo, dest, impute, valid },
    title: uniq(`${id} Demande`),
    departTitle: uniq(`${id} Réponse`),
  };
}

/** Déroule le parcours par l'API, chaque étape au nom de l'acteur qui la porte. */
async function deroulerParApi(
  p: Prepa,
  apres: (etape: Etape) => Promise<void>,
): Promise<{ mailId: number; departId: number }> {
  const { bo, dest, valid } = p.clients;
  const scan = await uploadScan(bo, { name: 'arrivee.pdf' });
  const mail = await createArrivee(bo, {
    title: p.title,
    destinataireRoleId: p.a.dest.roleId,
    externalEntityId: p.refs.externalEntityId,
    scannedDocumentId: scan.mailScannedDocumentId,
  });
  await apres('enregistre');

  await imputer(dest, {
    mailId: mail.mailId,
    userGroupId: p.a.impute.userGroupId,
    mailInputationTypeId: INPUTATION_TYPE.validationDirection,
  });
  await apres('impute');

  await valid.post('/courriers/validation-direction', { mailIds: [mail.mailId] });
  await apres('valide');

  const depart = await departAvecPdf(bo, {
    title: p.departTitle,
    mailDepartTypeId: p.refs.departTypeId,
    externalEntityId: p.refs.externalEntityId,
    parentMailId: mail.mailId,
  });
  await apres('repondu');

  await integrerDecharge(bo, depart.mailId);
  await apres('decharge');

  return { mailId: mail.mailId, departId: depart.mailId };
}

test.describe('Parcours de bout en bout Docu-Courriers', () => {
  test('COU-60 — parcours complet par l’interface, de l’enregistrement au tableau de bord', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    test.slow();
    const refs = await createCourrierRefs(api, uniq('COU-60'));
    const { bo, dest, impute, valid } = await acteurs(api, uniq, 'cou60');
    const prefix = uniq('COU-60');
    const title = `${prefix} Demande de subvention`;
    const departTitle = `${prefix} Réponse à la demande`;
    const imputeApi = await apiAs(impute.username, impute.password);

    // Point de départ du tableau de bord de l'imputé : rien dans son périmètre.
    expect(await dashboardFiles(imputeApi)).toMatchObject({ scope: 'imputed', enCours: { count: 0 } });

    // 1. Enregistrement de l'arrivée (bureau d'ordre).
    await loginAs(page, bo.username, bo.password);
    const mailId = await enregistrerParEcran(page, { title, refs, dest, pdfName: `${prefix}.pdf` });

    // 2. Contrôle : le destinataire impute (ce qui valide le contrôle).
    await loginAs(page, dest.username, dest.password);
    await gotoList(page, MENUS.controle, '/courriers/controle');
    await tableRow(page, title).getByText(title, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${MENUS.controle}/${mailId}$`));
    await page.getByRole('tab', { name: 'Imputations (0)' }).click();
    await page.getByRole('button', { name: 'Ajouter une imputation' }).click();
    await selectOption(page, page.getByLabel('Rôle', { exact: true }), impute.roleName);
    await selectOption(page, page.getByLabel('Imputer à'), impute.fullName, { multiple: true });
    await selectOption(page, page.getByLabel("Type d'imputation"), 'Validation Direction');
    await page.getByLabel('Instructions (facultatif)').fill('Préparer la réponse');
    const imputed = waitForApi(page, '/courriers/imputations', 'POST');
    await page.getByRole('button', { name: 'Imputer', exact: true }).click();
    expect((await imputed).status()).toBe(201);
    await expect(toast(page, 'Imputation créée.')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Imputations (1)' })).toBeVisible();
    await gotoList(page, MENUS.controle, '/courriers/controle');
    await expect(tableRow(page, title)).toHaveCount(0);
    expect((await getMail(api, mailId)).valider).toBe(true);

    // 3. Parapheur de l'imputé : ouvert, le courrier y reste (type non traité à la lecture).
    await loginAs(page, impute.username, impute.password);
    await gotoList(page, MENUS.parapheur, '/courriers/parapheur');
    const read = waitForApi(page, `/courriers/${mailId}/imputations/lecture`, 'POST');
    await tableRow(page, title).getByText(title, { exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    expect((await read).ok()).toBe(true);
    await gotoList(page, MENUS.parapheur, '/courriers/parapheur');
    await expect(tableRow(page, title)).toBeVisible();

    // 4. Suivi (périmètre « mes imputations ») et tableau de bord de l'imputé.
    await gotoList(page, MENUS.suivi, '/courriers/suivi');
    await expect(tableRow(page, title)).toBeVisible();
    await openTdb(page);
    await expect(tdbValue(page, 'tdb-file-enCours')).toHaveText('1');
    await expect(tdbValue(page, 'tdb-file-parapheur')).toHaveText('1');
    await expect(tdbValue(page, 'tdb-file-validationDirection')).toHaveText('1');
    await expect(tdbValue(page, 'tdb-kpi-en-cours')).toHaveText('1');

    // 5. Validation : « Marquer comme traité ».
    await loginAs(page, valid.username, valid.password);
    await gotoList(page, MENUS.validation, '/courriers/validation-direction');
    await showHundredRows(page, /\/api\/courriers\/validation-direction$/);
    await tableRow(page, title).getByRole('checkbox').check();
    await expect(page.getByText('1 courrier(s) sélectionné(s)')).toBeVisible();
    await page.getByRole('button', { name: 'Marquer comme traité' }).click();
    const validated = waitForApi(page, '/courriers/validation-direction', 'POST');
    await popconfirm(page).getByRole('button', { name: 'Marquer comme traité' }).click();
    expect((await validated).status()).toBe(200);
    await expect(toast(page, '1 courrier(s) marqué(s) comme traité(s).')).toBeVisible();
    await expect(tableRow(page, title)).toHaveCount(0);

    const traite = await getMail(api, mailId);
    expect(traite).toMatchObject({ status: MAIL_STATUS.traite, validationDirection: true });
    expect(traite.dateTraited).not.toBeNull();
    for (const imp of traite.inputations as Array<{ dateTreated: string | null }>) {
      expect(imp.dateTreated).not.toBeNull();
    }
    expect(await fileIds(imputeApi, '/courriers/parapheur')).not.toContain(mailId);
    expect(await fileIds(imputeApi, '/courriers/suivi')).not.toContain(mailId);

    // 6. Réponse : départ lié au courrier (bureau d'ordre).
    await loginAs(page, bo.username, bo.password);
    const types = waitForApi(page, '/courriers/referentials/depart-types');
    await page.goto(MENUS.depart);
    await types;
    const next = waitForApi(page, `/courriers/next-reference/depart/${refs.departTypeId}`);
    await pickOption(page, page.getByLabel('Type de courrier départ'), refs.departTypeLabel);
    await next;
    await expect(page.getByLabel('N° de référence')).toHaveValue('00001');
    await page.getByLabel('Objet du courrier').fill(departTitle);
    // Pas d'Entrée (`fillDate`) : elle soumettrait le formulaire du Départ à mi-saisie.
    await typeDate(page.getByLabel('Date du courrier'), frDay());
    await pickOption(page, page.getByLabel('Destinataire externe'), refs.externalEntityLabel);
    await pickOption(page, page.getByLabel('Lié au courrier'), title);
    await page.locator('input[type="file"]').setInputFiles(pdf(`${prefix}-reponse.pdf`));
    const departCreated = waitForApi(page, '/courriers/depart', 'POST');
    await page.getByRole('button', { name: 'Créer le courrier de départ' }).click();
    const departRes = await departCreated;
    expect(departRes.status()).toBe(201);
    await expect(toast(page, 'Courrier de départ créé.')).toBeVisible();
    const departId = ((await departRes.json()) as { mailId: number }).mailId;
    expect(await getMail(api, departId)).toMatchObject({
      mailType: MAIL_TYPE.depart,
      status: MAIL_STATUS.redige,
      mailParent: mailId,
      destinataireExpediteur: bo.userGroupId,
    });

    // 7. Intégration de la décharge signée.
    const pending = waitForApi(page, '/courriers/decharges-en-attente');
    await page.goto(MENUS.integrationDecharge);
    await pending;
    await pickOption(page, page.getByLabel('Courrier', { exact: true }), departTitle);
    await page.locator('input[type="file"]').setInputFiles(pdf(`${prefix}-decharge.pdf`));
    await page.getByRole('button', { name: 'Intégrer la décharge' }).click();
    const integrated = waitForApi(page, `/courriers/${departId}/integration-decharge`, 'POST');
    await popconfirm(page).getByRole('button', { name: 'Intégrer', exact: true }).click();
    expect((await integrated).status()).toBe(200);
    await expect(toast(page, 'Décharge intégrée : courrier déchargé et archivé.')).toBeVisible();

    // 8. Recherche : les deux courriers, archivés, avec leurs pièces.
    const firstSearch = waitForApi(page, '/courriers/recherche', 'POST');
    await page.goto(MENUS.recherche);
    await firstSearch;
    const searched = waitForApi(page, '/courriers/recherche', 'POST');
    await page.getByLabel('Texte recherché').fill(prefix);
    await page.getByLabel('Texte recherché').press('Enter');
    expect((await searched).status()).toBe(200);
    await expect(page.locator('.ant-card-head-title').filter({ hasText: /résultats?$/ })).toHaveText(
      /^2\s*résultats$/,
    );
    await expect(tableRow(page, departTitle)).toContainText('Départ');
    await expect(tableRow(page, title)).toContainText('Arrivée');

    await tableRow(page, title).getByText(title, { exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    // Arrivée : son PDF + la réponse (rattachée au parent, §12) + la décharge (§13).
    await page.getByRole('tab', { name: 'Fichiers (3)' }).click();
    await expect(page.locator('.ant-tag').filter({ hasText: /^Décharge signée$/ })).toHaveCount(1);

    await page.goto(`${MENUS.recherche}/${departId}`);
    await expect(page.getByRole('heading', { level: 2, name: departTitle })).toBeVisible();
    await page.getByRole('tab', { name: 'Fichiers (2)' }).click();
    await expect(page.locator('.ant-tag').filter({ hasText: /^Décharge signée$/ })).toHaveCount(1);

    // 9. Tableau de bord de l'imputé : plus rien en cours, un courrier enregistré et archivé.
    await loginAs(page, impute.username, impute.password);
    await openTdb(page);
    await expect(tdbValue(page, 'tdb-file-enCours')).toHaveText('0');
    await expect(tdbValue(page, 'tdb-file-parapheur')).toHaveText('0');
    await expect(tdbValue(page, 'tdb-file-validationDirection')).toHaveText('0');
    await expect(tdbValue(page, 'tdb-kpi-en-cours')).toHaveText('0');
    await expect(tdbValue(page, 'tdb-kpi-enregistres')).toHaveText('1');
    await expect(tdbValue(page, 'tdb-kpi-archives')).toHaveText('1');
  });

  test('COU-61 — compteurs du tableau de bord à chaque étape (vue globale filtrée)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const attendu: Record<Etape, Record<string, unknown>> = {
      enregistre: {
        aControler: { count: 1 },
        parapheur: { count: 0 },
        validationDirection: { count: 0 },
        decharge: { count: 0 },
        enCours: { count: 1 },
      },
      impute: {
        aControler: { count: 0 },
        parapheur: { count: 1 },
        validationDirection: { count: 1 },
        decharge: { count: 0 },
        enCours: { count: 1 },
      },
      valide: {
        aControler: { count: 0 },
        parapheur: { count: 0 },
        validationDirection: { count: 0 },
        decharge: { count: 0 },
        enCours: { count: 0 },
      },
      // « À contrôler » n'est pas vérifié à partir du départ : voir COU-64 (départ rédigé compté).
      repondu: {
        parapheur: { count: 0 },
        validationDirection: { count: 0 },
        decharge: { count: 1 },
        enCours: { count: 1 },
      },
      decharge: {
        parapheur: { count: 0 },
        validationDirection: { count: 0 },
        decharge: { count: 0 },
        enCours: { count: 0 },
      },
    };

    const p = await preparer(api, apiAs, uniq, 'COU-61');
    const filtre = { externalEntityId: p.refs.externalEntityId };
    await deroulerParApi(p, async (etape) => {
      const files = await dashboardFiles(api, filtre);
      expect(files.scope).toBe('all');
      expect(files, etape).toMatchObject(attendu[etape]);
      const synthese = await dashboardSynthese(api, filtre);
      expect(synthese.enCours, etape).toBe((attendu[etape].enCours as { count: number }).count);
    });

    // Fin d'échange : l'arrivée (date_traited) et le départ (date_decharge, §3.7) sont archivés.
    expect((await dashboardSynthese(api, filtre)).traites.valeur).toBe(2);
  });

  test('COU-62 — badges de menu et notifications des acteurs au fil du parcours', async ({ api, apiAs, uniq }) => {
    const p = await preparer(api, apiAs, uniq, 'COU-62');
    const { bo: boApi, dest: destApi, impute: imputeApi } = p.clients;
    expect((await badges(destApi)).controle).toBe(0);
    expect((await badges(imputeApi)).parapheur).toBe(0);

    const attendu: Partial<Record<Etape, { controle: number; parapheur: number }>> = {
      enregistre: { controle: 1, parapheur: 0 },
      impute: { controle: 0, parapheur: 1 },
      valide: { controle: 0, parapheur: 0 },
      decharge: { controle: 0, parapheur: 0 },
    };
    await deroulerParApi(p, async (etape) => {
      const att = attendu[etape];
      if (!att) return;
      expect((await badges(destApi)).controle, `contrôle (${etape})`).toBe(att.controle);
      expect((await badges(imputeApi)).parapheur, `parapheur (${etape})`).toBe(att.parapheur);
    });

    const t = p.title;
    expect(await notificationMessages(destApi)).toEqual(
      expect.arrayContaining([
        `Nouveau courrier enregistré : ${t}`,
        `Courrier à imputer : ${t}`,
        `Validation Direction : ${t}`,
        `Courrier traité et archivé — réponse envoyée : ${t}`,
        `Décharge reçue — échange clos : ${t}`,
      ]),
    );
    expect(await notificationMessages(imputeApi)).toEqual(
      expect.arrayContaining([
        `Courrier imputé : ${t}`,
        `Validation Direction : ${t}`,
        `Courrier traité et archivé — réponse envoyée : ${t}`,
        `Décharge reçue — échange clos : ${t}`,
      ]),
    );
    // L'émetteur du départ est prévenu de l'intégration de SA décharge, pas de sa propre réponse.
    const boMessages = await notificationMessages(boApi);
    expect(boMessages).toContain(`Décharge intégrée : ${p.departTitle}`);
    expect(boMessages).not.toContain(`Courrier traité et archivé — réponse envoyée : ${t}`);
  });

  test('COU-63 — réponse par départ AVANT la validation : le courrier est clos et archivé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const refs = await createCourrierRefs(api, uniq('COU-63'));
    const a = await acteurs(api, uniq, 'cou63');
    const mail = await arriveeImputee(api, {
      prefix: uniq('COU-63'),
      dest: a.dest,
      impute: a.impute,
      typeId: INPUTATION_TYPE.validationDirection,
    });
    const [boApi, imputeApi, validApi] = await Promise.all([
      apiAs(a.bo.username, a.bo.password),
      apiAs(a.impute.username, a.impute.password),
      apiAs(a.valid.username, a.valid.password),
    ]);
    expect(await fileIds(imputeApi, '/courriers/suivi')).toContain(mail.mailId);
    expect(await fileIds(validApi, '/courriers/validation-direction')).toContain(mail.mailId);

    await departAvecPdf(boApi, {
      title: uniq('COU-63 Réponse'),
      externalEntityId: refs.externalEntityId,
      parentMailId: mail.mailId,
    });

    const closed = await getMail(api, mail.mailId);
    expect(closed.dateTraited).not.toBeNull();
    expect(closed.status).toBe(MAIL_STATUS.redaction); // archivé sans changer de statut (§12)
    expect(await fileIds(imputeApi, '/courriers/suivi')).not.toContain(mail.mailId);
    expect(await fileIds(validApi, '/courriers/validation-direction')).not.toContain(mail.mailId);
    expect((await searchArchives(boApi, { fullText: mail.title })).rows.map((r) => r.mailId)).toContain(
      mail.mailId,
    );

    // À l'écran : le Suivi de l'imputé ne le montre plus.
    await loginAs(page, a.impute.username, a.impute.password);
    await gotoList(page, MENUS.suivi, '/courriers/suivi');
    await expect(page.getByRole('heading', { level: 2, name: 'Suivi des courriers' })).toBeVisible();
    await expect(tableRow(page, mail.title)).toHaveCount(0);
  });

  test('COU-64 — courrier clos par un départ : il quitte le parapheur de l’imputé', async ({
    api,
    apiAs,
    uniq,
  }) => {
    test.fixme(
      true,
      "Question métier : listParapheur ne filtre pas date_traited ; un courrier archivé par la réponse (départ lié) reste au parapheur tant que l'imputation n'est pas traitée, et createDepart ne clôt pas les imputations. Attendu supposé : sortie du parapheur (ou imputations clôturées).",
    );
    const refs = await createCourrierRefs(api, uniq('COU-64'));
    const a = await acteurs(api, uniq, 'cou64');
    const mail = await arriveeImputee(api, {
      prefix: uniq('COU-64'),
      dest: a.dest,
      impute: a.impute,
      typeId: INPUTATION_TYPE.validationDirection,
    });
    const boApi = await apiAs(a.bo.username, a.bo.password);
    await departAvecPdf(boApi, {
      title: uniq('COU-64 Réponse'),
      externalEntityId: refs.externalEntityId,
      parentMailId: mail.mailId,
    });
    const imputeApi = await apiAs(a.impute.username, a.impute.password);
    expect(await fileIds(imputeApi, '/courriers/parapheur')).not.toContain(mail.mailId);
    expect((await badges(imputeApi)).parapheur).toBe(0);
  });

  test('COU-64 — un départ rédigé n’entre pas dans la file Contrôle de son rédacteur', async ({
    api,
    apiAs,
    uniq,
  }) => {
    test.fixme(
      true,
      "Question métier : controleWhere (et la tuile « À contrôler », qui la reproduit) ne filtre ni le sens ni date_traited ; un Départ (valider=false, émetteur = rédacteur) figure au Contrôle de son rédacteur, même déchargé et archivé. Attendu supposé : Contrôle réservé aux Arrivées non archivées.",
    );
    const redac = await createCourrierActor(api, {
      prefix: uniq('cou64b-redac'),
      menus: [MENUS.depart, MENUS.controle],
    });
    const redacApi = await apiAs(redac.username, redac.password);
    const depart = await departAvecPdf(redacApi, { title: uniq('COU-64b Départ') });
    expect(await fileIds(redacApi, '/courriers/controle')).not.toContain(depart.mailId);
  });
});
