import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import { MENUS, createArrivee, createCourrierActor, imputer } from './_helpers';
import {
  QUEUE_API,
  createInputationType,
  gotoWorklist,
  notificationsOf,
  waitApi,
} from './_helpers/workflow-t2';

/**
 * Notifications in-app (§03.5) des actions de workflow courrier, et leur cloche
 * (`components/NotificationsBell.tsx`, polling 60 s du compteur, liste des 10 dernières).
 *
 * Canal e-mail : `EmailService` est inactif sans `SMTP_HOST` (pile E2E) — l'envoi est ignoré et,
 * surtout, ne doit pas faire échouer l'action métier : on vérifie donc le 201 de l'action ET la
 * notification in-app, qui fait foi.
 */

/** Bouton cloche et son compteur (`Badge` AntD autour du bouton). */
function bell(page: Page) {
  const button = page.getByRole('button', { name: 'Notifications', exact: true });
  const count = page.locator('.ant-badge').filter({ has: button }).locator('.ant-badge-count');
  return { button, count };
}

test.describe('Notifications in-app (§03.5)', () => {
  test('COU-39 — imputation : notification non lue, cloche, « Tout marquer lu », isolement par destinataire', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const type = await createInputationType(api, uniq('COU-39 Pour avis'));
    const dest = await createCourrierActor(api, { prefix: uniq('cou39-dest'), menus: [MENUS.controle] });
    const b = await createCourrierActor(api, { prefix: uniq('cou39-b'), menus: [MENUS.parapheur] });
    const autre = await createCourrierActor(api, { prefix: uniq('cou39-autre'), menus: [MENUS.parapheur] });
    const mail = await createArrivee(api, { title: uniq('COU-39 Objet'), destinataireRoleId: dest.roleId });

    const bApi = await apiAs(b.username, b.password);
    expect(await bApi.get('/notifications/unread-count')).toEqual({ count: 0 });

    // L'action aboutit (201) même sans messagerie configurée.
    const destApi = await apiAs(dest.username, dest.password);
    const created = await destApi.raw.post('/courriers/imputations', {
      mailId: mail.mailId,
      userGroupId: b.userGroupId,
      mailInputationTypeId: type.mailInputationTypeId,
    });
    expect(created.status()).toBe(201);

    const inbox = await notificationsOf(bApi);
    expect(inbox.unread).toBe(1);
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]).toMatchObject({
      message: `Courrier imputé : ${mail.title}`,
      targetType: 'mail',
      targetId: mail.mailId,
      isRead: false,
    });
    expect(await bApi.get('/notifications/unread-count')).toEqual({ count: 1 });
    const notifId = inbox.rows[0]!.notificationId;

    // Un autre acteur ne peut ni voir ni acquitter la notification de B.
    const autreApi = await apiAs(autre.username, autre.password);
    expect((await notificationsOf(autreApi)).rows.map((n) => n.notificationId)).not.toContain(notifId);
    expect(await autreApi.patch(`/notifications/${notifId}/read`, {})).toEqual({ updated: 0 });
    expect((await notificationsOf(bApi, { unreadOnly: true })).rows.map((n) => n.notificationId)).toEqual([notifId]);

    // Cloche : compteur, liste, « Tout marquer lu ».
    await loginAs(page, b.username, b.password);
    const counted = waitApi(page, 'GET', /\/api\/notifications\/unread-count$/);
    await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur);
    await counted;
    const { button, count } = bell(page);
    await expect(count).toHaveText('1');
    const listed = waitApi(page, 'GET', /\/api\/notifications$/);
    await button.click();
    await listed;
    const panel = page.locator('.da-notif-dropdown');
    await expect(panel.getByText('Notifications', { exact: true })).toBeVisible();
    await expect(panel.getByText(`Courrier imputé : ${mail.title}`)).toBeVisible();
    const readAll = panel.getByRole('button', { name: 'Tout marquer lu' });
    await expect(readAll).toBeEnabled();
    const marked = waitApi(page, 'PATCH', /\/api\/notifications\/read-all$/);
    await readAll.click();
    expect((await marked).status()).toBe(200);
    await expect(readAll).toBeDisabled();
    await expect(count).toHaveCount(0);

    expect(await bApi.get('/notifications/unread-count')).toEqual({ count: 0 });
    const read = await notificationsOf(bApi);
    expect(read.unread).toBe(0);
    expect(read.rows.find((n) => n.notificationId === notifId)?.isRead).toBe(true);
    expect((await notificationsOf(bApi, { unreadOnly: true })).rows).toHaveLength(0);

    // Acquittement unitaire : une seule fois, par son destinataire.
    await imputer(destApi, { mailId: mail.mailId, userGroupId: b.userGroupId, mailInputationTypeId: type.mailInputationTypeId });
    const second = (await notificationsOf(bApi, { unreadOnly: true })).rows;
    expect(second).toHaveLength(1);
    expect(await bApi.patch(`/notifications/${second[0]!.notificationId}/read`, {})).toEqual({ updated: 1 });
    expect(await bApi.patch(`/notifications/${second[0]!.notificationId}/read`, {})).toEqual({ updated: 0 });
    expect(await bApi.get('/notifications/unread-count')).toEqual({ count: 0 });
  });

  test('COU-39 — boîte vide : « Aucune notification », action « Tout marquer lu » inactive', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    const b = await createCourrierActor(api, { prefix: uniq('cou39b'), menus: [MENUS.parapheur] });
    await loginAs(page, b.username, b.password);
    await gotoWorklist(page, MENUS.parapheur, QUEUE_API.parapheur);
    const { button, count } = bell(page);
    await expect(count).toHaveCount(0);
    const listed = waitApi(page, 'GET', /\/api\/notifications$/);
    await button.click();
    await listed;
    const panel = page.locator('.da-notif-dropdown');
    await expect(panel.getByText('Aucune notification')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Tout marquer lu' })).toBeDisabled();
  });
});
