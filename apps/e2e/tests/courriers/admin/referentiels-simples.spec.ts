/**
 * Référentiels plats du paramétrage Docu-Courriers (patron `MailRefPage` : libellé seul) —
 * natures, confidentialités, types de courrier départ, types d'entité externe — et objets de
 * courrier (libellé + durées de suivi).
 *
 * Règles éprouvées (apps/api/src/modules/courriers/mail-referentials.service.ts,
 * domain/label-normalisation.ts) :
 *  - libellé stocké espaces compactés, casse conservée ;
 *  - unicité parmi les ACTIFS, insensible à la casse et aux espaces (« Officiel » = « OFFICIEL » =
 *    « Offi ciel ») → 409 lisible ; un libellé désactivé redevient libre (index partiel) ;
 *  - désactivation logique (is_active=false) : l'élément sort des listes et des lookups.
 *
 * Natures, objets et confidentialités sont des écrans MASQUÉS (HIDDEN_MENU_KEYS) : hors barre
 * latérale, non assignables à un rôle, accessibles à l'administrateur par URL directe — c'est le
 * profil du fixture `page`. Leur refus aux autres profils est couvert par `../permissions.spec.ts`
 * (COU-99).
 */
import { test, expect } from '../_helpers/test';
import {
  REF_API,
  UNKNOWN_ID,
  activeLabels,
  card,
  deactivateRow,
  editInline,
  expectNoRow,
  expectToast,
  findRow,
  gotoAndWait,
  optionsMatching,
  waitApi,
} from '../_helpers/admin-t4';

interface SimpleRef {
  name: string;
  url: string;
  api: string;
  title: string;
  formTitle: string;
  /** Fin du libellé du bouton de ligne « Désactiver … ». */
  confirm: string;
  idField: string;
  duplicate: RegExp;
  prefix: string;
}

const SIMPLE_REFS: SimpleRef[] = [
  {
    name: 'natures',
    url: '/admin/courriers/natures',
    api: REF_API.natures,
    title: 'Natures de courrier',
    formTitle: 'Nouvelle nature',
    confirm: 'cette nature',
    idField: 'mailNatureId',
    duplicate: /Une nature active porte déjà ce libellé/,
    prefix: 'Nat',
  },
  {
    name: 'confidentialités',
    url: '/admin/courriers/confidentialites',
    api: REF_API.confidentialites,
    title: 'Confidentialités',
    formTitle: 'Nouveau niveau',
    confirm: 'ce niveau de confidentialité',
    idField: 'mailConfidentialiteId',
    duplicate: /Une confidentialité active porte déjà ce libellé/,
    prefix: 'Conf',
  },
  {
    name: 'types de départ',
    url: '/admin/courriers/types-depart',
    api: REF_API.departTypes,
    title: 'Types de courrier départ',
    formTitle: 'Nouveau type de départ',
    confirm: 'ce type de départ',
    idField: 'mailDepartTypeId',
    duplicate: /Un type de courrier départ actif porte déjà ce libellé/,
    prefix: 'Dep',
  },
  {
    name: "types d'entité externe",
    url: '/admin/courriers/types-entites-externes',
    api: REF_API.externalEntityTypes,
    title: "Types d'entité externe",
    formTitle: 'Nouveau type',
    confirm: "ce type d'entité externe",
    idField: 'externalEntityTypeId',
    duplicate: /Un type d'entité externe actif porte déjà ce libellé/,
    prefix: 'Tee',
  },
];

/** Variante « même clé normalisée » : casse changée + un espace interne + bordures. */
const dedupVariant = (label: string) => `  ${label.toUpperCase().replace(/^(.)(.)/, '$1 $2')} `;

for (const r of SIMPLE_REFS) {
  test.describe(`Paramétrage courrier — ${r.name}`, () => {
    // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
    // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
    // Délai triplé, aucune assertion modifiée.
    test.slow();
    test(`COU-70 — [${r.name}] création depuis le formulaire : libellé compacté, ligne et lookup à jour`, async ({
      page,
      api,
      uniq,
    }) => {
      const base = uniq(r.prefix);
      const stored = `${base} bis`;
      await gotoAndWait(page, r.url, 'GET', r.api);
      await expect(page.getByRole('heading', { name: r.title })).toBeVisible();

      const form = card(page, r.formTitle);
      await form.getByLabel('Libellé').fill(`  ${base}    bis  `);
      const post = waitApi(page, 'POST', r.api);
      const reload = waitApi(page, 'GET', r.api);
      await form.getByRole('button', { name: 'Ajouter' }).click();

      const res = await post;
      expect(res.status()).toBe(201);
      expect(await res.json()).toMatchObject({ label: stored });
      await reload;
      await expectToast(page, 'Élément créé');
      await expect(form.getByLabel('Libellé')).toHaveValue('');
      await expect(await findRow(page, stored)).toBeVisible();
      expect(await activeLabels(api, r.api)).toContain(stored);
    });

    test(`COU-71 — [${r.name}] renommage en place : propre casse permise, libellé d'un autre actif refusé`, async ({
      page,
      api,
      uniq,
    }) => {
      const label = uniq(r.prefix);
      const other = uniq(`${r.prefix}Autre`);
      const created = await api.post(r.api, { label });
      await api.post(r.api, { label: other });
      const id = created[r.idField] as number;
      const patchPath = `${r.api}/${id}`;

      await gotoAndWait(page, r.url, 'GET', r.api);
      // 1) Renommage nominal.
      const renamed = `${label} renommé`;
      let row = await findRow(page, label);
      let res = await editInline(page, row, label, renamed, patchPath);
      expect(res.status()).toBe(200);
      await expectToast(page, 'Modifié');
      row = await findRow(page, renamed);
      await expect(row).toBeVisible();

      // 2) Changer sa propre casse reste permis (l'élément s'exclut du contrôle d'unicité).
      const upper = renamed.toUpperCase();
      res = await editInline(page, row, renamed, upper, patchPath);
      expect(res.status()).toBe(200);
      expect(await activeLabels(api, r.api)).toContain(upper);

      // 3) Prendre le libellé (normalisé) d'un autre actif : 409, message lisible, ligne inchangée.
      row = await findRow(page, upper);
      const reload = waitApi(page, 'GET', r.api);
      res = await editInline(page, row, upper, other.toLowerCase(), patchPath);
      expect(res.status()).toBe(409);
      await expectToast(page, r.duplicate);
      await reload;
      await expect(await findRow(page, upper)).toBeVisible();

      const raw = await api.raw.patch(patchPath, { label: dedupVariant(other) });
      expect(raw.status()).toBe(409);
    });

    test(`COU-72 — [${r.name}] désactivation confirmée : sort de la liste et du lookup, libellé de nouveau libre`, async ({
      page,
      api,
      uniq,
    }) => {
      const label = uniq(r.prefix);
      const created = await api.post(r.api, { label });
      const id = created[r.idField] as number;

      await gotoAndWait(page, r.url, 'GET', r.api);
      const row = await findRow(page, label);
      const reload = waitApi(page, 'GET', r.api);
      const res = await deactivateRow(page, row, `Désactiver ${r.confirm}`, `${r.api}/${id}`);
      expect(res.status()).toBe(200);
      expect(await res.json()).toEqual({ deactivated: true });
      await reload;
      await expectToast(page, 'Élément désactivé');
      await expectNoRow(page, label);
      expect(await activeLabels(api, r.api)).not.toContain(label);

      // Unicité « parmi les actifs » (index partiel WHERE is_active) : le libellé est réutilisable.
      const again = await api.raw.post(r.api, { label });
      expect(again.status()).toBe(201);
    });

    test(`COU-73 — [${r.name}] erreurs de saisie : libellé vide, doublon normalisé, identifiant inconnu`, async ({
      page,
      api,
      uniq,
    }) => {
      const label = uniq(r.prefix);
      await api.post(r.api, { label });

      await gotoAndWait(page, r.url, 'GET', r.api);
      const form = card(page, r.formTitle);
      const field = form.getByLabel('Libellé');
      const add = form.getByRole('button', { name: 'Ajouter' });

      // Vide / espaces seuls : le bouton reste désactivé (aucun appel).
      await expect(add).toBeDisabled();
      await field.fill('    ');
      await expect(add).toBeDisabled();

      // Doublon à la casse et aux espaces près : 409 et message serveur affiché.
      await field.fill(dedupVariant(label));
      const post = waitApi(page, 'POST', r.api);
      await add.click();
      expect((await post).status()).toBe(409);
      await expectToast(page, r.duplicate);
      await expect(field).toHaveValue(dedupVariant(label)); // saisie conservée pour correction

      // Mêmes refus côté API.
      expect((await api.raw.post(r.api, { label: '   ' })).status()).toBe(400);
      expect((await api.raw.post(r.api, {})).status()).toBe(400);
      expect((await api.raw.post(r.api, { label: dedupVariant(label) })).status()).toBe(409);
      // Identifiant inconnu : 404 (la désactivation remontait une erreur Prisma en 500).
      expect((await api.raw.patch(`${r.api}/${UNKNOWN_ID}`, { label: uniq('x') })).status()).toBe(404);
      expect((await api.raw.del(`${r.api}/${UNKNOWN_ID}`)).status()).toBe(404);
    });
  });
}

test.describe('Paramétrage courrier — référentiels dans les listes de formulaires', () => {
  // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
  // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
  // Délai triplé, aucune assertion modifiée.
  test.slow();
  test('COU-74 — [types de départ] proposé dans « Type de courrier départ » du Départ, retiré une fois désactivé', async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('DepForm');
    const created = await api.post(REF_API.departTypes, { label });

    await gotoAndWait(page, '/courriers/depart', 'GET', REF_API.departTypes);
    const combo = page.getByLabel('Type de courrier départ');
    await expect(await optionsMatching(page, combo, label)).toHaveCount(1);

    await api.del(`${REF_API.departTypes}/${created.mailDepartTypeId}`);
    await gotoAndWait(page, '/courriers/depart', 'GET', REF_API.departTypes);
    await expect(
      await optionsMatching(page, page.getByLabel('Type de courrier départ'), label),
    ).toHaveCount(0);
  });

  test('COU-74 — [natures] proposée dans le filtre « Nature » de la recherche, retirée une fois désactivée', async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('NatForm');
    const created = await api.post(REF_API.natures, { label });
    // Le filtre est un Select sous un libellé texte (pas de <label>) : on remonte au conteneur.
    const natureCombo = () =>
      page.getByText('Nature', { exact: true }).first().locator('..').getByRole('combobox');

    await gotoAndWait(page, '/courriers/recherche', 'GET', REF_API.natures);
    await expect(await optionsMatching(page, natureCombo(), label)).toHaveCount(1);

    await api.del(`${REF_API.natures}/${created.mailNatureId}`);
    await gotoAndWait(page, '/courriers/recherche', 'GET', REF_API.natures);
    await expect(await optionsMatching(page, natureCombo(), label)).toHaveCount(0);
  });

  test("COU-74 — [types d'entité externe] proposé dans le champ « Type » des entités externes, retiré une fois désactivé", async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('TeeForm');
    const created = await api.post(REF_API.externalEntityTypes, { label });

    // Le libellé « Type » couvre aussi le bouton « + » (Créer un type) : on vise la liste.
    const typeCombo = () =>
      card(page, 'Nouvelle entité externe').getByRole('combobox', { name: 'Type' });
    await gotoAndWait(page, '/admin/courriers/entites-externes', 'GET', REF_API.externalEntityTypes);
    await expect(await optionsMatching(page, typeCombo(), label)).toHaveCount(1);

    await api.del(`${REF_API.externalEntityTypes}/${created.externalEntityTypeId}`);
    await gotoAndWait(page, '/admin/courriers/entites-externes', 'GET', REF_API.externalEntityTypes);
    await expect(await optionsMatching(page, typeCombo(), label)).toHaveCount(0);
  });

  test('COU-74 — [confidentialités, objets] lookups actifs seulement, utilisables à l’enregistrement d’un courrier', async ({
    api,
    uniq,
  }) => {
    // Aucun formulaire web ne propose aujourd'hui confidentialité ni objet (l'enregistrement §05
    // ne les expose pas) : on éprouve le lookup qui les alimenterait et l'API d'enregistrement.
    const conf = await api.post(REF_API.confidentialites, { label: uniq('ConfForm') });
    const objet = await api.post(REF_API.objets, { label: uniq('ObjForm'), dureeSuiviExterne: 2 });
    expect(await activeLabels(api, REF_API.confidentialites)).toContain(conf.label);
    expect(await activeLabels(api, REF_API.objets)).toContain(objet.label);

    await api.del(`${REF_API.confidentialites}/${conf.mailConfidentialiteId}`);
    await api.del(`${REF_API.objets}/${objet.mailObjetId}`);
    expect(await activeLabels(api, REF_API.confidentialites)).not.toContain(conf.label);
    expect(await activeLabels(api, REF_API.objets)).not.toContain(objet.label);
  });
});

test.describe('Paramétrage courrier — objets de courrier', () => {
  // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
  // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
  // Délai triplé, aucune assertion modifiée.
  test.slow();
  const URL = '/admin/courriers/objets';

  test('COU-75 — objets : création avec durées, durée modifiée en place, renommage, désactivation', async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('Obj');
    await gotoAndWait(page, URL, 'GET', REF_API.objets);
    await expect(page.getByRole('heading', { name: 'Objets de courrier' })).toBeVisible();

    // Création.
    const form = card(page, 'Nouvel objet');
    await form.getByLabel('Libellé').fill(label);
    await form.getByLabel('Durée de suivi externe (jours)').fill('5');
    await form.getByLabel('Durée de suivi interne (jours)').fill('3');
    const post = waitApi(page, 'POST', REF_API.objets);
    let reload = waitApi(page, 'GET', REF_API.objets);
    await form.getByRole('button', { name: 'Ajouter' }).click();
    const created = await post;
    expect(created.status()).toBe(201);
    expect(created.request().postDataJSON()).toEqual({
      label,
      dureeSuiviExterne: 5,
      dureeSuiviInterne: 3,
    });
    const id = (await created.json()).mailObjetId as number;
    await reload;
    await expectToast(page, 'Objet créé');

    let row = await findRow(page, label);
    const ext = row.getByLabel(`Durée de suivi externe en jours pour « ${label} »`);
    await expect(ext).toHaveValue('5');
    await expect(row.getByLabel(`Durée de suivi interne en jours pour « ${label} »`)).toHaveValue('3');

    // Durée modifiée en place (validée par Entrée).
    await ext.fill('8');
    const patch = waitApi(page, 'PATCH', `${REF_API.objets}/${id}`);
    await ext.press('Enter');
    const patched = await patch;
    expect(patched.status()).toBe(200);
    expect(patched.request().postDataJSON()).toEqual({ dureeSuiviExterne: 8 });
    await expectToast(page, 'Modifié');
    expect((await api.get(REF_API.objets)).find((o: { mailObjetId: number }) => o.mailObjetId === id))
      .toMatchObject({ dureeSuiviExterne: 8, dureeSuiviInterne: 3 });

    // Renommage.
    const renamed = `${label} renommé`;
    row = await findRow(page, label);
    expect((await editInline(page, row, label, renamed, `${REF_API.objets}/${id}`)).status()).toBe(200);

    // Désactivation.
    row = await findRow(page, renamed);
    reload = waitApi(page, 'GET', REF_API.objets);
    const del = await deactivateRow(page, row, `Désactiver l'objet ${renamed}`, `${REF_API.objets}/${id}`);
    expect(del.status()).toBe(200);
    await reload;
    await expectToast(page, 'Objet désactivé');
    await expectNoRow(page, renamed);
    expect(await activeLabels(api, REF_API.objets)).not.toContain(renamed);
  });

  test('COU-76 — objets : erreurs de saisie (libellé vide, doublon normalisé, durées invalides, inconnu)', async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('Obj');
    const created = await api.post(REF_API.objets, { label });

    await gotoAndWait(page, URL, 'GET', REF_API.objets);
    const form = card(page, 'Nouvel objet');
    const add = form.getByRole('button', { name: 'Ajouter' });
    await expect(add).toBeDisabled();
    await form.getByLabel('Libellé').fill('   ');
    await expect(add).toBeDisabled();

    await form.getByLabel('Libellé').fill(dedupVariant(label));
    const post = waitApi(page, 'POST', REF_API.objets);
    await add.click();
    expect((await post).status()).toBe(409);
    await expectToast(page, /Un objet actif porte déjà ce libellé/);

    expect((await api.raw.post(REF_API.objets, { label: '' })).status()).toBe(400);
    expect((await api.raw.post(REF_API.objets, { label: uniq('o'), dureeSuiviExterne: -1 })).status()).toBe(400);
    expect((await api.raw.post(REF_API.objets, { label: uniq('o'), dureeSuiviInterne: 1.5 })).status()).toBe(400);
    expect((await api.raw.patch(`${REF_API.objets}/${created.mailObjetId}`, {})).status()).toBe(400);
    expect((await api.raw.patch(`${REF_API.objets}/${UNKNOWN_ID}`, { dureeSuiviExterne: 1 })).status()).toBe(404);
    expect((await api.raw.del(`${REF_API.objets}/${UNKNOWN_ID}`)).status()).toBe(404);
  });
});
