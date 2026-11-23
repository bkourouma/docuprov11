/**
 * GED-45 à GED-49 — Gouvernance des documents (`/gouvernance`, API `/governance`).
 *
 * Pile E2E : IA désactivée ; aucune proposition n'est produite (pas de document archivé préparé,
 * pas d'analyse lancée par ces tests sur un document réel). Menu RBAC `/gouvernance` refusé par
 * défaut ; « tout le fonds » réservé aux administrateurs.
 */
import { test, expect } from '../../../fixtures';
import { createRestrictedUser } from '../_helpers/users';
import { createArchivedDocument } from '../_helpers/archives';
import { minimalPdf } from '../_helpers/documents';
import {
  GOVERNANCE_AI_OFF_MESSAGE,
  MISSING_ID,
  MISSING_ID_2,
  asT4,
  asT4As,
  errorText,
  expectAiDisabled,
  isApiCall,
  openPageAs,
  pickAntOption,
} from '../_helpers/ia';
import {
  ANALYZE_DOCUMENT_NOT_FOUND,
  GOVERNANCE_EMPTY_FILTERED,
  GOVERNANCE_FORBIDDEN_TEXT,
  GOVERNANCE_KINDS,
  type GovernanceDashboard,
  type GovernancePage,
} from '../_helpers/gouvernance';

const FORBIDDEN_SECTION = "Vous n'avez pas accès à cette section.";
const GOV_MENU = '/gouvernance';

function isProposalsRequest(fragment: string) {
  return (r: { url(): string; method(): string }) =>
    r.method() === 'GET' && r.url().includes('/governance/proposals?') && r.url().includes(fragment);
}

test.describe('Gouvernance — tableau de bord', () => {
  test('GED-45 IA désactivée : tableau de bord, message clair et cartes de synthèse', async ({ page, api }) => {
    const admin = asT4(api);
    await expectAiDisabled(admin);

    const dashboard = await admin.get<GovernanceDashboard>('/governance/dashboard');
    expect(dashboard.aiEnabled).toBe(false);
    expect(dashboard.aiMessage).toBe(GOVERNANCE_AI_OFF_MESSAGE);
    expect(Object.keys(dashboard.byKind).sort()).toEqual(GOVERNANCE_KINDS.map((k) => k.kind).sort());
    for (const counts of [...Object.values(dashboard.byKind), dashboard.totals]) {
      expect(counts.total).toBe(counts.proposee + counts.validee + counts.rejetee);
    }
    expect(Number.isInteger(dashboard.openDuplicateGroups)).toBe(true);
    expect(Number.isNaN(Date.parse(dashboard.generatedAt))).toBe(false);

    await page.goto('/gouvernance');
    await expect(page.getByRole('heading', { name: 'Gouvernance' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: GOVERNANCE_AI_OFF_MESSAGE })).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Détection des noms de personnes : réalisée uniquement par un modèle local.' }),
    ).toBeVisible();

    const cards = page.getByRole('group', { name: 'Synthèse des propositions' });
    for (const { label } of GOVERNANCE_KINDS) {
      await expect(cards.getByRole('button', { name: new RegExp(`^${label} : \\d+ en attente`) })).toBeVisible();
    }
    await expect(cards.getByRole('group', { name: /^Groupes de doublons ouverts : \d+$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Actualiser' })).toBeVisible();

    // Une carte filtre la liste par nature ; un second clic retire le filtre.
    const card = cards.getByRole('button', { name: /^Doublon exact :/ });
    const filteredP = page.waitForRequest(isProposalsRequest('kind=duplicate_exact'));
    await card.click();
    await filteredP;
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toContainText('Filtre actif');
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Gouvernance — liste et filtres', () => {
  test('GED-46 filtres combinés sans résultat : état vide dédié puis réinitialisation', async ({ page, api }) => {
    const admin = asT4(api);
    // Précondition (pile sans IA ni analyse) : aucune proposition validée de sensibilité à 90 % et plus.
    const expected = await admin.get<GovernancePage>(
      '/governance/proposals?kind=sensitivity&status=1&minConfidence=0.9&page=1&pageSize=25',
    );
    expect(expected.total, 'précondition : aucune proposition de sensibilité validée ≥ 90 %').toBe(0);

    await page.goto('/gouvernance');
    await expect(page.getByRole('heading', { name: 'Gouvernance' })).toBeVisible();

    let req = page.waitForRequest(isProposalsRequest('status=1'));
    await pickAntOption(page, page.getByLabel('Statut', { exact: true }), 'Validée');
    await req;
    req = page.waitForRequest(isProposalsRequest('kind=sensitivity'));
    await pickAntOption(page, page.getByLabel('Nature', { exact: true }), 'Sensibilité');
    await req;
    req = page.waitForRequest(isProposalsRequest('minConfidence=0.9'));
    await pickAntOption(page, page.getByLabel('Confiance minimale', { exact: true }), '90 % et plus');
    await req;

    await expect(page.getByText(GOVERNANCE_EMPTY_FILTERED)).toBeVisible();

    const resetP = page.waitForRequest(isProposalsRequest('status=0'));
    await page.getByRole('button', { name: 'Réinitialiser les filtres' }).first().click();
    await resetP;
    await expect(page.locator('.gov-filter', { hasText: 'Statut' }).locator('.ant-select-selection-item')).toHaveText(
      'Proposée',
    );
    await expect(page.getByText(GOVERNANCE_EMPTY_FILTERED)).toHaveCount(0);
  });

  test('GED-46 filtres et identifiants invalides refusés par l’API (400 / 404)', async ({ api }) => {
    const raw = asT4(api).raw;
    for (const query of [
      'status=3',
      'kind=inconnue',
      'pageSize=101',
      'page=0',
      'minConfidence=2',
      'groupKey=',
      'champInconnu=1',
    ]) {
      const res = await raw.get(`/governance/proposals?${query}`);
      expect(res.status(), `${query} : ${await errorText(res)}`).toBe(400);
    }
    expect((await raw.get('/governance/proposals/abc')).status()).toBe(400);
    expect((await raw.get('/governance/proposals/0')).status()).toBe(400);
    const missing = await raw.get(`/governance/proposals/${MISSING_ID}`);
    expect(missing.status()).toBe(404);
    expect(await errorText(missing)).toBe('Proposition introuvable.');
  });
});

test.describe('Gouvernance — analyse', () => {
  test('GED-47 modale d’analyse : saisies invalides, document introuvable, numéros ignorés', async ({ page, api }) => {
    await expectAiDisabled(asT4(api));
    await page.goto('/gouvernance');
    await page.getByRole('button', { name: 'Analyser un document' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Analyser un document' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Analyser tout le fonds' })).toBeVisible(); // administrateur

    const field = dialog.getByLabel('Numéro(s) de document');
    const go = dialog.getByRole('button', { name: 'Lancer l’analyse' });

    await go.click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Saisissez au moins un numéro de document.' })).toBeVisible();
    await field.fill('12 abc');
    await go.click();
    await expect(
      dialog.getByRole('alert').filter({ hasText: '« abc » n’est pas un numéro de document valide.' }),
    ).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    // Un seul numéro inexistant : 404 de l'API, message centré sur le document (ANO-GED-T4-2).
    await field.fill(String(MISSING_ID));
    let resP = page.waitForResponse(isApiCall('POST', '/governance/analyze'));
    await go.click();
    expect((await resP).status()).toBe(404);
    await expect(dialog.getByRole('alert').filter({ hasText: ANALYZE_DOCUMENT_NOT_FOUND })).toBeVisible();

    // Plusieurs numéros inexistants : 202, rien en file, IA désactivée signalée.
    await field.fill(`${MISSING_ID}, ${MISSING_ID_2}`);
    resP = page.waitForResponse(isApiCall('POST', '/governance/analyze'));
    await go.click();
    expect((await resP).status()).toBe(202);
    const success = dialog.getByRole('alert').filter({ hasText: '0 document(s) mis en file, 2 ignoré(s).' });
    await expect(success).toBeVisible();
    await expect(success).toContainText(GOVERNANCE_AI_OFF_MESSAGE);

    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialog).toBeHidden();
  });

  test('GED-47 API d’analyse : contrat 202 et corps invalides', async ({ api }) => {
    const admin = asT4(api);
    await expectAiDisabled(admin);
    const res = await admin.raw.post('/governance/analyze', { documentIds: [MISSING_ID, MISSING_ID_2, MISSING_ID] });
    expect(res.status()).toBe(202);
    expect(await res.json()).toEqual({
      queued: 0,
      ignored: 2,
      aiEnabled: false,
      message: GOVERNANCE_AI_OFF_MESSAGE,
    });

    const single = await admin.raw.post('/governance/analyze', { documentId: MISSING_ID });
    expect(single.status()).toBe(404);
    expect(await errorText(single)).toBe('Document introuvable.');

    for (const body of [
      {},
      { documentIds: [] },
      { documentIds: Array.from({ length: 201 }, (_, i) => i + 1) },
      { documentId: 0 },
      { all: true, documentId: 1 },
      { all: false },
    ]) {
      const bad = await admin.raw.post('/governance/analyze', body);
      expect(bad.status(), JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });
});

test.describe('Gouvernance — droits', () => {
  test('GED-48 sans le menu « Gouvernance » : écran refusé et API 403', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    const user = await createRestrictedUser(asT4(api), asT4As(apiAs), uniq('gov-sans-menu'), []);
    const self = await asT4As(apiAs)(user.username, user.password);
    for (const [method, path, body] of [
      ['GET', '/governance/dashboard', undefined],
      ['GET', '/governance/proposals', undefined],
      ['GET', `/governance/proposals/${MISSING_ID}`, undefined],
      ['POST', '/governance/analyze', { documentIds: [MISSING_ID] }],
      ['POST', `/governance/proposals/${MISSING_ID}/validate`, {}],
      ['POST', `/governance/proposals/${MISSING_ID}/reject`, {}],
    ] as const) {
      const res = method === 'GET' ? await self.raw.get(path) : await self.raw.post(path, body);
      expect(res.status(), `${method} ${path}`).toBe(403);
      expect(await errorText(res)).toBe(FORBIDDEN_SECTION);
    }

    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const p = session.page;
      await p.goto('/gouvernance');
      await expect(p.getByText(GOVERNANCE_FORBIDDEN_TEXT)).toBeVisible();
      await expect(p.getByRole('button', { name: 'Analyser un document' })).toHaveCount(0);
      await expect(p.getByRole('button', { name: 'Actualiser' })).toHaveCount(0);
      await expect(p.getByRole('group', { name: 'Synthèse des propositions' })).toHaveCount(0);
    } finally {
      await session.close();
    }
  });

  test('GED-48 avec le menu, non administrateur : écran ouvert, « tout le fonds » refusé', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    const user = await createRestrictedUser(asT4(api), asT4As(apiAs), uniq('gov-avec-menu'), [GOV_MENU]);
    const self = await asT4As(apiAs)(user.username, user.password);

    const dashboard = await self.get<GovernanceDashboard>('/governance/dashboard');
    expect(dashboard.aiEnabled).toBe(false);
    const all = await self.raw.post('/governance/analyze', { all: true });
    expect(all.status()).toBe(403);
    expect(await errorText(all)).toBe('Réservé aux administrateurs');
    const ignored = await self.raw.post('/governance/analyze', { documentIds: [MISSING_ID] });
    expect(ignored.status()).toBe(202);
    expect(await ignored.json()).toMatchObject({ queued: 0, ignored: 1 });

    const session = await openPageAs(browser, loginAs, user, testInfo.project.use.baseURL);
    try {
      const p = session.page;
      await p.goto('/gouvernance');
      await expect(p.getByRole('heading', { name: 'Gouvernance' })).toBeVisible();
      await expect(p.getByRole('group', { name: 'Synthèse des propositions' })).toBeVisible();
      await expect(p.getByText(GOVERNANCE_FORBIDDEN_TEXT)).toHaveCount(0);
      await p.getByRole('button', { name: 'Analyser un document' }).first().click();
      const dialog = p.getByRole('dialog', { name: 'Analyser un document' });
      await expect(dialog.getByRole('button', { name: 'Lancer l’analyse' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Analyser tout le fonds' })).toHaveCount(0);
    } finally {
      await session.close();
    }
  });
});

test.describe('Gouvernance — revue', () => {
  test('GED-49 revue d’une proposition inexistante ou mal adressée : refus propres', async ({ api }) => {
    const raw = asT4(api).raw;
    for (const action of ['validate', 'reject']) {
      const res = await raw.post(`/governance/proposals/${MISSING_ID}/${action}`, {});
      expect(res.status(), action).toBe(404);
      // Message propre au service de revue (la lecture répond « Proposition introuvable. »).
      expect(await errorText(res)).toBe('Proposition de gouvernance introuvable.');
      expect((await raw.post(`/governance/proposals/abc/${action}`, {})).status()).toBe(400);
    }
    expect(
      (await raw.post(`/governance/proposals/${MISSING_ID}/validate`, { confirmLowering: 'oui' })).status(),
    ).toBe(400);
    expect((await raw.post(`/governance/proposals/${MISSING_ID}/validate`, { intrus: true })).status()).toBe(400);

    // La route générique du socle IA ne connaît pas non plus cette décision.
    const generic = await raw.post(`/ged/ai/decisions/${MISSING_ID}/validate`, {});
    expect(generic.status()).toBe(404);
    expect(await errorText(generic)).toBe('Décision IA introuvable');
  });

  test('GED-49 valider puis rejeter une vraie proposition (doublon exact déterministe)', async ({ api, uniq }) => {
    // Trois documents ARCHIVÉS au contenu identique : le worker `ged-governance` (détection
    // déterministe par empreinte, active IA désactivée) propose les deux plus récents comme doublons
    // du plus ancien. Le worker tourne dans la pile (E2E_WORKER=1).
    expect(process.env.E2E_WORKER, 'le worker BullMQ de la pile doit tourner').toBe('1');
    test.slow();
    await expectAiDisabled(api);
    const label = uniq('ged49');
    const pdf = minimalPdf(`contenu identique ${label}`);
    const original = await createArchivedDocument(api, `${label} original`, pdf);
    const dupA = await createArchivedDocument(api, `${label} copie A`, pdf);
    const dupB = await createArchivedDocument(api, `${label} copie B`, pdf);
    const before = await api.get<GovernanceDashboard>('/governance/dashboard');

    const analyzed = await api.raw.post('/governance/analyze', {
      documentIds: [original.documentId, dupA.documentId, dupB.documentId],
    });
    expect(analyzed.status()).toBe(202);
    expect(await analyzed.json()).toMatchObject({ queued: 3, ignored: 0, aiEnabled: false });

    type Proposal = { id: string; kind: string; status: number; documentId: number | null; originalDocumentId: number | null };
    const proposalOf = async (documentId: number): Promise<Proposal | undefined> => {
      const res = await api.get<{ items: Proposal[] }>('/governance/proposals', {
        query: { kind: 'duplicate_exact', status: 0, documentId },
      });
      return res.items[0];
    };
    await expect
      .poll(async () => [await proposalOf(dupA.documentId), await proposalOf(dupB.documentId)].every(Boolean), {
        message: 'propositions « Doublon exact » produites par le worker',
        timeout: 60_000,
      })
      .toBe(true);
    const pA = (await proposalOf(dupA.documentId))!;
    const pB = (await proposalOf(dupB.documentId))!;
    expect(pA.originalDocumentId).toBe(original.documentId);
    expect(pB.originalDocumentId).toBe(original.documentId);
    // L'original n'est le doublon de personne.
    expect(await proposalOf(original.documentId)).toBeUndefined();

    // Valider : le doublon est gelé (archivage logique) ; une seconde revue est refusée (409).
    const validated = await api.raw.post(`/governance/proposals/${pA.id}/validate`, {});
    expect(validated.status(), await errorText(validated)).toBe(200);
    expect(((await validated.json()) as { proposal: { status: number } }).proposal.status).toBe(1);
    const detail = await api.get<{ status: number; comparison: { duplicate: { isFrozen: boolean } } | null }>(
      `/governance/proposals/${pA.id}`,
    );
    expect(detail.status).toBe(1);
    expect(detail.comparison?.duplicate.isFrozen).toBe(true);
    expect((await api.raw.post(`/governance/proposals/${pA.id}/validate`, {})).status()).toBe(409);
    expect((await api.raw.post(`/governance/proposals/${pA.id}/reject`, {})).status()).toBe(409);

    // Rejeter l'autre : statut « Rejetée », le document reste intact (non gelé).
    const rejected = await api.raw.post(`/governance/proposals/${pB.id}/reject`, {});
    expect(rejected.status(), await errorText(rejected)).toBeLessThan(300);
    const rejectedDetail = await api.get<{ status: number; comparison: { duplicate: { isFrozen: boolean } } | null }>(
      `/governance/proposals/${pB.id}`,
    );
    expect(rejectedDetail.status).toBe(2);
    expect(rejectedDetail.comparison?.duplicate.isFrozen).toBe(false);

    // Tableau de bord cohérent : une validée et une rejetée de plus pour « Doublon exact ».
    const after = await api.get<GovernanceDashboard>('/governance/dashboard');
    const k0 = before.byKind.duplicate_exact!;
    const k1 = after.byKind.duplicate_exact!;
    expect(k1.validee - k0.validee).toBe(1);
    expect(k1.rejetee - k0.rejetee).toBe(1);
    expect(k1.total).toBe(k1.proposee + k1.validee + k1.rejetee);
  });
});
