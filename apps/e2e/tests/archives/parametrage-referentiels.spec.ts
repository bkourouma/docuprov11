/**
 * Paramétrage Archives — référentiels du cycle de vie (tâche T4, lot 2) :
 * « Modes de destruction », « Sorts finaux », « Motifs de prêt » (patron `BulkRefPage`).
 *
 * Les trois écrans sont en saisie UNITAIRE (`singleEntry`) : la création EN MASSE n'existe que par
 * l'API (`POST { labels }`), qui reste le contrat commun — elle est donc testée par l'API.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import { creerTypeDocument } from './_helpers/documents';
import {
  MESSAGE_REFUS,
  REFERENTIELS,
  SETTINGS,
  apresAppel,
  boutonAntd,
  carte,
  champ,
  confirmer,
  creerDansReferentiel,
  creerElementReferentiel,
  cycleDuType,
  editerEnPlace,
  enregistrerCycle,
  ligneDansTable,
  listerReferentiel,
  ouvrirEcran,
  renommerEnPlace,
  type Referentiel,
} from './_helpers/parametrage';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

const TOUS: Referentiel[] = [REFERENTIELS.modes, REFERENTIELS.sorts, REFERENTIELS.motifs];

async function ouvrir(page: Page, ref: Referentiel): Promise<void> {
  await ouvrirEcran(page, ref.ecran, ref.titre, `${SETTINGS}/${ref.chemin}`);
}

for (const ref of TOUS) {
  test.describe(`Paramétrage Archives — ${ref.titre}`, () => {
    test(`ARC-35 crée un élément par l'écran et signale un doublon (${ref.titre})`, async ({
      page,
      api,
      uniq,
    }) => {
      const label = `${uniq('ARC-35')} élément`;
      await ouvrir(page, ref);
      const formulaire = carte(page, ref.titreFormulaire);
      const saisie = champ(formulaire, 'Libellé');
      const ajouter = boutonAntd(formulaire, 'Ajouter');

      // Libellé vide (ou blanc) : rien ne part, le bouton reste inactif.
      await expect(ajouter).toBeDisabled();
      await saisie.fill('   ');
      await expect(ajouter).toBeDisabled();

      await saisie.fill(label);
      const creation = await apresAppel(page, 'POST', `${SETTINGS}/${ref.chemin}`, () =>
        ajouter.click(),
      );
      expect(creation.status()).toBe(201);
      expect(creation.request().postDataJSON()).toEqual({ labels: [label] });
      await expect(page.getByText(`1 ${ref.nom} créé`, { exact: true })).toBeVisible();
      await expect(saisie).toHaveValue('');
      await expect(await ligneDansTable(carte(page, ref.titreTableau), label)).toHaveCount(1);

      // Même libellé, casse et espaces changés : ignoré, signalé, aucune seconde ligne.
      await saisie.fill(`  ${label.toUpperCase()}  `);
      const doublon = await apresAppel(page, 'POST', `${SETTINGS}/${ref.chemin}`, () =>
        ajouter.click(),
      );
      expect(doublon.status()).toBe(201);
      expect(await doublon.json()).toEqual({ created: 0, skipped: [label.toUpperCase()] });
      await expect(page.getByText('1 ignoré(s) (doublon)', { exact: true })).toBeVisible();
      const actifs = (await listerReferentiel(api, ref)).filter(
        (r) => r.label.toLowerCase() === label.toLowerCase(),
      );
      expect(actifs).toHaveLength(1);
    });

    test(`ARC-36 crée en masse par l'API : doublons ignorés et signalés, saisies vides refusées (${ref.titre})`, async ({
      api,
      uniq,
    }) => {
      const u = uniq('ARC-36');
      const existant = await creerElementReferentiel(api, ref, `${u} existant`);

      // Clé d'unicité = libellé sans AUCUN espace, en minuscules (`labelDedupKey`) ; libellé
      // stocké = bordures retirées, espaces internes compactés (`normaliseLabel`).
      const r = await creerDansReferentiel(api, ref, [
        `${u} un`,
        `  ${u}   deux  `,
        `${u.toUpperCase()} UN`, // doublon interne au lot (casse)
        `${u}existant`, // doublon de l'existant (espaces)
      ]);
      expect(r.created).toBe(2);
      expect(r.skipped).toEqual([`${u.toUpperCase()} UN`, `${u}existant`]);

      const lignes = (await listerReferentiel(api, ref)).filter((x) => x.label.startsWith(u));
      // Libellés stockés débarrassés des espaces de bordure (`normaliseLabel`).
      expect(lignes.map((x) => x.label).sort()).toEqual(
        [existant.label, `${u} deux`, `${u} un`].sort(),
      );

      // Erreurs de saisie : liste vide, libellé blanc, corps absent → 400, rien de créé.
      for (const corps of [{ labels: [] }, { labels: ['   '] }, { labels: [`${u} ok`, ''] }, {}]) {
        const refus = await api.raw.post(`${SETTINGS}/${ref.chemin}`, corps);
        expect(refus.status(), JSON.stringify(corps)).toBe(400);
      }
      expect((await listerReferentiel(api, ref)).some((x) => x.label === `${u} ok`)).toBe(false);
    });

    test(`ARC-37 renomme en place et refuse un libellé déjà porté (${ref.titre})`, async ({
      page,
      api,
      uniq,
    }) => {
      const u = uniq('ARC-37');
      const a = await creerElementReferentiel(api, ref, `${u} a`);
      const b = await creerElementReferentiel(api, ref, `${u} b`);
      await ouvrir(page, ref);
      const tableau = page.locator('.ant-table-wrapper').first();

      // Renommage nominal.
      let ligne = await ligneDansTable(tableau, a.label);
      const renomme = await renommerEnPlace(
        page,
        ligne,
        a.label,
        `${u} a renommé`,
        `${SETTINGS}/${ref.chemin}/${a.id}`,
      );
      expect(renomme.status()).toBe(200);
      await expect(page.getByText('Modifié', { exact: true })).toBeVisible();
      expect((await listerReferentiel(api, ref)).find((x) => x.id === a.id)?.label).toBe(
        `${u} a renommé`,
      );

      // Doublon (casse différente) : 409, message de l'API affiché, libellé inchangé.
      ligne = await ligneDansTable(tableau, `${u} a renommé`);
      const conflit = await renommerEnPlace(
        page,
        ligne,
        `${u} a renommé`,
        b.label.toUpperCase(),
        `${SETTINGS}/${ref.chemin}/${a.id}`,
      );
      expect(conflit.status()).toBe(409);
      await expect(page.getByText(ref.messageDoublon, { exact: true })).toBeVisible();
      expect((await listerReferentiel(api, ref)).find((x) => x.id === a.id)?.label).toBe(
        `${u} a renommé`,
      );

      // Libellé vidé : la cellule restaure l'ancien libellé SANS appel au serveur.
      ligne = await ligneDansTable(tableau, `${u} a renommé`);
      let patchs = 0;
      page.on('request', (req) => {
        if (req.method() === 'PATCH' && req.url().includes(`/${ref.chemin}/`)) patchs += 1;
      });
      const saisie = await editerEnPlace(page, ligne, `${u} a renommé`);
      await saisie.fill('');
      await saisie.press('Enter');
      await expect(saisie).toHaveCount(0);
      await expect(
        ligne.getByRole('button', { name: `${u} a renommé`, exact: true }),
      ).toBeVisible();
      expect(patchs).toBe(0);

      // Par l'API : libellé blanc 400, identifiant inconnu 404.
      expect(
        (await api.raw.patch(`${SETTINGS}/${ref.chemin}/${a.id}`, { label: '  ' })).status(),
      ).toBe(400);
      expect(
        (await api.raw.patch(`${SETTINGS}/${ref.chemin}/2147483000`, { label: `${u} x` })).status(),
      ).toBe(404);
    });

    test(`ARC-38 désactive un élément, seul ou en lot, sans effacer ses usages (${ref.titre})`, async ({
      page,
      api,
      uniq,
    }) => {
      const u = uniq('ARC-38');
      const seul = await creerElementReferentiel(api, ref, `${u} seul`);
      const lot1 = await creerElementReferentiel(api, ref, `${u} lot 1`);
      const lot2 = await creerElementReferentiel(api, ref, `${u} lot 2`);

      // Élément UTILISÉ : un sort final / mode de destruction cité par une règle de cycle de vie.
      // (Les motifs de prêt sont cités par les communications — scénario de T3.)
      const utilise = ref.chemin !== 'lending-motives';
      let typeId: number | null = null;
      if (utilise) {
        typeId = await creerTypeDocument(api, `${u} type`);
        await enregistrerCycle(api, {
          documentTypeId: typeId,
          usefulnessLifespan: 12,
          complianceLifespan: 24,
          ...(ref.chemin === 'final-fates'
            ? { finalFateId: seul.id }
            : { destructionModeId: seul.id }),
        });
      }

      await ouvrir(page, ref);
      const tableau = page.locator('.ant-table-wrapper').first();

      // Unitaire : confirmation qui énonce la conséquence, puis disparition de la liste.
      const ligne = await ligneDansTable(tableau, seul.label);
      await ligne
        .getByRole('button', { name: `Désactiver ${ref.demonstratif}`, exact: true })
        .click();
      await expect(
        page.getByText(
          'Le libellé reste lisible sur les enregistrements existants, mais il ne sera plus proposé dans les listes de choix.',
        ),
      ).toBeVisible();
      const desactivation = await apresAppel(page, 'DELETE', `${SETTINGS}/${ref.chemin}`, () =>
        confirmer(page, 'Désactiver'),
      );
      expect(desactivation.status()).toBe(200);
      expect(desactivation.request().postDataJSON()).toEqual({ ids: [seul.id] });
      expect(await desactivation.json()).toEqual({ deactivated: 1 });
      await expect(page.getByText('Élément désactivé', { exact: true })).toBeVisible();
      expect((await listerReferentiel(api, ref)).some((x) => x.id === seul.id)).toBe(false);

      if (utilise && typeId != null) {
        // La règle qui le cite garde son libellé (désactivation, pas suppression).
        const cycle = await cycleDuType(api, typeId);
        const cite = ref.chemin === 'final-fates' ? cycle?.finalFate : cycle?.destructionMode;
        expect(cite?.label).toBe(seul.label);
      }

      // En lot : deux cases cochées, une confirmation au pluriel.
      await (await ligneDansTable(tableau, lot1.label)).getByRole('checkbox').check();
      await (await ligneDansTable(tableau, lot2.label)).getByRole('checkbox').check();
      await expect(page.getByText('2 sélectionné(s)', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Désactiver la sélection' }).click();
      await expect(page.getByText(`Désactiver ces 2 ${ref.pluriel} ?`)).toBeVisible();
      const lot = await apresAppel(page, 'DELETE', `${SETTINGS}/${ref.chemin}`, () =>
        confirmer(page, 'Désactiver'),
      );
      expect(lot.status()).toBe(200);
      expect(
        ((lot.request().postDataJSON() as { ids: number[] }).ids ?? [])
          .slice()
          .sort((x, y) => x - y),
      ).toEqual([lot1.id, lot2.id].sort((x, y) => x - y));
      await expect(page.getByText('2 éléments désactivés', { exact: true })).toBeVisible();
      const restants = await listerReferentiel(api, ref);
      expect(restants.some((x) => x.id === lot1.id || x.id === lot2.id)).toBe(false);

      // Libellé libéré : il peut être recréé (unicité parmi les ACTIFS seulement).
      expect(await creerDansReferentiel(api, ref, [seul.label])).toEqual({
        created: 1,
        skipped: [],
      });

      // Corps invalide : 400.
      expect((await api.raw.del(`${SETTINGS}/${ref.chemin}`)).status()).toBe(400);
    });

    test(`ARC-39 refuse l'écriture sans le menu de l'écran, l'autorise avec (${ref.titre})`, async ({
      page,
      api,
      apiAs,
      loginAs,
      uniq,
    }) => {
      const u = uniq('ARC-39');
      const cible = await creerElementReferentiel(api, ref, `${u} cible`);
      const autre = TOUS.find((r) => r.chemin !== ref.chemin)!;
      const sans = await creerUtilisateurAvecMenus(api, {
        prefix: `${u}-sans`,
        menus: ['/search'],
      });
      const avec = await creerUtilisateurAvecMenus(api, {
        prefix: `${u}-avec`,
        menus: [ref.ecran],
      });

      // API sans le menu : lecture ouverte (lookup de formulaire, voulu par le contrôleur),
      // toute écriture refusée — le garde passe AVANT la validation du corps.
      const clientSans = await apiAs(sans.username, sans.password);
      expect((await clientSans.raw.get(`${SETTINGS}/${ref.chemin}`)).status()).toBe(200);
      expect(
        (
          await clientSans.raw.post(`${SETTINGS}/${ref.chemin}`, { labels: [`${u} intrus`] })
        ).status(),
      ).toBe(403);
      expect(
        (
          await clientSans.raw.patch(`${SETTINGS}/${ref.chemin}/${cible.id}`, { label: `${u} x` })
        ).status(),
      ).toBe(403);
      expect((await clientSans.raw.del(`${SETTINGS}/${ref.chemin}`)).status()).toBe(403);

      // API avec le menu : écriture permise sur CE référentiel, pas sur les autres.
      const clientAvec = await apiAs(avec.username, avec.password);
      const cree = await clientAvec.raw.post(`${SETTINGS}/${ref.chemin}`, {
        labels: [`${u} permis`],
      });
      expect(cree.status()).toBe(201);
      expect(await cree.json()).toEqual({ created: 1, skipped: [] });
      expect(
        (
          await clientAvec.raw.patch(`${SETTINGS}/${ref.chemin}/${cible.id}`, {
            label: `${u} cible renommée`,
          })
        ).status(),
      ).toBe(200);
      expect(
        (
          await clientAvec.raw.post(`${SETTINGS}/${autre.chemin}`, { labels: [`${u} ailleurs`] })
        ).status(),
      ).toBe(403);

      // Écran sans le menu : l'ajout part, est refusé et expliqué ; rien n'est créé.
      await loginAs(page, sans.username, sans.password);
      await ouvrir(page, ref);
      const formulaire = carte(page, ref.titreFormulaire);
      await champ(formulaire, 'Libellé').fill(`${u} par écran`);
      const refus = await apresAppel(page, 'POST', `${SETTINGS}/${ref.chemin}`, () =>
        boutonAntd(formulaire, 'Ajouter').click(),
      );
      expect(refus.status()).toBe(403);
      await expect(page.getByText(MESSAGE_REFUS, { exact: true })).toBeVisible();
      expect((await listerReferentiel(api, ref)).some((x) => x.label === `${u} par écran`)).toBe(
        false,
      );
      expect(page.url()).not.toContain('/login');
    });
  });
}
