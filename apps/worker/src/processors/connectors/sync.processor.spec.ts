// Câblage : tick, enfileur IA, refus de démarrage et passe de bout en bout sur une base simulée.
import { z } from 'zod';
import {
  ConnectorRegistry,
  encryptCredentials,
  loadKeyRing,
  type ConnectorDefinition,
  type SourceConnector,
} from '@archivage/connectors';
import { GedAiMode } from '@archivage/types';

jest.mock('../../db', () => ({ prisma: {} }));
jest.mock('../seal-document', () => ({ sealFreshDocument: jest.fn() }));

import { createAiEnqueuer } from './ai-trigger';
import { createPrismaSyncStore } from './prisma-store';
import { createConnectorSyncProcessor, runConnectorTick, runSyncJob } from './sync.processor';

const NOW = new Date('2026-11-20T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('runConnectorTick', () => {
  const rows = [
    {
      gedSourceConnectorId: 1,
      lastSyncAt: minutesAgo(120),
      syncIntervalMinutes: 60,
      isActive: true,
      status: 1,
    },
    {
      gedSourceConnectorId: 2,
      lastSyncAt: minutesAgo(10),
      syncIntervalMinutes: 60,
      isActive: true,
      status: 1,
    },
    {
      gedSourceConnectorId: 3,
      lastSyncAt: null,
      syncIntervalMinutes: 30,
      isActive: true,
      status: 1,
    },
    {
      gedSourceConnectorId: 4,
      lastSyncAt: minutesAgo(999),
      syncIntervalMinutes: 5,
      isActive: false,
      status: 1,
    },
    {
      gedSourceConnectorId: 5,
      lastSyncAt: minutesAgo(999),
      syncIntervalMinutes: 5,
      isActive: true,
      status: 0,
    },
    {
      gedSourceConnectorId: 6,
      lastSyncAt: minutesAgo(999),
      syncIntervalMinutes: null,
      isActive: true,
      status: 1,
    },
    {
      gedSourceConnectorId: 7,
      lastSyncAt: minutesAgo(60),
      syncIntervalMinutes: 60,
      isActive: true,
      status: 2,
    },
    // Autorisation expirée : jamais retentée automatiquement (relancer exige une action humaine).
    {
      gedSourceConnectorId: 8,
      lastSyncAt: minutesAgo(999),
      syncIntervalMinutes: 60,
      isActive: true,
      status: 3,
    },
  ];
  // Simule le filtre `where` de la requête : l'inactif, le statut 0 et l'absence de cadence en sont exclus.
  const findMany = jest.fn(async ({ where }: { where: any }) =>
    rows.filter(
      (r) =>
        r.isActive === where.isActive &&
        !where.status.notIn.includes(r.status) &&
        r.syncIntervalMinutes !== where.syncIntervalMinutes.not,
    ),
  );

  it('enfile les connecteurs échus (ou jamais synchronisés), ignore non échus et inactifs', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const res = await runConnectorTick({
      prisma: { gedSourceConnector: { findMany } } as never,
      syncQueue: { add },
      now: () => NOW,
    });
    expect(res).toEqual({ enqueued: 3 });
    expect(add.mock.calls.map((c) => c[1].connectorId)).toEqual([1, 3, 7]);
    expect(add).toHaveBeenCalledWith(
      'sync',
      { connectorId: 1, trigger: 'schedule', requestedBy: null },
      { jobId: 'ged-sync-1', removeOnComplete: true, removeOnFail: true },
    );
  });

  it('le processeur route `tick` et `sync`, et refuse un autre nom', async () => {
    const add = jest.fn();
    const processor = createConnectorSyncProcessor({
      prisma: { gedSourceConnector: { findMany: jest.fn().mockResolvedValue([]) } } as never,
      fileStore: { write: jest.fn() },
      archivesPath: '/coffre',
      aiQueue: null,
      syncQueue: { add },
    });
    expect(await processor({ name: 'tick', data: undefined as never })).toEqual({ enqueued: 0 });
    await expect(processor({ name: 'autre', data: undefined as never })).rejects.toThrow(/inconnu/);
  });
});

describe('createAiEnqueuer', () => {
  const settingRow = (mode: number) => ({
    mode,
    provider: null,
    model: 'm',
    endpoint: 'http://localhost:11434/v1',
    apiKeyRef: null,
    maskingEnabled: true,
    autoApplyThreshold: null,
    timeoutSeconds: 60,
  });

  it('IA activée : job `pipeline` avec les options de l’API', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const enqueue = createAiEnqueuer({
      prisma: {
        gedAiSetting: { findFirst: jest.fn().mockResolvedValue(settingRow(GedAiMode.Locale)) },
      } as never,
      queue: { add },
      env: {},
    });
    await enqueue(42, 7);
    expect(add).toHaveBeenCalledWith(
      'pipeline',
      { documentId: 42, sourceItemId: 7, requestedBy: null },
      { removeOnComplete: 1000, removeOnFail: 1000 },
    );
  });

  it('IA désactivée (mode 0 ou aucune ligne) : rien n’est enfilé', async () => {
    const add = jest.fn();
    for (const row of [settingRow(GedAiMode.Desactivee), null]) {
      const enqueue = createAiEnqueuer({
        prisma: { gedAiSetting: { findFirst: jest.fn().mockResolvedValue(row) } } as never,
        queue: { add },
        env: {},
      });
      await enqueue(1, 1);
    }
    expect(add).not.toHaveBeenCalled();
  });
});

describe('createPrismaSyncStore', () => {
  it('findDuplicateOriginal : copié/indexé seulement, hors élément courant, le plus ancien d’abord', async () => {
    const findFirst = jest.fn().mockResolvedValue({ gedSourceItemId: 3n });
    const store = createPrismaSyncStore({ gedSourceItem: { findFirst } } as never);
    expect(await store.findDuplicateOriginal('abc', 9n)).toEqual({ id: 3n });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contentHash: 'abc',
          gedSourceItemId: { not: 9n },
          state: { in: [1, 2] },
        },
        orderBy: [{ firstSeenAt: 'asc' }, { gedSourceItemId: 'asc' }],
      }),
    );
  });

  it('markDeleted : état 4 seulement, aucune suppression de document', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const document = { delete: jest.fn(), deleteMany: jest.fn() };
    const store = createPrismaSyncStore({ gedSourceItem: { updateMany }, document } as never);
    expect(await store.markDeleted(1, ['a', 'b'])).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { connectorId: 1, externalId: { in: ['a', 'b'] }, state: { not: 4 } },
      data: { state: 4 },
    });
    expect(document.delete).not.toHaveBeenCalled();
    expect(document.deleteMany).not.toHaveBeenCalled();
  });

  it('upsertItem n’écrit pas remoteVersion et laisse originAcl intacte quand elle est absente', async () => {
    const upsert = jest.fn().mockResolvedValue({
      gedSourceItemId: 1n,
      externalId: 'a',
      state: 0,
      documentId: null,
      contentHash: null,
      remoteVersion: null,
      duplicateOfId: null,
    });
    const store = createPrismaSyncStore({ gedSourceItem: { upsert } } as never);
    const base = {
      name: 'a.txt',
      originUrl: null,
      originPath: null,
      mimeType: null,
      byteLength: 12,
      originAuthor: null,
      originCreatedAt: null,
      originModifiedAt: null,
      originMetadata: null,
    };
    await store.upsertItem(1, 'a', base, NOW);
    const call = upsert.mock.calls[0]![0];
    expect(call.update).not.toHaveProperty('remoteVersion');
    expect(call.update).not.toHaveProperty('originAcl');
    expect(call.create).not.toHaveProperty('remoteVersion');
    expect(call.update.byteLength).toBe(12n);

    await store.upsertItem(1, 'a', { ...base, originAcl: { entries: [] } }, NOW);
    expect(upsert.mock.calls[1]![0].update.originAcl).toEqual({ entries: [] });
  });
});

describe('runSyncJob', () => {
  const baseRecord = {
    gedSourceConnectorId: 1,
    label: 'Test',
    connectorType: 'fake',
    mode: 0,
    status: 1,
    config: null,
    credentialsEnc: null,
    credentialsKeyId: null,
    credentialsRef: null,
    changeToken: null,
    targetDossierId: null,
    isActive: true,
  };

  function fakeRegistry(connector: Partial<SourceConnector> = {}, seen: { ctx?: any } = {}) {
    const registry = new ConnectorRegistry();
    const def: ConnectorDefinition = {
      type: 'fake',
      label: 'Fake',
      description: 'test',
      supportedModes: [0, 1, 2],
      configFields: [],
      credentialFields: [],
      configSchema: z.object({}).passthrough(),
      credentialsSchema: z.record(z.string()),
      assertConfigSafe: async () => undefined,
      create: (ctx) => {
        seen.ctx = ctx;
        return {
          type: 'fake',
          authenticate: async () => undefined,
          listChanges: async () => ({
            items: [],
            deletedExternalIds: [],
            nextToken: 'n1',
            hasMore: false,
          }),
          fetchFile: async () => ({ bytes: Buffer.alloc(0) }),
          readOriginAcl: async () => null,
          close: jest.fn().mockResolvedValue(undefined),
          ...connector,
        } as SourceConnector;
      },
    };
    registry.register(def);
    return registry;
  }

  function fakePrisma(record: Record<string, unknown> | null) {
    return {
      gedSourceConnector: {
        findUnique: jest.fn().mockResolvedValue(record),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
      },
      gedSourceSyncRun: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ gedSourceSyncRunId: 77n }),
        update: jest.fn().mockResolvedValue({}),
      },
      gedSourceItem: {},
      gedAiSetting: { findFirst: jest.fn().mockResolvedValue(null) },
    };
  }
  const common = (prisma: unknown, registry: ConnectorRegistry, env: NodeJS.ProcessEnv = {}) => ({
    prisma: prisma as never,
    fileStore: { write: jest.fn() },
    archivesPath: '/coffre',
    aiQueue: null,
    syncQueue: { add: jest.fn() },
    registry,
    env,
    now: () => NOW,
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });

  it('passe de bout en bout : identifiants par référence, env filtré, connecteur fermé, jeton persisté', async () => {
    const prisma = fakePrisma(baseRecord);
    const seen: { ctx?: any } = {};
    const close = jest.fn().mockResolvedValue(undefined);
    const registry = fakeRegistry({ close }, seen);
    const env = {
      GED_CONNECTOR_SECRET_DEMO: JSON.stringify({ password: 'unMotDePasse!' }),
      GED_CONNECTOR_FS_ROOTS: '/srv/depot',
      JWT_SECRET: 'ne-doit-pas-fuiter',
    };
    prisma.gedSourceConnector.findUnique.mockResolvedValue({
      ...baseRecord,
      credentialsRef: 'GED_CONNECTOR_SECRET_DEMO',
    });
    const res = await runSyncJob(
      { connectorId: 1, trigger: 'manual' },
      common(prisma, registry, env),
    );
    expect(res).toMatchObject({ status: 1 });
    expect(seen.ctx.credentials).toEqual({ password: 'unMotDePasse!' });
    expect(seen.ctx.deps.env).toEqual({
      GED_CONNECTOR_FS_ROOTS: '/srv/depot',
      GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS: undefined,
      ARCHIVES_PATH: '/coffre',
    });
    expect(JSON.stringify(seen.ctx.deps.env)).not.toContain('ne-doit-pas-fuiter');
    expect(close).toHaveBeenCalledTimes(1);
    expect(prisma.gedSourceConnector.update).toHaveBeenCalledWith({
      where: { gedSourceConnectorId: 1 },
      data: { changeToken: 'n1' },
    });
  });

  it('identifiants chiffrés déchiffrés avec le trousseau de l’environnement', async () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const env = { GED_CONNECTOR_KEY: key, GED_CONNECTOR_KEY_ID: 'k1' };
    const enc = encryptCredentials({ token: 'jeton-secret-1234' }, loadKeyRing(env));
    const prisma = fakePrisma({ ...baseRecord, ...enc });
    const seen: { ctx?: any } = {};
    await runSyncJob(
      { connectorId: 1, trigger: 'manual' },
      common(prisma, fakeRegistry({}, seen), env),
    );
    expect(seen.ctx.credentials).toEqual({ token: 'jeton-secret-1234' });
  });

  it('clé absente avec identifiants chiffrés : erreur claire, connecteur en erreur, moteur non lancé', async () => {
    const prisma = fakePrisma({ ...baseRecord, credentialsEnc: 'AAAA', credentialsKeyId: 'k1' });
    const res = await runSyncJob(
      { connectorId: 1, trigger: 'manual' },
      common(prisma, fakeRegistry(), {}),
    );
    expect(res).toMatchObject({ skipped: 'setup_error' });
    expect(prisma.gedSourceConnector.update).toHaveBeenCalledWith({
      where: { gedSourceConnectorId: 1 },
      data: expect.objectContaining({
        status: 2,
        lastError: expect.stringContaining('GED_CONNECTOR_KEY absente'),
      }),
    });
    expect(prisma.gedSourceSyncRun.create).not.toHaveBeenCalled();
  });

  it('connecteur inactif ou désactivé : refusé sans toucher à la base', async () => {
    for (const patch of [{ isActive: false }, { status: 0 }]) {
      const prisma = fakePrisma({ ...baseRecord, ...patch });
      const res = await runSyncJob(
        { connectorId: 1, trigger: 'manual' },
        common(prisma, fakeRegistry()),
      );
      expect(res).toEqual({ skipped: 'inactive' });
      expect(prisma.gedSourceConnector.update).not.toHaveBeenCalled();
      expect(prisma.gedSourceSyncRun.create).not.toHaveBeenCalled();
    }
  });

  it('type absent du registre : refusé, connecteur en erreur', async () => {
    const prisma = fakePrisma({ ...baseRecord, connectorType: 'inconnu' });
    const res = await runSyncJob(
      { connectorId: 1, trigger: 'manual' },
      common(prisma, fakeRegistry()),
    );
    expect(res).toMatchObject({ skipped: 'unknown_connector' });
    expect(prisma.gedSourceConnector.update).toHaveBeenCalledWith({
      where: { gedSourceConnectorId: 1 },
      data: expect.objectContaining({ status: 2 }),
    });
  });

  it('connecteur introuvable ou identifiant invalide : le job échoue', async () => {
    await expect(
      runSyncJob({ connectorId: 1, trigger: 'manual' }, common(fakePrisma(null), fakeRegistry())),
    ).rejects.toThrow(/introuvable/);
    await expect(
      runSyncJob({ connectorId: 0, trigger: 'manual' }, common(fakePrisma(null), fakeRegistry())),
    ).rejects.toThrow(/invalide/);
  });

  it('reprise planifiée : jobId propre, délai transmis, nettoyage automatique', async () => {
    const { ConnectorQuotaError } = jest.requireActual('@archivage/connectors');
    const prisma = fakePrisma(baseRecord);
    const deps = common(
      prisma,
      fakeRegistry({
        listChanges: async () => {
          throw new ConnectorQuotaError('429', 120_000);
        },
      }),
    );
    await runSyncJob({ connectorId: 1, trigger: 'schedule' }, deps);
    expect(deps.syncQueue.add).toHaveBeenCalledWith(
      'sync',
      { connectorId: 1, trigger: 'schedule', requestedBy: null },
      {
        jobId: `ged-sync-resume-1-${NOW.getTime()}`,
        delay: 120_000,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });
});
