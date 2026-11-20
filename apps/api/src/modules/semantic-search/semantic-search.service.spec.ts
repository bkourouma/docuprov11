import { HttpException } from '@nestjs/common';
import {
  GED_AI_QA_JSON_SCHEMA,
  GED_EMBEDDING_DIMENSION,
  GED_EMBEDDING_JOBS,
  GED_QA_MAX_SEGMENTS,
  GED_QA_PROMPT_VERSION,
  GED_QA_UNKNOWN_ANSWER,
  GED_SEMANTIC_EXCERPT_MAX_CHARS,
  GED_SEMANTIC_FALLBACK_MESSAGE,
  GedAiDecisionStatus,
  GedAiTask,
} from '@archivage/types';
import { AiProviderError } from '../ai/ai.types';
import type { AuthUser } from '../auth/auth.types';
import { SemanticSearchService } from './semantic-search.service';
import { buildQaRequest, parseQaOutput, resolveCitations } from './semantic-qa-prompt';

jest.mock('./semantic-access-filter', () => ({
  buildSemanticAccessFilter: jest.fn(() => {
    const { Prisma } = jest.requireActual('@prisma/client');
    return Prisma.sql`(d.is_archived = true)`;
  }),
}));
jest.mock('./semantic-qa-prompt', () => ({
  buildQaRequest: jest.fn(),
  parseQaOutput: jest.fn(),
  resolveCitations: jest.fn(),
}));

const user: AuthUser = { userId: 7, username: 'agent', isAdmin: false, userGroupId: 70 };
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10 };
const vector = Array.from({ length: GED_EMBEDDING_DIMENSION }, () => 0.1);
const SECRET = 'QUESTION-CONFIDENTIELLE-XYZ';

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    ged_document_chunk_id: 1n,
    document_id: 1,
    document_version_id: 11,
    chunk_index: 0,
    content: 'Contenu du segment.',
    page_from: 1,
    page_to: 2,
    label: 'Contrat A',
    version_number: 3,
    score: 0.8,
    ...over,
  };
}

function setup(opts: { enabled?: boolean; rows?: unknown[]; hnsw?: string | null } = {}) {
  const enabled = opts.enabled ?? true;
  const tx = {
    $queryRaw: jest.fn(async (sql: { sql: string }) =>
      sql.sql.includes('current_setting') ? [{ value: opts.hnsw ?? null }] : (opts.rows ?? []),
    ),
    $executeRaw: jest.fn(async () => 1),
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const ai = {
    status: jest.fn().mockResolvedValue({ enabled, mode: enabled ? 1 : 0 }),
    embed: jest.fn().mockResolvedValue({ disabled: false, vectors: [vector], model: 'bge-m3', dimension: 1024 }),
    run: jest.fn(),
    getEffectiveConfig: jest.fn().mockResolvedValue({ mode: 1, provider: 'ollama', model: 'llama3' }),
  };
  const decisions = { record: jest.fn().mockResolvedValue(99n) };
  const fulltext = {
    search: jest.fn().mockResolvedValue({
      total: 123,
      page: 1,
      pageSize: 10,
      rows: [
        { documentId: 5, label: 'Facture 5', cote: 'F-5', documentType: null, documentDate: null, createdAt: '', dossier: null, plan: null, location: null },
      ],
    }),
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const service = new SemanticSearchService(
    prisma as never,
    ai as never,
    decisions as never,
    fulltext as never,
    queue as never,
  );
  return { service, prisma, tx, ai, decisions, fulltext, queue };
}

beforeEach(() => {
  jest.clearAllMocks();
  (buildQaRequest as jest.Mock).mockImplementation((q: string, segs: unknown[]) => ({
    system: 'SYSTEM-QA',
    text: `TEXTE-QA ${segs.length}`,
    jsonSchema: GED_AI_QA_JSON_SCHEMA,
    maxOutputTokens: 700,
    _q: q,
  }));
  (parseQaOutput as jest.Mock).mockImplementation(() => ({ answerable: true, answer: 'ok [1]', citations: [1] }));
  (resolveCitations as jest.Mock).mockImplementation((_o: unknown, segs: Array<{ marker: number; documentId: number; documentLabel: string; versionId: number | null; versionNumber: number | null; pageFrom: number | null; pageTo: number | null; content: string }>) => ({
    answered: true,
    answer: 'ok [1]',
    citations: [{ marker: 1, documentId: segs[0].documentId, documentLabel: segs[0].documentLabel, versionId: segs[0].versionId, versionNumber: segs[0].versionNumber, pageFrom: segs[0].pageFrom, pageTo: segs[0].pageTo, excerpt: 'x' }],
  }));
});

describe('SemanticSearchService.search', () => {
  it('IA désactivée : repli plein texte, ni embed ni file, message présent, pas de total', async () => {
    const { service, ai, fulltext, prisma, queue } = setup({ enabled: false });
    const res = await service.search({ query: 'contrat', limit: 5 }, user);
    expect(res.mode).toBe('fulltext');
    expect(res.message).toBe(GED_SEMANTIC_FALLBACK_MESSAGE);
    expect(res.hits).toEqual([
      expect.objectContaining({ documentId: 5, documentLabel: 'Facture 5', excerpt: 'Facture 5 (F-5)', score: null, versionId: null, chunkIndex: null }),
    ]);
    expect(ai.embed).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(fulltext.search).toHaveBeenCalledWith({ fullText: 'contrat', page: 1, pageSize: 5 }, user);
    expect(JSON.stringify(res)).not.toContain('123');
    expect(res).not.toHaveProperty('total');
  });

  it('embed disabled entre-temps : même repli', async () => {
    const { service, ai } = setup();
    ai.embed.mockResolvedValue({ disabled: true, message: 'IA désactivée' });
    const res = await service.search({ query: 'contrat', limit: 5 }, user);
    expect(res.mode).toBe('fulltext');
  });

  it('dédoublonne (3 segments max par document), meilleur score en premier, extraits tronqués', async () => {
    const long = 'a'.repeat(GED_SEMANTIC_EXCERPT_MAX_CHARS * 3);
    const rows = [
      row({ ged_document_chunk_id: 1n, document_id: 1, chunk_index: 0, score: 0.6, content: long }),
      row({ ged_document_chunk_id: 2n, document_id: 1, chunk_index: 1, score: 0.9 }),
      row({ ged_document_chunk_id: 3n, document_id: 1, chunk_index: 2, score: 0.7 }),
      row({ ged_document_chunk_id: 4n, document_id: 1, chunk_index: 3, score: 0.65 }),
      row({ ged_document_chunk_id: 5n, document_id: 2, chunk_index: 0, score: 0.8, label: 'Autre' }),
    ];
    const { service } = setup({ rows });
    const res = await service.search({ query: 'contrat', limit: 10 }, user);
    expect(res.mode).toBe('semantic');
    const doc1 = res.hits.filter((h) => h.documentId === 1);
    expect(doc1).toHaveLength(3);
    expect(res.hits[0].score).toBe(0.9);
    expect(doc1.map((h) => h.score)).toEqual([0.9, 0.7, 0.65]);
    for (const h of res.hits) expect(h.excerpt.length).toBeLessThanOrEqual(GED_SEMANTIC_EXCERPT_MAX_CHARS);
    expect(res).not.toHaveProperty('total');
    expect(res).not.toHaveProperty('message');
  });

  it('respecte la limite demandée', async () => {
    const rows = [1, 2, 3, 4].map((i) => row({ document_id: i, score: 0.9 - i / 100 }));
    const { service } = setup({ rows });
    const res = await service.search({ query: 'contrat', limit: 2 }, user);
    expect(res.hits).toHaveLength(2);
  });

  it('transaction : lit current_setting puis SET LOCAL seulement si disponible', async () => {
    const on = setup({ hnsw: 'off' });
    await on.service.search({ query: 'contrat', limit: 5 }, user);
    expect(on.prisma.$transaction).toHaveBeenCalledTimes(1);
    // R1 : une expression vector est évaluée AVANT la lecture du réglage (chargement de pgvector).
    const warm = on.tx.$queryRaw.mock.calls[0][0] as unknown as { sql: string };
    expect(warm.sql).toContain("'[1]'::vector");
    const first = on.tx.$queryRaw.mock.calls[1][0] as unknown as { sql: string };
    expect(first.sql).toContain("current_setting('hnsw.iterative_scan', true)");
    expect(on.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const set = on.tx.$executeRaw.mock.calls[0] as unknown as Array<{ sql: string }>;
    expect(set[0].sql).toContain('SET LOCAL hnsw.iterative_scan = relaxed_order');
    expect(on.tx.$queryRaw).toHaveBeenCalledTimes(3);

    const off = setup({ hnsw: null });
    await off.service.search({ query: 'contrat', limit: 5 }, user);
    expect(off.tx.$executeRaw).not.toHaveBeenCalled();
    expect(off.tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('R5 : le nom du modèle d’embedding est normalisé (trim ; vide => défaut du mode)', async () => {
    const padded = setup({ hnsw: null });
    padded.ai.embed.mockResolvedValue({ disabled: false, vectors: [vector], model: '  bge-m3  ', dimension: 1024 });
    await padded.service.search({ query: 'contrat', limit: 5 }, user);
    const q1 = padded.tx.$queryRaw.mock.calls[2][0] as unknown as { values: unknown[] };
    expect(q1.values).toContain('bge-m3');

    const blank = setup({ hnsw: null });
    blank.ai.embed.mockResolvedValue({ disabled: false, vectors: [vector], model: '   ', dimension: 1024 });
    await blank.service.search({ query: 'contrat', limit: 5 }, user);
    const q2 = blank.tx.$queryRaw.mock.calls[2][0] as unknown as { values: unknown[] };
    expect(q2.values).toContain('bge-m3'); // mode local (1) => défaut local
  });

  it('la requête de voisins porte le filtre de droits, le modèle et le vecteur liés', async () => {
    const { service, tx } = setup({ hnsw: null });
    await service.search({ query: SECRET, limit: 5 }, user);
    const q = tx.$queryRaw.mock.calls[2][0] as unknown as { sql: string; values: unknown[] };
    expect(q.sql).toContain('d.is_archived = true');
    expect(q.values).toContain('bge-m3');
    expect(q.sql).not.toContain(SECRET);
  });

  it('erreur fournisseur : 503 générique, sans fuite du texte ni du message', async () => {
    const { service, ai } = setup();
    ai.embed.mockRejectedValue(new AiProviderError(`boom ${SECRET} sk-abc`));
    const err = await service.search({ query: SECRET, limit: 5 }, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect(JSON.stringify((err as HttpException).getResponse())).not.toMatch(/XYZ|sk-abc|boom/);
  });
});

describe('SemanticSearchService.ask', () => {
  it('IA désactivée : repli plein texte, decisionId null, run/embed jamais appelés', async () => {
    const { service, ai } = setup({ enabled: false });
    const res = await service.ask({ question: 'Quel est le montant ?' }, user);
    expect(res).toMatchObject({
      mode: 'fulltext',
      answered: false,
      answer: '',
      citations: [],
      message: GED_SEMANTIC_FALLBACK_MESSAGE,
      decisionId: null,
    });
    expect(res.hits).toHaveLength(1);
    expect(ai.embed).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('aucun segment suffisant : « je ne sais pas », run jamais appelé, décision journalisée sans texte', async () => {
    const { service, ai, decisions } = setup({ rows: [row({ score: 0.1 })] });
    const res = await service.ask({ question: SECRET }, user);
    expect(res).toMatchObject({
      mode: 'semantic',
      answered: false,
      answer: GED_QA_UNKNOWN_ANSWER,
      citations: [],
      decisionId: '99',
    });
    expect(ai.run).not.toHaveBeenCalled();
    expect(buildQaRequest).not.toHaveBeenCalled();
    expect(decisions.record).toHaveBeenCalledTimes(1);
    const rec = decisions.record.mock.calls[0][0];
    expect(rec).toMatchObject({
      task: GedAiTask.Question,
      mode: 1,
      model: 'llama3',
      status: GedAiDecisionStatus.Proposee,
      promptVersion: GED_QA_PROMPT_VERSION,
    });
    expect(JSON.stringify(rec)).not.toContain(SECRET);
  });

  it('échec du journal « je ne sais pas » : la réponse est tout de même rendue', async () => {
    const { service, decisions } = setup({ rows: [] });
    decisions.record.mockRejectedValue(new Error('db down'));
    const res = await service.ask({ question: 'Que dit le contrat ?' }, user);
    expect(res.answered).toBe(false);
    expect(res.decisionId).toBeNull();
  });

  it('avec segments : run appelé via buildQaRequest, 8 segments max, task Question, citations résolues', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ ged_document_chunk_id: BigInt(i + 1), document_id: i + 1, label: `Doc ${i + 1}`, score: 0.95 - i / 100 }),
    );
    const { service, ai } = setup({ rows });
    ai.run.mockResolvedValue({ disabled: false, data: { answerable: true, answer: 'ok [1]', citations: [1] }, decisionId: 42n });

    const res = await service.ask({ question: 'Que dit le contrat ?' }, user);

    const segs = (buildQaRequest as jest.Mock).mock.calls[0][1] as Array<{ marker: number }>;
    expect(segs).toHaveLength(GED_QA_MAX_SEGMENTS);
    expect(segs.map((s) => s.marker)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const opts = ai.run.mock.calls[0][0];
    expect(opts).toMatchObject({
      task: GedAiTask.Question,
      promptVersion: GED_QA_PROMPT_VERSION,
      requestedBy: 70,
      autoApply: false,
      documentId: null,
      parse: parseQaOutput,
    });
    expect(opts.request).toMatchObject({ system: 'SYSTEM-QA', text: 'TEXTE-QA 8', maxOutputTokens: 700 });
    expect(opts.request.jsonSchema).toBe(GED_AI_QA_JSON_SCHEMA);
    expect(resolveCitations).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ mode: 'semantic', answered: true, answer: 'ok [1]', decisionId: '42' });
    expect(res.citations[0]).toMatchObject({ marker: 1, documentId: 1, documentLabel: 'Doc 1' });
    expect(res).not.toHaveProperty('total');
  });

  it('écarte les segments sous le seuil de similarité', async () => {
    const rows = [row({ score: 0.9 }), row({ ged_document_chunk_id: 2n, document_id: 2, score: 0.29 })];
    const { service, ai } = setup({ rows });
    ai.run.mockResolvedValue({ disabled: false, data: {}, decisionId: null });
    const res = await service.ask({ question: 'Que dit le contrat ?' }, user);
    expect((buildQaRequest as jest.Mock).mock.calls[0][1]).toHaveLength(1);
    expect(res.decisionId).toBeNull();
  });

  it('run renvoie disabled : repli plein texte', async () => {
    const { service, ai } = setup({ rows: [row()] });
    ai.run.mockResolvedValue({ disabled: true, message: 'IA désactivée' });
    const res = await service.ask({ question: 'Que dit le contrat ?' }, user);
    expect(res.mode).toBe('fulltext');
    expect(res.decisionId).toBeNull();
  });

  it('erreur du modèle : 503 générique sans fuite', async () => {
    const { service, ai } = setup({ rows: [row({ content: 'TEXTE-SEGMENT-SECRET' })] });
    ai.run.mockRejectedValue(new AiProviderError('clé sk-123 + TEXTE-SEGMENT-SECRET'));
    const err = await service.ask({ question: SECRET }, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect(JSON.stringify((err as HttpException).getResponse())).not.toMatch(/sk-123|SECRET|XYZ/);
  });

  it('sortie du modèle inexploitable (parse) : 503 générique', async () => {
    const { service, ai } = setup({ rows: [row()] });
    ai.run.mockRejectedValue(new SyntaxError('Unexpected token dans {"answer":"TEXTE"}'));
    const err = await service.ask({ question: 'Que dit le contrat ?' }, user).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(503);
    expect(JSON.stringify((err as HttpException).getResponse())).not.toContain('TEXTE');
  });
});

describe('SemanticSearchService.reindex', () => {
  it('reindexDocument : jobId stable sans « : », options bornées', async () => {
    const { service, queue } = setup();
    await expect(service.reindexDocument(42, admin)).resolves.toEqual({ queued: true });
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe(GED_EMBEDDING_JOBS.reindexDocument);
    expect(data).toEqual({ documentId: 42, requestedBy: 10 });
    expect(opts.jobId).toBe('reindex-document-42');
    expect(opts.jobId).not.toContain(':');
    expect(opts.removeOnComplete).toBeTruthy();
    expect(opts.removeOnFail).toEqual(expect.objectContaining({ count: expect.any(Number) }));
  });

  it('reindexAll : met en file reindex-all', async () => {
    const { service, queue } = setup();
    await service.reindexAll(admin);
    expect(queue.add.mock.calls[0][0]).toBe(GED_EMBEDDING_JOBS.reindexAll);
    expect(queue.add.mock.calls[0][2].jobId).toBe('reindex-all');
  });

  it('IA désactivée : { disabled, message } sans mise en file', async () => {
    const { service, queue } = setup({ enabled: false });
    await expect(service.reindexAll(admin)).resolves.toMatchObject({ disabled: true });
    await expect(service.reindexDocument(1, admin)).resolves.toMatchObject({ disabled: true });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuse un non-administrateur (défense en profondeur)', async () => {
    const { service, queue } = setup();
    await expect(service.reindexAll(user)).rejects.toThrow();
    await expect(service.reindexDocument(1, user)).rejects.toThrow();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
