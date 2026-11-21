import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { WfGraph } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { DefinitionsService, canonicalJson, hashGraph } from './definitions.service';
import type { WfTaskExecutorRegistry } from './engine/engine.types';

const designer: AuthUser = { userId: 7, username: 'conc', isAdmin: false, userGroupId: 70 };
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10 };
const machine: AuthUser = { userId: 0, username: 'scan', isAdmin: false, userGroupId: null, isScanAgent: true };
const noGroup: AuthUser = { userId: 9, username: 'x', isAdmin: false, userGroupId: null };

const NOW = new Date('2026-11-21T10:00:00.000Z');

type Data = { data: Record<string, unknown> };

function validGraph(extra: Record<string, unknown> = {}): WfGraph {
  return {
    schemaVersion: 1,
    start: 'saisie',
    steps: [
      { key: 'saisie', name: 'Saisie', type: 'formulaire', next: [{ to: 'visa' }], ...extra },
      { key: 'visa', name: 'Visa', type: 'validation', next: [] },
    ],
  } as unknown as WfGraph;
}

function agentGraph(autonomy: 'suggere' | 'autonome' = 'suggere'): WfGraph {
  return {
    schemaVersion: 1,
    start: 'ia',
    steps: [
      {
        key: 'ia',
        name: 'Analyse',
        type: 'agent',
        agent: { objective: 'Résumer', tools: [], confidenceThreshold: 0.8, autonomy },
        next: [],
      },
    ],
  } as unknown as WfGraph;
}

function defRow(over: Record<string, unknown> = {}) {
  return {
    wfDefinitionId: 5,
    name: 'Demande',
    description: null,
    status: 0,
    source: 0,
    isLowRisk: false,
    lowRiskMarkedBy: null,
    lowRiskMarkedAt: null,
    createdBy: 70,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function verRow(over: Record<string, unknown> = {}) {
  return {
    wfDefinitionVersionId: 50,
    definitionId: 5,
    versionNumber: 1,
    status: 0,
    graph: validGraph(),
    graphHash: null,
    sourcePrompt: null,
    changeNote: null,
    publishedBy: null,
    publishedAt: null,
    createdBy: 70,
    createdAt: NOW,
    ...over,
  };
}

function makePrisma() {
  const prisma = {
    wfDefinition: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    wfDefinitionVersion: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    // Droit administrateur relu en base : seul l'utilisateur n° 1 (`admin`) l'est.
    appUser: {
      findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => ({
        isAdmin: where.userId === 1,
        isDisabled: false,
      })),
    },
    $transaction: jest.fn(),
  };
  // Transaction interactive : le client transactionnel est le même objet (les appels restent traçables).
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return prisma;
}

function registry(agent: boolean): WfTaskExecutorRegistry {
  return { register: jest.fn(), get: jest.fn(), has: (t: string) => agent && t === 'agent' };
}

function setup(withAgentExecutor = false) {
  const prisma = makePrisma();
  const service = new DefinitionsService(prisma as never, registry(withAgentExecutor));
  return { prisma, service };
}

const uniqueError = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('canonicalJson / hashGraph', () => {
  it('mêmes données, clés dans un autre ordre : même empreinte (64 hex)', () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: 'é' } };
    const b = { a: { x: 'é', y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashGraph(a)).toBe(hashGraph(b));
    expect(hashGraph(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('l’ordre des tableaux et les valeurs comptent', () => {
    expect(hashGraph({ a: [1, 2] })).not.toBe(hashGraph({ a: [2, 1] }));
    expect(hashGraph({ a: 1 })).not.toBe(hashGraph({ a: 2 }));
  });
});

describe('DefinitionsService : acteur', () => {
  it.each([
    ['identité machine', machine],
    ['utilisateur sans userGroupId', noGroup],
  ])('%s : toute opération est refusée (403) sans toucher la base', async (_n, actor) => {
    const { prisma, service } = setup();
    const calls = [
      () => service.list({}, actor),
      () => service.listLaunchable(actor),
      () => service.get(5, actor),
      () => service.getVersion(5, 1, actor),
      () => service.create({ name: 'A', graph: validGraph() }, actor),
      () => service.updateDraft(5, { name: 'B' }, actor),
      () => service.validateDraft(5, actor),
      () => service.publish(5, actor),
      () => service.archive(5, actor),
      () => service.setLowRisk(5, true, actor),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.wfDefinition.findMany).not.toHaveBeenCalled();
    expect(prisma.wfDefinition.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('DefinitionsService : lecture', () => {
  it('launchable ne demande que les définitions publiées ayant une version publiée', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findMany.mockResolvedValue([defRow({ status: 1 })]);
    const out = await service.listLaunchable(designer);
    expect(out).toHaveLength(1);
    expect(prisma.wfDefinition.findMany.mock.calls[0][0].where).toEqual({
      status: 1,
      versions: { some: { status: 1 } },
    });
  });

  it('get : versions sans graphe, dates en ISO ; 404 sinon', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(null);
    await expect(service.get(9, designer)).rejects.toBeInstanceOf(NotFoundException);

    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow());
    prisma.wfDefinitionVersion.findMany.mockResolvedValue([verRow({ versionNumber: 2, publishedAt: NOW })]);
    const out = await service.get(5, designer);
    expect(prisma.wfDefinitionVersion.findMany.mock.calls[0][0].select.graph).toBeUndefined();
    expect(out.versions[0]).not.toHaveProperty('graph');
    expect(out.versions[0]?.publishedAt).toBe('2026-11-21T10:00:00.000Z');
    expect(out.definition.createdAt).toBe('2026-11-21T10:00:00.000Z');
  });

  it('getVersion : 404 si absente, graphe complet sinon', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinitionVersion.findUnique.mockResolvedValueOnce(null);
    await expect(service.getVersion(5, 3, designer)).rejects.toBeInstanceOf(NotFoundException);
    prisma.wfDefinitionVersion.findUnique.mockResolvedValueOnce(verRow());
    const v = await service.getVersion(5, 1, designer);
    expect(v.graph.start).toBe('saisie');
    expect(prisma.wfDefinitionVersion.findUnique.mock.calls[1][0].where).toEqual({
      definitionId_versionNumber: { definitionId: 5, versionNumber: 1 },
    });
  });
});

describe('DefinitionsService.create', () => {
  it('crée la définition brouillon et la version 1 brouillon, auteur = acteur', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.create.mockResolvedValue({ ...defRow(), versions: [verRow()] });
    const out = await service.create({ name: '  Demande  ', graph: validGraph() }, designer);
    const data = prisma.wfDefinition.create.mock.calls[0][0].data;
    expect(data.name).toBe('Demande');
    expect(data.status).toBe(0);
    expect(data.createdBy).toBe(70);
    expect(data.versions.create).toMatchObject({ versionNumber: 1, status: 0, createdBy: 70 });
    expect(out.version.versionNumber).toBe(1);
  });

  it('nom déjà pris parmi les non archivés : 409 en français', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.create.mockRejectedValue(uniqueError());
    const err = await service.create({ name: 'Demande', graph: validGraph() }, designer).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('porte déjà ce nom');
  });
});

describe('DefinitionsService.updateDraft', () => {
  it('modifie le brouillon existant sans créer de version', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow());
    const g = validGraph();
    prisma.wfDefinitionVersion.update.mockResolvedValue(verRow({ graph: g, changeNote: 'v1b' }));
    const out = await service.updateDraft(5, { graph: g, changeNote: 'v1b' }, designer);
    expect(prisma.wfDefinitionVersion.create).not.toHaveBeenCalled();
    expect(prisma.wfDefinitionVersion.update.mock.calls[0][0].where).toEqual({ wfDefinitionVersionId: 50 });
    expect(out.version.changeNote).toBe('v1b');
  });

  it('dernière version publiée : nouvelle version brouillon max+1 copie du graphe publié, publiée intacte', async () => {
    const { prisma, service } = setup();
    const publishedGraph = validGraph();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ status: 1 }));
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(
      verRow({ versionNumber: 3, status: 1, graph: publishedGraph, publishedAt: NOW }),
    );
    prisma.wfDefinitionVersion.create.mockImplementation(async ({ data }: Data) =>
      verRow({ ...data, wfDefinitionVersionId: 99 }),
    );
    prisma.wfDefinition.update.mockResolvedValue(defRow({ status: 1, description: 'neuf' }));
    const out = await service.updateDraft(5, { description: 'neuf' }, designer);
    expect(prisma.wfDefinitionVersion.create.mock.calls[0][0].data).toMatchObject({
      definitionId: 5,
      versionNumber: 4,
      status: 0,
      graph: publishedGraph,
      createdBy: 70,
    });
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
    expect(prisma.wfDefinitionVersion.updateMany).not.toHaveBeenCalled();
    expect(out.version.versionNumber).toBe(4);
    expect(out.definition.description).toBe('neuf');
  });

  it('dernière version publiée + nouveau graphe : le brouillon porte le nouveau graphe', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ status: 1 }));
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ versionNumber: 1, status: 1 }));
    prisma.wfDefinitionVersion.create.mockImplementation(async ({ data }: Data) => verRow(data));
    const g = validGraph({ name: 'Autre' });
    await service.updateDraft(5, { graph: g }, designer);
    expect(prisma.wfDefinitionVersion.create.mock.calls[0][0].data.graph).toEqual(g);
  });

  it('renommage vers un nom pris : 409 ; workflow archivé : 409 ; inconnu : 404', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow());
    prisma.wfDefinition.update.mockRejectedValue(uniqueError());
    await expect(service.updateDraft(5, { name: 'Pris' }, designer)).rejects.toThrow(/porte déjà ce nom/);

    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ status: 2 }));
    await expect(service.updateDraft(5, { name: 'Z' }, designer)).rejects.toBeInstanceOf(ConflictException);

    prisma.wfDefinition.findUnique.mockResolvedValue(null);
    await expect(service.updateDraft(5, { name: 'Z' }, designer)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DefinitionsService.validateDraft', () => {
  it('graphe valide : ok, rien n’est écrit', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow());
    await expect(service.validateDraft(5, designer)).resolves.toEqual({ ok: true, issues: [] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    for (const m of [
      prisma.wfDefinition.update,
      prisma.wfDefinitionVersion.update,
      prisma.wfDefinitionVersion.updateMany,
    ]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it('renvoie les problèmes du graphe (cible inconnue, étape inatteignable)', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    const bad = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        { key: 'a', name: 'A', type: 'formulaire', next: [{ to: 'zz' }] },
        { key: 'b', name: 'B', type: 'formulaire', next: [] },
      ],
    };
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph: bad }));
    const out = await service.validateDraft(5, designer);
    expect(out.ok).toBe(false);
    const codes = out.issues.map((i) => i.code);
    expect(codes).toContain('EDGE_TARGET_NOT_FOUND');
    expect(codes).toContain('UNREACHABLE_STEP');
  });

  it('escalade invalide : ESCALATION_INVALID située sur l’étape ; valide : acceptée', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValueOnce(
      verRow({ graph: validGraph({ config: { escalation: { assignee: { kind: 'user' }, maxEscalations: 9 } } }) }),
    );
    const out = await service.validateDraft(5, designer);
    expect(out.ok).toBe(false);
    const esc = out.issues.filter((i) => i.code === 'ESCALATION_INVALID');
    expect(esc.length).toBeGreaterThanOrEqual(2);
    expect(esc.every((i) => i.stepKey === 'saisie')).toBe(true);

    prisma.wfDefinitionVersion.findFirst.mockResolvedValueOnce(
      verRow({
        graph: validGraph({
          dueInHours: 4,
          config: { escalation: { assignee: { kind: 'role', id: 3 }, dueInHours: 2 } },
        }),
      }),
    );
    await expect(service.validateDraft(5, designer)).resolves.toMatchObject({ ok: true });
  });

  it('étape agent : refusée sans exécuteur « agent », acceptée avec ; refusée aussi sans registre injecté', async () => {
    const without = setup(false);
    without.prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    without.prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph: agentGraph() }));
    const refused = await without.service.validateDraft(5, designer);
    expect(refused.ok).toBe(false);
    expect(refused.issues.map((i) => i.code)).toEqual(['EXECUTOR_MISSING']);

    const withExec = setup(true);
    withExec.prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    withExec.prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph: agentGraph() }));
    await expect(withExec.service.validateDraft(5, designer)).resolves.toMatchObject({ ok: true });

    const prisma = makePrisma();
    const bare = new DefinitionsService(prisma as never);
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph: agentGraph() }));
    expect((await bare.validateDraft(5, designer)).ok).toBe(false);
  });

  it('étape autonome : exige le marquage faible risque de la définition', async () => {
    const { prisma, service } = setup(true);
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph: agentGraph('autonome') }));
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow({ isLowRisk: false }));
    expect((await service.validateDraft(5, designer)).issues.map((i) => i.code)).toContain(
      'AUTONOMY_REQUIRES_LOW_RISK',
    );
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow({ isLowRisk: true }));
    expect((await service.validateDraft(5, designer)).ok).toBe(true);
  });

  it('aucun brouillon : 409', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(null);
    await expect(service.validateDraft(5, designer)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DefinitionsService.publish', () => {
  it('archive l’ancienne publiée AVANT de publier ; hash, auteur, date ; définition publiée ; une transaction', async () => {
    const { prisma, service } = setup();
    const order: string[] = [];
    const g = validGraph();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ status: 1 }));
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ versionNumber: 2, graph: g }));
    prisma.wfDefinitionVersion.updateMany.mockImplementation(async () => {
      order.push('archive-old');
      return { count: 1 };
    });
    prisma.wfDefinitionVersion.update.mockImplementation(async ({ data }: Data) => {
      order.push('publish-new');
      return verRow({ versionNumber: 2, ...data });
    });
    prisma.wfDefinition.update.mockImplementation(async ({ data }: Data) => {
      order.push('definition');
      return defRow({ ...data });
    });
    const out = await service.publish(5, designer);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['archive-old', 'publish-new', 'definition']);
    expect(prisma.wfDefinitionVersion.updateMany.mock.calls[0][0]).toEqual({
      where: { definitionId: 5, status: 1 },
      data: { status: 2 },
    });
    const upd = prisma.wfDefinitionVersion.update.mock.calls[0][0];
    expect(upd.where).toEqual({ wfDefinitionVersionId: 50 });
    expect(upd.data).toMatchObject({ status: 1, publishedBy: 70, graphHash: hashGraph(g) });
    expect(upd.data.publishedAt).toBeInstanceOf(Date);
    expect(prisma.wfDefinition.update.mock.calls[0][0].data).toEqual({ status: 1 });
    expect(out.version.status).toBe(1);
    expect(out.version.graphHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.definition.status).toBe(1);
  });

  it('empreinte indépendante de l’ordre des clés du graphe stocké', async () => {
    const run = async (graph: unknown) => {
      const { prisma, service } = setup();
      prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
      prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph }));
      prisma.wfDefinitionVersion.update.mockImplementation(async ({ data }: Data) => verRow(data));
      prisma.wfDefinition.update.mockResolvedValue(defRow({ status: 1 }));
      return (await service.publish(5, designer)).version.graphHash;
    };
    const reordered = {
      steps: [
        { next: [{ to: 'visa' }], type: 'formulaire', name: 'Saisie', key: 'saisie' },
        { next: [], type: 'validation', name: 'Visa', key: 'visa' },
      ],
      start: 'saisie',
      schemaVersion: 1,
    };
    expect(await run(validGraph())).toBe(await run(reordered));
  });

  it('graphe invalide : 422 avec les issues, rien n’est écrit', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(
      verRow({ graph: { schemaVersion: 1, start: 'nope', steps: [{ key: 'a', name: 'A', type: 'formulaire', next: [] }] } }),
    );
    const err = await service.publish(5, designer).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse().issues.map((i: { code: string }) => i.code)).toContain('START_NOT_FOUND');
    expect(prisma.wfDefinitionVersion.updateMany).not.toHaveBeenCalled();
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
    expect(prisma.wfDefinition.update).not.toHaveBeenCalled();
  });

  it('escalade invalide ou agent sans exécuteur : 422, rien d’écrit', async () => {
    const { prisma, service } = setup(false);
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValueOnce(
      verRow({ graph: validGraph({ config: { escalation: { assignee: { kind: 'team', id: 1 } } } }) }),
    );
    await expect(service.publish(5, designer)).rejects.toBeInstanceOf(UnprocessableEntityException);

    prisma.wfDefinitionVersion.findFirst.mockResolvedValueOnce(verRow({ graph: agentGraph() }));
    const err = await service.publish(5, designer).catch((e) => e);
    expect(err.getResponse().issues[0].code).toBe('EXECUTOR_MISSING');
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
    expect(prisma.wfDefinitionVersion.updateMany).not.toHaveBeenCalled();
  });

  it('workflow archivé : 409 ; pas de brouillon : 409', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow({ status: 2 }));
    await expect(service.publish(5, designer)).rejects.toBeInstanceOf(ConflictException);
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(null);
    await expect(service.publish(5, designer)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
  });
});

describe('DefinitionsService.archive', () => {
  it('définition à 2 et version publiée à 2, dans une transaction', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ status: 1 }));
    prisma.wfDefinition.update.mockResolvedValue(defRow({ status: 2 }));
    const out = await service.archive(5, designer);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.wfDefinitionVersion.updateMany.mock.calls[0][0]).toEqual({
      where: { definitionId: 5, status: 1 },
      data: { status: 2 },
    });
    expect(prisma.wfDefinition.update.mock.calls[0][0].data).toEqual({ status: 2 });
    expect(out.status).toBe(2);
  });

  it('déjà archivé : sans effet ; inconnu : 404', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow({ status: 2 }));
    await expect(service.archive(5, designer)).resolves.toMatchObject({ status: 2 });
    expect(prisma.wfDefinition.update).not.toHaveBeenCalled();
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(null);
    await expect(service.archive(5, designer)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DefinitionsService.setLowRisk', () => {
  it('réservé aux administrateurs, même si le garde a laissé passer', async () => {
    const { prisma, service } = setup();
    await expect(service.setLowRisk(5, true, designer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.wfDefinition.update).not.toHaveBeenCalled();
  });

  it('relit isAdmin en base : un jeton administrateur périmé est refusé', async () => {
    const { prisma, service } = setup();
    prisma.appUser.findUnique.mockResolvedValueOnce({ isAdmin: false, isDisabled: false });
    await expect(service.setLowRisk(5, true, admin)).rejects.toBeInstanceOf(ForbiddenException);
    prisma.appUser.findUnique.mockResolvedValueOnce({ isAdmin: true, isDisabled: true });
    await expect(service.setLowRisk(5, true, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.wfDefinition.update).not.toHaveBeenCalled();
  });

  it('pose le marquage avec l’administrateur et la date', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinition.update.mockImplementation(async ({ data }: Data) => defRow(data));
    const out = await service.setLowRisk(5, true, admin);
    const data = prisma.wfDefinition.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ isLowRisk: true, lowRiskMarkedBy: 10 });
    expect(data.lowRiskMarkedAt).toBeInstanceOf(Date);
    expect(out.isLowRisk).toBe(true);
    expect(out.lowRiskMarkedBy).toBe(10);
  });

  it('retrait refusé par le déclencheur SQL : 409 en français ; autre erreur : propagée', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ isLowRisk: true }));
    prisma.wfDefinition.update.mockRejectedValueOnce(
      Object.assign(new Error('retrait refusé (check_violation)'), { code: 'P2010', meta: { code: '23514' } }),
    );
    const err = await service.setLowRisk(5, false, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('étape agent autonome');

    const boom = new Error('connexion perdue');
    prisma.wfDefinition.update.mockRejectedValueOnce(boom);
    await expect(service.setLowRisk(5, false, admin)).rejects.toBe(boom);
  });

  it('une erreur de déclencheur à la POSE n’est pas déguisée en refus de retrait', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    const e = Object.assign(new Error('check_violation'), { code: 'P2010' });
    prisma.wfDefinition.update.mockRejectedValueOnce(e);
    await expect(service.setLowRisk(5, true, admin)).rejects.toBe(e);
  });

  it('définition inconnue : 404', async () => {
    const { prisma, service } = setup();
    prisma.wfDefinition.findUnique.mockResolvedValue(null);
    await expect(service.setLowRisk(5, true, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});
