import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  MENUS,
  arriveeImputee,
  createCourrierActor,
  getMail,
  imputer,
  sidebarItem,
  toast,
} from './_helpers';
import {
  QUEUE_API,
  actionButton,
  createInputationType,
  expectForbidden,
  gotoWorklist,
  imputationItem,
  inputationsOf,
  mailDetailApi,
  notificationsWithMessage,
  openFromWorklist,
  queueIds,
  showHundredRows,
  waitApi,
  worklistRow,
} from './_helpers/workflow-t2';

/**
 * Validation (§10) — `apps/web/app/courriers/validation/page.tsx` : file des courriers validés au
 * contrôle et non traités (`valider = true`, `dateTraited = null`, SANS périmètre), sélection
 * multiple + barre d'action « Marquer comme traité » (Popconfirm), ouverture en `MailViewer`
 * popup (actions de workflow en pied, « Traiter » par imputation, archivage).
 *
 * La file est GLOBALE : la grille passe à 100 lignes avant de chercher les lignes du test.
 */

const NO_SUCH_ID = 999_999_999;

test.describe('Validation (§10)', () => {
  test('COU-36 — validation Direction en lot : sélection, confirmation, courriers traités et notifiés', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-36 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou36-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou36-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou36-c'), menus: [MENUS.parapheur] });
    const v = await createCourrierActor(api, { prefix: uniq('cou36-v'), menus: [MENUS.validation] });
    const m1 = await arriveeImputee(api, { prefix: uniq('COU-36 un'), dest, impute: b, typeId: type.mailInputationTypeId });
    const m2 = await arriveeImputee(api, { prefix: uniq('COU-36 deux'), dest, impute: c, typeId: type.mailInputationTypeId });
    const m3 = await arriveeImputee(api, { prefix: uniq('COU-36 trois'), dest, impute: c, typeId: type.mailInputationTypeId });

    await loginAs(page, v.username, v.password);
    expect((await gotoWorklist(page, MENUS.validation, QUEUE_API.validation)).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 2, name: 'Validation' })).toBeVisible();
    // Barre d'action collante (le bouton OK de la Popconfirm porte le même libellé).
    const batch = page.locator('.da-sticky-actions').getByRole('button', { name: 'Marquer comme traité' });
    // Lot vide : action inactive, aucun appel possible.
    await expect(page.getByText('Sélectionnez des courriers à marquer comme traités.')).toBeVisible();
    await expect(batch).toBeDisabled();

    await showHundredRows(page, QUEUE_API.validation);
    for (const m of [m1, m2, m3]) await expect(worklistRow(page, m.title)).toBeVisible();
    await worklistRow(page, m1.title).getByRole('checkbox').check();
    await worklistRow(page, m2.title).getByRole('checkbox').check();
    await expect(page.getByText('2 courrier(s) sélectionné(s)')).toBeVisible();
    await expect(batch).toBeEnabled();

    // « Tout désélectionner » ramène au lot vide.
    await page.getByRole('button', { name: 'Tout désélectionner' }).click();
    await expect(batch).toBeDisabled();
    await worklistRow(page, m1.title).getByRole('checkbox').check();
    await worklistRow(page, m2.title).getByRole('checkbox').check();

    // Annuler la confirmation : rien n'est envoyé, la sélection reste.
    await batch.click();
    const confirm = page.locator('.ant-popconfirm');
    await expect(confirm.getByText('Marquer 2 courriers comme traités ?')).toBeVisible();
    await expect(confirm.getByText('Leurs imputations seront clôturées.')).toBeVisible();
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByText('2 courrier(s) sélectionné(s)')).toBeVisible();
    expect((await getMail(api, m1.mailId)).validationDirection).toBe(false);

    await batch.click();
    const sent = waitApi(page, 'POST', QUEUE_API.validation);
    await confirm.getByRole('button', { name: 'Marquer comme traité' }).click();
    const sentRes = await sent;
    expect(sentRes.status()).toBe(200);
    expect(sentRes.request().postDataJSON()).toEqual({ mailIds: expect.arrayContaining([m1.mailId, m2.mailId]) });
    expect(await sentRes.json()).toEqual({ updated: 2 });
    await expect(toast(page, '2 courrier(s) marqué(s) comme traité(s).')).toBeVisible();
    await expect(worklistRow(page, m1.title)).toHaveCount(0);
    await expect(worklistRow(page, m2.title)).toHaveCount(0);
    await expect(worklistRow(page, m3.title)).toBeVisible();
    await expect(page.getByText('Sélectionnez des courriers à marquer comme traités.')).toBeVisible();

    for (const m of [m1, m2]) {
      const after = await getMail(api, m.mailId);
      expect(after).toMatchObject({ validationDirection: true, status: 3 });
      expect(after.dateTraited).not.toBeNull();
      expect(after.inputations.every((i: { dateTreated: string | null }) => i.dateTreated != null)).toBe(true);
    }
    expect(await getMail(api, m3.mailId)).toMatchObject({ validationDirection: false, dateTraited: null });

    const destApi = await apiAs(dest.username, dest.password);
    const bApi = await apiAs(b.username, b.password);
    const cApi = await apiAs(c.username, c.password);
    expect(await notificationsWithMessage(destApi, `Validation Direction : ${m1.title}`)).toHaveLength(1);
    expect(await notificationsWithMessage(destApi, `Validation Direction : ${m2.title}`)).toHaveLength(1);
    expect(await notificationsWithMessage(bApi, `Validation Direction : ${m1.title}`)).toHaveLength(1);
    expect(await notificationsWithMessage(cApi, `Validation Direction : ${m2.title}`)).toHaveLength(1);
    expect(await notificationsWithMessage(cApi, `Validation Direction : ${m3.title}`)).toHaveLength(0);
    expect((await queueIds(bApi, '/courriers/parapheur')).ids).not.toContain(m1.mailId);
    expect((await queueIds(cApi, '/courriers/parapheur')).ids).toEqual([m3.mailId]);
  });

  test('COU-36 — erreurs de saisie : lot vide ou absent refusé (400), identifiants inconnus ignorés', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const v = await createCourrierActor(api, { prefix: uniq('cou36b-v'), menus: [MENUS.validation] });
    const vApi = await apiAs(v.username, v.password);
    expect((await vApi.raw.post('/courriers/validation-direction', { mailIds: [] })).status()).toBe(400);
    expect((await vApi.raw.post('/courriers/validation-direction', {})).status()).toBe(400);
    expect((await vApi.raw.post('/courriers/validation-direction', { mailIds: ['x'] })).status()).toBe(400);
    expect(await vApi.post('/courriers/validation-direction', { mailIds: [NO_SUCH_ID] })).toEqual({ updated: 0 });
  });

  test('COU-36 — un courrier déjà archivé ou traité n’est pas re-validé par le lot', async ({ api, apiAs, uniq }) => {
    // ANO-COU-13 corrigée : seuls les courriers de la file Validation sont mis à jour.
    const type = await createInputationType(api, uniq('COU-36c Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou36c-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou36c-b'), menus: [MENUS.parapheur] });
    const v = await createCourrierActor(api, { prefix: uniq('cou36c-v'), menus: [MENUS.validation] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-36c'), dest, impute: b, typeId: type.mailInputationTypeId });
    const vApi = await apiAs(v.username, v.password);
    await vApi.post(`/courriers/${mail.mailId}/archiver`, {});
    const archivedAt = (await getMail(api, mail.mailId)).dateTraited;
    expect(await vApi.post('/courriers/validation-direction', { mailIds: [mail.mailId] })).toEqual({ updated: 0 });
    expect(await getMail(api, mail.mailId)).toMatchObject({ status: 0, dateTraited: archivedAt, validationDirection: false });
  });

  test('COU-37 — visualiseur : « Traiter » par destinataire puis « Archiver » ; le courrier quitte la file', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-37 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou37-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou37-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou37-c'), menus: [MENUS.parapheur] });
    const v = await createCourrierActor(api, { prefix: uniq('cou37-v'), menus: [MENUS.validation] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-37'), dest, impute: b, typeId: type.mailInputationTypeId });
    await imputer(await apiAs(dest.username, dest.password), {
      mailId: mail.mailId,
      userGroupId: c.userGroupId,
      mailInputationTypeId: type.mailInputationTypeId,
    });

    await loginAs(page, v.username, v.password);
    await gotoWorklist(page, MENUS.validation, QUEUE_API.validation);
    await showHundredRows(page, QUEUE_API.validation);
    const loaded = waitApi(page, 'GET', mailDetailApi(mail.mailId));
    await openFromWorklist(page, mail.title);
    await loaded;
    const viewer = page.getByRole('dialog').filter({ hasText: mail.title });
    await expect(viewer).toBeVisible();
    for (const name of ['Marquer traité', 'Validation DG', 'Archiver']) await expect(actionButton(viewer, name)).toBeVisible();

    await viewer.getByRole('tab', { name: 'Imputations (2)' }).click();
    const itemB = imputationItem(viewer, b.fullName);
    const itemC = imputationItem(viewer, c.fullName);
    await expect(itemB).toContainText('En attente');
    await expect(itemC).toContainText('En attente');
    const treated = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/imputations/traiter-destinataire$`));
    await itemB.getByRole('button', { name: 'Traiter' }).click();
    const treatedRes = await treated;
    expect(treatedRes.status()).toBe(200);
    expect(treatedRes.request().postDataJSON()).toEqual({ userGroupId: b.userGroupId });
    await expect(toast(page, `Imputations de ${b.fullName} traitées.`)).toBeVisible();
    await expect(itemB).toContainText('Traitée');
    await expect(itemB.getByRole('button', { name: 'Traiter' })).toHaveCount(0);
    await expect(itemC).toContainText('En attente');

    let after = await getMail(api, mail.mailId);
    expect(inputationsOf(after, b.userGroupId)[0]!.dateTreated).not.toBeNull();
    expect(inputationsOf(after, c.userGroupId)[0]!.dateTreated).toBeNull();
    expect(after).toMatchObject({ status: 0, dateTraited: null }); // pas de traitement forcé du courrier
    expect(
      await notificationsWithMessage(await apiAs(dest.username, dest.password), `Imputation traitée par ${b.fullName} : ${mail.title}`),
    ).toHaveLength(1);
    expect((await queueIds(await apiAs(b.username, b.password), '/courriers/parapheur')).ids).not.toContain(mail.mailId);
    expect((await queueIds(await apiAs(c.username, c.password), '/courriers/parapheur')).ids).toContain(mail.mailId);

    const archived = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/archiver$`));
    await actionButton(viewer, 'Archiver').click();
    expect((await archived).status()).toBe(200);
    await expect(toast(page, 'Courrier archivé.')).toBeVisible();
    await expect(actionButton(viewer, 'Archiver')).toHaveCount(0);
    await expect(actionButton(viewer, 'Marquer traité')).toHaveCount(0);
    await viewer.getByRole('button', { name: 'Fermer' }).click();
    await expect(viewer).toBeHidden();
    await expect(worklistRow(page, mail.title)).toHaveCount(0);

    after = await getMail(api, mail.mailId);
    expect(after).toMatchObject({ status: 0, validationDirection: false });
    expect(after.dateTraited).not.toBeNull();
  });

  test('COU-38 — sans le menu Validation : entrée masquée, file, lot et traitement refusés (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-38 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou38-dest'), menus: [MENUS.controle] });
    const sans = await createCourrierActor(api, { prefix: uniq('cou38-sans'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-38'), dest, impute: sans, typeId: type.mailInputationTypeId });

    const sansApi = await apiAs(sans.username, sans.password);
    await expectForbidden(await sansApi.raw.get('/courriers/validation-direction'));
    await expectForbidden(await sansApi.raw.post('/courriers/validation-direction', { mailIds: [mail.mailId] }));
    await expectForbidden(
      await sansApi.raw.post(`/courriers/${mail.mailId}/imputations/traiter-destinataire`, { userGroupId: sans.userGroupId }),
    );
    const unchanged = await getMail(api, mail.mailId);
    expect(unchanged).toMatchObject({ validationDirection: false, dateTraited: null });
    expect(inputationsOf(unchanged, sans.userGroupId)[0]!.dateTreated).toBeNull();

    await loginAs(page, sans.username, sans.password);
    await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur);
    await expect(sidebarItem(page, 'Courriers Imputés')).toBeVisible();
    await expect(sidebarItem(page, 'Validation')).toHaveCount(0);
    expect((await gotoWorklist(page, MENUS.validation, QUEUE_API.validation)).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await expect(page.getByText('Aucun courrier à traiter')).toBeVisible();
    await expect(page.locator('.da-sticky-actions').getByRole('button', { name: 'Marquer comme traité' })).toBeDisabled();
  });
});
