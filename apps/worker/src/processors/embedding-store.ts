// Lot 3 — lecture/écriture pgvector de `ged_document_chunk` (Prisma n'expose pas la colonne `vector`).
// Tout passe par `$executeRaw` / `$queryRaw` avec des PARAMÈTRES LIÉS : aucune concaténation de contenu.
import { Prisma, type PrismaClient } from '@prisma/client';
import { GED_EMBEDDING_DIMENSION } from '@archivage/types';
import type { TextChunk } from './embedding-chunker';

/** Lignes insérées par requête (10 paramètres par ligne, bien sous la limite de 32 767 de PostgreSQL). */
export const CHUNK_INSERT_BATCH = 50;

/** Littéral pgvector `[x,y,...]` ; refuse toute dimension ou valeur invalide. */
export function toVectorLiteral(vector: readonly number[]): string {
  if (vector.length !== GED_EMBEDDING_DIMENSION) {
    throw new Error(`Vecteur de dimension ${vector.length} (attendu ${GED_EMBEDDING_DIMENSION}).`);
  }
  for (const x of vector) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('Vecteur : valeur non finie.');
  }
  return `[${vector.join(',')}]`;
}

export interface ReplaceChunksInput {
  documentId: number;
  versionId: number;
  model: string;
  chunks: readonly TextChunk[];
  vectors: readonly (readonly number[])[];
}

/** Supprime les segments d'un document (document épuré/gelé/sans texte : plus interrogeable). */
export async function deleteDocumentChunks(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  documentId: number,
): Promise<number> {
  return prisma.$executeRaw(
    Prisma.sql`DELETE FROM ged_document_chunk WHERE document_id = ${documentId}`,
  );
}

/**
 * Remplace les segments d'un document dans UNE transaction : DELETE puis INSERT en lots. Les
 * vecteurs sont validés AVANT d'ouvrir la transaction (rien n'est supprimé si l'un est invalide).
 */
export async function replaceDocumentChunks(
  prisma: Pick<PrismaClient, '$transaction'>,
  input: ReplaceChunksInput,
): Promise<number> {
  const { documentId, versionId, model, chunks, vectors } = input;
  if (chunks.length !== vectors.length) {
    throw new Error('Nombre de vecteurs différent du nombre de segments.');
  }
  const literals = vectors.map((v) => toVectorLiteral(v));

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM ged_document_chunk WHERE document_id = ${documentId}`,
    );
    for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
      const rows = chunks.slice(i, i + CHUNK_INSERT_BATCH).map((c, k) => {
        const vec = literals[i + k]!;
        return Prisma.sql`(${documentId}, ${versionId}, ${c.chunkIndex}, ${c.content}, ${c.contentHash}, ${c.tokenCount}, ${c.pageFrom}, ${c.pageTo}, ${vec}::vector, ${model})`;
      });
      await tx.$executeRaw(
        Prisma.sql`INSERT INTO ged_document_chunk (document_id, document_version_id, chunk_index, content, content_hash, token_count, page_from, page_to, embedding, embedding_model) VALUES ${Prisma.join(rows)}`,
      );
    }
    // Réindexation d'un gros document : les délais par défaut de Prisma (2 s d'attente, 5 s
    // d'exécution) sont trop courts pour un DELETE suivi de plusieurs INSERT de vecteurs.
  }, { maxWait: 30_000, timeout: 120_000 });
  return chunks.length;
}

type QueryPrisma = Pick<PrismaClient, '$queryRaw'>;

/** Conditions d'indexabilité : archivé, non épuré (état 3), non gelé. */
const INDEXABLE = Prisma.sql`d.is_archived = true AND d.document_state <> 3 AND d.is_frozen = false`;

/** Page (curseur par identifiant croissant) des documents archivés indexables. */
export async function listIndexableDocumentIds(
  prisma: QueryPrisma,
  opts: { afterId: number; limit: number },
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ documentId: number }>>(
    Prisma.sql`SELECT d.document_id AS "documentId" FROM document d WHERE ${INDEXABLE} AND d.document_id > ${opts.afterId} ORDER BY d.document_id LIMIT ${opts.limit}`,
  );
  return rows.map((r) => Number(r.documentId));
}

/**
 * Documents indexables dont l'index est absent ou périmé pour `model` :
 * - version courante avec texte OCR mais aucun segment de ce modèle sur cette version ;
 * - ou segments rattachés à une autre version que la courante ;
 * - ou `modified_at` postérieur au dernier segment.
 */
export async function listStaleDocumentIds(
  prisma: QueryPrisma,
  opts: { model: string; limit: number },
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ documentId: number }>>(Prisma.sql`
    SELECT d.document_id AS "documentId"
    FROM document d
    JOIN document_version v ON v.document_id = d.document_id AND v.is_current = true
    WHERE ${INDEXABLE}
      AND (
        (
          EXISTS (SELECT 1 FROM document_file f
                  WHERE f.document_version_id = v.document_version_id
                    AND f.ocr_text IS NOT NULL AND btrim(f.ocr_text) <> '')
          AND NOT EXISTS (SELECT 1 FROM ged_document_chunk c
                          WHERE c.document_id = d.document_id
                            AND c.document_version_id = v.document_version_id
                            AND c.embedding_model = ${opts.model})
        )
        OR EXISTS (SELECT 1 FROM ged_document_chunk c
                   WHERE c.document_id = d.document_id
                     AND c.document_version_id IS DISTINCT FROM v.document_version_id)
        OR d.modified_at > (SELECT max(c.created_at) FROM ged_document_chunk c
                            WHERE c.document_id = d.document_id)
      )
    ORDER BY d.document_id
    LIMIT ${opts.limit}`);
  return rows.map((r) => Number(r.documentId));
}

/** Documents qui ont encore des segments alors qu'ils ne sont plus indexables (épurés, gelés, repassés en attente). */
export async function listOrphanChunkDocumentIds(
  prisma: QueryPrisma,
  opts: { limit: number },
): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ documentId: number }>>(Prisma.sql`
    SELECT DISTINCT c.document_id AS "documentId"
    FROM ged_document_chunk c
    JOIN document d ON d.document_id = c.document_id
    WHERE NOT (${INDEXABLE})
    ORDER BY c.document_id
    LIMIT ${opts.limit}`);
  return rows.map((r) => Number(r.documentId));
}
