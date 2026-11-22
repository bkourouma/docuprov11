import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WF_EVAL_ACCURACY_FLOOR } from '@archivage/types';
import type { AuthUser } from '../../auth/auth.types';
import {
  AgentIdentityError,
  type AgentIdentity,
  type AgentRunInput,
  type AgentRunOutput,
  type AgentRunStopReason,
} from '../agent.contracts';
import type { LoadedAgentConfig } from '../agent-config.loader';
import { EVAL_MAX_ACTIVE_CASES, EvalService } from './eval.service';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const actor: AuthUser = { userId: 1, username: 'conceptrice', isAdmin: false, userGroupId: 10, fullName: 'Conceptrice' };
const machine: AuthUser = { userId: 0, username: 'scan', isAdmin: false, userGroupId: null, isScanAgent: true };

const CONFIG: LoadedAgentConfig = {
  definitionId: 5,
  definitionVersionId: 50,
  stepKey: 'tri',
  objective: 'Classer le courrier',
  autonomy: 1,
  confidenceThreshold: 0.8,
  model: null,
  maxSteps: 10,
  maxCostPerRun: null,
  timeoutSeconds: 120,
  evalSetId: null,
  allowedToolKeys: ['documents.search'],
  rejectedToolKeys: [],
  maxCallsByTool: { 'documents.search': 3 },
  specHash: 'hash-courant',
};

const IDENTITY: AgentIdentity = {
  principal: { userGroupId: 10, userId: 1, groupIds: [], roleId: null },
  user: { userId: 1, username: 'conceptrice', isAdmin: false, userGroupId: 10 },
};

function runnerOutput(over: Partial<AgentRunOutput> = {}, cost = 0.01): AgentRunOutput {
  return {
    outcome: 'final',
    result: { classe: 'facture' },
    explanation: 'ok',
    confidence: 0.95,
    sources: [],
    preparedActions: [],
    suspicionInjection: false,
    suspicionReasons: [],
    audit: {
      instruction: 'x',
      model: 'modele-test',
      aiDecisionIds: [],
      promptTokens: 1,
      completionTokens: 1,
      costAmount: cost,
      steps: 1,
      toolCalls: [],
    },
    ...over,
  };
}

const stopped = (stopReason: AgentRunStopReason): AgentRunOutput =>
  runnerOutput({ outcome: 'stopped', stopReason, result: null, confidence: null });

interface SetRow {
  wfEvalSetId: number;
  definitionId: number;
  stepKey: string | null;
  name: string;
  description: string | null;
  minAccuracy: string;
  isActive: boolean;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}
interface CaseRow {
  wfEvalCaseId: number;
  evalSetId: number;
  label: string;
  input: unknown;
  expected: unknown;
  weight: number;
  sortOrder: number;
  isActive: boolean;
}
interface RunRow {
  wfEvalRunId: bigint;
  evalSetId: number;
  definitionVersionId: number;
  status: number;
  totalCases: number;
  passedCases: number;
  accuracy: string | null;
  requiredAccuracy: string;
  passed: boolean;
  model: string | null;
  results: unknown;
  costAmount: string | null;
  errorMessage: string | null;
  runBy: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const graphWithAgent = (key: string) => ({ steps: [{ key, type: 'agent' }, { key: 'revue', type: 'validation' }] });

interface Options {
  sets?: Partial<SetRow>[];
  cases?: Partial<CaseRow>[];
  autonomousLinked?: number;
  script?: (input: AgentRunInput, n: number) => AgentRunOutput | Promise<AgentRunOutput>;
  config?: LoadedAgentConfig | null;
  identityError?: AgentIdentityError;
  /** Lignes `wf_agent_config` de la version la plus récente (étapes agent). */
  agentConfigs?: { stepKey: string; evalSetId: number | null }[];
  eligibility?: (versionId: number, stepKey: string) => { eligible: boolean; reason?: string };
}

function build(opts: Options = {}) {
  const sets: SetRow[] = (opts.sets ?? [{}]).map((s, i) => ({
    wfEvalSetId: i + 1,
    definitionId: 5,
    stepKey: 'tri',
    name: 'Jeu',
    description: null,
    minAccuracy: '0.900',
    isActive: true,
    createdBy: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...s,
  }));
  const cases: CaseRow[] = (opts.cases ?? []).map((c, i) => ({
    wfEvalCaseId: i + 1,
    evalSetId: 1,
    label: `Cas ${i + 1}`,
    input: { untrusted: [{ label: 'Courrier', origin: 'mail', text: 'SECRET-CONTENU' }] },
    expected: { result: { classe: 'facture' } },
    weight: 1,
    sortOrder: i,
    isActive: true,
    ...c,
  }));
  const runs: RunRow[] = [];
  let runSeq = 100;
  let caseSeq = 1000;
  let setSeq = 50;
  const versions = [
    { wfDefinitionVersionId: 50, definitionId: 5, versionNumber: 1, graph: graphWithAgent('tri') },
    { wfDefinitionVersionId: 51, definitionId: 5, versionNumber: 2, graph: graphWithAgent('tri') },
    { wfDefinitionVersionId: 90, definitionId: 9, versionNumber: 1, graph: graphWithAgent('autre') },
  ];

  const holder: { tx?: unknown } = {};
  const prisma = {
    wfDefinition: {
      findUnique: jest.fn(({ where }: { where: { wfDefinitionId: number } }) =>
        Promise.resolve([5, 9, 7].includes(where.wfDefinitionId) ? { wfDefinitionId: where.wfDefinitionId } : null),
      ),
    },
    wfDefinitionVersion: {
      findUnique: jest.fn(({ where }: { where: { wfDefinitionVersionId: number } }) =>
        Promise.resolve(versions.find((v) => v.wfDefinitionVersionId === where.wfDefinitionVersionId) ?? null),
      ),
      findFirst: jest.fn(({ where }: { where: { definitionId: number } }) =>
        Promise.resolve(
          [...versions].filter((v) => v.definitionId === where.definitionId).sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null,
        ),
      ),
      findMany: jest.fn(({ where }: { where: { definitionId: number } }) =>
        Promise.resolve(versions.filter((v) => v.definitionId === where.definitionId)),
      ),
    },
    wfAgentConfig: {
      count: jest.fn(() => Promise.resolve(opts.autonomousLinked ?? 0)),
      findMany: jest.fn(() => Promise.resolve([...(opts.agentConfigs ?? [])].sort((a, b) => a.stepKey.localeCompare(b.stepKey)))),
    },
    wfEvalSet: {
      findUnique: jest.fn(({ where }: { where: { wfEvalSetId: number } }) =>
        Promise.resolve(sets.find((s) => s.wfEvalSetId === where.wfEvalSetId) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: { definitionId?: number } }) =>
        Promise.resolve(sets.filter((s) => where.definitionId === undefined || s.definitionId === where.definitionId)),
      ),
      create: jest.fn(({ data }: { data: Partial<SetRow> }) => {
        const row = { ...sets[0]!, ...data, wfEvalSetId: ++setSeq } as SetRow;
        sets.push(row);
        return Promise.resolve({ ...row });
      }),
      update: jest.fn(({ where, data }: { where: { wfEvalSetId: number }; data: Partial<SetRow> }) => {
        const row = sets.find((s) => s.wfEvalSetId === where.wfEvalSetId)!;
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      }),
    },
    wfEvalCase: {
      count: jest.fn(({ where }: { where: { evalSetId: number; isActive: boolean } }) =>
        Promise.resolve(cases.filter((c) => c.evalSetId === where.evalSetId && c.isActive === where.isActive).length),
      ),
      aggregate: jest.fn(() => Promise.resolve({ _max: { sortOrder: Math.max(0, ...cases.map((c) => c.sortOrder)) } })),
      create: jest.fn(({ data }: { data: Partial<CaseRow> }) => {
        const row = { isActive: true, ...data, wfEvalCaseId: ++caseSeq } as CaseRow;
        cases.push(row);
        return Promise.resolve({ ...row });
      }),
      findFirst: jest.fn(({ where }: { where: { wfEvalCaseId: number; evalSetId: number } }) =>
        Promise.resolve(cases.find((c) => c.wfEvalCaseId === where.wfEvalCaseId && c.evalSetId === where.evalSetId) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: { evalSetId: number; isActive?: boolean } }) =>
        Promise.resolve(
          cases
            .filter((c) => c.evalSetId === where.evalSetId && (where.isActive === undefined || c.isActive === where.isActive))
            .map((c) => ({ ...c })),
        ),
      ),
      update: jest.fn(({ where, data }: { where: { wfEvalCaseId: number }; data: Partial<CaseRow> }) => {
        const row = cases.find((c) => c.wfEvalCaseId === where.wfEvalCaseId)!;
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      }),
    },
    wfEvalRun: {
      create: jest.fn(({ data }: { data: Partial<RunRow> }) => {
        const row: RunRow = {
          wfEvalRunId: BigInt(++runSeq),
          status: 0,
          totalCases: 0,
          passedCases: 0,
          accuracy: null,
          passed: false,
          model: null,
          results: null,
          costAmount: null,
          errorMessage: null,
          startedAt: new Date(),
          finishedAt: null,
          ...data,
        } as RunRow;
        runs.push(row);
        return Promise.resolve({ ...row });
      }),
      // Comme le SQL : un run terminé est figé, seul le statut 0 peut être modifié.
      updateMany: jest.fn(
        ({ where, data }: { where: { wfEvalRunId?: bigint; status: number; startedAt?: { lt: Date } }; data: Partial<RunRow> }) => {
          const hit = runs.filter(
            (r) =>
              r.status === where.status &&
              (where.wfEvalRunId === undefined || r.wfEvalRunId === where.wfEvalRunId) &&
              (where.startedAt === undefined || r.startedAt < where.startedAt.lt),
          );
          for (const r of hit) Object.assign(r, data);
          return Promise.resolve({ count: hit.length });
        },
      ),
      findMany: jest.fn(({ where }: { where: { evalSetId: number } }) =>
        Promise.resolve(runs.filter((r) => r.evalSetId === where.evalSetId).map((r) => ({ ...r }))),
      ),
      findUnique: jest.fn(({ where }: { where: { wfEvalRunId: bigint } }) => {
        const r = runs.find((x) => x.wfEvalRunId === where.wfEvalRunId);
        return Promise.resolve(r ? { ...r } : null);
      }),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(holder.tx)),
  };

  holder.tx = prisma;
  const calls: AgentRunInput[] = [];
  const runner = {
    run: jest.fn(async (input: AgentRunInput) => {
      calls.push(input);
      return opts.script ? opts.script(input, calls.length) : runnerOutput();
    }),
  };
  const identity = {
    resolve: jest.fn(() => (opts.identityError ? Promise.reject(opts.identityError) : Promise.resolve(IDENTITY))),
  };
  const loader = { load: jest.fn(() => Promise.resolve(opts.config === undefined ? CONFIG : opts.config)) };
  const audit = { dataChange: jest.fn((_entry: unknown) => Promise.resolve()) };
  const eligibility = {
    check: jest.fn((versionId: number, stepKey: string) =>
      Promise.resolve(opts.eligibility ? opts.eligibility(versionId, stepKey) : { eligible: true }),
    ),
  };
  const service = new EvalService(prisma as never, runner, identity, loader as never, audit as never, eligibility as never);
  return { service, prisma, runner, identity, loader, audit, eligibility, sets, cases, runs, calls };
}

const snap = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

const manyCases = (n: number, over: Partial<CaseRow> = {}): Partial<CaseRow>[] => Array.from({ length: n }, () => ({ ...over }));

/** Cas « réussi » si le runner répond la classe attendue, « échoué » si le cas attend autre chose. */
const failing: Partial<CaseRow> = { expected: { result: { classe: 'devis' } } };

describe('EvalService : jeux', () => {
  it('createSet : seuil par défaut 0,9, créateur journalisé', async () => {
    const { service, audit } = build();
    const dto = await service.createSet({ definitionId: 5, name: 'Nouveau', stepKey: 'tri' }, actor);
    expect(dto).toMatchObject({ definitionId: 5, minAccuracy: '0.900', stepKey: 'tri', createdBy: 10 });
    expect(audit.dataChange).toHaveBeenCalledWith(expect.objectContaining({ objectRef: `wf_eval_set:${dto.wfEvalSetId}` }));
  });

  it('plancher : un seuil < 0,8 est refusé en 422 à la création (0,7999 aussi), 0,8 accepté', async () => {
    const { service } = build();
    for (const minAccuracy of [0, 0.5, 0.799]) {
      await expect(service.createSet({ definitionId: 5, name: 'x', minAccuracy }, actor)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    }
    await expect(service.createSet({ definitionId: 5, name: 'x', minAccuracy: WF_EVAL_ACCURACY_FLOOR }, actor)).resolves.toBeDefined();
  });

  it('plancher : jamais abaissé sous 0,8 à la modification (422), même sans étape autonome', async () => {
    const { service, prisma } = build();
    await expect(service.updateSet(1, { minAccuracy: 0.5 }, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.wfEvalSet.update).not.toHaveBeenCalled();
  });

  it('abaisser (au-dessus du plancher) un jeu lié à une étape autonome : 409 ; le relever reste permis', async () => {
    const { service, prisma } = build({ autonomousLinked: 1 });
    await expect(service.updateSet(1, { minAccuracy: 0.85 }, actor)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wfEvalSet.update).not.toHaveBeenCalled();
    await expect(service.updateSet(1, { minAccuracy: 0.95 }, actor)).resolves.toMatchObject({ minAccuracy: '0.950' });
  });

  it('abaisser un jeu non lié à une étape autonome est permis (au-dessus du plancher)', async () => {
    const { service } = build();
    await expect(service.updateSet(1, { minAccuracy: 0.85 }, actor)).resolves.toMatchObject({ minAccuracy: '0.850' });
  });

  it('désactiver un jeu lié à une configuration autonome : 409 ; sinon permis ; réactiver toujours permis', async () => {
    const linked = build({ autonomousLinked: 2 });
    await expect(linked.service.updateSet(1, { isActive: false }, actor)).rejects.toBeInstanceOf(ConflictException);
    const free = build();
    await expect(free.service.updateSet(1, { isActive: false }, actor)).resolves.toMatchObject({ isActive: false });
    const inactiveLinked = build({ autonomousLinked: 2, sets: [{ isActive: false }] });
    await expect(inactiveLinked.service.updateSet(1, { isActive: true }, actor)).resolves.toMatchObject({ isActive: true });
  });

  it('definitionId est immuable : une valeur différente est refusée (422), la même est ignorée', async () => {
    const { service, prisma } = build();
    await expect(service.updateSet(1, { definitionId: 9 }, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.wfEvalSet.update).not.toHaveBeenCalled();
    await expect(service.updateSet(1, { definitionId: 5 }, actor)).resolves.toMatchObject({ definitionId: 5 });
    for (const call of prisma.wfEvalSet.update.mock.calls) {
      expect((call[0] as { data: object }).data).not.toHaveProperty('definitionId');
    }
  });

  it('stepKey : doit être une étape agent d’une version du workflow (422), sinon 404 pour un workflow inconnu', async () => {
    const { service } = build();
    await expect(service.createSet({ definitionId: 5, name: 'x', stepKey: 'revue' }, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(service.createSet({ definitionId: 5, name: 'x', stepKey: 'autre' }, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(service.createSet({ definitionId: 777, name: 'x' }, actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateSet(1, { stepKey: 'inconnue' }, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.updateSet(1, { stepKey: null }, actor)).resolves.toMatchObject({ stepKey: null });
  });

  it('liste filtrée par workflow, lecture d’un jeu inconnu : 404', async () => {
    const { service } = build({ sets: [{}, { definitionId: 9 }] });
    expect(await service.listSets()).toHaveLength(2);
    expect(await service.listSets(9)).toHaveLength(1);
    await expect(service.getSet(999)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('identité machine ou sans groupe : refusée sur toute écriture et tout run', async () => {
    const { service } = build({ cases: manyCases(1) });
    await expect(service.createSet({ definitionId: 5, name: 'x' }, machine)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateSet(1, { name: 'x' }, machine)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.addCase(1, { label: 'c', input: {}, expected: { returnsToHuman: true } }, machine),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.removeCase(1, 1, machine)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.runSet(1, {}, machine)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EvalService : cas', () => {
  const valid = { label: 'Facture', input: {}, expected: { result: { classe: 'facture' } } };

  it('ajoute un cas (poids 1 par défaut, ordre à la suite) sans mettre son contenu dans le journal', async () => {
    const { service, audit } = build({ cases: manyCases(2) });
    const dto = await service.addCase(1, { ...valid, input: { untrusted: [{ label: 'M', origin: 'mail', text: 'TEXTE-SENSIBLE' }] } }, actor);
    expect(dto).toMatchObject({ evalSetId: 1, weight: 1, isActive: true });
    expect(dto.sortOrder).toBe(2);
    expect(JSON.stringify(audit.dataChange.mock.calls)).not.toContain('TEXTE-SENSIBLE');
  });

  it('plafond de 500 cas actifs : le 501e est refusé (422) ; un cas désactivé ne compte pas', async () => {
    const { service } = build({ cases: manyCases(EVAL_MAX_ACTIVE_CASES) });
    await expect(service.addCase(1, valid, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const lighter = build({ cases: [...manyCases(EVAL_MAX_ACTIVE_CASES - 1), { isActive: false }] });
    await expect(lighter.service.addCase(1, valid, actor)).resolves.toBeDefined();
  });

  it('la réactivation d’un cas respecte aussi le plafond', async () => {
    const { service } = build({ cases: [...manyCases(EVAL_MAX_ACTIVE_CASES), { isActive: false }] });
    await expect(service.updateCase(1, EVAL_MAX_ACTIVE_CASES + 1, { isActive: true }, actor)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('refuse un cas dépassant 64 Kio (service, en plus de zod)', async () => {
    const { service } = build();
    const huge = { untrusted: Array.from({ length: 4 }, () => ({ label: 'L', origin: 'document' as const, text: 'x'.repeat(20_000) })) };
    await expect(service.addCase(1, { ...valid, input: huge }, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('supprimer = désactiver (ligne conservée, idempotent) ; la liste par défaut ne montre que les cas actifs', async () => {
    const { service, cases } = build({ cases: manyCases(3) });
    const dto = await service.removeCase(1, 2, actor);
    expect(dto.isActive).toBe(false);
    expect(cases).toHaveLength(3);
    await expect(service.removeCase(1, 2, actor)).resolves.toMatchObject({ isActive: false });
    expect(await service.listCases(1)).toHaveLength(2);
    expect(await service.listCases(1, true)).toHaveLength(3);
    await expect(service.removeCase(1, 999, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('modifie un cas d’un autre jeu : introuvable', async () => {
    const { service } = build({ cases: [{ evalSetId: 2 }] });
    await expect(service.updateCase(1, 1, { label: 'x' }, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EvalService : evalContext', () => {
  it('le contexte du cas est transmis au runner (scope.evalContext) ; absent si le cas n’en a pas', async () => {
    const { service, calls } = build({
      cases: [
        { input: { context: { delegates: [{ userGroupId: 8 }] } } },
        { input: { untrusted: [{ label: 'M', origin: 'mail', text: 'x' }] } },
      ],
    });
    await service.runSet(1, {}, actor);
    await service.whenIdle();
    expect(calls[0]!.scope.evalContext).toEqual({ delegates: [{ userGroupId: 8 }] });
    expect(calls[1]!.scope).not.toHaveProperty('evalContext');
  });
});

describe('EvalService : getEligibilityStatus', () => {
  it('workflow inexistant : 404', async () => {
    const { service } = build();
    await expect(service.getEligibilityStatus(404)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('workflow sans version : 422 en français', async () => {
    const { service } = build();
    const err = await service.getEligibilityStatus(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toBe('Ce workflow n’a encore aucune version.');
  });

  it('aucune étape agent : steps vide, dernière version', async () => {
    const { service, eligibility } = build();
    await expect(service.getEligibilityStatus(5)).resolves.toEqual({
      definitionId: 5,
      definitionVersionId: 51,
      versionNumber: 2,
      steps: [],
    });
    expect(eligibility.check).not.toHaveBeenCalled();
  });

  it('étapes triées par clé : éligible (reason null) et non éligible (raison du service), sans écriture', async () => {
    const { service, eligibility, audit, prisma } = build({
      agentConfigs: [
        { stepKey: 'tri', evalSetId: 1 },
        { stepKey: 'analyse', evalSetId: null },
      ],
      eligibility: (_v, key) =>
        key === 'tri' ? { eligible: true } : { eligible: false, reason: 'Aucun jeu d’évaluation n’est lié à cette étape.' },
    });
    await expect(service.getEligibilityStatus(5)).resolves.toEqual({
      definitionId: 5,
      definitionVersionId: 51,
      versionNumber: 2,
      steps: [
        { stepKey: 'analyse', evalSetId: null, eligible: false, reason: 'Aucun jeu d’évaluation n’est lié à cette étape.' },
        { stepKey: 'tri', evalSetId: 1, eligible: true, reason: null },
      ],
    });
    expect(eligibility.check).toHaveBeenCalledWith(51, 'tri');
    expect(audit.dataChange).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('EvalService : runs', () => {
  it('renvoie IMMÉDIATEMENT le run « en cours » ; le runner n’est appelé qu’en arrière-plan', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { service, runner, runs } = build({ cases: manyCases(2), script: async () => (await gate, runnerOutput()) });
    const dto = await service.runSet(1, {}, actor);
    expect(dto).toMatchObject({ status: 0, totalCases: 2, passed: false, accuracy: null, finishedAt: null, requiredAccuracy: '0.900' });
    expect(typeof dto.wfEvalRunId).toBe('string');
    release();
    await service.whenIdle();
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runs[0]).toMatchObject({ status: 1, passed: true });
  });

  it('refuse une version d’un AUTRE workflow (422), ignore la dernière version par défaut sinon', async () => {
    const { service, runs } = build({ cases: manyCases(1) });
    await expect(service.runSet(1, { definitionVersionId: 90 }, actor)).rejects.toThrow(
      'Un jeu lié à une version ne change pas de workflow.',
    );
    await expect(service.runSet(1, { definitionVersionId: 90 }, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(service.runSet(1, { definitionVersionId: 4242 }, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(runs).toHaveLength(0);
    const dto = await service.runSet(1, {}, actor);
    expect(dto.definitionVersionId).toBe(51); // dernière version du workflow 5
    await service.whenIdle();
    const explicit = await service.runSet(1, { definitionVersionId: 50 }, actor);
    expect(explicit.definitionVersionId).toBe(50);
    await service.whenIdle();
  });

  it('étape : celle du jeu, sinon le paramètre, sinon 422 ; non agent => 422', async () => {
    const bound = build({ cases: manyCases(1) });
    await bound.service.runSet(1, {}, actor);
    await bound.service.whenIdle();
    expect(bound.loader.load).toHaveBeenCalledWith(51, 'tri');
    await expect(bound.service.runSet(1, { stepKey: 'autre' }, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);

    const free = build({ cases: manyCases(1), sets: [{ stepKey: null }] });
    await expect(free.service.runSet(1, {}, actor)).rejects.toThrow('Indiquez l’étape agent');
    await free.service.runSet(1, { stepKey: 'tri' }, actor);
    await free.service.whenIdle();
    expect(free.loader.load).toHaveBeenCalledWith(51, 'tri');

    const notAgent = build({ cases: manyCases(1), config: null });
    await expect(notAgent.service.runSet(1, {}, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('aucun cas actif : 422 (total_cases > 0), aucun run créé ; seuls les cas inactifs ne comptent pas', async () => {
    const { service, runs } = build({ cases: [{ isActive: false }] });
    await expect(service.runSet(1, {}, actor)).rejects.toThrow('Aucun cas actif');
    expect(runs).toHaveLength(0);
  });

  it('jeu désactivé : aucun run', async () => {
    const { service } = build({ cases: manyCases(1), sets: [{ isActive: false }] });
    await expect(service.runSet(1, {}, actor)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('identité de l’acteur (jamais celle d’un autre) ; identité refusée => 403 sans run', async () => {
    const ok = build({ cases: manyCases(1) });
    await ok.service.runSet(1, {}, actor);
    await ok.service.whenIdle();
    expect(ok.identity.resolve).toHaveBeenCalledWith(10);
    expect(ok.calls[0]).toMatchObject({ identity: IDENTITY, requestedBy: 10, mode: 'dry_run' });

    const refused = build({ cases: manyCases(1), identityError: new AgentIdentityError('no_launch_right', 'Droit retiré.') });
    await expect(refused.service.runSet(1, {}, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(refused.runs).toHaveLength(0);
  });

  it('exécute en mode dry_run avec la configuration chargée (outils, seuil, autonomie) et l’entrée du cas', async () => {
    const { service, calls } = build({
      cases: [
        {
          input: {
            untrusted: [{ label: 'Courrier', origin: 'mail', text: 'Bonjour' }],
            subject: { type: 'mail', id: '12' },
            context: { langue: 'fr' },
          },
        },
      ],
    });
    await service.runSet(1, {}, actor);
    await service.whenIdle();
    const input = calls[0]!;
    expect(input.mode).toBe('dry_run');
    expect(input.scope).toEqual({
      definitionId: 5,
      stepKey: 'tri',
      subject: { type: 'mail', id: '12' },
      evalContext: { langue: 'fr' },
    });
    expect(input.scope.instanceId).toBeUndefined();
    expect(input.spec).toMatchObject({
      objective: 'Classer le courrier',
      autonomy: 1,
      confidenceThreshold: 0.8,
      allowedToolKeys: ['documents.search'],
      remainingToolCalls: { 'documents.search': 3 },
      maxSteps: 10,
      timeoutSeconds: 120,
    });
    expect(input.untrusted).toEqual([
      { label: 'Courrier', origin: 'mail', text: 'Bonjour' },
      { label: 'Contexte', origin: 'context', text: '{"langue":"fr"}' },
    ]);
  });

  it('exécution SÉQUENTIELLE : jamais deux cas en même temps', async () => {
    let active = 0;
    let peak = 0;
    const { service } = build({
      cases: manyCases(4),
      script: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return runnerOutput();
      },
    });
    await service.runSet(1, {}, actor);
    await service.whenIdle();
    expect(peak).toBe(1);
  });

  describe('résultat du run', () => {
    it('réussi : cohérence total / passés / précision / seuil figé / empreinte / coût, sans contenu de document', async () => {
      const { service, runs } = build({
        cases: [...manyCases(9), failing],
        script: () => runnerOutput({}, 0.0123),
      });
      const created = await service.runSet(1, {}, actor);
      await service.whenIdle();
      const row = runs[0]!;
      expect(created.wfEvalRunId).toBe(String(row.wfEvalRunId));
      expect(row).toMatchObject({
        status: 1,
        totalCases: 10,
        passedCases: 9,
        accuracy: '0.900',
        requiredAccuracy: '0.900',
        passed: true,
        model: 'modele-test',
        costAmount: '0.1230',
        errorMessage: null,
        runBy: 10,
      });
      expect(row.finishedAt).toBeInstanceOf(Date);
      const results = row.results as { agentSpecHash: string; stepKey: string; cases: Array<Record<string, unknown>> };
      expect(results.agentSpecHash).toBe('hash-courant');
      expect(results.stepKey).toBe('tri');
      expect(results.cases).toHaveLength(10);
      expect(results.cases[0]).toMatchObject({ caseId: 1, passed: true, confidence: 0.95, disposition: 'propose' });
      expect(results.cases[9]).toMatchObject({ caseId: 10, passed: false });
      expect(JSON.stringify(row.results)).not.toContain('SECRET-CONTENU');
      expect(JSON.stringify(row.results)).not.toContain('facture');
    });

    it('échec : sous le seuil, passed = false mais le run est terminé (statut 1)', async () => {
      const { service, runs } = build({ cases: [...manyCases(8), failing, failing] });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      expect(runs[0]).toMatchObject({ status: 1, totalCases: 10, passedCases: 8, accuracy: '0.800', passed: false });
    });

    it('arrondi limite : 399/499 = 0,7996 ne réussit PAS à 0,8 (affiché 0,800) ; 4/5 = 0,8 réussit', async () => {
      const limit = { sets: [{ minAccuracy: '0.800' }] };
      const below = build({ ...limit, cases: [...manyCases(399), ...manyCases(100, failing)] });
      await below.service.runSet(1, {}, actor);
      await below.service.whenIdle();
      expect(below.runs[0]).toMatchObject({ status: 1, totalCases: 499, passedCases: 399, accuracy: '0.800', requiredAccuracy: '0.800', passed: false });

      const exact = build({ ...limit, cases: [...manyCases(4), failing] });
      await exact.service.runSet(1, {}, actor);
      await exact.service.whenIdle();
      expect(exact.runs[0]).toMatchObject({ status: 1, totalCases: 5, passedCases: 4, accuracy: '0.800', passed: true });
    });

    it('seuil figé au lancement : max(seuil du jeu, plancher), même si le jeu change ensuite', async () => {
      const { service, runs, sets } = build({ cases: manyCases(1), sets: [{ minAccuracy: '0.800' }] });
      await service.runSet(1, {}, actor);
      sets[0]!.minAccuracy = '0.990'; // modifié après coup : le run garde son seuil
      await service.whenIdle();
      expect(runs[0]!.requiredAccuracy).toBe('0.800');
      // jeu historique en dessous du plancher (écrit avant la règle) : le plancher s'applique.
      const old = build({ cases: manyCases(1), sets: [{ minAccuracy: '0.500' }] });
      await old.service.runSet(1, {}, actor);
      await old.service.whenIdle();
      expect(old.runs[0]!.requiredAccuracy).toBe('0.800');
    });

    it('le poids ne change pas la précision (comptage des cas)', async () => {
      const { service, runs } = build({
        cases: [{ weight: 1 }, { weight: 1 }, { weight: 1 }, { weight: 1 }, { ...failing, weight: 100 }],
        sets: [{ minAccuracy: '0.800' }],
      });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      expect(runs[0]).toMatchObject({ passedCases: 4, totalCases: 5, accuracy: '0.800', passed: true });
    });

    it('cas illisible en base : compté comme échoué, run non interrompu', async () => {
      const { service, runs, runner } = build({ cases: [{ expected: {} }, {}], sets: [{ minAccuracy: '0.800' }] });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      expect(runner.run).toHaveBeenCalledTimes(1);
      expect(runs[0]).toMatchObject({ status: 1, totalCases: 2, passedCases: 1, passed: false });
    });

    it('arrêt non interrupteur (sortie invalide) : cas échoué ou réussi selon l’attendu, run terminé', async () => {
      const { service, runs } = build({
        cases: [{ expected: { returnsToHuman: true } }, {}],
        script: (_i, n) => (n === 1 ? stopped('invalid_output') : runnerOutput()),
        sets: [{ minAccuracy: '0.800' }],
      });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      const results = runs[0]!.results as { cases: Array<Record<string, unknown>> };
      expect(results.cases[0]).toMatchObject({ passed: true, disposition: 'return_to_human', stopReason: 'invalid_output' });
      expect(runs[0]).toMatchObject({ status: 1, passedCases: 2, passed: true });
    });

    it('returnsToHuman = disposition « return_to_human » (confiance sous le seuil)', async () => {
      const { service, runs } = build({
        cases: [{ expected: { returnsToHuman: true } }],
        script: () => runnerOutput({ confidence: 0.5 }),
        sets: [{ minAccuracy: '0.800' }],
      });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      expect(runs[0]).toMatchObject({ status: 1, passed: true });
    });
  });

  describe('arrêts qui interrompent le run (statut 2)', () => {
    const reasons: AgentRunStopReason[] = [
      'budget_exceeded_global',
      'budget_exceeded_workflow',
      'budget_unavailable',
      'emergency_stop_global',
      'emergency_stop_workflow',
      'ai_disabled',
      'masking_required',
      'provider_error',
    ];

    it.each(reasons)('%s : statut 2, passed = false, message clair, jamais de réussite partielle', async (reason) => {
      const { service, runs, runner } = build({
        cases: manyCases(5),
        script: (_i, n) => (n === 3 ? stopped(reason) : runnerOutput({}, 0.01)),
        sets: [{ minAccuracy: '0.800' }],
      });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      const row = runs[0]!;
      expect(runner.run).toHaveBeenCalledTimes(3); // les cas suivants ne sont pas lancés
      expect(row).toMatchObject({ status: 2, passed: false, accuracy: null });
      expect(row.errorMessage).toMatch(/run interrompu au cas n° 3/);
      expect(row.finishedAt).toBeInstanceOf(Date);
      expect(row.costAmount).toBe('0.0300');
      expect((row.results as { cases: unknown[] }).cases).toHaveLength(2);
    });

    it('exception inattendue du runner : statut 2, message générique sans le détail de l’erreur', async () => {
      const { service, runs } = build({
        cases: manyCases(2),
        script: () => {
          throw new Error('détail confidentiel du fournisseur');
        },
      });
      await service.runSet(1, {}, actor);
      await service.whenIdle();
      expect(runs[0]).toMatchObject({ status: 2, passed: false });
      expect(runs[0]!.errorMessage).not.toContain('confidentiel');
    });
  });

  it('un run terminé n’est JAMAIS modifié : l’écriture finale est un UPDATE conditionnel sur le statut 0', async () => {
    let releaseRunner: () => void = () => undefined;
    const held = new Promise<void>((r) => (releaseRunner = r));
    const slow = build({ cases: manyCases(1), script: async () => (await held, runnerOutput()) });
    await slow.service.runSet(1, {}, actor);
    // Le run est clôturé « en erreur » par ailleurs (processus périmé) AVANT la fin de l'exécution.
    Object.assign(slow.runs[0]!, { status: 2, passed: false, errorMessage: 'figé', finishedAt: new Date() });
    const snapshot = snap(slow.runs[0]);
    releaseRunner();
    await slow.service.whenIdle();
    expect(snap(slow.runs[0])).toBe(snapshot);
    for (const call of slow.prisma.wfEvalRun.updateMany.mock.calls) {
      expect((call[0] as { where: { status: number } }).where.status).toBe(0);
    }
  });

  it('audit : création et fin du run, objectRef wf_eval_run:<id>, sans contenu', async () => {
    const { service, audit, runs } = build({ cases: manyCases(1) });
    await service.runSet(1, {}, actor);
    await service.whenIdle();
    const refs = audit.dataChange.mock.calls.map((c) => (c[0] as { objectRef: string }).objectRef);
    expect(refs).toEqual([`wf_eval_run:${runs[0]!.wfEvalRunId}`, `wf_eval_run:${runs[0]!.wfEvalRunId}`]);
    expect(JSON.stringify(audit.dataChange.mock.calls)).not.toContain('SECRET-CONTENU');
  });

  it('une panne d’audit ne bloque ni le run ni sa clôture', async () => {
    const { service, audit, runs } = build({ cases: manyCases(1) });
    audit.dataChange.mockRejectedValue(new Error('audit down'));
    await service.runSet(1, {}, actor);
    await service.whenIdle();
    expect(runs[0]).toMatchObject({ status: 1, passed: true });
  });

  it('lecture : détail d’un run par identifiant décimal ; liste sans le détail des cas ; identifiant invalide : 404', async () => {
    const { service, runs } = build({ cases: manyCases(1) });
    const created = await service.runSet(1, {}, actor);
    await service.whenIdle();
    const detail = await service.getRun(created.wfEvalRunId);
    expect(detail.results).not.toBeNull();
    const list = await service.listRuns(1);
    expect(list).toHaveLength(1);
    expect(list[0]!.results).toBeNull();
    expect(runs).toHaveLength(1);
    await expect(service.getRun('abc')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getRun('999999')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EvalService : failStaleRuns', () => {
  it('passe en erreur les runs en cours depuis plus d’une heure, jamais les récents ni les terminés', async () => {
    const { service, runs } = build({ cases: manyCases(1) });
    const base = {
      evalSetId: 1,
      definitionVersionId: 50,
      totalCases: 1,
      passedCases: 0,
      accuracy: null,
      requiredAccuracy: '0.900',
      passed: false,
      model: null,
      results: null,
      costAmount: null,
      errorMessage: null,
      runBy: 10,
    };
    const old = new Date(Date.now() - 2 * 3_600_000);
    runs.push(
      { ...base, wfEvalRunId: 1n, status: 0, startedAt: old, finishedAt: null },
      { ...base, wfEvalRunId: 2n, status: 0, startedAt: new Date(), finishedAt: null },
      { ...base, wfEvalRunId: 3n, status: 1, startedAt: old, finishedAt: old, accuracy: '1.000', passedCases: 1, passed: true },
    );
    expect(await service.failStaleRuns()).toBe(1);
    expect(runs[0]).toMatchObject({ status: 2, passed: false });
    expect(runs[0]!.errorMessage).toContain('plus d’une heure');
    expect(runs[0]!.finishedAt).toBeInstanceOf(Date);
    expect(runs[1]).toMatchObject({ status: 0 });
    expect(runs[2]).toMatchObject({ status: 1, passed: true });
  });

  it('onApplicationBootstrap ne lève jamais et ne bloque pas le démarrage, même si la base échoue', async () => {
    const { service, prisma } = build();
    prisma.wfEvalRun.updateMany.mockRejectedValueOnce(new Error('base indisponible'));
    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await expect(service.whenIdle()).resolves.toBeUndefined();
  });

  it('onApplicationBootstrap lance bien la clôture des runs périmés', async () => {
    const { service, prisma } = build();
    service.onApplicationBootstrap();
    await service.whenIdle();
    expect(prisma.wfEvalRun.updateMany).toHaveBeenCalledTimes(1);
  });
});
