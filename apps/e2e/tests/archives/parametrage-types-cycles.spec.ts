/**
 * Paramétrage Archives — « Paramétrage des types de documents » (§1) et « Cycles de vie des
 * documents » (§3) (tâche T4, lot 2). Motif `FormAbovePanel` : formulaire ouvert au-dessus du
 * tableau, une ligne par type (PUT = création OU remplacement).
 *
 * Unités : l'écran des cycles saisit et affiche des ANNÉES ; l'API stocke des MOIS (×12).
 */
import { test, expect } from '../../fixtures';
import { creerUtilisateurAvecMenus } from './_helpers/utilisateurs';
import {
  creerConfidentialite,
  creerDossier,
  creerPlan,
  creerTypeDocument,
} from './_helpers/documents';
import {
  MESSAGE_REFUS,
  REFERENTIELS,
  SETTINGS,
  apresAppel,
  boutonAntd,
  carte,
  champ,
  choisirAvecRecherche,
  confirmer,
  creerElementReferentiel,
  cycleDuType,
  enregistrerCycle,
  ligneDansTable,
  listeOuverte,
  ouvrirEcran,
  ouvrirSelect,
  parametrageDuType,
  supprimerParApi,
} from './_helpers/parametrage';

// Pile E2E partagée avec quatre autres piles sur la même machine : les 60 s par défaut ne suffisent
// pas aux parcours qui préparent beaucoup de données par l'API. Aucune assertion n'est relâchée.
test.describe.configure({ timeout: 180_000 });

const ECRAN_TYPES = '/admin/archives/parametrage-types';
const ECRAN_CYCLES = '/admin/archives/cycles-de-vie';
const TITRE_TYPES = 'Paramétrage des types de documents';
const TITRE_CYCLES = 'Cycles de vie des documents';
const DUA = "Durée d'utilité administrative (années)";
const CONFORMITE = 'Durée de conformité (années)';
/** Plus grand entier PostgreSQL `integer` (colonnes en mois). */
const INT4_MAX = 2_147_483_647;
/**
 * Borne haute appliquée par le service (ANO-ARC-T4-03) : 1 000 ans. Au-delà, l'échéance calculée
 * par « DUA expirés » (`date + make_interval(months => …)`) sort de la plage des `timestamp` et
 * ferait échouer la requête de TOUT l'écran, pas seulement de ce type.
 */
const DUREE_MAX_MOIS = 12_000;

test.describe('Paramétrage Archives — Paramétrage des types de documents', () => {
  test('ARC-44 paramètre un type (dossier, plan, confidentialité), le modifie et le supprime', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-44');
    const type = { id: await creerTypeDocument(api, `${u} type`), label: `${u} type` };
    const dossier = { id: await creerDossier(api, `${u} dossier`), label: `${u} dossier` };
    const plan = { id: await creerPlan(api, `${u} plan`), label: `${u} plan` };
    const plan2 = { id: await creerPlan(api, `${u} plan bis`), label: `${u} plan bis` };
    const conf = await creerConfidentialite(api, `${u} confidentiel`);

    await ouvrirEcran(page, ECRAN_TYPES, TITRE_TYPES, `${SETTINGS}/document-types`);
    await page.getByRole('button', { name: 'Nouveau paramétrage' }).click();
    const formulaire = carte(page, 'Paramétrer un type');
    const enregistrer = boutonAntd(formulaire, 'Enregistrer');
    await expect(enregistrer).toBeDisabled();

    await choisirAvecRecherche(page, champ(formulaire, 'Type de document'), type.label);
    await choisirAvecRecherche(page, champ(formulaire, 'Dossier'), dossier.label);
    await choisirAvecRecherche(page, champ(formulaire, 'Plan de classement'), plan.label);
    await choisirAvecRecherche(page, champ(formulaire, 'Confidentialité'), conf.label);
    const creation = await apresAppel(page, 'PUT', `${SETTINGS}/document-types`, () =>
      enregistrer.click(),
    );
    expect(creation.status()).toBe(200);
    expect(creation.request().postDataJSON()).toEqual({
      documentTypeId: type.id,
      dossierId: dossier.id,
      planId: plan.id,
      confidentialiteId: conf.confidentialiteId,
      ocr: false,
      cryptage: false,
      tauxCompression: null,
      profilScanner: null,
      routines: null,
    });
    await expect(page.getByText('Paramétrage enregistré', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nouveau paramétrage' })).toBeVisible();

    const tableau = carte(page, 'Paramétrages');
    let ligne = await ligneDansTable(tableau, type.label);
    await expect(ligne).toContainText(dossier.label);
    await expect(ligne).toContainText(plan.label);
    await expect(ligne).toContainText(conf.label);
    expect(await parametrageDuType(api, type.id)).toMatchObject({
      dossierId: dossier.id,
      planId: plan.id,
      confidentialiteId: conf.confidentialiteId,
    });

    // Modification : la ligne se recharge dans le formulaire, l'écran prévient du remplacement.
    await ligne.getByRole('button', { name: 'Charger ce paramétrage dans le formulaire' }).click();
    await expect(
      formulaire.getByText('Ce type est déjà paramétré', { exact: false }),
    ).toBeVisible();
    await choisirAvecRecherche(page, champ(formulaire, 'Plan de classement'), plan2.label);
    const modification = await apresAppel(page, 'PUT', `${SETTINGS}/document-types`, () =>
      enregistrer.click(),
    );
    expect(modification.status()).toBe(200);
    expect(modification.request().postDataJSON()).toMatchObject({
      documentTypeId: type.id,
      dossierId: dossier.id,
      planId: plan2.id,
      confidentialiteId: conf.confidentialiteId,
    });
    const apres = await parametrageDuType(api, type.id);
    expect(apres).toMatchObject({ planId: plan2.id, dossierId: dossier.id });
    // Une seule ligne par type : PUT est un remplacement, pas un ajout.
    ligne = await ligneDansTable(tableau, type.label);
    await expect(ligne).toHaveCount(1);
    await expect(ligne).toContainText(plan2.label);

    // Suppression.
    await ligne.getByRole('button', { name: 'Supprimer ce paramétrage' }).click();
    const suppression = await apresAppel(page, 'DELETE', `${SETTINGS}/document-types`, () =>
      confirmer(page, 'Supprimer'),
    );
    expect(suppression.status()).toBe(200);
    expect(suppression.request().postDataJSON()).toEqual({ ids: [apres!.documentTypeSettingId] });
    await expect(page.getByText('Paramétrage supprimé', { exact: true })).toBeVisible();
    expect(await parametrageDuType(api, type.id)).toBeNull();
  });

  test('ARC-44 refuse un paramétrage invalide par l’API', async ({ api, uniq }) => {
    const u = uniq('ARC-44e');
    const typeId = await creerTypeDocument(api, `${u} type`);
    const put = (corps: Record<string, unknown>) =>
      api.raw.put(`${SETTINGS}/document-types`, corps);

    expect((await put({})).status()).toBe(400);
    expect((await put({ documentTypeId: 2147483000 })).status()).toBe(404);
    expect((await put({ documentTypeId: typeId, tauxCompression: 0 })).status()).toBe(400);
    expect((await put({ documentTypeId: typeId, tauxCompression: 101 })).status()).toBe(400);
    // ANO-ARC-T4-01 : une référence inexistante est une erreur de saisie (400), pas un 500.
    expect((await put({ documentTypeId: typeId, dossierId: 2147483000 })).status()).toBe(400);
    expect((await put({ documentTypeId: typeId, planId: 2147483000 })).status()).toBe(400);
    expect((await put({ documentTypeId: typeId, confidentialiteId: 2147483000 })).status()).toBe(
      400,
    );
    expect(await parametrageDuType(api, typeId)).toBeNull();

    // Paramétrage vide : légitime (« aucun défaut »).
    expect((await put({ documentTypeId: typeId })).status()).toBe(200);
    expect(await parametrageDuType(api, typeId)).toMatchObject({
      dossierId: null,
      planId: null,
      confidentialiteId: null,
    });
  });
});

test.describe('Paramétrage Archives — Cycles de vie des documents', () => {
  test('ARC-45 définit la DUA, la conformité, le sort final et le mode de destruction d’un type', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-45');
    const type = { id: await creerTypeDocument(api, `${u} type`), label: `${u} type` };
    const sort = await creerElementReferentiel(api, REFERENTIELS.sorts, `${u} destruction`);
    const mode = await creerElementReferentiel(api, REFERENTIELS.modes, `${u} broyage`);

    await ouvrirEcran(page, ECRAN_CYCLES, TITRE_CYCLES, `${SETTINGS}/life-cycles`);
    await page.getByRole('button', { name: 'Nouvelle règle' }).click();
    const formulaire = carte(page, 'Définir un cycle de vie');
    const enregistrer = boutonAntd(formulaire, 'Enregistrer');
    await expect(enregistrer).toBeDisabled();

    // Bornes de saisie : aucune durée négative.
    await expect(champ(formulaire, DUA)).toHaveAttribute('aria-valuemin', '0');
    await expect(champ(formulaire, CONFORMITE)).toHaveAttribute('aria-valuemin', '0');

    await choisirAvecRecherche(page, champ(formulaire, 'Type de document'), type.label);
    await champ(formulaire, DUA).fill('3');
    await champ(formulaire, CONFORMITE).fill('10');
    await choisirAvecRecherche(page, champ(formulaire, 'Sort final'), sort.label);
    await choisirAvecRecherche(page, champ(formulaire, 'Mode de destruction'), mode.label);
    const creation = await apresAppel(page, 'PUT', `${SETTINGS}/life-cycles`, () =>
      enregistrer.click(),
    );
    expect(creation.status()).toBe(200);
    // Années à l'écran, MOIS dans le contrat.
    expect(creation.request().postDataJSON()).toEqual({
      documentTypeId: type.id,
      usefulnessLifespan: 36,
      complianceLifespan: 120,
      finalFateId: sort.id,
      destructionModeId: mode.id,
    });
    await expect(page.getByText('Cycle de vie enregistré', { exact: true })).toBeVisible();

    const tableau = carte(page, 'Règles de cycle de vie');
    let ligne = await ligneDansTable(tableau, type.label);
    await expect(ligne).toContainText('3 ans');
    await expect(ligne).toContainText('10 ans');
    await expect(ligne).toContainText(sort.label);
    await expect(ligne).toContainText(mode.label);

    // Modification : la règle se recharge (mois → années), DUA ramenée à 0 = « immédiat ».
    await ligne.getByRole('button', { name: 'Charger cette règle dans le formulaire' }).click();
    await expect(formulaire.getByText('Ce type a déjà une règle', { exact: false })).toBeVisible();
    await expect(champ(formulaire, DUA)).toHaveValue('3');
    await expect(champ(formulaire, CONFORMITE)).toHaveValue('10');
    await champ(formulaire, DUA).fill('0');
    const modification = await apresAppel(page, 'PUT', `${SETTINGS}/life-cycles`, () =>
      enregistrer.click(),
    );
    expect(modification.request().postDataJSON()).toMatchObject({
      usefulnessLifespan: 0,
      complianceLifespan: 120,
      finalFateId: sort.id,
      destructionModeId: mode.id,
    });
    ligne = await ligneDansTable(tableau, type.label);
    await expect(ligne).toHaveCount(1);
    await expect(ligne).toContainText('immédiat');
    expect(await cycleDuType(api, type.id)).toMatchObject({
      usefulnessLifespan: 0,
      complianceLifespan: 120,
    });

    // Suppression : la conséquence (sortie de « DUA expirés ») est énoncée.
    await ligne.getByRole('button', { name: 'Supprimer cette règle' }).click();
    await expect(page.getByText('cesseront de remonter dans', { exact: false })).toBeVisible();
    const suppression = await apresAppel(page, 'DELETE', `${SETTINGS}/life-cycles`, () =>
      confirmer(page, 'Supprimer'),
    );
    expect(suppression.status()).toBe(200);
    await expect(page.getByText('Règle supprimée', { exact: true })).toBeVisible();
    expect(await cycleDuType(api, type.id)).toBeNull();
  });

  test('ARC-45 refuse une durée hors bornes ou une référence inexistante', async ({
    api,
    uniq,
  }) => {
    const u = uniq('ARC-45e');
    const typeId = await creerTypeDocument(api, `${u} type`);
    const put = (corps: Record<string, unknown>) => api.raw.put(`${SETTINGS}/life-cycles`, corps);
    const base = { documentTypeId: typeId, usefulnessLifespan: 12, complianceLifespan: 24 };

    for (const corps of [
      { ...base, usefulnessLifespan: -1 },
      { ...base, complianceLifespan: -12 },
      { ...base, usefulnessLifespan: 1.5 },
      { ...base, usefulnessLifespan: '12' },
      { documentTypeId: typeId, usefulnessLifespan: 12 },
      // ANO-ARC-T4-03 : durée démesurée (jusqu'au-delà d'un `integer` PostgreSQL) → refus lisible.
      { ...base, usefulnessLifespan: INT4_MAX + 1 },
      { ...base, complianceLifespan: INT4_MAX + 1 },
      { ...base, usefulnessLifespan: DUREE_MAX_MOIS + 1 },
      // ANO-ARC-T4-01 : sort final / mode inexistant → 400, pas une violation de clé en 500.
      { ...base, finalFateId: 2147483000 },
      { ...base, destructionModeId: 2147483000 },
    ]) {
      expect((await put(corps)).status(), JSON.stringify(corps)).toBe(400);
    }
    expect((await put({ ...base, documentTypeId: 2147483000 })).status()).toBe(404);
    expect(await cycleDuType(api, typeId)).toBeNull();

    // Bornes admises : 0 (échu d'office) et la borne haute.
    expect((await put({ ...base, usefulnessLifespan: 0 })).status()).toBe(200);
    expect((await put({ ...base, complianceLifespan: DUREE_MAX_MOIS })).status()).toBe(200);
  });

  test('ARC-45 n’envoie que des années entières (pas de mois perdus à la relecture)', async ({
    page,
    api,
    uniq,
  }) => {
    // ANO-ARC-T4-04 (corrigée) : sans `precision={0}`, « 2,5 ans » partait en 30 mois, que la
    // relecture affichait « 3 ans » (Math.round) et qu'un nouvel enregistrement changeait en 36
    // mois. Désormais l'InputNumber arrondit la saisie à la sortie du champ (règle d'AntD avec
    // `precision={0}` : demi vers le haut) et le champ montre l'entier qui sera envoyé. La virgule
    // française et le point sont tous deux lus comme séparateur décimal (« 2,5 » n'est pas 25).
    const u = uniq('ARC-45d');
    const type = { id: await creerTypeDocument(api, `${u} type`), label: `${u} type` };
    await ouvrirEcran(page, ECRAN_CYCLES, TITRE_CYCLES, `${SETTINGS}/life-cycles`);
    await page.getByRole('button', { name: 'Nouvelle règle' }).click();
    const formulaire = carte(page, 'Définir un cycle de vie');
    await choisirAvecRecherche(page, champ(formulaire, 'Type de document'), type.label);
    await champ(formulaire, DUA).fill('2,5');
    await champ(formulaire, CONFORMITE).fill('4.4');
    await champ(formulaire, CONFORMITE).blur();
    // À la sortie de chaque champ : l'entier arrondi, avant tout enregistrement.
    await expect(champ(formulaire, DUA)).toHaveValue('3');
    await expect(champ(formulaire, CONFORMITE)).toHaveValue('4');

    const envoi = await apresAppel(page, 'PUT', `${SETTINGS}/life-cycles`, () =>
      boutonAntd(formulaire, 'Enregistrer').click(),
    );
    expect(envoi.status()).toBe(200);
    // Ce qui part est exactement ce qui était affiché : 3 ans et 4 ans, jamais 30 mois.
    expect(envoi.request().postDataJSON()).toMatchObject({
      documentTypeId: type.id,
      usefulnessLifespan: 36,
      complianceLifespan: 48,
    });
    await expect(page.getByText('Cycle de vie enregistré', { exact: true })).toBeVisible();
    expect(await cycleDuType(api, type.id)).toMatchObject({
      usefulnessLifespan: 36,
      complianceLifespan: 48,
    });
    // Relecture : le tableau affiche les mêmes années (pas de dérive au prochain enregistrement).
    const ligne = await ligneDansTable(carte(page, 'Règles de cycle de vie'), type.label);
    await expect(ligne).toContainText('3 ans');
    await expect(ligne).toContainText('4 ans');
  });

  test('ARC-45 désactiver un sort final ou un mode utilisé ne vide pas la règle qui le cite', async ({
    page,
    api,
    uniq,
  }) => {
    const u = uniq('ARC-45u');
    const type = { id: await creerTypeDocument(api, `${u} type`), label: `${u} type` };
    const sort = await creerElementReferentiel(api, REFERENTIELS.sorts, `${u} versement`);
    const mode = await creerElementReferentiel(api, REFERENTIELS.modes, `${u} incinération`);
    await enregistrerCycle(api, {
      documentTypeId: type.id,
      usefulnessLifespan: 60,
      complianceLifespan: 120,
      finalFateId: sort.id,
      destructionModeId: mode.id,
    });
    // Désactivation par l'API (le geste d'écran est couvert par ARC-38).
    await supprimerParApi(api, `${SETTINGS}/final-fates`, [sort.id]);
    await supprimerParApi(api, `${SETTINGS}/destruction-modes`, [mode.id]);

    await ouvrirEcran(page, ECRAN_CYCLES, TITRE_CYCLES, `${SETTINGS}/life-cycles`);
    const ligne = await ligneDansTable(carte(page, 'Règles de cycle de vie'), type.label);
    await expect(ligne).toContainText(sort.label);
    await expect(ligne).toContainText(mode.label);

    // Le formulaire ne propose plus les éléments désactivés pour une NOUVELLE règle.
    await page.getByRole('button', { name: 'Nouvelle règle' }).click();
    const formulaire = carte(page, 'Définir un cycle de vie');
    const choixSort = champ(formulaire, 'Sort final');
    await ouvrirSelect(choixSort);
    await choixSort.fill(sort.label);
    await expect(listeOuverte(page).getByTitle(sort.label, { exact: true })).toHaveCount(0);
  });
});

test.describe('Paramétrage Archives — permissions des types et cycles', () => {
  test('ARC-46 refuse l’écriture du paramétrage des types et des cycles sans leur menu', async ({
    page,
    api,
    apiAs,
    loginAs,
    uniq,
  }) => {
    const u = uniq('ARC-46');
    const type = { id: await creerTypeDocument(api, `${u} type`), label: `${u} type` };
    const sans = await creerUtilisateurAvecMenus(api, { prefix: `${u}-sans`, menus: ['/search'] });
    const avecCycles = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-cycles`,
      menus: [ECRAN_CYCLES],
    });
    const avecTypes = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-types`,
      menus: [ECRAN_TYPES],
    });
    const regle = { documentTypeId: type.id, usefulnessLifespan: 12, complianceLifespan: 24 };

    const clientSans = await apiAs(sans.username, sans.password);
    // Lectures ouvertes (défauts consommés par l'indexation) — question remontée au rapport.
    expect((await clientSans.raw.get(`${SETTINGS}/document-types`)).status()).toBe(200);
    expect((await clientSans.raw.get(`${SETTINGS}/life-cycles`)).status()).toBe(200);
    expect(
      (
        await clientSans.raw.put(`${SETTINGS}/document-types`, { documentTypeId: type.id })
      ).status(),
    ).toBe(403);
    expect((await clientSans.raw.del(`${SETTINGS}/document-types`)).status()).toBe(403);
    expect((await clientSans.raw.put(`${SETTINGS}/life-cycles`, regle)).status()).toBe(403);
    expect((await clientSans.raw.del(`${SETTINGS}/life-cycles`)).status()).toBe(403);
    expect(
      (
        await clientSans.raw.put(`${SETTINGS}/document-life-cycles`, {
          documentId: 1,
          usefulnessLifespan: '2030-01-01',
          complianceLifespan: '2040-01-01',
        })
      ).status(),
    ).toBe(403);
    expect(await cycleDuType(api, type.id)).toBeNull();
    expect(await parametrageDuType(api, type.id)).toBeNull();

    // Chaque menu n'ouvre que son écran.
    const clientCycles = await apiAs(avecCycles.username, avecCycles.password);
    expect((await clientCycles.raw.put(`${SETTINGS}/life-cycles`, regle)).status()).toBe(200);
    expect(
      (
        await clientCycles.raw.put(`${SETTINGS}/document-types`, { documentTypeId: type.id })
      ).status(),
    ).toBe(403);
    const clientTypes = await apiAs(avecTypes.username, avecTypes.password);
    expect(
      (
        await clientTypes.raw.put(`${SETTINGS}/document-types`, { documentTypeId: type.id })
      ).status(),
    ).toBe(200);
    expect((await clientTypes.raw.put(`${SETTINGS}/life-cycles`, regle)).status()).toBe(403);

    // Écran sans le menu : l'enregistrement est refusé et expliqué, la règle reste inchangée.
    await loginAs(page, sans.username, sans.password);
    await ouvrirEcran(page, ECRAN_CYCLES, TITRE_CYCLES, `${SETTINGS}/life-cycles`);
    await page.getByRole('button', { name: 'Nouvelle règle' }).click();
    const formulaire = carte(page, 'Définir un cycle de vie');
    await choisirAvecRecherche(page, champ(formulaire, 'Type de document'), type.label);
    await champ(formulaire, DUA).fill('7');
    const refus = await apresAppel(page, 'PUT', `${SETTINGS}/life-cycles`, () =>
      boutonAntd(formulaire, 'Enregistrer').click(),
    );
    expect(refus.status()).toBe(403);
    await expect(page.getByText(MESSAGE_REFUS, { exact: true })).toBeVisible();
    expect(await cycleDuType(api, type.id)).toMatchObject({ usefulnessLifespan: 12 });
  });

  test('ARC-46 refuse l’ouverture d’un écran de paramétrage Archives sans son menu', async ({
    page,
    api,
    loginAs,
    uniq,
  }) => {
    // ANO-ARC-T4-05 : aucune garde de route côté web — `AuthShell` ne fait que masquer l'entrée de
    // menu. Décision de l'utilisateur : écran « Accès refusé » dès l'ouverture, pour tous les
    // modules, corrigé dans la coquille commune par le lot transverse. Le refus de l'API (403 sur
    // les écritures sans menu) est vérifié dès maintenant par le test ARC-46 ci-dessus.
    test.fixme('en attente du lot transverse : écran Accès refusé');

    const u = uniq('ARC-46b');
    const sans = await creerUtilisateurAvecMenus(api, { prefix: `${u}-sans`, menus: ['/search'] });
    const avecCycles = await creerUtilisateurAvecMenus(api, {
      prefix: `${u}-cycles`,
      menus: [ECRAN_CYCLES],
    });

    await loginAs(page, sans.username, sans.password);
    for (const [route, titre, ouvrirFormulaire] of [
      [ECRAN_CYCLES, TITRE_CYCLES, 'Nouvelle règle'],
      [ECRAN_TYPES, TITRE_TYPES, 'Nouveau paramétrage'],
    ] as const) {
      await page.goto(route);
      await expect(page.getByText('Accès refusé').first(), route).toBeVisible();
      // L'écran lui-même n'est pas montré : ni son titre, ni de quoi ouvrir son formulaire.
      await expect(page.getByRole('heading', { name: titre, exact: true }), route).toHaveCount(0);
      await expect(page.getByRole('button', { name: ouvrirFormulaire }), route).toHaveCount(0);
    }

    // Contrôle positif : le menu des cycles ouvre son écran, sans écran de refus.
    await loginAs(page, avecCycles.username, avecCycles.password);
    await ouvrirEcran(page, ECRAN_CYCLES, TITRE_CYCLES, `${SETTINGS}/life-cycles`);
    await expect(page.getByText('Accès refusé')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nouvelle règle' })).toBeVisible();
  });
});
