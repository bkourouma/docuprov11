import type { Prisma } from '@prisma/client';
import {
  findEmbeddingNeighbours,
  findExactDuplicates,
  findTitleCandidates,
  listActiveConfidentialiteLevels,
  listAnalyzableDocumentIds,
  listExistingProposals,
  loadGovernanceDocument,
} from './governance-store';
import { createGovernanceEngineDeps } from './governance.processor';

// Faux Prisma : on vérifie la FORME des requêtes (paramètres liés, pas de concaténation, tables visées).
// Leur exécution réelle (pgvector, array_agg, LATERAL) exige PostgreSQL : non vérifiable ici.
function fakePrisma(rowsByCall: unknown[][] = []) {
  const queue = [...rowsByCall];
  const sqls: Array<{ text: string; values: unknown[] }> = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      sqls.push({ text: q.text, values: q.values });
      return queue.shift() ?? [];
    }),
    document: { findUnique: jest.fn(), findMany: jest.fn() },
    confidentialite: { findMany: jest.fn() },
    gedAiDecision: { findMany: jest.fn() },
    gedAiSetting: { findFirst: jest.fn().mockResolvedValue(null) },
    gedAiMaskingRule: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { prisma, sqls };
}

// Faux Prisma transactionnel : `$transaction(fn)` exécute fn avec un client `tx` ; `events` garde l'ordre.
function fakeTxPrisma(opts: { rowsByCall: unknown[][]; hnsw: string | null }) {
  const queue = [...opts.rowsByCall];
  const events: Array<{ via: 'root' | 'tx'; kind: 'query' | 'exec'; text: string; values: unknown[] }> = [];
  const mk = (via: 'root' | 'tx') => ({
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      events.push({ via, kind: 'query', text: q.text, values: q.values });
      if (q.text.includes('current_setting')) return [{ value: opts.hnsw }];
      if (q.text.includes("'[1]'::vector")) return [{}];
      return queue.shift() ?? [];
    }),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      events.push({ via, kind: 'exec', text: q.text, values: q.values });
      return 0;
    }),
  });
  const tx = mk('tx');
  const prisma = {
    ...mk('root'),
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, events };
}

describe('findExactDuplicates', () => {
  it('deux requêtes paramétrées (file_hash puis source_hash), ensembles complets et égaux', async () => {
    const d = new Date('2020-01-01T00:00:00Z');
    const { prisma, sqls } = fakePrisma([[{ documentId: 2, createdAt: d }], [{ documentId: 3, createdAt: d }]]);
    const res = await findExactDuplicates(prisma as never, 42);
    expect(res).toEqual([
      { documentId: 2, createdAt: d, method: 'file_hash' },
      { documentId: 3, createdAt: d, method: 'source_hash' },
    ]);
    expect(sqls).toHaveLength(2);
    const [files, sources] = sqls;
    expect(files!.text).toContain('document_file');
    expect(files!.text).toContain('is_current = true');
    expect(files!.text).toContain('array_agg(DISTINCT f.hash ORDER BY f.hash)');
    expect(files!.text).toContain('s.hashes = m.hashes');
    expect(files!.text).toContain('s.complete');
    expect(files!.text).toContain('d.is_archived = true AND d.document_state <> 3');
    expect(files!.values).toContain(42);
    expect(sources!.text).toContain('ged_source_item');
    expect(sources!.text).toContain('array_agg(DISTINCT i.content_hash ORDER BY i.content_hash)');
    expect(sources!.text).toContain('s.hashes = m.hashes');
    expect(sources!.values).toContain(42);
    // Aucune valeur n'est concaténée dans le texte SQL.
    for (const q of sqls) expect(q.text).not.toContain('42');
  });
});

describe('findEmbeddingNeighbours', () => {
  it('sans segment : une seule requête, aucun voisin', async () => {
    const { prisma, sqls } = fakePrisma([[]]);
    expect(await findEmbeddingNeighbours(prisma as never, 5)).toEqual([]);
    expect(sqls).toHaveLength(1);
  });

  it('deux temps : échantillon, 50 voisins LATERAL du même modèle, cosinus entre centroïdes', async () => {
    const d = new Date('2021-01-01T00:00:00Z');
    const { prisma, sqls } = fakePrisma([
      [
        { chunkId: 11n, model: 'emb-1' },
        { chunkId: 15, model: 'emb-1' },
        { chunkId: 19n, model: 'emb-1' },
      ],
      [{ documentId: 8 }, { documentId: 9 }],
      [{ documentId: 8, createdAt: d, similarity: 0.97 }],
    ]);
    const res = await findEmbeddingNeighbours(prisma as never, 5);
    expect(res).toEqual([{ documentId: 8, createdAt: d, similarity: 0.97, embeddingModel: 'emb-1' }]);
    expect(sqls).toHaveLength(3);
    expect(sqls[0]!.text).toContain('row_number()');
    expect(sqls[1]!.text).toContain('CROSS JOIN LATERAL');
    expect(sqls[1]!.text).toContain('c.embedding <=> s.embedding');
    expect(sqls[1]!.text).toContain('c.embedding_model = $');
    expect(sqls[1]!.values).toEqual(expect.arrayContaining(['emb-1', 5, 50, 11n, 15n, 19n]));
    expect(sqls[2]!.text).toContain('avg(embedding)');
    expect(sqls[2]!.text).toContain('avg(c.embedding)');
    expect(sqls[2]!.text).toContain('cand.centroid <=> mine.centroid');
    expect(sqls[2]!.values).toEqual(expect.arrayContaining([5, 8, 9, 'emb-1']));
    for (const q of sqls) {
      expect(q.text).not.toContain('emb-1');
    }
  });

  it('aucun candidat : pas de troisième requête', async () => {
    const { prisma, sqls } = fakePrisma([[{ chunkId: 1, model: 'm' }], []]);
    expect(await findEmbeddingNeighbours(prisma as never, 5)).toEqual([]);
    expect(sqls).toHaveLength(2);
  });
});

describe('findEmbeddingNeighbours : hnsw.iterative_scan', () => {
  const sample = [{ chunkId: 11n, model: 'emb-1' }];

  it('SET LOCAL émis dans la même transaction, après la vérification, avant la requête de voisins', async () => {
    const { prisma, events } = fakeTxPrisma({ rowsByCall: [sample, [{ documentId: 8 }], []], hnsw: 'off' });
    await findEmbeddingNeighbours(prisma as never, 5);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const tx = events.filter((e) => e.via === 'tx');
    expect(tx).toHaveLength(4);
    expect(tx[0]!.text).toContain("'[1]'::vector");
    expect(tx[1]!.text).toContain("current_setting('hnsw.iterative_scan', true)");
    expect(tx[2]!.kind).toBe('exec');
    expect(tx[2]!.text).toContain('SET LOCAL hnsw.iterative_scan = relaxed_order');
    expect(tx[2]!.values).toEqual([]);
    expect(tx[3]!.text).toContain('CROSS JOIN LATERAL');
    expect(tx[3]!.values).toEqual(expect.arrayContaining(['emb-1', 5, 50, 11n]));
    // l'échantillon reste hors transaction
    expect(events.filter((e) => e.via === 'root').length).toBeGreaterThanOrEqual(1);
    for (const e of events) expect(e.text).not.toContain('emb-1');
  });

  it('réglage absent (pgvector < 0.8) : aucun SET LOCAL, la requête de voisins est quand même exécutée', async () => {
    const { prisma, events } = fakeTxPrisma({ rowsByCall: [sample, [{ documentId: 8 }], []], hnsw: null });
    await findEmbeddingNeighbours(prisma as never, 5);
    expect(events.some((e) => e.kind === 'exec')).toBe(false);
    expect(events.some((e) => e.text.includes('CROSS JOIN LATERAL'))).toBe(true);
  });

  it('sans segment : aucune transaction', async () => {
    const { prisma } = fakeTxPrisma({ rowsByCall: [[]], hnsw: 'off' });
    expect(await findEmbeddingNeighbours(prisma as never, 5)).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('findTitleCandidates', () => {
  it('même type, même date, plafonné, paramètres liés', async () => {
    const d = new Date('2021-01-01T00:00:00Z');
    const { prisma, sqls } = fakePrisma([[{ documentId: 2, label: 'Facture', createdAt: d }]]);
    const res = await findTitleCandidates(prisma as never, 1, { documentTypeId: 4, documentDate: '2026-03-01', limit: 200 });
    expect(res).toEqual([{ documentId: 2, label: 'Facture', createdAt: d }]);
    const q = sqls[0]!;
    expect(q.text).toContain('d.document_type_id = $');
    expect(q.text).toContain('d.document_date = $');
    expect(q.text).toContain('::date');
    expect(q.text).toContain('LIMIT $');
    expect(q.values).toEqual(expect.arrayContaining([1, 4, '2026-03-01', 200]));
    expect(q.text).not.toContain('2026-03-01');
  });
});

describe('lectures Prisma', () => {
  it('loadGovernanceDocument : version courante, rang de confidentialité, date AAAA-MM-JJ', async () => {
    const { prisma } = fakePrisma();
    prisma.document.findUnique.mockResolvedValue({
      documentId: 3,
      label: 'L',
      documentTypeId: 2,
      documentDate: new Date('2026-03-15T00:00:00Z'),
      isArchived: true,
      documentState: 1,
      confidentialiteId: 5,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      confidentialite: { rank: 2 },
      versions: [{ files: [{ ocrText: 'a' }, { ocrText: null }] }],
    });
    const doc = await loadGovernanceDocument(prisma as never, 3);
    expect(doc).toMatchObject({ documentDate: '2026-03-15', confidentialiteRank: 2, ocrTexts: ['a', null] });
    expect(prisma.document.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: 3 } }),
    );
    const args = prisma.document.findUnique.mock.calls[0]![0] as { select: { versions: { where: unknown } } };
    expect(args.select.versions.where).toEqual({ isCurrent: true });
    prisma.document.findUnique.mockResolvedValue(null);
    expect(await loadGovernanceDocument(prisma as never, 4)).toBeNull();
  });

  it('niveaux actifs uniquement', async () => {
    const { prisma } = fakePrisma();
    prisma.confidentialite.findMany.mockResolvedValue([{ confidentialiteId: 1, label: 'P', rank: 0 }]);
    expect(await listActiveConfidentialiteLevels(prisma as never)).toEqual([{ confidentialiteId: 1, label: 'P', rank: 0 }]);
    expect(prisma.confidentialite.findMany.mock.calls[0]![0]).toMatchObject({ where: { isActive: true } });
  });

  it('propositions existantes : version de gabarit, statuts 0..3, jamais les erreurs', async () => {
    const { prisma } = fakePrisma();
    prisma.gedAiDecision.findMany.mockResolvedValue([{ documentId: 1, status: 0, output: { kind: 'pii' } }]);
    expect(await listExistingProposals(prisma as never, [])).toEqual([]);
    expect(prisma.gedAiDecision.findMany).not.toHaveBeenCalled();
    const res = await listExistingProposals(prisma as never, [1, 2]);
    expect(res).toEqual([{ documentId: 1, status: 0, output: { kind: 'pii' } }]);
    const where = (prisma.gedAiDecision.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ promptVersion: 'ged-governance-v1', documentId: { in: [1, 2] } });
    expect(where.status).toEqual({ in: [0, 1, 2, 3] });
  });

  it('page des documents analysables : archivés, non épurés, curseur croissant', async () => {
    const { prisma } = fakePrisma();
    prisma.document.findMany.mockResolvedValue([{ documentId: 6 }, { documentId: 9 }]);
    expect(await listAnalyzableDocumentIds(prisma as never, { afterId: 5, limit: 51 })).toEqual([6, 9]);
    expect(prisma.document.findMany.mock.calls[0]![0]).toMatchObject({
      where: { isArchived: true, documentState: { not: 3 }, documentId: { gt: 5 } },
      orderBy: { documentId: 'asc' },
      take: 51,
    });
  });
});

describe('mode IA coupé de bout en bout', () => {
  it('aucune requête sur ged_document_chunk', async () => {
    const { prisma, sqls } = fakePrisma();
    prisma.document.findUnique.mockResolvedValue({
      documentId: 3,
      label: 'L',
      documentTypeId: 2,
      documentDate: new Date('2026-03-15T00:00:00Z'),
      isArchived: true,
      documentState: 1,
      confidentialiteId: null,
      createdAt: new Date('2020-01-01T00:00:00Z'),
      confidentialite: null,
      versions: [{ files: [] }],
    });
    const { analyzeDocument } = await import('./governance-engine');
    const deps = createGovernanceEngineDeps(prisma as never, {});
    const res = await analyzeDocument(3, deps, {});
    expect(res.aiDisabled).toBe(true);
    expect(sqls.length).toBeGreaterThan(0);
    for (const q of sqls) expect(q.text).not.toContain('ged_document_chunk');
  });
});
