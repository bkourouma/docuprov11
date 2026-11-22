import { PrismaClient } from '@prisma/client';
import type { WfGraph } from '@archivage/types';
import { WorkflowEngine } from '../workflows/engine/engine';
import type { WfDirectory, WfPrincipal } from '../workflows/engine/engine.types';
import { WfExecutorRegistry } from '../workflows/engine/executor-registry';
import {
  AgentIdentityError,
  type AgentRunInput,
  type AgentRunOutput,
  type WfAgentRunner,
} from './agent.contracts';
import { AgentConfigLoader } from './agent-config.loader';
import { AgentEventSink } from './agent-event-sink.service';
import { AgentGateService } from './budget/agent-gate.service';
import { AgentTaskExecutor } from './executor/agent-executor';

// Test d'intégration de BOUT EN BOUT sur une base PostgreSQL JETABLE : vrai moteur, vrai exécuteur d'agent,
// vrai garde (budget, arrêt d'urgence), vraie boîte et vrai journal ; seuls le runner (donc le modèle),
// l'identité et l'éligibilité sont simulés. Ne s'exécute que si WF_TEST_DATABASE_URL est définie (JAMAIS la
// base de développement). À lancer avec `--runInBand` : la ligne budgétaire globale est partagée avec
// budget.integration.spec.ts.

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Agent de workflow — intégration de bout en bout PostgreSQL'
  : 'Agent de workflow — intégration de bout en bout PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL)';

const HUMAN: WfPrincipal = { userGroupId: 20, userId: 20, groupIds: [], roleId: null };

const output = (over: Partial<AgentRunOutput> = {}): AgentRunOutput => ({
  outcome: 'final',
  result: { service: 'RH' },
  explanation: 'Courrier relatif aux congés.',
  confidence: 0.93,
  sources: [{ kind: 'mail', id: 5, label: 'Courrier 5' }],
  preparedActions: [],
  suspicionInjection: false,
  suspicionReasons: [],
  audit: {
    instruction: 'Trier le courrier',
    model: 'modele-test',
    aiDecisionIds: [],
    promptTokens: 120,
    completionTokens: 30,
    costAmount: 2,
    steps: 1,
    toolCalls: [],
  },
  ...over,
});

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let engine: WorkflowEngine;
  let next: () => AgentRunOutput = () => output();
  let identityFails: AgentIdentityError | null = null;
  let eligible = false;
  let initialGlobal: Awaited<ReturnType<PrismaClient['wfBudget']['findFirst']>> = null;
  let seq = 0;
  const runInputs: AgentRunInput[] = [];

  const directory: WfDirectory = { isUserGroupActive: () => Promise.resolve(true) };

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.wfBudget.createMany({ data: [{ definitionId: null }], skipDuplicates: true });
    initialGlobal = await prisma.wfBudget.findFirst({ where: { definitionId: null } });

    const runner: WfAgentRunner = {
      run: (input) => {
        runInputs.push(input);
        return Promise.resolve(next());
      },
    };
    const gate = new AgentGateService(prisma as never, { getEffectiveConfig: () => Promise.resolve({ mode: 1 }) } as never);
    const executor = new AgentTaskExecutor(
      {
        resolve: () =>
          identityFails
            ? Promise.reject(identityFails)
            : Promise.resolve({ principal: HUMAN, user: { userId: 10, username: 'u', isAdmin: false, userGroupId: 10 } }),
      },
      runner,
      gate,
      new AgentEventSink(prisma as never),
      new AgentConfigLoader(prisma as never),
      { check: () => Promise.resolve({ eligible }) } as never,
    );
    const registry = new WfExecutorRegistry();
    registry.register(executor);
    engine = new WorkflowEngine(prisma, { registry, directory });
  });

  afterAll(async () => {
    await engine?.whenIdle();
    if (prisma && initialGlobal) {
      await prisma.wfBudget.updateMany({
        where: { definitionId: null },
        data: {
          capAmount: initialGlobal.capAmount,
          consumedAmount: initialGlobal.consumedAmount,
          consumedTokens: initialGlobal.consumedTokens,
          emergencyStop: initialGlobal.emergencyStop,
          emergencyStopAt: initialGlobal.emergencyStopAt,
        },
      });
    }
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    next = () => output();
    identityFails = null;
    eligible = false;
    runInputs.length = 0;
    await prisma.wfBudget.updateMany({
      where: { definitionId: null },
      data: { capAmount: null, consumedAmount: 0, consumedTokens: 0, emergencyStop: false, emergencyStopAt: null },
    });
  });

  async function publish(autonomy: 'suggere' | 'agit_avec_validation' | 'autonome'): Promise<number> {
    seq += 1;
    const graph: WfGraph = {
      schemaVersion: 1,
      start: 'trier',
      steps: [
        {
          key: 'trier',
          name: 'Trier le courrier',
          type: 'agent',
          assignee: { kind: 'user', id: 20 },
          agent: { objective: 'Trier le courrier', tools: [], confidenceThreshold: 0.8, autonomy },
          next: [{ to: 'fin' }],
        },
        { key: 'fin', name: 'Fin', type: 'checklist', assignee: { kind: 'user', id: 20 }, config: { items: [{ key: 'ok' }] }, next: [] },
      ],
    } as unknown as WfGraph;
    const def = await prisma.wfDefinition.create({ data: { name: `wf-agent-${Date.now()}-${seq}`, status: 1 } });
    await prisma.wfDefinitionVersion.create({
      data: { definitionId: def.wfDefinitionId, versionNumber: 1, status: 1, graph: graph as object, publishedAt: new Date(), publishedBy: 1 },
    });
    return def.wfDefinitionId;
  }

  async function start(definitionId: number) {
    const res = await engine.startInstance({ definitionId, startedBy: 10, context: { courrier: 5 }, subjectType: 'mail', subjectId: '5' });
    await engine.whenIdle();
    return res.instance.wfInstanceId;
  }

  const events = (id: string) => prisma.wfEventLog.findMany({ where: { instanceId: BigInt(id) }, orderBy: { wfEventLogId: 'asc' } });
  const items = (id: string) => prisma.wfInboxItem.findMany({ where: { instanceId: BigInt(id) }, orderBy: { wfInboxItemId: 'asc' } });
  const instance = (id: string) => prisma.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: BigInt(id) } });

  it('agit avec validation : proposition kind 1 journalisée (sources, confiance, modèle), validée en un clic, instance qui avance', async () => {
    const id = await start(await publish('agit_avec_validation'));
    const [item] = await items(id);
    expect(item).toMatchObject({ kind: 1, status: 0 });
    expect((item!.proposal as { mode: string }).mode).toBe('action');
    const proposed = (await events(id)).find((e) => e.eventType === 'agent.proposed')!;
    expect(proposed).toMatchObject({ actorKind: 2, autonomyLevel: 1, model: 'modele-test', promptTokens: 120, completionTokens: 30 });
    expect(Number(proposed.confidence)).toBeCloseTo(0.93);
    expect(proposed.sources).toEqual([{ kind: 'mail', id: 5, label: 'Courrier 5' }]);
    expect(runInputs[0]).toMatchObject({ mode: 'live', requestedBy: 10, scope: { subject: { type: 'mail', id: '5' } } });

    const res = await engine.completeTask({ taskId: item!.taskId.toString(), principal: HUMAN, result: item!.proposal });
    await engine.whenIdle();
    expect(res.openedTasks).toHaveLength(1);
    const accepted = (await events(id)).find((e) => e.eventType === 'validation.accepted')!;
    expect(accepted.validatedBy).toBe(20);
    expect(accepted.validatedAt).not.toBeNull();
  });

  it('autonome éligible : agit seul, agent.acted journalisé AVANT la clôture ; non éligible : proposition', async () => {
    eligible = true;
    const id = await start(await publish('autonome'));
    const ev = (await events(id)).map((e) => e.eventType);
    expect(ev.indexOf('agent.acted')).toBeGreaterThanOrEqual(0);
    expect(ev.indexOf('agent.acted')).toBeLessThan(ev.indexOf('task.completed'));
    expect(await items(id).then((i) => i.filter((x) => x.kind === 1))).toHaveLength(0);

    eligible = false;
    const id2 = await start(await publish('autonome'));
    expect((await items(id2))[0]).toMatchObject({ kind: 1 });
    expect((await events(id2)).some((e) => e.eventType === 'agent.acted')).toBe(false);
  });

  it('sous le seuil de confiance : jamais d’action seule, la tâche retourne à l’humain (agent.escalated)', async () => {
    next = () => output({ confidence: 0.4 });
    eligible = true;
    const id = await start(await publish('autonome'));
    const [item] = await items(id);
    expect(item).toMatchObject({ kind: 0, status: 0 });
    const escalated = (await events(id)).find((e) => e.eventType === 'agent.escalated')!;
    expect(escalated.decision).toMatchObject({ reason: 'low_confidence' });
    expect((await instance(id)).status).toBe(1);
  });

  it('suspicion d’injection : proposition signalée, jamais appliquée seule, même autonome et éligible', async () => {
    next = () => output({ suspicionInjection: true, suspicionReasons: ['entree:ignorer_consignes'] });
    eligible = true;
    const id = await start(await publish('autonome'));
    const [item] = await items(id);
    expect(item).toMatchObject({ kind: 1 });
    expect((item!.proposal as { suspicion_injection: boolean }).suspicion_injection).toBe(true);
    expect((await events(id)).some((e) => e.eventType === 'agent.acted')).toBe(false);
  });

  it('arrêt d’urgence global : aucun appel modèle, la tâche retourne à l’humain, l’instance n’est pas bloquée', async () => {
    await prisma.wfBudget.updateMany({ where: { definitionId: null }, data: { emergencyStop: true, emergencyStopAt: new Date() } });
    const id = await start(await publish('agit_avec_validation'));
    expect(runInputs).toHaveLength(0);
    expect((await items(id))[0]).toMatchObject({ kind: 0 });
    expect((await events(id)).find((e) => e.eventType === 'agent.escalated')!.decision).toMatchObject({ reason: 'emergency_stop_global' });
    expect((await instance(id)).status).toBe(1);
  });

  it('plafond atteint : refus avant l’appel (échec fermé), tâche à l’humain', async () => {
    await prisma.wfBudget.updateMany({ where: { definitionId: null }, data: { capAmount: 10, consumedAmount: 10 } });
    const gate = new AgentGateService(prisma as never, { getEffectiveConfig: () => Promise.resolve({ mode: 1 }) } as never);
    const def = await publish('agit_avec_validation');
    await expect(gate.reserve({ definitionId: def }, { promptTokens: 1, completionTokens: 1, cost: 1 })).rejects.toMatchObject({
      reason: 'budget_exceeded_global',
    });
    const consumed = await prisma.wfBudget.findFirstOrThrow({ where: { definitionId: null } });
    expect(Number(consumed.consumedAmount)).toBe(10);
  });

  it('lanceur désactivé : l’agent s’arrête, la tâche retourne à l’humain', async () => {
    identityFails = new AgentIdentityError('disabled', 'compte désactivé');
    const id = await start(await publish('agit_avec_validation'));
    expect(runInputs).toHaveLength(0);
    expect((await items(id))[0]).toMatchObject({ kind: 0 });
    expect((await events(id)).find((e) => e.eventType === 'agent.escalated')!.decision).toMatchObject({ reason: 'identity_disabled' });
  });

  it('IA désactivée (mode 0) : aucun agent ne tourne, le workflow fonctionne en mode humain', async () => {
    const executor = new AgentTaskExecutor(
      { resolve: () => Promise.reject(new Error('ne doit pas être appelé')) },
      { run: () => Promise.reject(new Error('ne doit pas être appelé')) },
      new AgentGateService(prisma as never, { getEffectiveConfig: () => Promise.resolve({ mode: 0 }) } as never),
      new AgentEventSink(prisma as never),
      new AgentConfigLoader(prisma as never),
      { check: () => Promise.resolve({ eligible: true }) } as never,
    );
    const registry = new WfExecutorRegistry();
    registry.register(executor);
    const offline = new WorkflowEngine(prisma, { registry, directory });
    const res = await offline.startInstance({ definitionId: await publish('autonome'), startedBy: 10 });
    await offline.whenIdle();
    const [item] = await items(res.instance.wfInstanceId);
    expect(item).toMatchObject({ kind: 0 });
    expect((await events(res.instance.wfInstanceId)).find((e) => e.eventType === 'agent.escalated')!.decision).toMatchObject({
      reason: 'ai_disabled',
    });
  });
});
