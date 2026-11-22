// Docu-Flow : déclencheurs par événement (scénarios WF-80 à WF-84).
// API : apps/api/src/modules/workflow-triggers/** (menu conception sur toutes les routes). Écran : bloc
// « Déclencheurs » de l'éditeur (conception/_components/panels/TriggersSlot.tsx, lecture seule).
//
// L'événement « courrier arrivé » est émis par l'enregistrement d'un courrier Arrivée (POST /courriers/arrivee) et
// consommé par l'API (file wf-events) : aucun appel externe. Chaque test filtre sur un rôle destinataire créé pour
// lui, pour ne jamais être déclenché par les courriers d'un autre test.

import { test, expect } from '../../../fixtures';
import {
  WF_MENUS,
  archiveDefinition,
  createPublishedDefinition,
  singleFormGraph,
  type ApiLike,
  type WfInstanceDto,
} from '../_helpers/wf-api';
import { adminUserGroupId, createWfUser } from '../_helpers/users';
import { gotoEditor } from '../_helpers/ui';

interface TriggerDto {
  wfTriggerId: number;
  name: string;
  eventType: string;
  definitionId: number;
  conditions: { match?: Array<{ field: string; op: string; value?: unknown }> };
  runAsUserGroupId: number;
  isActive: boolean;
  lastFiredAt: string | null;
}

interface InstanceWithSubject extends WfInstanceDto {
  triggerId: number | null;
  subjectType: string | null;
  subjectId: string | null;
}

function roleCondition(roleId: number) {
  return { match: [{ field: 'subject.destinataireRoleId', op: 'eq', value: roleId }] };
}

async function createRole(api: ApiLike, name: string): Promise<number> {
  const role = await api.post<{ roleId: number }>('/roles', { name, description: 'Rôle destinataire E2E Docu-Flow', menuKeys: [] });
  return role.roleId;
}

async function registerMail(api: ApiLike, title: string, destinataireRoleId: number): Promise<number> {
  const mail = await api.post<{ mailId: number }>('/courriers/arrivee', { title, date: new Date().toISOString(), destinataireRoleId });
  return mail.mailId;
}

/** Workflow témoin publié, déclenché par tout courrier Arrivée destiné à `roleId`. Renvoie son identifiant. */
async function createSentinel(api: ApiLike, name: string, roleId: number, runAs: number): Promise<number> {
  const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
  await api.post('/workflows/triggers', {
    definitionId: definition.wfDefinitionId,
    name: `${name} (déclencheur)`,
    eventType: 'mail.arrived',
    conditions: roleCondition(roleId),
    runAsUserGroupId: runAs,
  });
  return definition.wfDefinitionId;
}

async function instancesOf(api: ApiLike, definitionId: number): Promise<InstanceWithSubject[]> {
  const { items } = await api.get<{ items: InstanceWithSubject[] }>(`/workflows/instances?definitionId=${definitionId}&limit=100`);
  return items;
}

test.describe('Docu-Flow : déclencheurs', () => {
  test('WF-80 Catalogue, création, lecture dans l’éditeur, modification et suppression d’un déclencheur', async ({ page, api, uniq }) => {
    const catalog = await api.get<{ eventTypes: Array<{ type: string; label: string; fields: Array<{ name: string }> }>; operators: string[] }>(
      '/workflows/triggers/catalog',
    );
    const mailEvent = catalog.eventTypes.find((e) => e.type === 'mail.arrived');
    expect(mailEvent?.label).toBe('Courrier arrivé (enregistré)');
    expect(mailEvent?.fields.map((f) => f.name)).toContain('destinataireRoleId');
    expect(catalog.operators).toEqual(expect.arrayContaining(['eq', 'neq', 'in', 'exists']));

    const name = uniq('WF-80 Déclencheur');
    const triggerName = uniq('Sur courrier WF-80');
    const { definition } = await createPublishedDefinition(api, { name, graph: singleFormGraph() });
    const runAs = await adminUserGroupId(api);
    const roleId = await createRole(api, uniq('Rôle WF-80'));

    const created = await api.post<TriggerDto>('/workflows/triggers', {
      definitionId: definition.wfDefinitionId,
      name: triggerName,
      eventType: 'mail.arrived',
      conditions: roleCondition(roleId),
      runAsUserGroupId: runAs,
      isActive: false,
    });
    expect(created).toMatchObject({ name: triggerName, eventType: 'mail.arrived', isActive: false, lastFiredAt: null });
    expect(created.conditions.match).toEqual([{ field: 'subject.destinataireRoleId', op: 'eq', value: roleId }]);
    const listed = await api.get<TriggerDto[]>(`/workflows/triggers?definitionId=${definition.wfDefinitionId}`);
    expect(listed.map((t) => t.wfTriggerId)).toEqual([created.wfTriggerId]);

    await gotoEditor(page, definition.wfDefinitionId);
    const block = page.getByRole('region', { name: 'Déclencheurs' });
    await expect(block.getByText(triggerName)).toBeVisible();
    await expect(block.getByText('Inactif', { exact: true })).toBeVisible();
    await expect(block.getByText('Événement : mail.arrived')).toBeVisible();
    await expect(block.getByText(`Exécuté en tant qu’utilisateur n° ${runAs}`)).toBeVisible();

    const updated = await api.put<TriggerDto>(`/workflows/triggers/${created.wfTriggerId}`, { isActive: true, name: `${triggerName} (actif)` });
    expect(updated).toMatchObject({ isActive: true, name: `${triggerName} (actif)` });
    // Le type d'événement ne change jamais après la création (clé inconnue du schéma strict).
    expect((await api.raw.put(`/workflows/triggers/${created.wfTriggerId}`, { eventType: 'document.deposited' })).status()).toBe(400);

    expect(await api.del<{ deleted: true }>(`/workflows/triggers/${created.wfTriggerId}`)).toEqual({ deleted: true });
    expect(await api.get<TriggerDto[]>(`/workflows/triggers?definitionId=${definition.wfDefinitionId}`)).toEqual([]);
    expect((await api.raw.get(`/workflows/triggers/${created.wfTriggerId}`)).status()).toBe(404);
  });

  test('WF-81 Conditions invalides et workflow archivé : création refusée (422), rien n’est enregistré', async ({ api, uniq }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-81 Conditions'), graph: singleFormGraph() });
    const runAs = await adminUserGroupId(api);
    const base = { definitionId: definition.wfDefinitionId, name: uniq('Déclencheur WF-81'), eventType: 'mail.arrived', runAsUserGroupId: runAs };

    const noPrefix = await api.raw.post('/workflows/triggers', { ...base, conditions: { match: [{ field: 'destinataireRoleId', op: 'eq', value: 1 }] } });
    expect(noPrefix.status()).toBe(422);
    expect(JSON.stringify(await noPrefix.json())).toContain('le champ doit commencer par « subject. »');

    const unknownField = await api.raw.post('/workflows/triggers', { ...base, conditions: { match: [{ field: 'subject.texteLibre', op: 'eq', value: 'x' }] } });
    expect(unknownField.status()).toBe(422);
    expect(JSON.stringify(await unknownField.json())).toContain('champ « texteLibre » absent du catalogue de mail.arrived');

    const wrongType = await api.raw.post('/workflows/triggers', {
      ...base,
      conditions: { match: [{ field: 'subject.destinataireRoleId', op: 'eq', value: 'douze' }] },
    });
    expect(wrongType.status()).toBe(422);

    // Type d'événement hors catalogue : refusé par le schéma (400).
    expect((await api.raw.post('/workflows/triggers', { ...base, eventType: 'mail.deleted', conditions: {} })).status()).toBe(400);

    await archiveDefinition(api, definition.wfDefinitionId);
    expect((await api.raw.post('/workflows/triggers', { ...base, conditions: {} })).status()).toBe(422);

    expect(await api.get<TriggerDto[]>(`/workflows/triggers?definitionId=${definition.wfDefinitionId}`)).toEqual([]);
  });

  test('WF-82 Droits : menu conception exigé, pas d’élévation par le lanceur désigné', async ({ api, apiAs, uniq }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-82 Droits'), graph: singleFormGraph() });
    const adminUg = await adminUserGroupId(api);
    const launcher = await createWfUser(api, { prefix: uniq('wf82-lanceur'), menus: [WF_MENUS.launch] });
    const designerOnly = await createWfUser(api, { prefix: uniq('wf82-concepteur'), menus: [WF_MENUS.design] });
    const designer = await createWfUser(api, { prefix: uniq('wf82-conc-lanceur'), menus: [WF_MENUS.design, WF_MENUS.launch] });
    const body = (runAsUserGroupId: number) => ({
      definitionId: definition.wfDefinitionId,
      name: uniq('Déclencheur WF-82'),
      eventType: 'mail.arrived',
      conditions: {},
      runAsUserGroupId,
      isActive: false,
    });

    // Sans le menu conception : toutes les routes sont refusées.
    const asLauncher = await apiAs(launcher.username, launcher.password);
    expect((await asLauncher.raw.get('/workflows/triggers/catalog')).status()).toBe(403);
    expect((await asLauncher.raw.post('/workflows/triggers', body(launcher.userGroupId))).status()).toBe(403);

    // Le lanceur désigné doit posséder le menu lancer (un concepteur seul ne peut pas se désigner).
    const asDesignerOnly = await apiAs(designerOnly.username, designerOnly.password);
    expect((await asDesignerOnly.raw.post('/workflows/triggers', body(designerOnly.userGroupId))).status()).toBe(422);

    // Un non-administrateur ne désigne que son propre compte.
    const asDesigner = await apiAs(designer.username, designer.password);
    expect((await asDesigner.raw.post('/workflows/triggers', body(adminUg))).status()).toBe(403);
    const own = await asDesigner.post<TriggerDto>('/workflows/triggers', body(designer.userGroupId));
    expect(own.runAsUserGroupId).toBe(designer.userGroupId);

    // ... et ne modifie ni ne supprime le déclencheur d'un autre lanceur.
    const adminTrigger = await api.post<TriggerDto>('/workflows/triggers', body(adminUg));
    expect((await asDesigner.raw.put(`/workflows/triggers/${adminTrigger.wfTriggerId}`, { isActive: true })).status()).toBe(403);
    expect((await asDesigner.raw.del(`/workflows/triggers/${adminTrigger.wfTriggerId}`)).status()).toBe(403);
    expect((await api.get<TriggerDto>(`/workflows/triggers/${adminTrigger.wfTriggerId}`)).isActive).toBe(false);
  });

  test('WF-83 Un courrier Arrivée enregistré pour le rôle visé lance le workflow ; un autre rôle ne le lance pas', async ({
    api,
    uniq,
  }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-83 Courrier'), graph: singleFormGraph() });
    const id = definition.wfDefinitionId;
    const runAs = await adminUserGroupId(api);
    const watchedRole = await createRole(api, uniq('Rôle visé WF-83'));
    const otherRole = await createRole(api, uniq('Autre rôle WF-83'));
    const trigger = await api.post<TriggerDto>('/workflows/triggers', {
      definitionId: id,
      name: uniq('Sur courrier WF-83'),
      eventType: 'mail.arrived',
      conditions: roleCondition(watchedRole),
      runAsUserGroupId: runAs,
    });

    // Témoin : un second workflow déclenché par l'AUTRE rôle prouve que le courrier ignoré a bien été examiné.
    const sentinel = await createSentinel(api, uniq('WF-83 Témoin'), otherRole, runAs);

    const first = await registerMail(api, uniq('Courrier visé WF-83'), watchedRole);
    await expect.poll(async () => (await instancesOf(api, id)).length, { timeout: 15_000 }).toBe(1);

    const ignored = await registerMail(api, uniq('Courrier ignoré WF-83'), otherRole);
    await expect.poll(async () => (await instancesOf(api, sentinel)).map((i) => i.subjectId), { timeout: 15_000 }).toEqual([String(ignored)]);
    const second = await registerMail(api, uniq('Courrier visé 2 WF-83'), watchedRole);
    await expect.poll(async () => (await instancesOf(api, id)).length, { timeout: 15_000 }).toBe(2);

    const instances = await instancesOf(api, id);
    expect(instances.map((i) => i.subjectId).sort()).toEqual([String(first), String(second)].sort());
    expect(instances.map((i) => i.subjectId)).not.toContain(String(ignored));
    for (const instance of instances) {
      expect(instance).toMatchObject({ triggerId: trigger.wfTriggerId, subjectType: 'mail', startedBy: runAs });
    }
    expect((await api.get<TriggerDto>(`/workflows/triggers/${trigger.wfTriggerId}`)).lastFiredAt).not.toBeNull();
  });

  test('WF-84 Déclencheur désactivé : le courrier visé ne lance rien jusqu’à la réactivation', async ({ api, uniq }) => {
    const { definition } = await createPublishedDefinition(api, { name: uniq('WF-84 Inactif'), graph: singleFormGraph() });
    const id = definition.wfDefinitionId;
    const runAs = await adminUserGroupId(api);
    const roleId = await createRole(api, uniq('Rôle WF-84'));
    const trigger = await api.post<TriggerDto>('/workflows/triggers', {
      definitionId: id,
      name: uniq('Sur courrier WF-84'),
      eventType: 'mail.arrived',
      conditions: roleCondition(roleId),
      runAsUserGroupId: runAs,
      isActive: false,
    });

    // Témoin actif sur le même rôle : son instance prouve que l'événement du premier courrier est traité AVANT la
    // réactivation (sinon le déclencheur réactivé pourrait le voir passer).
    const sentinel = await createSentinel(api, uniq('WF-84 Témoin'), roleId, runAs);

    const whileInactive = await registerMail(api, uniq('Courrier inactif WF-84'), roleId);
    await expect.poll(async () => (await instancesOf(api, sentinel)).length, { timeout: 15_000 }).toBe(1);
    expect(await instancesOf(api, id)).toEqual([]);
    await api.put(`/workflows/triggers/${trigger.wfTriggerId}`, { isActive: true });
    const afterActivation = await registerMail(api, uniq('Courrier actif WF-84'), roleId);

    await expect.poll(async () => (await instancesOf(api, id)).length, { timeout: 15_000 }).toBe(1);
    const [instance] = await instancesOf(api, id);
    expect(instance?.subjectId).toBe(String(afterActivation));
    expect(instance?.subjectId).not.toBe(String(whileInactive));
  });
});
