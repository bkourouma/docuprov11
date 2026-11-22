import { AgentBlockedError, type AgentBlockReason, type AgentReservation } from '../agent.contracts';
import { AgentGateService } from './agent-gate.service';

// Prisma simulé : un petit magasin en mémoire qui interprète les requêtes SQL du service d'après leur
// texte. `$transaction` restaure l'état si le rappel lève (rollback COMPLET), comme PostgreSQL.

interface Row {
  cap: number | null;
  consumed: number;
  tokens: number;
  stop: boolean;
}

class FakeDb {
  rows = new Map<number | null, Row>();
  sql: string[] = [];
  failTransactions = false;

  constructor(global: Row | null = { cap: null, consumed: 0, tokens: 0, stop: false }) {
    if (global) this.rows.set(null, global);
  }

  private snapshot(): Map<number | null, Row> {
    return new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
  }

  tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      this.sql.push(text);
      if (text.includes('GREATEST')) {
        const [cost, tokens] = values as [string, number, number?];
        const id = text.includes('"definition_id" IS NULL') ? null : (values[2] as number);
        const row = this.rows.get(id);
        if (row) {
          row.consumed = Math.max(0, row.consumed + Number(cost));
          row.tokens = Math.max(0, row.tokens + tokens);
        }
      }
      return Promise.resolve(1);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      this.sql.push(text);
      if (text.includes('RETURNING')) {
        const cost = Number(values[0]);
        const tokens = values[1] as number;
        const defId = text.includes('"definition_id" IS NULL') ? null : (values[2] as number);
        const row = this.rows.get(defId);
        if (!row || row.stop) return Promise.resolve([]);
        if (row.cap !== null && row.consumed + cost > row.cap) return Promise.resolve([]);
        row.consumed += cost;
        row.tokens += tokens;
        return Promise.resolve([{ wf_budget_id: 1 }]);
      }
      const row = this.rows.get(text.includes('"definition_id" IS NULL') ? null : (values[0] as number));
      return Promise.resolve(row ? [{ emergency_stop: row.stop }] : []);
    },
  };

  prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (this.failTransactions) throw new Error('connexion perdue');
      const saved = this.snapshot();
      try {
        return await fn(this.tx);
      } catch (err) {
        this.rows = saved;
        throw err;
      }
    },
    wfBudget: {
      findMany: jest.fn(() =>
        Promise.resolve([...this.rows].map(([definitionId, r]) => ({ definitionId, emergencyStop: r.stop }))),
      ),
    },
  };
}

function build(db: FakeDb, mode: number | Error = 1) {
  const ai = {
    getEffectiveConfig: jest.fn(() => (mode instanceof Error ? Promise.reject(mode) : Promise.resolve({ mode }))),
  };
  return new AgentGateService(db.prisma as never, ai as never);
}

async function reason(p: Promise<unknown>): Promise<AgentBlockReason> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AgentBlockedError);
    return (err as AgentBlockedError).reason;
  }
  throw new Error('un AgentBlockedError était attendu');
}

const use = (cost: number, prompt = 10, completion = 5) => ({ promptTokens: prompt, completionTokens: completion, cost });

describe('AgentGateService.assertRunnable', () => {
  it('passe quand l’IA est active et qu’aucun arrêt d’urgence n’est posé', async () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: null, consumed: 0, tokens: 0, stop: false });
    await expect(build(db).assertRunnable({ definitionId: 7 })).resolves.toBeUndefined();
  });

  it('IA désactivée (mode 0) => ai_disabled, avant toute lecture du budget', async () => {
    const db = new FakeDb();
    expect(await reason(build(db, 0).assertRunnable({ definitionId: 7 }))).toBe('ai_disabled');
    expect(db.prisma.wfBudget.findMany).not.toHaveBeenCalled();
  });

  it('arrêt d’urgence global => emergency_stop_global (prioritaire sur celui du workflow)', async () => {
    const db = new FakeDb({ cap: null, consumed: 0, tokens: 0, stop: true });
    db.rows.set(7, { cap: null, consumed: 0, tokens: 0, stop: true });
    expect(await reason(build(db).assertRunnable({ definitionId: 7 }))).toBe('emergency_stop_global');
  });

  it('arrêt d’urgence du workflow => emergency_stop_workflow ; un autre workflow n’est pas touché', async () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: null, consumed: 0, tokens: 0, stop: true });
    db.rows.set(8, { cap: null, consumed: 0, tokens: 0, stop: false });
    const gate = build(db);
    expect(await reason(gate.assertRunnable({ definitionId: 7 }))).toBe('emergency_stop_workflow');
    await expect(gate.assertRunnable({ definitionId: 8 })).resolves.toBeUndefined();
  });

  it('échec fermé : lecture du budget en erreur => budget_unavailable', async () => {
    const db = new FakeDb();
    db.prisma.wfBudget.findMany.mockRejectedValueOnce(new Error('base injoignable'));
    expect(await reason(build(db).assertRunnable({ definitionId: 7 }))).toBe('budget_unavailable');
  });

  it('échec fermé : lecture de la configuration IA en erreur => budget_unavailable', async () => {
    const db = new FakeDb();
    expect(await reason(build(db, new Error('boom')).assertRunnable({ definitionId: 7 }))).toBe('budget_unavailable');
  });

  it('échec fermé : ligne globale absente => budget_unavailable', async () => {
    const db = new FakeDb(null);
    expect(await reason(build(db).assertRunnable({ definitionId: 7 }))).toBe('budget_unavailable');
  });
});

describe('AgentGateService.reserve', () => {
  it('débite la ligne globale et celle du workflow, renvoie une réservation à id aléatoire', async () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: 100, consumed: 0, tokens: 0, stop: false });
    const gate = build(db);
    const a = await gate.reserve({ definitionId: 7 }, use(2));
    const b = await gate.reserve({ definitionId: 7 }, use(3));
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ definitionId: 7, reserved: { cost: 2, promptTokens: 10, completionTokens: 5 } });
    expect(db.rows.get(null)).toMatchObject({ consumed: 5, tokens: 30 });
    expect(db.rows.get(7)).toMatchObject({ consumed: 5, tokens: 30 });
  });

  it('sans ligne workflow : pas de plafond workflow, seul le global s’applique', async () => {
    const db = new FakeDb({ cap: 10, consumed: 0, tokens: 0, stop: false });
    const gate = build(db);
    await gate.reserve({ definitionId: 7 }, use(10));
    expect(db.rows.has(7)).toBe(false);
    expect(await reason(gate.reserve({ definitionId: 7 }, use(1)))).toBe('budget_exceeded_global');
  });

  it('refuse AVANT dépassement : consommé + estimation > plafond => budget_exceeded_workflow, rien n’est débité', async () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: 10, consumed: 8, tokens: 0, stop: false });
    const gate = build(db);
    expect(await reason(gate.reserve({ definitionId: 7 }, use(3)))).toBe('budget_exceeded_workflow');
    expect(db.rows.get(7)?.consumed).toBe(8);
    await expect(gate.reserve({ definitionId: 7 }, use(2))).resolves.toBeDefined();
    expect(db.rows.get(7)?.consumed).toBe(10);
  });

  it('plafond global dépassé => budget_exceeded_global', async () => {
    const db = new FakeDb({ cap: 5, consumed: 5, tokens: 0, stop: false });
    expect(await reason(build(db).reserve({ definitionId: 7 }, use(1)))).toBe('budget_exceeded_global');
  });

  it('plafond nul : tout appel coûteux est refusé', async () => {
    const db = new FakeDb({ cap: 0, consumed: 0, tokens: 0, stop: false });
    expect(await reason(build(db).reserve({ definitionId: 7 }, use(0.0001)))).toBe('budget_exceeded_global');
  });

  it('arrêt d’urgence global / workflow => refus (et pas un dépassement)', async () => {
    const dbG = new FakeDb({ cap: null, consumed: 0, tokens: 0, stop: true });
    expect(await reason(build(dbG).reserve({ definitionId: 7 }, use(1)))).toBe('emergency_stop_global');
    const dbW = new FakeDb();
    dbW.rows.set(7, { cap: null, consumed: 0, tokens: 0, stop: true });
    expect(await reason(build(dbW).reserve({ definitionId: 7 }, use(1)))).toBe('emergency_stop_workflow');
  });

  it('ROLLBACK COMPLET : quand le workflow refuse, la réservation globale déjà faite est annulée', async () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: 1, consumed: 0, tokens: 0, stop: false });
    const gate = build(db);
    expect(await reason(gate.reserve({ definitionId: 7 }, use(5)))).toBe('budget_exceeded_workflow');
    expect(db.rows.get(null)).toMatchObject({ consumed: 0, tokens: 0 });
    expect(db.rows.get(7)).toMatchObject({ consumed: 0, tokens: 0 });
  });

  it('ordre fixe : la ligne globale est traitée avant celle du workflow', async () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: null, consumed: 0, tokens: 0, stop: false });
    await build(db).reserve({ definitionId: 7 }, use(1));
    const incs = db.sql.filter((s) => s.includes('RETURNING'));
    expect(incs).toHaveLength(2);
    expect(incs[0]).toContain('"definition_id" IS NULL');
    expect(incs[1]).toContain('"definition_id" = ?');
  });

  it('incrément atomique et conditionnel : un seul UPDATE porte le plafond, l’arrêt d’urgence, RETURNING', async () => {
    const db = new FakeDb();
    await build(db).reserve({ definitionId: 7 }, use(1));
    const inc = db.sql.find((s) => s.includes('RETURNING'));
    expect(inc).toMatch(/^\s*UPDATE "wf_budget"/);
    expect(inc).toContain('NOT "emergency_stop"');
    expect(inc).toContain('"consumed_amount" + ?::numeric <= "cap_amount"');
    expect(inc).toContain('"consumed_tokens" = "consumed_tokens" +');
  });

  it('remise à zéro de la période échue avant l’incrément : mensuel et journalier, jamais le cumulé', async () => {
    const db = new FakeDb();
    await build(db).reserve({ definitionId: 7 }, use(1));
    const reset = db.sql.find((s) => s.includes('date_trunc'));
    expect(reset).toBeDefined();
    expect(reset).toContain('"period_kind" = 0');
    expect(reset).toContain('"period_kind" = 1');
    expect(reset).not.toContain('"period_kind" = 2');
    expect(reset).toContain("AT TIME ZONE 'UTC'");
    expect(db.sql.indexOf(reset as string)).toBeLessThan(db.sql.findIndex((s) => s.includes('RETURNING')));
  });

  it('échec fermé : erreur de base pendant la réservation => budget_unavailable', async () => {
    const db = new FakeDb();
    db.failTransactions = true;
    expect(await reason(build(db).reserve({ definitionId: 7 }, use(1)))).toBe('budget_unavailable');
  });

  it('estimation invalide (NaN, négative) => budget_unavailable', async () => {
    const gate = build(new FakeDb());
    expect(await reason(gate.reserve({ definitionId: 7 }, use(Number.NaN)))).toBe('budget_unavailable');
    expect(await reason(gate.reserve({ definitionId: 7 }, use(-1)))).toBe('budget_unavailable');
  });
});

describe('AgentGateService.settle / release', () => {
  async function reserved(db: FakeDb, cost: number, gate = build(db)): Promise<[AgentGateService, AgentReservation]> {
    return [gate, await gate.reserve({ definitionId: 7 }, use(cost, 100, 50))];
  }
  const dbWith = () => {
    const db = new FakeDb();
    db.rows.set(7, { cap: 100, consumed: 0, tokens: 0, stop: false });
    return db;
  };

  it('settle remplace l’estimation par le réel (vers le bas)', async () => {
    const db = dbWith();
    const [gate, r] = await reserved(db, 10);
    await gate.settle(r, { promptTokens: 40, completionTokens: 10, cost: 4 });
    expect(db.rows.get(null)).toMatchObject({ consumed: 4, tokens: 50 });
    expect(db.rows.get(7)).toMatchObject({ consumed: 4, tokens: 50 });
  });

  it('settle ne refuse jamais, même si le réel dépasse le plafond', async () => {
    const db = dbWith();
    const [gate, r] = await reserved(db, 90);
    await expect(gate.settle(r, { promptTokens: 1, completionTokens: 1, cost: 500 })).resolves.toBeUndefined();
    expect(db.rows.get(7)?.consumed).toBe(500);
  });

  it('la consommation ne devient jamais négative', async () => {
    const db = dbWith();
    const [gate, r] = await reserved(db, 10);
    db.rows.get(7)!.consumed = 2; // remise à zéro de période entre-temps, par exemple
    db.rows.get(null)!.tokens = 5;
    await gate.settle(r, { promptTokens: 0, completionTokens: 0, cost: 0 });
    expect(db.rows.get(7)).toMatchObject({ consumed: 0, tokens: 0 });
    expect(db.rows.get(null)?.tokens).toBe(0);
  });

  it('release retire l’estimation ; un second release est sans effet', async () => {
    const db = dbWith();
    const [gate, r] = await reserved(db, 10);
    await gate.release(r);
    expect(db.rows.get(7)).toMatchObject({ consumed: 0, tokens: 0 });
    await gate.reserve({ definitionId: 7 }, use(3));
    await gate.release(r);
    expect(db.rows.get(7)?.consumed).toBe(3);
  });

  it('ne touche que les lignes débitées (pas de ligne workflow à la réservation)', async () => {
    const db = new FakeDb();
    const gate = build(db);
    const r = await gate.reserve({ definitionId: 7 }, use(5));
    db.rows.set(7, { cap: null, consumed: 0, tokens: 0, stop: false }); // ligne créée après coup
    await gate.release(r);
    expect(db.rows.get(null)?.consumed).toBe(0);
    expect(db.rows.get(7)?.consumed).toBe(0);
    expect(db.sql.filter((s) => s.includes('GREATEST') && s.includes('"definition_id" = ?'))).toHaveLength(0);
  });

  it('ne lève jamais : une erreur de base est journalisée sans contenu', async () => {
    const db = dbWith();
    const [gate, r] = await reserved(db, 10);
    db.failTransactions = true;
    const logSpy = jest.spyOn(gate['logger'], 'error').mockImplementation(() => undefined);
    await expect(gate.settle(r, { promptTokens: 1, completionTokens: 1, cost: 1 })).resolves.toBeUndefined();
    await expect(gate.release(r)).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('connexion perdue');
  });
});

describe('AgentGateService.costOf', () => {
  const KEYS = ['WF_AGENT_COST_PER_1K_PROMPT', 'WF_AGENT_COST_PER_1K_COMPLETION'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => KEYS.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])));
  afterEach(() =>
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))),
  );
  const gate = () => build(new FakeDb());

  it('tarif par défaut : 5 / 15 par 1000 jetons', () => {
    expect(gate().costOf({ promptTokens: 1000, completionTokens: 1000 })).toBe(20);
    expect(gate().costOf({ promptTokens: 2000, completionTokens: 0 })).toBe(10);
    expect(gate().costOf({ promptTokens: 0, completionTokens: 500 })).toBe(7.5);
  });

  it('tarif lu dans l’environnement', () => {
    process.env.WF_AGENT_COST_PER_1K_PROMPT = '2';
    process.env.WF_AGENT_COST_PER_1K_COMPLETION = '0.5';
    expect(gate().costOf({ promptTokens: 1000, completionTokens: 2000 })).toBe(3);
  });

  it('valeurs invalides (texte, négatif, vide) => défauts', () => {
    process.env.WF_AGENT_COST_PER_1K_PROMPT = 'abc';
    process.env.WF_AGENT_COST_PER_1K_COMPLETION = '-4';
    expect(gate().costOf({ promptTokens: 1000, completionTokens: 1000 })).toBe(20);
    process.env.WF_AGENT_COST_PER_1K_PROMPT = '';
    expect(gate().costOf({ promptTokens: 1000, completionTokens: 0 })).toBe(5);
  });

  it('jetons négatifs ou non finis comptés pour 0', () => {
    expect(gate().costOf({ promptTokens: -5, completionTokens: Number.NaN })).toBe(0);
  });
});
