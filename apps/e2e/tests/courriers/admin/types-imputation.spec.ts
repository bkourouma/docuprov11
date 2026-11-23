/**
 * Types d'imputation (§18) — écran `/admin/courriers/types-imputation`.
 *
 * Les types 5 (Validation DG), 10 (Pour suivi), 14 (Validation Direction) et 17 (En copie) sont
 * référencés EN DUR par le workflow (`MailInputationTypeId`, packages/types) : l'écran les marque
 * « système » sans bouton de désactivation, et l'API refuse désormais leur désactivation (409).
 * Ils restent renommables et leur drapeau « suivi » modifiable (comportement actuel, non tranché).
 */
import { test, expect } from '../_helpers/test';
import { INPUTATION_TYPE } from '../_helpers';
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
  waitApi,
} from '../_helpers/admin-t4';

const URL = '/admin/courriers/types-imputation';
const FORM = "Nouveau type d'imputation";

interface TypeRow {
  mailInputationTypeId: number;
  label: string;
  suivi: boolean;
}

const SYSTEM_IDS = Object.values(INPUTATION_TYPE) as number[];

test.describe("Paramétrage courrier — types d'imputation", () => {
  // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
  // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
  // Délai triplé, aucune assertion modifiée.
  test.slow();
  test('COU-92 — types système 5/10/14/17 : marqués « système », non désactivables (écran et API)', async ({
    page,
    api,
  }) => {
    const all = (await api.get(REF_API.inputationTypes)) as TypeRow[];
    const system = all.filter((t) => SYSTEM_IDS.includes(t.mailInputationTypeId));
    // Le seed du module doit fournir les quatre types du workflow, actifs.
    expect(system.map((t) => t.mailInputationTypeId).sort((a, b) => a - b)).toEqual([5, 10, 14, 17]);

    await gotoAndWait(page, URL, 'GET', REF_API.inputationTypes);
    for (const t of system) {
      const row = await findRow(page, t.label);
      await expect(row.getByText('système', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: `Désactiver le type ${t.label}` })).toHaveCount(0);
    }

    for (const id of SYSTEM_IDS) {
      const res = await api.raw.del(`${REF_API.inputationTypes}/${id}`);
      expect(res.status()).toBe(409);
      expect(JSON.stringify(await res.json())).toMatch(/système/);
    }
    const after = (await api.get(REF_API.inputationTypes)) as TypeRow[];
    expect(after.filter((t) => SYSTEM_IDS.includes(t.mailInputationTypeId))).toHaveLength(4);
  });

  test('COU-93 — création avec « suivi », bascule du suivi, renommage, désactivation d’un type non système', async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('Imput');
    await gotoAndWait(page, URL, 'GET', REF_API.inputationTypes);
    await expect(page.getByRole('heading', { name: "Types d'imputation" })).toBeVisible();

    const form = card(page, FORM);
    await form.getByLabel('Libellé').fill(label);
    const suiviSwitch = form.getByRole('switch', { name: 'Traitement automatique à la lecture' });
    await suiviSwitch.click();
    await expect(suiviSwitch).toHaveAttribute('aria-checked', 'true');
    const post = waitApi(page, 'POST', REF_API.inputationTypes);
    let reload = waitApi(page, 'GET', REF_API.inputationTypes);
    await form.getByRole('button', { name: 'Ajouter' }).click();
    const res = await post;
    expect(res.status()).toBe(201);
    expect(res.request().postDataJSON()).toEqual({ label, suivi: true });
    const id = (await res.json()).mailInputationTypeId as number;
    await reload;
    await expectToast(page, "Type d'imputation créé");
    await expect(suiviSwitch).toHaveAttribute('aria-checked', 'false'); // formulaire remis à zéro

    // Ligne : pas de marqueur système, interrupteur coché ; bascule → PATCH { suivi: false }.
    let row = await findRow(page, label);
    await expect(row.getByText('système', { exact: true })).toHaveCount(0);
    const rowSwitch = row.getByRole('switch', { name: `Traitement automatique à la lecture pour « ${label} »` });
    await expect(rowSwitch).toHaveAttribute('aria-checked', 'true');
    const patch = waitApi(page, 'PATCH', `${REF_API.inputationTypes}/${id}`);
    await rowSwitch.click();
    const patched = await patch;
    expect(patched.status()).toBe(200);
    expect(patched.request().postDataJSON()).toEqual({ suivi: false });
    await expectToast(page, 'Modifié');
    await expect(
      (await findRow(page, label)).getByRole('switch', {
        name: `Traitement automatique à la lecture pour « ${label} »`,
      }),
    ).toHaveAttribute('aria-checked', 'false');

    // Renommage.
    const renamed = `${label} renommé`;
    row = await findRow(page, label);
    expect((await editInline(page, row, label, renamed, `${REF_API.inputationTypes}/${id}`)).status()).toBe(200);

    // Proposé au lookup des imputations (fiche/parapheur) avec son drapeau.
    expect(((await api.get(REF_API.inputationTypes)) as TypeRow[]).find((t) => t.mailInputationTypeId === id))
      .toMatchObject({ label: renamed, suivi: false });

    // Désactivation.
    row = await findRow(page, renamed);
    reload = waitApi(page, 'GET', REF_API.inputationTypes);
    const del = await deactivateRow(
      page,
      row,
      `Désactiver le type ${renamed}`,
      `${REF_API.inputationTypes}/${id}`,
    );
    expect(del.status()).toBe(200);
    await reload;
    await expectToast(page, 'Type désactivé');
    await expectNoRow(page, renamed);
    expect(
      ((await api.get(REF_API.inputationTypes)) as TypeRow[]).some((t) => t.mailInputationTypeId === id),
    ).toBe(false);
  });

  test('COU-94 — erreurs de saisie : libellé vide, doublon normalisé, corps invalide, inconnu', async ({
    page,
    api,
    uniq,
  }) => {
    const label = uniq('Imput');
    const created = (await api.post(REF_API.inputationTypes, { label })) as TypeRow;

    await gotoAndWait(page, URL, 'GET', REF_API.inputationTypes);
    const form = card(page, FORM);
    const add = form.getByRole('button', { name: 'Ajouter' });
    await expect(add).toBeDisabled();
    await form.getByLabel('Libellé').fill('  ');
    await expect(add).toBeDisabled();
    await form.getByLabel('Libellé').fill(` ${label.toUpperCase()} `);
    const post = waitApi(page, 'POST', REF_API.inputationTypes);
    await add.click();
    expect((await post).status()).toBe(409);
    await expectToast(page, /Un type d'imputation actif porte déjà ce libellé/);

    const path = `${REF_API.inputationTypes}/${created.mailInputationTypeId}`;
    expect((await api.raw.post(REF_API.inputationTypes, { label: '' })).status()).toBe(400);
    expect((await api.raw.post(REF_API.inputationTypes, { label: uniq('i'), suivi: 'oui' })).status()).toBe(400);
    expect((await api.raw.patch(path, {})).status()).toBe(400);
    expect((await api.raw.patch(path, { label: label.toLowerCase() })).status()).toBe(200); // sa propre casse
    expect((await api.raw.patch(`${REF_API.inputationTypes}/${UNKNOWN_ID}`, { suivi: true })).status()).toBe(404);
    expect((await api.raw.del(`${REF_API.inputationTypes}/${UNKNOWN_ID}`)).status()).toBe(404);
  });
});
