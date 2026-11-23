/**
 * Entités externes / correspondants (§17), bouton « + » du champ Type (§16) et propriétés
 * personnalisées EAV (§12/§16) — écran `/admin/courriers/entites-externes`.
 *
 * Code lu : apps/web/app/admin/courriers/entites-externes/page.tsx,
 * components/mail/NewExternalEntityTypeModal.tsx, apps/api/src/modules/courriers/
 * mail-referentials.{controller,service,dto}.ts.
 *
 * Les propriétés personnalisées n'ont pas d'écran d'administration (doc §16 : « ni contrôleur, ni
 * entrée de menu ») : elles sont éprouvées par l'API que consomme le panneau de métadonnées d'un
 * courrier (`MailMetadataPanel`).
 */
import { test, expect } from '../_helpers/test';
import type { ApiClient } from '../../../fixtures';
import {
  REF_API,
  UNKNOWN_ID,
  card,
  deactivateRow,
  editInline,
  expectNoRow,
  expectToast,
  findRow,
  gotoAndWait,
  openDropdown,
  optionsMatching,
  pickOption,
  waitApi,
} from '../_helpers/admin-t4';

const URL = '/admin/courriers/entites-externes';
const FORM = 'Nouvelle entité externe';

interface EntityRow {
  externalEntityId: number;
  label: string;
  email: string | null;
  telephone: string | null;
  externalEntityTypeId: number | null;
  externalEntityType: { label: string } | null;
}

async function entityById(api: ApiClient, id: number) {
  const rows = (await api.get(REF_API.externalEntities)) as EntityRow[];
  return rows.find((r) => r.externalEntityId === id);
}

test.describe('Paramétrage courrier — entités externes', () => {
  // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
  // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
  // Délai triplé, aucune assertion modifiée.
  test.slow();
  test('COU-77 — création complète (nom, type, e-mail, téléphone) puis filtre par nom', async ({
    page,
    api,
    uniq,
  }) => {
    const type = await api.post(REF_API.externalEntityTypes, { label: uniq('TeeCrea') });
    const name = uniq('Corresp');

    await gotoAndWait(page, URL, 'GET', REF_API.externalEntities);
    await expect(page.getByRole('heading', { name: 'Entités externes' })).toBeVisible();
    const form = card(page, FORM);
    await form.getByLabel('Nom').fill(`  ${name}  `);
    // Le libellé « Type » couvre aussi le bouton « + » (Créer un type) : on vise la liste.
    await pickOption(page, form.getByRole('combobox', { name: 'Type' }), type.label);
    await form.getByLabel('E-mail').fill('contact@exemple.org');
    await form.getByLabel('Téléphone').fill('+221 33 000 00 00');

    const post = waitApi(page, 'POST', REF_API.externalEntities);
    const reload = waitApi(page, 'GET', REF_API.externalEntities);
    await form.getByRole('button', { name: 'Ajouter' }).click();
    const res = await post;
    expect(res.status()).toBe(201);
    expect(res.request().postDataJSON()).toEqual({
      label: name,
      email: 'contact@exemple.org',
      telephone: '+221 33 000 00 00',
      externalEntityTypeId: type.externalEntityTypeId,
    });
    const id = (await res.json()).externalEntityId as number;
    await reload;
    await expectToast(page, 'Entité externe créée');
    await expect(form.getByLabel('Nom')).toHaveValue('');

    // Filtre client par nom.
    const filter = page.getByLabel('Filtrer les correspondants par nom');
    await filter.fill(name.toLowerCase());
    const row = await findRow(page, name);
    await expect(row).toContainText(type.label);
    await expect(row).toContainText('contact@exemple.org');
    await expect(row).toContainText('+221 33 000 00 00');
    await filter.fill(`${name}-inexistant`);
    await expect(page.getByText('Aucun correspondant ne porte ce nom')).toBeVisible();

    expect(await entityById(api, id)).toMatchObject({
      label: name,
      externalEntityTypeId: type.externalEntityTypeId,
      externalEntityType: { label: type.label },
    });
  });

  test('COU-78 — modification en place : nom, type, e-mail (effacé), téléphone', async ({
    page,
    api,
    uniq,
  }) => {
    const typeA = await api.post(REF_API.externalEntityTypes, { label: uniq('TeeA') });
    const typeB = await api.post(REF_API.externalEntityTypes, { label: uniq('TeeB') });
    const name = uniq('Corresp');
    const created = (await api.post(REF_API.externalEntities, {
      label: name,
      email: 'avant@exemple.org',
      telephone: '111',
      externalEntityTypeId: typeA.externalEntityTypeId,
    })) as EntityRow;
    const patchPath = `${REF_API.externalEntities}/${created.externalEntityId}`;

    await gotoAndWait(page, URL, 'GET', REF_API.externalEntities);
    const filter = page.getByLabel('Filtrer les correspondants par nom');
    await filter.fill(name);

    // Nom.
    const renamed = `${name} renommé`;
    let row = await findRow(page, name);
    let res = await editInline(page, row, name, renamed, patchPath);
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ label: renamed });
    await expectToast(page, 'Modifié');

    // Type (EditableSelect) : clic sur le libellé courant, choix d'un autre type.
    row = await findRow(page, renamed);
    await row.getByRole('button', { name: typeA.label, exact: true }).click();
    await page.keyboard.type(typeB.label);
    const typePatch = waitApi(page, 'PATCH', patchPath);
    await openDropdown(page)
      .locator('.ant-select-item-option')
      .filter({ hasText: typeB.label })
      .first()
      .click();
    res = await typePatch;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ externalEntityTypeId: typeB.externalEntityTypeId });

    // E-mail effacé : champ optionnel, enregistré à null.
    row = await findRow(page, renamed);
    res = await editInline(page, row, 'avant@exemple.org', '', patchPath);
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ email: null });

    // Téléphone.
    row = await findRow(page, renamed);
    res = await editInline(page, row, '111', '222', patchPath);
    expect(res.status()).toBe(200);

    expect(await entityById(api, created.externalEntityId)).toMatchObject({
      label: renamed,
      email: null,
      telephone: '222',
      externalEntityTypeId: typeB.externalEntityTypeId,
    });
  });

  test('COU-79 — désactivation : sort de l’annuaire et des listes de correspondants du Départ', async ({
    page,
    api,
    uniq,
  }) => {
    const name = uniq('Corresp');
    const created = (await api.post(REF_API.externalEntities, { label: name })) as EntityRow;

    // Proposé comme destinataire externe d'un départ tant qu'il est actif.
    await gotoAndWait(page, '/courriers/depart', 'GET', REF_API.externalEntities);
    await expect(
      await optionsMatching(page, page.getByLabel('Destinataire externe'), name),
    ).toHaveCount(1);

    await gotoAndWait(page, URL, 'GET', REF_API.externalEntities);
    await page.getByLabel('Filtrer les correspondants par nom').fill(name);
    const row = await findRow(page, name);
    const reload = waitApi(page, 'GET', REF_API.externalEntities);
    const res = await deactivateRow(
      page,
      row,
      `Désactiver ${name}`,
      `${REF_API.externalEntities}/${created.externalEntityId}`,
    );
    expect(res.status()).toBe(200);
    await reload;
    await expectToast(page, 'Entité externe désactivée');
    await expectNoRow(page, name);
    expect(await entityById(api, created.externalEntityId)).toBeUndefined();

    await gotoAndWait(page, '/courriers/depart', 'GET', REF_API.externalEntities);
    await expect(
      await optionsMatching(page, page.getByLabel('Destinataire externe'), name),
    ).toHaveCount(0);
  });

  test('COU-80 — erreurs de saisie : nom vide, e-mail invalide, type inconnu, identifiant inconnu', async ({
    page,
    api,
    uniq,
  }) => {
    await gotoAndWait(page, URL, 'GET', REF_API.externalEntities);
    const form = card(page, FORM);
    const add = form.getByRole('button', { name: 'Ajouter' });
    await expect(add).toBeDisabled();
    await form.getByLabel('Nom').fill('   ');
    await expect(add).toBeDisabled();

    await form.getByLabel('Nom').fill(uniq('Corresp'));
    await expect(add).toBeEnabled();
    const email = form.getByLabel('E-mail');
    await email.fill('pas-une-adresse');
    await expect(add).toBeDisabled();
    await expect(email).toHaveClass(/ant-input-status-error/);
    await email.fill('ok@exemple.org');
    await expect(add).toBeEnabled();

    // API.
    expect((await api.raw.post(REF_API.externalEntities, { label: '  ' })).status()).toBe(400);
    expect(
      (await api.raw.post(REF_API.externalEntities, { label: uniq('c'), externalEntityTypeId: 0 })).status(),
    ).toBe(400);
    // Type inconnu : 400 lisible (violation de clé étrangère en 500 auparavant).
    const unknownType = await api.raw.post(REF_API.externalEntities, {
      label: uniq('c'),
      externalEntityTypeId: UNKNOWN_ID,
    });
    expect(unknownType.status()).toBe(400);
    const created = (await api.post(REF_API.externalEntities, { label: uniq('c') })) as EntityRow;
    const path = `${REF_API.externalEntities}/${created.externalEntityId}`;
    expect((await api.raw.patch(path, {})).status()).toBe(400);
    expect((await api.raw.patch(path, { externalEntityTypeId: UNKNOWN_ID })).status()).toBe(400);
    expect((await api.raw.patch(`${REF_API.externalEntities}/${UNKNOWN_ID}`, { label: 'x' })).status()).toBe(404);
    expect((await api.raw.del(`${REF_API.externalEntities}/${UNKNOWN_ID}`)).status()).toBe(404);
  });

  test('COU-80 — e-mail invalide refusé aussi par l’API (question ouverte)', async ({ api, uniq }) => {
    test.fixme(
      true,
      "Question métier : l'écran refuse une adresse invalide en citant `z.string().email()` côté API, " +
        "mais le DTO n'impose qu'une chaîne. Faut-il valider l'e-mail au serveur (400), au risque de " +
        'refuser la saisie rapide depuis l’enregistrement ?',
    );
    const res = await api.raw.post(REF_API.externalEntities, {
      label: uniq('c'),
      email: 'pas-une-adresse',
    });
    expect(res.status()).toBe(400);
  });

  test('COU-81 — bouton « + » du champ Type : type créé, sélectionné, refus d’un doublon', async ({
    page,
    api,
    uniq,
  }) => {
    const typeLabel = uniq('TeePlus');
    const name = uniq('Corresp');
    await gotoAndWait(page, URL, 'GET', REF_API.externalEntityTypes);
    const form = card(page, FORM);

    await form.getByRole('button', { name: "Créer un type d'entité externe" }).click();
    const dialog = page.getByRole('dialog', { name: "Nouveau type d'entité externe" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Créer' })).toBeDisabled();
    await dialog.getByLabel('Libellé').fill(typeLabel);
    const post = waitApi(page, 'POST', REF_API.externalEntityTypes);
    await dialog.getByRole('button', { name: 'Créer' }).click();
    const res = await post;
    expect(res.status()).toBe(201);
    const typeId = (await res.json()).externalEntityTypeId as number;
    await expectToast(page, /Type d.entité externe créé/);
    await expect(dialog).toBeHidden();
    // Sélectionné d'office dans le champ Type du formulaire.
    await expect(form.locator('.ant-select-selection-item')).toHaveText(typeLabel);

    // Le correspondant créé porte ce type.
    await form.getByLabel('Nom').fill(name);
    const postEntity = waitApi(page, 'POST', REF_API.externalEntities);
    await form.getByRole('button', { name: 'Ajouter' }).click();
    expect((await postEntity).request().postDataJSON()).toMatchObject({
      label: name,
      externalEntityTypeId: typeId,
    });

    // Même référentiel que l'écran dédié « Types d'entité externe ».
    const types = (await api.get(REF_API.externalEntityTypes)) as Array<{ label: string }>;
    expect(types.map((t) => t.label)).toContain(typeLabel);

    // Doublon (casse/espaces) : 409, message serveur, la modale reste ouverte.
    await form.getByRole('button', { name: "Créer un type d'entité externe" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Libellé')).toHaveValue(''); // repart d'un champ vide
    await dialog.getByLabel('Libellé').fill(` ${typeLabel.toUpperCase()} `);
    const dup = waitApi(page, 'POST', REF_API.externalEntityTypes);
    await dialog.getByRole('button', { name: 'Créer' }).click();
    expect((await dup).status()).toBe(409);
    await expectToast(page, /Un type d'entité externe actif porte déjà ce libellé/);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toBeHidden();
  });

  test('COU-82 — propriétés personnalisées (EAV) : définition, valeur par entité, refus motivés', async ({
    api,
    uniq,
  }) => {
    const type = await api.post(REF_API.externalEntityTypes, { label: uniq('TeeEav') });
    const typed = (await api.post(REF_API.externalEntities, {
      label: uniq('CorrEav'),
      externalEntityTypeId: type.externalEntityTypeId,
    })) as EntityRow;
    const untyped = (await api.post(REF_API.externalEntities, { label: uniq('CorrSansType') })) as EntityRow;

    // Définition d'une propriété (libellé normalisé, unique parmi les actives).
    const propLabel = uniq('Prop');
    const prop = await api.post(REF_API.customProperties, { label: `  ${propLabel} ` });
    expect(prop).toMatchObject({ label: propLabel });
    const propId = prop.externalEntityCustomPropertyId as number;
    expect(
      ((await api.get(REF_API.customProperties)) as Array<{ label: string }>).map((p) => p.label),
    ).toContain(propLabel);
    expect((await api.raw.post(REF_API.customProperties, { label: propLabel.toUpperCase() })).status()).toBe(409);
    expect((await api.raw.post(REF_API.customProperties, { label: '' })).status()).toBe(400);

    // Valeur : upsert (une valeur par propriété et entité), type déduit de l'entité.
    const first = await api.post(REF_API.customValues, {
      externalEntityId: typed.externalEntityId,
      externalEntityCustomPropertyId: propId,
      value: 'A',
    });
    expect(first).toMatchObject({ value: 'A', externalEntityTypeId: type.externalEntityTypeId });
    await api.post(REF_API.customValues, {
      externalEntityId: typed.externalEntityId,
      externalEntityCustomPropertyId: propId,
      value: 'B',
    });
    const values = (await api.get(
      `${REF_API.externalEntities}/${typed.externalEntityId}/custom-values`,
    )) as Array<{ value: string; externalEntityCustomPropertyId: number; customProperty: { label: string } }>;
    const mine = values.filter((v) => v.externalEntityCustomPropertyId === propId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ value: 'B', customProperty: { label: propLabel } });

    // Refus motivés.
    const noType = await api.raw.post(REF_API.customValues, {
      externalEntityId: untyped.externalEntityId,
      externalEntityCustomPropertyId: propId,
      value: 'x',
    });
    expect(noType.status()).toBe(409);
    expect(JSON.stringify(await noType.json())).toMatch(/n'a pas de type d'entité externe/);
    expect(
      (await api.raw.post(REF_API.customValues, {
        externalEntityId: UNKNOWN_ID,
        externalEntityCustomPropertyId: propId,
        value: 'x',
      })).status(),
    ).toBe(404);
    // Propriété inconnue : 404 lisible (violation de clé étrangère en 500 auparavant).
    expect(
      (await api.raw.post(REF_API.customValues, {
        externalEntityId: typed.externalEntityId,
        externalEntityCustomPropertyId: UNKNOWN_ID,
        value: 'x',
      })).status(),
    ).toBe(404);
    expect(
      (await api.raw.post(REF_API.customValues, {
        externalEntityId: typed.externalEntityId,
        externalEntityCustomPropertyId: propId,
      })).status(),
    ).toBe(400);

    // Désactivation de la définition.
    await api.del(`${REF_API.customProperties}/${propId}`);
    expect(
      ((await api.get(REF_API.customProperties)) as Array<{ label: string }>).map((p) => p.label),
    ).not.toContain(propLabel);
    expect((await api.raw.del(`${REF_API.customProperties}/${UNKNOWN_ID}`)).status()).toBe(404);
  });

  test('COU-83 — doublon de nom de correspondant (question ouverte)', async ({ api, uniq }) => {
    test.fixme(
      true,
      'Question métier : la source refuse un nom déjà porté (§17 « Unicité du nom », trim + minuscules ' +
        '+ sans espaces), la V6 n’applique aucun contrôle ni index sur `external_entity`. Faut-il ' +
        'refuser (409) — y compris depuis la création rapide de l’enregistrement — ou admettre des homonymes ?',
    );
    const name = uniq('Homonyme');
    await api.post(REF_API.externalEntities, { label: name });
    const dup = await api.raw.post(REF_API.externalEntities, { label: ` ${name.toUpperCase()} ` });
    expect(dup.status()).toBe(409);
  });
});
