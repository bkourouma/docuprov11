/**
 * Paramétrage Archives — métadonnées dynamiques (tâche T4, lot 2) :
 * « Gestion des métadonnées » (§8), « Éléments des listes » (§9),
 * « Métadonnées par type de document » (§7), et leur usage aval : les champs du formulaire
 * dynamique d'indexation (`GET /archives/settings/metadata-document-types/:id/fields`).
 */
import { test, expect } from '../../fixtures';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import { creerTypeDocument } from './_helpers/documents';
import {
  MESSAGE_REFUS,
  SETTINGS,
  TYPE_SAISIE,
  apresAppel,
  boutonAntd,
  associationsDuType,
  associer,
  carte,
  champ,
  champsDuType,
  choisirAvecRecherche,
  choisirSansRecherche,
  confirmer,
  creerMetaDonnee,
  creerValeurs,
  ligneDansTable,
  listeOuverte,
  listerMetaDonnees,
  listerValeurs,
  ouvrirEcran,
  ouvrirSelect,
  renommerEnPlace,
  supprimerParApi,
  valeurAffichee,
} from './_helpers/parametrage';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

const ECRAN_META = '/admin/archives/metadonnees';
const ECRAN_VALEURS = '/admin/archives/elements-listes';
const ECRAN_ASSOC = '/admin/archives/metadonnees-types';

test.describe('Paramétrage Archives — Gestion des métadonnées', () => {
  test('ARC-40 crée, retype, renomme et désactive une métadonnée ; refuse les saisies invalides', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-40');
    const label = `${u} statut`;
    await ouvrirEcran(page, ECRAN_META, 'Gestion des métadonnées', `${SETTINGS}/metadatas`);
    const formulaire = carte(page, 'Nouvelle métadonnée');
    const ajouter = boutonAntd(formulaire, 'Ajouter');
    await expect(ajouter).toBeDisabled();

    // Création « Liste de valeurs » (le type par défaut est « Texte »).
    await champ(formulaire, 'Libellé').fill(label);
    await choisirSansRecherche(
      page,
      champ(formulaire, 'Type de saisie'),
      TYPE_SAISIE.liste.libelle,
    );
    const creation = await apresAppel(page, 'POST', `${SETTINGS}/metadatas`, () => ajouter.click());
    expect(creation.status()).toBe(201);
    expect(creation.request().postDataJSON()).toEqual({
      metaDatas: [{ label, dataType: TYPE_SAISIE.liste.valeur }],
    });
    await expect(page.getByText('1 métadonnée créée', { exact: true })).toBeVisible();

    const tableau = carte(page, 'Métadonnées');
    let ligne = await ligneDansTable(tableau, label);
    await expect(ligne.getByText(TYPE_SAISIE.liste.libelle, { exact: true })).toBeVisible();
    // Une liste renvoie vers la saisie de ses valeurs.
    await expect(
      ligne.getByRole('button', { name: 'Gérer les valeurs de cette liste' }),
    ).toBeVisible();
    const meta = (await listerMetaDonnees(api)).find((m) => m.label === label)!;
    expect(meta).toMatchObject({ dataType: TYPE_SAISIE.liste.valeur, listItemCount: 0 });

    // Doublon (casse, espaces) : ignoré et signalé.
    await champ(formulaire, 'Libellé').fill(` ${label.toUpperCase()} `);
    const doublon = await apresAppel(page, 'POST', `${SETTINGS}/metadatas`, () => ajouter.click());
    expect(await doublon.json()).toEqual({ created: 0, skipped: [label.toUpperCase()] });
    await expect(page.getByText('1 ignoré(s) (doublon)', { exact: true })).toBeVisible();

    // Changement du type de saisie en place : Liste → Texte, le lien vers les valeurs disparaît.
    ligne = await ligneDansTable(tableau, label);
    await ligne.getByRole('button', { name: TYPE_SAISIE.liste.libelle, exact: true }).click();
    const retype = await apresAppel(page, 'PATCH', `${SETTINGS}/metadatas/${meta.metaDataId}`, () =>
      listeOuverte(page).getByTitle(TYPE_SAISIE.texte.libelle, { exact: true }).click(),
    );
    expect(retype.status()).toBe(200);
    expect(retype.request().postDataJSON()).toEqual({ dataType: TYPE_SAISIE.texte.valeur });
    ligne = await ligneDansTable(tableau, label);
    await expect(
      ligne.getByRole('button', { name: TYPE_SAISIE.texte.libelle, exact: true }),
    ).toBeVisible();
    await expect(
      ligne.getByRole('button', { name: 'Gérer les valeurs de cette liste' }),
    ).toHaveCount(0);

    // Renommage en place.
    const renomme = await renommerEnPlace(
      page,
      ligne,
      label,
      `${label} bis`,
      `${SETTINGS}/metadatas/${meta.metaDataId}`,
    );
    expect(renomme.status()).toBe(200);
    expect(renomme.request().postDataJSON()).toEqual({ label: `${label} bis` });

    // Désactivation : confirmation qui énonce la conséquence.
    ligne = await ligneDansTable(tableau, `${label} bis`);
    await ligne.getByRole('button', { name: 'Désactiver cette métadonnée', exact: true }).click();
    await expect(
      page.getByText('Elle disparaîtra des formulaires d’indexation.', { exact: false }),
    ).toBeVisible();
    const desactivation = await apresAppel(page, 'DELETE', `${SETTINGS}/metadatas`, () =>
      confirmer(page, 'Désactiver'),
    );
    expect(desactivation.request().postDataJSON()).toEqual({ ids: [meta.metaDataId] });
    await expect(page.getByText('Métadonnée désactivée', { exact: true })).toBeVisible();
    expect((await listerMetaDonnees(api)).some((m) => m.metaDataId === meta.metaDataId)).toBe(
      false,
    );

    // Saisies invalides par l'API : 400, rien de créé.
    const invalides: unknown[] = [
      { metaDatas: [] },
      { metaDatas: [{ label: '   ', dataType: TYPE_SAISIE.texte.valeur }] },
      { metaDatas: [{ label: `${u} hors type`, dataType: 7 }] },
      { metaDatas: [{ label: `${u} négatif`, dataType: -1 }] },
      { metaDatas: [{ label: `${u} sans type` }] },
    ];
    for (const corps of invalides) {
      expect(
        (await api.raw.post(`${SETTINGS}/metadatas`, corps)).status(),
        JSON.stringify(corps),
      ).toBe(400);
    }
    const autre = await creerMetaDonnee(api, `${u} autre`, TYPE_SAISIE.date.valeur);
    expect((await api.raw.patch(`${SETTINGS}/metadatas/${autre.metaDataId}`, {})).status()).toBe(
      400,
    );
    expect(
      (await api.raw.patch(`${SETTINGS}/metadatas/${autre.metaDataId}`, { dataType: 9 })).status(),
    ).toBe(400);
    // Renommer vers un libellé actif déjà porté : 409.
    const tiers = await creerMetaDonnee(api, `${u} tiers`, TYPE_SAISIE.texte.valeur);
    expect(
      (
        await api.raw.patch(`${SETTINGS}/metadatas/${autre.metaDataId}`, {
          label: tiers.label.toUpperCase(),
        })
      ).status(),
    ).toBe(409);
    expect((await listerMetaDonnees(api)).some((m) => m.label.startsWith(`${u} hors`))).toBe(false);
  });
});

test.describe('Paramétrage Archives — Éléments des listes', () => {
  test('ARC-41 saisit les valeurs d’une liste depuis sa métadonnée, dédoublonne et désactive', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-41');
    const liste = await creerMetaDonnee(api, `${u} priorité`, TYPE_SAISIE.liste.valeur);
    const texte = await creerMetaDonnee(api, `${u} commentaire`, TYPE_SAISIE.texte.valeur);

    // Depuis « Gestion des métadonnées », le lien pré-sélectionne la liste.
    await ouvrirEcran(page, ECRAN_META, 'Gestion des métadonnées', `${SETTINGS}/metadatas`);
    const ligneMeta = await ligneDansTable(carte(page, 'Métadonnées'), liste.label);
    const chargement = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        r.url().includes('/archives/settings/metadata-list-items'),
    );
    await ligneMeta.getByRole('button', { name: 'Gérer les valeurs de cette liste' }).click();
    await expect(page).toHaveURL(new RegExp(`${ECRAN_VALEURS}\\?metaDataId=${liste.metaDataId}$`));
    expect((await chargement).status()).toBe(200);
    await expect(
      page.getByRole('heading', { name: 'Éléments des listes', exact: true }),
    ).toBeVisible();

    const formulaire = carte(page, 'Nouvelle valeur');
    const selectMeta = champ(formulaire, 'Métadonnée (type Liste)');
    await expect(valeurAffichee(selectMeta, liste.label)).toBeVisible();
    await expect(valeurAffichee(champ(page, 'Filtrer par métadonnée'), liste.label)).toBeVisible();

    // Seules les métadonnées « Liste » sont proposées.
    await ouvrirSelect(selectMeta);
    await selectMeta.fill(texte.label);
    await expect(listeOuverte(page).getByTitle(texte.label, { exact: true })).toHaveCount(0);
    await selectMeta.press('Escape');
    await expect(valeurAffichee(selectMeta, liste.label)).toBeVisible();

    // Création unitaire, puis doublon.
    const ajouter = boutonAntd(formulaire, 'Ajouter');
    await champ(formulaire, 'Valeur').fill(`${u} haute`);
    const creation = await apresAppel(page, 'POST', `${SETTINGS}/metadata-list-items`, () =>
      ajouter.click(),
    );
    expect(creation.status()).toBe(201);
    expect(creation.request().postDataJSON()).toEqual({
      metaDataId: liste.metaDataId,
      labels: [`${u} haute`],
    });
    await expect(page.getByText('1 valeur créée', { exact: true })).toBeVisible();
    await champ(formulaire, 'Valeur').fill(`${u} HAUTE`);
    const doublon = await apresAppel(page, 'POST', `${SETTINGS}/metadata-list-items`, () =>
      ajouter.click(),
    );
    expect(await doublon.json()).toEqual({ created: 0, skipped: [`${u} HAUTE`] });
    await expect(page.getByText('1 ignoré(s) (doublon)', { exact: true })).toBeVisible();

    // Création en masse par l'API : doublons internes et existants ignorés et signalés.
    expect(
      await creerValeurs(api, liste.metaDataId, [`${u} basse`, `${u}  BASSE`, `${u}haute`]),
    ).toEqual({ created: 1, skipped: [`${u} BASSE`, `${u}haute`] });
    // La même valeur reste permise sur une AUTRE liste (unicité par métadonnée).
    const autreListe = await creerMetaDonnee(api, `${u} urgence`, TYPE_SAISIE.liste.valeur);
    expect(await creerValeurs(api, autreListe.metaDataId, [`${u} haute`])).toEqual({
      created: 1,
      skipped: [],
    });

    // Désactivation d'une valeur par l'écran.
    await page.reload();
    const tableau = carte(page, 'Valeurs de liste');
    const ligneBasse = await ligneDansTable(tableau, `${u} basse`);
    await ligneBasse.getByRole('button', { name: 'Désactiver cette valeur', exact: true }).click();
    const desactivation = await apresAppel(page, 'DELETE', `${SETTINGS}/metadata-list-items`, () =>
      confirmer(page, 'Désactiver'),
    );
    expect(desactivation.status()).toBe(200);
    await expect(page.getByText('Valeur désactivée', { exact: true })).toBeVisible();
    expect((await listerValeurs(api, liste.metaDataId)).map((v) => v.label)).toEqual([
      `${u} haute`,
    ]);
    // Le compteur de « Gestion des métadonnées » ne compte que les valeurs actives.
    expect(
      (await listerMetaDonnees(api)).find((m) => m.metaDataId === liste.metaDataId)?.listItemCount,
    ).toBe(1);

    // Erreurs de saisie par l'API.
    expect(
      (
        await api.raw.post(`${SETTINGS}/metadata-list-items`, {
          metaDataId: liste.metaDataId,
          labels: [],
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await api.raw.post(`${SETTINGS}/metadata-list-items`, {
          metaDataId: liste.metaDataId,
          labels: [' '],
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await api.raw.post(`${SETTINGS}/metadata-list-items`, {
          metaDataId: 2147483000,
          labels: [`${u} x`],
        })
      ).status(),
    ).toBe(404);
    // ANO-ARC-T4-02 : une valeur de liste sur une métadonnée qui n'est PAS une liste est refusée,
    // comme l'écran le laisse entendre (il ne propose que les listes).
    const refusTexte = await api.raw.post(`${SETTINGS}/metadata-list-items`, {
      metaDataId: texte.metaDataId,
      labels: [`${u} hors liste`],
    });
    expect(refusTexte.status()).toBe(400);
    expect(await listerValeurs(api, texte.metaDataId)).toEqual([]);
  });
});

test.describe('Paramétrage Archives — Métadonnées par type de document', () => {
  test('ARC-42 associe, remplace et retire les métadonnées d’un type ; le formulaire d’indexation suit', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-42');
    const typeA = { id: await creerTypeDocument(api, `${u} type A`), label: `${u} type A` };
    const typeB = { id: await creerTypeDocument(api, `${u} type B`), label: `${u} type B` };
    const reference = await creerMetaDonnee(api, `${u} référence`, TYPE_SAISIE.texte.valeur);
    const etat = await creerMetaDonnee(api, `${u} état`, TYPE_SAISIE.liste.valeur);
    await creerValeurs(api, etat.metaDataId, [`${u} brouillon`, `${u} signé`]);
    const optionReference = `${reference.label} — ${TYPE_SAISIE.texte.libelle}`;
    const optionEtat = `${etat.label} — ${TYPE_SAISIE.liste.libelle}`;

    await ouvrirEcran(
      page,
      ECRAN_ASSOC,
      'Métadonnées par type de document',
      `${SETTINGS}/metadata-document-types`,
    );

    // ASSOCIER : produit cartésien 2 types × 2 métadonnées.
    const ajout = carte(page, 'Associer (ajout)');
    const bouton = boutonAntd(ajout, 'Associer');
    await expect(bouton).toBeDisabled();
    await choisirAvecRecherche(page, champ(ajout, 'Types de documents'), typeA.label, true);
    await choisirAvecRecherche(page, champ(ajout, 'Types de documents'), typeB.label, true);
    await choisirAvecRecherche(page, champ(ajout, 'Métadonnées'), optionReference, true);
    await choisirAvecRecherche(page, champ(ajout, 'Métadonnées'), optionEtat, true);
    const lien = await apresAppel(page, 'POST', `${SETTINGS}/metadata-document-types`, () =>
      bouton.click(),
    );
    expect(lien.status()).toBe(201);
    expect(await lien.json()).toEqual({ created: 4, alreadyLinked: 0 });
    await expect(page.getByText('4 association(s) créée(s)', { exact: true })).toBeVisible();

    // Couples déjà en place : non bloquant, compté et signalé.
    await choisirAvecRecherche(page, champ(ajout, 'Types de documents'), typeA.label, true);
    await choisirAvecRecherche(page, champ(ajout, 'Métadonnées'), optionReference, true);
    await apresAppel(page, 'POST', `${SETTINGS}/metadata-document-types`, () => bouton.click());
    await expect(
      page.getByText('0 association(s) créée(s) — 1 déjà en place', { exact: true }),
    ).toBeVisible();

    // Usage aval : les champs du formulaire d'indexation du type A, valeurs de liste comprises.
    let champs = await champsDuType(api, typeA.id);
    expect(champs.map((c) => c.label).sort()).toEqual([etat.label, reference.label].sort());
    expect(
      champs.find((c) => c.metaDataId === etat.metaDataId)?.options.map((o) => o.label),
    ).toEqual([`${u} brouillon`, `${u} signé`]);

    // L'accordéon du type A détaille ses deux métadonnées.
    const associations = carte(page, 'Associations');
    const ligneA = await ligneDansTable(associations, typeA.label);
    await ligneA.locator('.ant-table-row-expand-icon').click();
    const detail = associations.locator('.ant-table-expanded-row');
    await expect(detail.getByRole('row').filter({ hasText: reference.label })).toHaveCount(1);
    await expect(detail.getByRole('row').filter({ hasText: etat.label })).toHaveCount(1);

    // REMPLACER la liste du type A : on retire « référence », la confirmation l'annonce.
    const remplacer = carte(page, "Remplacer la liste d'un type");
    await choisirAvecRecherche(page, champ(remplacer, 'Type de document'), typeA.label);
    const choixType = champ(remplacer, 'Métadonnées de ce type');
    await expect(valeurAffichee(choixType, reference.label)).toBeVisible();
    await expect(valeurAffichee(choixType, etat.label)).toBeVisible();
    await valeurAffichee(choixType, reference.label)
      .locator('.ant-select-selection-item-remove')
      .click();
    await boutonAntd(remplacer, 'Enregistrer la liste').click();
    await expect(
      page.getByText('Retirer 1 métadonnée de ce type ?', { exact: true }),
    ).toBeVisible();
    const remplacement = await apresAppel(page, 'PUT', `${SETTINGS}/metadata-document-types`, () =>
      confirmer(page, 'Enregistrer'),
    );
    expect(remplacement.status()).toBe(200);
    expect(remplacement.request().postDataJSON()).toEqual({
      documentTypeId: typeA.id,
      metaDataIds: [etat.metaDataId],
    });
    await expect(
      page.getByText('Liste des métadonnées mise à jour', { exact: true }),
    ).toBeVisible();
    expect((await associationsDuType(api, typeA.id)).map((a) => a.metaDataId)).toEqual([
      etat.metaDataId,
    ]);

    // RETIRER une association du type B depuis son accordéon.
    await page.reload();
    const ligneB = await ligneDansTable(carte(page, 'Associations'), typeB.label);
    await ligneB.locator('.ant-table-row-expand-icon').click();
    const ligneDetail = carte(page, 'Associations')
      .locator('.ant-table-expanded-row')
      .getByRole('row')
      .filter({ hasText: reference.label });
    await ligneDetail.getByRole('button', { name: 'Retirer cette métadonnée de ce type' }).click();
    const retrait = await apresAppel(page, 'DELETE', `${SETTINGS}/metadata-document-types`, () =>
      confirmer(page, 'Retirer'),
    );
    expect(retrait.status()).toBe(200);
    await expect(page.getByText('Association supprimée', { exact: true })).toBeVisible();
    expect((await associationsDuType(api, typeB.id)).map((a) => a.metaDataId)).toEqual([
      etat.metaDataId,
    ]);

    // Désactivations répercutées sur le formulaire d'indexation : valeur, puis métadonnée.
    const signe = (await listerValeurs(api, etat.metaDataId)).find(
      (v) => v.label === `${u} signé`,
    )!;
    await supprimerParApi(api, `${SETTINGS}/metadata-list-items`, [signe.metaDataListItemId]);
    champs = await champsDuType(api, typeA.id);
    expect(
      champs.find((c) => c.metaDataId === etat.metaDataId)?.options.map((o) => o.label),
    ).toEqual([`${u} brouillon`]);
    await supprimerParApi(api, `${SETTINGS}/metadatas`, [etat.metaDataId]);
    expect(await champsDuType(api, typeA.id)).toEqual([]);

    // Erreurs de saisie par l'API.
    expect(
      (
        await api.raw.post(`${SETTINGS}/metadata-document-types`, {
          documentTypeIds: [],
          metaDataIds: [reference.metaDataId],
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await api.raw.put(`${SETTINGS}/metadata-document-types`, {
          documentTypeId: 2147483000,
          metaDataIds: [],
        })
      ).status(),
    ).toBe(404);
    // ANO-ARC-T4-01 : une référence inexistante est une erreur de saisie (400), pas un 500.
    expect(
      (
        await api.raw.post(`${SETTINGS}/metadata-document-types`, {
          documentTypeIds: [typeA.id],
          metaDataIds: [2147483000],
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await api.raw.put(`${SETTINGS}/metadata-document-types`, {
          documentTypeId: typeA.id,
          metaDataIds: [2147483000],
        })
      ).status(),
    ).toBe(400);
    expect(await associer(api, [typeB.id], [reference.metaDataId])).toEqual({
      created: 1,
      alreadyLinked: 0,
    });
  });

  test.fixme('ARC-42 rend une métadonnée obligatoire pour un type de document', // aucun. À écrire si la règle est confirmée et le champ ajouté. // obligatoire (ni colonne, ni DTO, ni écran) ; le formulaire d'indexation n'en impose donc // Question métier (rapport T4) : le modèle `metadata_document_type` ne porte AUCUN caractère
  async () => {});
});

test.describe('Paramétrage Archives — permissions des métadonnées', () => {
  test('ARC-43 refuse chaque écriture des trois écrans sans leur menu, l’autorise avec le seul menu concerné', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-43');
    const typeId = await creerTypeDocument(api, `${u} type`);
    const meta = await creerMetaDonnee(api, `${u} liste`, TYPE_SAISIE.liste.valeur);
    await creerValeurs(api, meta.metaDataId, [`${u} valeur`]);
    const valeur = (await listerValeurs(api, meta.metaDataId))[0]!;
    const sans = await creerUtilisateurAvecMenus(api, { prefix: `${u}-sans`, menus: ['/search'] });
    const avecMeta = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-meta`,
      menus: [ECRAN_META],
    });

    const clientSans = await apiAs(sans.username, sans.password);
    // Lectures : ouvertes (lookups du formulaire d'indexation) — question remontée au rapport.
    for (const chemin of [
      `${SETTINGS}/metadatas`,
      `${SETTINGS}/metadata-list-items`,
      `${SETTINGS}/metadata-document-types`,
      `${SETTINGS}/metadata-document-types/summary`,
      `${SETTINGS}/metadata-document-types/${typeId}/fields`,
    ]) {
      expect((await clientSans.raw.get(chemin)).status(), chemin).toBe(200);
    }
    // Écritures : toutes refusées.
    const refus: Array<[string, () => Promise<{ status(): number }>]> = [
      [
        'POST metadatas',
        () =>
          clientSans.raw.post(`${SETTINGS}/metadatas`, {
            metaDatas: [{ label: `${u} x`, dataType: 1 }],
          }),
      ],
      [
        'PATCH metadatas',
        () => clientSans.raw.patch(`${SETTINGS}/metadatas/${meta.metaDataId}`, { label: `${u} x` }),
      ],
      ['DELETE metadatas', () => clientSans.raw.del(`${SETTINGS}/metadatas`)],
      [
        'POST list-items',
        () =>
          clientSans.raw.post(`${SETTINGS}/metadata-list-items`, {
            metaDataId: meta.metaDataId,
            labels: [`${u} x`],
          }),
      ],
      [
        'PATCH list-items',
        () =>
          clientSans.raw.patch(`${SETTINGS}/metadata-list-items/${valeur.metaDataListItemId}`, {
            label: `${u} x`,
          }),
      ],
      ['DELETE list-items', () => clientSans.raw.del(`${SETTINGS}/metadata-list-items`)],
      [
        'POST document-types',
        () =>
          clientSans.raw.post(`${SETTINGS}/metadata-document-types`, {
            documentTypeIds: [typeId],
            metaDataIds: [meta.metaDataId],
          }),
      ],
      [
        'PUT document-types',
        () =>
          clientSans.raw.put(`${SETTINGS}/metadata-document-types`, {
            documentTypeId: typeId,
            metaDataIds: [meta.metaDataId],
          }),
      ],
      ['DELETE document-types', () => clientSans.raw.del(`${SETTINGS}/metadata-document-types`)],
    ];
    for (const [nom, appel] of refus) {
      expect((await appel()).status(), nom).toBe(403);
    }
    expect(await associationsDuType(api, typeId)).toEqual([]);

    // Le menu « Métadonnées » ouvre CET écran-là, pas les deux autres.
    const clientMeta = await apiAs(avecMeta.username, avecMeta.password);
    expect(
      (
        await clientMeta.raw.post(`${SETTINGS}/metadatas`, {
          metaDatas: [{ label: `${u} permise`, dataType: 1 }],
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await clientMeta.raw.post(`${SETTINGS}/metadata-list-items`, {
          metaDataId: meta.metaDataId,
          labels: [`${u} y`],
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await clientMeta.raw.post(`${SETTINGS}/metadata-document-types`, {
          documentTypeIds: [typeId],
          metaDataIds: [meta.metaDataId],
        })
      ).status(),
    ).toBe(403);

    // Écran sans le menu : la création est refusée et expliquée.
    await loginAs(page, sans.username, sans.password);
    await ouvrirEcran(page, ECRAN_META, 'Gestion des métadonnées', `${SETTINGS}/metadatas`);
    const formulaire = carte(page, 'Nouvelle métadonnée');
    await champ(formulaire, 'Libellé').fill(`${u} par écran`);
    const reponse = await apresAppel(page, 'POST', `${SETTINGS}/metadatas`, () =>
      boutonAntd(formulaire, 'Ajouter').click(),
    );
    expect(reponse.status()).toBe(403);
    await expect(page.getByText(MESSAGE_REFUS, { exact: true })).toBeVisible();
    expect((await listerMetaDonnees(api)).some((m) => m.label === `${u} par écran`)).toBe(false);
  });
});
