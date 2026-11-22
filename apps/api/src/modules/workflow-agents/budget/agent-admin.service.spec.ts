import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import { AgentAdminService, toBudgetDto } from './agent-admin.service';
import { updateWfBudgetSchema } from './agent-admin.dto';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10, fullName: 'Admin Test' };
const machine: AuthUser = { userId: 0, username: 'scan', isAdmin: false, userGroupId: null, isScanAgent: true };
const noGroup: AuthUser = { userId: 9, username: 'x', isAdmin: false, userGroupId: null };

interface Row {
  wfBudgetId: number;
  definitionId: number | null;
  periodKind: number;
  periodStart: Date;
  capAmount: string | null;
  consumedAmount: string;
  consumedTokens: bigint;
  alertThreshold: string;
  currency: string;
  emergencyStop: boolean;
  emergencyStopAt: Date | null;
  emergencyStopBy: number | null;
  emergencyStopReason: string | null;
  updatedAt: Date;
  updatedBy: number | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    wfBudgetId: 1,
    definitionId: null,
    periodKind: 0,
    periodStart: new Date('2026-11-01T00:00:00.000Z'),
    capAmount: null,
    consumedAmount: '0',
    consumedTokens: 0n,
    alertThreshold: '0.8',
    currency: 'XOF',
    emergencyStop: false,
    emergencyStopAt: null,
    emergencyStopBy: null,
    emergencyStopReason: null,
    updatedAt: NOW,
    updatedBy: null,
    ...over,
  };
}

function build(initial: Row[] = [row()], knownDefinitions: number[] = [5, 6], mode = 1) {
  const rows = [...initial];
  let nextId = 100;
  const find = (definitionId: number | null) => {
    const r = rows.find((x) => x.definitionId === definitionId);
    return r ? { ...r } : null; // copie : comme Prisma, l'ancien état ne bouge pas
  };
  const has = (definitionId: number | null) => rows.some((x) => x.definitionId === definitionId);
  const wfBudget = {
    findFirst: jest.fn(({ where }: { where: { definitionId: null } }) => Promise.resolve(find(where.definitionId))),
    findUnique: jest.fn(({ where }: { where: { definitionId?: number; wfBudgetId?: number } }) =>
      Promise.resolve(
        where.wfBudgetId !== undefined
          ? (rows.find((r) => r.wfBudgetId === where.wfBudgetId) ?? null)
          : find(where.definitionId ?? null),
      ),
    ),
    findUniqueOrThrow: jest.fn(({ where }: { where: { wfBudgetId: number } }) =>
      Promise.resolve({ ...(rows.find((r) => r.wfBudgetId === where.wfBudgetId) as Row) }),
    ),
    findMany: jest.fn(() => Promise.resolve(rows.filter((r) => r.definitionId !== null))),
    createMany: jest.fn(({ data }: { data: { definitionId: number | null }[] }) => {
      for (const d of data) {
        if (!has(d.definitionId)) rows.push(row({ wfBudgetId: nextId++, definitionId: d.definitionId }));
      }
      return Promise.resolve({ count: data.length });
    }),
    updateMany: jest.fn(
      ({ where, data }: { where: { wfBudgetId: number; consumedAmount?: number }; data: Partial<Row> }) => {
        const target = rows.find((r) => r.wfBudgetId === where.wfBudgetId);
        if (!target) return Promise.resolve({ count: 0 });
        if (where.consumedAmount !== undefined && Number(target.consumedAmount) !== where.consumedAmount) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(target, data, { updatedAt: NOW });
        return Promise.resolve({ count: 1 });
      },
    ),
    update: jest.fn(({ where, data }: { where: { wfBudgetId: number }; data: Partial<Row> }) => {
      const target = rows.find((r) => r.wfBudgetId === where.wfBudgetId) as Row;
      Object.assign(target, data, { updatedAt: NOW });
      return Promise.resolve({ ...target });
    }),
  };
  const wfDefinition = {
    findUnique: jest.fn(({ where }: { where: { wfDefinitionId: number } }) =>
      Promise.resolve(knownDefinitions.includes(where.wfDefinitionId) ? { wfDefinitionId: where.wfDefinitionId } : null),
    ),
  };
  const tx = { wfBudget, wfDefinition };
  const prisma = { ...tx, $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  const ai = { getEffectiveConfig: jest.fn(() => Promise.resolve({ mode })) };
  const audit = { dataChange: jest.fn(() => Promise.resolve()) };
  const service = new AgentAdminService(prisma as never, ai as never, audit as never);
  return { service, rows, wfBudget, prisma, audit, ai };
}

describe('AgentAdminService : acteur', () => {
  it('refuse l’identité machine et un compte sans groupe, partout', async () => {
    const { service } = build();
    for (const who of [machine, noGroup]) {
      await expect(service.status(who)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getBudget(who)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.updateBudget({ capAmount: 1 }, who)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.setEmergencyStop({ active: true }, who)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });
});

describe('AgentAdminService.status / getBudget', () => {
  it('status : aucun secret, seulement mode IA et arrêt global', async () => {
    const { service } = build([row({ emergencyStop: true, emergencyStopAt: NOW })], [], 2);
    expect(await service.status(admin)).toEqual({ aiEnabled: true, aiMode: 2, emergencyStopGlobal: true });
  });

  it('status : IA désactivée (mode 0)', async () => {
    const { service } = build([row()], [], 0);
    expect(await service.status(admin)).toEqual({ aiEnabled: false, aiMode: 0, emergencyStopGlobal: false });
  });

  it('getBudget : global + workflows, montants en chaîne', async () => {
    const { service } = build([
      row({ capAmount: '1000', consumedAmount: '12.5', consumedTokens: 4200n }),
      row({ wfBudgetId: 2, definitionId: 5, capAmount: '50' }),
    ]);
    const res = await service.getBudget(admin);
    expect(res.global).toMatchObject({ definitionId: null, capAmount: '1000', consumedAmount: '12.5', consumedTokens: '4200' });
    expect(res.workflows).toHaveLength(1);
    expect(res.workflows[0]).toMatchObject({ definitionId: 5, capAmount: '50', periodStart: '2026-11-01' });
    expect(typeof res.global.consumedTokens).toBe('string');
  });

  it('crée la ligne globale si elle manque (état anormal réparé côté administration)', async () => {
    const { service, rows } = build([]);
    const res = await service.getBudget(admin);
    expect(res.global.definitionId).toBeNull();
    expect(rows).toHaveLength(1);
  });
});

describe('AgentAdminService.updateBudget', () => {
  it('modifie la ligne globale (plafond, période, seuil, devise) et journalise ancien/nouveau', async () => {
    const { service, audit } = build();
    const dto = await service.updateBudget(
      { capAmount: 2500.5, periodKind: 1, alertThreshold: 0.9, currency: 'EUR' },
      admin,
    );
    expect(dto).toMatchObject({ capAmount: '2500.5000', periodKind: 1, alertThreshold: '0.900', currency: 'EUR', updatedBy: 10 });
    expect(audit.dataChange).toHaveBeenCalledTimes(1);
    const entry = (audit.dataChange.mock.calls as unknown as [Record<string, string | number>][])[0]![0];
    expect(entry).toMatchObject({ userGroupId: 10, actorFullName: 'Admin Test', objectRef: 'wf_budget:global' });
    expect(JSON.parse(String(entry.oldValue))).toMatchObject({ capAmount: null, currency: 'XOF', periodKind: 0 });
    expect(JSON.parse(String(entry.newValue))).toMatchObject({ capAmount: '2500.5000', currency: 'EUR', periodKind: 1 });
  });

  it('capAmount null retire le plafond ; un champ absent n’est pas modifié', async () => {
    const { service } = build([row({ capAmount: '10', currency: 'XOF', periodKind: 2 })]);
    const dto = await service.updateBudget({ capAmount: null }, admin);
    expect(dto).toMatchObject({ capAmount: null, currency: 'XOF', periodKind: 2 });
  });

  it('crée à la demande la ligne du workflow (la définition existe) et journalise sans ancienne valeur', async () => {
    const { service, rows, audit } = build();
    const dto = await service.updateBudget({ definitionId: 5, capAmount: 40 }, admin);
    expect(dto).toMatchObject({ definitionId: 5, capAmount: '40.0000' });
    expect(rows.filter((r) => r.definitionId === 5)).toHaveLength(1);
    const entry = (audit.dataChange.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(entry.objectRef).toBe('wf_budget:definition:5');
    expect(entry.oldValue).toBeUndefined();
  });

  it('définition inconnue => 404, rien n’est créé ni journalisé', async () => {
    const { service, rows, audit } = build();
    await expect(service.updateBudget({ definitionId: 999, capAmount: 1 }, admin)).rejects.toBeInstanceOf(NotFoundException);
    expect(rows).toHaveLength(1);
    expect(audit.dataChange).not.toHaveBeenCalled();
  });

  it('changement de devise refusé (409) s’il y a du consommé ; la période, elle, ne remet rien à zéro', async () => {
    const { service, rows, audit } = build([row({ consumedAmount: '3.2', currency: 'XOF' })]);
    await expect(service.updateBudget({ currency: 'EUR' }, admin)).rejects.toBeInstanceOf(ConflictException);
    expect(rows[0]?.currency).toBe('XOF');
    expect(audit.dataChange).not.toHaveBeenCalled();
    const dto = await service.updateBudget({ periodKind: 2 }, admin);
    expect(dto).toMatchObject({ periodKind: 2, consumedAmount: '3.2' });
  });

  it('changement de devise accepté sans consommé ; la même devise est toujours acceptée', async () => {
    const { service } = build([row({ consumedAmount: '5' })]);
    await expect(service.updateBudget({ currency: 'XOF', capAmount: 9 }, admin)).resolves.toMatchObject({ capAmount: '9.0000' });
    const fresh = build();
    await expect(fresh.service.updateBudget({ currency: 'USD' }, admin)).resolves.toMatchObject({ currency: 'USD' });
  });

  it('une panne du journal d’audit ne défait pas la modification', async () => {
    const { service, audit } = build();
    audit.dataChange.mockRejectedValueOnce(new Error('audit indisponible'));
    const logSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    await expect(service.updateBudget({ capAmount: 1 }, admin)).resolves.toMatchObject({ capAmount: '1.0000' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]?.[0])).not.toContain('audit indisponible');
  });
});

describe('updateWfBudgetSchema', () => {
  it('accepte un corps valide et refuse les valeurs hors bornes / clés inconnues', () => {
    const ok = updateWfBudgetSchema.safeParse({ definitionId: 3, capAmount: 0, periodKind: 2, alertThreshold: 1, currency: 'XOF' });
    expect(ok.success).toBe(true);
    expect(updateWfBudgetSchema.safeParse({ definitionId: null, capAmount: null }).success).toBe(true);
    for (const bad of [
      { definitionId: 0 },
      { definitionId: 1.5 },
      { capAmount: -1 },
      { capAmount: 1e12 },
      { periodKind: 3 },
      { alertThreshold: 1.1 },
      { currency: 'xof' },
      { currency: 'XOFF' },
      { inconnu: true },
    ]) {
      expect(updateWfBudgetSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('AgentAdminService.setEmergencyStop', () => {
  it('active : arrêt global avec date, auteur et motif ; journalisé', async () => {
    const { service, audit } = build();
    const dto = await service.setEmergencyStop({ active: true, reason: '  Dérive de coût  ' }, admin);
    expect(dto).toMatchObject({ definitionId: null, emergencyStop: true, emergencyStopBy: 10, emergencyStopReason: 'Dérive de coût' });
    expect(dto.emergencyStopAt).not.toBeNull();
    const entry = (audit.dataChange.mock.calls as unknown as [Record<string, string>][])[0]![0];
    expect(entry.objectRef).toBe('wf_budget:global');
    expect(JSON.parse(entry.oldValue ?? '{}').emergencyStop).toBe(false);
    expect(JSON.parse(entry.newValue ?? '{}').emergencyStop).toBe(true);
  });

  it('inactive : remise à faux, date / auteur / motif effacés', async () => {
    const { service } = build([row({ emergencyStop: true, emergencyStopAt: NOW, emergencyStopBy: 3, emergencyStopReason: 'x' })]);
    const dto = await service.setEmergencyStop({ active: false }, admin);
    expect(dto).toMatchObject({ emergencyStop: false, emergencyStopAt: null, emergencyStopBy: null, emergencyStopReason: null });
  });

  it('idempotent : répéter l’état demandé n’écrit ni ne journalise rien', async () => {
    const { service, audit, wfBudget } = build([row({ emergencyStop: true, emergencyStopAt: NOW, emergencyStopBy: 3, emergencyStopReason: 'x' })]);
    const dto = await service.setEmergencyStop({ active: true, reason: 'autre' }, admin);
    expect(dto).toMatchObject({ emergencyStop: true, emergencyStopBy: 3, emergencyStopReason: 'x' });
    expect(wfBudget.update).not.toHaveBeenCalled();
    expect(audit.dataChange).not.toHaveBeenCalled();
    const off = build();
    await off.service.setEmergencyStop({ active: false }, admin);
    expect(off.wfBudget.update).not.toHaveBeenCalled();
  });

  it('arrêt d’un workflow : crée la ligne si besoin, ne touche pas la ligne globale', async () => {
    const { service, rows, audit } = build();
    const dto = await service.setEmergencyStop({ definitionId: 5, active: true }, admin);
    expect(dto).toMatchObject({ definitionId: 5, emergencyStop: true });
    expect(rows.find((r) => r.definitionId === null)?.emergencyStop).toBe(false);
    const entry = (audit.dataChange.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(entry.objectRef).toBe('wf_budget:definition:5');
  });

  it('définition inconnue => 404', async () => {
    const { service } = build();
    await expect(service.setEmergencyStop({ definitionId: 999, active: true }, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('toBudgetDto', () => {
  it('sérialise dates en texte et nombres en chaîne', () => {
    const dto = toBudgetDto(row({ consumedTokens: 9007199254740993n, emergencyStopAt: NOW, emergencyStop: true }) as never);
    expect(dto.consumedTokens).toBe('9007199254740993');
    expect(dto.emergencyStopAt).toBe('2026-11-21T10:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-11-21T10:00:00.000Z');
  });
});
