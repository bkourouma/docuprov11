import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  INPUTATION_TYPE,
  MENUS,
  createArrivee,
  createCourrierActor,
  createExternalEntity,
  getMail,
  imputer,
  selectOption,
  sidebarItem,
  toast,
} from './_helpers';

/**
 * Écran « Courriers arrivés » / Contrôle (§06) — `apps/web/app/courriers/controle/page.tsx` (file,
 * `MailWorklist`) et `controle/[mailId]/page.tsx` (`MailDetailPage`, onglets Courrier/Imputations).
 *
 * File PERSONNELLE du destinataire principal (porteur du rôle destinataire), tant que `valider=false`.
 * L'admin n'y figure pas : chaque test crée ses acteurs et se connecte avec `loginAs`.
 * L'écran n'offre AUCUN bouton « Valider » ni « Supprimer le courrier » (§06 : le contrôle est
 * automatique à la première imputation du destinataire) : la validation manuelle et la suppression
 * logique ne sont exposées que par l'API (`POST :id/valider`, `DELETE :id`), testées ici par l'API
 * avec l'effet vérifié à l'écran.
 */

type ListRes = { total: number; rows: Array<{ mailId: number; destinataireRole: { name: string } | null }> };

async function controleIds(client: { get(path: string): Promise<unknown> }): Promise<number[]> {
  const res = (await client.get('/courriers/controle?pageSize=200')) as ListRes;
  return res.rows.map((r) => r.mailId);
}

const mailRow = (page: Page, title: string) => page.getByRole('row').filter({ hasText: title });

/** Ouvre la file Contrôle et attend sa première réponse (renvoie le statut HTTP). */
async function openControle(page: Page): Promise<number> {
  const loaded = page.waitForResponse((r) => /\/api\/courriers\/controle\?/.test(r.url()));
  await page.goto(MENUS.controle);
  return (await loaded).status();
}

test.describe('Courriers arrivés — Contrôle (§06)', () => {
  test('COU-15 — le courrier apparaît dans la file du seul destinataire principal ; détail en onglets', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou15-dest'), menus: [MENUS.controle] });
    const autre = await createCourrierActor(api, { prefix: uniq('cou15-autre'), menus: [MENUS.controle] });
    const entity = await createExternalEntity(api, uniq('COU-15'));
    const mail = await createArrivee(api, {
      title: uniq('COU-15 Objet'),
      destinataireRoleId: dest.roleId,
      externalEntityId: entity.externalEntityId,
      reference: 'REF-15',
      description: 'Description COU-15',
    });

    const destApi = await apiAs(dest.username, dest.password);
    const destList = (await destApi.get('/courriers/controle?pageSize=200')) as ListRes;
    expect(destList.rows.map((r) => r.mailId)).toContain(mail.mailId);
    // Le badge du menu compte exactement ce que la file montre.
    const badges = (await destApi.get('/courriers/badges')) as { controle: number };
    expect(badges.controle).toBe(destList.total);
    const autreApi = await apiAs(autre.username, autre.password);
    expect(await controleIds(autreApi)).not.toContain(mail.mailId);

    await loginAs(page, dest.username, dest.password);
    expect(await openControle(page)).toBe(200);
    await expect(page.getByRole('heading', { level: 2, name: 'Courriers arrivés' })).toBeVisible();
    const row = mailRow(page, mail.title);
    await expect(row).toBeVisible();
    await expect(row).toContainText(dest.roleName);
    await expect(row).toContainText(entity.label);
    if (mail.nReference) await expect(row).toContainText(mail.nReference);

    await row.getByText(mail.title).click();
    await expect(page).toHaveURL(new RegExp(`${MENUS.controle}/${mail.mailId}$`));
    await expect(page.getByRole('heading', { level: 2, name: mail.title })).toBeVisible();
    const fiche = page.locator('.ant-descriptions');
    await expect(fiche).toContainText(dest.roleName);
    await expect(fiche).toContainText(entity.label);
    await expect(fiche).toContainText('Description COU-15');
    await expect(page.getByRole('tab', { name: 'Courrier' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Imputations (0)' })).toBeVisible();
    // Pas d'actions de workflow ni d'archivage au bureau d'ordre (§03.1/§06).
    for (const name of ['Marquer traité', 'Archiver', 'Valider', 'Validation DG', 'Décharger']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }

    // L'autre acteur, qui a pourtant le menu, ne voit rien dans sa file.
    await loginAs(page, autre.username, autre.password);
    expect(await openControle(page)).toBe(200);
    await expect(mailRow(page, mail.title)).toHaveCount(0);
  });

  test('COU-16 — imputation depuis le contrôle : auto-validation, sortie de file, parapheur de l’imputé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou16-dest'), menus: [MENUS.controle] });
    const impute = await createCourrierActor(api, { prefix: uniq('cou16-impute'), menus: [MENUS.parapheur] });
    const mail = await createArrivee(api, { title: uniq('COU-16 Objet'), destinataireRoleId: dest.roleId });

    await loginAs(page, dest.username, dest.password);
    await page.goto(`${MENUS.controle}/${mail.mailId}`);
    await page.getByRole('tab', { name: 'Imputations (0)' }).click();
    await page.getByRole('button', { name: 'Ajouter une imputation' }).click();

    await selectOption(page, page.getByLabel('Rôle', { exact: true }), impute.roleName);
    await selectOption(page, page.getByLabel('Imputer à'), impute.fullName, { multiple: true });
    await selectOption(page, page.getByLabel("Type d'imputation"), 'Pour Suivi');
    await page.getByLabel('Instructions (facultatif)').fill('Traiter sous 48 h');

    const created = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/courriers\/imputations$/.test(r.url()),
    );
    await page.getByRole('button', { name: 'Imputer', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(toast(page, 'Imputation créée.')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Imputations (1)' })).toBeVisible();
    const item = page.locator('.ant-list-item').filter({ hasText: 'Pour Suivi' });
    await expect(item).toContainText(impute.fullName);
    await expect(item).toContainText('Traiter sous 48 h');

    const after = await getMail(api, mail.mailId);
    expect(after.valider).toBe(true);
    expect(after.inputations).toHaveLength(1);
    expect(after.inputations[0]).toMatchObject({
      userId: impute.userGroupId,
      mailInputationTypeId: INPUTATION_TYPE.pourSuivi,
      createdBy: dest.userGroupId,
      instructions: 'Traiter sous 48 h',
    });
    const destApi = await apiAs(dest.username, dest.password);
    expect(await controleIds(destApi)).not.toContain(mail.mailId);
    const imputeApi = await apiAs(impute.username, impute.password);
    const parapheur = (await imputeApi.get('/courriers/parapheur?pageSize=200')) as ListRes;
    expect(parapheur.rows.map((r) => r.mailId)).toContain(mail.mailId);

    // L'auteur peut supprimer SON imputation ; le courrier reste validé (il ne revient pas au contrôle).
    await item.getByRole('button', { name: 'Supprimer' }).click();
    await page.getByRole('button', { name: 'Oui' }).click();
    await expect(toast(page, 'Imputation supprimée.')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Imputations (0)' })).toBeVisible();
    const removed = await getMail(api, mail.mailId);
    expect(removed.inputations).toHaveLength(0);
    expect(removed.valider).toBe(true);

    await page.getByRole('button', { name: 'Retour à la liste' }).click();
    await expect(page).toHaveURL(new RegExp(`${MENUS.controle}$`));
    await expect(mailRow(page, mail.title)).toHaveCount(0);
  });

  test('COU-16b — imputation par un tiers (non destinataire) : pas d’auto-validation', async ({ api, apiAs, uniq }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou16b-dest'), menus: [MENUS.controle] });
    const tiers = await createCourrierActor(api, { prefix: uniq('cou16b-tiers'), menus: [MENUS.controle] });
    const impute = await createCourrierActor(api, { prefix: uniq('cou16b-impute'), menus: [MENUS.parapheur] });
    const mail = await createArrivee(api, { title: uniq('COU-16b Objet'), destinataireRoleId: dest.roleId });

    const tiersApi = await apiAs(tiers.username, tiers.password);
    await imputer(tiersApi, {
      mailId: mail.mailId,
      userGroupId: impute.userGroupId,
      mailInputationTypeId: INPUTATION_TYPE.pourSuivi,
    });
    expect((await getMail(api, mail.mailId)).valider).toBe(false);
    // L'admin non plus ne court-circuite pas le contrôle.
    await imputer(api, {
      mailId: mail.mailId,
      userGroupId: impute.userGroupId,
      mailInputationTypeId: INPUTATION_TYPE.pourSuivi,
    });
    expect((await getMail(api, mail.mailId)).valider).toBe(false);
    expect(await controleIds(await apiAs(dest.username, dest.password))).toContain(mail.mailId);
  });

  test('COU-17 — validation du contrôle (API) : le courrier quitte la file et passe en Validation', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou17-dest'), menus: [MENUS.controle] });
    const mail = await createArrivee(api, { title: uniq('COU-17 Objet'), destinataireRoleId: dest.roleId });

    await loginAs(page, dest.username, dest.password);
    await openControle(page);
    await expect(mailRow(page, mail.title)).toBeVisible();

    const destApi = await apiAs(dest.username, dest.password);
    const validated = (await destApi.post(`/courriers/${mail.mailId}/valider`, {})) as { valider: boolean };
    expect(validated.valider).toBe(true);
    expect(await controleIds(destApi)).not.toContain(mail.mailId);
    const detail = await getMail(api, mail.mailId);
    expect(detail).toMatchObject({ valider: true, status: 0, dateTraited: null, isDeleted: false });
    const validation = (await api.get('/courriers/validation-direction?pageSize=200')) as ListRes;
    expect(validation.rows.map((r) => r.mailId)).toContain(mail.mailId);

    expect(await openControle(page)).toBe(200);
    await expect(mailRow(page, mail.title)).toHaveCount(0);
  });

  test('COU-18 — suppression logique (API) : le courrier disparaît (file, détail 404)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou18-dest'), menus: [MENUS.controle] });
    const mail = await createArrivee(api, { title: uniq('COU-18 Objet'), destinataireRoleId: dest.roleId });

    await loginAs(page, dest.username, dest.password);
    await openControle(page);
    await expect(mailRow(page, mail.title)).toBeVisible();

    const destApi = await apiAs(dest.username, dest.password);
    const deleted = (await destApi.del(`/courriers/${mail.mailId}`)) as { isDeleted: boolean; status: number };
    expect(deleted).toMatchObject({ isDeleted: true, status: 0 }); // statut inchangé (§03.1)
    expect((await api.raw.get(`/courriers/${mail.mailId}`)).status()).toBe(404);
    expect(await controleIds(destApi)).not.toContain(mail.mailId);
    // Deuxième suppression : le courrier n'existe plus pour l'API.
    expect((await destApi.raw.del(`/courriers/${mail.mailId}`)).status()).toBe(404);

    expect(await openControle(page)).toBe(200);
    await expect(mailRow(page, mail.title)).toHaveCount(0);
    await page.goto(`${MENUS.controle}/${mail.mailId}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Courrier introuvable' })).toBeVisible();
  });

  test('COU-19 — sans le menu Contrôle : entrée masquée, file et actions refusées (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou19-dest'), menus: [MENUS.controle] });
    const sans = await createCourrierActor(api, { prefix: uniq('cou19-sans'), menus: [MENUS.enregistrement] });
    const impute = await createCourrierActor(api, {
      prefix: uniq('cou19-impute'),
      menus: [MENUS.controle, MENUS.parapheur],
    });
    const mail = await createArrivee(api, { title: uniq('COU-19 Objet'), destinataireRoleId: dest.roleId });

    const sansApi = await apiAs(sans.username, sans.password);
    const list = await sansApi.raw.get('/courriers/controle');
    expect(list.status()).toBe(403);
    expect(((await list.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
    expect((await sansApi.raw.post(`/courriers/${mail.mailId}/valider`, {})).status()).toBe(403);
    expect((await sansApi.raw.del(`/courriers/${mail.mailId}`)).status()).toBe(403);
    expect(
      (
        await sansApi.raw.post('/courriers/imputations', {
          mailId: mail.mailId,
          userGroupId: impute.userGroupId,
          mailInputationTypeId: INPUTATION_TYPE.pourSuivi,
        })
      ).status(),
    ).toBe(403);
    expect(await getMail(api, mail.mailId)).toMatchObject({ valider: false, isDeleted: false });

    // Suppression d'une imputation réservée à son AUTEUR, même avec le menu Contrôle.
    const destApi = await apiAs(dest.username, dest.password);
    const imp = (await imputer(destApi, {
      mailId: mail.mailId,
      userGroupId: impute.userGroupId,
      mailInputationTypeId: INPUTATION_TYPE.pourSuivi,
    })) as { mailInputationId: number };
    const imputeApi = await apiAs(impute.username, impute.password);
    const notAuthor = await imputeApi.raw.del(`/courriers/imputations/${imp.mailInputationId}`);
    expect(notAuthor.status()).toBe(403);
    expect(((await notAuthor.json()) as { message: string }).message).toContain(
      "Seul l'auteur de l'imputation peut la supprimer",
    );

    await loginAs(page, sans.username, sans.password);
    await page.goto(MENUS.enregistrement);
    await expect(sidebarItem(page, 'Enregistrement')).toBeVisible();
    await expect(sidebarItem(page, 'Courriers arrivés')).toHaveCount(0);
    expect(await openControle(page)).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await expect(page.getByText('Aucun courrier à contrôler')).toBeVisible();
  });

  // Décision de l'utilisateur (phase B) : tout porteur du menu Contrôle peut valider ou supprimer un
  // courrier, même s'il n'en est pas le destinataire principal (état actuel confirmé).
  test('COU-19b — un porteur du menu Contrôle NON destinataire peut valider et supprimer le courrier', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou19b-dest'), menus: [MENUS.controle] });
    const tiers = await createCourrierActor(api, { prefix: uniq('cou19b-tiers'), menus: [MENUS.controle] });
    const aValider = await createArrivee(api, { title: uniq('COU-19b Valider'), destinataireRoleId: dest.roleId });
    const aSupprimer = await createArrivee(api, { title: uniq('COU-19b Supprimer'), destinataireRoleId: dest.roleId });
    const tiersApi = await apiAs(tiers.username, tiers.password);

    expect((await tiersApi.raw.post(`/courriers/${aValider.mailId}/valider`, {})).status()).toBe(200);
    expect(await getMail(api, aValider.mailId)).toMatchObject({ valider: true, isDeleted: false });

    expect((await tiersApi.raw.del(`/courriers/${aSupprimer.mailId}`)).status()).toBe(200);
    expect((await api.raw.get(`/courriers/${aSupprimer.mailId}`)).status()).toBe(404);
  });
});
