import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  INPUTATION_TYPE,
  MENUS,
  arriveeImputee,
  createArrivee,
  createCourrierActor,
  getMail,
  imputer,
  sidebarItem,
  toast,
} from './_helpers';
import {
  QUEUE_API,
  actionButton,
  badgeCount,
  createInputationType,
  expectForbidden,
  expectHoursAfter,
  getBadges,
  gotoWorklist,
  imputationItem,
  inputationsOf,
  mailDetailApi,
  notificationsWithMessage,
  openFromWorklist,
  queueIds,
  showHundredRows,
  statusTag,
  waitApi,
  worklistRow,
} from './_helpers/workflow-t2';

/**
 * Suivi des courriers (§09) — `apps/web/app/courriers/suivi/page.tsx` (file + colonne « Fiche
 * d'imputation ») et `suivi/[mailId]/page.tsx` (`MailDetailPage` : actions de workflow, ni ajout ni
 * traitement d'imputation, pas d'archivage).
 *
 * Périmètre (`mailScopeFromMenuKeys`, recalculé en base à chaque requête) :
 *  - `/courriers/suivi` → tous les courriers en cours (`dateTraited = null`) ;
 *  - `/courriers/suivi-dc` → ceux où l'utilisateur porte une imputation (traitée ou non, En Copie
 *    compris) ; c'est une PERMISSION, pas une route : même écran ;
 *  - aucun des deux → 403 sur la file, badge Suivi à 0.
 *
 * La file « Suivi complet » est GLOBALE (tous les tests parallèles y déposent) : on passe la grille
 * à 100 lignes avant d'y chercher une ligne, et les assertions de comptage passent par un acteur DC
 * dont le périmètre est propre au test.
 */

const NO_SUCH_ID = 999_999_999;

test.describe('Suivi des courriers (§09)', () => {
  test('COU-30 — « Validation DG » depuis la fiche Suivi : drapeau, imputation Pour Suivi +48 h, notification', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-30 Pour avis'));
    // Le destinataire principal reçoit l'imputation « Pour Suivi » dans SON parapheur : il lui faut
    // le menu Parapheur pour que la file le prouve (sans lui : 403, quel que soit son contenu).
    const dest = await createCourrierActor(api, {
      prefix: uniq('cou30-dest'),
      menus: [MENUS.controle, MENUS.parapheur],
    });
    const b = await createCourrierActor(api, { prefix: uniq('cou30-b'), menus: [MENUS.parapheur] });
    const suivi = await createCourrierActor(api, { prefix: uniq('cou30-suivi'), menus: [MENUS.suivi] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-30'), dest, impute: b, typeId: type.mailInputationTypeId });

    await loginAs(page, suivi.username, suivi.password);
    const loaded = waitApi(page, 'GET', mailDetailApi(mail.mailId));
    await page.goto(`${MENUS.suivi}/${mail.mailId}`);
    const detailRes = await loaded;
    expect(new URL(detailRes.url()).searchParams.get('imputations')).toBeNull();
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();

    const t0 = Date.now();
    const dg = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/validation-dg$`));
    await actionButton(page, 'Validation DG').click();
    expect((await dg).status()).toBe(200);
    await expect(toast(page, 'Validation DG enregistrée.')).toBeVisible();
    await expect(actionButton(page, 'Validation DG')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Imputations (2)' }).click();
    await expect(imputationItem(page, 'Pour Suivi')).toContainText(dest.fullName);

    const after = await getMail(api, mail.mailId);
    expect(after.validationDG).toBe(true);
    const suiviDest = inputationsOf(after, dest.userGroupId);
    expect(suiviDest).toHaveLength(1);
    expect(suiviDest[0]).toMatchObject({ mailInputationTypeId: INPUTATION_TYPE.pourSuivi, createdBy: suivi.userGroupId });
    expectHoursAfter(suiviDest[0]!.deadline, t0, 48);
    const destApi = await apiAs(dest.username, dest.password);
    expect(await notificationsWithMessage(destApi, `Validation DG : ${mail.title}`)).toHaveLength(1);
    expect((await queueIds(destApi, '/courriers/parapheur')).ids).toContain(mail.mailId);
    expect((await (await apiAs(suivi.username, suivi.password)).raw.post(`/courriers/${NO_SUCH_ID}/validation-dg`, {})).status()).toBe(404);
  });

  test('COU-31 — Suivi complet : file, fiche en consultation (pas d’ajout / traitement / archivage), « Marquer traité »', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-31 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou31-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou31-b'), menus: [MENUS.parapheur] });
    const suivi = await createCourrierActor(api, { prefix: uniq('cou31-suivi'), menus: [MENUS.suivi] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-31'), dest, impute: b, typeId: type.mailInputationTypeId });
    const suiviApi = await apiAs(suivi.username, suivi.password);
    expect((await queueIds(suiviApi, '/courriers/suivi')).ids).toContain(mail.mailId);

    await loginAs(page, suivi.username, suivi.password);
    expect((await gotoWorklist(page, MENUS.suivi, QUEUE_API.suivi)).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 2, name: 'Suivi des courriers' })).toBeVisible();
    await expect(sidebarItem(page, 'Suivi des courriers')).toBeVisible();
    await showHundredRows(page, QUEUE_API.suivi);
    const row = worklistRow(page, mail.title);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: `Fiche d'imputation du courrier ${mail.nReference ?? mail.mailId}` })).toBeVisible();

    await openFromWorklist(page, mail.title);
    await expect(page).toHaveURL(new RegExp(`${MENUS.suivi}/${mail.mailId}$`));
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();
    for (const name of ['Marquer traité', 'Validation DG', 'Décharger', 'Enregistrer la réponse']) {
      await expect(actionButton(page, name)).toBeVisible();
    }
    await expect(actionButton(page, 'Archiver')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Imputations (1)' }).click();
    await expect(imputationItem(page, b.fullName)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ajouter une imputation' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Traiter', exact: true })).toHaveCount(0);

    const treated = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/imputations/traiter$`));
    await actionButton(page, 'Marquer traité').click();
    expect((await treated).status()).toBe(200);
    await expect(toast(page, 'Courrier traité.')).toBeVisible();
    await expect(statusTag(page, 'Traité')).toBeVisible();
    await expect(actionButton(page, 'Marquer traité')).toHaveCount(0);

    const after = await getMail(api, mail.mailId);
    expect(after.status).toBe(3);
    expect(after.dateTraited).not.toBeNull();
    expect(inputationsOf(after, b.userGroupId)[0]!.dateTreated).not.toBeNull();
    expect((await queueIds(suiviApi, '/courriers/suivi')).ids).not.toContain(mail.mailId);
    expect((await queueIds(await apiAs(b.username, b.password), '/courriers/parapheur')).ids).not.toContain(mail.mailId);
  });

  test('COU-32 — périmètre « Suivi DC » : seulement les courriers où l’on est imputé (traité, en copie compris)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-32 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou32-dest'), menus: [MENUS.controle] });
    const dc = await createCourrierActor(api, { prefix: uniq('cou32-dc'), menus: [MENUS.suiviDC] });
    const autre = await createCourrierActor(api, { prefix: uniq('cou32-autre'), menus: [MENUS.parapheur] });

    const enCours = await arriveeImputee(api, { prefix: uniq('COU-32 en cours'), dest, impute: dc, typeId: type.mailInputationTypeId });
    const traitee = await arriveeImputee(api, { prefix: uniq('COU-32 traitée'), dest, impute: dc, typeId: type.mailInputationTypeId });
    // Seule SON imputation est traitée : le courrier reste en cours (dateTraited nulle).
    expect(await api.post(`/courriers/${traitee.mailId}/imputations/traiter-destinataire`, { userGroupId: dc.userGroupId })).toEqual({
      treated: 1,
    });
    const copie = await createArrivee(api, {
      title: uniq('COU-32 en copie'),
      destinataireRoleId: dest.roleId,
      enCopieUserGroupIds: [dc.userGroupId],
    });
    const horsPerimetre = await arriveeImputee(api, {
      prefix: uniq('COU-32 hors'),
      dest,
      impute: autre,
      typeId: type.mailInputationTypeId,
    });
    expect((await getMail(api, traitee.mailId)).dateTraited).toBeNull();

    const dcApi = await apiAs(dc.username, dc.password);
    const file = await queueIds(dcApi, '/courriers/suivi');
    expect([...file.ids].sort((x, y) => x - y)).toEqual([enCours.mailId, traitee.mailId, copie.mailId].sort((x, y) => x - y));
    expect(file.total).toBe(3);
    expect((await getBadges(dcApi)).suivi).toBe(3);
    // Le périmètre DC ouvre aussi les actions de workflow (MAIL_WORKFLOW_MENUS) — pas l'archivage.
    await expectForbidden(await dcApi.raw.post(`/courriers/${enCours.mailId}/archiver`, {}));

    await loginAs(page, dc.username, dc.password);
    expect((await gotoWorklist(page, MENUS.suivi, QUEUE_API.suivi)).status()).toBe(200);
    // Même entrée de menu que le Suivi complet (altKeys), avec son compteur.
    await expect(badgeCount(sidebarItem(page, 'Suivi des courriers'))).toHaveText('3');
    for (const m of [enCours, traitee, copie]) await expect(worklistRow(page, m.title)).toBeVisible();
    await expect(worklistRow(page, horsPerimetre.title)).toHaveCount(0);

    await openFromWorklist(page, enCours.title);
    await expect(page).toHaveURL(new RegExp(`${MENUS.suivi}/${enCours.mailId}$`));
    await expect(actionButton(page, 'Marquer traité')).toBeVisible();
    await expect(actionButton(page, 'Archiver')).toHaveCount(0);
  });

  test('COU-33 — sans permission de suivi : entrée masquée, file et actions refusées, badge à 0', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-33 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou33-dest'), menus: [MENUS.controle] });
    // Imputé, mais sans aucun menu de suivi ni de workflow.
    const sans = await createCourrierActor(api, { prefix: uniq('cou33-sans'), menus: [MENUS.enregistrement] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-33'), dest, impute: sans, typeId: type.mailInputationTypeId });

    const sansApi = await apiAs(sans.username, sans.password);
    await expectForbidden(await sansApi.raw.get('/courriers/suivi'));
    expect((await getBadges(sansApi)).suivi).toBe(0);
    for (const action of ['imputations/traiter', 'validation-dg', 'decharge', 'enregistrement-reponse']) {
      await expectForbidden(await sansApi.raw.post(`/courriers/${mail.mailId}/${action}`, {}));
    }
    await expectForbidden(await sansApi.raw.post(`/courriers/${mail.mailId}/fiche-imputation/pdf`, {}));
    await expectForbidden(await sansApi.raw.post(`/courriers/${mail.mailId}/fiche-imputation`, {}));
    expect(await getMail(api, mail.mailId)).toMatchObject({
      validationDG: false,
      decharge: false,
      enregistrementReponse: false,
      dateTraited: null,
    });

    await loginAs(page, sans.username, sans.password);
    await page.goto(MENUS.enregistrement);
    await expect(sidebarItem(page, 'Enregistrement')).toBeVisible();
    await expect(sidebarItem(page, 'Suivi des courriers')).toHaveCount(0);
    expect((await gotoWorklist(page, MENUS.suivi, QUEUE_API.suivi)).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await expect(page.getByText('Aucun courrier en cours')).toBeVisible();
  });

  test('COU-33 — retrait du droit de suivi effectif sans reconnexion (rôle désactivé)', async ({ api, apiAs, uniq }) => {
    const suivi = await createCourrierActor(api, { prefix: uniq('cou33b-suivi'), menus: [MENUS.suivi] });
    const suiviApi = await apiAs(suivi.username, suivi.password);
    expect((await suiviApi.raw.get('/courriers/suivi')).status()).toBe(200);

    await api.patch(`/roles/${suivi.roleId}`, { isActive: false });
    // Même jeton : le garde relit le rôle en base.
    await expectForbidden(await suiviApi.raw.get('/courriers/suivi'));
    expect((await getBadges(suiviApi)).suivi).toBe(0);
  });

  test('COU-34 — fiche d’imputation : aperçu PDF, téléchargement DOCX, refus et 404', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-34 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou34-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou34-b'), menus: [MENUS.parapheur] });
    const suivi = await createCourrierActor(api, { prefix: uniq('cou34-suivi'), menus: [MENUS.suivi] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-34'), dest, impute: b, typeId: type.mailInputationTypeId });

    await loginAs(page, suivi.username, suivi.password);
    await gotoWorklist(page, MENUS.suivi, QUEUE_API.suivi);
    await showHundredRows(page, QUEUE_API.suivi);
    const pdf = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/fiche-imputation/pdf$`));
    await worklistRow(page, mail.title)
      .getByRole('button', { name: `Fiche d'imputation du courrier ${mail.nReference ?? mail.mailId}` })
      .click();
    const pdfRes = await pdf;
    expect(pdfRes.status()).toBe(200);
    expect(pdfRes.headers()['content-type']).toContain('application/pdf');
    const dialog = page.getByRole('dialog').filter({ hasText: "Fiche d'imputation" });
    await expect(dialog).toBeVisible();
    // Actions du PIED de la fenêtre : la visionneuse PDF a aussi son « Imprimer » (barre d'outils).
    const footer = dialog.locator('.ant-modal-footer');
    await expect(footer.getByRole('button', { name: 'Imprimer' })).toBeEnabled();

    const download = page.waitForEvent('download');
    const docx = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/fiche-imputation$`));
    await footer.getByRole('button', { name: 'Télécharger (DOCX)' }).click();
    expect((await docx).status()).toBe(200);
    expect((await download).suggestedFilename()).toBe(`FICHE_IMPUTATION_${mail.mailId}.docx`);
    await expect(toast(page, 'Fiche téléchargée (DOCX).')).toBeVisible();
    await footer.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialog).toBeHidden();

    // API : formats, nom de fichier, 404, refus sans le menu Suivi.
    const suiviApi = await apiAs(suivi.username, suivi.password);
    const pdfApi = await suiviApi.raw.post(`/courriers/${mail.mailId}/fiche-imputation/pdf`, {});
    expect(pdfApi.status()).toBe(200);
    expect((await pdfApi.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(pdfApi.headers()['content-disposition']).toContain(`FICHE_IMPUTATION_${mail.mailId}_`);
    const docxApi = await suiviApi.raw.post(`/courriers/${mail.mailId}/fiche-imputation`, {});
    expect(docxApi.status()).toBe(200);
    expect(docxApi.headers()['content-type']).toContain('wordprocessingml.document');
    expect((await docxApi.body()).subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await suiviApi.raw.post(`/courriers/${NO_SUCH_ID}/fiche-imputation/pdf`, {})).status()).toBe(404);
    await expectForbidden(await (await apiAs(b.username, b.password)).raw.post(`/courriers/${mail.mailId}/fiche-imputation/pdf`, {}));
  });

  test('COU-35 — fiche d’imputation pour un utilisateur au périmètre « Suivi DC »', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    // Décision de l'utilisateur (ANO-COU-12) : la fiche s'ouvre au menu « Suivi DC », limitée aux
    // courriers imputés à l'utilisateur.
    const type = await createInputationType(api, uniq('COU-35 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou35-dest'), menus: [MENUS.controle] });
    const dc = await createCourrierActor(api, { prefix: uniq('cou35-dc'), menus: [MENUS.suiviDC] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-35'), dest, impute: dc, typeId: type.mailInputationTypeId });
    const horsPerimetre = await createArrivee(api, { title: uniq('COU-35 Hors périmètre'), destinataireRoleId: dest.roleId });

    const dcApi = await apiAs(dc.username, dc.password);
    expect((await dcApi.raw.post(`/courriers/${mail.mailId}/fiche-imputation/pdf`, {})).status()).toBe(200);
    expect((await dcApi.raw.post(`/courriers/${mail.mailId}/fiche-imputation`, {})).status()).toBe(200);
    const refus = await dcApi.raw.post(`/courriers/${horsPerimetre.mailId}/fiche-imputation/pdf`, {});
    expect(refus.status()).toBe(403);
    expect(((await refus.json()) as { message: string }).message).toBe('Courrier hors de votre périmètre de suivi');
    expect((await dcApi.raw.post(`/courriers/${horsPerimetre.mailId}/fiche-imputation`, {})).status()).toBe(403);
    expect((await dcApi.raw.post(`/courriers/${NO_SUCH_ID}/fiche-imputation/pdf`, {})).status()).toBe(404);
    await loginAs(page, dc.username, dc.password);
    await gotoWorklist(page, MENUS.suivi, QUEUE_API.suivi);
    const pdf = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/fiche-imputation/pdf$`));
    await worklistRow(page, mail.title)
      .getByRole('button', { name: `Fiche d'imputation du courrier ${mail.nReference ?? mail.mailId}` })
      .click();
    expect((await pdf).status()).toBe(200);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toHaveCount(0);
  });

  test('COU-32 — le périmètre DC suit l’existence de l’imputation (ajout puis suppression)', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // Le périmètre DC suit l'EXISTENCE d'une imputation à l'utilisateur : la retirer le fait sortir.
    const type = await createInputationType(api, uniq('COU-33c Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou33c-dest'), menus: [MENUS.controle] });
    const dc = await createCourrierActor(api, { prefix: uniq('cou33c-dc'), menus: [MENUS.suiviDC] });
    const mail = await createArrivee(api, { title: uniq('COU-33c Objet'), destinataireRoleId: dest.roleId });
    const dcApi = await apiAs(dc.username, dc.password);
    expect((await queueIds(dcApi, '/courriers/suivi')).ids).not.toContain(mail.mailId);
    const destApi = await apiAs(dest.username, dest.password);
    const imp = (await imputer(destApi, {
      mailId: mail.mailId,
      userGroupId: dc.userGroupId,
      mailInputationTypeId: type.mailInputationTypeId,
    })) as { mailInputationId: number };
    expect((await queueIds(dcApi, '/courriers/suivi')).ids).toContain(mail.mailId);
    await destApi.del(`/courriers/imputations/${imp.mailInputationId}`);
    expect((await queueIds(dcApi, '/courriers/suivi')).ids).not.toContain(mail.mailId);
    expect((await getBadges(dcApi)).suivi).toBe(0);
  });
});
