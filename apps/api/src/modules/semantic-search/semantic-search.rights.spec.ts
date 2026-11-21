/**
 * NON-RÉGRESSION DES DROITS — la recherche sémantique et les questions-réponses ne doivent jamais
 * lire, renvoyer, citer ni envoyer au modèle un segment d'un document interdit.
 *
 * Ici, AUCUN mock du filtre de droits ni du prompt : `buildSemanticAccessFilter` et
 * `buildQaRequest` sont les vrais. Seuls Prisma et `AiService` sont simulés.
 *
 * LIMITE (preuve définitive impossible sans base) : le « Prisma » simulé joue le rôle de la base en
 * lisant le SQL reçu (il ne renvoie le segment interdit que si les clauses de droits manquent).
 * Cela prouve que le filtre est BIEN INJECTÉ dans la requête exécutée, dans le même WHERE que le
 * tri `<=>` ; cela ne prouve pas que Postgres/pgvector évalue ces clauses comme prévu. Cette
 * preuve (exécution réelle sur Postgres + pgvector avec des jeux de droits) n'a pas pu être faite
 * ici faute de base ; elle relève du test d'intégration / de la recette.
 */
import { Prisma } from '@prisma/client';
import { GED_EMBEDDING_DIMENSION } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { buildSemanticAccessFilter } from './semantic-access-filter';
import { SemanticSearchService } from './semantic-search.service';
import { buildNearestChunksQuery } from './semantic-vector.sql';

const user: AuthUser = { userId: 7, username: 'agent', isAdmin: false, userGroupId: 70 };
const vector = Array.from({ length: GED_EMBEDDING_DIMENSION }, () => 0.1);
const FORBIDDEN_TEXT = 'TEXTE-DOCUMENT-INTERDIT-ZZZ';

const forbiddenRow = {
  ged_document_chunk_id: 1n,
  document_id: 666,
  document_version_id: 6660,
  chunk_index: 0,
  content: FORBIDDEN_TEXT,
  page_from: 1,
  page_to: 1,
  label: 'Dossier confidentiel',
  version_number: 1,
  score: 0.99, // le plus proche
};
const allowedRow = {
  ged_document_chunk_id: 2n,
  document_id: 10,
  document_version_id: 100,
  chunk_index: 0,
  content: 'Texte autorisé sur le contrat.',
  page_from: 2,
  page_to: 2,
  label: 'Contrat autorisé',
  version_number: 2,
  score: 0.6,
};

/** Rôle de la base : le segment interdit n'est renvoyé que si le SQL ne porte pas les clauses de droits. */
function fakeDatabase(sql: string): unknown[] {
  if (sql.includes('current_setting')) return [{ value: null }];
  const hasRights =
    sql.includes('permission_level_id = 1') &&
    sql.includes('d.is_frozen = false') &&
    sql.includes('d.document_state <>') &&
    sql.includes('confidentialite');
  return hasRights ? [allowedRow] : [forbiddenRow, allowedRow];
}

function setup() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => {
      queries.push(q);
      return fakeDatabase(q.sql);
    }),
    $executeRaw: jest.fn(async () => 1),
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const ai = {
    status: jest.fn().mockResolvedValue({ enabled: true, mode: 1 }),
    embed: jest.fn().mockResolvedValue({ disabled: false, vectors: [vector], model: 'bge-m3', dimension: 1024 }),
    run: jest.fn().mockResolvedValue({
      disabled: false,
      data: { answerable: true, answer: 'Réponse [1] [2]', citations: [1, 2] },
      decisionId: 5n,
    }),
    getEffectiveConfig: jest.fn().mockResolvedValue({ mode: 1, provider: 'ollama', model: 'm' }),
  };
  const service = new SemanticSearchService(
    prisma as never,
    ai as never,
    { record: jest.fn().mockResolvedValue(1n) } as never,
    { search: jest.fn() } as never,
    { add: jest.fn() } as never,
  );
  return { service, ai, queries };
}

describe('droits : forme du SQL (vrai buildSemanticAccessFilter)', () => {
  it('la requête de voisins contient les clauses de droits dans le même WHERE que ORDER BY <=>', () => {
    const q = buildNearestChunksQuery({
      queryVector: vector,
      embeddingModel: 'bge-m3',
      accessFilter: buildSemanticAccessFilter(user),
      limit: 5,
    });
    const where = q.sql.indexOf('WHERE');
    const order = q.sql.indexOf('ORDER BY c.embedding <=>');
    expect(where).toBeGreaterThan(-1);
    expect(order).toBeGreaterThan(where);
    const whereBlock = q.sql.slice(where, order);
    expect(whereBlock).toContain('confidentialite');
    expect(whereBlock).toContain('permission_level_id = 1'); // refus explicite
    expect(whereBlock).toContain('d.document_state <>'); // épuré
    expect(q.values).toContain(3); // DocumentState.Epure
    expect(whereBlock).toContain('d.is_frozen = false');
    expect(whereBlock).toContain('d.is_archived = true');
    expect(whereBlock).toContain('dv.is_current = true');
    // Aucune clause de droits après le tri (filtre « après coup » interdit).
    expect(q.sql.slice(order)).not.toContain('permission_level_id');
  });

  it('témoin : sans filtre de droits, le double renverrait bien le segment interdit', () => {
    const q = buildNearestChunksQuery({
      queryVector: vector,
      embeddingModel: 'bge-m3',
      accessFilter: Prisma.sql`true`,
      limit: 5,
    });
    expect(fakeDatabase(q.sql)).toContain(forbiddenRow);
  });
});

describe('droits : comportement du service', () => {
  it('search : ne renvoie pas le segment interdit', async () => {
    const { service, queries } = setup();
    const res = await service.search({ query: 'contrat', limit: 10 }, user);
    expect(res.hits.map((h) => h.documentId)).toEqual([10]);
    expect(JSON.stringify(res)).not.toContain(FORBIDDEN_TEXT);
    expect(JSON.stringify(res)).not.toContain('Dossier confidentiel');
    const knn = queries.find((q) => q.sql.includes('<=>'));
    expect(knn?.sql).toContain('permission_level_id = 1');
  });

  it('ask : ne cite pas le segment interdit et ne l’envoie pas au modèle', async () => {
    const { service, ai } = setup();
    const res = await service.ask({ question: 'Que dit le contrat ?' }, user);
    expect(res.citations.map((c) => c.documentId)).not.toContain(666);
    expect(JSON.stringify(res)).not.toContain(FORBIDDEN_TEXT);

    const opts = ai.run.mock.calls[0][0] as { request: { system: string; text: string } };
    expect(opts.request.text).not.toContain(FORBIDDEN_TEXT);
    expect(opts.request.system).not.toContain(FORBIDDEN_TEXT);
    expect(opts.request.text).not.toContain('Dossier confidentiel');
    expect(opts.request.text).toContain('Texte autorisé sur le contrat.');
  });
});
