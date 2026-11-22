import {
  AgentBlockedError,
  type AgentBlockReason,
  type AgentReservation,
  type AgentUsage,
} from '../../workflow-agents/agent.contracts';
import { AsstError } from '../assistant.contracts';
import { AsstGateService } from './asst-gate.service';

// Test unitaire : faux PrismaService (table asst_user_budget en mémoire) et faux WfAgentGate.

interface Row {
  userId: number;
  day: string;
  amount: number;
  tokens: number;
  calls: number;
  capAmount: number | null;
  capTokens: number | null;
}

class FakePrisma {
  rows: Row[] = [];
  failSql = false;
  private find(userId: number, day: string): Row | undefined {
    return this.rows.find((r) => r.userId === userId && r.day === day);
  }
  $executeRaw(strings: TemplateStringsArray, ...v: unknown[]): Promise<number> {
    if (this.failSql) return Promise.reject(new Error('connexion perdue : secret'));
    const sql = strings.join('?');
    if (sql.includes('INSERT INTO "asst_user_budget"')) {
      const [userId, day, capAmount, capTokens] = v as [
        number,
        string,
        string | null,
        number | null,
      ];
      if (this.find(userId, day)) return Promise.resolve(0);
      this.rows.push({
        userId,
        day,
        amount: 0,
        tokens: 0,
        calls: 0,
        capAmount: capAmount === null ? null : Number(capAmount),
        capTokens,
      });
      return Promise.resolve(1);
    }
    if (sql.includes('GREATEST')) {
      const [cost, tokens, calls, userId, day] = v as [string, number, number, number, string];
      const r = this.find(userId, day);
      if (!r) return Promise.resolve(0);
      r.amount = Math.max(0, r.amount + Number(cost));
      r.tokens = Math.max(0, r.tokens + tokens);
      r.calls = Math.max(0, r.calls + calls);
      return Promise.resolve(1);
    }
    return Promise.reject(new Error('SQL inattendu'));
  }
  $queryRaw(strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]> {
    if (this.failSql) return Promise.reject(new Error('connexion perdue : secret'));
    const sql = strings.join('?');
    if (sql.includes('RETURNING')) {
      const [cost, tokens, userId, day] = v as [string, number, number, string];
      const r = this.find(userId, day);
      if (!r) return Promise.resolve([]);
      const c = Number(cost);
      if (r.capAmount !== null && r.amount + c > r.capAmount) return Promise.resolve([]);
      if (r.capTokens !== null && r.tokens + tokens > r.capTokens) return Promise.resolve([]);
      r.amount += c;
      r.tokens += tokens;
      r.calls += 1;
      return Promise.resolve([{ asst_user_budget_id: 1 }]);
    }
    if (sql.includes('SELECT')) {
      const [userId, day] = v as [number, string];
      const r = this.find(userId, day);
      return Promise.resolve(
        r
          ? [
              {
                cap_amount: r.capAmount,
                cap_tokens: r.capTokens,
                consumed_amount: r.amount,
                consumed_tokens: r.tokens,
              },
            ]
          : [],
      );
    }
    return Promise.reject(new Error('SQL inattendu'));
  }
}

class FakeWfGate {
  assertError: unknown = null;
  reserveError: unknown = null;
  reserveCalls: { definitionId: number }[] = [];
  settled: { r: AgentReservation; actual: AgentUsage }[] = [];
  released: AgentReservation[] = [];
  settleThrows = false;
  assertRunnable(scope: { definitionId: number }): Promise<void> {
    this.reserveCalls.push(scope);
    return this.assertError ? Promise.reject(this.assertError as Error) : Promise.resolve();
  }
  reserve(scope: { definitionId: number }, estimate: AgentUsage): Promise<AgentReservation> {
    this.reserveCalls.push(scope);
    if (this.reserveError) return Promise.reject(this.reserveError as Error);
    return Promise.resolve({ id: 'glob-1', definitionId: scope.definitionId, reserved: estimate });
  }
  settle(r: AgentReservation, actual: AgentUsage): Promise<void> {
    this.settled.push({ r, actual });
    return this.settleThrows ? Promise.reject(new Error('x')) : Promise.resolve();
  }
  release(r: AgentReservation): Promise<void> {
    this.released.push(r);
    return Promise.resolve();
  }
  costOf(): number {
    return 0;
  }
}

const usage = (cost: number, tokens = 100): AgentUsage => ({
  promptTokens: tokens,
  completionTokens: 0,
  cost,
});
const NOW = new Date('2026-11-22T10:00:00Z');

describe('AsstGateService (unitaire)', () => {
  let prisma: FakePrisma;
  let wf: FakeWfGate;
  let gate: AsstGateService;
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.ASST_USER_DAILY_CAP_AMOUNT;
    delete process.env.ASST_USER_DAILY_CAP_TOKENS;
    prisma = new FakePrisma();
    wf = new FakeWfGate();
    gate = new AsstGateService(prisma as never, wf as never);
    gate.now = () => NOW;
  });
  afterAll(() => {
    process.env = saved;
  });

  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      if (e instanceof AsstError) return e.errorCode;
      throw e;
    }
    return 'ok';
  };

  describe('mapping des raisons de blocage de la porte globale', () => {
    it.each<[AgentBlockReason, string]>([
      ['ai_disabled', 'assistant_unavailable'],
      ['emergency_stop_global', 'assistant_unavailable'],
      ['emergency_stop_workflow', 'assistant_unavailable'],
      ['budget_exceeded_global', 'budget_exceeded'],
      ['budget_exceeded_workflow', 'budget_exceeded'],
      ['budget_unavailable', 'assistant_unavailable'],
    ])('assertRunnable et reserve : %s -> %s', async (reason, expected) => {
      wf.assertError = new AgentBlockedError(reason, 'x');
      expect(await code(gate.assertRunnable(1))).toBe(expected);
      wf.assertError = null;
      wf.reserveError = new AgentBlockedError(reason, 'x');
      expect(await code(gate.reserve(1, usage(10)))).toBe(expected);
      // aucune consommation résiduelle
      expect(prisma.rows[0]).toMatchObject({ amount: 0, tokens: 0, calls: 0 });
    });

    it('assertRunnable interroge la définition 0', async () => {
      await gate.assertRunnable(1);
      expect(wf.reserveCalls).toEqual([{ definitionId: 0 }]);
    });
  });

  describe('échec fermé', () => {
    it('erreur SQL à la réservation : assistant_unavailable, sans détail technique', async () => {
      prisma.failSql = true;
      let err: unknown;
      try {
        await gate.reserve(1, usage(10));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AsstError);
      expect((err as AsstError).errorCode).toBe('assistant_unavailable');
      expect((err as AsstError).message).not.toMatch(/secret|connexion/);
    });

    it('erreur SQL à assertRunnable et userCap', async () => {
      prisma.failSql = true;
      expect(await code(gate.assertRunnable(1))).toBe('assistant_unavailable');
      expect(await code(gate.userCap(1))).toBe('assistant_unavailable');
    });

    it('erreur inattendue de la porte globale : échec fermé et compensation', async () => {
      wf.reserveError = new Error('réseau');
      expect(await code(gate.reserve(1, usage(10)))).toBe('assistant_unavailable');
      expect(prisma.rows[0]).toMatchObject({ amount: 0, tokens: 0, calls: 0 });
    });

    it.each([
      { cost: NaN, promptTokens: 1, completionTokens: 1 },
      { cost: -1, promptTokens: 1, completionTokens: 1 },
      { cost: Infinity, promptTokens: 1, completionTokens: 1 },
      { cost: 1, promptTokens: NaN, completionTokens: 1 },
      { cost: 1, promptTokens: 1, completionTokens: -5 },
    ])('estimation invalide %j : refus sans effet', async (est) => {
      expect(await code(gate.reserve(1, est))).toBe('assistant_unavailable');
      expect(prisma.rows).toHaveLength(0);
      expect(wf.reserveCalls).toHaveLength(0);
    });
  });

  describe('compensation et réservation', () => {
    it('réserve utilisateur puis globale ; renvoie l’id global', async () => {
      const r = await gate.reserve(1, usage(10, 50));
      expect(r).toMatchObject({ userId: 1, globalReservationId: 'glob-1' });
      expect(prisma.rows[0]).toMatchObject({ amount: 10, tokens: 50, calls: 1 });
      expect(wf.reserveCalls).toEqual([{ definitionId: 0 }]);
    });

    it('plafond utilisateur atteint : budget_exceeded sans appeler la porte globale', async () => {
      process.env.ASST_USER_DAILY_CAP_AMOUNT = '15';
      await gate.reserve(1, usage(10));
      wf.reserveCalls = [];
      expect(await code(gate.reserve(1, usage(10)))).toBe('budget_exceeded');
      expect(wf.reserveCalls).toHaveLength(0);
      expect(prisma.rows[0]).toMatchObject({ amount: 10, calls: 1 });
    });

    it('assertRunnable refuse quand le plafond est atteint', async () => {
      process.env.ASST_USER_DAILY_CAP_AMOUNT = '10';
      await gate.reserve(1, usage(10));
      expect(await code(gate.assertRunnable(1))).toBe('budget_exceeded');
      expect(await code(gate.assertRunnable(2))).toBe('ok');
    });
  });

  describe('settle / release', () => {
    it('settle remplace la réservation par le réel, une seule fois, et règle la porte globale', async () => {
      const r = await gate.reserve(1, usage(10, 100));
      await gate.settle(r, usage(4, 40));
      await gate.settle(r, usage(4, 40));
      expect(prisma.rows[0]).toMatchObject({ amount: 4, tokens: 40, calls: 1 });
      expect(wf.settled).toHaveLength(1);
      expect(wf.settled[0].r).toMatchObject({ id: 'glob-1', definitionId: 0 });
      await gate.release(r); // déjà soldée : sans effet
      expect(wf.released).toHaveLength(0);
      expect(prisma.rows[0]).toMatchObject({ amount: 4 });
    });

    it('settle peut dépasser le plafond (aucun refus)', async () => {
      process.env.ASST_USER_DAILY_CAP_AMOUNT = '10';
      const r = await gate.reserve(1, usage(10));
      await expect(gate.settle(r, usage(25))).resolves.toBeUndefined();
      expect(prisma.rows[0].amount).toBe(25);
    });

    it('release annule la réservation, idempotent', async () => {
      const r = await gate.reserve(1, usage(10, 100));
      await gate.release(r);
      await gate.release(r);
      expect(prisma.rows[0]).toMatchObject({ amount: 0, tokens: 0, calls: 0 });
      expect(wf.released).toHaveLength(1);
      expect(wf.released[0].id).toBe('glob-1');
    });

    it('ne lèvent jamais (SQL ou porte globale en échec)', async () => {
      const r = await gate.reserve(1, usage(10));
      prisma.failSql = true;
      wf.settleThrows = true;
      await expect(gate.settle(r, usage(5))).resolves.toBeUndefined();
      const r2 = await gate.reserve(2, usage(10)).catch(() => null);
      expect(r2).toBeNull(); // SQL en échec : refus fermé
      await expect(gate.release(r)).resolves.toBeUndefined();
    });
  });

  describe('plafonds de configuration', () => {
    it('défaut : 3000 et 500000', async () => {
      await gate.reserve(1, usage(1));
      expect(await gate.userCap(1)).toMatchObject({
        capAmount: 3000,
        capTokens: 500000,
        consumedAmount: 1,
      });
    });

    it('ligne absente : consommation 0 et plafonds de configuration', async () => {
      process.env.ASST_USER_DAILY_CAP_AMOUNT = '42';
      expect(await gate.userCap(7)).toEqual({
        capAmount: 42,
        capTokens: 500000,
        consumedAmount: 0,
        consumedTokens: 0,
      });
    });

    it('none : pas de plafond', async () => {
      process.env.ASST_USER_DAILY_CAP_AMOUNT = 'none';
      process.env.ASST_USER_DAILY_CAP_TOKENS = 'NONE';
      await gate.reserve(1, usage(1_000_000, 10_000_000));
      expect(await gate.userCap(1)).toMatchObject({ capAmount: null, capTokens: null });
    });

    it.each(['abc', '-5', 'NaN'])('valeur invalide %s : défaut', async (v) => {
      process.env.ASST_USER_DAILY_CAP_AMOUNT = v;
      process.env.ASST_USER_DAILY_CAP_TOKENS = v;
      expect(await gate.userCap(1)).toMatchObject({ capAmount: 3000, capTokens: 500000 });
    });

    it('le jour est le jour UTC de l’horloge injectée', async () => {
      await gate.reserve(1, usage(5));
      gate.now = () => new Date('2026-11-23T00:00:01Z');
      await gate.reserve(1, usage(5));
      expect(prisma.rows.map((r) => r.day)).toEqual(['2026-11-22', '2026-11-23']);
    });
  });
});
