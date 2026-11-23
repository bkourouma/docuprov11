import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import type { ApiClient } from '../../fixtures';
import {
  FORBIDDEN_MESSAGE,
  MENUS,
  createArrivee,
  createCourrierActor,
  createExternalEntity,
  fieldError,
  getMail,
  openDropdown,
  sidebarItem,
  toast,
  uploadScan,
  type CourrierActor,
} from './_helpers';
import {
  MAIL_STATUS,
  countRequests,
  dechargesEnAttente,
  departAvecPdf,
  integrerDecharge,
  pdf,
  pickOption,
  popconfirm,
  textFile,
  waitForApi,
} from './_helpers/flux-t3';

/**
 * Écran « Intégration décharge » (§13) — `apps/web/app/courriers/integration-decharge/page.tsx`.
 *
 * Lu dans le code (phase A) :
 *  - « Courrier » : Select nommé (`#mailId`) alimenté par `GET decharges-en-attente` (départs sans
 *    pièce `decharge = true`, 200 au plus) ; libellé composé « n° X — objet — correspondant — date ».
 *  - « Décharge signée (PDF) » : champ MIROIR nommé `fileName` (porte la règle obligatoire) et
 *    zone de dépôt ; le fichier retenu s'affiche sous la zone avec un bouton « Retirer ».
 *  - Le Popconfirm « Intégrer cette décharge ? » ne s'ouvre qu'une fois le formulaire VALIDE ;
 *    « Intégrer » dépose le PDF (§07) puis `POST :id/integration-decharge` ; « Annuler » n'envoie rien.
 */

interface Echange {
  bo: CourrierActor;
  entity: { externalEntityId: number; label: string };
  arrivee: { mailId: number; title: string };
  depart: { mailId: number; title: string };
}

/** Arrivée + départ lié (avec PDF) rédigé par un agent « bureau d'ordre » (Départ + Décharge). */
async function echange(
  api: ApiClient,
  apiAs: (username: string, password: string) => Promise<ApiClient>,
  prefix: string,
): Promise<Echange> {
  const bo = await createCourrierActor(api, {
    prefix: `${prefix}-bo`,
    menus: [MENUS.depart, MENUS.integrationDecharge],
  });
  const entity = await createExternalEntity(api, prefix);
  const arrivee = await createArrivee(api, {
    title: `${prefix} Demande`,
    destinataireRoleId: bo.roleId,
    externalEntityId: entity.externalEntityId,
  });
  const boApi = await apiAs(bo.username, bo.password);
  const depart = await departAvecPdf(boApi, {
    title: `${prefix} Réponse`,
    externalEntityId: entity.externalEntityId,
    parentMailId: arrivee.mailId,
  });
  return { bo, entity, arrivee, depart };
}

const integrateButton = (page: Page) => page.getByRole('button', { name: 'Intégrer la décharge' });
const courrierField = (page: Page) => page.getByLabel('Courrier', { exact: true });

async function openIntegration(page: Page): Promise<number> {
  const list = waitForApi(page, '/courriers/decharges-en-attente');
  await page.goto(MENUS.integrationDecharge);
  await expect(page.getByRole('heading', { level: 2, name: 'Intégration décharge' })).toBeVisible();
  return (await list).status();
}

test.describe('Intégration de la décharge signée (§13)', () => {
  test('COU-44 — nominal : décharge rattachée au départ ET au parent, départ déchargé et archivé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const { bo, entity, arrivee, depart } = await echange(api, apiAs, uniq('COU-44'));
    expect(await dechargesEnAttente(api)).toContain(depart.mailId);

    await loginAs(page, bo.username, bo.password);
    expect(await openIntegration(page)).toBe(200);
    await expect(sidebarItem(page, 'Intégration décharge')).toBeVisible();

    await pickOption(page, courrierField(page), depart.title);
    await expect(page.locator('.ant-select:has(#mailId) .ant-select-selection-item')).toContainText(entity.label);
    const fileName = `${uniq('cou44-decharge')}.pdf`;
    await page.locator('input[type="file"]').setInputFiles(pdf(fileName));
    await expect(page.getByText(fileName, { exact: true })).toBeVisible();

    await integrateButton(page).click();
    const confirm = popconfirm(page);
    await expect(confirm).toContainText('Intégrer cette décharge ?');
    const scanUpload = waitForApi(page, '/courriers/documents-scannes', 'POST');
    const integrated = waitForApi(page, `/courriers/${depart.mailId}/integration-decharge`, 'POST');
    const reloaded = waitForApi(page, '/courriers/decharges-en-attente');
    await confirm.getByRole('button', { name: 'Intégrer', exact: true }).click();
    const scanRes = await scanUpload;
    expect(scanRes.status()).toBe(201);
    expect((await integrated).status()).toBe(200);
    await expect(toast(page, 'Décharge intégrée : courrier déchargé et archivé.')).toBeVisible();
    await reloaded;

    // Le départ a quitté la liste : formulaire vidé, plus aucune option à son titre.
    await expect(page.getByText(fileName, { exact: true })).toHaveCount(0);
    await courrierField(page).click();
    await courrierField(page).fill(depart.title);
    await expect(openDropdown(page)).toContainText('Aucun courrier de départ en attente de décharge');
    expect(await dechargesEnAttente(api)).not.toContain(depart.mailId);

    const d = await getMail(api, depart.mailId);
    expect(d.status).toBe(MAIL_STATUS.decharge);
    expect(d.dateDecharge).not.toBeNull();
    expect(d.dateTraited).not.toBeNull();
    expect(d.documents).toHaveLength(2); // la réponse + la décharge signée
    const decharge = (d.documents as Array<{ documentId: number; decharge: boolean }>).filter((x) => x.decharge);
    expect(decharge).toHaveLength(1);

    // §13 : la décharge est aussi rattachée au courrier auquel le départ répondait.
    const parent = await getMail(api, arrivee.mailId);
    expect(parent.documents).toContainEqual(
      expect.objectContaining({ documentId: decharge[0]!.documentId, decharge: true }),
    );

    // Le scan déposé a quitté la file §07.
    const scanId = ((await scanRes.json()) as { mailScannedDocumentId: number }).mailScannedDocumentId;
    expect(await api.get(`/courriers/documents-scannes/${scanId}`)).toMatchObject({
      isTraite: true,
      mailId: depart.mailId,
    });
  });

  test('COU-45 — erreurs de saisie et annulation : confirmation seulement si valide, rien envoyé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const { bo, depart } = await echange(api, apiAs, uniq('COU-45'));

    await loginAs(page, bo.username, bo.password);
    await openIntegration(page);
    const integrations = countRequests(page, /^\/courriers\/\d+\/integration-decharge$/, 'POST');
    const uploads = countRequests(page, '/courriers/documents-scannes', 'POST');

    // Formulaire vide : deux erreurs, pas de confirmation.
    await integrateButton(page).click();
    await expect(fieldError(page, 'Le courrier est obligatoire')).toBeVisible();
    await expect(fieldError(page, 'Le scan de la décharge signée est obligatoire')).toBeVisible();
    await expect(popconfirm(page)).toHaveCount(0);

    // Courrier choisi, pièce manquante : seule l'erreur de la pièce subsiste.
    await pickOption(page, courrierField(page), depart.title);
    await integrateButton(page).click();
    await expect(fieldError(page, 'Le courrier est obligatoire')).toHaveCount(0);
    await expect(fieldError(page, 'Le scan de la décharge signée est obligatoire')).toBeVisible();
    await expect(popconfirm(page)).toHaveCount(0);

    // Fichier non PDF refusé.
    await page.locator('input[type="file"]').setInputFiles(textFile('decharge.txt'));
    await expect(toast(page, 'Seuls les fichiers PDF sont acceptés.')).toBeVisible();
    await expect(page.getByText('decharge.txt', { exact: true })).toHaveCount(0);

    // PDF retenu puis retiré : l'exigence revient.
    await page.locator('input[type="file"]').setInputFiles(pdf('decharge-45.pdf'));
    await expect(page.getByText('decharge-45.pdf', { exact: true })).toBeVisible();
    await expect(fieldError(page, 'Le scan de la décharge signée est obligatoire')).toHaveCount(0);
    await page.getByRole('button', { name: 'Retirer' }).click();
    await expect(page.getByText('decharge-45.pdf', { exact: true })).toHaveCount(0);
    await integrateButton(page).click();
    await expect(fieldError(page, 'Le scan de la décharge signée est obligatoire')).toBeVisible();

    // Formulaire valide : confirmation, puis « Annuler » n'envoie rien.
    await page.locator('input[type="file"]').setInputFiles(pdf('decharge-45.pdf'));
    await integrateButton(page).click();
    await expect(popconfirm(page)).toContainText('Intégrer cette décharge ?');
    await popconfirm(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(popconfirm(page)).toHaveCount(0);
    expect(integrations()).toBe(0);
    expect(uploads()).toBe(0);
    expect(await dechargesEnAttente(api)).toContain(depart.mailId);

    // API : pièce absente (400), scan inconnu (404), courrier inconnu (404).
    const boApi = await apiAs(bo.username, bo.password);
    expect((await boApi.raw.post(`/courriers/${depart.mailId}/integration-decharge`, {})).status()).toBe(400);
    expect(
      (
        await boApi.raw.post(`/courriers/${depart.mailId}/integration-decharge`, {
          scannedDocumentId: 2_147_483_000,
        })
      ).status(),
    ).toBe(404);
    const scan = await uploadScan(boApi, { name: 'decharge-orpheline.pdf' });
    expect(
      (
        await boApi.raw.post('/courriers/2147483000/integration-decharge', {
          scannedDocumentId: scan.mailScannedDocumentId,
        })
      ).status(),
    ).toBe(404);
    const after = await getMail(api, depart.mailId);
    expect(after).toMatchObject({ status: MAIL_STATUS.redige, dateTraited: null });
    expect(after.documents).toHaveLength(1);
  });

  test('COU-46 — intégration sur un courrier ARRIVÉE refusée (4xx), courrier inchangé', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // Anomalie suspectée (mails.service.ts integrateDecharge) : seul `assertMailActive` est vérifié ;
    // une Arrivée passe en « Déchargé » et est archivée. §13 ne vise que les courriers de départ.
    const bo = await createCourrierActor(api, { prefix: uniq('cou46-bo'), menus: [MENUS.integrationDecharge] });
    const arrivee = await createArrivee(api, { title: uniq('COU-46 Arrivée'), destinataireRoleId: bo.roleId });
    const boApi = await apiAs(bo.username, bo.password);
    const scan = await uploadScan(boApi, { name: 'decharge-46.pdf' });

    const res = await boApi.raw.post(`/courriers/${arrivee.mailId}/integration-decharge`, {
      scannedDocumentId: scan.mailScannedDocumentId,
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    const mail = await getMail(api, arrivee.mailId);
    expect(mail).toMatchObject({ status: MAIL_STATUS.redaction, dateTraited: null });
    expect(mail.documents).toHaveLength(0);
  });

  test('COU-46 — seconde intégration sur un départ déjà déchargé', async ({ api, apiAs, uniq }) => {
    test.fixme(
      true,
      'Question métier : integrateDecharge ne refuse pas une seconde décharge (2 pièces decharge=true, dates écrasées). Attendu supposé : 409 ou 400, première décharge conservée.',
    );
    const { bo, depart } = await echange(api, apiAs, uniq('COU-46b'));
    await integrerDecharge(api, depart.mailId);
    const first = await getMail(api, depart.mailId);
    const boApi = await apiAs(bo.username, bo.password);
    const scan = await uploadScan(boApi, { name: 'decharge-bis.pdf' });
    const res = await boApi.raw.post(`/courriers/${depart.mailId}/integration-decharge`, {
      scannedDocumentId: scan.mailScannedDocumentId,
    });
    expect([400, 409]).toContain(res.status());
    const second = await getMail(api, depart.mailId);
    expect(second.documents).toHaveLength(first.documents.length);
    expect(second.dateDecharge).toBe(first.dateDecharge);
  });

  test('COU-47 — sans le menu Intégration décharge : entrée masquée, liste et intégration refusées (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const { depart } = await echange(api, apiAs, uniq('COU-47'));
    const sans = await createCourrierActor(api, { prefix: uniq('cou47-sans'), menus: [MENUS.recherche] });
    const sansApi = await apiAs(sans.username, sans.password);

    const list = await sansApi.raw.get('/courriers/decharges-en-attente');
    expect(list.status()).toBe(403);
    expect(((await list.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
    expect(
      (await sansApi.raw.post(`/courriers/${depart.mailId}/integration-decharge`, { documentId: 1 })).status(),
    ).toBe(403);
    expect(await dechargesEnAttente(api)).toContain(depart.mailId);

    await loginAs(page, sans.username, sans.password);
    await page.goto(MENUS.recherche);
    await expect(sidebarItem(page, 'Recherche courrier')).toBeVisible();
    await expect(sidebarItem(page, 'Intégration décharge')).toHaveCount(0);

    expect(await openIntegration(page)).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await courrierField(page).click();
    await expect(openDropdown(page)).toContainText('Aucun courrier de départ en attente de décharge');
  });
});
