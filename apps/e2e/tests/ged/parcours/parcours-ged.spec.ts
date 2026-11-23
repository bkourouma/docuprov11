/**
 * GED — parcours de bout en bout.
 *  - GED-01 : espace → document de l'éditeur → édition (WebSocket collab) → version → fiche →
 *    intégrité + cachet → publication → lecture anonyme refusée / lecture authentifiée → dépublication.
 *  - GED-02 : fonctions IA sans service configuré (gouvernance, recherche sémantique) : états propres.
 *  - GED-03 : un membre CONTRIBUTEUR crée et édite son document dans un espace de collaboration.
 *  - GED-04 : co-édition par un contributeur d'un document créé par autrui (question métier).
 */
import { test, expect } from '../../../fixtures';
import type { Page } from '@playwright/test';
import {
  SpaceKind,
  SpacePermission,
  addUserMember,
  anonymousContext,
  antMessage,
  createSpace,
  createSpaceUser,
  descriptionValue,
  idFromUrl,
  popconfirmButton,
  publicPath,
  toSlug,
  userPage,
  type SpaceDocumentRow,
} from '../_helpers/espaces';

interface VersionRow {
  documentVersionId: number;
  versionNumber: number;
  isCurrent: boolean;
  changeSummary: string | null;
  files: Array<{ fileId: number; fileExtension: string; originalName: string | null }>;
}

/** Barre d'état de l'éditeur (région `role=status`) : « Connecté · Enregistré », « Hors ligne »… */
const editorStatus = (page: Page) =>
  page.getByRole('status').filter({ hasText: /Connecté|Connexion|Reconnexion|Hors ligne/ });

/**
 * Saisit du texte dans l'éditeur une fois la session temps réel établie et synchronisée, puis
 * attend que le serveur ait tout reçu (« Enregistré » : connecté, synchronisé, 0 modification en
 * attente). La persistance passe par le WebSocket collab (`/api/collab`), pas par une requête REST.
 */
async function typeInEditor(page: Page, text: string) {
  await expect(editorStatus(page)).toContainText('Connecté · Enregistré');
  const box = page.getByRole('textbox', { name: 'Contenu du document' });
  await expect(box).toBeEditable();
  await box.click();
  await page.keyboard.type(text);
  await expect(box).toContainText(text);
  await expect(editorStatus(page)).toContainText('Connecté · Enregistré');
}

/** « Enregistrer une version » depuis l'éditeur ; renvoie le numéro créé (attend une création). */
async function saveVersionFromEditor(page: Page, documentId: number, summary: string): Promise<number> {
  await page.getByRole('button', { name: 'Enregistrer une version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Enregistrer une version' });
  await dialog.getByLabel('Résumé des modifications (facultatif)').fill(summary);
  const saved = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/collab/documents/${documentId}/versions` &&
      r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  const res = await saved;
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { created: boolean; version: { versionNumber: number } | null };
  expect(body.created, 'le contenu saisi doit produire une nouvelle version').toBe(true);
  const n = body.version?.versionNumber ?? NaN;
  await expect(antMessage(page, `Version ${n} enregistrée.`)).toBeVisible();
  await expect(dialog).toBeHidden();
  return n;
}

test.describe('GED — parcours de bout en bout', () => {
  test('GED-01 espace, document, édition, version, cachet, publication, lecture et dépublication', async ({
    page,
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }, testInfo) => {
    test.slow(); // parcours long : éditeur temps réel + plusieurs contextes navigateur.
    const spaceLabel = uniq('ged01-espace');
    const docLabel = uniq('ged01-doc');
    const typed = `Compte rendu ${uniq('ged01-texte')}`;
    const summary = 'Première rédaction';
    const slug = toSlug(uniq('ged01-pub'));

    // 1. Créer l'espace par l'interface (partagé : condition de la publication).
    await page.goto('/espaces');
    await page.getByRole('button', { name: 'Nouvel espace' }).first().click();
    const form = page.getByRole('dialog', { name: 'Nouvel espace' });
    await form.getByLabel('Libellé').fill(spaceLabel);
    await form.getByRole('radio', { name: 'Partagé' }).check();
    await form.getByRole('button', { name: "Créer l'espace" }).click();
    await expect(page).toHaveURL(/\/espaces\/\d+$/);
    const spaceId = idFromUrl(page.url(), 'espaces');
    await expect(page.getByRole('heading', { name: spaceLabel })).toBeVisible();

    // 2. Créer un document dans l'éditeur, depuis l'espace (espace présélectionné).
    await page.getByRole('button', { name: 'Nouveau document' }).click();
    await expect(page).toHaveURL(new RegExp(`/editeur/nouveau\\?spaceId=${spaceId}$`));
    await expect(page.locator('.ant-select-selection-item').filter({ hasText: spaceLabel })).toBeVisible();
    await page.getByLabel('Titre').fill(docLabel);
    await page.getByRole('button', { name: 'Créer le document' }).click();
    await expect(page).toHaveURL(/\/editeur\/\d+$/);
    const documentId = idFromUrl(page.url(), 'editeur');
    await expect(page.getByRole('heading', { name: docLabel })).toBeVisible();

    // 3. Éditer (persistance par le WebSocket collab).
    await typeInEditor(page, typed);

    // 4. Enregistrer une version depuis l'éditeur, puis la vérifier par l'API.
    const versionNumber = await saveVersionFromEditor(page, documentId, summary);
    expect(versionNumber).toBe(2);
    const versions = await api.get<VersionRow[]>(`/documents/${documentId}/versions`);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    const v2 = versions[0];
    if (!v2) throw new Error('version 2 absente de la liste');
    expect(v2).toMatchObject({ isCurrent: true, changeSummary: summary });
    // L'instantané HTML de la version porte bien le texte saisi.
    const html = v2.files.find((f) => f.fileExtension === '.html');
    expect(html, 'pièce .html de la version').toBeTruthy();
    const content = await api.raw.get(
      `/documents/${documentId}/versions/${v2.documentVersionId}/files/${html!.fileId}/content`,
    );
    expect(content.status()).toBe(200);
    expect(await content.text()).toContain(typed);

    // 5. Fiche document : versions visibles.
    await page.getByRole('button', { name: 'Retour à la fiche' }).click();
    await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`));
    await expect(page.getByRole('heading', { name: `Document #${documentId}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ouvrir le document' })).toBeVisible();
    await page.getByRole('tab', { name: 'Versions' }).click();
    const timeline = page.locator('.ant-timeline');
    await expect(timeline.getByText('Version 2', { exact: true })).toBeVisible();
    await expect(timeline.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(timeline.getByText('Courante')).toHaveCount(1);
    await expect(timeline.getByText(summary)).toBeVisible();

    // 6. Intégrité puis cachet serveur. La clé de scellement est créée au premier usage sous
    //    ARCHIVES (`loadOrCreateSealingKey`) : aucun réglage n'est requis pour la pile E2E.
    await page.getByRole('tab', { name: 'Sécurité et conformité' }).click();
    await expect(page.getByText('Non scellé')).toBeVisible();
    await page.getByRole('button', { name: 'Vérifier maintenant' }).click();
    await expect(antMessage(page, /Intégrité conforme\.|Empreinte de référence posée\./)).toBeVisible();
    await page.getByRole('button', { name: 'Apposer le cachet' }).click();
    await expect(antMessage(page, 'Cachet apposé.')).toBeVisible();
    await expect(page.getByText('Scellé et intact')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Renouveler le cachet' })).toBeVisible();
    const seal = await api.get<{ sealed: boolean; knownKey?: boolean; signatureValid?: boolean; contentMatches?: boolean }>(
      `/documents/${documentId}/seal`,
    );
    expect(seal).toMatchObject({ sealed: true, knownKey: true, signatureValid: true, contentMatches: true });

    // 7. Le document est dans l'espace (l'éditeur l'y a rattaché à la création).
    await page.goto(`/espaces/${spaceId}`);
    await expect(page.getByRole('tab', { name: 'Documents (1)' })).toBeVisible();
    await expect(page.getByRole('link', { name: docLabel })).toHaveAttribute('href', `/documents/${documentId}`);
    const inSpace = await api.get<SpaceDocumentRow[]>(`/spaces/${spaceId}/documents`);
    expect(inSpace.map((d) => d.documentId)).toEqual([documentId]);

    // 8. Publier l'espace.
    await page.getByRole('button', { name: 'Publier' }).click();
    const publish = page.getByRole('dialog', { name: "Publier l'espace" });
    await publish.getByPlaceholder('mon-espace').fill(slug);
    await publish.getByRole('button', { name: 'Publier' }).click();
    await expect(antMessage(page, 'Espace publié')).toBeVisible();
    await expect(page.getByRole('link', { name: publicPath(slug) })).toBeVisible();

    // 9a. Lecture ANONYME : refusée (aucune route publique, renvoi vers la connexion).
    const anon = await anonymousContext(browser, testInfo);
    try {
      expect((await anon.request.get(`/api/spaces/published/${slug}`)).status()).toBe(401);
      const anonPage = await anon.newPage();
      await anonPage.goto(publicPath(slug));
      await expect(anonPage).toHaveURL(/\/login(\?|$)/);
      await expect(anonPage.getByText(spaceLabel)).toHaveCount(0);
    } finally {
      await anon.close();
    }

    // 9b. Lecture par le « public » réel : un utilisateur authentifié, porteur du menu, non membre.
    const reader = await createSpaceUser(api, apiAs, uniq('ged01-lecteur'));
    const { context, page: readerPage } = await userPage(browser, testInfo, loginAs, reader);
    try {
      await readerPage.goto(publicPath(slug));
      await expect(readerPage.getByRole('heading', { name: spaceLabel })).toBeVisible();
      await expect(readerPage.getByRole('link', { name: docLabel })).toBeVisible();
      await expect(readerPage.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);

      // 10. Dépublier : le lien ne sert plus rien.
      await page.getByRole('button', { name: 'Dépublier' }).click();
      await popconfirmButton(page, 'Dépublier').click();
      await expect(antMessage(page, 'Espace dépublié')).toBeVisible();
      await expect(descriptionValue(page, 'Publication')).toHaveText('Non publié');

      await readerPage.reload();
      await expect(readerPage.getByText("Cet espace n'existe pas ou n'est plus publié.")).toBeVisible();
      await expect(readerPage.getByRole('link', { name: docLabel })).toHaveCount(0);
      const readerApi = await apiAs(reader.username, reader.password);
      expect((await readerApi.raw.get(`/spaces/published/${slug}`)).status()).toBe(404);
    } finally {
      await context.close();
    }
    expect((await api.raw.get(`/spaces/published/${slug}`)).status()).toBe(404);
  });

  test('GED-02 fonctions IA sans service configuré : gouvernance et recherche répondent proprement', async ({
    api,
    uniq,
  }) => {
    // Pile E2E hermétique : aucune clé IA. On vérifie les ÉTATS, jamais un appel au fournisseur.
    const space = await createSpace(api, { label: uniq('ged02') });
    const docLabel = uniq('ged02-doc');
    const doc = await api.post<{ documentId: number }>('/collab/documents', { spaceId: space.gedSpaceId, label: docLabel });

    // Gouvernance : l'analyse est acceptée (202) et annonce le mode déterministe.
    const analyze = await api.raw.post('/governance/analyze', { documentIds: [doc.documentId] });
    expect(analyze.status()).toBe(202);
    const analysis = (await analyze.json()) as { queued: number; ignored: number; aiEnabled: boolean; message: string | null };
    expect(analysis.aiEnabled).toBe(false);
    expect(analysis.message).toContain('IA désactivée');
    // Un document de l'éditeur non validé n'est pas « analysable » (is_archived = false) : ignoré.
    expect(analysis.queued + analysis.ignored).toBe(1);

    // Recherche sémantique : repli plein texte, sans erreur.
    const search = await api.raw.post('/semantic-search', { query: docLabel });
    expect(search.status()).toBe(200);
    const found = (await search.json()) as { mode: string; hits: unknown[] };
    expect(found.mode).toBe('fulltext');
    expect(Array.isArray(found.hits)).toBe(true);

    // Question-réponse : repli plein texte aussi.
    const ask = await api.raw.post('/semantic-search/ask', { question: `Que contient ${docLabel} ?` });
    expect(ask.status()).toBe(200);
    expect(((await ask.json()) as { mode: string }).mode).toBe('fulltext');
  });

  test('GED-03 un membre contributeur crée et édite son document ; il ne peut pas le sceller', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    test.slow();
    const contributor = await createSpaceUser(api, apiAs, uniq('ged03-contrib'));
    const space = await createSpace(api, { label: uniq('ged03-espace'), kind: SpaceKind.Collaboration });
    await addUserMember(api, space.gedSpaceId, contributor.userGroupId, SpacePermission.Contribution);
    const docLabel = uniq('ged03-doc');
    const typed = `Contribution ${uniq('ged03-texte')}`;

    const { context, page } = await userPage(browser, testInfo, loginAs, contributor);
    try {
      await page.goto(`/espaces/${space.gedSpaceId}`);
      await expect(descriptionValue(page, 'Mon droit')).toHaveText('Contribution');
      // Contribution : créer et rattacher, mais ni modifier ni publier l'espace.
      await expect(page.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Publier', exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'Nouveau document' }).click();
      await expect(page.locator('.ant-select-selection-item').filter({ hasText: space.label })).toBeVisible();
      await page.getByLabel('Titre').fill(docLabel);
      await page.getByRole('button', { name: 'Créer le document' }).click();
      await expect(page).toHaveURL(/\/editeur\/\d+$/);
      const documentId = idFromUrl(page.url(), 'editeur');

      // Créateur : niveau Modification sur SA pièce, donc éditeur en écriture.
      await expect(page.getByText('Lecture seule', { exact: true })).toHaveCount(0);
      await typeInEditor(page, typed);
      expect(await saveVersionFromEditor(page, documentId, 'Ajout du contributeur')).toBe(2);

      // Le document est dans l'espace, vu aussi par le propriétaire.
      const owned = await api.get<SpaceDocumentRow[]>(`/spaces/${space.gedSpaceId}/documents`);
      expect(owned.map((d) => d.documentId)).toContain(documentId);

      // Cachet : niveau Archivistique requis, la raison est affichée et l'API refuse (403).
      await page.goto(`/documents/${documentId}`);
      await page.getByRole('tab', { name: 'Sécurité et conformité' }).click();
      await expect(page.getByText('Niveau Archivistique requis pour apposer un cachet')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Apposer le cachet' })).toHaveCount(0);
      const self = await apiAs(contributor.username, contributor.password);
      const sealed = await self.raw.post(`/documents/${documentId}/seal`, {});
      expect(sealed.status()).toBe(403);
    } finally {
      await context.close();
    }
  });

  test('GED-04 un contributeur ne modifie pas le document créé par un autre membre (lecture seule)', async ({
    browser,
    api,
    apiAs,
    loginAs,
    uniq,
  }, testInfo) => {
    // Règle confirmée par l'utilisateur (2026-11-22) : l'appartenance « Contribution » à un espace
    // ne donne aucun droit d'écriture sur le document d'un autre membre (docs/ged-espaces.md §3.4).
    test.slow();
    const author = await createSpaceUser(api, apiAs, uniq('ged04-auteur'));
    const coMember = await createSpaceUser(api, apiAs, uniq('ged04-membre'));
    const space = await createSpace(api, { label: uniq('ged04-espace'), kind: SpaceKind.Collaboration });
    await addUserMember(api, space.gedSpaceId, author.userGroupId, SpacePermission.Contribution);
    await addUserMember(api, space.gedSpaceId, coMember.userGroupId, SpacePermission.Contribution);

    const authorApi = await apiAs(author.username, author.password);
    const docLabel = uniq('ged04-doc');
    const doc = await authorApi.post<{ documentId: number }>('/collab/documents', {
      spaceId: space.gedSpaceId,
      label: docLabel,
    });
    // Témoin : l'auteur, lui, édite sa pièce.
    expect(await authorApi.get(`/collab/documents/${doc.documentId}/session`)).toMatchObject({ mode: 'write' });

    // Le co-membre voit le document dans l'espace…
    const coApi = await apiAs(coMember.username, coMember.password);
    const listed = await coApi.get<SpaceDocumentRow[]>(`/spaces/${space.gedSpaceId}/documents`);
    expect(listed.map((d) => d.documentId)).toContain(doc.documentId);
    // … mais l'ouvre en lecture seule : session `read`, écritures refusées (403), aucune version créée.
    expect(await coApi.get(`/collab/documents/${doc.documentId}/session`)).toMatchObject({
      mode: 'read',
      label: docLabel,
    });
    expect((await coApi.raw.post(`/collab/documents/${doc.documentId}/versions`, {})).status()).toBe(403);
    expect((await coApi.raw.post(`/collab/documents/${doc.documentId}/import`, {})).status()).toBe(403);
    expect((await coApi.raw.patch(`/documents/${doc.documentId}/indexation`, { label: 'pirate' })).status()).toBe(403);
    const versions = await api.get<VersionRow[]>(`/documents/${doc.documentId}/versions`);
    expect(versions.map((v) => v.versionNumber)).toEqual([1]);

    // Écran : éditeur non modifiable, aucune action d'écriture.
    const { context, page } = await userPage(browser, testInfo, loginAs, coMember);
    try {
      await page.goto(`/editeur/${doc.documentId}`);
      const box = page.getByRole('textbox', { name: 'Contenu du document (lecture seule)', exact: true });
      await expect(box).toBeVisible();
      await expect(box).toHaveAttribute('contenteditable', 'false');
      await expect(page.getByText('Lecture seule', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enregistrer une version' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
