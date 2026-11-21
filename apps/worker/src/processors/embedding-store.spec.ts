import type { Prisma } from '@prisma/client';
import { GED_EMBEDDING_DIMENSION } from '@archivage/types';
import { chunkText } from './embedding-chunker';
import {
  CHUNK_INSERT_BATCH,
  deleteDocumentChunks,
  listIndexableDocumentIds,
  listStaleDocumentIds,
  replaceDocumentChunks,
  toVectorLiteral,
} from './embedding-store';

const vec = (seed = 0.5) =>
  Array.from({ length: GED_EMBEDDING_DIMENSION }, (_, i) => seed + i / 1e4);

function harness() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const order: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      calls.push({ sql: q.text, values: q.values });
      return 1;
    }),
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>, _opts?: unknown) => {
      order.push('begin');
      const r = await fn(tx);
      order.push('commit');
      return r;
    }),
  };
  return { prisma: prisma as never, calls, order, tx, transaction: prisma.$transaction };
}

describe('toVectorLiteral', () => {
  it('littéral [x,y,...] à 1024 valeurs', () => {
    const lit = toVectorLiteral(vec());
    expect(lit.startsWith('[')).toBe(true);
    expect(lit.endsWith(']')).toBe(true);
    expect(lit.slice(1, -1).split(',')).toHaveLength(1024);
  });
  it('refuse mauvaise dimension et valeurs non finies', () => {
    expect(() => toVectorLiteral([1, 2])).toThrow(/dimension/);
    const bad = vec();
    bad[3] = Number.NaN;
    expect(() => toVectorLiteral(bad)).toThrow(/non finie/);
  });
});

describe('replaceDocumentChunks', () => {
  const chunks = chunkText([{ page: 2, text: 'Un texte. Et un autre texte à indexer.' }]);
  const base = { documentId: 1, versionId: 1, model: 'm' };

  it('R2 : la transaction reçoit des délais généreux (maxWait, timeout)', async () => {
    const h = harness();
    await replaceDocumentChunks(h.prisma, { ...base, chunks, vectors: [vec()] });
    const opts = h.transaction.mock.calls[0]![1] as { maxWait: number; timeout: number };
    expect(opts.maxWait).toBeGreaterThanOrEqual(30_000);
    expect(opts.timeout).toBeGreaterThanOrEqual(60_000);
  });

  it('DELETE puis INSERT dans la même transaction, paramètres liés', async () => {
    const h = harness();
    await replaceDocumentChunks(h.prisma, {
      documentId: 7,
      versionId: 11,
      model: 'bge-m3',
      chunks,
      vectors: [vec()],
    });
    expect(h.order).toEqual(['begin', 'commit']);
    expect(h.calls).toHaveLength(2);
    const [del, ins] = h.calls;
    expect(del!.sql).toBe('DELETE FROM ged_document_chunk WHERE document_id = $1');
    expect(del!.values).toEqual([7]);
    expect(ins!.sql).toContain(
      'INSERT INTO ged_document_chunk (document_id, document_version_id, chunk_index, content, content_hash, token_count, page_from, page_to, embedding, embedding_model) VALUES',
    );
    expect(ins!.sql).toContain('$9::vector');
    expect(ins!.sql).not.toContain(chunks[0]!.content); // aucun contenu concaténé
    expect(ins!.values).toEqual([
      7,
      11,
      0,
      chunks[0]!.content,
      chunks[0]!.contentHash,
      chunks[0]!.tokenCount,
      2,
      2,
      toVectorLiteral(vec()),
      'bge-m3',
    ]);
  });

  it('insertion par lots de CHUNK_INSERT_BATCH', async () => {
    const h = harness();
    const many = Array.from({ length: CHUNK_INSERT_BATCH + 3 }, (_, i) => ({
      ...chunks[0]!,
      chunkIndex: i,
    }));
    await replaceDocumentChunks(h.prisma, { ...base, chunks: many, vectors: many.map(() => vec()) });
    expect(h.calls).toHaveLength(3); // DELETE + 2 INSERT
    expect(h.calls[1]!.values).toHaveLength(CHUNK_INSERT_BATCH * 10);
    expect(h.calls[2]!.values).toHaveLength(30);
  });

  it('vecteur invalide ou nombre incohérent : aucune transaction ouverte', async () => {
    const h = harness();
    await expect(
      replaceDocumentChunks(h.prisma, { ...base, chunks, vectors: [[1, 2, 3]] }),
    ).rejects.toThrow();
    await expect(replaceDocumentChunks(h.prisma, { ...base, chunks, vectors: [] })).rejects.toThrow();
    expect(h.order).toEqual([]);
  });

  it('une erreur d’insertion se propage (la transaction n’est pas validée)', async () => {
    const h = harness();
    h.tx.$executeRaw.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('db'));
    await expect(
      replaceDocumentChunks(h.prisma, { ...base, chunks, vectors: [vec()] }),
    ).rejects.toThrow('db');
    expect(h.order).toEqual(['begin']);
  });
});

describe('deleteDocumentChunks et listings', () => {
  it('DELETE paramétré', async () => {
    const executeRaw = jest.fn().mockResolvedValue(4);
    expect(await deleteDocumentChunks({ $executeRaw: executeRaw } as never, 9)).toBe(4);
    const q = executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(q.text).toBe('DELETE FROM ged_document_chunk WHERE document_id = $1');
    expect(q.values).toEqual([9]);
  });

  it('listIndexableDocumentIds : curseur et limite liés, ids convertis en nombres', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ documentId: 3 }, { documentId: 5n }]);
    const ids = await listIndexableDocumentIds({ $queryRaw: queryRaw } as never, {
      afterId: 2,
      limit: 500,
    });
    expect(ids).toEqual([3, 5]);
    const q = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(q.text).toContain('d.is_archived = true AND d.document_state <> 3 AND d.is_frozen = false');
    expect(q.values).toEqual([2, 500]);
  });

  it('listStaleDocumentIds : modèle et limite liés', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await listStaleDocumentIds({ $queryRaw: queryRaw } as never, { model: 'bge-m3', limit: 200 });
    const q = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(q.values).toEqual(['bge-m3', 200]);
    expect(q.text).toContain('IS DISTINCT FROM v.document_version_id');
    expect(q.text).toContain('d.modified_at >');
  });
});
