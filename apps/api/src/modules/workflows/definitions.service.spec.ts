import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { WfGraph } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { agentSpecHash, evalCasesHash } from './agent-spec-hash';
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
    // Lot W2 : configuration des agents (lignes, outils, registre, autorisations, jeux et runs d'évaluation).
    wfAgentConfig: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    wfAgentConfigTool: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    wfTool: { findMany: jest.fn().mockResolvedValue([]) },
    wfToolGrant: { findMany: jest.fn().mockResolvedValue([]) },
    wfEvalSet: { findUnique: jest.fn().mockResolvedValue(null) },
    wfEvalRun: { findMany: jest.fn().mockResolvedValue([]) },
    wfEvalCase: { findMany: jest.fn().mockResolvedValue([]) },
    // Verrou `SELECT … FOR UPDATE` de la définition.
    $queryRaw: jest.fn().mockResolvedValue([]),
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
    // Marquage posé : reste le contrôle d'éligibilité (jeu d'évaluation lié, run réussi), couvert plus bas.
    expect((await service.validateDraft(5, designer)).issues.map((i) => i.code)).toEqual(['AGENT_AUTONOMY_NOT_ELIGIBLE']);
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

// ---------------------------------------------------------------------------
// Lot W2 : configuration des agents sur le brouillon
// ---------------------------------------------------------------------------

function agentSpecOf(over: Record<string, unknown> = {}) {
  return { objective: 'Résumer', tools: [] as string[], confidenceThreshold: 0.8, autonomy: 'suggere', ...over };
}

function graphWithAgent(spec: Record<string, unknown> | undefined, extraStep = true): WfGraph {
  const steps: Array<Record<string, unknown>> = [
    { key: 'ia', name: 'Analyse', type: 'agent', ...(spec ? { agent: spec } : {}), next: extraStep ? [{ to: 'visa' }] : [] },
  ];
  if (extraStep) steps.push({ key: 'visa', name: 'Visa', type: 'validation', next: [] });
  return { schemaVersion: 1, start: 'ia', steps } as unknown as WfGraph;
}

const DOC_READ = { wfToolId: 3, toolKey: 'doc.read', isEnabled: true };
const MAIL_SEND = { wfToolId: 4, toolKey: 'mail.send', isEnabled: false };

function rowOf(over: Record<string, unknown> = {}) {
  return {
    wfAgentConfigId: 31,
    definitionVersionId: 50,
    stepKey: 'ia',
    objective: 'Résumer',
    autonomyLevel: 0,
    confidenceThreshold: '0.800',
    model: null,
    maxSteps: 10,
    maxCostPerRun: null,
    timeoutSeconds: 120,
    evalSetId: null,
    createdAt: NOW,
    updatedAt: NOW,
    tools: [] as Array<{ toolId: number }>,
    ...over,
  };
}

function expectedHash(over: Record<string, unknown> = {}): string {
  return agentSpecHash({
    objective: 'Résumer',
    tools: [],
    confidenceThreshold: 0.8,
    model: null,
    maxSteps: 10,
    maxCostPerRun: null,
    timeoutSeconds: 120,
    ...over,
  });
}

describe('DefinitionsService.upsertAgentConfig', () => {
  function draftWith(prisma: ReturnType<typeof makePrisma>, graph: WfGraph, ver: Record<string, unknown> = {}) {
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph, ...ver }));
    prisma.wfDefinitionVersion.update.mockImplementation(async ({ data }: Data) => verRow(data));
  }

  it('identité machine : 403 sans toucher la base', async () => {
    const { prisma, service } = setup(true);
    await expect(service.upsertAgentConfig(5, 'ia', { objective: 'x' }, machine)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listAgentConfigs(5, noGroup)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.wfDefinition.findUnique).not.toHaveBeenCalled();
  });

  it('dernière version publiée : 409, rien d’écrit', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf()), { status: 1 });
    await expect(service.upsertAgentConfig(5, 'ia', { objective: 'Autre' }, designer)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.listAgentConfigs(5, designer)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
    expect(prisma.wfAgentConfig.create).not.toHaveBeenCalled();
  });

  it('workflow archivé : 409 ; inconnu : 404 ; étape absente : 404 ; étape non agent : 422', async () => {
    const { prisma, service } = setup(true);
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(defRow({ status: 2 }));
    await expect(service.upsertAgentConfig(5, 'ia', { objective: 'x' }, designer)).rejects.toBeInstanceOf(ConflictException);
    prisma.wfDefinition.findUnique.mockResolvedValueOnce(null);
    await expect(service.upsertAgentConfig(5, 'ia', { objective: 'x' }, designer)).rejects.toBeInstanceOf(NotFoundException);
    draftWith(prisma, graphWithAgent(agentSpecOf()));
    await expect(service.upsertAgentConfig(5, 'zzz', { objective: 'x' }, designer)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.upsertAgentConfig(5, 'visa', { objective: 'x' }, designer)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
  });

  it('outil inconnu ou désactivé : 422, rien d’écrit', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf()));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ, MAIL_SEND]);
    const err = await service.upsertAgentConfig(5, 'ia', { tools: ['doc.read', 'mail.send', 'absent.tool'] }, designer).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.message).toContain('mail.send');
    expect(err.message).toContain('absent.tool');
    expect(err.message).not.toContain('doc.read');
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
    expect(prisma.wfAgentConfig.create).not.toHaveBeenCalled();
  });

  it('jeu d’évaluation d’un autre workflow ou inexistant : 422', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf()));
    prisma.wfEvalSet.findUnique.mockResolvedValueOnce({ definitionId: 99 });
    await expect(service.upsertAgentConfig(5, 'ia', { evalSetId: 8 }, designer)).rejects.toBeInstanceOf(UnprocessableEntityException);
    prisma.wfEvalSet.findUnique.mockResolvedValueOnce(null);
    await expect(service.upsertAgentConfig(5, 'ia', { evalSetId: 8 }, designer)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
  });

  it('création : graphe (source de vérité) ET ligne ET outils dans UNE transaction ; empreinte renvoyée', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf()));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ]);
    prisma.wfEvalSet.findUnique.mockResolvedValue({ definitionId: 5 });
    prisma.wfAgentConfig.create.mockImplementation(async ({ data }: Data) => rowOf({ ...data, wfAgentConfigId: 31, evalSetId: data.evalSetId }));

    const out = await service.upsertAgentConfig(
      5,
      'ia',
      {
        objective: 'Classer le courrier',
        tools: ['doc.read'],
        confidenceThreshold: 0.8333,
        autonomy: 'agit_avec_validation',
        model: 'modele-x',
        maxSteps: 7,
        maxCostPerRun: 1.23456,
        timeoutSeconds: 300,
        evalSetId: 8,
      },
      designer,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const graphWritten = prisma.wfDefinitionVersion.update.mock.calls[0][0].data.graph as WfGraph;
    expect(graphWritten.steps[0]!.agent).toEqual({
      objective: 'Classer le courrier',
      tools: ['doc.read'],
      confidenceThreshold: 0.833,
      autonomy: 'agit_avec_validation',
      model: 'modele-x',
      maxSteps: 7,
      maxCostPerRun: 1.2346,
    });
    expect(graphWritten.steps[1]).toMatchObject({ key: 'visa', type: 'validation' }); // le reste du graphe est intact
    expect(prisma.wfAgentConfig.create.mock.calls[0][0].data).toMatchObject({
      definitionVersionId: 50,
      stepKey: 'ia',
      objective: 'Classer le courrier',
      autonomyLevel: 1,
      confidenceThreshold: 0.833,
      model: 'modele-x',
      maxSteps: 7,
      maxCostPerRun: 1.2346,
      timeoutSeconds: 300,
      evalSetId: 8,
    });
    expect(prisma.wfAgentConfigTool.deleteMany).toHaveBeenCalledWith({ where: { agentConfigId: 31 } });
    expect(prisma.wfAgentConfigTool.createMany.mock.calls[0][0].data).toEqual([{ agentConfigId: 31, toolId: 3 }]);
    expect(out).toMatchObject({
      wfAgentConfigId: 31,
      stepKey: 'ia',
      autonomyLevel: 1,
      confidenceThreshold: '0.833',
      maxCostPerRun: '1.2346',
      timeoutSeconds: 300,
      evalSetId: 8,
      tools: ['doc.read'],
    });
    expect(out.agentSpecHash).toBe(
      expectedHash({
        objective: 'Classer le courrier',
        tools: ['doc.read'],
        confidenceThreshold: 0.833,
        model: 'modele-x',
        maxSteps: 7,
        maxCostPerRun: 1.2346,
        timeoutSeconds: 300,
      }),
    );
  });

  it('modification : champs absents conservés (graphe et ligne), timeout et jeu existants préservés', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf({ tools: ['doc.read'], model: 'm1', maxSteps: 5 })));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ]);
    prisma.wfAgentConfig.findUnique.mockResolvedValue({ wfAgentConfigId: 31, timeoutSeconds: 200, evalSetId: 8 });
    prisma.wfAgentConfig.update.mockImplementation(async ({ data }: Data) => rowOf({ ...data }));

    const out = await service.upsertAgentConfig(5, 'ia', { confidenceThreshold: 0.9 }, designer);

    const graphWritten = prisma.wfDefinitionVersion.update.mock.calls[0][0].data.graph as WfGraph;
    expect(graphWritten.steps[0]!.agent).toEqual({
      objective: 'Résumer',
      tools: ['doc.read'],
      confidenceThreshold: 0.9,
      autonomy: 'suggere',
      model: 'm1',
      maxSteps: 5,
    });
    const upd = prisma.wfAgentConfig.update.mock.calls[0][0];
    expect(upd.where).toEqual({ wfAgentConfigId: 31 });
    expect(upd.data).toMatchObject({ confidenceThreshold: 0.9, model: 'm1', maxSteps: 5, evalSetId: 8, timeoutSeconds: 200 });
    expect(prisma.wfAgentConfig.create).not.toHaveBeenCalled();
    expect(out.tools).toEqual(['doc.read']);
  });

  it('null délie le jeu et retire modèle et plafond', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf({ model: 'm1', maxCostPerRun: 2 })));
    prisma.wfAgentConfig.findUnique.mockResolvedValue({ wfAgentConfigId: 31, timeoutSeconds: 120, evalSetId: 8 });
    prisma.wfAgentConfig.update.mockImplementation(async ({ data }: Data) => rowOf({ ...data }));
    await service.upsertAgentConfig(5, 'ia', { evalSetId: null, model: null, maxCostPerRun: null }, designer);
    const graphWritten = prisma.wfDefinitionVersion.update.mock.calls[0][0].data.graph as WfGraph;
    expect(graphWritten.steps[0]!.agent).not.toHaveProperty('model');
    expect(graphWritten.steps[0]!.agent).not.toHaveProperty('maxCostPerRun');
    expect(prisma.wfAgentConfig.update.mock.calls[0][0].data).toMatchObject({ evalSetId: null, model: null, maxCostPerRun: null });
  });

  it('étape sans configuration ni objectif fourni : 422', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(undefined));
    await expect(service.upsertAgentConfig(5, 'ia', { confidenceThreshold: 0.9 }, designer)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
  });

  it('déclencheur d’autonomie : 409 en français ; autre erreur propagée telle quelle', async () => {
    const { prisma, service } = setup(true);
    draftWith(prisma, graphWithAgent(agentSpecOf()));
    prisma.wfAgentConfig.create.mockRejectedValueOnce(
      Object.assign(new Error('autonomie « autonome » refusée : le workflow n\'est pas marqué faible risque (check_violation)'), { code: 'P2010' }),
    );
    const err = await service.upsertAgentConfig(5, 'ia', { autonomy: 'autonome', evalSetId: null }, designer).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('faible risque');

    prisma.wfAgentConfig.create.mockRejectedValueOnce(
      Object.assign(new Error('autonomie « autonome » refusée : aucun run d\'évaluation réussi pour cette version (check_violation)'), { code: 'P2010' }),
    );
    const err2 = await service.upsertAgentConfig(5, 'ia', { autonomy: 'autonome' }, designer).catch((e) => e);
    expect(err2).toBeInstanceOf(ConflictException);
    expect(err2.message).toContain('run d’évaluation');

    const boom = new Error('connexion perdue');
    prisma.wfAgentConfig.create.mockRejectedValueOnce(boom);
    await expect(service.upsertAgentConfig(5, 'ia', { autonomy: 'autonome' }, designer)).rejects.toBe(boom);
  });
});

describe('DefinitionsService.listAgentConfigs', () => {
  it('le graphe fait foi pour les champs communs ; la ligne apporte timeout, jeu et identifiant ; sans ligne : id 0', async () => {
    const { prisma, service } = setup(true);
    const graph = {
      schemaVersion: 1,
      start: 'a',
      steps: [
        { key: 'a', name: 'A', type: 'agent', agent: agentSpecOf({ objective: 'Du graphe', tools: ['doc.read'] }), next: [{ to: 'b' }] },
        { key: 'b', name: 'B', type: 'agent', agent: agentSpecOf({ objective: 'Sans ligne' }), next: [{ to: 'c' }] },
        { key: 'c', name: 'C', type: 'validation', next: [] },
      ],
    } as unknown as WfGraph;
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph }));
    prisma.wfAgentConfig.findMany.mockResolvedValue([
      rowOf({ stepKey: 'a', objective: 'Périmé dans la ligne', timeoutSeconds: 90, evalSetId: 8 }),
    ]);
    const out = await service.listAgentConfigs(5, designer);
    expect(out.map((c) => c.stepKey)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ wfAgentConfigId: 31, objective: 'Du graphe', timeoutSeconds: 90, evalSetId: 8, tools: ['doc.read'] });
    expect(out[0]!.agentSpecHash).toBe(expectedHash({ objective: 'Du graphe', tools: ['doc.read'], timeoutSeconds: 90 }));
    expect(out[1]).toMatchObject({ wfAgentConfigId: 0, objective: 'Sans ligne', timeoutSeconds: 120, evalSetId: null });
  });
});

describe('DefinitionsService.updateDraft : copie des configurations d’agent', () => {
  it('nouvelle version depuis une publiée : lignes et outils copiés (jeu et délai conservés), autonome ramené à 1', async () => {
    const { prisma, service } = setup(true);
    const graph = graphWithAgent(agentSpecOf());
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow({ status: 1 }));
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ status: 1, versionNumber: 3, graph }));
    prisma.wfDefinitionVersion.create.mockImplementation(async ({ data }: Data) => verRow({ ...data, wfDefinitionVersionId: 60 }));
    prisma.wfAgentConfig.findMany.mockResolvedValue([
      rowOf({ autonomyLevel: 2, evalSetId: 8, timeoutSeconds: 200, tools: [{ toolId: 3 }, { toolId: 4 }] }),
      rowOf({ wfAgentConfigId: 32, stepKey: 'ancienne_etape', tools: [] }),
    ]);
    prisma.wfAgentConfig.create.mockResolvedValue(rowOf());
    await service.updateDraft(5, { changeNote: 'n' }, designer);

    expect(prisma.wfAgentConfig.findMany.mock.calls[0][0].where).toEqual({ definitionVersionId: 50 });
    expect(prisma.wfAgentConfig.create).toHaveBeenCalledTimes(1); // l'étape qui n'est plus agent n'est pas copiée
    const data = prisma.wfAgentConfig.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      definitionVersionId: 60,
      stepKey: 'ia',
      autonomyLevel: 1,
      evalSetId: 8,
      timeoutSeconds: 200,
      tools: { create: [{ toolId: 3 }, { toolId: 4 }] },
    });
  });

  it('brouillon existant modifié : aucune copie', async () => {
    const { prisma, service } = setup(true);
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow());
    prisma.wfDefinitionVersion.update.mockImplementation(async ({ data }: Data) => verRow(data));
    await service.updateDraft(5, { changeNote: 'n' }, designer);
    expect(prisma.wfAgentConfig.findMany).not.toHaveBeenCalled();
    expect(prisma.wfAgentConfig.create).not.toHaveBeenCalled();
  });
});

describe('DefinitionsService : publication des étapes agent', () => {
  function publishSetup(graph: WfGraph, defOver: Record<string, unknown> = {}) {
    const ctx = setup(true);
    const { prisma } = ctx;
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow(defOver));
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph }));
    prisma.wfDefinitionVersion.update.mockImplementation(async ({ data }: Data) => verRow(data));
    prisma.wfDefinition.update.mockResolvedValue(defRow({ status: 1 }));
    prisma.wfAgentConfig.create.mockResolvedValue(rowOf());
    prisma.wfAgentConfig.update.mockResolvedValue(rowOf());
    return ctx;
  }
  const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

  it('synchronisation : lignes créées depuis le graphe AVANT la mise à publication ; outils alignés', async () => {
    const order: string[] = [];
    const { prisma, service } = publishSetup(graphWithAgent(agentSpecOf({ tools: ['doc.read'] })));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ]);
    prisma.wfToolGrant.findMany.mockResolvedValue([{ toolId: 3 }]);
    prisma.wfAgentConfig.create.mockImplementation(async () => {
      order.push('config');
      return rowOf();
    });
    prisma.wfAgentConfigTool.createMany.mockImplementation(async () => {
      order.push('tools');
      return { count: 1 };
    });
    prisma.wfDefinitionVersion.update.mockImplementation(async ({ data }: Data) => {
      order.push('publish');
      return verRow(data);
    });
    await service.publish(5, designer);
    expect(order).toEqual(['config', 'tools', 'publish']);
    expect(prisma.wfAgentConfig.create.mock.calls[0][0].data).toMatchObject({
      definitionVersionId: 50,
      stepKey: 'ia',
      objective: 'Résumer',
      autonomyLevel: 0,
      confidenceThreshold: 0.8,
      maxSteps: 10,
      timeoutSeconds: 120,
    });
    expect(prisma.wfAgentConfig.create.mock.calls[0][0].data).not.toHaveProperty('evalSetId', 8);
    expect(prisma.wfAgentConfigTool.createMany.mock.calls[0][0].data).toEqual([{ agentConfigId: 31, toolId: 3 }]);
  });

  it('ligne existante : mise à jour SANS toucher timeout ni jeu ; outils périmés retirés, nouveaux ajoutés', async () => {
    const { prisma, service } = publishSetup(graphWithAgent(agentSpecOf({ tools: ['doc.read'], autonomy: 'agit_avec_validation' })));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ]);
    prisma.wfToolGrant.findMany.mockResolvedValue([{ toolId: 3 }]);
    prisma.wfAgentConfig.findMany.mockResolvedValue([rowOf({ timeoutSeconds: 200, evalSetId: 8, tools: [{ toolId: 9 }] })]);
    await service.publish(5, designer);
    const upd = prisma.wfAgentConfig.update.mock.calls[0][0];
    expect(upd.where).toEqual({ wfAgentConfigId: 31 });
    expect(upd.data).toMatchObject({ autonomyLevel: 1 });
    expect(upd.data).not.toHaveProperty('timeoutSeconds');
    expect(upd.data).not.toHaveProperty('evalSetId');
    expect(prisma.wfAgentConfigTool.deleteMany).toHaveBeenCalledWith({ where: { agentConfigId: 31, toolId: { in: [9] } } });
    expect(prisma.wfAgentConfigTool.createMany.mock.calls[0][0].data).toEqual([{ agentConfigId: 31, toolId: 3 }]);
  });

  it('lignes des étapes qui ne sont plus agent : supprimées (outils d’abord)', async () => {
    const { prisma, service } = publishSetup(graphWithAgent(agentSpecOf()));
    await service.publish(5, designer);
    expect(prisma.wfAgentConfigTool.deleteMany.mock.calls[0][0]).toEqual({
      where: { agentConfig: { definitionVersionId: 50, stepKey: { notIn: ['ia'] } } },
    });
    expect(prisma.wfAgentConfig.deleteMany.mock.calls[0][0]).toEqual({
      where: { definitionVersionId: 50, stepKey: { notIn: ['ia'] } },
    });
    // Un graphe sans étape agent supprime aussi les lignes orphelines.
    const plain = publishSetup(validGraph());
    await plain.service.publish(5, designer);
    expect(plain.prisma.wfAgentConfig.deleteMany.mock.calls[0][0].where.stepKey).toEqual({ notIn: [] });
  });

  it('AGENT_TOOL_UNKNOWN : outil absent ou désactivé ; AGENT_TOOL_NOT_GRANTED : outil non autorisé au workflow', async () => {
    const { prisma, service } = publishSetup(graphWithAgent(agentSpecOf({ tools: ['doc.read', 'mail.send', 'absent.tool'] })));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ, MAIL_SEND]);
    prisma.wfToolGrant.findMany.mockResolvedValue([]);
    const v = await service.validateDraft(5, designer);
    expect(codes(v)).toEqual(['AGENT_TOOL_UNKNOWN', 'AGENT_TOOL_NOT_GRANTED']);
    expect(v.issues[0]!.message).toContain('mail.send');
    expect(v.issues[0]!.message).toContain('absent.tool');
    expect(v.issues[1]!.message).toContain('doc.read');
    expect(v.issues[0]).toMatchObject({ stepKey: 'ia', path: ['steps', 0, 'agent', 'tools'] });
    // Publication : 422 identique, rien d'écrit.
    const err = await service.publish(5, designer).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse().issues.map((i: { code: string }) => i.code)).toEqual(['AGENT_TOOL_UNKNOWN', 'AGENT_TOOL_NOT_GRANTED']);
    expect(prisma.wfAgentConfig.create).not.toHaveBeenCalled();
    expect(prisma.wfAgentConfigTool.deleteMany).not.toHaveBeenCalled();
    expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
  });

  it('outils tous autorisés : publication acceptée', async () => {
    const { prisma, service } = publishSetup(graphWithAgent(agentSpecOf({ tools: ['doc.read'] })));
    prisma.wfTool.findMany.mockResolvedValue([DOC_READ]);
    prisma.wfToolGrant.findMany.mockResolvedValue([{ toolId: 3 }]);
    expect(prisma.wfToolGrant.findMany).not.toHaveBeenCalled();
    await expect(service.validateDraft(5, designer)).resolves.toMatchObject({ ok: true });
    expect(prisma.wfToolGrant.findMany.mock.calls[0][0].where).toEqual({ definitionId: 5, toolId: { in: [3] } });
  });

  it('AGENT_CONFIG_INVALID : objectif blanc', async () => {
    const { service } = publishSetup(graphWithAgent(agentSpecOf({ objective: '   ' })));
    const v = await service.validateDraft(5, designer);
    expect(codes(v)).toEqual(['AGENT_CONFIG_INVALID']);
    expect(v.issues[0]!.message).toContain('objectif');
  });

  describe('autonomie', () => {
    const autonomous = () => graphWithAgent(agentSpecOf({ autonomy: 'autonome' }));
    const lowRisk = { isLowRisk: true };
    const withSet = (prisma: ReturnType<typeof makePrisma>, set: Record<string, unknown> | null, evalSetId: number | null = 8) => {
      prisma.wfAgentConfig.findMany.mockResolvedValue([rowOf({ evalSetId })]);
      prisma.wfEvalSet.findUnique.mockResolvedValue(set);
    };
    const okSet = { definitionId: 5, isActive: true, minAccuracy: '0.900' };
    const reason = (v: { issues: Array<{ code: string; message: string }> }) => v.issues.find((i) => i.code === 'AGENT_AUTONOMY_NOT_ELIGIBLE')?.message ?? '';

    it('sans jeu d’évaluation lié : refusé', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      withSet(prisma, null, null);
      const v = await service.validateDraft(5, designer);
      expect(codes(v)).toEqual(['AGENT_AUTONOMY_NOT_ELIGIBLE']);
      expect(reason(v)).toContain('aucun jeu');
    });

    it('jeu d’un autre workflow, introuvable ou désactivé : refusé', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      withSet(prisma, { ...okSet, definitionId: 99 });
      expect(reason(await service.validateDraft(5, designer))).toContain('n’appartient pas');
      withSet(prisma, null);
      expect(reason(await service.validateDraft(5, designer))).toContain('introuvable');
      withSet(prisma, { ...okSet, isActive: false });
      expect(reason(await service.validateDraft(5, designer))).toContain('désactivé');
      expect(prisma.wfEvalRun.findMany).not.toHaveBeenCalled();
    });

    it('seuil de précision du jeu sous le plancher (0,8) : refusé', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      withSet(prisma, { ...okSet, minAccuracy: '0.700' });
      const v = await service.validateDraft(5, designer);
      expect(reason(v)).toContain('plancher');
      expect(prisma.wfEvalRun.findMany).not.toHaveBeenCalled();
    });

    it('aucun run réussi (ou seuil du run inférieur à celui du jeu) : refusé ; requête bornée à CETTE version', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      withSet(prisma, okSet);
      prisma.wfEvalRun.findMany.mockResolvedValueOnce([]);
      expect(reason(await service.validateDraft(5, designer))).toContain('aucun run');
      expect(prisma.wfEvalRun.findMany.mock.calls[0][0].where).toEqual({
        evalSetId: 8,
        definitionVersionId: 50,
        status: 1,
        passed: true,
        totalCases: { gt: 0 },
      });
      // Run réussi avec l'ancien seuil 0,8 alors que le jeu exige maintenant 0,9.
      prisma.wfEvalRun.findMany.mockResolvedValueOnce([{ requiredAccuracy: '0.800', results: { agentSpecHash: expectedHash(), casesHash: evalCasesHash([]) } }]);
      expect(reason(await service.validateDraft(5, designer))).toContain('aucun run');
    });

    it('empreinte périmée (configuration changée depuis l’évaluation) : refusé', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      withSet(prisma, okSet);
      prisma.wfEvalRun.findMany.mockResolvedValue([
        { requiredAccuracy: '0.900', results: { agentSpecHash: expectedHash({ objective: 'Ancien objectif' }), casesHash: evalCasesHash([]) } },
        { requiredAccuracy: '0.900', results: null },
      ]);
      const v = await service.validateDraft(5, designer);
      expect(reason(v)).toContain('a changé');
      const err = await service.publish(5, designer).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.wfDefinitionVersion.update).not.toHaveBeenCalled();
    });

    it('run réussi à jour (même empreinte, délai du jeu pris en compte) : accepté et publié', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      prisma.wfAgentConfig.findMany.mockResolvedValue([rowOf({ evalSetId: 8, timeoutSeconds: 60 })]);
      prisma.wfEvalSet.findUnique.mockResolvedValue(okSet);
      prisma.wfEvalRun.findMany.mockResolvedValue([
        { requiredAccuracy: '0.900', results: { agentSpecHash: expectedHash({ timeoutSeconds: 60 }), casesHash: evalCasesHash([]) } },
      ]);
      await expect(service.validateDraft(5, designer)).resolves.toMatchObject({ ok: true });
      await expect(service.publish(5, designer)).resolves.toMatchObject({ version: { status: 1 } });
      expect(prisma.wfAgentConfig.update.mock.calls[0][0].data).toMatchObject({ autonomyLevel: 2 });
    });

    it('cas du jeu modifiés depuis le run réussi : refusé à la publication (empreinte du jeu de cas)', async () => {
      const { prisma, service } = publishSetup(autonomous(), lowRisk);
      prisma.wfAgentConfig.findMany.mockResolvedValue([rowOf({ evalSetId: 8, timeoutSeconds: 60 })]);
      prisma.wfEvalSet.findUnique.mockResolvedValue(okSet);
      prisma.wfEvalRun.findMany.mockResolvedValue([
        { requiredAccuracy: '0.900', results: { agentSpecHash: expectedHash({ timeoutSeconds: 60 }), casesHash: evalCasesHash([]) } },
      ]);
      prisma.wfEvalCase.findMany.mockResolvedValue([{ wfEvalCaseId: 3, input: {}, expected: { returnsToHuman: true } }]);
      const v = await service.validateDraft(5, designer);
      expect(reason(v)).toContain('cas du jeu');
      await expect(service.publish(5, designer)).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('workflow non marqué faible risque : seul le contrôle du graphe signale (pas de doublon)', async () => {
      const { prisma, service } = publishSetup(autonomous(), { isLowRisk: false });
      withSet(prisma, okSet);
      prisma.wfEvalRun.findMany.mockResolvedValue([{ requiredAccuracy: '0.900', results: { agentSpecHash: expectedHash(), casesHash: evalCasesHash([]) } }]);
      expect(codes(await service.validateDraft(5, designer))).toEqual(['AUTONOMY_REQUIRES_LOW_RISK']);
    });
  });

  it('refus du déclencheur SQL à la synchronisation : 422 lisible plutôt que 500', async () => {
    const { prisma, service } = publishSetup(graphWithAgent(agentSpecOf()));
    prisma.wfAgentConfig.create.mockRejectedValueOnce(
      Object.assign(new Error('autonomie « autonome » refusée (check_violation)'), { code: 'P2010' }),
    );
    const err = await service.publish(5, designer).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse().issues[0].code).toBe('AGENT_AUTONOMY_NOT_ELIGIBLE');
    const boom = new Error('connexion perdue');
    prisma.wfAgentConfig.create.mockRejectedValueOnce(boom);
    await expect(service.publish(5, designer)).rejects.toBe(boom);
  });

  it('sans exécuteur « agent » : EXECUTOR_MISSING reste signalé', async () => {
    const prisma = makePrisma();
    const service = new DefinitionsService(prisma as never, registry(false));
    prisma.wfDefinition.findUnique.mockResolvedValue(defRow());
    prisma.wfDefinitionVersion.findFirst.mockResolvedValue(verRow({ graph: graphWithAgent(agentSpecOf()) }));
    expect(codes(await service.validateDraft(5, designer))).toEqual(['EXECUTOR_MISSING']);
  });
});
