import { PrismaClient } from '@prisma/client';
import { AgentBlockedError, type AgentUsage } from '../agent.contracts';
import { AgentGateService } from './agent-gate.service';

// Test d'intégration du budget des agents sur une VRAIE base PostgreSQL JETABLE (atomicité de l'UPDATE
// conditionnel, verrous, rollback, CHECK). Ne s'exécute que si WF_TEST_DATABASE_URL est définie ; la base
// doit contenir la migration 20261121120000_add_workflow_foundations (table wf_budget + ligne globale).
// JAMAIS la base de développement : le test refuse de tourner si l'URL est celle de DATABASE_URL.
//
// La ligne budgétaire GLOBALE est unique et partagée : chaque test la remet dans un état connu et
// `afterAll` restaure son état initial. Les lignes de workflow sont créées par le test et supprimées à la fin.

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Budget des agents — intégration PostgreSQL'
  : 'Budget des agents — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL vers une base jetable pour l’exécuter)';

const usage = (cost: number): AgentUsage => ({ promptTokens: 1, completionTokens: 1, cost });

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let gate: AgentGateService;
  let seq = 0;
  const createdDefinitions: number[] = [];
  let initialGlobal: Awaited<ReturnType<PrismaClient['wfBudget']['findFirst']>> = null;

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error('WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.');
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    // Ligne globale : créée si la migration ne l'a pas posée (ON CONFLICT DO NOTHING).
    await prisma.wfBudget.createMany({ data: [{ definitionId: null }], skipDuplicates: true });
    initialGlobal = await prisma.wfBudget.findFirst({ where: { definitionId: null } });
    const ai = { getEffectiveConfig: () => Promise.resolve({ mode: 1 }) };
    gate = new AgentGateService(prisma as never, ai as never);
  });

  afterAll(async () => {
    if (!prisma) return;
    if (initialGlobal) {
      await prisma.wfBudget.updateMany({
        where: { definitionId: null },
        data: {
          periodKind: initialGlobal.periodKind,
          periodStart: initialGlobal.periodStart,
          capAmount: initialGlobal.capAmount,
          consumedAmount: initialGlobal.consumedAmount,
          consumedTokens: initialGlobal.consumedTokens,
          emergencyStop: initialGlobal.emergencyStop,
          emergencyStopAt: initialGlobal.emergencyStopAt,
          emergencyStopBy: initialGlobal.emergencyStopBy,
          emergencyStopReason: initialGlobal.emergencyStopReason,
        },
      });
    }
    if (createdDefinitions.length > 0) {
      await prisma.wfBudget.deleteMany({ where: { definitionId: { in: createdDefinitions } } });
    }
    await prisma.$disconnect();
  });

  /** Ligne globale dans un état connu : cumulé (jamais remis à zéro), consommé nul, pas d'arrêt d'urgence. */
  async function resetGlobal(over: { cap?: number | null; stop?: boolean } = {}): Promise<void> {
    const stop = over.stop ?? false;
    await prisma.wfBudget.updateMany({
      where: { definitionId: null },
      data: {
        periodKind: 2,
        capAmount: over.cap === undefined || over.cap === null ? null : over.cap.toFixed(4),
        consumedAmount: 0,
        consumedTokens: 0,
        emergencyStop: stop,
        emergencyStopAt: stop ? new Date() : null,
      },
    });
  }

  /** Nouveau workflow (+ ligne budgétaire facultative). */
  async function newWorkflow(
    budget: { cap?: number | null; consumed?: number; stop?: boolean; periodKind?: number } | null,
  ): Promise<number> {
    seq += 1;
    const def = await prisma.wfDefinition.create({ data: { name: `wf-budget-test-${Date.now()}-${seq}`, status: 1 } });
    createdDefinitions.push(def.wfDefinitionId);
    if (budget) {
      const stop = budget.stop ?? false;
      await prisma.wfBudget.create({
        data: {
          definitionId: def.wfDefinitionId,
          periodKind: budget.periodKind ?? 2,
          capAmount: budget.cap === undefined || budget.cap === null ? null : budget.cap.toFixed(4),
          consumedAmount: (budget.consumed ?? 0).toFixed(4),
          emergencyStop: stop,
          emergencyStopAt: stop ? new Date() : null,
        },
      });
    }
    return def.wfDefinitionId;
  }

  const rowOf = (definitionId: number | null) => prisma.wfBudget.findFirst({ where: { definitionId } });
  const consumed = async (definitionId: number | null): Promise<number> => Number((await rowOf(definitionId))?.consumedAmount);

  async function fire(definitionId: number, n: number, cost: number) {
    const results = await Promise.allSettled(Array.from({ length: n }, () => gate.reserve({ definitionId }, usage(cost))));
    const accepted = results.filter((r) => r.status === 'fulfilled').length;
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof AgentBlockedError ? r.reason.reason : `inattendu: ${String(r.reason)}`));
    return { accepted, reasons };
  }

  it('40 réservations concurrentes de coût 1 sur un plafond workflow de 25 : exactement 25 acceptées, jamais plus', async () => {
    await resetGlobal({ cap: null });
    const def = await newWorkflow({ cap: 25 });
    const { accepted, reasons } = await fire(def, 40, 1);
    expect(accepted).toBe(25);
    expect(reasons).toHaveLength(15);
    expect(new Set(reasons)).toEqual(new Set(['budget_exceeded_workflow']));
    expect(await consumed(def)).toBe(25);
    // Les 15 refus ont annulé leur réservation globale : le global ne porte que les 25 acceptées.
    expect(await consumed(null)).toBe(25);
    expect(Number((await rowOf(def))?.consumedTokens)).toBe(50);
  });

  it('40 réservations concurrentes de coût 1 sur un plafond GLOBAL de 25 : exactement 25 acceptées', async () => {
    await resetGlobal({ cap: 25 });
    const def = await newWorkflow({ cap: null });
    const other = await newWorkflow(null); // sans ligne : seul le global s'applique
    const [a, b] = await Promise.all([fire(def, 20, 1), fire(other, 20, 1)]);
    expect(a.accepted + b.accepted).toBe(25);
    expect(new Set([...a.reasons, ...b.reasons])).toEqual(new Set(['budget_exceeded_global']));
    expect(await consumed(null)).toBe(25);
    expect(await consumed(def)).toBe(a.accepted); // le workflow ne porte que ses propres acceptées
    expect(await rowOf(other)).toBeNull();
  });

  it('arrêt d’urgence global : 0 acceptée, rien n’est consommé', async () => {
    await resetGlobal({ cap: null, stop: true });
    const def = await newWorkflow({ cap: null });
    const { accepted, reasons } = await fire(def, 10, 1);
    expect(accepted).toBe(0);
    expect(new Set(reasons)).toEqual(new Set(['emergency_stop_global']));
    expect(await consumed(null)).toBe(0);
    expect(await consumed(def)).toBe(0);
    await expect(gate.assertRunnable({ definitionId: def })).rejects.toMatchObject({ reason: 'emergency_stop_global' });
  });

  it('arrêt d’urgence du workflow : 0 acceptée, le global est intact (rollback), un autre workflow passe', async () => {
    await resetGlobal({ cap: null });
    const stopped = await newWorkflow({ stop: true });
    const free = await newWorkflow({ cap: null });
    const { accepted, reasons } = await fire(stopped, 10, 1);
    expect(accepted).toBe(0);
    expect(new Set(reasons)).toEqual(new Set(['emergency_stop_workflow']));
    expect(await consumed(null)).toBe(0);
    await expect(gate.assertRunnable({ definitionId: stopped })).rejects.toMatchObject({ reason: 'emergency_stop_workflow' });
    await expect(gate.assertRunnable({ definitionId: free })).resolves.toBeUndefined();
    expect((await fire(free, 3, 1)).accepted).toBe(3);
  });

  it('rollback global : quand le workflow refuse, la réservation globale déjà faite est annulée', async () => {
    await resetGlobal({ cap: 100 });
    const def = await newWorkflow({ cap: 3, consumed: 3 });
    await expect(gate.reserve({ definitionId: def }, usage(1))).rejects.toMatchObject({ reason: 'budget_exceeded_workflow' });
    expect(await consumed(null)).toBe(0);
    expect(Number((await rowOf(null))?.consumedTokens)).toBe(0);
    expect(await consumed(def)).toBe(3);
  });

  it('refuse avant dépassement : consommé + estimation > plafond n’est jamais débité', async () => {
    await resetGlobal({ cap: null });
    const def = await newWorkflow({ cap: 10, consumed: 8 });
    await expect(gate.reserve({ definitionId: def }, usage(3))).rejects.toMatchObject({ reason: 'budget_exceeded_workflow' });
    expect(await consumed(def)).toBe(8);
    await expect(gate.reserve({ definitionId: def }, usage(2))).resolves.toBeDefined();
    expect(await consumed(def)).toBe(10);
  });

  it('settle remplace l’estimation par le réel ; release la retire ; la consommation reste >= 0', async () => {
    await resetGlobal({ cap: null });
    const def = await newWorkflow({ cap: 100 });
    const r1 = await gate.reserve({ definitionId: def }, usage(10));
    await gate.settle(r1, { promptTokens: 1, completionTokens: 1, cost: 4 });
    expect(await consumed(def)).toBe(4);
    expect(await consumed(null)).toBe(4);
    const r2 = await gate.reserve({ definitionId: def }, usage(6));
    await gate.settle(r2, { promptTokens: 1, completionTokens: 1, cost: 600 }); // ne refuse jamais
    expect(await consumed(def)).toBe(604);
    const r3 = await gate.reserve({ definitionId: def }, usage(1)).catch(() => null);
    expect(r3).toBeNull(); // plafond dépassé : refus
    const def2 = await newWorkflow({ cap: null });
    const r4 = await gate.reserve({ definitionId: def2 }, usage(5));
    await gate.release(r4);
    expect(await consumed(def2)).toBe(0);
    expect(await consumed(null)).toBe(604);
  });

  it('remise à zéro de la période échue : journalier et mensuel oui, cumulé jamais', async () => {
    await resetGlobal({ cap: null });
    const daily = await newWorkflow({ cap: 20, consumed: 10, periodKind: 1 });
    const monthly = await newWorkflow({ cap: 20, consumed: 10, periodKind: 0 });
    const cumulative = await newWorkflow({ cap: 20, consumed: 10, periodKind: 2 });
    const sameDay = await newWorkflow({ cap: 20, consumed: 10, periodKind: 1 });
    await prisma.$executeRaw`UPDATE "wf_budget" SET "period_start" = ((now() AT TIME ZONE 'UTC')::date - 1)
      WHERE "definition_id" IN (${daily}, ${cumulative})`;
    await prisma.$executeRaw`UPDATE "wf_budget" SET "period_start" = (date_trunc('month', (now() AT TIME ZONE 'UTC')::date) - interval '1 day')::date
      WHERE "definition_id" = ${monthly}`;
    for (const id of [daily, monthly, cumulative, sameDay]) await gate.reserve({ definitionId: id }, usage(5));
    expect(await consumed(daily)).toBe(5);
    expect(await consumed(monthly)).toBe(5);
    expect(await consumed(cumulative)).toBe(15);
    expect(await consumed(sameDay)).toBe(15); // période en cours : pas de remise à zéro
    const today = await prisma.$queryRaw<{ d: string }[]>`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d`;
    expect((await rowOf(daily))?.periodStart.toISOString().slice(0, 10)).toBe(today[0]?.d);
  });
});
