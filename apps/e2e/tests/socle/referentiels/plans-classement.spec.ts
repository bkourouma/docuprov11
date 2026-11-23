/**
 * Référentiel « Plan de classement » (`/admin/classification-plans`) : arborescence, NOM requis,
 * CODE et PARENT facultatifs (un parent absent crée une racine), suppression en cascade.
 * Aucune contrainte d'unicité, ni sur le libellé ni sur le code (schéma) : voir le `fixme` final.
 */
import { test, expect } from '../../../fixtures';
import {
  SCREENS,
  createRef,
  dropCreated,
  listRef,
  openRef,
  refParentField,
  refTextbox,
  pickTreeNode,
  type Created,
} from '../_helpers/referentiels';
import { UNKNOWN_ID, confirmPopover, editInline, revealRow, rx, waitApi } from '../_helpers/securite';

const S = SCREENS.plans;
type Row = { planId: number; parentId: number | null; label: string; code: string | null; depth: number; path: string };

const created: Created[] = [];
test.afterEach(async ({ api }) => dropCreated(api, created));

test('SOC-67 créer une racine sans code et une rubrique cotée, éditer, vider le code, supprimer la branche', async ({
  page,
  api,
  uniq,
}) => {
  const rootLabel = uniq('SOC67 racine');
  const childLabel = uniq('SOC67 rubrique');
  const childCode = uniq('67');
  await openRef(page, S);

  // Racine : nom seul (ni code ni parent).
  await refTextbox(page, "Nom de l'élément").fill(rootLabel);
  let posted = waitApi(page, 'POST', '/referentials/plans');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  let res = await posted;
  expect(res.status()).toBe(201);
  const root = (await res.json()) as Row;
  created.push({ screen: S, id: root.planId });
  await expect(page.getByText('Élément créé')).toBeVisible();
  expect(root).toMatchObject({ parentId: null, code: null, depth: 0, path: `/${root.planId}/` });
  // Corps envoyé : `parentId` et `code` ABSENTS (un null explicite serait refusé en 400).
  expect(res.request().postDataJSON()).toEqual({ label: rootLabel });

  // Rubrique cotée sous la racine.
  await refTextbox(page, "Nom de l'élément").fill(childLabel);
  await refTextbox(page, 'Code').fill(childCode);
  await pickTreeNode(page, refParentField(page), rootLabel);
  posted = waitApi(page, 'POST', '/referentials/plans');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  res = await posted;
  expect(res.status()).toBe(201);
  const child = (await res.json()) as Row;
  created.push({ screen: S, id: child.planId });
  expect(child).toMatchObject({ parentId: root.planId, code: childCode, depth: 1 });

  await revealRow(page, rootLabel);
  const childRow = () => page.getByRole('row', { name: rx(childLabel) });
  await expect(childRow()).toBeVisible();

  // Code facultatif : le vider l'efface (null), l'écran affiche le tiret.
  const cleared = waitApi(page, 'PATCH', `/referentials/plans/${child.planId}`);
  await editInline(childRow(), childCode, '');
  expect((await cleared).status()).toBe(200);
  await expect(page.getByText('Modifié')).toBeVisible();
  expect((await listRef<Row>(api, S)).find((r) => r.planId === child.planId)?.code).toBeNull();

  // Renommer la racine.
  const renamed = uniq('SOC67 racine renommée');
  const patched = waitApi(page, 'PATCH', `/referentials/plans/${root.planId}`);
  await editInline(await revealRow(page, rootLabel), rootLabel, renamed);
  expect((await patched).status()).toBe(200);

  const rootRow = await revealRow(page, renamed);
  await rootRow.getByRole('button', { name: 'Supprimer cet élément' }).click();
  const deleted = waitApi(page, 'DELETE', `/referentials/plans/${root.planId}`);
  await confirmPopover(page, 'Supprimer');
  expect((await deleted).status()).toBe(200);
  expect(await (await deleted).json()).toEqual({ deactivated: true, count: 2 });
  await expect(page.getByText('Élément supprimé')).toBeVisible();
  await expect(childRow()).toHaveCount(0);
  const ids = (await listRef<Row>(api, S)).map((r) => r.planId);
  expect(ids).not.toContain(root.planId);
  expect(ids).not.toContain(child.planId);
});

test('SOC-67 saisies invalides : 400/404 lisibles, jamais 500', async ({ api, uniq }) => {
  const off = await createRef<Row>(api, created, S, { label: uniq('SOC67 désactivé') });
  await api.del(`/referentials/plans/${off.planId}`);

  const post = (body: unknown) => api.raw.post('/referentials/plans', body);
  expect((await post({ label: '  ' })).status(), 'nom blanc').toBe(400);
  expect((await post({ label: uniq('x'), parentId: null })).status(), 'parent null explicite').toBe(400);
  expect((await post({ label: uniq('x'), parentId: UNKNOWN_ID })).status(), 'parent inconnu').toBe(400);
  // Parent désactivé : refusé depuis le correctif de `resolveParent`.
  expect((await post({ label: uniq('x'), parentId: off.planId })).status(), 'parent désactivé').toBe(400);

  const ok = await createRef<Row>(api, created, S, { label: uniq('SOC67 cible') });
  const patch = (id: number, body: unknown) => api.raw.patch(`/referentials/plans/${id}`, body);
  const none = await patch(ok.planId, {});
  expect(none.status()).toBe(400);
  expect((await patch(ok.planId, { label: '' })).status(), 'nom vidé').toBe(400);
  expect((await patch(UNKNOWN_ID, { label: uniq('x') })).status()).toBe(404);
  expect((await api.raw.del(`/referentials/plans/${UNKNOWN_ID}`)).status()).toBe(404);
});

// Question métier ouverte (rapport tâche C) : le schéma n'impose aucune unicité au plan de
// classement — deux rubriques sœurs peuvent porter le même libellé et la même cote. Faut-il
// refuser une COTE en double (au moins parmi les actifs) ? Comportement attendu non décidé.
test.fixme('SOC-67 (question) cote en double parmi les rubriques actives : refus 409 attendu ?', async () => {});
