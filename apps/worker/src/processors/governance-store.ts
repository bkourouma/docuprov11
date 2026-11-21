// Lot 5 — implémentation Prisma / SQL réelle des dépendances du moteur de gouvernance.
// Toutes les requêtes brutes sont paramétrées (`Prisma.sql` : jamais de concaténation de valeurs).
// Mode IA coupé : le moteur n'appelle pas `findEmbeddingNeighbours`, donc AUCUNE requête sur
// `ged_document_chunk` n'est émise.
import { Prisma, type PrismaClient } from '@prisma/client';
import { GedAiDecisionStatus, GED_GOVERNANCE_PROMPT_VERSION } from '@archivage/types';
import type {
  EmbeddingNeighbour,
  ExactDuplicateMatch,
  ExistingProposal,
  GovernanceDocument,
  TitleCandidate,
} from './governance-engine';

type QueryPrisma = Pick<PrismaClient, '$queryRaw'>;
/**
 * `$transaction` est optionnel dans le type pour ne pas changer le `Pick` de `governance.processor.ts`
 * (hors périmètre) : le vrai client l'a toujours ; sans lui on retombe sur la requête simple.
 */
type NeighbourPrisma = QueryPrisma & Partial<Pick<PrismaClient, '$transaction'>>;

/** Voisins pgvector retenus par segment échantillonné. */
export const GOVERNANCE_NEIGHBOURS_PER_CHUNK = 50;
/** Nombre de segments échantillonnés par document (premier, milieu, dernier). */
export const GOVERNANCE_SAMPLED_CHUNKS = 3;

/** Conditions d'éligibilité d'un document candidat : archivé et non épuré (état 3). */
const ANALYZABLE = Prisma.sql`d.is_archived = true AND d.document_state <> 3`;

/** Document + texte OCR de la version courante. `null` si introuvable. */
export async function loadGovernanceDocument(
  prisma: Pick<PrismaClient, 'document'>,
  documentId: number,
): Promise<GovernanceDocument | null> {
  const doc = await prisma.document.findUnique({
    where: { documentId },
    select: {
      documentId: true,
      label: true,
      documentTypeId: true,
      documentDate: true,
      isArchived: true,
      documentState: true,
      confidentialiteId: true,
      createdAt: true,
      confidentialite: { select: { rank: true } },
      versions: {
        where: { isCurrent: true },
        take: 1,
        select: { files: { orderBy: { sortOrder: 'asc' }, select: { ocrText: true } } },
      },
    },
  });
  if (!doc) return null;
  return {
    documentId: doc.documentId,
    label: doc.label,
    documentTypeId: doc.documentTypeId,
    documentDate: doc.documentDate ? doc.documentDate.toISOString().slice(0, 10) : null,
    isArchived: doc.isArchived,
    documentState: doc.documentState,
    confidentialiteId: doc.confidentialiteId,
    confidentialiteRank: doc.confidentialite ? doc.confidentialite.rank : null,
    createdAt: doc.createdAt,
    ocrTexts: (doc.versions[0]?.files ?? []).map((f) => f.ocrText),
  };
}

/** Niveaux de confidentialité actifs, du moins au plus restrictif. */
export async function listActiveConfidentialiteLevels(
  prisma: Pick<PrismaClient, 'confidentialite'>,
): Promise<Array<{ confidentialiteId: number; label: string; rank: number }>> {
  const rows = await prisma.confidentialite.findMany({
    where: { isActive: true },
    orderBy: [{ rank: 'asc' }, { confidentialiteId: 'asc' }],
    select: { confidentialiteId: true, label: true, rank: true },
  });
  return rows.map((r) => ({ confidentialiteId: r.confidentialiteId, label: r.label, rank: r.rank }));
}

/**
 * Doublons exacts. Un document est un doublon si l'ENSEMBLE de ses empreintes est identique à celui
 * du document analysé et non vide :
 * - `file_hash` : `document_file.hash` de tous les fichiers de la version courante ;
 * - `source_hash` : `ged_source_item.content_hash` de tous les éléments de source liés.
 * Un ensemble incomplet (fichier sans empreinte) n'est jamais comparable : pas de faux positif sur
 * un recouvrement partiel.
 */
export async function findExactDuplicates(
  prisma: QueryPrisma,
  documentId: number,
): Promise<ExactDuplicateMatch[]> {
  const fileRows = await prisma.$queryRaw<Array<{ documentId: number; createdAt: Date }>>(Prisma.sql`
    WITH mine AS (
      SELECT array_agg(DISTINCT f.hash ORDER BY f.hash) FILTER (WHERE f.hash IS NOT NULL) AS hashes,
             coalesce(bool_and(f.hash IS NOT NULL), false) AS complete
      FROM document_version v
      JOIN document_file f ON f.document_version_id = v.document_version_id
      WHERE v.document_id = ${documentId} AND v.is_current = true
    ),
    cand AS (
      SELECT DISTINCT v.document_id
      FROM document_version v
      JOIN document_file f ON f.document_version_id = v.document_version_id
      WHERE v.is_current = true
        AND v.document_id <> ${documentId}
        AND f.hash IN (SELECT unnest(m.hashes) FROM mine m)
    ),
    sets AS (
      SELECT v.document_id,
             array_agg(DISTINCT f.hash ORDER BY f.hash) FILTER (WHERE f.hash IS NOT NULL) AS hashes,
             coalesce(bool_and(f.hash IS NOT NULL), false) AS complete
      FROM document_version v
      JOIN document_file f ON f.document_version_id = v.document_version_id
      WHERE v.is_current = true AND v.document_id IN (SELECT document_id FROM cand)
      GROUP BY v.document_id
    )
    SELECT d.document_id AS "documentId", d.created_at AS "createdAt"
    FROM sets s
    CROSS JOIN mine m
    JOIN document d ON d.document_id = s.document_id
    WHERE ${ANALYZABLE}
      AND m.complete AND s.complete
      AND m.hashes IS NOT NULL AND cardinality(m.hashes) > 0
      AND s.hashes = m.hashes
    ORDER BY d.document_id`);

  const sourceRows = await prisma.$queryRaw<Array<{ documentId: number; createdAt: Date }>>(Prisma.sql`
    WITH mine AS (
      SELECT array_agg(DISTINCT i.content_hash ORDER BY i.content_hash)
               FILTER (WHERE i.content_hash IS NOT NULL) AS hashes,
             coalesce(bool_and(i.content_hash IS NOT NULL), false) AS complete
      FROM ged_source_item i
      WHERE i.document_id = ${documentId}
    ),
    cand AS (
      SELECT DISTINCT i.document_id
      FROM ged_source_item i
      WHERE i.document_id IS NOT NULL
        AND i.document_id <> ${documentId}
        AND i.content_hash IN (SELECT unnest(m.hashes) FROM mine m)
    ),
    sets AS (
      SELECT i.document_id,
             array_agg(DISTINCT i.content_hash ORDER BY i.content_hash)
               FILTER (WHERE i.content_hash IS NOT NULL) AS hashes,
             coalesce(bool_and(i.content_hash IS NOT NULL), false) AS complete
      FROM ged_source_item i
      WHERE i.document_id IN (SELECT document_id FROM cand)
      GROUP BY i.document_id
    )
    SELECT d.document_id AS "documentId", d.created_at AS "createdAt"
    FROM sets s
    CROSS JOIN mine m
    JOIN document d ON d.document_id = s.document_id
    WHERE ${ANALYZABLE}
      AND m.complete AND s.complete
      AND m.hashes IS NOT NULL AND cardinality(m.hashes) > 0
      AND s.hashes = m.hashes
    ORDER BY d.document_id`);

  return [
    ...fileRows.map((r) => ({
      documentId: Number(r.documentId),
      createdAt: r.createdAt,
      method: 'file_hash' as const,
    })),
    ...sourceRows.map((r) => ({
      documentId: Number(r.documentId),
      createdAt: r.createdAt,
      method: 'source_hash' as const,
    })),
  ];
}

/**
 * Voisins sémantiques, en deux temps pour ne comparer que quelques centroïdes :
 * 1. échantillon de segments du document (premier, milieu, dernier) et son `embedding_model` ;
 * 2. pour chaque segment, les 50 plus proches voisins du MÊME modèle hors le document (recherche
 *    LATERAL, éligible à l'index HNSW) -> identifiants de documents candidats ;
 * 3. cosinus entre centroïdes `avg(embedding)` du document et de chaque candidat archivé non épuré.
 * Le filtrage par seuil est fait par l'appelant (le moteur) ; on renvoie la similarité mesurée.
 */
export async function findEmbeddingNeighbours(
  prisma: NeighbourPrisma,
  documentId: number,
): Promise<EmbeddingNeighbour[]> {
  const sample = await prisma.$queryRaw<Array<{ chunkId: bigint | number; model: string }>>(Prisma.sql`
    SELECT c.ged_document_chunk_id AS "chunkId", c.embedding_model AS "model"
    FROM (
      SELECT ged_document_chunk_id, embedding_model, chunk_index,
             row_number() OVER (ORDER BY chunk_index, ged_document_chunk_id) AS rn,
             count(*) OVER () AS cnt
      FROM ged_document_chunk
      WHERE document_id = ${documentId}
    ) c
    WHERE c.rn IN (1, (c.cnt + 1) / 2, c.cnt)
    ORDER BY c.rn`);
  const model = sample[0]?.model;
  if (!model) return [];
  const chunkIds = [
    ...new Set(sample.filter((s) => s.model === model).map((s) => BigInt(s.chunkId))),
  ].slice(0, GOVERNANCE_SAMPLED_CHUNKS);
  if (chunkIds.length === 0) return [];

  const neighboursQuery = Prisma.sql`
    SELECT DISTINCT n.document_id AS "documentId"
    FROM ged_document_chunk s
    CROSS JOIN LATERAL (
      SELECT c.document_id
      FROM ged_document_chunk c
      WHERE c.embedding_model = ${model}
        AND c.document_id IS NOT NULL
        AND c.document_id <> ${documentId}
      ORDER BY c.embedding <=> s.embedding
      LIMIT ${GOVERNANCE_NEIGHBOURS_PER_CHUNK}
    ) n
    WHERE s.ged_document_chunk_id IN (${Prisma.join(chunkIds)})`;
  // Avec l'index HNSW, le filtre (document_id <> self, embedding_model) est appliqué APRÈS le parcours
  // de l'index : sans balayage itératif (pgvector >= 0.8) on peut recevoir trop peu de voisins. Même
  // technique que la recherche sémantique : expression vector (charge la bibliothèque), lecture de
  // `current_setting(..., true)` (NULL si pgvector < 0.8), `SET LOCAL` seulement si disponible, le tout
  // dans la même transaction que la requête de voisins.
  const runNeighbours = async (tx: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>) => {
    await tx.$queryRaw(Prisma.sql`SELECT '[1]'::vector`);
    const setting = await tx.$queryRaw<Array<{ value: string | null }>>(
      Prisma.sql`SELECT current_setting('hnsw.iterative_scan', true) AS value`,
    );
    if (setting[0]?.value != null) {
      await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    }
    return tx.$queryRaw<Array<{ documentId: number }>>(neighboursQuery);
  };
  const neighbours = prisma.$transaction
    ? await prisma.$transaction(runNeighbours)
    : await prisma.$queryRaw<Array<{ documentId: number }>>(neighboursQuery);
  const candidateIds = [...new Set(neighbours.map((n) => Number(n.documentId)))];
  if (candidateIds.length === 0) return [];

  const rows = await prisma.$queryRaw<
    Array<{ documentId: number; createdAt: Date; similarity: number }>
  >(Prisma.sql`
    WITH mine AS (
      SELECT avg(embedding) AS centroid
      FROM ged_document_chunk
      WHERE document_id = ${documentId} AND embedding_model = ${model}
    ),
    cand AS (
      SELECT c.document_id, avg(c.embedding) AS centroid
      FROM ged_document_chunk c
      WHERE c.document_id IN (${Prisma.join(candidateIds)}) AND c.embedding_model = ${model}
      GROUP BY c.document_id
    )
    SELECT d.document_id AS "documentId",
           d.created_at AS "createdAt",
           (1 - (cand.centroid <=> mine.centroid))::float8 AS "similarity"
    FROM cand
    CROSS JOIN mine
    JOIN document d ON d.document_id = cand.document_id
    WHERE ${ANALYZABLE}
    ORDER BY "similarity" DESC, d.document_id`);
  return rows.map((r) => ({
    documentId: Number(r.documentId),
    createdAt: r.createdAt,
    similarity: Number(r.similarity),
    embeddingModel: model,
  }));
}

/** Candidats « titre + métadonnées » : même type et même date, archivés non épurés (au plus `limit`). */
export async function findTitleCandidates(
  prisma: QueryPrisma,
  documentId: number,
  criteria: { documentTypeId: number; documentDate: string; limit: number },
): Promise<TitleCandidate[]> {
  const rows = await prisma.$queryRaw<Array<{ documentId: number; label: string; createdAt: Date }>>(
    Prisma.sql`
    SELECT d.document_id AS "documentId", d.label AS "label", d.created_at AS "createdAt"
    FROM document d
    WHERE ${ANALYZABLE}
      AND d.document_id <> ${documentId}
      AND d.document_type_id = ${criteria.documentTypeId}
      AND d.document_date = ${criteria.documentDate}::date
    ORDER BY d.document_id
    LIMIT ${criteria.limit}`,
  );
  return rows.map((r) => ({
    documentId: Number(r.documentId),
    label: r.label,
    createdAt: r.createdAt,
  }));
}

/** Propositions de gouvernance existantes (statuts 0 à 3 ; les erreurs ne comptent pas). */
export async function listExistingProposals(
  prisma: Pick<PrismaClient, 'gedAiDecision'>,
  documentIds: number[],
): Promise<ExistingProposal[]> {
  if (documentIds.length === 0) return [];
  const rows = await prisma.gedAiDecision.findMany({
    where: {
      promptVersion: GED_GOVERNANCE_PROMPT_VERSION,
      documentId: { in: documentIds },
      status: {
        in: [
          GedAiDecisionStatus.Proposee,
          GedAiDecisionStatus.Validee,
          GedAiDecisionStatus.Rejetee,
          GedAiDecisionStatus.AppliqueeAuto,
        ],
      },
    },
    select: { documentId: true, status: true, output: true },
  });
  return rows.map((r) => ({ documentId: r.documentId, status: r.status, output: r.output }));
}

/** Page (curseur par identifiant croissant) des documents archivés non épurés. */
export async function listAnalyzableDocumentIds(
  prisma: Pick<PrismaClient, 'document'>,
  opts: { afterId: number; limit: number },
): Promise<number[]> {
  const rows = await prisma.document.findMany({
    where: { isArchived: true, documentState: { not: 3 }, documentId: { gt: opts.afterId } },
    orderBy: { documentId: 'asc' },
    take: opts.limit,
    select: { documentId: true },
  });
  return rows.map((r) => r.documentId);
}

