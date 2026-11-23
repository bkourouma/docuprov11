/**
 * DUA expirés et épuration — Docu-Archives §1 et §2 : liste des documents dont la durée d'utilité
 * administrative est atteinte (fenêtre d'anticipation, recherche), épuration confirmée, écran
 * « Documents épurés ». Scénarios ARC-29, ARC-30, ARC-33 et ARC-34.
 *
 * Une DUA échue est préparée par l'API : cycle de vie PROPRE au document (dates), qui l'emporte
 * sur la règle de son type. Les documents de test n'ont pas de type, donc aucune règle de type ne
 * les fait entrer dans la liste à notre insu.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { compteGroupeDe } from './_helpers/documents';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import {
  INVITE_CONFORMITE,
  MENUS,
  REFUS_MENU,
  attendreListe,
  creerMotifPret,
  creerPret,
  documentsCommunicables,
  dossierAvecDocuments,
  echus,
  epures,
  jourFr,
  jourIso,
  poserDua,
  rechercherDansListe,
} from './_helpers/archives-data';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

/** Ouvre « DUA expirés » et y filtre sur `texte`. */
async function ouvrirDuaExpirees(page: Page, texte: string) {
  await page.goto('/archives/dua-expirees');
  await expect(page.getByRole('heading', { name: 'DUA expirés' })).toBeVisible();
  await rechercherDansListe(page, INVITE_CONFORMITE, '/archives/dua-expired', texte);
}

const ligne = (page: Page, texte: string) => page.getByRole('row').filter({ hasText: texte });

test.describe('DUA expirés', () => {
  test('ARC-29 liste les documents échus et anticipe l’échéance selon l’horizon choisi', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-29');
    const { documents } = await dossierAvecDocuments(api, u, 3);
    const [echu, prochain, sansRegle] = documents as [
      (typeof documents)[0],
      (typeof documents)[0],
      (typeof documents)[0],
    ];
    await poserDua(api, echu.documentId, -2);
    // Dans deux mois : hors de l'échu strict, dans la fenêtre « 3 mois ».
    await poserDua(api, prochain.documentId, 60);

    // Fond : la coupure et le périmètre de chaque horizon.
    expect((await echus(api, u, 0)).map((r) => r.documentId)).toEqual([echu.documentId]);
    expect((await echus(api, u, 3)).map((r) => r.documentId)).toEqual([
      echu.documentId,
      prochain.documentId,
    ]);
    expect((await echus(api, u, 120)).map((r) => r.documentId)).not.toContain(sansRegle.documentId);

    // Écran, horizon par défaut « Échu aujourd’hui ».
    await page.goto('/archives/dua-expirees');
    await expect(page.getByRole('heading', { name: 'DUA expirés' })).toBeVisible();
    const filtree = attendreListe(page, '/archives/dua-expired', u);
    const champ = page.getByPlaceholder(INVITE_CONFORMITE);
    await champ.fill(u);
    await champ.press('Enter');
    const reponse = await filtree;
    expect(reponse.status()).toBe(200);
    const { cutoff } = (await reponse.json()) as { cutoff: string };
    expect(cutoff).toBe(jourIso(0));
    await expect(page.getByText(`Échéance au plus tard le ${jourFr(cutoff)}`)).toBeVisible();
    await expect(ligne(page, echu.label)).toHaveCount(1);
    await expect(ligne(page, echu.label)).toContainText(jourFr(jourIso(-2)));
    await expect(ligne(page, prochain.label)).toHaveCount(0);
    await expect(ligne(page, sansRegle.label)).toHaveCount(0);

    // Horizon « 3 mois » : la recherche est conservée, le document à venir apparaît.
    const elargie = page.waitForResponse((r) => {
      const url = new URL(r.url());
      return (
        url.pathname.endsWith('/api/archives/dua-expired') &&
        url.searchParams.get('monthsAhead') === '3' &&
        url.searchParams.get('search') === u
      );
    });
    await page.locator('.ant-select').filter({ hasText: 'Échu aujourd’hui' }).click();
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      .getByTitle('Échu dans les 3 mois', { exact: true })
      .click();
    expect((await elargie).status()).toBe(200);
    await expect(ligne(page, prochain.label)).toHaveCount(1);
    await expect(ligne(page, prochain.label)).toContainText(jourFr(jourIso(60)));
    await expect(ligne(page, echu.label)).toHaveCount(1);
    await expect(ligne(page, sansRegle.label)).toHaveCount(0);
    await expect(page.getByText('2 document(s)', { exact: true })).toBeVisible();

    // Recherche sans résultat : état vide explicite.
    await rechercherDansListe(page, INVITE_CONFORMITE, '/archives/dua-expired', `${u}-absent`);
    await expect(page.getByText('Aucun document échu sur cette période')).toBeVisible();
  });

  test('ARC-30 épure à l’écran après confirmation ; le document rejoint « Documents épurés »', async ({
    page,
    api,
    apiAs,
    uniq,
  }) => {
    const u = uniq('ARC-30');
    const { dossierId, documents } = await dossierAvecDocuments(api, u, 3);
    const [aEpurer, restant, prete] = documents as [
      (typeof documents)[0],
      (typeof documents)[0],
      (typeof documents)[0],
    ];
    for (const d of documents) await poserDua(api, d.documentId, -3);
    // Le troisième est encore communiqué : son épuration sera refusée.
    const motif = await creerMotifPret(api, `${u} motif`);
    const emprunteur = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-emp`,
      menus: [MENUS.mesCommuniques],
    });
    await creerPret(api, {
      documentIds: [prete.documentId],
      userGroupId: await compteGroupeDe(api, apiAs, emprunteur),
      lendingMotiveId: motif.lendingMotiveId,
    });

    await ouvrirDuaExpirees(page, u);
    await expect(page.getByRole('row').filter({ hasText: u })).toHaveCount(3);

    await test.step('annuler la confirmation n’épure rien', async () => {
      await ligne(page, aEpurer.label).getByRole('checkbox').check();
      await expect(page.getByText('1 document(s) sélectionné(s)')).toBeVisible();
      await page.getByRole('button', { name: 'Épurer la sélection' }).click();
      await expect(page.getByText('Déclarer épurés ces 1 document(s) ?')).toBeVisible();
      await page.getByRole('button', { name: 'Annuler' }).click();
      await expect(ligne(page, aEpurer.label)).toHaveCount(1);
      expect(await epures(api, u)).toEqual([]);
    });

    await test.step('épuration confirmée, le document prêté est signalé et conservé', async () => {
      await ligne(page, prete.label).getByRole('checkbox').check();
      await expect(page.getByText('2 document(s) sélectionné(s)')).toBeVisible();
      const purge = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname.endsWith('/api/archives/dua-expired/purge'),
      );
      await page.getByRole('button', { name: 'Épurer la sélection' }).click();
      await page.getByRole('button', { name: 'Épurer', exact: true }).click();
      const reponse = await purge;
      expect(reponse.status()).toBe(200);
      expect(
        (reponse.request().postDataJSON() as { documentIds: number[] }).documentIds.sort(),
      ).toEqual([aEpurer.documentId, prete.documentId].sort());
      await expect(
        page.getByText(
          `1 document(s) épuré(s). Non épuré(s), encore communiqué(s) : ${prete.label}`,
        ),
      ).toBeVisible();
      await expect(ligne(page, aEpurer.label)).toHaveCount(0);
      await expect(ligne(page, prete.label)).toHaveCount(1);
      await expect(ligne(page, restant.label)).toHaveCount(1);
      // La barre de sélection disparaît avec la sélection.
      await expect(page.getByRole('button', { name: 'Épurer la sélection' })).toHaveCount(0);
    });

    await test.step('« Documents épurés » le montre, en consultation seule', async () => {
      await page.goto('/archives/documents-epures');
      await expect(page.getByRole('heading', { name: 'Documents épurés' })).toBeVisible();
      await rechercherDansListe(page, INVITE_CONFORMITE, '/archives/purged', u);
      await expect(ligne(page, aEpurer.label)).toHaveCount(1);
      await expect(ligne(page, aEpurer.label)).toContainText(jourFr(jourIso(-3)));
      await expect(ligne(page, restant.label)).toHaveCount(0);
      await expect(ligne(page, prete.label)).toHaveCount(0);
      await expect(page.getByRole('checkbox')).toHaveCount(0);
    });

    // Fond : états, sortie de la liste des échus, plus communicable, épuration idempotente.
    expect((await epures(api, u)).map((r) => r.documentId)).toEqual([aEpurer.documentId]);
    expect((await echus(api, u)).map((r) => r.documentId).sort()).toEqual(
      [restant.documentId, prete.documentId].sort(),
    );
    expect((await documentsCommunicables(api, dossierId)).map((d) => d.documentId)).toEqual([
      restant.documentId,
    ]);
    expect(
      await api.post('/archives/dua-expired/purge', { documentIds: [aEpurer.documentId] }),
    ).toEqual({ purged: 0, blocked: [] });
    const vide = await api.raw.post('/archives/dua-expired/purge', { documentIds: [] });
    expect(vide.status()).toBe(400);
    expect(await vide.text()).toContain('Aucun document sélectionné');
  });

  test('ARC-30 l’API refuse en bloc d’épurer un document dont la DUA n’est pas échue', async ({
    page,
    api,
    uniq,
  }) => {
    // ANO-ARC-T3-06 (corrigée) : `POST /archives/dua-expired/purge` épurait TOUT identifiant reçu,
    // sans revérifier l'échéance. Décision (option prudente) : la DUA de chaque document est
    // revérifiée par la règle de « DUA expirés » sans anticipation ; sinon 409 qui nomme les
    // documents non échus, et RIEN n'est épuré.
    const u = uniq('ARC-30b');
    const { documents } = await dossierAvecDocuments(api, u, 4);
    const [echu, nonEchu, sansRegle, echuAujourdhui] = documents as [
      (typeof documents)[0],
      (typeof documents)[0],
      (typeof documents)[0],
      (typeof documents)[0],
    ];
    await poserDua(api, echu.documentId, -2);
    await poserDua(api, nonEchu.documentId, 30);
    // Borne incluse : une DUA qui tombe aujourd'hui est échue aujourd'hui.
    await poserDua(api, echuAujourdhui.documentId, 0);
    const purge = (documentIds: number[]) =>
      api.raw.post('/archives/dua-expired/purge', { documentIds });
    const idsEchus = [echu.documentId, echuAujourdhui.documentId].sort();

    // Fond : le non échu est dans la fenêtre « 3 mois », pas dans l'échu strict.
    expect((await echus(api, u, 0)).map((r) => r.documentId).sort()).toEqual(idsEchus);
    expect((await echus(api, u, 3)).map((r) => r.documentId)).toContain(nonEchu.documentId);

    await test.step('refus en bloc qui nomme les non échus, sans rien épurer', async () => {
      const refus = await purge([echu.documentId, nonEchu.documentId, sansRegle.documentId]);
      expect(refus.status()).toBe(409);
      const corps = await refus.text();
      expect(corps).toContain(
        `Document(s) dont la DUA n'est pas échue : ${nonEchu.label}, ${sansRegle.label}.`,
      );
      expect(corps).toContain("Aucun document n'a été épuré.");
      expect(corps).not.toContain(echu.label);
      // Le document échu de la même demande n'a pas été épuré pour autant.
      expect(await epures(api, u)).toEqual([]);
      expect((await echus(api, u, 0)).map((r) => r.documentId).sort()).toEqual(idsEchus);
    });

    await test.step('un identifiant inexistant est refusé (404), sans rien épurer', async () => {
      const inconnu = await purge([echu.documentId, 2_000_000_000]);
      expect(inconnu.status()).toBe(404);
      expect(await inconnu.text()).toContain('Document(s) introuvable(s) : 2000000000');
      expect(await epures(api, u)).toEqual([]);
    });

    await test.step('à l’écran, la fenêtre « 3 mois » ne permet pas d’épurer par avance', async () => {
      await ouvrirDuaExpirees(page, u);
      const elargie = page.waitForResponse((r) => {
        const url = new URL(r.url());
        return (
          url.pathname.endsWith('/api/archives/dua-expired') &&
          url.searchParams.get('monthsAhead') === '3' &&
          url.searchParams.get('search') === u
        );
      });
      await page.locator('.ant-select').filter({ hasText: 'Échu aujourd’hui' }).click();
      await page
        .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
        .getByTitle('Échu dans les 3 mois', { exact: true })
        .click();
      expect((await elargie).status()).toBe(200);
      await ligne(page, nonEchu.label).getByRole('checkbox').check();
      await expect(page.getByText('1 document(s) sélectionné(s)')).toBeVisible();
      const envoi = page.waitForResponse(
        (r) =>
          r.request().method() === 'POST' &&
          new URL(r.url()).pathname.endsWith('/api/archives/dua-expired/purge'),
      );
      await page.getByRole('button', { name: 'Épurer la sélection' }).click();
      await page.getByRole('button', { name: 'Épurer', exact: true }).click();
      expect((await envoi).status()).toBe(409);
      await expect(
        page.getByText(`Document(s) dont la DUA n'est pas échue : ${nonEchu.label}.`),
      ).toBeVisible();
      await expect(ligne(page, nonEchu.label)).toHaveCount(1);
      expect(await epures(api, u)).toEqual([]);
    });

    await test.step('contrôle positif : les échus (dont l’échéance du jour) sont épurés', async () => {
      expect(await api.post('/archives/dua-expired/purge', { documentIds: idsEchus })).toEqual({
        purged: 2,
        blocked: [],
      });
      expect((await epures(api, u)).map((r) => r.documentId).sort()).toEqual(idsEchus);
      // Toujours refusé pour le non échu, seul.
      expect((await purge([nonEchu.documentId])).status()).toBe(409);
      expect((await epures(api, u)).map((r) => r.documentId).sort()).toEqual(idsEchus);
    });
  });
});

test.describe('DUA et épuration — refus par permission', () => {
  const ECRANS = [
    {
      menu: MENUS.duaExpirees,
      url: '/archives/dua-expirees',
      route: '/archives/dua-expired',
      nav: 'DUA expirés',
    },
    {
      menu: MENUS.epures,
      url: '/archives/documents-epures',
      route: '/archives/purged',
      nav: 'Documents épurés',
    },
  ] as const;

  for (const ecran of ECRANS) {
    test(`ARC-33 sans le menu, l’écran ${ecran.url} et sa liste sont refusés`, async ({
      page,
      api,
      apiAs,
      loginAs,
      uniq,
    }) => {
      const u = uniq('ARC-33');
      const sans = await creerUtilisateurAvecMenus(api, {
        prefix: `${u}-sans`,
        menus: [MENUS.autre],
      });
      const avec = await creerUtilisateurAvecMenus(api, {
        prefix: `${u}-avec`,
        menus: [ecran.menu],
      });
      expect(
        (await (await apiAs(sans.username, sans.password)).raw.get(ecran.route)).status(),
      ).toBe(403);
      expect(
        (await (await apiAs(avec.username, avec.password)).raw.get(ecran.route)).status(),
      ).toBe(200);

      await loginAs(page, sans.username, sans.password);
      const liste = attendreListe(page, ecran.route);
      await page.goto(ecran.url);
      expect((await liste).status()).toBe(403);
      await expect(page.getByText(REFUS_MENU).first()).toBeVisible();
      await expect(page.getByRole('menuitem', { name: ecran.nav, exact: true })).toHaveCount(0);
    });
  }

  test('ARC-34 l’épuration est refusée sans le menu « DUA expirés », même avec « Documents épurés »', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-34');
    const {
      documents: [doc],
    } = await dossierAvecDocuments(api, u, 1);
    await poserDua(api, doc!.documentId, -2);
    const consultant = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-cons`,
      menus: [MENUS.epures],
    });
    const archiviste = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-arch`,
      menus: [MENUS.duaExpirees],
    });

    const clientConsultant = await apiAs(consultant.username, consultant.password);
    expect((await clientConsultant.raw.get('/archives/purged')).status()).toBe(200);
    expect((await clientConsultant.raw.get('/archives/dua-expired')).status()).toBe(403);
    const refus = await clientConsultant.raw.post('/archives/dua-expired/purge', {
      documentIds: [doc!.documentId],
    });
    expect(refus.status()).toBe(403);
    // Rien n'a changé : toujours échu, pas épuré.
    expect((await echus(api, u)).map((r) => r.documentId)).toEqual([doc!.documentId]);
    expect(await epures(api, u)).toEqual([]);

    // Écran : l'URL ouverte à la main ne montre aucun document ni aucune action d'épuration.
    await loginAs(page, consultant.username, consultant.password);
    await page.goto('/archives/dua-expirees');
    await expect(page.getByText(REFUS_MENU).first()).toBeVisible();
    await expect(page.getByText('Aucun document échu sur cette période')).toBeVisible();
    await expect(ligne(page, doc!.label)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Épurer la sélection' })).toHaveCount(0);

    // Contrôle positif : le menu « DUA expirés » suffit à épurer, sans être administrateur.
    const clientArchiviste = await apiAs(archiviste.username, archiviste.password);
    expect(
      await clientArchiviste.post('/archives/dua-expired/purge', {
        documentIds: [doc!.documentId],
      }),
    ).toEqual({ purged: 1, blocked: [] });
    expect((await epures(api, u)).map((r) => r.documentId)).toEqual([doc!.documentId]);
  });
});
