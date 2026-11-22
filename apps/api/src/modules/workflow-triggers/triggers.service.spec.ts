import { ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { WF_EVENT_CATALOG } from './domain/event-catalog';
import { createTriggerSchema, listTriggersQuerySchema, updateTriggerSchema } from './triggers.dto';
import { WorkflowTriggersService } from './triggers.service';

const designer: AuthUser = { userId: 7, username: 'conc', fullName: 'Conceptrice', isAdmin: false, userGroupId: 70 };
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10 };
const machine: AuthUser = { userId: 0, username: 'scan', isAdmin: false, userGroupId: null, isScanAgent: true };
const noGroup: AuthUser = { userId: 9, username: 'x', isAdmin: false, userGroupId: null };

const NOW = new Date('2026-11-21T10:00:00.000Z');

function triggerRow(over: Record<string, unknown> = {}) {
  return {
    wfTriggerId: 3,
    definitionId: 5,
    name: 'Courriers entrants',
    eventType: 'mail.arrived',
    conditions: { match: [{ field: 'subject.mailType', op: 'eq', value: 0 }] },
    runAsUserGroupId: 70,
    isActive: true,
    lastFiredAt: null,
    createdBy: 70,
    createdAt: NOW,
    updatedAt: NOW,
    definition: { name: 'Demande', status: 1 },
    ...over,
  };
}

function setup() {
  const prisma = {
    wfDefinition: { findUnique: jest.fn().mockResolvedValue({ wfDefinitionId: 5, name: 'Demande', status: 1 }) },
    wfTrigger: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        triggerRow({ ...data, wfTriggerId: 3 }),
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => triggerRow(data)),
      delete: jest.fn().mockResolvedValue({}),
    },
    // Le compte 70 appartient à la personne n° 7, le compte 80 à la personne n° 8.
    appUserGroup: {
      findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) =>
        where.userGroupId === 70 ? { userId: 7 } : where.userGroupId === 80 ? { userId: 8 } : null,
      ),
    },
  };
  const principals = {
    canLaunch: jest.fn().mockResolvedValue(true),
    describeUserGroup: jest.fn().mockResolvedValue('Conceptrice'),
  };
  const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
  const service = new WorkflowTriggersService(prisma as never, principals as never, audit as never);
  return { prisma, principals, audit, service };
}

const body = (over: Record<string, unknown> = {}) =>
  createTriggerSchema.parse({
    name: '  Courriers entrants ',
    eventType: 'mail.arrived',
    definitionId: 5,
    runAsUserGroupId: 70,
    conditions: { match: [{ field: 'subject.mailType', op: 'eq', value: 0 }] },
    ...over,
  });

describe('schémas zod des déclencheurs', () => {
  it('création : nom rogné, valeurs par défaut', () => {
    const b = createTriggerSchema.parse({ name: ' A ', eventType: 'mail.arrived', definitionId: 1, runAsUserGroupId: 2 });
    expect(b).toEqual({ name: 'A', eventType: 'mail.arrived', definitionId: 1, runAsUserGroupId: 2, conditions: {}, isActive: true });
  });

  it('création : refuse clé inconnue, type d’événement inconnu, nom vide ou trop long, id non positif', () => {
    const base = { name: 'A', eventType: 'mail.arrived', definitionId: 1, runAsUserGroupId: 2 };
    expect(createTriggerSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ ...base, eventType: 'x.y' }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ ...base, name: 'x'.repeat(201) }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ ...base, definitionId: 0 }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ ...base, runAsUserGroupId: 1.5 }).success).toBe(false);
    expect(createTriggerSchema.safeParse({ ...base, conditions: [] }).success).toBe(false);
  });

  it('mise à jour : eventType et definitionId refusés, au moins un champ', () => {
    expect(updateTriggerSchema.safeParse({ eventType: 'mail.arrived' }).success).toBe(false);
    expect(updateTriggerSchema.safeParse({ definitionId: 2 }).success).toBe(false);
    expect(updateTriggerSchema.safeParse({}).success).toBe(false);
    expect(updateTriggerSchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('liste : défauts et bornes', () => {
    expect(listTriggersQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(listTriggersQuerySchema.parse({ isActive: 'false', limit: '100', offset: '5', definitionId: '3' })).toEqual({
      isActive: false,
      limit: 100,
      offset: 5,
      definitionId: 3,
    });
    expect(listTriggersQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listTriggersQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listTriggersQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(listTriggersQuerySchema.safeParse({ isActive: 'oui' }).success).toBe(false);
  });
});

describe('WorkflowTriggersService : acteur', () => {
  it.each([
    ['identité machine', machine],
    ['utilisateur sans userGroupId', noGroup],
  ])('%s : écritures refusées (403) sans toucher la base', async (_n, actor) => {
    const { prisma, service } = setup();
    await expect(service.create(actor, body())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update(actor, 3, { isActive: false })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(actor, 3)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.wfDefinition.findUnique).not.toHaveBeenCalled();
    expect(prisma.wfTrigger.create).not.toHaveBeenCalled();
    expect(prisma.wfTrigger.update).not.toHaveBeenCalled();
    expect(prisma.wfTrigger.delete).not.toHaveBeenCalled();
  });
});

describe('WorkflowTriggersService.create', () => {
  it('création nominale : conditions normalisées, créateur, journal, DTO', async () => {
    const { prisma, audit, service } = setup();
    const dto = await service.create(designer, body());
    const data = (prisma.wfTrigger.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      definitionId: 5,
      name: 'Courriers entrants',
      eventType: 'mail.arrived',
      runAsUserGroupId: 70,
      isActive: true,
      createdBy: 70,
      conditions: { match: [{ field: 'subject.mailType', op: 'eq', value: 0 }] },
    });
    expect(dto).toEqual({
      wfTriggerId: 3,
      name: 'Courriers entrants',
      eventType: 'mail.arrived',
      definitionId: 5,
      definitionName: 'Demande',
      conditions: { match: [{ field: 'subject.mailType', op: 'eq', value: 0 }] },
      runAsUserGroupId: 70,
      runAsLabel: 'Conceptrice',
      isActive: true,
      lastFiredAt: null,
      createdBy: 70,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(audit.dataChange).toHaveBeenCalledTimes(1);
    const entry = audit.dataChange.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ userGroupId: 70, actorFullName: 'Conceptrice', objectRef: 'wf_trigger:3' });
    expect(entry.oldValue).toBeUndefined();
    expect(JSON.parse(entry.newValue as string)).toMatchObject({ name: 'Courriers entrants', eventType: 'mail.arrived' });
  });

  it('conditions {} : stockées sous la forme normalisée { match: [] }', async () => {
    const { prisma, service } = setup();
    await service.create(designer, body({ conditions: {} }));
    const data = (prisma.wfTrigger.create.mock.calls[0]?.[0] as { data: { conditions: unknown } }).data;
    expect(data.conditions).toEqual({ match: [] });
  });

  it('conditions invalides : 422 avec la liste des problèmes, rien n’est créé', async () => {
    const { prisma, service } = setup();
    const err = await service
      .create(designer, body({ conditions: { match: [{ field: 'subject.title', op: 'eq', value: 'x' }] } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    const response = (err as UnprocessableEntityException).getResponse() as { issues: string[] };
    expect(response.issues.length).toBeGreaterThan(0);
    expect(response.issues[0]).toContain('title');
    expect(prisma.wfTrigger.create).not.toHaveBeenCalled();
  });

  it('threshold.crossed sans seuil : 422', async () => {
    const { service } = setup();
    await expect(
      service.create(designer, body({ eventType: 'threshold.crossed', conditions: {} })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('définition archivée : 422 ; inexistante : 404', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValueOnce({ wfDefinitionId: 5, name: 'Demande', status: 2 });
    await expect(service.create(designer, body())).rejects.toBeInstanceOf(UnprocessableEntityException);
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(null);
    await expect(service.create(designer, body())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.wfTrigger.create).not.toHaveBeenCalled();
  });

  it('lanceur désactivé ou sans menu Lancer : 422 avec le message attendu', async () => {
    const { prisma, principals, service } = setup();
    principals.canLaunch.mockResolvedValue(false);
    const err = await service.create(designer, body()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toBe('Le compte lanceur doit être actif et posséder le menu Lancer.');
    expect(prisma.wfTrigger.create).not.toHaveBeenCalled();
  });

  it('non-administrateur qui désigne le compte d’une autre personne : 403, sans fuite sur ses droits', async () => {
    const { prisma, principals, service } = setup();
    const err = await service.create(designer, body({ runAsUserGroupId: 80 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe('Seul un administrateur peut désigner un autre compte comme lanceur.');
    expect(principals.canLaunch).not.toHaveBeenCalled();
    expect(prisma.wfTrigger.create).not.toHaveBeenCalled();
  });

  it('non-administrateur : lanceur inexistant = 403 ; autre compte de la MÊME personne = OK', async () => {
    const { prisma, service } = setup();
    await expect(service.create(designer, body({ runAsUserGroupId: 999 }))).rejects.toBeInstanceOf(ForbiddenException);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce({ userId: 7 });
    await expect(service.create(designer, body({ runAsUserGroupId: 71 }))).resolves.toMatchObject({ runAsUserGroupId: 71 });
  });

  it('administrateur qui désigne un autre compte actif : OK', async () => {
    const { prisma, principals, service } = setup();
    const dto = await service.create(admin, body({ runAsUserGroupId: 80 }));
    expect(dto.runAsUserGroupId).toBe(80);
    expect(principals.canLaunch).toHaveBeenCalledWith(80);
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
    expect((prisma.wfTrigger.create.mock.calls[0]?.[0] as { data: { createdBy: number } }).data.createdBy).toBe(10);
  });

  it('administrateur : lanceur sans menu Lancer = 422', async () => {
    const { principals, service } = setup();
    principals.canLaunch.mockResolvedValue(false);
    await expect(service.create(admin, body({ runAsUserGroupId: 80 }))).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('échec du journal : l’opération réussit quand même', async () => {
    const { audit, service } = setup();
    audit.dataChange.mockRejectedValue(new Error('base de journal indisponible'));
    await expect(service.create(designer, body())).resolves.toMatchObject({ wfTriggerId: 3 });
  });
});

describe('WorkflowTriggersService.update', () => {
  it('introuvable : 404', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(null);
    await expect(service.update(designer, 3, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('renommage : n’altère ni lanceur ni type, journalise avant / après', async () => {
    const { prisma, principals, audit, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    await service.update(designer, 3, { name: 'Autre nom' });
    const call = prisma.wfTrigger.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ name: 'Autre nom' });
    expect(principals.canLaunch).not.toHaveBeenCalled();
    const entry = audit.dataChange.mock.calls[0]?.[0] as { oldValue: string; newValue: string; objectRef: string };
    expect(entry.objectRef).toBe('wf_trigger:3');
    expect(JSON.parse(entry.oldValue)).toMatchObject({ name: 'Courriers entrants' });
    expect(entry.oldValue.length).toBeLessThan(500);
  });

  it('conditions : revalidées avec le type d’événement stocké, 422 si invalides', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    await expect(
      service.update(designer, 3, { conditions: { deadline: { leadHours: 3 } } }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await service.update(designer, 3, { conditions: { match: [{ field: 'subject.status', op: 'in', value: [1, 2] }] } });
    const call = prisma.wfTrigger.update.mock.calls[0]?.[0] as { data: { conditions: unknown } };
    expect(call.data.conditions).toEqual({ match: [{ field: 'subject.status', op: 'in', value: [1, 2] }] });
  });

  it('changement de lanceur : revalidé (menu Lancer, puis anti-élévation)', async () => {
    const { prisma, principals, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    principals.canLaunch.mockResolvedValueOnce(false);
    await expect(service.update(admin, 3, { runAsUserGroupId: 80 })).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.update(designer, 3, { runAsUserGroupId: 80 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.wfTrigger.update).not.toHaveBeenCalled();
    await service.update(admin, 3, { runAsUserGroupId: 80 });
    expect(principals.canLaunch).toHaveBeenLastCalledWith(80);
    expect((prisma.wfTrigger.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data).toEqual({
      runAsUserGroupId: 80,
    });
  });

  it('réactivation après désactivation automatique : lanceur et conditions revalidés', async () => {
    const { prisma, principals, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow({ isActive: false }));
    await service.update(designer, 3, { isActive: true });
    expect(principals.canLaunch).toHaveBeenCalledWith(70);
    expect((prisma.wfTrigger.update.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data).toEqual({ isActive: true });

    principals.canLaunch.mockResolvedValueOnce(false);
    await expect(service.update(designer, 3, { isActive: true })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('réactivation sur une définition archivée : 422', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(
      triggerRow({ isActive: false, definition: { name: 'Demande', status: 2 } }),
    );
    await expect(service.update(designer, 3, { isActive: true })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.wfTrigger.update).not.toHaveBeenCalled();
  });

  it('désactivation : aucun contrôle de lanceur', async () => {
    const { prisma, principals, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    await service.update(designer, 3, { isActive: false });
    expect(principals.canLaunch).not.toHaveBeenCalled();
  });

  it('échec du journal : la mise à jour réussit quand même', async () => {
    const { prisma, audit, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    audit.dataChange.mockRejectedValue(new Error('indisponible'));
    await expect(service.update(designer, 3, { name: 'B' })).resolves.toBeDefined();
  });
});

describe('WorkflowTriggersService.remove', () => {
  it('supprime réellement et journalise l’état précédent', async () => {
    const { prisma, audit, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    await service.remove(designer, 3);
    expect(prisma.wfTrigger.delete).toHaveBeenCalledWith({ where: { wfTriggerId: 3 } });
    const entry = audit.dataChange.mock.calls[0]?.[0] as { oldValue: string; newValue?: string; objectRef: string };
    expect(entry.objectRef).toBe('wf_trigger:3');
    expect(JSON.parse(entry.oldValue)).toMatchObject({ eventType: 'mail.arrived', runAsUserGroupId: 70 });
    expect(entry.newValue).toBeUndefined();
  });

  it('introuvable : 404 ; échec du journal : suppression réussie', async () => {
    const { prisma, audit, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValueOnce(null);
    await expect(service.remove(designer, 3)).rejects.toBeInstanceOf(NotFoundException);
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow());
    audit.dataChange.mockRejectedValue(new Error('indisponible'));
    await expect(service.remove(designer, 3)).resolves.toBeUndefined();
    expect(prisma.wfTrigger.delete).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowTriggersService : anti-élévation sur le lanceur actuel', () => {
  it.each([
    ['modifier', (svc: WorkflowTriggersService) => svc.update(designer, 3, { name: 'X' })],
    ['réactiver', (svc: WorkflowTriggersService) => svc.update(designer, 3, { isActive: true })],
    ['supprimer', (svc: WorkflowTriggersService) => svc.remove(designer, 3)],
  ])('non-administrateur ne peut pas %s un déclencheur dont le lanceur est un autre compte : 403 sans écriture ni audit', async (_n, run) => {
    const { prisma, audit, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow({ runAsUserGroupId: 80, isActive: false }));
    await expect(run(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.wfTrigger.update).not.toHaveBeenCalled();
    expect(prisma.wfTrigger.delete).not.toHaveBeenCalled();
    expect(audit.dataChange).not.toHaveBeenCalled();
  });

  it('lanceur actuel inexistant : 403 pour un non-administrateur', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow({ runAsUserGroupId: 999 }));
    await expect(service.remove(designer, 3)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('non-administrateur : OK si le lanceur est l’un de ses propres comptes', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow({ runAsUserGroupId: 71, isActive: false }));
    prisma.appUserGroup.findUnique.mockResolvedValue({ userId: 7 });
    await expect(service.update(designer, 3, { isActive: true })).resolves.toBeDefined();
    await expect(service.remove(designer, 3)).resolves.toBeUndefined();
  });

  it('administrateur : peut tout, sans consulter le compte lanceur actuel', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow({ runAsUserGroupId: 80, isActive: false }));
    await service.update(admin, 3, { isActive: true });
    await service.remove(admin, 3);
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });
});

describe('WorkflowTriggersService : lecture', () => {
  it('list : filtres, pagination et DTO seulement (aucun champ brut)', async () => {
    const { prisma, service } = setup();
    prisma.wfTrigger.findMany.mockResolvedValue([triggerRow({ conditions: { match: [], extra: 'x' } })]);
    const out = await service.list({ definitionId: 5, eventType: 'mail.arrived', isActive: true, limit: 10, offset: 20 });
    const args = prisma.wfTrigger.findMany.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({
      where: { definitionId: 5, eventType: 'mail.arrived', isActive: true },
      take: 10,
      skip: 20,
    });
    expect(Object.keys(out[0] as object).sort()).toEqual(
      [
        'wfTriggerId', 'name', 'eventType', 'definitionId', 'definitionName', 'conditions', 'runAsUserGroupId',
        'runAsLabel', 'isActive', 'lastFiredAt', 'createdBy', 'createdAt', 'updatedAt',
      ].sort(),
    );
    // Une clé inconnue stockée n'est jamais renvoyée : les conditions sont renormalisées.
    expect(out[0]?.conditions).toEqual({ match: [] });
  });

  it('list sans filtre : where vide', async () => {
    const { prisma, service } = setup();
    await service.list({ limit: 25, offset: 0 });
    expect((prisma.wfTrigger.findMany.mock.calls[0]?.[0] as { where: unknown }).where).toEqual({});
  });

  it('get : 404 si absent ; libellé du lanceur nul si le compte a disparu', async () => {
    const { prisma, principals, service } = setup();
    prisma.wfTrigger.findUnique.mockResolvedValueOnce(null);
    await expect(service.get(3)).rejects.toBeInstanceOf(NotFoundException);
    prisma.wfTrigger.findUnique.mockResolvedValue(triggerRow({ lastFiredAt: NOW }));
    principals.describeUserGroup.mockResolvedValue(null);
    const dto = await service.get(3);
    expect(dto.runAsLabel).toBeNull();
    expect(dto.lastFiredAt).toBe(NOW.toISOString());
  });
});

describe('WorkflowTriggersService.catalog', () => {
  it('ne contient que des champs et types du catalogue, opérateurs et plafonds', () => {
    const { service } = setup();
    const cat = service.catalog();
    expect(cat.eventTypes.map((e) => e.type).sort()).toEqual(Object.keys(WF_EVENT_CATALOG).sort());
    for (const e of cat.eventTypes) {
      const spec = WF_EVENT_CATALOG[e.type];
      expect(e.label).toBe(spec.label);
      expect(e.subjectType).toBe(spec.subjectType);
      expect(e.fields.map((f) => f.name).sort()).toEqual(Object.keys(spec.fields).sort());
      for (const f of e.fields) expect(f).toEqual({ name: f.name, kind: spec.fields[f.name]?.kind, label: spec.fields[f.name]?.label });
    }
    expect(cat.operators).toEqual(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists']);
    expect(cat.limits).toEqual({
      defaults: { maxLaunches: 60, windowMinutes: 60 },
      ceiling: { maxLaunches: 1000, windowMinutes: 1440 },
    });
  });
});
