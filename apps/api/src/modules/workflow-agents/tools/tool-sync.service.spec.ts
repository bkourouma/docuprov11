import type { PrismaService } from '../../prisma/prisma.service';
import { createBaseTools } from './base-tools';
import { toolRegistryProvider } from './tools.provider';
import { WfToolSyncService } from './tool-sync.service';
import { WfToolRegistry } from './tool-registry';

/** Faux `wf_tool` en mémoire : reproduit la sémantique de l'upsert (create vs update). */
function fakePrisma() {
  const table = new Map<string, Record<string, unknown>>();
  const upsert = jest.fn(async (args: { where: { toolKey: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
    const existing = table.get(args.where.toolKey);
    if (existing) Object.assign(existing, args.update);
    else table.set(args.where.toolKey, { isEnabled: true, ...args.create });
    return table.get(args.where.toolKey);
  });
  return { table, upsert, prisma: { wfTool: { upsert } } as unknown as PrismaService };
}

function registry() {
  const r = new WfToolRegistry();
  createBaseTools({} as never).forEach((t) => r.register(t));
  return r;
}

describe('WfToolSyncService', () => {
  it('crée les cinq outils activés, avec leurs métadonnées', async () => {
    const { table, prisma } = fakePrisma();
    const svc = new WfToolSyncService(prisma, registry());
    await svc.onApplicationBootstrap();
    expect(table.size).toBe(5);
    expect(table.get('proposer_imputation')).toMatchObject({
      toolKey: 'proposer_imputation', sideEffect: 1, requiresValidation: true, isEnabled: true,
    });
    expect(table.get('lire_document')?.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it('idempotent : deux synchronisations donnent le même état', async () => {
    const { table, prisma } = fakePrisma();
    const svc = new WfToolSyncService(prisma, registry());
    await svc.sync();
    const first = JSON.stringify([...table.entries()]);
    await svc.sync();
    expect(JSON.stringify([...table.entries()])).toBe(first);
    expect(table.size).toBe(5);
  });

  it('ne réactive JAMAIS un outil désactivé et n’envoie pas is_enabled', async () => {
    const { table, upsert, prisma } = fakePrisma();
    const svc = new WfToolSyncService(prisma, registry());
    await svc.sync();
    (table.get('lire_courrier') as Record<string, unknown>).isEnabled = false;
    (table.get('lire_courrier') as Record<string, unknown>).label = 'ancien libellé';
    await svc.sync();
    expect(table.get('lire_courrier')?.isEnabled).toBe(false);
    expect(table.get('lire_courrier')?.label).toBe('Lire un courrier');
    for (const [args] of upsert.mock.calls) expect(args.update).not.toHaveProperty('isEnabled');
  });

  it('une erreur est journalisée sans bloquer le démarrage', async () => {
    const upsert = jest.fn().mockRejectedValue(new Error('base indisponible : secret'));
    const svc = new WfToolSyncService({ wfTool: { upsert } } as unknown as PrismaService, registry());
    const errors: string[] = [];
    (svc as unknown as { logger: { error: (m: string) => void } }).logger = { error: (m) => errors.push(m) };
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).not.toContain('secret');
  });

  it('continue avec les autres outils si un seul échoue', async () => {
    const { upsert, prisma, table } = fakePrisma();
    upsert.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const svc = new WfToolSyncService(prisma, registry());
    (svc as unknown as { logger: { error: () => void } }).logger = { error: () => undefined };
    await expect(svc.sync()).resolves.toBe(4);
    expect(table.size).toBe(4);
  });
});

describe('toolRegistryProvider', () => {
  it('construit le registre avec les cinq outils à partir du port de données', () => {
    const factory = (toolRegistryProvider as { useFactory: (d: unknown) => WfToolRegistry }).useFactory;
    const reg = factory({});
    expect(reg.list().map((t) => t.key)).toHaveLength(5);
  });
});
