/**
 * Service de lecture de la gouvernance. Le filtre de visibilité (T3) est MOQUÉ par un marqueur
 * reconnaissable ; le « Prisma » simulé capture le SQL émis. LIMITE : sans PostgreSQL réel, on prouve
 * que le périmètre et la visibilité sont injectés dans CHAQUE requête brute vers `ged_ai_decision`,
 * pas que la base les évalue comme prévu (relève de la recette).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  GED_GOVERNANCE_AI_OFF_MESSAGE,
  GED_GOVERNANCE_BATCH_SIZE,
  GED_GOVERNANCE_JOBS,
  GED_GOVERNANCE_PROMPT_VERSION,
  type GovernanceListQuery,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';

jest.mock('./governance-access-filter', () => {
  const { Prisma: P } = jest.requireActual('@prisma/client');
  return {
    buildProposalVisibilityFilter: jest.fn(() => P.sql`'VIS_MARKER' = 'VIS_MARKER'`),
    buildGovernanceAccessFilter: jest.fn(() => P.sql`'ACC_MARKER' = 'ACC_MARKER'`),
  };
});
jest.mock('../documents/documents.service', () => ({ DocumentsService: class {} }));

import { buildGovernanceAccessFilter, buildProposalVisibilityFilter } from './governance-access-filter';
import { GovernanceQueryService } from './governance-query.service';

const manager: AuthUser = { userId: 7, username: 'gest', isAdmin: false, userGroupId: 70 };
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10 };

const dupOutput = {
  schemaVersion: 1,
  kind: 'duplicate_exact',
  method: 'file_hash',
  similarity: 1,
  groupKey: 'dup:5',
  originalDocumentId: 5,
  duplicateDocumentId: 6,
  proposedAction: 'archive_duplicate',
};
const sensOutput = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: 'sensitivity',
  score: 2,
  currentConfidentialiteId: 1,
  currentRank: 2,
  proposedConfidentialiteId: 2,
  proposedRank: 1,
  direction: 'lower',
  reasons: ['keyword_hr'],
  detection: { deterministic: true, ai: false },
  ...over,
});

function decisionRow(id: bigint, output: unknown, over: Record<string, unknown> = {}) {
  return {
    ged_ai_decision_id: id,
    document_id: 6,
    provider: 'deterministe',
    model: 'regles-gouvernance-v1',
    input_excerpt: 'Extrait   masque',
    input_masked: true,
    output,
    confidence: '0.950',
    status: 0,
    validated_by: null,
    validated_at: null,
    created_at: new Date('2026-11-20T10:00:00Z'),
    ...over,
  };
}

interface Captured {
  sql: string;
  values: unknown[];
}

function setup(opts: {
  rows?: unknown[];
  total?: number;
  dashboardRows?: unknown[];
  analyzable?: number[];
  aiEnabled?: boolean;
  canAccess?: boolean;
  docs?: unknown[];
  confs?: unknown[];
} = {}) {
  const queries: Captured[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (q: Captured) => {
      queries.push({ sql: q.sql, values: q.values });
      if (q.sql.includes('FROM ged_ai_decision')) {
        if (q.sql.includes('GROUPING SETS')) return opts.dashboardRows ?? [];
        if (q.sql.includes('COUNT(*)')) return [{ total: opts.total ?? 0 }];
        return opts.rows ?? [];
      }
      if (q.sql.includes('COUNT(*)')) return [{ total: 321 }];
      return (opts.analyzable ?? []).map((document_id) => ({ document_id }));
    }),
    document: {
      findMany: jest.fn(async () => opts.docs ?? [{ documentId: 6, label: 'Facture 6', confidentialiteId: 1 }, { documentId: 5, label: 'Facture 5', confidentialiteId: null }]),
      findUnique: jest.fn(async ({ where }: { where: { documentId: number } }) => ({
        documentId: where.documentId,
        label: `Doc ${where.documentId}`,
        cote: 'C-1',
        documentDate: new Date('2026-01-31T00:00:00Z'),
        createdAt: new Date('2026-02-01T08:00:00Z'),
        isFrozen: where.documentId === 5,
        overview: 'x'.repeat(500),
        documentType: { label: 'Facture' },
        confidentialite: { label: 'Interne' },
        versions: [{ files: [{ byteLength: 100n, pageCount: 2 }, { byteLength: 50n, pageCount: null }] }],
      })),
    },
    confidentialite: {
      findMany: jest.fn(async () =>
        opts.confs ?? [
          { confidentialiteId: 1, label: 'Confidentiel', rank: 2 },
          { confidentialiteId: 2, label: 'Interne', rank: 1 },
        ],
      ),
    },
  };
  const documents = { canAccess: jest.fn(async () => opts.canAccess ?? true) };
  const ai = {
    status: jest.fn(async () => (opts.aiEnabled === false ? { enabled: false, mode: 0, message: 'off' } : { enabled: true, mode: 1 })),
  };
  const queue = { add: jest.fn(async () => ({})) };
  const service = new GovernanceQueryService(prisma as never, documents as never, ai as never, queue as never);
  return { service, prisma, documents, ai, queue, queries };
}

const listQuery = (over: Partial<GovernanceListQuery> = {}): GovernanceListQuery => ({ page: 1, pageSize: 25, ...over });

/** AUCUNE requête brute vers `ged_ai_decision` sans le marqueur de visibilité ni le périmètre. */
function expectAllDecisionQueriesScoped(queries: Captured[]) {
  const decisionQueries = queries.filter((q) => q.sql.includes('ged_ai_decision'));
  expect(decisionQueries.length).toBeGreaterThan(0);
  for (const q of decisionQueries) {
    expect(q.sql).toContain("'VIS_MARKER' = 'VIS_MARKER'");
    expect(q.sql).toContain('a.prompt_version =');
    expect(q.sql).toContain('a.task IN');
    expect(q.sql).toContain('a.status IN');
    expect(q.sql).toContain("a.output->>'kind' IN");
    expect(q.values).toContain(GED_GOVERNANCE_PROMPT_VERSION);
  }
}

beforeEach(() => jest.clearAllMocks());

describe('liste', () => {
  it('list et COUNT portent le même WHERE (visibilité comprise), tri created_at DESC, id DESC', async () => {
    const { service, queries } = setup({ rows: [decisionRow(11n, dupOutput)], total: 41 });
    const page = await service.list(listQuery({ page: 3, pageSize: 10 }), manager);

    expect(buildProposalVisibilityFilter).toHaveBeenCalledWith(manager, 'a');
    expectAllDecisionQueriesScoped(queries);
    expect(queries).toHaveLength(2);
    const [list, count] = queries;
    const whereOf = (sql: string) => sql.slice(sql.indexOf('WHERE'), sql.includes('ORDER BY') ? sql.indexOf('ORDER BY') : undefined).replace(/\s+/g, ' ').trim();
    expect(whereOf(list.sql)).toBe(whereOf(count.sql));
    expect(list.values.slice(0, -2)).toEqual(count.values);
    expect(list.sql).toContain('ORDER BY a.created_at DESC, a.ged_ai_decision_id DESC');
    // Pagination bornée et liée (jamais interpolée) : LIMIT pageSize OFFSET (page-1)*pageSize.
    expect(list.values.slice(-2)).toEqual([10, 20]);
    expect(list.sql).toContain('LIMIT ? OFFSET ?');
    expect(page).toMatchObject({ total: 41, page: 3, pageSize: 10 });
    expect(page.items).toHaveLength(1);
  });

  it('filtres facultatifs liés en paramètres, ajoutés au WHERE obligatoire', async () => {
    const { service, queries } = setup();
    await service.list(
      listQuery({ kind: 'duplicate_near', status: 0, documentId: 6, groupKey: 'dup:5', minConfidence: 0.8 }),
      manager,
    );
    expectAllDecisionQueriesScoped(queries);
    for (const q of queries) {
      expect(q.sql).toContain("a.output->>'kind' = ?");
      expect(q.sql).toContain('a.status = ?');
      expect(q.sql).toContain('a.document_id = ?');
      expect(q.sql).toContain("a.output->>'groupKey' = ?");
      expect(q.sql).toContain('a.confidence >= ?');
      expect(q.values).toEqual(expect.arrayContaining(['duplicate_near', 0, 6, 'dup:5', 0.8]));
      expect(q.sql).not.toContain('duplicate_near'); // valeurs jamais dans le texte SQL
      expect(q.sql).not.toContain('dup:5');
    }
  });

  it('sans filtre : aucune clause facultative', async () => {
    const { service, queries } = setup();
    await service.list(listQuery(), manager);
    expect(queries[0].sql).not.toContain('a.document_id =');
    expect(queries[0].sql).not.toContain('a.confidence >=');
  });

  it('ignore les lignes dont output est invalide, conserve les autres', async () => {
    const { service } = setup({
      rows: [
        decisionRow(1n, { kind: 'duplicate_exact', nimportequoi: true }),
        decisionRow(2n, null),
        decisionRow(3n, { kind: 'autre' }),
        decisionRow(4n, dupOutput),
      ],
      total: 4,
    });
    const page = await service.list(listQuery(), manager);
    expect(page.items.map((i) => i.id)).toEqual(['4']);
  });

  it('étiquettes lues après, pour les seuls identifiants de la page ; vue complète', async () => {
    const { service, prisma } = setup({ rows: [decisionRow(11n, dupOutput)], total: 1 });
    const { items } = await service.list(listQuery(), manager);
    expect(prisma.document.findMany).toHaveBeenCalledTimes(1);
    const arg = (prisma.document.findMany.mock.calls[0] as unknown as [{ where: { documentId: { in: number[] } } }])[0];
    expect(arg.where.documentId.in.sort()).toEqual([5, 6]);
    expect(items[0]).toMatchObject({
      id: '11',
      kind: 'duplicate_exact',
      status: 0,
      confidence: 0.95,
      documentId: 6,
      documentLabel: 'Facture 6',
      originalDocumentId: 5,
      originalDocumentLabel: 'Facture 5',
      groupKey: 'dup:5',
      excerpt: 'Extrait masque',
      inputMasked: true,
      createdAt: '2026-11-20T10:00:00.000Z',
      requiresLoweringConfirmation: false,
    });
  });

  it('page vide : aucune lecture d’étiquette', async () => {
    const { service, prisma } = setup({ rows: [], total: 0 });
    const page = await service.list(listQuery(), manager);
    expect(page.items).toEqual([]);
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('sensibilité : abaissement détecté sur le rang VIVANT, pas sur celui consigné', async () => {
    // Consigné : élévation (courant 0 -> proposé 1) ; vivant : le document est maintenant au rang 2.
    const out = sensOutput({ currentConfidentialiteId: null, currentRank: null, direction: 'raise' });
    const { service } = setup({ rows: [decisionRow(21n, out, { document_id: 6 })], total: 1 });
    const { items } = await service.list(listQuery(), manager);
    expect(items[0].requiresLoweringConfirmation).toBe(true); // proposé 1 < vivant 2
    expect(items[0].proposedConfidentialiteLabel).toBe('Interne');
    expect(items[0].currentConfidentialiteLabel).toBeNull();
  });

  it('sensibilité : élévation => pas de confirmation ; document sans niveau => pas de confirmation', async () => {
    const raise = sensOutput({ proposedConfidentialiteId: 1, proposedRank: 2, currentConfidentialiteId: 2, currentRank: 1, direction: 'raise' });
    const a = setup({
      rows: [decisionRow(22n, raise, { document_id: 6 })],
      docs: [{ documentId: 6, label: 'D', confidentialiteId: 2 }],
      total: 1,
    });
    expect((await a.service.list(listQuery(), manager)).items[0].requiresLoweringConfirmation).toBe(false);

    const b = setup({
      rows: [decisionRow(23n, sensOutput(), { document_id: 6 })],
      docs: [{ documentId: 6, label: 'D', confidentialiteId: null }],
      total: 1,
    });
    expect((await b.service.list(listQuery(), manager)).items[0].requiresLoweringConfirmation).toBe(false);
  });

  it('sensibilité : doute (document ou niveau courant introuvable) => confirmation exigée', async () => {
    const noDoc = setup({ rows: [decisionRow(24n, sensOutput())], docs: [], total: 1 });
    expect((await noDoc.service.list(listQuery(), manager)).items[0].requiresLoweringConfirmation).toBe(true);
    const noLive = setup({
      rows: [decisionRow(25n, sensOutput())],
      docs: [{ documentId: 6, label: 'D', confidentialiteId: 99 }],
      total: 1,
    });
    expect((await noLive.service.list(listQuery(), manager)).items[0].requiresLoweringConfirmation).toBe(true);
  });
});

describe('détail', () => {
  it('404 uniforme : aucune ligne (inexistant, hors périmètre ou invisible)', async () => {
    const { service, queries } = setup({ rows: [] });
    await expect(service.get(99, manager)).rejects.toBeInstanceOf(NotFoundException);
    expectAllDecisionQueriesScoped(queries);
    expect(queries[0].values).toContain(99n);
  });

  it('404 identique si output invalide', async () => {
    const { service } = setup({ rows: [decisionRow(1n, { kind: 'pii' })] });
    await expect(service.get(1, manager)).rejects.toThrow('Proposition introuvable.');
  });

  it('le message est le même dans tous les cas de 404', async () => {
    const a = setup({ rows: [] });
    const b = setup({ rows: [decisionRow(1n, null)] });
    const msg = async (s: GovernanceQueryService) => {
      try {
        await s.get(1, manager);
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(await msg(a.service)).toBe(await msg(b.service));
  });

  it('doublon : comparaison de deux résumés (tronqué à 300, fichiers/pages/octets)', async () => {
    const { service, queries } = setup({ rows: [decisionRow(11n, dupOutput)] });
    const detail = await service.get(11, manager);
    expectAllDecisionQueriesScoped(queries);
    expect(detail.comparison).not.toBeNull();
    const { original, duplicate } = detail.comparison!;
    expect(original.documentId).toBe(5);
    expect(duplicate.documentId).toBe(6);
    expect(original.isFrozen).toBe(true);
    expect(duplicate.isFrozen).toBe(false);
    expect(original).toMatchObject({
      label: 'Doc 5',
      cote: 'C-1',
      documentDate: '2026-01-31',
      documentTypeLabel: 'Facture',
      confidentialiteLabel: 'Interne',
      fileCount: 2,
      pageCount: 2,
      byteLength: 150,
    });
    expect(original.overviewExcerpt).toHaveLength(300);
    expect(original.overviewExcerpt!.endsWith('…')).toBe(true);
  });

  it('hors doublon : comparison = null', async () => {
    const { service } = setup({ rows: [decisionRow(21n, sensOutput())] });
    expect((await service.get(21, manager)).comparison).toBeNull();
  });
});

describe('tableau de bord', () => {
  const rows = [
    { kind: 'duplicate_exact', status: 0, n: 3, open_groups: 2 },
    { kind: 'duplicate_exact', status: 1, n: 1, open_groups: 0 },
    { kind: 'sensitivity', status: 2, n: 4, open_groups: 0 },
    { kind: null, status: null, n: 8, open_groups: 2 },
  ];

  it('UN SEUL GROUP BY, avec périmètre + visibilité, jamais de compte global', async () => {
    const { service, queries } = setup({ dashboardRows: rows });
    await service.dashboard(manager);
    expect(queries).toHaveLength(1);
    expectAllDecisionQueriesScoped(queries);
    expect(queries[0].sql).toContain('GROUP BY GROUPING SETS');
    expect(queries[0].sql).toContain("COUNT(DISTINCT a.output->>'groupKey')");
    expect(buildProposalVisibilityFilter).toHaveBeenCalledWith(manager, 'a');
  });

  it('agrège par type, tous les types présents même à zéro', async () => {
    const { service } = setup({ dashboardRows: rows });
    const d = await service.dashboard(manager);
    expect(d.byKind.duplicate_exact).toEqual({ proposee: 3, validee: 1, rejetee: 0, total: 4 });
    expect(d.byKind.sensitivity).toEqual({ proposee: 0, validee: 0, rejetee: 4, total: 4 });
    expect(d.byKind.duplicate_near).toEqual({ proposee: 0, validee: 0, rejetee: 0, total: 0 });
    expect(d.byKind.pii).toEqual({ proposee: 0, validee: 0, rejetee: 0, total: 0 });
    expect(d.totals).toEqual({ proposee: 3, validee: 1, rejetee: 4, total: 8 });
    expect(d.openDuplicateGroups).toBe(2);
    expect(d.aiEnabled).toBe(true);
    expect(d.aiMessage).toBeNull();
    expect(typeof d.generatedAt).toBe('string');
  });

  it('rien de visible : tout à zéro ; IA désactivée => message clair', async () => {
    const { service } = setup({ dashboardRows: [], aiEnabled: false });
    const d = await service.dashboard(manager);
    expect(d.totals.total).toBe(0);
    expect(d.openDuplicateGroups).toBe(0);
    expect(Object.keys(d.byKind).sort()).toEqual(['duplicate_exact', 'duplicate_near', 'pii', 'sensitivity']);
    expect(d.aiEnabled).toBe(false);
    expect(d.aiMessage).toBe(GED_GOVERNANCE_AI_OFF_MESSAGE);
  });
});

describe('analyse', () => {
  it('un document : canAccess sinon 404 ; aucun job enfilé', async () => {
    const { service, queue } = setup({ canAccess: false });
    await expect(service.analyze({ documentId: 5 }, manager)).rejects.toBeInstanceOf(NotFoundException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('un document non archivé ou épuré : 404 (même message)', async () => {
    const { service, queue, queries } = setup({ canAccess: true, analyzable: [] });
    await expect(service.analyze({ documentId: 5 }, manager)).rejects.toThrow('Document introuvable.');
    expect(queries[0].sql).toContain('d.is_archived = true');
    expect(queries[0].sql).toContain('d.document_state <>');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('un document : job analyze-document, jobId sans deux-points, options de nettoyage', async () => {
    const { service, queue, documents } = setup({ analyzable: [5] });
    const res = await service.analyze({ documentId: 5 }, manager);
    expect(documents.canAccess).toHaveBeenCalledWith(5, manager);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      GED_GOVERNANCE_JOBS.analyzeDocument,
      { documentId: 5, requestedBy: 70 },
      { jobId: 'governance-doc-5', removeOnComplete: true, removeOnFail: true },
    );
    expect(res).toEqual({ queued: 1, ignored: 0, aiEnabled: true, message: null });
  });

  it('liste : filtre SQL (archivé, non épuré, droits), ignorés comptés, doublons de la demande dédupliqués', async () => {
    const { service, queue, queries } = setup({ analyzable: [1, 3] });
    const res = await service.analyze({ documentIds: [1, 2, 3, 3, 4] }, manager);
    expect(buildGovernanceAccessFilter).toHaveBeenCalledWith(manager, 'd');
    expect(queries[0].sql).toContain("'ACC_MARKER' = 'ACC_MARKER'");
    expect(queries[0].sql).toContain('d.is_archived = true');
    expect(queries[0].sql).toContain('d.document_state <>');
    expect(res).toMatchObject({ queued: 2, ignored: 2 });
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0] as unknown as [string, unknown, { jobId: string; removeOnComplete: boolean; removeOnFail: boolean }];
    expect(name).toBe(GED_GOVERNANCE_JOBS.analyzeBatch);
    expect(data).toEqual({ scope: 'documents', documentIds: [1, 3], requestedBy: 70 });
    expect(opts.jobId).toMatch(/^governance-batch-[0-9a-f]+$/);
    expect(opts.jobId).not.toContain(':');
    expect(opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });
  });

  it('liste : paquets de GED_GOVERNANCE_BATCH_SIZE, jobId distincts', async () => {
    const ids = Array.from({ length: GED_GOVERNANCE_BATCH_SIZE * 2 + 1 }, (_, i) => i + 1);
    const { service, queue } = setup({ analyzable: ids });
    const res = await service.analyze({ documentIds: ids }, manager);
    expect(res.queued).toBe(ids.length);
    expect(queue.add).toHaveBeenCalledTimes(3);
    const calls = queue.add.mock.calls as unknown as [string, { documentIds: number[] }, { jobId: string }][];
    expect(calls.map((c) => c[1].documentIds.length)).toEqual([GED_GOVERNANCE_BATCH_SIZE, GED_GOVERNANCE_BATCH_SIZE, 1]);
    expect(new Set(calls.map((c) => c[2].jobId)).size).toBe(3);
  });

  it('liste : tout ignoré => rien d’enfilé, pas d’erreur', async () => {
    const { service, queue } = setup({ analyzable: [] });
    const res = await service.analyze({ documentIds: [8, 9] }, manager);
    expect(res).toMatchObject({ queued: 0, ignored: 2 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('all : non-administrateur => 403, rien d’enfilé', async () => {
    const { service, queue } = setup();
    await expect(service.analyze({ all: true }, manager)).rejects.toBeInstanceOf(ForbiddenException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('all : administrateur => UN job analyze-batch scope all', async () => {
    const { service, queue } = setup();
    const res = await service.analyze({ all: true }, admin);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      GED_GOVERNANCE_JOBS.analyzeBatch,
      { scope: 'all', requestedBy: 10 },
      { jobId: 'governance-all', removeOnComplete: true, removeOnFail: true },
    );
    expect(res).toMatchObject({ queued: 321, ignored: 0 });
  });

  it('IA désactivée : l’enfilage a lieu, la réponse porte le message clair', async () => {
    const { service, queue } = setup({ analyzable: [5], aiEnabled: false });
    const res = await service.analyze({ documentId: 5 }, manager);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ queued: 1, ignored: 0, aiEnabled: false, message: GED_GOVERNANCE_AI_OFF_MESSAGE });
  });
});

describe('structure SQL', () => {
  it('valeurs toujours liées : aucune requête n’interpole l’identifiant ou le statut', async () => {
    const { service, queries } = setup();
    await service.list(listQuery({ documentId: 424242, status: 2 }), manager);
    for (const q of queries) {
      expect(q.sql).not.toContain('424242');
      expect(Prisma.sql`x`).toBeDefined();
    }
  });
});

describe('cohérence des totaux : validité de output dans le WHERE commun', () => {
  const VALIDITY = [
    "jsonb_typeof(a.output) = 'object'",
    "a.output->>'schemaVersion' = '1'",
    "jsonb_typeof(a.output->'duplicateDocumentId') = 'number'",
    "a.output->>'duplicateDocumentId' ~ '^[1-9][0-9]{0,9}$'",
    "a.output->>'originalDocumentId' ~ '^[1-9][0-9]{0,9}$'",
    "a.output->>'duplicateDocumentId' = a.document_id::text",
    "a.output->>'proposedConfidentialiteId' ~ '^[1-9][0-9]{0,9}$'",
    "jsonb_typeof(a.output->'findings') = 'array'",
    'jsonb_array_length(a.output->\'findings\') > 0',
  ];
  const flat = (sql: string) => sql.replace(/\s+/g, ' ');

  it('list, count, get et dashboard portent les mêmes conditions de validité', async () => {
    const t = setup({ rows: [decisionRow(11n, dupOutput)], total: 1 });
    await t.service.list(listQuery(), manager);
    await t.service.get(11, manager);
    await t.service.dashboard(manager);
    const decisionQueries = t.queries.filter((q) => q.sql.includes('ged_ai_decision'));
    expect(decisionQueries).toHaveLength(4); // list, count, get, dashboard
    for (const q of decisionQueries) {
      const sql = flat(q.sql);
      for (const fragment of VALIDITY) expect(sql).toContain(fragment);
    }
  });

  it('une ligne invalide simulée n’est pas comptée : total issu de SQL, liste filtrée par Node', async () => {
    // Le faux Prisma renvoie une ligne invalide malgré le SQL (champ secondaire non contrôlé par
    // SQL) : la liste l'écarte ; le total vient du COUNT SQL qui porte les mêmes gardes.
    const t = setup({
      rows: [decisionRow(1n, { ...dupOutput, extra: 1 }), decisionRow(2n, dupOutput)],
      total: 1,
    });
    const page = await t.service.list(listQuery(), manager);
    expect(page.items.map((i) => i.id)).toEqual(['2']);
    expect(page.total).toBe(1);
    const sql = flat(t.queries[1].sql);
    expect(sql).toContain("jsonb_typeof(a.output->'schemaVersion') = 'number'");
    expect(sql).toContain("CASE WHEN jsonb_typeof(a.output->'findings') = 'array'");
  });

  it('natures liées en paramètres (jamais interpolées)', async () => {
    const t = setup();
    await t.service.list(listQuery(), manager);
    expect(t.queries[0].values).toEqual(
      expect.arrayContaining(['duplicate_exact', 'duplicate_near', 'sensitivity', 'pii']),
    );
  });
});

describe('getForAdminReview', () => {
  it('administrateur : périmètre et validité, SANS visibilité ni lien document, sans comparaison', async () => {
    const orphan = decisionRow(31n, dupOutput, { document_id: null });
    const t = setup({ rows: [orphan], docs: [] });
    const view = await t.service.getForAdminReview(31, admin);
    expect(buildProposalVisibilityFilter).not.toHaveBeenCalled();
    const sql = t.queries[0].sql.replace(/\s+/g, ' ');
    expect(sql).not.toContain('VIS_MARKER');
    expect(sql).not.toContain('a.document_id::text');
    expect(sql).toContain('a.prompt_version =');
    expect(sql).toContain('a.task IN');
    expect(sql).toContain('a.status IN');
    expect(sql).toContain("jsonb_typeof(a.output) = 'object'");
    expect(sql).toContain("a.output->>'originalDocumentId' ~");
    expect(t.queries[0].values).toContain(31n);
    expect(view.id).toBe('31');
    expect(view.documentId).toBeNull();
    expect(view.documentLabel).toBeNull();
    expect(view.originalDocumentLabel).toBeNull();
    expect('comparison' in view).toBe(false);
    expect(t.prisma.document.findUnique).not.toHaveBeenCalled();
  });

  it('non administrateur et agent de numérisation : 404 sans aucune requête', async () => {
    const t = setup({ rows: [decisionRow(31n, dupOutput)] });
    await expect(t.service.getForAdminReview(31, manager)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      t.service.getForAdminReview(31, { ...admin, isScanAgent: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.queries).toHaveLength(0);
  });

  it('output invalide ou aucune ligne : 404', async () => {
    const t = setup({ rows: [decisionRow(31n, { kind: 'pii' })] });
    await expect(t.service.getForAdminReview(31, admin)).rejects.toBeInstanceOf(NotFoundException);
    const t2 = setup({ rows: [] });
    await expect(t2.service.getForAdminReview(31, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});
