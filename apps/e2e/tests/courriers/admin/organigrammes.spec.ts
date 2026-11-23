/**
 * Organigrammes (§14 — arbre en chemin matérialisé) et rattachement rôle ↔ organigramme (§15).
 *
 * Code lu : apps/web/app/admin/courriers/{organigrammes,role-organigramme}/page.tsx,
 * components/editable.tsx (EditableLocation), apps/api/src/modules/courriers/
 * organigramme.{controller,service,dto}.ts, domain/organigramme.ts, mails.service.ts
 * (`deriveOrganigramme` : l'organigramme d'un courrier = celui du rôle destinataire).
 */
import { test, expect } from '../_helpers/test';
import { MENUS, createArrivee, createCourrierActor, getMail } from '../_helpers';
import {
  REF_API,
  UNKNOWN_ID,
  card,
  createOrgNode,
  deactivateRow,
  editInline,
  expectNoRow,
  expectToast,
  findRow,
  gotoAndWait,
  listOrgNodes,
  pickTreeNode,
  waitApi,
} from '../_helpers/admin-t4';

const URL = '/admin/courriers/organigrammes';
const ROLE_URL = '/admin/courriers/role-organigramme';
const ROOT = '— Racine —';

test.describe('Paramétrage courrier — organigrammes', () => {
  // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
  // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
  // Délai triplé, aucune assertion modifiée.
  test.slow();
  test('COU-84 — création d’une racine puis d’un enfant : arbre, chemin et profondeur', async ({
    page,
    uniq,
  }) => {
    const rootLabel = uniq('Direction');
    const childLabel = uniq('Service');
    await gotoAndWait(page, URL, 'GET', REF_API.organigramme);
    await expect(page.getByRole('heading', { name: 'Organigrammes' })).toBeVisible();
    const form = card(page, 'Nouveau nœud');

    // Racine (parent vide).
    await form.getByLabel('Nom du nœud').fill(rootLabel);
    let post = waitApi(page, 'POST', REF_API.organigramme);
    let reload = waitApi(page, 'GET', REF_API.organigramme);
    await form.getByRole('button', { name: 'Ajouter' }).click();
    let res = await post;
    expect(res.status()).toBe(201);
    expect(res.request().postDataJSON()).toEqual({ label: rootLabel });
    const root = await res.json();
    expect(root).toMatchObject({ parentId: null, depth: 0, path: `/${root.organigrammeId}/` });
    await reload;
    await expectToast(page, 'Nœud créé');
    await expect((await findRow(page, rootLabel)).getByRole('button', { name: ROOT })).toBeVisible();

    // Enfant : parent choisi dans l'arbre.
    await form.getByLabel('Nom du nœud').fill(childLabel);
    await form.getByLabel('Parent (vide = racine)').click();
    await pickTreeNode(page, rootLabel);
    post = waitApi(page, 'POST', REF_API.organigramme);
    reload = waitApi(page, 'GET', REF_API.organigramme);
    await form.getByRole('button', { name: 'Ajouter' }).click();
    res = await post;
    expect(res.status()).toBe(201);
    expect(res.request().postDataJSON()).toEqual({
      label: childLabel,
      parentId: root.organigrammeId,
    });
    const child = await res.json();
    expect(child).toMatchObject({
      parentId: root.organigrammeId,
      depth: 1,
      path: `${root.path}${child.organigrammeId}/`,
    });
    await reload;
    await expect(
      (await findRow(page, childLabel)).getByRole('button', { name: rootLabel, exact: true }),
    ).toBeVisible();
  });

  test('COU-85 — renommage en place d’un nœud, repris dans la colonne Parent de ses enfants', async ({
    page,
    api,
    uniq,
  }) => {
    const parent = await createOrgNode(api, uniq('Direction'));
    const child = await createOrgNode(api, uniq('Service'), parent.organigrammeId);
    const renamed = `${parent.label} renommée`;

    await gotoAndWait(page, URL, 'GET', REF_API.organigramme);
    const row = await findRow(page, parent.label);
    const res = await editInline(
      page,
      row,
      parent.label,
      `  ${renamed}  `,
      `${REF_API.organigramme}/${parent.organigrammeId}`,
    );
    expect(res.status()).toBe(200);
    await expectToast(page, 'Modifié');
    await expect(
      (await findRow(page, child.label)).getByRole('button', { name: renamed, exact: true }),
    ).toBeVisible();
    const nodes = await listOrgNodes(api);
    expect(nodes.find((n) => n.organigrammeId === parent.organigrammeId)?.label).toBe(renamed);
  });

  test('COU-86 — déplacement d’un nœud par la colonne Parent : tout le sous-arbre suit', async ({
    page,
    api,
    uniq,
  }) => {
    const a = await createOrgNode(api, uniq('OrgA'));
    const b = await createOrgNode(api, uniq('OrgB'));
    const c = await createOrgNode(api, uniq('OrgC'), a.organigrammeId);
    const d = await createOrgNode(api, uniq('OrgD'), c.organigrammeId);

    await gotoAndWait(page, URL, 'GET', REF_API.organigramme);
    const row = await findRow(page, c.label);
    await row.getByRole('button', { name: a.label, exact: true }).click();
    const patch = waitApi(page, 'PATCH', `${REF_API.organigramme}/${c.organigrammeId}/parent`);
    await pickTreeNode(page, b.label);
    const res = await patch;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ parentId: b.organigrammeId });
    await expectToast(page, 'Nœud déplacé');
    await expect(
      (await findRow(page, c.label)).getByRole('button', { name: b.label, exact: true }),
    ).toBeVisible();

    const nodes = await listOrgNodes(api);
    const byId = (id: number) => nodes.find((n) => n.organigrammeId === id)!;
    expect(byId(c.organigrammeId)).toMatchObject({
      parentId: b.organigrammeId,
      path: `${b.path}${c.organigrammeId}/`,
      depth: 1,
    });
    expect(byId(d.organigrammeId)).toMatchObject({
      parentId: c.organigrammeId,
      path: `${b.path}${c.organigrammeId}/${d.organigrammeId}/`,
      depth: 2,
    });

    // Retour à la racine : exposé par l'API seulement (le sélecteur de parent n'a pas d'option
    // « Racine » une fois un parent posé — cf. COU-91 pour la même limite côté rôles).
    await api.patch(`${REF_API.organigramme}/${c.organigrammeId}/parent`, { parentId: null });
    const after = await listOrgNodes(api);
    expect(after.find((n) => n.organigrammeId === c.organigrammeId)).toMatchObject({
      parentId: null,
      path: `/${c.organigrammeId}/`,
      depth: 0,
    });
    expect(after.find((n) => n.organigrammeId === d.organigrammeId)).toMatchObject({
      path: `/${c.organigrammeId}/${d.organigrammeId}/`,
      depth: 1,
    });
  });

  test('COU-87 — déplacements interdits : sous un descendant, sous soi-même, parent inconnu ou désactivé', async ({
    page,
    api,
    uniq,
  }) => {
    const a = await createOrgNode(api, uniq('OrgA'));
    const c = await createOrgNode(api, uniq('OrgC'), a.organigrammeId);
    const off = await createOrgNode(api, uniq('OrgOff'));
    await api.del(`${REF_API.organigramme}/${off.organigrammeId}`);
    const parentPath = `${REF_API.organigramme}/${a.organigrammeId}/parent`;

    await gotoAndWait(page, URL, 'GET', REF_API.organigramme);
    // Sous son propre descendant : cycle refusé, rien ne bouge.
    let row = await findRow(page, a.label);
    await row.getByRole('button', { name: ROOT }).click();
    let patch = waitApi(page, 'PATCH', parentPath);
    await pickTreeNode(page, c.label);
    expect((await patch).status()).toBe(400);
    await expectToast(page, 'Déplacement cyclique interdit');

    // Sous lui-même.
    row = await findRow(page, a.label);
    await row.getByRole('button', { name: ROOT }).click();
    patch = waitApi(page, 'PATCH', parentPath);
    await pickTreeNode(page, a.label);
    expect((await patch).status()).toBe(400);
    await expectToast(page, 'Un nœud ne peut être son propre parent');
    await expect((await findRow(page, a.label)).getByRole('button', { name: ROOT })).toBeVisible();

    // API : parent inconnu, parent désactivé, corps invalide.
    expect((await api.raw.patch(parentPath, { parentId: UNKNOWN_ID })).status()).toBe(400);
    expect((await api.raw.patch(parentPath, { parentId: off.organigrammeId })).status()).toBe(400);
    expect((await api.raw.patch(parentPath, {})).status()).toBe(400);
    expect(
      (await api.raw.patch(`${REF_API.organigramme}/${UNKNOWN_ID}/parent`, { parentId: null })).status(),
    ).toBe(404);
    const nodes = await listOrgNodes(api);
    expect(nodes.find((n) => n.organigrammeId === a.organigrammeId)).toMatchObject({
      parentId: null,
      path: `/${a.organigrammeId}/`,
    });
  });

  test('COU-88 — désactivation d’un nœud : tout son sous-arbre disparaît, le reste demeure', async ({
    page,
    api,
    uniq,
  }) => {
    const a = await createOrgNode(api, uniq('OrgA'));
    const b = await createOrgNode(api, uniq('OrgB'), a.organigrammeId);
    const c = await createOrgNode(api, uniq('OrgC'), b.organigrammeId);
    const sibling = await createOrgNode(api, uniq('OrgS'), a.organigrammeId);

    await gotoAndWait(page, URL, 'GET', REF_API.organigramme);
    const row = await findRow(page, b.label);
    const reload = waitApi(page, 'GET', REF_API.organigramme);
    const res = await deactivateRow(
      page,
      row,
      `Désactiver le nœud ${b.label}`,
      `${REF_API.organigramme}/${b.organigrammeId}`,
    );
    expect(res.status()).toBe(200);
    await reload;
    await expectToast(page, 'Nœud et son sous-arbre désactivés');
    await expectNoRow(page, b.label);
    await expectNoRow(page, c.label);
    await expect(await findRow(page, a.label)).toBeVisible();
    await expect(await findRow(page, sibling.label)).toBeVisible();

    const ids = (await listOrgNodes(api)).map((n) => n.organigrammeId);
    expect(ids).toEqual(expect.arrayContaining([a.organigrammeId, sibling.organigrammeId]));
    expect(ids).not.toContain(b.organigrammeId);
    expect(ids).not.toContain(c.organigrammeId);
  });

  test('COU-89 — erreurs de saisie : nom vide, parent inconnu ou désactivé, nœud inconnu', async ({
    page,
    api,
    uniq,
  }) => {
    await gotoAndWait(page, URL, 'GET', REF_API.organigramme);
    const form = card(page, 'Nouveau nœud');
    const add = form.getByRole('button', { name: 'Ajouter' });
    await expect(add).toBeDisabled();
    await form.getByLabel('Nom du nœud').fill('   ');
    await expect(add).toBeDisabled();

    const off = await createOrgNode(api, uniq('OrgOff'));
    await api.del(`${REF_API.organigramme}/${off.organigrammeId}`);
    expect((await api.raw.post(REF_API.organigramme, { label: '' })).status()).toBe(400);
    expect((await api.raw.post(REF_API.organigramme, { label: uniq('o'), parentId: UNKNOWN_ID })).status()).toBe(400);
    // Parent désactivé : refusé (créait un enfant actif orphelin, affiché comme une fausse racine).
    expect(
      (await api.raw.post(REF_API.organigramme, { label: uniq('o'), parentId: off.organigrammeId })).status(),
    ).toBe(400);
    const node = await createOrgNode(api, uniq('Org'));
    expect((await api.raw.patch(`${REF_API.organigramme}/${node.organigrammeId}`, { label: ' ' })).status()).toBe(400);
    expect((await api.raw.patch(`${REF_API.organigramme}/${UNKNOWN_ID}`, { label: 'x' })).status()).toBe(404);
    expect((await api.raw.del(`${REF_API.organigramme}/${UNKNOWN_ID}`)).status()).toBe(404);
  });

  test('COU-89 — deux nœuds frères homonymes (question ouverte)', async ({ api, uniq }) => {
    test.fixme(
      true,
      'Question métier : la source dédoublonne les noms à la création multiple (§14, trim + minuscules ' +
        '+ sans espaces) ; la V6 ne contrôle aucun doublon d’organigramme. Refus (409) entre frères, ' +
        'dans tout l’arbre, ou homonymes admis ?',
    );
    const parent = await createOrgNode(api, uniq('Direction'));
    const label = uniq('Service');
    await createOrgNode(api, label, parent.organigrammeId);
    const dup = await api.raw.post(REF_API.organigramme, {
      label: label.toUpperCase(),
      parentId: parent.organigrammeId,
    });
    expect(dup.status()).toBe(409);
  });
});

test.describe('Paramétrage courrier — rôles ↔ organigramme', () => {
  // Écrans de paramétrage : plusieurs navigations, éditions en place et pagination des
  // référentiels partagés par toute la suite ; sous la charge des autres lots ils dépassent 60 s.
  // Délai triplé, aucune assertion modifiée.
  test.slow();
  test('COU-90 — rattacher un rôle à un nœud ; le courrier enregistré pour ce rôle en hérite', async ({
    page,
    api,
    uniq,
  }) => {
    const actor = await createCourrierActor(api, { prefix: uniq('roleorg'), menus: [MENUS.controle] });
    const node = await createOrgNode(api, uniq('Direction'));

    await gotoAndWait(page, ROLE_URL, 'GET', REF_API.roleAssignments);
    await expect(page.getByRole('heading', { name: 'Rôles ↔ organigramme' })).toBeVisible();
    let row = await findRow(page, actor.roleName);
    await expect(row.getByText('Non rattaché')).toBeVisible();

    await row.getByRole('button', { name: '—' }).click();
    const patch = waitApi(page, 'PATCH', `${REF_API.organigramme}/roles/${actor.roleId}`);
    await pickTreeNode(page, node.label);
    const res = await patch;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ organigrammeId: node.organigrammeId });
    await expectToast(page, 'Assignation enregistrée');
    row = await findRow(page, actor.roleName);
    await expect(row.getByRole('button', { name: node.label, exact: true })).toBeVisible();
    await expect(row.getByText('Non rattaché')).toHaveCount(0);

    const assignments = (await api.get(REF_API.roleAssignments)) as Array<{
      roleId: number;
      organigrammeId: number | null;
    }>;
    expect(assignments.find((r) => r.roleId === actor.roleId)?.organigrammeId).toBe(node.organigrammeId);

    // Dérivation à l'enregistrement : le courrier destiné à ce rôle porte son organigramme.
    const mail = await createArrivee(api, { title: uniq('Courrier org'), destinataireRoleId: actor.roleId });
    const detail = await getMail(api, mail.mailId);
    expect(detail.organigramme?.label).toBe(node.label);
  });

  test('COU-91 — rattachement : nœud inconnu ou désactivé refusé, rôle inconnu, détachement par l’API', async ({
    page,
    api,
    uniq,
  }) => {
    const actor = await createCourrierActor(api, { prefix: uniq('roleorg'), menus: [MENUS.controle] });
    const node = await createOrgNode(api, uniq('Direction'));
    const off = await createOrgNode(api, uniq('OrgOff'));
    await api.del(`${REF_API.organigramme}/${off.organigrammeId}`);
    const path = `${REF_API.organigramme}/roles/${actor.roleId}`;

    expect((await api.raw.patch(path, { organigrammeId: UNKNOWN_ID })).status()).toBe(400);
    expect((await api.raw.patch(path, { organigrammeId: off.organigrammeId })).status()).toBe(400);
    expect((await api.raw.patch(path, {})).status()).toBe(400);
    expect(
      (await api.raw.patch(`${REF_API.organigramme}/roles/${UNKNOWN_ID}`, { organigrammeId: node.organigrammeId })).status(),
    ).toBe(404);

    await api.patch(path, { organigrammeId: node.organigrammeId });
    await api.patch(path, { organigrammeId: null });
    await gotoAndWait(page, ROLE_URL, 'GET', REF_API.roleAssignments);
    await expect((await findRow(page, actor.roleName)).getByText('Non rattaché')).toBeVisible();
    const mail = await createArrivee(api, { title: uniq('Courrier sans org'), destinataireRoleId: actor.roleId });
    expect((await getMail(api, mail.mailId)).organigramme ?? null).toBeNull();
  });

  test('COU-91 — détacher un rôle depuis l’écran (question ouverte)', async ({ page, api, uniq }) => {
    test.fixme(
      true,
      'Question métier / UX : le sélecteur en place (EditableLocation) n’offre ni effacement ni option ' +
        '« aucun » : une fois rattaché, un rôle ne peut plus être détaché que par l’API (null accepté). ' +
        'Faut-il un bouton « Détacher » (la source avait « Clear » + « UpdateAssignment ») ?',
    );
    const actor = await createCourrierActor(api, { prefix: uniq('roleorg'), menus: [MENUS.controle] });
    const node = await createOrgNode(api, uniq('Direction'));
    await api.patch(`${REF_API.organigramme}/roles/${actor.roleId}`, { organigrammeId: node.organigrammeId });
    await gotoAndWait(page, ROLE_URL, 'GET', REF_API.roleAssignments);
    const row = await findRow(page, actor.roleName);
    await row.getByRole('button', { name: /Détacher/ }).click();
    await expect(row.getByText('Non rattaché')).toBeVisible();
  });
});
