import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/test';
import {
  FORBIDDEN_MESSAGE,
  INPUTATION_TYPE,
  MENUS,
  createCourrierActor,
  createExternalEntity,
  fieldError,
  fillDate,
  getMail,
  openDropdown,
  pdfUpload,
  selectOption,
  sidebarItem,
  toast,
  todayIso,
  uploadScan,
} from './_helpers';

/**
 * Écran « Enregistrement d'un courrier » (§05) — `apps/web/app/courriers/enregistrement/page.tsx`.
 *
 * Sélecteurs : les Form.Item portent `name` (Form sans `name`) → l'id du contrôle = nom du champ
 * (`#title`, `#externalEntityId`…). Le champ Expéditeur est un Form.Item `noStyle` imbriqué : son
 * libellé n'est relié à aucun contrôle, d'où `#externalEntityId` au lieu de `getByLabel`.
 * Aucun service IA en E2E : la case « Saisie automatique par IA » n'est pas proposée.
 */

const COURRIER_DATE_FR = '05/11/2026';
const COURRIER_DATE_ISO = '2026-11-05';

const isArriveePost = (url: string, method: string) =>
  method === 'POST' && /\/api\/courriers\/arrivee$/.test(url);

function todayFr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

const nRefField = (page: Page) => page.getByLabel("N° d'enregistrement");

/** Ouvre l'écran et attend la fin du chargement (n° proposé posé après tous les lookups). */
async function openEnregistrement(page: Page, query = ''): Promise<string> {
  await page.goto(`${MENUS.enregistrement}${query}`);
  await expect(nRefField(page)).toHaveValue(/^\d{5,}$/);
  return nRefField(page).inputValue();
}

/** Remplit les champs obligatoires (hors n° et date d'enregistrement, pré-remplis). */
async function fillRequired(
  page: Page,
  v: { title: string; reference: string; entityLabel: string; roleName: string; pdfName?: string },
): Promise<void> {
  await page.getByLabel('Objet du courrier').fill(v.title);
  await fillDate(page.getByLabel('Date du courrier'), COURRIER_DATE_FR);
  await page.getByLabel('Référence expéditeur').fill(v.reference);
  await selectOption(page, page.locator('#externalEntityId'), v.entityLabel);
  await selectOption(page, page.getByLabel('Destinataire', { exact: true }), v.roleName);
  if (v.pdfName) {
    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(pdfUpload(v.pdfName));
  }
}

/** Soumet le formulaire et renvoie le corps de `POST /courriers/arrivee` (201 attendu). */
async function submitAndGetMail(page: Page): Promise<{ mailId: number; nReference: string }> {
  const created = page.waitForResponse((r) => isArriveePost(r.url(), r.request().method()));
  await page.getByRole('button', { name: 'Enregistrer le courrier' }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  await expect(toast(page, 'Courrier enregistré.')).toBeVisible();
  return (await res.json()) as { mailId: number; nReference: string };
}

test.describe('Enregistrement d’un courrier arrivée (§05)', () => {
  test('COU-01 — nominal : n° proposé, champs obligatoires, destinataire = rôle, PDF joint', async ({
    page,
    api,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou01-dest'), menus: [MENUS.controle] });
    const entity = await createExternalEntity(api, uniq('COU-01'));
    const title = uniq('COU-01 Objet');

    const proposed = await openEnregistrement(page);
    await expect(page.getByLabel("Date d'enregistrement")).toHaveValue(todayFr());

    await fillRequired(page, {
      title,
      reference: 'REF-EXP-01',
      entityLabel: entity.label,
      roleName: dest.roleName,
      pdfName: `${uniq('cou01')}.pdf`,
    });
    await page.getByLabel('Résumé / description (facultatif)').fill('Résumé du courrier E2E');

    const body = await submitAndGetMail(page);

    // On reste sur la saisie, formulaire vidé, n° suivant proposé (strictement supérieur).
    await expect(page).toHaveURL(new RegExp(`${MENUS.enregistrement}$`));
    await expect(page.getByLabel('Objet du courrier')).toHaveValue('');
    await expect
      .poll(async () => Number(await nRefField(page).inputValue()))
      .toBeGreaterThan(Number(proposed));

    const mail = await getMail(api, body.mailId);
    expect(mail).toMatchObject({
      title,
      nReference: proposed, // le n° affiché est celui enregistré
      reference: 'REF-EXP-01',
      description: 'Résumé du courrier E2E',
      mailType: 0, // Arrivée
      status: 0, // Rédaction
      valider: false,
      isDeleted: false,
      destinataireRoleId: dest.roleId,
      destinataireExpediteur: null,
      externalEntityId: entity.externalEntityId,
    });
    expect(mail.destinataireRole).toMatchObject({ roleId: dest.roleId, name: dest.roleName });
    expect(String(mail.date)).toMatch(new RegExp(`^${COURRIER_DATE_ISO}`));
    expect(String(mail.dateEnregistrementCourrier)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Le PDF entre par la file §07 puis est promu en document GED rattaché.
    expect(mail.documents).toHaveLength(1);
    expect(mail.documents[0]).toMatchObject({ decharge: false });
    expect(mail.inputations).toHaveLength(0);
  });

  test('COU-02 — champs obligatoires manquants : erreurs affichées, aucun envoi', async ({ page }) => {
    let posted = false;
    page.on('request', (r) => {
      if (isArriveePost(r.url(), r.method())) posted = true;
    });
    await openEnregistrement(page);

    await page.getByRole('button', { name: 'Enregistrer le courrier' }).click();
    for (const msg of [
      "L'objet est obligatoire",
      'La date est obligatoire',
      'La référence expéditeur est obligatoire',
      "L'expéditeur est obligatoire",
      'Le destinataire est obligatoire',
      'Le courrier numérisé est obligatoire',
    ]) {
      await expect(fieldError(page, msg)).toBeVisible();
    }

    // Titre et date saisis : leurs erreurs disparaissent, celle du destinataire reste.
    await page.getByLabel('Objet du courrier').fill('Objet partiel');
    await fillDate(page.getByLabel('Date du courrier'), COURRIER_DATE_FR);
    await page.getByRole('button', { name: 'Enregistrer le courrier' }).click();
    await expect(fieldError(page, "L'objet est obligatoire")).toHaveCount(0);
    await expect(fieldError(page, 'La date est obligatoire')).toHaveCount(0);
    await expect(fieldError(page, 'Le destinataire est obligatoire')).toBeVisible();

    // N° d'enregistrement vidé à la main : obligatoire lui aussi.
    await nRefField(page).fill('');
    await expect(fieldError(page, "Le n° d'enregistrement est obligatoire")).toBeVisible();

    expect(posted).toBe(false);
  });

  test('COU-03 — API : titre, date et destinataire validés (400)', async ({ api, uniq }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou03-dest'), menus: [MENUS.controle] });
    const date = todayIso();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['titre absent', { date, destinataireRoleId: dest.roleId }],
      ['titre blanc', { title: '   ', date, destinataireRoleId: dest.roleId }],
      ['date absente', { title: 'COU-03', destinataireRoleId: dest.roleId }],
      ['date invalide', { title: 'COU-03', date: 'pas-une-date', destinataireRoleId: dest.roleId }],
      ['destinataire absent', { title: 'COU-03', date }],
      ['destinataire non entier', { title: 'COU-03', date, destinataireRoleId: 'abc' }],
    ];
    for (const [label, body] of cases) {
      const res = await api.raw.post('/courriers/arrivee', body);
      expect(res.status(), label).toBe(400);
    }

    // Rôle inconnu : 400 explicite (et non 500 sur la clé étrangère).
    const unknown = await api.raw.post('/courriers/arrivee', {
      title: 'COU-03',
      date,
      destinataireRoleId: 999_999_999,
    });
    expect(unknown.status()).toBe(400);
    expect(((await unknown.json()) as { message: string }).message).toContain(
      'Rôle destinataire introuvable ou inactif',
    );

    // Rôle désactivé : même refus.
    await api.patch(`/roles/${dest.roleId}`, { isActive: false });
    const inactive = await api.raw.post('/courriers/arrivee', {
      title: 'COU-03',
      date,
      destinataireRoleId: dest.roleId,
    });
    expect(inactive.status()).toBe(400);
  });

  test('COU-04 — destinataire = rôle non système ; rôle sans porteur signalé', async ({ page, api, uniq }) => {
    const porteur = await createCourrierActor(api, { prefix: uniq('cou04-porteur'), menus: [MENUS.controle] });
    const vide = (await api.post('/roles', { name: uniq('COU-04 role vide'), menuKeys: [] })) as {
      roleId: number;
      name: string;
    };
    const allRoles = (await api.get('/roles')) as Array<{ roleId: number; name: string; isSystem: boolean }>;
    const systemRoles = allRoles.filter((r) => r.isSystem);
    expect(systemRoles.length).toBeGreaterThan(0);

    const dest = (await api.get('/courriers/destinataire-roles')) as Array<{
      roleId: number;
      label: string;
      userCount: number;
    }>;
    expect(dest).toContainEqual({ roleId: porteur.roleId, label: porteur.roleName, userCount: 1 });
    expect(dest).toContainEqual({ roleId: vide.roleId, label: vide.name, userCount: 0 });
    for (const s of systemRoles) expect(dest.map((r) => r.roleId)).not.toContain(s.roleId);

    await openEnregistrement(page);
    const combo = page.getByLabel('Destinataire', { exact: true });

    await combo.click();
    await combo.fill(porteur.roleName);
    await expect(openDropdown(page).getByTitle(porteur.roleName, { exact: true })).toBeVisible();

    await combo.fill(vide.name);
    await expect(
      openDropdown(page).getByTitle(`${vide.name} (aucun utilisateur)`, { exact: true }),
    ).toBeVisible();

    await combo.fill(systemRoles[0]!.name);
    await expect(openDropdown(page).getByTitle(systemRoles[0]!.name, { exact: true })).toHaveCount(0);
  });

  test('COU-04 — API : le rôle système est refusé comme destinataire', async ({ api }) => {
    test.fixme(
      true,
      "Question métier : §05 exclut le rôle système des destinataires, mais seul le lookup le filtre ; POST /courriers/arrivee l'accepte (deriveOrganigramme ne teste que isActive). Attendu supposé : 400.",
    );
    const allRoles = (await api.get('/roles')) as Array<{ roleId: number; isSystem: boolean }>;
    const system = allRoles.find((r) => r.isSystem);
    expect(system).toBeTruthy();
    const res = await api.raw.post('/courriers/arrivee', {
      title: 'COU-04 rôle système',
      date: todayIso(),
      destinataireRoleId: system!.roleId,
    });
    expect(res.status()).toBe(400);
  });

  test('COU-05 — correspondant créé à la volée depuis le « + » et sélectionné', async ({ page, api, uniq }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou05-dest'), menus: [MENUS.controle] });
    const label = uniq('COU-05 Ministère');
    const title = uniq('COU-05 Objet');

    await openEnregistrement(page);
    await page.getByRole('button', { name: 'Créer un expéditeur' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvel expéditeur (entité externe)' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Créer' })).toBeDisabled();

    await dialog.getByLabel('Nom', { exact: true }).fill(label);
    await dialog.getByLabel('E-mail').fill('contact@e2e.test');
    const createdEntity = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/api\/courriers\/referentials\/external-entities$/.test(r.url()),
    );
    await dialog.getByRole('button', { name: 'Créer' }).click();
    const entityRes = await createdEntity;
    expect(entityRes.status()).toBe(201);
    const entity = (await entityRes.json()) as { externalEntityId: number; label: string };
    await expect(toast(page, 'Correspondant créé')).toBeVisible();
    await expect(dialog).toBeHidden();

    // Sélectionné d'office dans le champ Expéditeur.
    await expect(page.locator('.ant-select:has(#externalEntityId) .ant-select-selection-item')).toHaveText(
      label,
    );

    await page.getByLabel('Objet du courrier').fill(title);
    await fillDate(page.getByLabel('Date du courrier'), COURRIER_DATE_FR);
    await page.getByLabel('Référence expéditeur').fill('REF-05');
    await selectOption(page, page.getByLabel('Destinataire', { exact: true }), dest.roleName);
    await page.locator('input[type="file"][accept=".pdf"]').setInputFiles(pdfUpload(`${uniq('cou05')}.pdf`));
    const body = await submitAndGetMail(page);

    const mail = await getMail(api, body.mailId);
    expect(mail.externalEntityId).toBe(entity.externalEntityId);
    expect(mail.externalEntity).toMatchObject({ label });

    const entities = (await api.get('/courriers/referentials/external-entities')) as Array<{
      externalEntityId: number;
      label: string;
      email: string | null;
    }>;
    expect(entities).toContainEqual(
      expect.objectContaining({ externalEntityId: entity.externalEntityId, label, email: 'contact@e2e.test' }),
    );
  });

  test('COU-06 — en copie : imputation « En Copie », hors parapheur, visible au suivi DC', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou06-dest'), menus: [MENUS.controle] });
    const copie = await createCourrierActor(api, {
      prefix: uniq('cou06-copie'),
      menus: [MENUS.parapheur, MENUS.suiviDC],
    });
    const entity = await createExternalEntity(api, uniq('COU-06'));
    const title = uniq('COU-06 Objet');

    await openEnregistrement(page);
    await fillRequired(page, {
      title,
      reference: 'REF-06',
      entityLabel: entity.label,
      roleName: dest.roleName,
      pdfName: `${uniq('cou06')}.pdf`,
    });
    await selectOption(page, page.getByLabel('En copie (facultatif)'), copie.fullName, { multiple: true });
    const body = await submitAndGetMail(page);

    const mail = await getMail(api, body.mailId);
    expect(mail.inputations).toHaveLength(1);
    expect(mail.inputations[0]).toMatchObject({
      userId: copie.userGroupId,
      mailInputationTypeId: INPUTATION_TYPE.enCopie,
      dateTreated: null,
    });

    const copieApi = await apiAs(copie.username, copie.password);
    const parapheur = (await copieApi.get('/courriers/parapheur?pageSize=200')) as {
      rows: Array<{ mailId: number }>;
    };
    expect(parapheur.rows.map((r) => r.mailId)).not.toContain(body.mailId);
    const suivi = (await copieApi.get('/courriers/suivi?pageSize=200')) as { rows: Array<{ mailId: number }> };
    expect(suivi.rows.map((r) => r.mailId)).toContain(body.mailId);

    // Le destinataire principal, lui, le reçoit dans son Contrôle.
    const destApi = await apiAs(dest.username, dest.password);
    const controle = (await destApi.get('/courriers/controle?pageSize=200')) as {
      rows: Array<{ mailId: number }>;
    };
    expect(controle.rows.map((r) => r.mailId)).toContain(body.mailId);
  });

  test('COU-07 — rattachement d’un scan via ?scanId= : pas de PDF à rejoindre, scan traité', async ({
    page,
    api,
    uniq,
  }) => {
    const dest = await createCourrierActor(api, { prefix: uniq('cou07-dest'), menus: [MENUS.controle] });
    const entity = await createExternalEntity(api, uniq('COU-07'));
    const scan = await uploadScan(api, { name: `${uniq('cou07-scan')}.pdf` });
    const title = uniq('COU-07 Objet');

    await openEnregistrement(page, `?scanId=${scan.mailScannedDocumentId}`);
    const banner = page.getByRole('alert').filter({ hasText: 'Document scanné rattaché' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(scan.fileName);

    // Aucun PDF sélectionné : le binaire vient du scan, le champ n'est pas exigé.
    await fillRequired(page, { title, reference: 'REF-07', entityLabel: entity.label, roleName: dest.roleName });
    const body = await submitAndGetMail(page);
    await expect(fieldError(page, 'Le courrier numérisé est obligatoire')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${MENUS.enregistrement}$`));
    await expect(banner).toBeHidden();

    const mail = await getMail(api, body.mailId);
    expect(mail.documents).toHaveLength(1);
    const scanRow = (await api.get(`/courriers/documents-scannes/${scan.mailScannedDocumentId}`)) as {
      isTraite: boolean;
      mailId: number | null;
      documentId: number | null;
    };
    expect(scanRow).toMatchObject({
      isTraite: true,
      mailId: body.mailId,
      documentId: mail.documents[0].documentId,
    });
    const pending = (await api.get('/courriers/documents-scannes?pageSize=200')) as {
      rows: Array<{ mailScannedDocumentId: number }>;
    };
    expect(pending.rows.map((r) => r.mailScannedDocumentId)).not.toContain(scan.mailScannedDocumentId);

    // Scan inconnu : refus propre (404), aucun courrier créé.
    const res = await api.raw.post('/courriers/arrivee', {
      title: 'COU-07 scan inconnu',
      date: todayIso(),
      destinataireRoleId: dest.roleId,
      scannedDocumentId: 999_999_999,
    });
    expect(res.status()).toBe(404);
  });

  test('COU-08 — saisie automatique IA sans service : désactivée, non proposée', async ({ page, api }) => {
    expect(await api.get('/courriers/extraction-ia/disponibilite')).toEqual({ enabled: false });

    const dispo = page.waitForResponse((r) => /\/api\/courriers\/extraction-ia\/disponibilite$/.test(r.url()));
    await openEnregistrement(page);
    expect(await (await dispo).json()).toEqual({ enabled: false });
    await expect(page.getByText('Saisie automatique par IA')).toHaveCount(0);
    await expect(page.getByText('Déposer le courrier à analyser')).toHaveCount(0);

    // Appel direct : erreur propre et actionnable (503), jamais un 500.
    const res = await api.raw.upload('/courriers/extraction-ia', { field: 'file', file: pdfUpload('ia.pdf') });
    expect(res.status()).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain("L'IA est désactivée");

    // Format non lisible par l'analyse : 400 avant tout appel IA.
    const tiff = await api.raw.upload('/courriers/extraction-ia', {
      field: 'file',
      file: { name: 'scan.tiff', mimeType: 'image/tiff', buffer: Buffer.from('II*\u0000') },
    });
    expect(tiff.status()).toBe(400);
    expect(((await tiff.json()) as { message: string }).message).toContain('Format non pris en charge');
  });

  test('COU-09 — sans le menu Enregistrement : entrée masquée, API 403, envoi refusé', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const agent = await createCourrierActor(api, { prefix: uniq('cou09-agent'), menus: [MENUS.controle] });
    const agentApi = await apiAs(agent.username, agent.password);
    // Créé AVANT l'ouverture de l'écran : la liste des correspondants est lue au chargement.
    const entity = await createExternalEntity(api, uniq('COU-09'));

    expect((await agentApi.raw.get('/courriers/next-reference/arrivee')).status()).toBe(403);
    expect((await agentApi.raw.get('/courriers/extraction-ia/disponibilite')).status()).toBe(403);
    const post = await agentApi.raw.post('/courriers/arrivee', {
      title: 'COU-09',
      date: todayIso(),
      destinataireRoleId: agent.roleId,
    });
    expect(post.status()).toBe(403);
    expect(((await post.json()) as { message: string }).message).toBe(FORBIDDEN_MESSAGE);
    expect(
      (await agentApi.raw.post('/courriers/referentials/external-entities', { label: uniq('COU-09') })).status(),
    ).toBe(403);
    expect(
      (await agentApi.raw.upload('/courriers/documents-scannes', { field: 'file', file: pdfUpload('cou09.pdf') })).status(),
    ).toBe(403);

    await loginAs(page, agent.username, agent.password);
    await page.goto(MENUS.controle);
    await expect(sidebarItem(page, 'Courriers arrivés')).toBeVisible();
    await expect(sidebarItem(page, 'Enregistrement')).toHaveCount(0);

    // Accès direct à l'URL : pas de n° proposé (403), et l'envoi échoue avec le message du garde.
    const ref = page.waitForResponse((r) => /\/api\/courriers\/next-reference\/arrivee$/.test(r.url()));
    await page.goto(MENUS.enregistrement);
    expect((await ref).status()).toBe(403);
    // Fin du chargement : la date d'enregistrement est posée en même temps que le n° (vide ici).
    await expect(page.getByLabel("Date d'enregistrement")).toHaveValue(todayFr());
    await expect(nRefField(page)).toHaveValue('');
    await nRefField(page).fill('99999');
    await fillRequired(page, {
      title: uniq('COU-09 Objet'),
      reference: 'REF-09',
      entityLabel: entity.label,
      roleName: agent.roleName,
      pdfName: 'cou09.pdf',
    });
    let arriveePosted = false;
    page.on('request', (r) => {
      if (isArriveePost(r.url(), r.method())) arriveePosted = true;
    });
    await page.getByRole('button', { name: 'Enregistrer le courrier' }).click();
    await expect(toast(page, FORBIDDEN_MESSAGE)).toBeVisible();
    // Le dépôt du PDF (1re étape) est refusé : l'enregistrement n'est même pas tenté.
    expect(arriveePosted).toBe(false);
  });

  test('COU-09 — accès direct sans le menu : écran « accès refusé » explicite', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    // Décision de l'utilisateur : écran « Accès refusé » dès l'ouverture, fait dans AuthShell par le
    // lot transverse. Le refus de l'API (403) est déjà vérifié par le test COU-09 précédent.
    test.fixme(true, 'en attente du lot transverse : écran Accès refusé');
    const agent = await createCourrierActor(api, { prefix: uniq('cou09b-agent'), menus: [MENUS.controle] });
    await loginAs(page, agent.username, agent.password);
    await page.goto(MENUS.enregistrement);
    await expect(page.getByText(/accès refusé/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enregistrer le courrier' })).toHaveCount(0);
  });
});
