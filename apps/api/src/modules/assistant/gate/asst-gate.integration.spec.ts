import { PrismaClient } from '@prisma/client';
import { AgentGateService } from '../../workflow-agents/budget/agent-gate.service';
import { AsstError } from '../assistant.contracts';
import { AsstGateService } from './asst-gate.service';

// Intégration de la porte de coût de l'assistant sur une VRAIE base PostgreSQL JETABLE : vrai AgentGateService,
// vrai client Prisma. Ne s'exécute que si WF_TEST_DATABASE_URL est définie (JAMAIS la base de développement).
// À lancer avec `--runInBand` : la ligne budgétaire globale `wf_budget` est PARTAGÉE (sauvegardée avant, restaurée
// après, jamais laissée en arrêt d'urgence). Utilisateurs de test : 9 100 001 et suivants (lignes supprimées à la fin).

const url = process.env.WF_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const title = url
  ? 'Porte de coût de l’assistant — intégration PostgreSQL'
  : 'Porte de coût de l’assistant — intégration PostgreSQL (IGNORÉ : définir WF_TEST_DATABASE_URL)';

const USER_BASE = 9_100_001;
const USER_MAX = 9_100_999;
const usage = (cost: number, tokens = 100) => ({ promptTokens: tokens, completionTokens: 0, cost });

suite(title, () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let gate: AsstGateService;
  let initialGlobal: Awaited<ReturnType<PrismaClient['wfBudget']['findFirst']>> = null;
  let seq = 0;
  const nextUser = (): number => USER_BASE + seq++;

  const resetGlobal = async (over: { cap?: number | null; stop?: boolean } = {}): Promise<void> => {
    await prisma.wfBudget.updateMany({
      where: { definitionId: null },
      data: {
        capAmount: over.cap ?? null,
        consumedAmount: 0,
        consumedTokens: 0,
        emergencyStop: over.stop ?? false,
        emergencyStopAt: over.stop ? new Date() : null,
      },
    });
  };
  const globalRow = async () => {
    const g = await prisma.wfBudget.findFirst({ where: { definitionId: null } });
    return { amount: Number(g?.consumedAmount), tokens: Number(g?.consumedTokens) };
  };
  const userRow = async (userId: number, day?: string) => {
    const rows = await prisma.asstUserBudget.findMany({
      where: { userId, ...(day ? { day: new Date(`${day}T00:00:00Z`) } : {}) },
    });
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      amount: Number(r.consumedAmount),
      tokens: Number(r.consumedTokens),
      calls: r.callCount,
      capAmount: r.capAmount === null ? null : Number(r.capAmount),
      capTokens: r.capTokens === null ? null : Number(r.capTokens),
    }));
  };
  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      if (e instanceof AsstError) return e.errorCode;
      throw e;
    }
  };

  beforeAll(async () => {
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
      throw new Error(
        'WF_TEST_DATABASE_URL pointe vers DATABASE_URL : refus de toucher la base de développement.',
      );
    }
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.wfBudget.createMany({ data: [{ definitionId: null }], skipDuplicates: true });
    initialGlobal = await prisma.wfBudget.findFirst({ where: { definitionId: null } });
    const ai = { getEffectiveConfig: () => Promise.resolve({ mode: 1 }) };
    gate = new AsstGateService(prisma as never, new AgentGateService(prisma as never, ai as never));
  });

  beforeEach(async () => {
    delete process.env.ASST_USER_DAILY_CAP_AMOUNT;
    delete process.env.ASST_USER_DAILY_CAP_TOKENS;
    gate.now = () => new Date();
    await resetGlobal();
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.asstUserBudget.deleteMany({
      where: { userId: { gte: USER_BASE, lte: USER_MAX } },
    });
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
    await prisma.$disconnect();
  });

  it('(a)(b) assertRunnable passe ; reserve débite la ligne globale et l’utilisateur, sans ligne pour la définition 0', async () => {
    const u = nextUser();
    await expect(gate.assertRunnable(u)).resolves.toBeUndefined();
    await gate.reserve(u, usage(10, 100));
    expect(await globalRow()).toEqual({ amount: 10, tokens: 100 });
    expect(await userRow(u)).toEqual([
      expect.objectContaining({ amount: 10, tokens: 100, calls: 1 }),
    ]);
    expect(await prisma.wfBudget.count({ where: { definitionId: 0 } })).toBe(0);
  });

  it('(c) arrêt d’urgence global : assistant_unavailable, rien de réservé', async () => {
    const u = nextUser();
    await resetGlobal({ stop: true });
    expect(await codeOf(gate.assertRunnable(u))).toBe('assistant_unavailable');
    expect(await codeOf(gate.reserve(u, usage(10)))).toBe('assistant_unavailable');
    expect(await globalRow()).toEqual({ amount: 0, tokens: 0 });
    expect(await userRow(u)).toEqual([expect.objectContaining({ amount: 0, tokens: 0, calls: 0 })]);
  });

  it('(d) plafond global : budget_exceeded et réservation utilisateur compensée', async () => {
    const [u1, u2] = [nextUser(), nextUser()];
    await resetGlobal({ cap: 15 });
    await gate.reserve(u1, usage(10));
    expect(await codeOf(gate.reserve(u2, usage(10)))).toBe('budget_exceeded');
    expect(await globalRow()).toEqual({ amount: 10, tokens: 100 });
    expect(await userRow(u2)).toEqual([
      expect.objectContaining({ amount: 0, tokens: 0, calls: 0 }),
    ]);
  });

  it('(e) settle et release ajustent la ligne globale et l’utilisateur ; idempotents', async () => {
    const u = nextUser();
    const r1 = await gate.reserve(u, usage(10, 100));
    const r2 = await gate.reserve(u, usage(6, 60));
    await gate.settle(r1, usage(4, 40));
    await gate.settle(r1, usage(4, 40));
    await gate.release(r2);
    await gate.release(r2);
    expect(await globalRow()).toEqual({ amount: 4, tokens: 40 });
    expect(await userRow(u)).toEqual([
      expect.objectContaining({ amount: 4, tokens: 40, calls: 1 }),
    ]);
  });

  it('userCap : ligne absente = consommation 0 et plafonds de configuration', async () => {
    const u = nextUser();
    process.env.ASST_USER_DAILY_CAP_AMOUNT = '77';
    expect(await gate.userCap(u)).toEqual({
      capAmount: 77,
      capTokens: 500000,
      consumedAmount: 0,
      consumedTokens: 0,
    });
  });

  it('réservations CONCURRENTES : exactement N réussissent, consommation = N x estimation', async () => {
    const u = nextUser();
    process.env.ASST_USER_DAILY_CAP_AMOUNT = '70'; // 7 appels de 10
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        gate.reserve(u, usage(10, 10)).then(
          () => 'ok',
          (e: unknown) => (e as AsstError).errorCode,
        ),
      ),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(7);
    expect(results.filter((r) => r === 'budget_exceeded')).toHaveLength(13);
    expect(await userRow(u)).toEqual([
      expect.objectContaining({ amount: 70, tokens: 70, calls: 7 }),
    ]);
    expect(await globalRow()).toEqual({ amount: 70, tokens: 70 });
  });

  it('plafond de jetons', async () => {
    const u = nextUser();
    process.env.ASST_USER_DAILY_CAP_AMOUNT = 'none';
    process.env.ASST_USER_DAILY_CAP_TOKENS = '250';
    await gate.reserve(u, usage(1, 100));
    await gate.reserve(u, usage(1, 100));
    expect(await codeOf(gate.reserve(u, usage(1, 100)))).toBe('budget_exceeded');
    expect(await userRow(u)).toEqual([
      expect.objectContaining({ tokens: 200, calls: 2, capAmount: null, capTokens: 250 }),
    ]);
    expect(await globalRow()).toEqual({ amount: 2, tokens: 200 });
  });

  it('remise à zéro par jour : une ligne par jour UTC, séparées', async () => {
    const u = nextUser();
    process.env.ASST_USER_DAILY_CAP_AMOUNT = '10';
    gate.now = () => new Date('2031-03-01T23:59:59Z');
    await gate.reserve(u, usage(10));
    expect(await codeOf(gate.reserve(u, usage(1)))).toBe('budget_exceeded');
    expect(await codeOf(gate.assertRunnable(u))).toBe('budget_exceeded');
    gate.now = () => new Date('2031-03-02T00:00:01Z');
    expect(await codeOf(gate.assertRunnable(u))).toBe('ok');
    await gate.reserve(u, usage(4));
    const rows = await userRow(u);
    expect(rows.map((r) => [r.day, r.amount])).toEqual(
      expect.arrayContaining([
        ['2031-03-01', 10],
        ['2031-03-02', 4],
      ]),
    );
    expect(await gate.userCap(u, new Date('2031-03-01T12:00:00Z'))).toMatchObject({
      consumedAmount: 10,
    });
  });
});
