import { GED_GOVERNANCE_BATCH_SIZE, GED_GOVERNANCE_JOBS } from '@archivage/types';
import {
  createGovernanceProcessor,
  governanceAllJobId,
  type GovernanceProcessorDeps,
} from './governance.processor';

function build(
  opts: {
    pages?: Record<number, number[]>;
    failOn?: number[];
    skipOn?: number[];
    batchSize?: number;
  } = {},
) {
  const analyzed: number[] = [];
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const list = jest.fn(async ({ afterId, limit }: { afterId: number; limit: number }) =>
    (opts.pages?.[afterId] ?? []).slice(0, limit),
  );
  const deps: GovernanceProcessorDeps = {
    analyze: jest.fn(async (id: number) => {
      analyzed.push(id);
      if (opts.failOn?.includes(id)) throw new Error('détail interne avec jean.dupont@example.com');
      if (opts.skipOn?.includes(id)) return { documentId: id, aiDisabled: false, skipped: 'not_analyzable' as const, created: [] };
      return { documentId: id, aiDisabled: false, created: [{ kind: 'pii' as const, decisionId: `d${id}` }] };
    }),
    listAnalyzableDocumentIds: list,
    queue,
    batchSize: opts.batchSize,
    log: {
      info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    },
  };
  const handler = createGovernanceProcessor(deps);
  const run = (name: string, data: unknown) => handler({ name, data } as never);
  return { run, deps, analyzed, logs, queue, list };
}

describe('analyze-document', () => {
  it('délègue au moteur avec requestedBy', async () => {
    const h = build();
    const res = await h.run(GED_GOVERNANCE_JOBS.analyzeDocument, { documentId: 12, requestedBy: 4 });
    expect(res).toMatchObject({ documentId: 12 });
    expect(h.deps.analyze).toHaveBeenCalledWith(12, 4);
  });
  it('documentId invalide : erreur claire', async () => {
    const h = build();
    await expect(h.run(GED_GOVERNANCE_JOBS.analyzeDocument, { documentId: 'x' })).rejects.toThrow(/documentId invalide/);
  });
});

describe('analyze-batch scope documents', () => {
  it('analyse séquentielle ; une erreur est consignée (message sûr) et n’arrête pas le lot', async () => {
    const h = build({ failOn: [2], skipOn: [3] });
    const res = await h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'documents', documentIds: [1, 2, 3, 3, 4] });
    expect(h.analyzed).toEqual([1, 2, 3, 4]);
    expect(res).toEqual({
      batch: true,
      scope: 'documents',
      processed: 4,
      skipped: 1,
      errors: 1,
      created: 2,
      nextAfterDocumentId: null,
    });
    const warn = h.logs.find((l) => l.level === 'warn')!;
    expect(warn.obj).toEqual({ documentId: 2, error: 'Erreur inattendue pendant le traitement de gouvernance.' });
    expect(JSON.stringify(h.logs)).not.toContain('jean.dupont');
    expect(h.queue.add).not.toHaveBeenCalled();
  });
  it('liste invalide : erreur claire', async () => {
    const h = build();
    await expect(h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'documents', documentIds: [1, -2] })).rejects.toThrow(/documentIds invalide/);
  });
});

describe('analyze-batch scope all', () => {
  it('une page de GED_GOVERNANCE_BATCH_SIZE puis ré-enfile le job suivant (jobId stable)', async () => {
    const ids = Array.from({ length: GED_GOVERNANCE_BATCH_SIZE + 1 }, (_, i) => i + 1);
    const h = build({ pages: { 0: ids } });
    const res = await h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'all', requestedBy: 9 });
    expect(h.list).toHaveBeenCalledWith({ afterId: 0, limit: GED_GOVERNANCE_BATCH_SIZE + 1 });
    expect(h.analyzed).toHaveLength(GED_GOVERNANCE_BATCH_SIZE);
    expect(res).toMatchObject({ scope: 'all', processed: GED_GOVERNANCE_BATCH_SIZE, nextAfterDocumentId: GED_GOVERNANCE_BATCH_SIZE });
    expect(h.queue.add).toHaveBeenCalledWith(
      GED_GOVERNANCE_JOBS.analyzeBatch,
      { scope: 'all', afterDocumentId: GED_GOVERNANCE_BATCH_SIZE, requestedBy: 9 },
      { jobId: governanceAllJobId(GED_GOVERNANCE_BATCH_SIZE), removeOnComplete: true, removeOnFail: true },
    );
    expect(governanceAllJobId(50)).toBe('governance-all-50');
  });

  it('dernière page : pas de job suivant', async () => {
    const h = build({ pages: { 50: [51, 52] } });
    const res = await h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'all', afterDocumentId: 50 });
    expect(h.analyzed).toEqual([51, 52]);
    expect(res).toMatchObject({ processed: 2, nextAfterDocumentId: null });
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('page exactement pleine sans suite : aucun job vide ré-enfilé', async () => {
    const h = build({ pages: { 0: [1, 2, 3] }, batchSize: 3 });
    const res = await h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'all' });
    expect(res).toMatchObject({ processed: 3, nextAfterDocumentId: null });
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('une erreur sur un document n’empêche ni la page ni le job suivant', async () => {
    const h = build({ pages: { 0: [1, 2, 3, 4] }, batchSize: 3, failOn: [1] });
    const res = await h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'all' });
    expect(res).toMatchObject({ processed: 3, errors: 1, nextAfterDocumentId: 3 });
    expect(h.queue.add).toHaveBeenCalledTimes(1);
  });

  it('logs : compteurs et identifiants seulement', async () => {
    const h = build({ pages: { 0: [1, 2] } });
    await h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'all' });
    const info = h.logs.find((l) => l.level === 'info')!;
    expect(Object.keys(info.obj).sort()).toEqual(
      ['afterDocumentId', 'created', 'errors', 'nextAfterDocumentId', 'processed', 'scope', 'skipped'].sort(),
    );
  });
});

describe('jobs inconnus', () => {
  it('nom inconnu : erreur claire', async () => {
    const h = build();
    await expect(h.run('autre-chose', {})).rejects.toThrow('Job de gouvernance inconnu : autre-chose');
  });
  it('portée inconnue : erreur claire', async () => {
    const h = build();
    await expect(h.run(GED_GOVERNANCE_JOBS.analyzeBatch, { scope: 'x' })).rejects.toThrow(/portée inconnue/);
  });
});
