import type { PrismaService } from '../../prisma/prisma.service';
import { WfBudgetEmergencyStopGate } from './emergency-stop';

type Where = { emergencyStop: boolean; OR: Array<{ definitionId: number | null }> };

/** Prisma simulé : applique la clause `where` à quelques lignes wf_budget. */
function gateWith(rows: Array<{ definitionId: number | null; emergencyStop: boolean }>) {
  const findFirst = jest.fn(({ where }: { where: Where }) => {
    const hit = rows.find(
      (r) => r.emergencyStop === where.emergencyStop && where.OR.some((c) => c.definitionId === r.definitionId),
    );
    return Promise.resolve(hit ? { wfBudgetId: 1 } : null);
  });
  const prisma = { wfBudget: { findFirst } } as unknown as PrismaService;
  return { gate: new WfBudgetEmergencyStopGate(prisma), findFirst };
}

describe('WfBudgetEmergencyStopGate', () => {
  it("aucune ligne : pas d'arrêt", async () => {
    expect(await gateWith([]).gate.isStopped(5)).toBe(false);
  });

  it('arrêt global (definition_id nul) : bloque tout workflow', async () => {
    const { gate } = gateWith([{ definitionId: null, emergencyStop: true }]);
    expect(await gate.isStopped(5)).toBe(true);
    expect(await gate.isStopped(6)).toBe(true);
  });

  it('arrêt par workflow : bloque ce workflow seulement', async () => {
    const { gate } = gateWith([{ definitionId: 5, emergencyStop: true }]);
    expect(await gate.isStopped(5)).toBe(true);
    expect(await gate.isStopped(6)).toBe(false);
  });

  it("ligne sans arrêt d'urgence : pas de blocage", async () => {
    const { gate } = gateWith([
      { definitionId: null, emergencyStop: false },
      { definitionId: 5, emergencyStop: false },
    ]);
    expect(await gate.isStopped(5)).toBe(false);
  });

  it("laisse remonter l'erreur de la base (le répartiteur applique fail-closed)", async () => {
    const prisma = { wfBudget: { findFirst: jest.fn().mockRejectedValue(new Error('db')) } } as unknown as PrismaService;
    await expect(new WfBudgetEmergencyStopGate(prisma).isStopped(1)).rejects.toThrow('db');
  });
});
