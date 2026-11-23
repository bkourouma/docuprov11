import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  INPUTATION_TYPE,
  MENUS,
  arriveeImputee,
  createArrivee,
  createCourrierActor,
  fillDate,
  getMail,
  imputer,
  openDropdown,
  selectOption,
  sidebarItem,
  toast,
} from './_helpers';
import {
  QUEUE_API,
  actionButton,
  badgeCount,
  chooseOption,
  createEmptyRole,
  createInputationType,
  expectForbidden,
  expectHoursAfter,
  expectSameLocalDay,
  frDateInDays,
  getBadges,
  gotoWorklist,
  imputationItem,
  imputationItemOf,
  imputationsTab,
  inputationsOf,
  lectureApi,
  mailDetailApi,
  notificationsWithMessage,
  openFromWorklist,
  queueIds,
  statusTag,
  waitApi,
  worklistRow,
} from './_helpers/workflow-t2';

/**
 * Parapheur / « Courriers Imputés » (§08) — `apps/web/app/courriers/parapheur/page.tsx` (file
 * PERSONNELLE de l'imputé) et `parapheur/[mailId]/page.tsx` (`MailDetailPage` avec
 * `autoTreatOnOpen` + `onlyMyImputations`).
 *
 * Règles lues dans le code (phase A) :
 *  - la file = au moins une imputation À L'UTILISATEUR, non traitée, de type ≠ 17 (En Copie) ;
 *  - ouvrir la fiche appelle `POST :id/imputations/lecture` : les imputations de type `suivi=true`
 *    (10 Pour Suivi) sont traitées, et le courrier passe Traité si toutes le sont ;
 *  - chacun ne voit que SA branche (`?imputations=mine`) sauf le destinataire principal et l'admin.
 *
 * Pour qu'une ouverture de fiche ne traite pas l'imputation à l'insu du test, la plupart des tests
 * imputent avec un type NEUF `suivi=false` (créé par l'admin, libellé unique).
 */

const NO_SUCH_ID = 999_999_999;

test.describe('Parapheur — Courriers Imputés (§08)', () => {
  test('COU-20 — file personnelle de l’imputé, badge du menu et ouverture de la fiche', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-20 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou20-dest'), menus: [MENUS.controle] });
    const impute = await createCourrierActor(api, { prefix: uniq('cou20-impute'), menus: [MENUS.parapheur] });
    const autre = await createCourrierActor(api, { prefix: uniq('cou20-autre'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, {
      prefix: uniq('COU-20'),
      dest,
      impute,
      typeId: type.mailInputationTypeId,
    });

    const imputeApi = await apiAs(impute.username, impute.password);
    const file = await queueIds(imputeApi, '/courriers/parapheur');
    expect(file.ids).toEqual([mail.mailId]);
    expect((await getBadges(imputeApi)).parapheur).toBe(file.total);
    expect((await queueIds(await apiAs(autre.username, autre.password), '/courriers/parapheur')).ids).not.toContain(
      mail.mailId,
    );

    await loginAs(page, impute.username, impute.password);
    expect((await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur)).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 2, name: 'Courriers Imputés' })).toBeVisible();
    await expect(badgeCount(sidebarItem(page, 'Courriers Imputés'))).toHaveText('1');
    const row = worklistRow(page, mail.title);
    await expect(row).toBeVisible();
    await expect(row).toContainText(dest.roleName);
    if (mail.nReference) await expect(row).toContainText(mail.nReference);
    // Statut masqué dans cette file (constant) ; l'échéance reste affichée.
    await expect(page.getByRole('columnheader', { name: 'Statut' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Date butoir' })).toBeVisible();

    const lecture = waitApi(page, 'POST', lectureApi(mail.mailId));
    const detail = waitApi(page, 'GET', mailDetailApi(mail.mailId));
    await openFromWorklist(page, mail.title);
    expect((await lecture).status()).toBe(200);
    const detailRes = await detail;
    expect(new URL(detailRes.url()).searchParams.get('imputations')).toBe('mine');
    await expect(page).toHaveURL(new RegExp(`${MENUS.parapheur}/${mail.mailId}$`));
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Courrier' })).toBeVisible();
    await imputationsTab(page).click();
    await expect(page.getByRole('tab', { name: 'Imputations (1)' })).toBeVisible();
    const item = imputationItem(page, type.label);
    await expect(item).toContainText(impute.fullName);
    await expect(item).toContainText(`par ${dest.fullName}`);

    // Type non « suivi » : la lecture ne l'a PAS traité, le courrier reste dans la file.
    const after = await getMail(api, mail.mailId);
    expect(inputationsOf(after, impute.userGroupId)[0]!.dateTreated).toBeNull();
    expect(after.dateTraited).toBeNull();
    await page.getByRole('button', { name: 'Retour à la liste' }).click();
    await expect(page).toHaveURL(new RegExp(`${MENUS.parapheur}$`));
    await expect(worklistRow(page, mail.title)).toBeVisible();

    // Un autre porteur du menu n'y voit rien.
    await loginAs(page, autre.username, autre.password);
    expect((await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur)).status()).toBe(200);
    await expect(worklistRow(page, mail.title)).toHaveCount(0);
    await expect(page.getByText('Aucun courrier imputé')).toBeVisible();
  });

  test('COU-21 — ré-imputation depuis le parapheur : rôle → porteur, type, instructions, échéance', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-21 Pour attribution'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou21-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou21-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou21-c'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-21'), dest, impute: b, typeId: type.mailInputationTypeId });
    const deadline = frDateInDays(7);

    await loginAs(page, b.username, b.password);
    const lecture = waitApi(page, 'POST', lectureApi(mail.mailId));
    await page.goto(`${MENUS.parapheur}/${mail.mailId}`);
    await lecture;
    await page.getByRole('tab', { name: 'Imputations (1)' }).click();
    await page.getByRole('button', { name: 'Ajouter une imputation' }).click();

    await selectOption(page, page.getByLabel('Rôle', { exact: true }), c.roleName);
    await selectOption(page, page.getByLabel('Imputer à'), c.fullName, { multiple: true });
    await selectOption(page, page.getByLabel("Type d'imputation"), type.label);
    await fillDate(page.getByLabel('Échéance (facultatif)'), deadline);
    await page.getByLabel('Instructions (facultatif)').fill('Préparer une réponse COU-21');

    const created = waitApi(page, 'POST', /\/api\/courriers\/imputations$/);
    await page.getByRole('button', { name: 'Imputer', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(toast(page, 'Imputation créée.')).toBeVisible();
    // Sa branche : sa propre imputation + celle qu'il vient de créer.
    await expect(page.getByRole('tab', { name: 'Imputations (2)' })).toBeVisible();
    const item = imputationItemOf(page, c.fullName);
    await expect(item).toContainText(type.label);
    await expect(item).toContainText('Préparer une réponse COU-21');
    await expect(item).toContainText(`Échéance ${deadline}`);
    await expect(item).toContainText(`par ${b.fullName}`);
    // Pas de suppression au parapheur (réservée à l'auteur, depuis le Contrôle).
    await expect(item.getByRole('button', { name: 'Supprimer' })).toHaveCount(0);

    const after = await getMail(api, mail.mailId);
    const toC = inputationsOf(after, c.userGroupId);
    expect(toC).toHaveLength(1);
    expect(toC[0]).toMatchObject({
      mailInputationTypeId: type.mailInputationTypeId,
      instructions: 'Préparer une réponse COU-21',
      createdBy: b.userGroupId,
      dateTreated: null,
    });
    await expectSameLocalDay(page, toC[0]!.deadline, deadline);
    expect(after.valider).toBe(true);

    const cApi = await apiAs(c.username, c.password);
    expect((await queueIds(cApi, '/courriers/parapheur')).ids).toContain(mail.mailId);
    expect(await notificationsWithMessage(cApi, `Courrier imputé : ${mail.title}`)).toHaveLength(1);
    // B garde le courrier : sa propre imputation n'est pas traitée par la ré-imputation.
    expect((await queueIds(await apiAs(b.username, b.password), '/courriers/parapheur')).ids).toContain(mail.mailId);
  });

  test('COU-22 — erreurs de saisie : imputation sans destinataire ou sans type, refus API lisibles', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-22 Pour avis'));
    const vide = await createEmptyRole(api, uniq('COU-22 rôle vide'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou22-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou22-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou22-c'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-22'), dest, impute: b, typeId: type.mailInputationTypeId });

    // ---- Écran : le bouton « Imputer » reste inactif tant que destinataire ET type manquent.
    await loginAs(page, b.username, b.password);
    await page.goto(`${MENUS.parapheur}/${mail.mailId}`);
    await page.getByRole('tab', { name: 'Imputations (1)' }).click();
    await page.getByRole('button', { name: 'Ajouter une imputation' }).click();
    const imputerBtn = page.getByRole('button', { name: 'Imputer', exact: true });
    const actors = page.getByLabel('Imputer à');
    await expect(imputerBtn).toBeDisabled();
    await expect(actors).toBeDisabled(); // « Choisissez d’abord un rôle »
    await expect(page.getByText('Choisissez d’abord un rôle')).toBeVisible();

    await selectOption(page, page.getByLabel('Rôle', { exact: true }), vide.name);
    await actors.click();
    await expect(openDropdown(page).getByText('Aucun utilisateur actif ne porte ce rôle')).toBeVisible();
    await actors.press('Escape');
    await expect(imputerBtn).toBeDisabled();

    // Le Rôle porte déjà une valeur (le rôle vide) : `chooseOption` ouvre la liste par le conteneur.
    await chooseOption(page, page.getByLabel('Rôle', { exact: true }), c.roleName);
    await selectOption(page, actors, c.fullName, { multiple: true });
    await expect(imputerBtn).toBeDisabled(); // destinataire choisi, type manquant
    await selectOption(page, page.getByLabel("Type d'imputation"), type.label);
    await expect(imputerBtn).toBeEnabled();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Ajouter une imputation' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Imputations (1)' })).toBeVisible();
    expect((await getMail(api, mail.mailId)).inputations).toHaveLength(1);

    // ---- API : champs manquants (Zod → 400), référence inconnue (400), courrier absent (404).
    const bApi = await apiAs(b.username, b.password);
    const base = { mailId: mail.mailId, userGroupId: c.userGroupId, mailInputationTypeId: type.mailInputationTypeId };
    const sansType = await bApi.raw.post('/courriers/imputations', { mailId: mail.mailId, userGroupId: c.userGroupId });
    expect(sansType.status()).toBe(400);
    const sansDest = await bApi.raw.post('/courriers/imputations', {
      mailId: mail.mailId,
      mailInputationTypeId: type.mailInputationTypeId,
    });
    expect(sansDest.status()).toBe(400);

    const typeInconnu = await bApi.raw.post('/courriers/imputations', { ...base, mailInputationTypeId: NO_SUCH_ID });
    expect(typeInconnu.status()).toBe(400);
    expect(((await typeInconnu.json()) as { message: string }).message).toBe("Type d'imputation introuvable");
    const destInconnu = await bApi.raw.post('/courriers/imputations', { ...base, userGroupId: NO_SUCH_ID });
    expect(destInconnu.status()).toBe(400);
    expect(((await destInconnu.json()) as { message: string }).message).toBe(
      "Destinataire de l'imputation introuvable",
    );
    const courrierInconnu = await bApi.raw.post('/courriers/imputations', { ...base, mailId: NO_SUCH_ID });
    expect(courrierInconnu.status()).toBe(404);

    // Courrier supprimé (logiquement) : plus imputable.
    const supprime = await createArrivee(api, { title: uniq('COU-22 supprimé'), destinataireRoleId: dest.roleId });
    await (await apiAs(dest.username, dest.password)).del(`/courriers/${supprime.mailId}`);
    expect((await bApi.raw.post('/courriers/imputations', { ...base, mailId: supprime.mailId })).status()).toBe(404);

    expect((await getMail(api, mail.mailId)).inputations).toHaveLength(1);
    expect(await notificationsWithMessage(await apiAs(c.username, c.password), `Courrier imputé : ${mail.title}`)).toHaveLength(0);
  });

  test('COU-23 — « En Copie » n’entre pas au parapheur (file et badge) mais reste consultable au Suivi', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-23 Pour attribution'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou23-dest'), menus: [MENUS.controle] });
    const copie = await createCourrierActor(api, {
      prefix: uniq('cou23-copie'),
      menus: [MENUS.parapheur, MENUS.suiviDC],
    });
    const mail = await createArrivee(api, {
      title: uniq('COU-23 Objet'),
      destinataireRoleId: dest.roleId,
      enCopieUserGroupIds: [copie.userGroupId],
    });

    const copieApi = await apiAs(copie.username, copie.password);
    const detail = await getMail(api, mail.mailId);
    expect(inputationsOf(detail, copie.userGroupId).map((i) => i.mailInputationTypeId)).toEqual([INPUTATION_TYPE.enCopie]);
    expect((await queueIds(copieApi, '/courriers/parapheur')).ids).not.toContain(mail.mailId);
    expect((await getBadges(copieApi)).parapheur).toBe(0);
    expect((await queueIds(copieApi, '/courriers/suivi')).ids).toContain(mail.mailId);
    expect(
      await notificationsWithMessage(copieApi, `Courrier enregistré, vous êtes en copie : ${mail.title}`),
    ).toHaveLength(1);

    await loginAs(page, copie.username, copie.password);
    expect((await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur)).status()).toBe(200);
    await expect(worklistRow(page, mail.title)).toHaveCount(0);
    await expect(page.getByText('Aucun courrier imputé')).toBeVisible();
    await expect(badgeCount(sidebarItem(page, 'Courriers Imputés'))).toHaveCount(0);
    expect((await gotoWorklist(page, MENUS.suivi, QUEUE_API.suivi)).status()).toBe(200);
    await expect(worklistRow(page, mail.title)).toBeVisible();

    // Réellement imputé EN PLUS de la copie : le courrier entre alors dans son parapheur.
    await imputer(await apiAs(dest.username, dest.password), {
      mailId: mail.mailId,
      userGroupId: copie.userGroupId,
      mailInputationTypeId: type.mailInputationTypeId,
    });
    expect((await queueIds(copieApi, '/courriers/parapheur')).ids).toEqual([mail.mailId]);
    expect((await getBadges(copieApi)).parapheur).toBe(1);
    expect((await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur)).status()).toBe(200);
    await expect(worklistRow(page, mail.title)).toBeVisible();
  });

  test('COU-24 — lecture : une imputation « Pour Suivi » se traite à l’ouverture et le courrier sort de la file', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou24-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou24-b'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-24'), dest, impute: b }); // Pour Suivi (10)
    const bApi = await apiAs(b.username, b.password);
    expect((await queueIds(bApi, '/courriers/parapheur')).ids).toEqual([mail.mailId]);

    await loginAs(page, b.username, b.password);
    await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur);
    const lecture = waitApi(page, 'POST', lectureApi(mail.mailId));
    await openFromWorklist(page, mail.title);
    const lectureRes = await lecture;
    expect(lectureRes.status()).toBe(200);
    expect(((await lectureRes.json()) as { allTreated: boolean }).allTreated).toBe(true);
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();
    await expect(statusTag(page, 'Traité')).toBeVisible();

    const after = await getMail(api, mail.mailId);
    expect(after.status).toBe(3);
    expect(after.dateTraited).not.toBeNull();
    expect(inputationsOf(after, b.userGroupId)[0]!.dateTreated).not.toBeNull();
    expect((await queueIds(bApi, '/courriers/parapheur')).ids).not.toContain(mail.mailId);
    expect((await getBadges(bApi)).parapheur).toBe(0);
    expect((await queueIds(api, '/courriers/suivi')).ids).not.toContain(mail.mailId);

    await page.getByRole('button', { name: 'Retour à la liste' }).click();
    await expect(page.getByText('Aucun courrier imputé')).toBeVisible();
  });

  test('COU-24 — la lecture ne traite que les imputations « suivi » DU LECTEUR', async ({ api, apiAs, uniq }) => {
    test.fixme(
      true,
      "Question métier Q1 : MailInputationsService.treatOnRead traite TOUTES les imputations de type suivi du courrier, quel que soit le lecteur (et sans vérifier qu'il est imputé). Attendu supposé : l'ouverture par B ne traite pas l'imputation « Pour Suivi » de C.",
    );
    const type = await createInputationType(api, uniq('COU-24b Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou24b-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou24b-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou24b-c'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-24b'), dest, impute: b, typeId: type.mailInputationTypeId });
    await imputer(await apiAs(dest.username, dest.password), {
      mailId: mail.mailId,
      userGroupId: c.userGroupId,
      mailInputationTypeId: INPUTATION_TYPE.pourSuivi,
    });
    await (await apiAs(b.username, b.password)).post(`/courriers/${mail.mailId}/imputations/lecture`, {});
    expect(inputationsOf(await getMail(api, mail.mailId), c.userGroupId)[0]!.dateTreated).toBeNull();
    expect((await queueIds(await apiAs(c.username, c.password), '/courriers/parapheur')).ids).toContain(mail.mailId);
  });

  test('COU-25 — chacun ne voit que sa branche d’imputations ; le destinataire principal voit tout', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-25 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou25-dest'), menus: [MENUS.controle, MENUS.parapheur] });
    const b = await createCourrierActor(api, { prefix: uniq('cou25-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou25-c'), menus: [MENUS.parapheur] });
    const d = await createCourrierActor(api, { prefix: uniq('cou25-d'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-25'), dest, impute: b, typeId: type.mailInputationTypeId });
    const destApi = await apiAs(dest.username, dest.password);
    await imputer(destApi, { mailId: mail.mailId, userGroupId: d.userGroupId, mailInputationTypeId: type.mailInputationTypeId });
    const bApi = await apiAs(b.username, b.password);
    await imputer(bApi, { mailId: mail.mailId, userGroupId: c.userGroupId, mailInputationTypeId: type.mailInputationTypeId });

    type Detail = { inputations: Array<{ userId: number }> };
    const users = (m: unknown) => (m as Detail).inputations.map((i) => i.userId).sort((x, y) => x - y);
    const sorted = (...ids: number[]) => [...ids].sort((x, y) => x - y);
    const mine = `/courriers/${mail.mailId}?imputations=mine`;
    expect(users(await bApi.get(mine))).toEqual(sorted(b.userGroupId, c.userGroupId));
    expect(users(await (await apiAs(c.username, c.password)).get(mine))).toEqual([c.userGroupId]);
    expect(users(await destApi.get(mine))).toEqual(sorted(b.userGroupId, c.userGroupId, d.userGroupId));
    expect(users(await api.get(mine))).toEqual(sorted(b.userGroupId, c.userGroupId, d.userGroupId));
    // Sans le paramètre (consultation), la chaîne complète.
    expect(users(await bApi.get(`/courriers/${mail.mailId}`))).toHaveLength(3);

    await loginAs(page, b.username, b.password);
    await page.goto(`${MENUS.parapheur}/${mail.mailId}`);
    await page.getByRole('tab', { name: 'Imputations (2)' }).click();
    // Par IMPUTÉ : le nom de B figure aussi dans l'historique de l'imputation qu'il a créée pour C.
    await expect(imputationItemOf(page, b.fullName)).toBeVisible();
    await expect(imputationItemOf(page, c.fullName)).toBeVisible();
    await expect(imputationItemOf(page, d.fullName)).toHaveCount(0);

    await loginAs(page, dest.username, dest.password);
    await page.goto(`${MENUS.parapheur}/${mail.mailId}`);
    await expect(page.getByRole('tab', { name: 'Imputations (3)' })).toBeVisible();
  });

  test('COU-26 — « Marquer traité » d’un courrier imputé (API, menu Parapheur) : tout est clôturé', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-26 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou26-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou26-b'), menus: [MENUS.parapheur] });
    const c = await createCourrierActor(api, { prefix: uniq('cou26-c'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-26'), dest, impute: b, typeId: type.mailInputationTypeId });
    await imputer(await apiAs(dest.username, dest.password), {
      mailId: mail.mailId,
      userGroupId: c.userGroupId,
      mailInputationTypeId: type.mailInputationTypeId,
    });

    const bApi = await apiAs(b.username, b.password);
    const res = (await bApi.post(`/courriers/${mail.mailId}/imputations/traiter`, {})) as { allTreated: boolean };
    expect(res.allTreated).toBe(true);
    const after = await getMail(api, mail.mailId);
    expect(after.status).toBe(3);
    expect(after.dateTraited).not.toBeNull();
    expect(after.inputations.every((i: { dateTreated: string | null }) => i.dateTreated != null)).toBe(true);
    expect((await queueIds(bApi, '/courriers/parapheur')).ids).not.toContain(mail.mailId);
    expect((await queueIds(await apiAs(c.username, c.password), '/courriers/parapheur')).ids).not.toContain(mail.mailId);
    expect((await bApi.raw.post(`/courriers/${NO_SUCH_ID}/imputations/traiter`, {})).status()).toBe(404);
  });

  test('COU-26 — la fiche du parapheur propose les actions de workflow et « Traiter » par imputation', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    test.fixme(
      true,
      "Anomalie A1 : parapheur/[mailId]/page.tsx ne passe ni showWorkflowActions ni canTreatImputations à MailDetailPage, alors que son commentaire annonce « les actions de workflow (§03.2) et le traitement par imputation (§10) restent disponibles » et que l'API autorise le Parapheur (traiter, archiver). NB : traiter-destinataire n'est gardé que par /courriers/validation (question métier).",
    );
    const type = await createInputationType(api, uniq('COU-26b Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou26b-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou26b-b'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-26b'), dest, impute: b, typeId: type.mailInputationTypeId });

    await loginAs(page, b.username, b.password);
    await page.goto(`${MENUS.parapheur}/${mail.mailId}`);
    await expect(actionButton(page, 'Marquer traité')).toBeVisible();
    await expect(actionButton(page, 'Archiver')).toBeVisible();
    await page.getByRole('tab', { name: 'Imputations (1)' }).click();
    await expect(imputationItem(page, b.fullName).getByRole('button', { name: 'Traiter' })).toBeVisible();
    await expect(imputationItem(page, b.fullName)).toContainText('En attente');

    const treated = waitApi(page, 'POST', new RegExp(`/api/courriers/${mail.mailId}/imputations/traiter$`));
    await actionButton(page, 'Marquer traité').click();
    expect((await treated).status()).toBe(200);
    await expect(toast(page, 'Courrier traité.')).toBeVisible();
    await expect(statusTag(page, 'Traité')).toBeVisible();
  });

  test('COU-27 — archivage (menus Parapheur/Validation) : date de traitement posée, statut inchangé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-27 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou27-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou27-b'), menus: [MENUS.parapheur] });
    const suivi = await createCourrierActor(api, { prefix: uniq('cou27-suivi'), menus: [MENUS.suivi] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-27'), dest, impute: b, typeId: type.mailInputationTypeId });

    // Le Suivi n'archive pas : bouton absent de sa fiche, API refusée.
    const suiviApi = await apiAs(suivi.username, suivi.password);
    await expectForbidden(await suiviApi.raw.post(`/courriers/${mail.mailId}/archiver`, {}));
    await loginAs(page, suivi.username, suivi.password);
    await page.goto(`${MENUS.suivi}/${mail.mailId}`);
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();
    await expect(actionButton(page, 'Marquer traité')).toBeVisible();
    await expect(actionButton(page, 'Archiver')).toHaveCount(0);

    const bApi = await apiAs(b.username, b.password);
    const archived = (await bApi.post(`/courriers/${mail.mailId}/archiver`, {})) as {
      dateTraited: string | null;
      status: number;
    };
    expect(archived.dateTraited).not.toBeNull();
    expect(archived.status).toBe(0);
    const after = await getMail(api, mail.mailId);
    expect(after).toMatchObject({ status: 0, valider: true, validationDirection: false });
    expect((await queueIds(suiviApi, '/courriers/suivi')).ids).not.toContain(mail.mailId);
    expect((await queueIds(api, '/courriers/validation-direction')).ids).not.toContain(mail.mailId);
    expect(
      await notificationsWithMessage(await apiAs(dest.username, dest.password), `Courrier archivé : ${mail.title}`),
    ).toHaveLength(1);
    expect((await bApi.raw.post(`/courriers/${NO_SUCH_ID}/archiver`, {})).status()).toBe(404);
  });

  test('COU-27 — un courrier archivé sort du parapheur de ses imputés', async ({ api, apiAs, uniq }) => {
    test.fixme(
      true,
      "Question métier Q2 : MailsService.listParapheur (et le badge parapheur) ne filtrent pas dateTraited ; l'archivage ne traite pas les imputations, le courrier archivé reste donc indéfiniment dans le parapheur. Attendu supposé : il en sort.",
    );
    const type = await createInputationType(api, uniq('COU-27b Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou27b-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou27b-b'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-27b'), dest, impute: b, typeId: type.mailInputationTypeId });
    const bApi = await apiAs(b.username, b.password);
    await bApi.post(`/courriers/${mail.mailId}/archiver`, {});
    expect((await queueIds(bApi, '/courriers/parapheur')).ids).not.toContain(mail.mailId);
    expect((await getBadges(bApi)).parapheur).toBe(0);
  });

  test('COU-28 — sans le menu Parapheur : entrée masquée, file et actions refusées (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-28 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou28-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou28-b'), menus: [MENUS.parapheur] });
    const sans = await createCourrierActor(api, { prefix: uniq('cou28-sans'), menus: [MENUS.enregistrement] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-28'), dest, impute: b, typeId: type.mailInputationTypeId });

    const sansApi = await apiAs(sans.username, sans.password);
    await expectForbidden(await sansApi.raw.get('/courriers/parapheur'));
    await expectForbidden(
      await sansApi.raw.post('/courriers/imputations', {
        mailId: mail.mailId,
        userGroupId: b.userGroupId,
        mailInputationTypeId: type.mailInputationTypeId,
      }),
    );
    await expectForbidden(await sansApi.raw.post(`/courriers/${mail.mailId}/imputations/lecture`, {}));
    await expectForbidden(
      await sansApi.raw.post('/courriers/imputations/validation', { mailId: mail.mailId, userGroupId: b.userGroupId }),
    );
    await expectForbidden(await sansApi.raw.post(`/courriers/${mail.mailId}/imputations/traiter`, {}));
    await expectForbidden(await sansApi.raw.post(`/courriers/${mail.mailId}/archiver`, {}));
    const unchanged = await getMail(api, mail.mailId);
    expect(unchanged.inputations).toHaveLength(1);
    expect(unchanged.dateTraited).toBeNull();

    await loginAs(page, sans.username, sans.password);
    await page.goto(MENUS.enregistrement);
    await expect(sidebarItem(page, 'Enregistrement')).toBeVisible();
    await expect(sidebarItem(page, 'Courriers Imputés')).toHaveCount(0);
    expect((await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur)).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await expect(page.getByText('Aucun courrier imputé')).toBeVisible();
  });

  test('COU-28 — suppression d’une imputation : réservée à son auteur', async ({ api, apiAs, uniq }) => {
    const type = await createInputationType(api, uniq('COU-28b Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou28b-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou28b-b'), menus: [MENUS.parapheur] });
    const tiers = await createCourrierActor(api, { prefix: uniq('cou28b-tiers'), menus: [MENUS.controle, MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-28b'), dest, impute: b, typeId: type.mailInputationTypeId });
    const imp = inputationsOf(await getMail(api, mail.mailId), b.userGroupId)[0]!;
    expect(imp.createdBy).toBe(dest.userGroupId);

    // L'imputé, sans le menu Contrôle : refus du garde.
    await expectForbidden(await (await apiAs(b.username, b.password)).raw.del(`/courriers/imputations/${imp.mailInputationId}`));
    // Un tiers qui a le menu, mais n'est pas l'auteur : refus métier.
    const notAuthor = await (await apiAs(tiers.username, tiers.password)).raw.del(
      `/courriers/imputations/${imp.mailInputationId}`,
    );
    expect(notAuthor.status()).toBe(403);
    expect(((await notAuthor.json()) as { message: string }).message).toBe("Seul l'auteur de l'imputation peut la supprimer");
    expect((await getMail(api, mail.mailId)).inputations).toHaveLength(1);

    // L'auteur : supprimée, puis introuvable.
    const destApi = await apiAs(dest.username, dest.password);
    expect(await destApi.del(`/courriers/imputations/${imp.mailInputationId}`)).toEqual({ deleted: true });
    expect((await destApi.raw.del(`/courriers/imputations/${imp.mailInputationId}`)).status()).toBe(404);
    expect((await getMail(api, mail.mailId)).inputations).toHaveLength(0);
  });

  test('COU-29 — soumission à validation DG / Direction (API) : imputation 5 / 14 à +48 h, valideur notifié', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-29 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou29-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou29-b'), menus: [MENUS.parapheur] });
    const dg = await createCourrierActor(api, { prefix: uniq('cou29-dg'), menus: [MENUS.parapheur] });
    const dir = await createCourrierActor(api, { prefix: uniq('cou29-dir'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-29'), dest, impute: b, typeId: type.mailInputationTypeId });
    const bApi = await apiAs(b.username, b.password);

    const t0 = Date.now();
    const toDg = (await bApi.post('/courriers/imputations/validation', {
      mailId: mail.mailId,
      userGroupId: dg.userGroupId,
      isDG: true,
    })) as { mailInputationTypeId: number; createdBy: number; deadline: string };
    expect(toDg).toMatchObject({ mailInputationTypeId: INPUTATION_TYPE.validationDG, createdBy: b.userGroupId });
    expectHoursAfter(toDg.deadline, t0, 48);
    const toDir = (await bApi.post('/courriers/imputations/validation', {
      mailId: mail.mailId,
      userGroupId: dir.userGroupId,
    })) as { mailInputationTypeId: number; deadline: string };
    expect(toDir.mailInputationTypeId).toBe(INPUTATION_TYPE.validationDirection);
    expectHoursAfter(toDir.deadline, t0, 48);

    const dgApi = await apiAs(dg.username, dg.password);
    expect(await notificationsWithMessage(dgApi, `Soumission à validation DG : ${mail.title}`)).toHaveLength(1);
    expect((await queueIds(dgApi, '/courriers/parapheur')).ids).toContain(mail.mailId);
    const dirApi = await apiAs(dir.username, dir.password);
    expect(await notificationsWithMessage(dirApi, `Soumission à validation Direction : ${mail.title}`)).toHaveLength(1);
    // Les types de validation ne sont pas « suivi » : la lecture par le valideur ne les traite pas.
    await dgApi.post(`/courriers/${mail.mailId}/imputations/lecture`, {});
    expect(inputationsOf(await getMail(api, mail.mailId), dg.userGroupId)[0]!.dateTreated).toBeNull();

    // Erreurs de saisie et refus.
    expect((await bApi.raw.post('/courriers/imputations/validation', { mailId: mail.mailId })).status()).toBe(400);
    expect(
      (await bApi.raw.post('/courriers/imputations/validation', { mailId: mail.mailId, userGroupId: NO_SUCH_ID })).status(),
    ).toBe(400);
    expect(
      (await bApi.raw.post('/courriers/imputations/validation', { mailId: NO_SUCH_ID, userGroupId: dg.userGroupId })).status(),
    ).toBe(404);
    await expectForbidden(
      await (await apiAs(dest.username, dest.password)).raw.post('/courriers/imputations/validation', {
        mailId: mail.mailId,
        userGroupId: dg.userGroupId,
      }),
    );
    expect(inputationsOf(await getMail(api, mail.mailId))).toHaveLength(3);
  });

  test('COU-29 — soumission à validation depuis la fiche du parapheur', async ({ page, api, loginAs, uniq }) => {
    test.fixme(
      true,
      "Question métier Q7 : aucun écran n'expose la soumission à validation DG/Direction (lib/courriers.ts `submitValidation` n'est appelé nulle part). Libellé et emplacement du bouton à définir ; scénario P3 écrit sur l'hypothèse « Soumettre à validation » dans la fiche du parapheur.",
    );
    const type = await createInputationType(api, uniq('COU-29b Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou29b-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou29b-b'), menus: [MENUS.parapheur] });
    const mail = await arriveeImputee(api, { prefix: uniq('COU-29b'), dest, impute: b, typeId: type.mailInputationTypeId });
    await loginAs(page, b.username, b.password);
    await page.goto(`${MENUS.parapheur}/${mail.mailId}`);
    await expect(page.getByRole('button', { name: /Soumettre à validation/ })).toBeVisible();
  });
});
