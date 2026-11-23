/**
 * Permissions de menu du module Docu-Courriers — spec TRANSVERSE (écrans opérationnels
 * `/courriers/*` et de paramétrage `/admin/courriers/*`).
 *
 * Comment l'application refuse (code lu, non modifié) :
 *  - barre latérale : `AuthShell` filtre `NAV` (components/nav.ts) sur `menuKeys` de `/auth/me`
 *    (règle unique `effectiveMenuKeys`, partagée avec le garde API) ; `altKeys` ouvre une entrée
 *    par une permission alternative (Suivi ← `/courriers/suivi-dc`) ;
 *  - URL directe : il n'existe AUCUNE garde de route côté web. L'écran se monte ; le refus vient
 *    de l'API (`MenuPermissionGuard` → 403 « Vous n'avez pas accès à cette section. »), affiché en
 *    notification par l'écran. Les écrans dont le chargement n'appelle pas d'endpoint gardé
 *    (Enregistrement, Départ, et tout le paramétrage dont les LECTURES sont ouvertes à tout
 *    utilisateur authentifié) ne refusent qu'à l'écriture. La question « faut-il refuser l'écran
 *    lui-même ? » est posée par le test.fixme de COU-95 ;
 *  - écrans MASQUÉS (natures, objets, confidentialités — HIDDEN_MENU_KEYS) : absents de la barre
 *    latérale et du catalogue assignable ; `sanitizeMenuKeys` les retire d'un rôle à
 *    l'enregistrement. Seuls l'administrateur et le rôle système y ont accès (COU-99).
 *
 * Témoin : l'acteur refusé détient UN autre menu de la même section (choisi pour ne donner accès
 * à aucun endpoint de l'écran testé), sinon la section entière disparaîtrait et l'absence de
 * l'entrée ne prouverait rien.
 */
import type { APIResponse } from '@playwright/test';
import { test, expect } from './_helpers/test';
import type { ApiClient } from '../../fixtures';
import { MENUS, createCourrierActor, type CourrierActor } from './_helpers';
import {
  FORBIDDEN_MESSAGE,
  REF_API,
  UNKNOWN_ID,
  card,
  createOrgNode,
  expectToast,
  gotoAndWait,
  navEntry,
  navSection,
  waitApi,
} from './_helpers/admin-t4';

type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Call {
  method: Verb;
  path: string;
  body?: unknown;
}

/** Appel sans levée (statut lu par le test). */
function send(client: ApiClient, c: Call): Promise<APIResponse> {
  switch (c.method) {
    case 'GET':
      return client.raw.get(c.path);
    case 'POST':
      return client.raw.post(c.path, c.body ?? {});
    case 'PUT':
      return client.raw.put(c.path, c.body ?? {});
    case 'PATCH':
      return client.raw.patch(c.path, c.body ?? {});
    case 'DELETE':
      return client.raw.del(c.path);
  }
}

// ---------------------------------------------------------------------------------------------
// Écrans opérationnels
// ---------------------------------------------------------------------------------------------

interface OpScreen {
  menu: string;
  url: string;
  /** Libellé de l'entrée de barre latérale (nav.ts). */
  nav: string;
  /** Titre de l'écran (PageHeader). */
  title: string;
  /** Endpoint gardé de LECTURE (celui que l'écran appelle à son montage si `loadsOnMount`). */
  load: Call;
  loadsOnMount: boolean;
  /** Écriture gardée par ce seul menu (ou par une liste qui exclut le témoin). Corps vide :
   *  le garde passe AVANT la validation, un refus rend donc 403 et non 400. */
  write: Call;
}

const OPS: OpScreen[] = [
  {
    menu: MENUS.tableauDeBord,
    url: MENUS.tableauDeBord,
    nav: 'Tableau de bord',
    title: 'Tableau de bord courrier',
    load: { method: 'GET', path: '/courriers/dashboard/layout' },
    loadsOnMount: true,
    write: { method: 'PUT', path: '/courriers/dashboard/layout', body: { widgets: [] } },
  },
  {
    menu: MENUS.enregistrement,
    url: MENUS.enregistrement,
    nav: 'Enregistrement',
    title: "Enregistrement d'un courrier",
    load: { method: 'GET', path: '/courriers/next-reference/arrivee' },
    loadsOnMount: false,
    write: { method: 'POST', path: '/courriers/arrivee' },
  },
  {
    menu: MENUS.controle,
    url: MENUS.controle,
    nav: 'Courriers arrivés',
    title: 'Courriers arrivés',
    load: { method: 'GET', path: '/courriers/controle' },
    loadsOnMount: true,
    write: { method: 'POST', path: `/courriers/${UNKNOWN_ID}/valider` },
  },
  {
    menu: MENUS.documentsScannes,
    url: MENUS.documentsScannes,
    nav: 'Documents scannés',
    title: 'Documents scannés',
    load: { method: 'GET', path: '/courriers/documents-scannes' },
    loadsOnMount: true,
    write: { method: 'POST', path: '/courriers/documents-scannes' },
  },
  {
    menu: MENUS.parapheur,
    url: MENUS.parapheur,
    nav: 'Courriers Imputés',
    title: 'Courriers Imputés',
    load: { method: 'GET', path: '/courriers/parapheur' },
    loadsOnMount: true,
    write: { method: 'POST', path: '/courriers/imputations/validation' },
  },
  {
    menu: MENUS.suivi,
    url: MENUS.suivi,
    nav: 'Suivi des courriers',
    title: 'Suivi des courriers',
    load: { method: 'GET', path: '/courriers/suivi' },
    loadsOnMount: true,
    write: { method: 'POST', path: `/courriers/${UNKNOWN_ID}/fiche-imputation/pdf` },
  },
  {
    menu: MENUS.validation,
    url: MENUS.validation,
    nav: 'Validation',
    title: 'Validation',
    load: { method: 'GET', path: '/courriers/validation-direction' },
    loadsOnMount: true,
    write: { method: 'POST', path: '/courriers/validation-direction' },
  },
  {
    menu: MENUS.recherche,
    url: MENUS.recherche,
    nav: 'Recherche courrier',
    title: 'Recherche courrier',
    load: { method: 'POST', path: '/courriers/recherche', body: {} },
    loadsOnMount: true,
    write: { method: 'POST', path: '/courriers/recherche', body: {} },
  },
  {
    menu: MENUS.depart,
    url: MENUS.depart,
    nav: 'Courrier de départ',
    title: 'Courrier de départ',
    load: { method: 'GET', path: '/courriers/depart' },
    loadsOnMount: false,
    write: { method: 'POST', path: '/courriers/depart' },
  },
  {
    menu: MENUS.integrationDecharge,
    url: MENUS.integrationDecharge,
    nav: 'Intégration décharge',
    title: 'Intégration décharge',
    load: { method: 'GET', path: '/courriers/decharges-en-attente' },
    loadsOnMount: true,
    write: { method: 'POST', path: `/courriers/${UNKNOWN_ID}/integration-decharge` },
  },
];

const opByMenu = (menu: string) => OPS.find((o) => o.menu === menu)!;
/** Recherche ne figure dans aucune liste multi-menus d'endpoint : témoin neutre (Départ pour elle). */
const opWitness = (s: OpScreen) => opByMenu(s.menu === MENUS.recherche ? MENUS.depart : MENUS.recherche);

test.describe('Permissions Docu-Courriers — écrans opérationnels', () => {
  for (const s of OPS) {
    test(`COU-95 — [${s.nav}] sans le menu : entrée absente, chargement et écriture refusés (403)`, async ({
      page,
      api,
      uniq,
      loginAs,
      apiAs,
    }) => {
      const witness = opWitness(s);
      const actor = await createCourrierActor(api, { prefix: uniq('perm'), menus: [witness.menu] });
      const actorApi = await apiAs(actor.username, actor.password);

      // API : lecture gardée et écriture refusées par le garde de menu.
      const read = await send(actorApi, s.load);
      expect(read.status()).toBe(403);
      expect(JSON.stringify(await read.json())).toContain(FORBIDDEN_MESSAGE);
      expect((await send(actorApi, s.write)).status()).toBe(403);

      // Barre latérale : la section est là (témoin), l'entrée testée n'y est pas.
      await loginAs(page, actor.username, actor.password);
      await page.goto(witness.url);
      const section = navSection(page, 'Docu-Courriers');
      await expect(navEntry(section, witness.nav)).toBeVisible();
      await expect(navEntry(section, s.nav)).toHaveCount(0);

      // URL directe : l'écran se monte mais son chargement est refusé et le dit.
      if (s.loadsOnMount) {
        const refused = waitApi(page, s.load.method, s.load.path);
        await page.goto(s.url);
        expect((await refused).status()).toBe(403);
        await expectToast(page, FORBIDDEN_MESSAGE);
      }
    });

    test(`COU-96 — [${s.nav}] avec le menu : entrée visible, écran chargé, lecture autorisée`, async ({
      page,
      api,
      uniq,
      loginAs,
      apiAs,
    }) => {
      const actor = await createCourrierActor(api, { prefix: uniq('perm'), menus: [s.menu] });
      const actorApi = await apiAs(actor.username, actor.password);
      expect((await send(actorApi, s.load)).status()).toBe(200);

      await loginAs(page, actor.username, actor.password);
      if (s.loadsOnMount) {
        const loaded = await gotoAndWait(page, s.url, s.load.method, s.load.path);
        expect(loaded.status()).toBe(200);
      } else {
        await page.goto(s.url);
      }
      await expect(page.getByRole('heading', { name: s.title })).toBeVisible();
      await expect(navEntry(navSection(page, 'Docu-Courriers'), s.nav)).toBeVisible();
    });
  }

  test('COU-96 — [Suivi DC] la permission de périmètre ouvre l’entrée « Suivi des courriers » et sa fiche d’imputation', async ({
    page,
    api,
    uniq,
    loginAs,
    apiAs,
  }) => {
    const actor = await createCourrierActor(api, { prefix: uniq('permdc'), menus: [MENUS.suiviDC] });
    const actorApi = await apiAs(actor.username, actor.password);
    expect((await actorApi.raw.get('/courriers/suivi')).status()).toBe(200);
    // Le bouton « Fiche d'imputation » est proposé sur cet écran : la route doit admettre la
    // permission DC comme les autres routes du Suivi (MAIL_WORKFLOW_MENUS). Courrier inconnu → 404,
    // pas 403. (Anomalie suspectée : mails.controller.ts n'exige que MENU_SUIVI.)
    expect((await actorApi.raw.post(`/courriers/${UNKNOWN_ID}/fiche-imputation/pdf`, {})).status()).toBe(404);

    await loginAs(page, actor.username, actor.password);
    const loaded = await gotoAndWait(page, MENUS.suivi, 'GET', '/courriers/suivi');
    expect(loaded.status()).toBe(200);
    await expect(navEntry(navSection(page, 'Docu-Courriers'), 'Suivi des courriers')).toBeVisible();
  });

  // Décision de l'utilisateur : écran « Accès refusé » dès l'ouverture (AuthShell, lot transverse).
  // Le 403 de l'API est vérifié dès maintenant par les tests COU-95 paramétrés ci-dessus.
  test('COU-95 — accès direct par URL à un écran non autorisé : écran « Accès refusé »', async ({
    page,
    api,
    uniq,
    loginAs,
  }) => {
    test.fixme(true, 'en attente du lot transverse : écran Accès refusé');
    const actor = await createCourrierActor(api, { prefix: uniq('perm'), menus: [MENUS.recherche] });
    await loginAs(page, actor.username, actor.password);
    await page.goto(MENUS.enregistrement);
    await expect(page.getByText(/Accès refusé/)).toBeVisible();
    await expect(page.getByRole('heading', { name: "Enregistrement d'un courrier" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Écrans de paramétrage (visibles et assignables)
// ---------------------------------------------------------------------------------------------

interface Ctx {
  uniq: (p: string) => string;
  nodeId: number;
  actor: CourrierActor;
  departTypeId: number;
  inputationTypeId: number;
  entityTypeId: number;
  entityId: number;
  customPropertyId: number;
}

interface SettingScreen {
  menu: string;
  nav: string;
  title: string;
  /** Écritures que ce menu (seul) autorise. */
  writes: (ctx: Ctx) => Call[];
  /** Écriture nominale autorisée, 2xx attendu. */
  granted: (ctx: Ctx) => Call;
  /** Tentative d'écriture depuis l'écran (formulaire « Nouvel élément »). */
  uiCreate?: { formTitle: string; field: string; api: string };
}

const SETTINGS: SettingScreen[] = [
  {
    menu: MENUS.adminOrganigrammes,
    nav: 'Organigrammes',
    title: 'Organigrammes',
    writes: (c) => [
      { method: 'POST', path: REF_API.organigramme, body: { label: c.uniq('o') } },
      { method: 'PATCH', path: `${REF_API.organigramme}/${c.nodeId}`, body: { label: c.uniq('o') } },
      { method: 'PATCH', path: `${REF_API.organigramme}/${c.nodeId}/parent`, body: { parentId: null } },
      { method: 'DELETE', path: `${REF_API.organigramme}/${c.nodeId}` },
    ],
    granted: (c) => ({ method: 'POST', path: REF_API.organigramme, body: { label: c.uniq('o') } }),
    uiCreate: { formTitle: 'Nouveau nœud', field: 'Nom du nœud', api: REF_API.organigramme },
  },
  {
    menu: MENUS.adminRoleOrganigramme,
    nav: 'Rôles ↔ organigramme',
    title: 'Rôles ↔ organigramme',
    writes: (c) => [
      { method: 'PATCH', path: `${REF_API.organigramme}/roles/${c.actor.roleId}`, body: { organigrammeId: c.nodeId } },
    ],
    granted: (c) => ({
      method: 'PATCH',
      path: `${REF_API.organigramme}/roles/${c.actor.roleId}`,
      body: { organigrammeId: c.nodeId },
    }),
  },
  {
    menu: MENUS.adminTypesEntitesExternes,
    nav: "Types d'entité externe",
    title: "Types d'entité externe",
    writes: (c) => [
      { method: 'POST', path: REF_API.externalEntityTypes, body: { label: c.uniq('t') } },
      { method: 'PATCH', path: `${REF_API.externalEntityTypes}/${c.entityTypeId}`, body: { label: c.uniq('t') } },
      { method: 'DELETE', path: `${REF_API.externalEntityTypes}/${c.entityTypeId}` },
    ],
    granted: (c) => ({ method: 'POST', path: REF_API.externalEntityTypes, body: { label: c.uniq('t') } }),
    uiCreate: { formTitle: 'Nouveau type', field: 'Libellé', api: REF_API.externalEntityTypes },
  },
  {
    menu: MENUS.adminEntitesExternes,
    nav: 'Entités externes',
    title: 'Entités externes',
    writes: (c) => [
      { method: 'POST', path: REF_API.externalEntities, body: { label: c.uniq('e') } },
      { method: 'PATCH', path: `${REF_API.externalEntities}/${c.entityId}`, body: { label: c.uniq('e') } },
      { method: 'DELETE', path: `${REF_API.externalEntities}/${c.entityId}` },
      // Bouton « + » du champ Type : même écriture que l'écran des types (menus en OU).
      { method: 'POST', path: REF_API.externalEntityTypes, body: { label: c.uniq('t') } },
      { method: 'POST', path: REF_API.customProperties, body: { label: c.uniq('p') } },
      { method: 'DELETE', path: `${REF_API.customProperties}/${c.customPropertyId}` },
      {
        method: 'POST',
        path: REF_API.customValues,
        body: { externalEntityId: c.entityId, externalEntityCustomPropertyId: c.customPropertyId, value: 'x' },
      },
    ],
    granted: (c) => ({ method: 'POST', path: REF_API.externalEntityTypes, body: { label: c.uniq('t') } }),
    uiCreate: { formTitle: 'Nouvelle entité externe', field: 'Nom', api: REF_API.externalEntities },
  },
  {
    menu: MENUS.adminTypesImputation,
    nav: "Types d'imputation",
    title: "Types d'imputation",
    writes: (c) => [
      { method: 'POST', path: REF_API.inputationTypes, body: { label: c.uniq('i') } },
      { method: 'PATCH', path: `${REF_API.inputationTypes}/${c.inputationTypeId}`, body: { suivi: true } },
      { method: 'DELETE', path: `${REF_API.inputationTypes}/${c.inputationTypeId}` },
    ],
    granted: (c) => ({ method: 'POST', path: REF_API.inputationTypes, body: { label: c.uniq('i') } }),
    uiCreate: { formTitle: "Nouveau type d'imputation", field: 'Libellé', api: REF_API.inputationTypes },
  },
  {
    menu: MENUS.adminTypesDepart,
    nav: 'Types de courrier départ',
    title: 'Types de courrier départ',
    writes: (c) => [
      { method: 'POST', path: REF_API.departTypes, body: { label: c.uniq('d') } },
      { method: 'PATCH', path: `${REF_API.departTypes}/${c.departTypeId}`, body: { label: c.uniq('d') } },
      { method: 'DELETE', path: `${REF_API.departTypes}/${c.departTypeId}` },
    ],
    granted: (c) => ({ method: 'POST', path: REF_API.departTypes, body: { label: c.uniq('d') } }),
    uiCreate: { formTitle: 'Nouveau type de départ', field: 'Libellé', api: REF_API.departTypes },
  },
];

const settingByMenu = (menu: string) => SETTINGS.find((s) => s.menu === menu)!;
/** Types de départ : n'ouvre que ses propres endpoints (Organigrammes pour lui-même). */
const settingWitness = (s: SettingScreen) =>
  settingByMenu(s.menu === MENUS.adminTypesDepart ? MENUS.adminOrganigrammes : MENUS.adminTypesDepart);

/** Données cibles créées par l'administrateur (les écritures refusées ne doivent rien toucher). */
async function settingsCtx(api: ApiClient, uniq: (p: string) => string, actor: CourrierActor): Promise<Ctx> {
  const node = await createOrgNode(api, uniq('PermOrg'));
  const departType = await api.post(REF_API.departTypes, { label: uniq('PermDep') });
  const inputationType = await api.post(REF_API.inputationTypes, { label: uniq('PermImp') });
  const entityType = await api.post(REF_API.externalEntityTypes, { label: uniq('PermTee') });
  const entity = await api.post(REF_API.externalEntities, {
    label: uniq('PermCorr'),
    externalEntityTypeId: entityType.externalEntityTypeId,
  });
  const prop = await api.post(REF_API.customProperties, { label: uniq('PermProp') });
  return {
    uniq,
    actor,
    nodeId: node.organigrammeId,
    departTypeId: departType.mailDepartTypeId,
    inputationTypeId: inputationType.mailInputationTypeId,
    entityTypeId: entityType.externalEntityTypeId,
    entityId: entity.externalEntityId,
    customPropertyId: prop.externalEntityCustomPropertyId,
  };
}

test.describe('Permissions Docu-Courriers — paramétrage', () => {
  for (const s of SETTINGS) {
    test(`COU-97 — [${s.nav}] sans le menu : entrée absente, écritures refusées (API et écran)`, async ({
      page,
      api,
      uniq,
      loginAs,
      apiAs,
    }) => {
      const witness = settingWitness(s);
      const actor = await createCourrierActor(api, { prefix: uniq('perm'), menus: [witness.menu] });
      const actorApi = await apiAs(actor.username, actor.password);
      const ctx = await settingsCtx(api, uniq, actor);

      for (const call of s.writes(ctx)) {
        const res = await send(actorApi, call);
        expect(res.status(), `${call.method} ${call.path}`).toBe(403);
      }

      await loginAs(page, actor.username, actor.password);
      await page.goto(witness.menu);
      const section = navSection(page, 'Paramétrage Courrier');
      await expect(navEntry(section, witness.nav)).toBeVisible();
      await expect(navEntry(section, s.nav)).toHaveCount(0);

      // URL directe : les lectures étant ouvertes, l'écran se monte ; la création est refusée.
      if (s.uiCreate) {
        await page.goto(s.menu);
        const form = card(page, s.uiCreate.formTitle);
        const label = uniq('Refus');
        await form.getByLabel(s.uiCreate.field).fill(label);
        const post = waitApi(page, 'POST', s.uiCreate.api);
        await form.getByRole('button', { name: 'Ajouter' }).click();
        expect((await post).status()).toBe(403);
        await expectToast(page, FORBIDDEN_MESSAGE);
        const labels = ((await api.get(s.uiCreate.api)) as Array<{ label: string }>).map((r) => r.label);
        expect(labels).not.toContain(label);
      }
    });

    test(`COU-98 — [${s.nav}] avec le menu : entrée visible, écran chargé, écriture autorisée`, async ({
      page,
      api,
      uniq,
      loginAs,
      apiAs,
    }) => {
      const actor = await createCourrierActor(api, { prefix: uniq('perm'), menus: [s.menu] });
      const actorApi = await apiAs(actor.username, actor.password);
      const ctx = await settingsCtx(api, uniq, actor);
      const granted = s.granted(ctx);
      const res = await send(actorApi, granted);
      // Nest : 201 pour un POST de création, 200 pour un PATCH.
      expect(res.status()).toBe(granted.method === 'POST' ? 201 : 200);

      await loginAs(page, actor.username, actor.password);
      await page.goto(s.menu);
      await expect(page.getByRole('heading', { name: s.title })).toBeVisible();
      await expect(navEntry(navSection(page, 'Paramétrage Courrier'), s.nav)).toBeVisible();
    });
  }

  test('COU-97 — [Entités externes] création d’un correspondant ouverte au menu Enregistrement, le reste non', async ({
    api,
    uniq,
    apiAs,
  }) => {
    const actor = await createCourrierActor(api, { prefix: uniq('permenr'), menus: [MENUS.enregistrement] });
    const actorApi = await apiAs(actor.username, actor.password);
    const ctx = await settingsCtx(api, uniq, actor);

    const created = await actorApi.raw.post(REF_API.externalEntities, { label: uniq('CorrRapide') });
    expect(created.status()).toBe(201);
    const id = (await created.json()).externalEntityId as number;
    expect((await actorApi.raw.patch(`${REF_API.externalEntities}/${id}`, { label: uniq('x') })).status()).toBe(403);
    expect((await actorApi.raw.del(`${REF_API.externalEntities}/${id}`)).status()).toBe(403);
    expect((await actorApi.raw.post(REF_API.externalEntityTypes, { label: uniq('t') })).status()).toBe(403);
    expect((await actorApi.raw.post(REF_API.customProperties, { label: uniq('p') })).status()).toBe(403);
    expect(
      (await actorApi.raw.post(REF_API.customValues, {
        externalEntityId: ctx.entityId,
        externalEntityCustomPropertyId: ctx.customPropertyId,
        value: 'x',
      })).status(),
    ).toBe(403);
    // Les lectures des référentiels (lookups des formulaires) restent ouvertes.
    expect((await actorApi.raw.get(REF_API.externalEntities)).status()).toBe(200);
    expect((await actorApi.raw.get(REF_API.externalEntityTypes)).status()).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Écrans masqués : natures, objets, confidentialités
// ---------------------------------------------------------------------------------------------

const HIDDEN = [
  { menu: '/admin/courriers/natures', title: 'Natures de courrier', nav: 'Natures de courrier', api: REF_API.natures },
  { menu: '/admin/courriers/objets', title: 'Objets de courrier', nav: 'Objets de courrier', api: REF_API.objets },
  { menu: '/admin/courriers/confidentialites', title: 'Confidentialités', nav: 'Confidentialités', api: REF_API.confidentialites },
];

test.describe('Permissions Docu-Courriers — écrans masqués (administrateur seul)', () => {
  test('COU-99 — non assignables : absents du catalogue, retirés d’un rôle, écritures refusées à tout non-admin', async ({
    api,
    uniq,
    apiAs,
  }) => {
    const catalog = (await api.get('/roles/menus')) as Array<{ key: string }>;
    const keys = catalog.map((m) => m.key);
    for (const h of HIDDEN) expect(keys).not.toContain(h.menu);
    for (const s of SETTINGS) expect(keys).toContain(s.menu);

    // Rôle demandé AVEC les trois écrans masqués : seuls les menus assignables sont conservés.
    const actor = await createCourrierActor(api, {
      prefix: uniq('permhid'),
      menus: [...HIDDEN.map((h) => h.menu), MENUS.adminTypesDepart],
    });
    const roles = (await api.get('/roles')) as Array<{ roleId: number; menuKeys: string[] }>;
    expect(roles.find((r) => r.roleId === actor.roleId)?.menuKeys).toEqual([MENUS.adminTypesDepart]);

    const actorApi = await apiAs(actor.username, actor.password);
    const me = (await actorApi.get('/auth/me')) as { menuKeys?: string[] };
    for (const h of HIDDEN) expect(me.menuKeys ?? []).not.toContain(h.menu);
    for (const h of HIDDEN) {
      expect((await actorApi.raw.post(h.api, { label: uniq('h') })).status(), h.api).toBe(403);
      expect((await actorApi.raw.del(`${h.api}/${UNKNOWN_ID}`)).status(), h.api).toBe(403);
      // Lecture (lookup) ouverte.
      expect((await actorApi.raw.get(h.api)).status(), h.api).toBe(200);
    }
  });

  test('COU-99 — l’administrateur y accède par URL directe, sans entrée de barre latérale', async ({
    page,
    api,
    uniq,
  }) => {
    for (const h of HIDDEN) {
      const loaded = await gotoAndWait(page, h.menu, 'GET', h.api);
      expect(loaded.status()).toBe(200);
      await expect(page.getByRole('heading', { name: h.title })).toBeVisible();
      // Le fil d'Ariane est le seul repère de ces écrans hors menu.
      await expect(page.locator('.ant-breadcrumb')).toContainText('Paramétrage Courrier');
      const created = await api.raw.post(h.api, { label: uniq('AdminHid') });
      expect(created.status()).toBe(201);
    }

    await page.goto(MENUS.adminOrganigrammes); // ouvre la section « Paramétrage Courrier »
    const section = navSection(page, 'Paramétrage Courrier');
    await expect(navEntry(section, 'Organigrammes')).toBeVisible();
    for (const h of HIDDEN) await expect(navEntry(section, h.nav)).toHaveCount(0);
  });
});
