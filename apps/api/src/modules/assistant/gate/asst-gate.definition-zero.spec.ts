import { AgentGateService } from '../../workflow-agents/budget/agent-gate.service';
import { AsstError } from '../assistant.contracts';
import { AsstGateService } from './asst-gate.service';

// TEST CLÉ : AsstGateService réel branché sur le VRAI AgentGateService, avec un faux PrismaService qui simule
// `wf_budget` en mémoire. Seule la ligne GLOBALE existe : aucune ligne pour la définition 0 (ASST_GATE_DEFINITION_ID).
// Prouve que la porte globale est réutilisée telle quelle : la ligne de la définition 0 est absente et tolérée,
// l'arrêt d'urgence et le plafond GLOBAUX s'appliquent, settle/release ajustent la ligne globale.

interface GlobalRow {
  emergencyStop: boolean;
  capAmount: number | null;
  amount: number;
  tokens: number;
}

interface UserRow {
  userId: number;
  day: string;
  amount: number;
  tokens: number;
  calls: number;
  capAmount: number | null;
  capTokens: number | null;
}

class FakePrisma {
  global: GlobalRow | null = { emergencyStop: false, capAmount: null, amount: 0, tokens: 0 };
  users: UserRow[] = [];
  /** Requêtes sur une ligne de définition (doivent rester sans effet : la ligne n'existe pas). */
  definitionQueries = 0;

  $transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
    return cb(this);
  }

  wfBudget = {
    findMany: (): Promise<{ definitionId: number | null; emergencyStop: boolean }[]> =>
      Promise.resolve(
        this.global ? [{ definitionId: null, emergencyStop: this.global.emergencyStop }] : [],
      ),
  };

  private user(userId: number, day: string): UserRow | undefined {
    return this.users.find((u) => u.userId === userId && u.day === day);
  }

  $executeRaw(strings: TemplateStringsArray, ...v: unknown[]): Promise<number> {
    const sql = strings.join('?');
    if (sql.includes('"wf_budget"')) {
      if (sql.includes('"definition_id" = ')) {
        this.definitionQueries += 1;
        return Promise.resolve(0);
      }
      if (sql.includes('GREATEST')) {
        const [cost, tokens] = v as [string, number];
        if (!this.global) return Promise.resolve(0);
        this.global.amount = Math.max(0, this.global.amount + Number(cost));
        this.global.tokens = Math.max(0, this.global.tokens + tokens);
        return Promise.resolve(1);
      }
      return Promise.resolve(0); // remise à zéro de période : rien à faire (période courante)
    }
    if (sql.includes('INSERT INTO "asst_user_budget"')) {
      const [userId, day, capAmount, capTokens] = v as [
        number,
        string,
        string | null,
        number | null,
      ];
      if (this.user(userId, day)) return Promise.resolve(0);
      this.users.push({
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
      const u = this.user(userId, day);
      if (!u) return Promise.resolve(0);
      u.amount = Math.max(0, u.amount + Number(cost));
      u.tokens = Math.max(0, u.tokens + tokens);
      u.calls = Math.max(0, u.calls + calls);
      return Promise.resolve(1);
    }
    return Promise.reject(new Error('SQL inattendu'));
  }

  $queryRaw(strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]> {
    const sql = strings.join('?');
    if (sql.includes('"wf_budget"')) {
      if (sql.includes('"definition_id" = ')) {
        this.definitionQueries += 1;
        return Promise.resolve([]);
      }
      const g = this.global;
      if (sql.includes('RETURNING')) {
        const [cost, tokens] = v as [string, number];
        const c = Number(cost);
        if (!g || g.emergencyStop || (g.capAmount !== null && g.amount + c > g.capAmount))
          return Promise.resolve([]);
        g.amount += c;
        g.tokens += tokens;
        return Promise.resolve([{ wf_budget_id: 1 }]);
      }
      if (sql.includes('SELECT "emergency_stop"')) {
        return Promise.resolve(g ? [{ emergency_stop: g.emergencyStop }] : []);
      }
    }
    if (sql.includes('"asst_user_budget"')) {
      if (sql.includes('RETURNING')) {
        const [cost, tokens, userId, day] = v as [string, number, number, string];
        const u = this.user(userId, day);
        const c = Number(cost);
        if (!u) return Promise.resolve([]);
        if (u.capAmount !== null && u.amount + c > u.capAmount) return Promise.resolve([]);
        if (u.capTokens !== null && u.tokens + tokens > u.capTokens) return Promise.resolve([]);
        u.amount += c;
        u.tokens += tokens;
        u.calls += 1;
        return Promise.resolve([{ asst_user_budget_id: 1 }]);
      }
      const [userId, day] = v as [number, string];
      const u = this.user(userId, day);
      return Promise.resolve(
        u
          ? [
              {
                cap_amount: u.capAmount,
                cap_tokens: u.capTokens,
                consumed_amount: u.amount,
                consumed_tokens: u.tokens,
              },
            ]
          : [],
      );
    }
    return Promise.reject(new Error('SQL inattendu'));
  }
}

const usage = (cost: number, tokens = 100) => ({ promptTokens: tokens, completionTokens: 0, cost });

describe('AsstGateService sur le vrai AgentGateService (définition 0 sans ligne wf_budget)', () => {
  let prisma: FakePrisma;
  let gate: AsstGateService;

  beforeEach(() => {
    delete process.env.ASST_USER_DAILY_CAP_AMOUNT;
    delete process.env.ASST_USER_DAILY_CAP_TOKENS;
    prisma = new FakePrisma();
    const ai = { getEffectiveConfig: () => Promise.resolve({ mode: 1 }) };
    const real = new AgentGateService(prisma as never, ai as never);
    gate = new AsstGateService(prisma as never, real);
    gate.now = () => new Date('2026-11-22T10:00:00Z');
  });

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      if (e instanceof AsstError) return e.errorCode;
      throw e;
    }
  };

  it('(a) assertRunnable passe avec la seule ligne globale', async () => {
    await expect(gate.assertRunnable(1)).resolves.toBeUndefined();
  });

  it('(b) reserve ne débite que la ligne globale ; définition 0 absente tolérée', async () => {
    const r = await gate.reserve(1, usage(10, 100));
    expect(r.globalReservationId).toEqual(expect.any(String));
    expect(prisma.global).toMatchObject({ amount: 10, tokens: 100 });
    expect(prisma.users[0]).toMatchObject({ amount: 10, tokens: 100, calls: 1 });
    expect(prisma.definitionQueries).toBeGreaterThan(0); // la ligne de la définition 0 est interrogée, absente, tolérée
  });

  it('(c) l’arrêt d’urgence global bloque : assistant_unavailable, rien de réservé', async () => {
    prisma.global!.emergencyStop = true;
    expect(await codeOf(gate.assertRunnable(1))).toBe('assistant_unavailable');
    expect(await codeOf(gate.reserve(1, usage(10)))).toBe('assistant_unavailable');
    expect(prisma.global).toMatchObject({ amount: 0, tokens: 0 });
    expect(prisma.users[0]).toMatchObject({ amount: 0, tokens: 0, calls: 0 });
  });

  it('(d) le plafond global est effectif : budget_exceeded et réservation utilisateur compensée', async () => {
    prisma.global!.capAmount = 15;
    await gate.reserve(1, usage(10));
    expect(await codeOf(gate.reserve(2, usage(10)))).toBe('budget_exceeded');
    expect(prisma.global).toMatchObject({ amount: 10 });
    expect(prisma.users.find((u) => u.userId === 2)).toMatchObject({
      amount: 0,
      tokens: 0,
      calls: 0,
    });
    expect(prisma.users.find((u) => u.userId === 1)).toMatchObject({ amount: 10, calls: 1 });
  });

  it('(e) settle et release ajustent la ligne globale', async () => {
    const r1 = await gate.reserve(1, usage(10, 100));
    const r2 = await gate.reserve(1, usage(6, 60));
    expect(prisma.global).toMatchObject({ amount: 16, tokens: 160 });
    await gate.settle(r1, usage(4, 40));
    expect(prisma.global).toMatchObject({ amount: 10, tokens: 100 });
    await gate.release(r2);
    expect(prisma.global).toMatchObject({ amount: 4, tokens: 40 });
    expect(prisma.users[0]).toMatchObject({ amount: 4, tokens: 40, calls: 1 });
    // idempotence
    await gate.settle(r1, usage(4, 40));
    await gate.release(r2);
    expect(prisma.global).toMatchObject({ amount: 4, tokens: 40 });
  });

  it('(f) échec fermé si la ligne globale est absente (budget_unavailable)', async () => {
    prisma.global = null;
    expect(await codeOf(gate.assertRunnable(1))).toBe('assistant_unavailable');
    expect(await codeOf(gate.reserve(1, usage(10)))).toBe('assistant_unavailable');
    expect(prisma.users[0]).toMatchObject({ amount: 0, tokens: 0, calls: 0 });
  });
});
