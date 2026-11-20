import { Prisma } from '@prisma/client';
import { GED_EMBEDDING_DIMENSION } from '@archivage/types';

/**
 * Format texte pgvector d'un vecteur : `[0.1,0.2,...]`. Refuse toute valeur qui ne serait pas un
 * nombre fini et toute longueur différente de la dimension de l'index : le littéral est lié comme
 * PARAMÈTRE (`$n::vector`), jamais concaténé, mais on garantit qu'il reste bien formé.
 */
export function toVectorLiteral(vector: number[]): string {
  if (!Array.isArray(vector) || vector.length !== GED_EMBEDDING_DIMENSION) {
    throw new Error(`Vecteur invalide : ${GED_EMBEDDING_DIMENSION} composantes attendues.`);
  }
  for (const v of vector) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error('Vecteur invalide : composante non finie.');
    }
  }
  return `[${vector.join(',')}]`;
}

/** Ligne brute renvoyée par `buildNearestChunksQuery`. */
export interface NearestChunkRow {
  ged_document_chunk_id: bigint;
  document_id: number;
  document_version_id: number | null;
  chunk_index: number;
  content: string;
  page_from: number | null;
  page_to: number | null;
  label: string;
  version_number: number | null;
  /** Similarité cosinus (1 - distance). */
  score: number;
}

export interface NearestChunksQueryInput {
  queryVector: number[];
  embeddingModel: string;
  /** Expression booléenne sur l'alias `d` (`buildSemanticAccessFilter`). */
  accessFilter: Prisma.Sql;
  limit: number;
}

/**
 * Requête des segments les plus proches (distance cosinus, index HNSW `vector_cosine_ops`).
 *
 * - Le filtre de DROITS est dans le WHERE de cette même requête, jamais appliqué après coup :
 *   un segment interdit n'est donc jamais lu par l'application.
 * - Seuls les segments de la version COURANTE (`document_version.is_current`) remontent.
 * - Vecteur, modèle et limite sont des paramètres liés. Le vecteur apparaît deux fois (score et
 *   tri) : le tri doit rester `ORDER BY c.embedding <=> $vec` pour que l'index soit utilisable.
 */
export function buildNearestChunksQuery(input: NearestChunksQueryInput): Prisma.Sql {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new Error('Limite invalide.');
  }
  const vec = toVectorLiteral(input.queryVector);
  return Prisma.sql`
    SELECT c.ged_document_chunk_id, c.document_id, c.document_version_id, c.chunk_index,
           c.content, c.page_from, c.page_to, d.label, dv.version_number,
           1 - (c.embedding <=> ${vec}::vector) AS score
    FROM ged_document_chunk c
    JOIN document d ON d.document_id = c.document_id
    JOIN document_version dv ON dv.document_version_id = c.document_version_id
                          AND dv.document_id = c.document_id
    WHERE c.embedding_model = ${input.embeddingModel}
      AND c.document_id IS NOT NULL
      AND dv.is_current = true
      AND (${input.accessFilter})
    ORDER BY c.embedding <=> ${vec}::vector
    LIMIT ${input.limit}`;
}
