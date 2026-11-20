import type { Job } from 'bullmq';
import type { Prisma } from '@prisma/client';
import {
  GED_AI_DISABLED_MESSAGE,
  GED_EMBEDDING_DIMENSION,
  GED_EMBEDDING_JOBS,
  GedAiMode,
  type GedEmbeddingJobData,
} from '@archivage/types';
import type { EffectiveAiConfig } from './ai-config';
import type { Embedder, EmbeddingSetup } from './embedding-provider';
import {
  createEmbeddingProcessor,
  EMBEDDING_REINDEX_PAGE,
  EMBEDDING_SWEEP_LIMIT,
  reindexJobId,
} from './embedding-processor';

const config = (mode: number): EffectiveAiConfig => ({
  mode: mode as never,
  provider: 'openai',
  model: 'm',
  endpoint: 'https://api.example.com/v1',
  apiKey: 'k',
  maskingEnabled: true,
  threshold: null,
  timeoutSeconds: 30,
});
const ON: EmbeddingSetup = { config: config(GedAiMode.Cloud), model: 'emb-1', dimension: 1024 };
const OFF: EmbeddingSetup = { config: config(GedAiMode.Desactivee), model: '', dimension: 1024 };

const SECRET_TEXT = 'Texte confidentiel du document qui ne doit jamais etre journalise.';
const vec = () => Array.from({ length: GED_EMBEDDING_DIMENSION }, () => 0.1);

interface DocRow {
  isArchived: boolean;
  isFrozen: boolean;
  documentState: number;
  versions: Array<{
    documentVersionId: number;
    versionNumber: number;
    files: Array<{ ocrText: string | null; pageCount: number | null }>;
  }>;
}
const goodDoc = (over: Partial<DocRow> = {}): DocRow => ({
  isArchived: true,
  isFrozen: false,
  documentState: 1,
  versions: [
    {
      documentVersionId: 55,
      versionNumber: 3,
      files: [{ ocrText: SECRET_TEXT, pageCount: 1 }],
    },
  ],
  ...over,
});

function build(opts: { setup?: EmbeddingSetup; doc?: DocRow | null; queryRows?: unknown[][] } = {}) {
  const sqls: Array<{ sql: string; values: unknown[] }> = [];
  const order: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      sqls.push({ sql: q.text, values: q.values });
      order.push(q.text.startsWith('DELETE') ? 'tx-delete' : 'tx-insert');
      return 1;
    }),
  };
  const queryRows = [...(opts.queryRows ?? [])];
  const prisma = {
    document: { findUnique: jest.fn().mockResolvedValue(opts.doc === undefined ? goodDoc() : opts.doc) },
    $queryRaw: jest.fn(async (q: Prisma.Sql) => {
      sqls.push({ sql: q.text, values: q.values });
      return queryRows.shift() ?? [];
    }),
    $executeRaw: jest.fn(async (q: Prisma.Sql) => {
      sqls.push({ sql: q.text, values: q.values });
      order.push('delete');
      return 2;
    }),
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      order.push('begin');
      return fn(tx);
    }),
  };
  const embedder = {
    loadSetup: jest.fn().mockResolvedValue(opts.setup ?? ON),
    embed: jest.fn(async (_s: EmbeddingSetup, texts: readonly string[]) => {
      order.push('embed');
      return { disabled: false as const, model: 'emb-1', dimension: 1024, vectors: texts.map(vec) };
    }),
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const log = { info: (obj: Record<string, unknown>, msg: string) => logs.push({ obj, msg }) };
  const handler = createEmbeddingProcessor(prisma as never, {
    embedder: embedder as unknown as Embedder,
    queue,
    log,
  });
  const run = (name: string, data: GedEmbeddingJobData = {}) =>
    handler({ name, data } as unknown as Job<GedEmbeddingJobData>);
  return { prisma, embedder, queue, logs, order, sqls, run };
}

describe('reindex-document', () => {
  it('nominal : segmente, embed, puis remplace les segments dans une transaction', async () => {
    const h = build();
    const res = await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 12 });
    expect(res).toEqual({ disabled: false, documentId: 12, chunks: 1 });
    expect(h.embedder.embed).toHaveBeenCalledWith(ON, [SECRET_TEXT]);
    // la transaction n'est ouverte qu'APRÈS réception des vecteurs
    expect(h.order).toEqual(['embed', 'begin', 'tx-delete', 'tx-insert']);
    const insert = h.sqls.find((s) => s.sql.startsWith('INSERT'))!;
    expect(insert.values.slice(0, 2)).toEqual([12, 55]); // document, version courante
    expect(insert.values[9]).toBe('emb-1');
    expect(h.prisma.document.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: 12 },
        select: expect.objectContaining({
          versions: expect.objectContaining({ where: { isCurrent: true } }),
        }),
      }),
    );
  });

  it('IA désactivée : aucune lecture de document, aucun appel, aucune écriture', async () => {
    const h = build({ setup: OFF });
    const res = await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 1 });
    expect(res).toEqual({ disabled: true, message: GED_AI_DISABLED_MESSAGE });
    expect(h.prisma.document.findUnique).not.toHaveBeenCalled();
    expect(h.embedder.embed).not.toHaveBeenCalled();
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('document introuvable', async () => {
    const h = build({ doc: null });
    expect(await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 9 })).toEqual({
      disabled: false,
      documentId: 9,
      skipped: 'document_not_found',
      chunks: 0,
    });
    expect(h.embedder.embed).not.toHaveBeenCalled();
  });

  it.each([
    ['épuré', { documentState: 3 }],
    ['gelé', { isFrozen: true }],
    ['non archivé', { isArchived: false }],
  ])('document %s : not_indexable et segments supprimés', async (_label, over) => {
    const h = build({ doc: goodDoc(over) });
    const res = await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 4 });
    expect(res).toEqual({ disabled: false, documentId: 4, skipped: 'not_indexable', chunks: 0 });
    expect(h.embedder.embed).not.toHaveBeenCalled();
    expect(h.order).toEqual(['delete']);
    expect(h.sqls[0]).toEqual({
      sql: 'DELETE FROM ged_document_chunk WHERE document_id = $1',
      values: [4],
    });
  });

  it('pas de texte (OCR absent ou blanc) : no_text et segments supprimés', async () => {
    const h = build({
      doc: goodDoc({
        versions: [{ documentVersionId: 1, versionNumber: 1, files: [{ ocrText: '  ', pageCount: 1 }, { ocrText: null, pageCount: 1 }] }],
      }),
    });
    expect(await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 4 })).toEqual({
      disabled: false,
      documentId: 4,
      skipped: 'no_text',
      chunks: 0,
    });
    expect(h.order).toEqual(['delete']);
  });

  it('aucune version courante : no_text', async () => {
    const h = build({ doc: goodDoc({ versions: [] }) });
    expect(await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 4 })).toMatchObject({
      skipped: 'no_text',
    });
  });

  it('échec d’embedding : erreur propagée, anciens segments intacts (aucune écriture)', async () => {
    const h = build();
    h.embedder.embed.mockRejectedValueOnce(new Error('fournisseur HS'));
    await expect(h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 12 })).rejects.toThrow(
      'fournisseur HS',
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('documentId invalide : erreur', async () => {
    const h = build();
    await expect(h.run(GED_EMBEDDING_JOBS.reindexDocument, {})).rejects.toThrow(/documentId/);
    await expect(h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 1.5 })).rejects.toThrow();
  });

  it('journal : compteurs et identifiants seulement, jamais de texte', async () => {
    const h = build();
    await h.run(GED_EMBEDDING_JOBS.reindexDocument, { documentId: 12 });
    expect(JSON.stringify(h.logs)).not.toContain(SECRET_TEXT);
    expect(h.logs.length).toBeGreaterThan(0);
  });

  it('job inconnu : erreur', async () => {
    const h = build();
    await expect(h.run('autre')).rejects.toThrow(/inconnu/);
  });
});

describe('reindex-all', () => {
  it('un job par document, jobId stable sans « : », pagination par curseur', async () => {
    const page1 = Array.from({ length: EMBEDDING_REINDEX_PAGE }, (_, i) => ({ documentId: i + 1 }));
    const h = build({ queryRows: [page1, [{ documentId: EMBEDDING_REINDEX_PAGE + 1 }]] });
    const res = await h.run(GED_EMBEDDING_JOBS.reindexAll, { requestedBy: 3 });
    expect(res).toEqual({ disabled: false, queued: EMBEDDING_REINDEX_PAGE + 1 });
    expect(h.queue.add).toHaveBeenCalledTimes(EMBEDDING_REINDEX_PAGE + 1);
    expect(h.queue.add).toHaveBeenNthCalledWith(
      1,
      GED_EMBEDDING_JOBS.reindexDocument,
      { documentId: 1, requestedBy: 3 },
      { jobId: 'reindex-document-1', removeOnComplete: true, removeOnFail: true },
    );
    for (const call of h.queue.add.mock.calls) expect(call[2].jobId).not.toContain(':');
    expect(reindexJobId(42)).toBe('reindex-document-42');
    // 2e page : curseur = dernier identifiant de la 1re
    const queries = h.sqls.filter((s) => s.sql.includes('SELECT'));
    expect(queries[1]!.values[0]).toBe(EMBEDDING_REINDEX_PAGE);
  });

  it('IA désactivée : ne fait rien', async () => {
    const h = build({ setup: OFF });
    expect(await h.run(GED_EMBEDDING_JOBS.reindexAll)).toEqual({
      disabled: true,
      message: GED_AI_DISABLED_MESSAGE,
    });
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('sweep', () => {
  it('met en file les documents périmés puis orphelins, sans doublon, avec la borne', async () => {
    const h = build({
      queryRows: [[{ documentId: 1 }, { documentId: 2 }], [{ documentId: 2 }, { documentId: 9 }]],
    });
    const res = await h.run(GED_EMBEDDING_JOBS.sweep);
    expect(res).toEqual({ disabled: false, queued: 3 });
    expect(h.queue.add.mock.calls.map((c) => c[1].documentId)).toEqual([1, 2, 9]);
    // borne : 200 pour les périmés, le reste pour les orphelins ; modèle courant lié
    expect(h.sqls[0]!.values).toEqual(['emb-1', EMBEDDING_SWEEP_LIMIT]);
    expect(h.sqls[1]!.values).toEqual([EMBEDDING_SWEEP_LIMIT - 2]);
  });

  it('borne atteinte : pas de requête sur les orphelins', async () => {
    const full = Array.from({ length: EMBEDDING_SWEEP_LIMIT }, (_, i) => ({ documentId: i + 1 }));
    const h = build({ queryRows: [full] });
    const res = await h.run(GED_EMBEDDING_JOBS.sweep);
    expect(res).toEqual({ disabled: false, queued: EMBEDDING_SWEEP_LIMIT });
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('IA désactivée : ne fait rien', async () => {
    const h = build({ setup: OFF });
    expect(await h.run(GED_EMBEDDING_JOBS.sweep)).toMatchObject({ disabled: true });
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});
