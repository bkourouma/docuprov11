import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  MENUS,
  createArrivee,
  createCourrierActor,
  pdfUpload,
  sidebarItem,
  toast,
  uploadScan,
} from './_helpers';

/**
 * Écran « Documents scannés » (§07) — `apps/web/app/courriers/documents-scannes/page.tsx`.
 * File GLOBALE des dépôts non encore enregistrés (`isTraite=false`), plus récents d'abord, 25 par
 * page : chaque test dépose un fichier au nom unique et le retrouve par ce nom.
 */

type ScanRow = {
  mailScannedDocumentId: number;
  fileName: string | null;
  machineName: string | null;
  isTraite: boolean;
  mailId: number | null;
  documentId: number | null;
};

const scanRow = (page: Page, fileName: string) => page.getByRole('row').filter({ hasText: fileName });

async function pendingIds(api: { get(path: string): Promise<unknown> }): Promise<number[]> {
  const res = (await api.get('/courriers/documents-scannes?pageSize=200')) as { rows: ScanRow[] };
  return res.rows.map((r) => r.mailScannedDocumentId);
}

test.describe('Documents scannés (§07)', () => {
  test('COU-10 — dépôt depuis l’écran : toast, ligne en tête de file, scan non traité', async ({
    page,
    api,
    uniq,
  }) => {
    const name = `${uniq('cou10-depot')}.pdf`;
    await page.goto(MENUS.documentsScannes);
    await expect(page.getByRole('button', { name: 'Déposer un document' })).toBeVisible();

    const uploaded = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/courriers\/documents-scannes$/.test(r.url()),
    );
    await page.locator('input[type="file"]').setInputFiles(pdfUpload(name));
    const res = await uploaded;
    expect(res.status()).toBe(201);
    const created = (await res.json()) as ScanRow;

    await expect(toast(page, `« ${name} » déposé.`)).toBeVisible();
    const row = scanRow(page, name);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Consulter' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Enregistrer' })).toBeVisible();

    const list = (await api.get('/courriers/documents-scannes?pageSize=200')) as { rows: ScanRow[] };
    expect(list.rows).toContainEqual(
      expect.objectContaining({
        mailScannedDocumentId: created.mailScannedDocumentId,
        fileName: name,
        isTraite: false,
        mailId: null,
        documentId: null,
        machineName: null,
      }),
    );
  });

  test('COU-11 — aperçu inline du scan (PDF), 404 pour un scan inconnu', async ({ page, api, uniq }) => {
    const scan = await uploadScan(api, { name: `${uniq('cou11-apercu')}.pdf`, machineName: 'POSTE-E2E' });

    const content = await api.raw.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}/content`);
    expect(content.status()).toBe(200);
    expect(content.headers()['content-type']).toContain('application/pdf');
    expect(content.headers()['content-disposition']).toMatch(/^inline;/);
    expect((await content.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const detail = (await api.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}`)) as ScanRow;
    expect(detail).toMatchObject({ fileName: scan.fileName, machineName: 'POSTE-E2E', isTraite: false });

    await page.goto(MENUS.documentsScannes);
    const row = scanRow(page, scan.fileName);
    await expect(row).toBeVisible();
    const fetched = page.waitForResponse((r) =>
      r.url().endsWith(`/api/courriers/documents-scannes/${scan.mailScannedDocumentId}/content`),
    );
    await row.getByRole('button', { name: 'Consulter' }).click();
    expect((await fetched).status()).toBe(200);

    const dialog = page.getByRole('dialog', { name: scan.fileName });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Aperçu indisponible')).toHaveCount(0);
    await expect(toast(page, 'Aperçu indisponible (fichier introuvable).')).toHaveCount(0);
    // Échap est écouté sur la fenêtre (rc-dialog) : il faut que le focus y soit. rc-dialog ne l'y
    // place qu'à la fin de l'animation d'ouverture ; avant, le focus est encore sur « Consulter ».
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const unknown = await api.raw.get('/courriers/documents-scannes/999999999/content');
    expect(unknown.status()).toBe(404);
    expect((await api.raw.get('/courriers/documents-scannes/999999999')).status()).toBe(404);
  });

  test('COU-12 — « Enregistrer » ouvre la saisie rattachée ; une fois enregistré, le scan quitte la file', async ({
    page,
    api,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou12-dest'), menus: [MENUS.controle] });
    const scan = await uploadScan(api, { name: `${uniq('cou12-scan')}.pdf` });

    await page.goto(MENUS.documentsScannes);
    await scanRow(page, scan.fileName).getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page).toHaveURL(
      new RegExp(`${MENUS.enregistrement}\\?scanId=${scan.mailScannedDocumentId}$`),
    );
    const banner = page.getByRole('alert').filter({ hasText: 'Document scanné rattaché' });
    await expect(banner).toContainText(scan.fileName);

    // Enregistrement (par l'API ; le parcours écran est couvert par COU-07) → scan traité.
    const mail = await createArrivee(api, {
      title: uniq('COU-12 Objet'),
      destinataireRoleId: dest.roleId,
      scannedDocumentId: scan.mailScannedDocumentId,
    });
    expect(await pendingIds(api)).not.toContain(scan.mailScannedDocumentId);
    const detail = (await api.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}`)) as ScanRow;
    expect(detail).toMatchObject({ isTraite: true, mailId: mail.mailId });

    const reloaded = page.waitForResponse((r) => /\/api\/courriers\/documents-scannes\?/.test(r.url()));
    await page.goto(MENUS.documentsScannes);
    expect((await reloaded).status()).toBe(200);
    await expect(page.getByText('Chargement…')).toHaveCount(0);
    await expect(scanRow(page, scan.fileName)).toHaveCount(0);
  });

  test('COU-13 — dépôts refusés : extension non gérée, fichier vide', async ({ page, api, uniq }) => {
    const exe = await api.raw.upload('/courriers/documents-scannes', {
      field: 'file',
      file: { name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
    });
    expect(exe.status()).toBe(400);
    expect(((await exe.json()) as { message: string }).message).toContain('Extension non acceptée');

    const bmp = await api.raw.upload('/courriers/documents-scannes', {
      field: 'file',
      file: { name: 'image.bmp', mimeType: 'image/bmp', buffer: Buffer.from('BM') },
    });
    expect(bmp.status()).toBe(400);

    const empty = await api.raw.upload('/courriers/documents-scannes', {
      field: 'file',
      file: { name: 'vide.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
    });
    expect(empty.status()).toBe(400);
    expect(((await empty.json()) as { message: string }).message).toContain('Aucun fichier reçu');

    // À l'écran : l'attribut `accept` ne protège pas d'un fichier forcé, l'API répond et le toast le dit.
    const txt = `${uniq('cou13-note')}.txt`;
    await page.goto(MENUS.documentsScannes);
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: txt, mimeType: 'text/plain', buffer: Buffer.from('texte') });
    await expect(toast(page, /Extension non acceptée/)).toBeVisible();
    await expect(scanRow(page, txt)).toHaveCount(0);
  });

  test('COU-14 — sans le menu : entrée masquée, liste/aperçu/dépôt refusés (403)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const agent = await createCourrierActor(api, { prefix: uniq('cou14-agent'), menus: [MENUS.controle] });
    const enreg = await createCourrierActor(api, { prefix: uniq('cou14-enreg'), menus: [MENUS.enregistrement] });
    const scan = await uploadScan(api, { name: `${uniq('cou14-scan')}.pdf` });

    const agentApi = await apiAs(agent.username, agent.password);
    const forbidden = await agentApi.raw.get('/courriers/documents-scannes');
    expect(forbidden.status()).toBe(403);
    expect(((await forbidden.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
    expect((await agentApi.raw.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}`)).status()).toBe(403);
    expect(
      (await agentApi.raw.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}/content`)).status(),
    ).toBe(403);
    expect(
      (await agentApi.raw.upload('/courriers/documents-scannes', { field: 'file', file: pdfUpload('cou14.pdf') })).status(),
    ).toBe(403);

    // L'Enregistrement dépose et lit UN scan (rattachement §05), mais ne consulte pas la file.
    const enregApi = await apiAs(enreg.username, enreg.password);
    expect((await enregApi.raw.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}`)).status()).toBe(200);
    expect((await enregApi.raw.get('/courriers/documents-scannes')).status()).toBe(403);
    expect(
      (await enregApi.raw.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}/content`)).status(),
    ).toBe(403);
    expect(
      (await enregApi.raw.upload('/courriers/documents-scannes', {
        field: 'file',
        file: pdfUpload(`${uniq('cou14-enreg')}.pdf`),
      })).status(),
    ).toBe(201);

    await loginAs(page, agent.username, agent.password);
    await page.goto(MENUS.controle);
    await expect(sidebarItem(page, 'Courriers arrivés')).toBeVisible();
    await expect(sidebarItem(page, 'Documents scannés')).toHaveCount(0);

    const list = page.waitForResponse((r) => /\/api\/courriers\/documents-scannes(\?.*)?$/.test(r.url()));
    await page.goto(MENUS.documentsScannes);
    expect((await list).status()).toBe(403);
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    await expect(scanRow(page, scan.fileName)).toHaveCount(0);
  });
});
