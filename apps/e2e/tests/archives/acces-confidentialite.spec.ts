/**
 * Accès de la recherche P3 — confidentialité, droits explicites (« refus par défaut ») et refus
 * par permission — ARC-20 à ARC-22.
 *
 * Règle RÉELLEMENT appliquée (lue dans `SearchService.buildWhere` et `DocumentsService.canAccess`,
 * qui doivent rester identiques), pour un utilisateur ni administrateur ni agent de numérisation :
 *  - CONFIDENTIALITÉ : un document sans niveau est ouvert ; sinon il faut une habilitation de rang
 *    supérieur ou égal, OU être le créateur, OU détenir un droit nominatif sur CE document ;
 *  - DROITS EXPLICITES : un document (ou son type) qui porte au moins un droit en vigueur est
 *    RESTREINT à ses bénéficiaires ; un document sans aucun droit n'est PAS restreint (écart avec
 *    FR-027, cf. le test « fixme » d'ARC-21).
 * Chaque refus est vérifié sur les quatre canaux : liste ET total de la recherche, export, fiche
 * (`GET /documents/:id`) et binaire (`GET /documents/:id/files/:fileId/content`).
 *
 * Les documents sont créés par l'administrateur : l'utilisateur restreint n'en est jamais le
 * créateur, son passe-droit ne joue donc pas.
 */
import { test, expect } from '../../fixtures';
import type { ApiClient } from '../../fixtures';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import {
  NIVEAU,
  accorderDroitDocument,
  compteGroupeDe,
  creerConfidentialite,
  creerDocumentArchive,
  creerTypeDocument,
  exporterBrut,
  habiliter,
  lignesResultat,
  ouvrirRecherche,
  rechercher,
  rechercherTexte,
} from './_helpers/documents';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

/** Tri numérique (le `sort()` par défaut compare des chaînes : 10 < 9). */
const croissant = (a: number, b: number) => a - b;

/** Identifiants visibles par `client` pour ce jeton, et total annoncé. */
async function visibles(client: ApiClient, jeton: string) {
  const res = await rechercher(client, { fullText: jeton, pageSize: 100 });
  return { ids: res.rows.map((r) => r.documentId), total: res.total };
}

/** Libellés présents dans l'export CSV de `client` pour ce jeton. */
async function exporteCsv(client: ApiClient, jeton: string): Promise<string> {
  const rep = await exporterBrut(client, { fullText: jeton, format: 'csv' });
  expect(rep.status()).toBe(200);
  return (await rep.body()).toString('utf8');
}

/** Premier fichier de la version courante (lu par l'administrateur). */
async function premierFichier(api: ApiClient, documentId: number): Promise<number> {
  const fiche = (await api.get(`/documents/${documentId}`)) as {
    currentVersion: { files: Array<{ fileId: number }> } | null;
  };
  const fichier = fiche.currentVersion?.files[0];
  if (!fichier) throw new Error(`Document ${documentId} sans fichier courant`);
  return fichier.fileId;
}

/** Les quatre canaux refusent `documentId` à `client`. */
async function attendreRefusSurTousLesCanaux(
  api: ApiClient,
  client: ApiClient,
  jeton: string,
  documentId: number,
  label: string,
): Promise<void> {
  const { ids } = await visibles(client, jeton);
  expect(ids, 'recherche').not.toContain(documentId);
  expect(await exporteCsv(client, jeton), 'export').not.toContain(label);
  expect((await client.raw.get(`/documents/${documentId}`)).status(), 'fiche').toBe(404);
  const fileId = await premierFichier(api, documentId);
  expect(
    (await client.raw.get(`/documents/${documentId}/files/${fileId}/content`)).status(),
    'binaire',
  ).toBe(404);
}

test.describe('Accès P3 — confidentialité', () => {
  test('ARC-20 un utilisateur non habilité ne voit pas un document confidentiel (recherche, total, export, fiche, binaire, écran)', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const jeton = uniq('ARC20');
    const niveau = await creerConfidentialite(api, uniq('ARC20 Secret'));
    const secret = await creerDocumentArchive(api, {
      label: `${jeton} secret`,
      confidentialiteId: niveau.confidentialiteId,
    });
    const ouvert = await creerDocumentArchive(api, { label: `${jeton} ouvert` });

    const agent = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc20'),
      menus: ['/search'],
    });
    await habiliter(api, agent.userId, null);
    const client = await apiAs(agent.username, agent.password);

    // Recherche : le document confidentiel n'est ni listé ni COMPTÉ (le total ne fuit pas).
    const vu = await visibles(client, jeton);
    expect(vu.ids).toEqual([ouvert.documentId]);
    expect(vu.total).toBe(1);
    await attendreRefusSurTousLesCanaux(api, client, jeton, secret.documentId, secret.label);
    expect(await exporteCsv(client, jeton)).toContain(ouvert.label);

    // Contrôle : l'administrateur voit les deux (passe-droit FR-028).
    const admin = await visibles(api, jeton);
    expect(admin.ids.sort(croissant)).toEqual(
      [ouvert.documentId, secret.documentId].sort(croissant),
    );
    expect(admin.total).toBe(2);

    // Écran : même filtrage pour l'agent connecté.
    await loginAs(page, agent.username, agent.password);
    await ouvrirRecherche(page);
    await rechercherTexte(page, jeton);
    await expect(lignesResultat(page, jeton)).toHaveCount(1);
    await expect(lignesResultat(page, ouvert.label)).toHaveCount(1);
    await expect(page.getByText('1 document(s)', { exact: true })).toBeVisible();
  });

  test('ARC-20 l’habilitation de rang suffisant ouvre le document, un rang inférieur non', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const jeton = uniq('ARC20r');
    // Créés l'un après l'autre : l'API attribue au second un rang strictement supérieur.
    const interne = await creerConfidentialite(api, uniq('ARC20 Interne'));
    const secret = await creerConfidentialite(api, uniq('ARC20 Secret'));
    expect(secret.rank).toBeGreaterThan(interne.rank);

    const docInterne = await creerDocumentArchive(api, {
      label: `${jeton} interne`,
      confidentialiteId: interne.confidentialiteId,
    });
    const docSecret = await creerDocumentArchive(api, {
      label: `${jeton} secret`,
      confidentialiteId: secret.confidentialiteId,
    });

    const agent = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc20r'),
      menus: ['/search'],
    });
    const client = await apiAs(agent.username, agent.password);

    await habiliter(api, agent.userId, interne.confidentialiteId);
    const bas = await visibles(client, jeton);
    expect(bas.ids).toEqual([docInterne.documentId]);
    expect(bas.total).toBe(1);
    expect((await client.raw.get(`/documents/${docInterne.documentId}`)).status()).toBe(200);
    await attendreRefusSurTousLesCanaux(api, client, jeton, docSecret.documentId, docSecret.label);

    // Habilitation relevée : la règle est lue en base à chaque requête, sans reconnexion.
    await habiliter(api, agent.userId, secret.confidentialiteId);
    const haut = await visibles(client, jeton);
    expect(haut.ids.sort(croissant)).toEqual(
      [docInterne.documentId, docSecret.documentId].sort(croissant),
    );
    expect(haut.total).toBe(2);
    expect((await client.raw.get(`/documents/${docSecret.documentId}`)).status()).toBe(200);
    expect(await exporteCsv(client, jeton)).toContain(docSecret.label);
  });
});

test.describe('Accès P3 — droits explicites (refus par défaut)', () => {
  test('ARC-21 un document restreint par un droit nominatif n’est visible que de son bénéficiaire', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const jeton = uniq('ARC21');
    const restreint = await creerDocumentArchive(api, { label: `${jeton} restreint` });
    const ouvert = await creerDocumentArchive(api, { label: `${jeton} ouvert` });

    const beneficiaire = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc21a'),
      menus: ['/search'],
    });
    const tiers = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc21b'),
      menus: ['/search'],
    });
    const compte = await compteGroupeDe(api, apiAs, beneficiaire);
    await accorderDroitDocument(api, restreint.documentId, compte, NIVEAU.consultation);

    const clientBeneficiaire = await apiAs(beneficiaire.username, beneficiaire.password);
    const clientTiers = await apiAs(tiers.username, tiers.password);

    const vuBeneficiaire = await visibles(clientBeneficiaire, jeton);
    expect(vuBeneficiaire.ids.sort(croissant)).toEqual(
      [ouvert.documentId, restreint.documentId].sort(croissant),
    );
    expect((await clientBeneficiaire.raw.get(`/documents/${restreint.documentId}`)).status()).toBe(
      200,
    );
    expect(await exporteCsv(clientBeneficiaire, jeton)).toContain(restreint.label);

    const vuTiers = await visibles(clientTiers, jeton);
    expect(vuTiers.ids).toEqual([ouvert.documentId]);
    expect(vuTiers.total).toBe(1);
    await attendreRefusSurTousLesCanaux(
      api,
      clientTiers,
      jeton,
      restreint.documentId,
      restreint.label,
    );
  });

  test('ARC-21 un droit sur le TYPE restreint tous les documents de ce type au rôle bénéficiaire', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const jeton = uniq('ARC21t');
    const documentTypeId = await creerTypeDocument(api, uniq('ARC21 Type restreint'));
    const duType = await creerDocumentArchive(api, { label: `${jeton} du type`, documentTypeId });

    const beneficiaire = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc21ta'),
      menus: ['/search'],
    });
    const tiers = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc21tb'),
      menus: ['/search'],
    });
    expect(beneficiaire.roleId, 'deux rôles distincts').not.toBe(tiers.roleId);
    await api.post('/referentials/document-type-permissions', {
      documentTypeId,
      permissionLevelId: NIVEAU.consultation,
      roleId: beneficiaire.roleId,
    });

    const clientBeneficiaire = await apiAs(beneficiaire.username, beneficiaire.password);
    expect((await visibles(clientBeneficiaire, jeton)).ids).toEqual([duType.documentId]);
    expect((await clientBeneficiaire.raw.get(`/documents/${duType.documentId}`)).status()).toBe(
      200,
    );

    const clientTiers = await apiAs(tiers.username, tiers.password);
    expect((await visibles(clientTiers, jeton)).total).toBe(0);
    await attendreRefusSurTousLesCanaux(api, clientTiers, jeton, duType.documentId, duType.label);
  });

  test('ARC-21 un droit nominatif lève l’exigence de confidentialité pour son seul bénéficiaire', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const jeton = uniq('ARC21c');
    const niveau = await creerConfidentialite(api, uniq('ARC21 Secret'));
    const secret = await creerDocumentArchive(api, {
      label: `${jeton} secret`,
      confidentialiteId: niveau.confidentialiteId,
    });

    const beneficiaire = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc21ca'),
      menus: ['/search'],
    });
    const tiers = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc21cb'),
      menus: ['/search'],
    });
    await habiliter(api, beneficiaire.userId, null);
    await habiliter(api, tiers.userId, null);
    await accorderDroitDocument(
      api,
      secret.documentId,
      await compteGroupeDe(api, apiAs, beneficiaire),
    );

    const clientBeneficiaire = await apiAs(beneficiaire.username, beneficiaire.password);
    expect((await visibles(clientBeneficiaire, jeton)).ids).toEqual([secret.documentId]);
    expect((await clientBeneficiaire.raw.get(`/documents/${secret.documentId}`)).status()).toBe(
      200,
    );

    const clientTiers = await apiAs(tiers.username, tiers.password);
    await attendreRefusSurTousLesCanaux(api, clientTiers, jeton, secret.documentId, secret.label);
  });

  test('ARC-21 refus par défaut strict (FR-027) : un document sans aucun droit est invisible', async () => {
    // FR-027 / CA-P3-b / data-model « Règle d'habilitation P3 » : « en l'absence de tout droit, le
    // document est invisible ». Le code applique l'inverse depuis le 2026-09-08 (décision du
    // propriétaire du produit, commentée dans `permissionCondition` et `isVisibleByPermissions`) :
    // un document dont ni lui ni son type ne porte de droit en vigueur est visible de TOUS.
    // Test à écrire selon la réponse : utilisateur sans droit + document neuf sans droit →
    // absent (FR-027) ou présent (règle actuelle).
    test.fixme(
      true,
      'Question métier : FR-027 (invisible sans droit explicite) ou règle du 2026-09-08 (visible si ' +
        'aucun droit n’est posé) ? La spécification et le code divergent.',
    );
  });
});

test.describe('Accès P3 — refus par permission', () => {
  test('ARC-22 un utilisateur sans droit ne peut ni s’octroyer un droit ni lever une confidentialité', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // ANO-ARC-B-01 (corrigée par le lot GED, `assertCanOpen`) : gère les droits et la
    // confidentialité d'un document quiconque peut ouvrir sa fiche — et seulement lui. Pour un compte
    // qui ne le peut pas, les routes de la fiche répondent 404, comme pour une pièce inexistante.
    const jeton = uniq('ARC22');
    const niveau = await creerConfidentialite(api, uniq('ARC22 Secret'));
    const secret = await creerDocumentArchive(api, {
      label: `${jeton} secret`,
      confidentialiteId: niveau.confidentialiteId,
    });
    const restreint = await creerDocumentArchive(api, { label: `${jeton} restreint` });

    const beneficiaire = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc22a'),
      menus: ['/search'],
    });
    const intrus = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc22b'),
      menus: ['/search'],
    });
    await habiliter(api, intrus.userId, null);
    await accorderDroitDocument(
      api,
      restreint.documentId,
      await compteGroupeDe(api, apiAs, beneficiaire),
    );
    const compteIntrus = await compteGroupeDe(api, apiAs, intrus);
    const droits = (await api.get(`/documents/${restreint.documentId}/permissions`)) as Array<{
      documentPermissionId: number;
    }>;
    const droitBeneficiaire = droits[0]?.documentPermissionId;
    expect(droitBeneficiaire, 'droit du bénéficiaire').toBeDefined();

    const client = await apiAs(intrus.username, intrus.password);
    await attendreRefusSurTousLesCanaux(api, client, jeton, secret.documentId, secret.label);
    await attendreRefusSurTousLesCanaux(api, client, jeton, restreint.documentId, restreint.label);

    // Chaque tentative sur la fiche doit répondre 404 (la pièce « n'existe pas » pour lui). Jouées
    // l'une après l'autre ; `expect.soft` : toutes sont rapportées, même si la première passe à tort.
    const tentatives: Array<[string, () => Promise<{ status(): number }>]> = [
      [
        'POST /documents/:id/permissions (droit nominatif sur soi)',
        () =>
          client.raw.post(`/documents/${restreint.documentId}/permissions`, {
            userGroupId: compteIntrus,
            permissionLevelId: NIVEAU.archivistique,
          }),
      ],
      [
        'PUT /documents/:id/confidentialite (retrait du niveau)',
        () =>
          client.raw.put(`/documents/${secret.documentId}/confidentialite`, {
            confidentialiteId: null,
          }),
      ],
      [
        'DELETE /documents/:id/permissions/:pid (retrait du seul droit, qui rendrait la pièce publique)',
        () => client.raw.del(`/documents/${restreint.documentId}/permissions/${droitBeneficiaire}`),
      ],
      [
        'GET /documents/:id/permissions (liste des bénéficiaires d’une pièce invisible)',
        () => client.raw.get(`/documents/${restreint.documentId}/permissions`),
      ],
      [
        'GET /documents/:id/confidentialite (liste des habilités d’une pièce invisible)',
        () => client.raw.get(`/documents/${secret.documentId}/confidentialite`),
      ],
    ];
    for (const [route, appel] of tentatives) {
      const statut = (await appel()).status();
      expect.soft(statut, `${route} → HTTP ${statut}`).toBe(404);
    }

    // Quel qu'ait été le sort des tentatives, les deux pièces doivent rester hors de sa portée.
    await attendreRefusSurTousLesCanaux(api, client, jeton, secret.documentId, secret.label);
    await attendreRefusSurTousLesCanaux(api, client, jeton, restreint.documentId, restreint.label);
    const fiche = (await api.get(`/documents/${secret.documentId}`)) as {
      confidentialiteId: number | null;
    };
    expect(fiche.confidentialiteId).toBe(niveau.confidentialiteId);
  });

  test('ARC-22 l’octroi direct d’un droit sur un document (référentiel) est réservé à l’administrateur', async ({
    api,
    apiAs,
    uniq,
  }) => {
    // `POST /referentials/document-permissions` porte `@RequireAdmin` (lot socle) : un compte
    // ordinaire reçoit 403 et la pièce reste invisible.
    const jeton = uniq('ARC22R');
    const niveau = await creerConfidentialite(api, uniq('ARC22R Secret'));
    const secret = await creerDocumentArchive(api, {
      label: `${jeton} secret`,
      confidentialiteId: niveau.confidentialiteId,
    });
    const intrus = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc22r'),
      menus: ['/search'],
    });
    await habiliter(api, intrus.userId, null);
    const compteIntrus = await compteGroupeDe(api, apiAs, intrus);
    const client = await apiAs(intrus.username, intrus.password);
    const r = await client.raw.post('/referentials/document-permissions', {
      documentId: secret.documentId,
      userGroupId: compteIntrus,
      permissionLevelId: NIVEAU.archivistique,
    });
    expect(r.status()).toBe(403);
    await attendreRefusSurTousLesCanaux(api, client, jeton, secret.documentId, secret.label);
  });

  test('ARC-22 sans le menu « Recherche », l’entrée n’apparaît pas dans la navigation', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    // Contrôle positif : l'administrateur, sur /search, voit l'entrée dans la section ouverte.
    await ouvrirRecherche(page);
    await expect(page.getByRole('menuitem', { name: 'Recherche', exact: true })).toBeVisible();

    // L'utilisateur n'a que « Acquisition par lot », dans la même section « Docu-Archives ».
    const agent = await creerUtilisateurAvecMenus(api, {
      prefix: uniq('arc22m'),
      menus: ['/acquisition'],
    });
    await loginAs(page, agent.username, agent.password);
    await page.goto('/search');
    await expect(
      page.getByRole('menuitem', { name: 'Acquisition par lot', exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Recherche', exact: true })).toHaveCount(0);
  });

  test('ARC-22 sans le menu « Recherche », l’écran et les routes de recherche/export sont refusés', async () => {
    // Constat : `/search` n'a pas de garde de route (AuthShell ne filtre que la barre latérale) et
    // `POST /documents/search` / `POST /documents/export` n'ont pas de `@RequireMenu` : un compte
    // sans le menu ouvre l'écran par son URL, cherche et exporte. Or la règle maison est « accès au
    // menu ⟹ accès aux données ». Mais `/documents/search` sert AUSSI les écrans Courriers
    // (`lib/courriers.ts`) et Espaces (`lib/espaces.ts`) : un `@RequireMenu('/search')` seul les
    // casserait. Test à écrire selon la réponse : écran « accès refusé » + 403 sur l'export (et sur
    // la recherche avec la liste des menus qui l'autorisent).
    test.fixme(
      true,
      'Question métier : quels menus ouvrent POST /documents/search et /documents/export ' +
        '(/search seul, ou aussi les menus Courriers et Espaces qui s’en servent) ?',
    );
  });
});
