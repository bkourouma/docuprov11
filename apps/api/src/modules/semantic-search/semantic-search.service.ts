import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  GED_AI_DISABLED_MESSAGE,
  GED_EMBEDDING_JOBS,
  GED_QA_MAX_SEGMENTS,
  GED_QA_MIN_SIMILARITY,
  GED_QA_PROMPT_VERSION,
  GED_QA_UNKNOWN_ANSWER,
  GED_SEMANTIC_DEFAULT_LIMIT,
  GED_SEMANTIC_EXCERPT_MAX_CHARS,
  GED_SEMANTIC_FALLBACK_MESSAGE,
  GedAiDecisionStatus,
  GedAiMode,
  normalizeEmbeddingModel,
  GedAiTask,
  type GedAskRequest,
  type GedAskResponse,
  type GedEmbeddingBulkJobData,
  type GedEmbeddingDocumentJobData,
  type GedSemanticHit,
  type GedSemanticSearchRequest,
  type GedSemanticSearchResponse,
} from '@archivage/types';
import { AiDecisionService } from '../ai/ai-decision.service';
import { AiService } from '../ai/ai.service';
import { AiMaskingRequiredError, AiProviderError, AiUnsupportedInputError } from '../ai/ai.types';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { type DocumentRow, SearchService } from '../search/search.service';
import { GED_EMBEDDING_QUEUE_TOKEN } from './embedding-queue.provider';
import { buildSemanticAccessFilter } from './semantic-access-filter';
import { buildQaRequest, parseQaOutput, type QaSegment, resolveCitations } from './semantic-qa-prompt';
import { buildNearestChunksQuery, type NearestChunkRow } from './semantic-vector.sql';

/** Au plus ce nombre de segments par document dans la recherche. */
export const SEMANTIC_MAX_SEGMENTS_PER_DOCUMENT = 3;
/** Sur-échantillonnage : la déduplication par document écarte des segments. */
const SEARCH_OVERSAMPLE = 3;
const SEARCH_FETCH_MAX = 60;

const SERVICE_UNAVAILABLE_MESSAGE =
  'Le service d’IA est momentanément indisponible. Réessayez plus tard.';

/** Libellé fixe journalisé quand aucune question n'est transmise au modèle. */
const UNSENT_INPUT_LABEL = '[question non transmise : sources insuffisantes]';

type DisabledResult = { disabled: true; message: string };

export function truncateExcerpt(text: string, max = GED_SEMANTIC_EXCERPT_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

@Injectable()
export class SemanticSearchService {
  private readonly logger = new Logger(SemanticSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly decisions: AiDecisionService,
    private readonly fulltext: SearchService,
    @Inject(GED_EMBEDDING_QUEUE_TOKEN) private readonly queue: Queue,
  ) {}

  // --- Recherche -------------------------------------------------------------------------------

  async search(dto: GedSemanticSearchRequest, user: AuthUser): Promise<GedSemanticSearchResponse> {
    const limit = dto.limit ?? GED_SEMANTIC_DEFAULT_LIMIT;
    if (!(await this.ai.status()).enabled) return this.fulltextSearch(dto.query, limit, user);

    const embedded = await this.embedQuery(dto.query);
    if (embedded.disabled) return this.fulltextSearch(dto.query, limit, user);

    const rows = await this.nearestChunks(
      embedded.vector,
      embedded.model,
      user,
      Math.min(limit * SEARCH_OVERSAMPLE, SEARCH_FETCH_MAX),
    );
    return { mode: 'semantic', hits: this.dedupeHits(rows, limit) };
  }

  // --- Questions-réponses ----------------------------------------------------------------------

  async ask(dto: GedAskRequest, user: AuthUser): Promise<GedAskResponse> {
    if (!(await this.ai.status()).enabled) return this.fulltextAsk(dto.question, user);

    const embedded = await this.embedQuery(dto.question);
    if (embedded.disabled) return this.fulltextAsk(dto.question, user);

    // Les droits sont appliqués DANS la requête : seuls des segments autorisés sont lus.
    const rows = await this.nearestChunks(
      embedded.vector,
      embedded.model,
      user,
      GED_QA_MAX_SEGMENTS,
    );
    const segments = this.toQaSegments(rows);

    if (segments.length === 0) {
      const decisionId = await this.recordUnknown(dto.question, user);
      return {
        mode: 'semantic',
        answered: false,
        answer: GED_QA_UNKNOWN_ANSWER,
        citations: [],
        hits: [],
        decisionId,
      };
    }

    const request = buildQaRequest(dto.question, segments);
    let result;
    try {
      // Le masquage est fait par AiService.run : rien n'est envoyé en clair ailleurs.
      result = await this.ai.run({
        task: GedAiTask.Question,
        request: {
          system: request.system,
          text: request.text,
          jsonSchema: request.jsonSchema,
          maxOutputTokens: request.maxOutputTokens,
        },
        parse: parseQaOutput,
        promptVersion: GED_QA_PROMPT_VERSION,
        requestedBy: user.userGroupId,
        autoApply: false,
        documentId: null,
      });
    } catch (e) {
      throw this.toUnavailable(e);
    }
    if (result.disabled) return this.fulltextAsk(dto.question, user);

    const resolved = resolveCitations(result.data, segments);
    return {
      mode: 'semantic',
      answered: resolved.answered,
      answer: resolved.answer,
      citations: resolved.citations,
      hits: [],
      decisionId: result.decisionId != null ? result.decisionId.toString() : null,
    };
  }

  // --- Réindexation (administrateurs) ----------------------------------------------------------

  async reindexAll(user: AuthUser): Promise<DisabledResult | { queued: true }> {
    this.assertAdmin(user);
    if (!(await this.ai.status()).enabled) return { disabled: true, message: GED_AI_DISABLED_MESSAGE };
    const data: GedEmbeddingBulkJobData = { requestedBy: user.userGroupId };
    await this.queue.add(GED_EMBEDDING_JOBS.reindexAll, data, this.jobOptions('reindex-all'));
    return { queued: true };
  }

  async reindexDocument(
    documentId: number,
    user: AuthUser,
  ): Promise<DisabledResult | { queued: true }> {
    this.assertAdmin(user);
    if (!(await this.ai.status()).enabled) return { disabled: true, message: GED_AI_DISABLED_MESSAGE };
    const data: GedEmbeddingDocumentJobData = { documentId, requestedBy: user.userGroupId };
    await this.queue.add(
      GED_EMBEDDING_JOBS.reindexDocument,
      data,
      this.jobOptions(`reindex-document-${documentId}`),
    );
    return { queued: true };
  }

  // --- Internes --------------------------------------------------------------------------------

  /**
   * `jobId` stable (sans ':') : une demande identique en cours n'est pas dupliquée. Les jobs
   * terminés sont supprimés aussitôt (sinon leur id bloquerait toute nouvelle demande) ; les
   * échecs sont conservés 5 min au plus (100 au maximum), pendant lesquelles le même id est refusé.
   */
  private jobOptions(jobId: string) {
    return {
      jobId,
      removeOnComplete: true,
      removeOnFail: { age: 300, count: 100 },
    };
  }

  private assertAdmin(user: AuthUser): void {
    if (!user.isAdmin) throw new ForbiddenException('Réservé aux administrateurs');
  }

  private async embedQuery(
    text: string,
  ): Promise<{ disabled: true } | { disabled: false; vector: number[]; model: string }> {
    try {
      const res = await this.ai.embed([text]);
      if (res.disabled) return { disabled: true };
      // Même normalisation que le worker (trim, vide => défaut) : le filtre SQL compare par égalité.
      const cloud = (await this.ai.getEffectiveConfig()).mode === GedAiMode.Cloud;
      return {
        disabled: false,
        vector: res.vectors[0],
        model: normalizeEmbeddingModel(res.model, cloud),
      };
    } catch (e) {
      throw this.toUnavailable(e);
    }
  }

  /** 503 générique : ni texte de question, ni message du fournisseur, ni clé. */
  private toUnavailable(e: unknown): HttpException {
    if (e instanceof HttpException) return e;
    const known =
      e instanceof AiProviderError ||
      e instanceof AiMaskingRequiredError ||
      e instanceof AiUnsupportedInputError;
    this.logger.warn(
      `Appel IA en échec (${known ? (e as Error).name : e instanceof Error ? e.name : 'erreur inconnue'}).`,
    );
    return new HttpException(SERVICE_UNAVAILABLE_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
  }

  /**
   * Segments les plus proches, filtrés par droits, dans UNE transaction interactive.
   *
   * Avec un index HNSW, le filtre (droits, version courante) est appliqué APRÈS le parcours de
   * l'index : sans balayage itératif (pgvector >= 0.8), il peut renvoyer trop peu de lignes.
   * Dans une transaction Postgres, une erreur annule tout : on ne tente donc JAMAIS un
   * `SET LOCAL` à l'aveugle. On lit d'abord `current_setting('hnsw.iterative_scan', true)`, qui
   * vaut NULL quand le réglage n'existe pas (pgvector < 0.8, ou bibliothèque non encore chargée
   * dans cette session : cas conservateur, la recherche reste correcte mais sans itération), et
   * on ne fait le `SET LOCAL` (limité à la transaction) que si la valeur n'est pas NULL.
   */
  private async nearestChunks(
    vector: number[],
    embeddingModel: string,
    user: AuthUser,
    limit: number,
  ): Promise<NearestChunkRow[]> {
    const query = buildNearestChunksQuery({
      queryVector: vector,
      embeddingModel,
      accessFilter: buildSemanticAccessFilter(user),
      limit,
    });
    return this.prisma.$transaction(async (tx) => {
      // Force le chargement de la bibliothèque pgvector dans la session : sans cela,
      // `current_setting` renvoie NULL tant qu'aucune expression vector n'a été évaluée.
      await tx.$queryRaw(Prisma.sql`SELECT '[1]'::vector`);
      const setting = await tx.$queryRaw<Array<{ value: string | null }>>(
        Prisma.sql`SELECT current_setting('hnsw.iterative_scan', true) AS value`,
      );
      if (setting[0]?.value != null) {
        await tx.$executeRaw(Prisma.sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
      }
      return tx.$queryRaw<NearestChunkRow[]>(query);
    });
  }

  /** Au plus 3 segments par document, meilleur score d'abord ; extraits tronqués. */
  private dedupeHits(rows: NearestChunkRow[], limit: number): GedSemanticHit[] {
    const perDocument = new Map<number, number>();
    const hits: GedSemanticHit[] = [];
    const sorted = [...rows].sort((a, b) => Number(b.score) - Number(a.score));
    for (const r of sorted) {
      const n = perDocument.get(r.document_id) ?? 0;
      if (n >= SEMANTIC_MAX_SEGMENTS_PER_DOCUMENT) continue;
      perDocument.set(r.document_id, n + 1);
      hits.push({
        documentId: r.document_id,
        documentLabel: r.label,
        versionId: r.document_version_id,
        versionNumber: r.version_number,
        pageFrom: r.page_from,
        pageTo: r.page_to,
        chunkIndex: r.chunk_index,
        excerpt: truncateExcerpt(r.content),
        score: Number(r.score),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Seuil de similarité (QA seulement), 8 segments au plus, numérotés 1..n. */
  private toQaSegments(rows: NearestChunkRow[]): QaSegment[] {
    return [...rows]
      .sort((a, b) => Number(b.score) - Number(a.score))
      .filter((r) => Number(r.score) >= GED_QA_MIN_SIMILARITY)
      .slice(0, GED_QA_MAX_SEGMENTS)
      .map((r, i) => ({
        marker: i + 1,
        documentId: r.document_id,
        documentLabel: r.label,
        versionId: r.document_version_id,
        versionNumber: r.version_number,
        pageFrom: r.page_from,
        pageTo: r.page_to,
        content: r.content,
      }));
  }

  /** Repli plein texte : même logique et mêmes droits que la recherche documentaire, sans total. */
  private async fulltextHits(query: string, limit: number, user: AuthUser): Promise<GedSemanticHit[]> {
    const res = await this.fulltext.search({ fullText: query, page: 1, pageSize: limit }, user);
    return res.rows.map((row) => this.rowToHit(row));
  }

  private rowToHit(row: DocumentRow): GedSemanticHit {
    return {
      documentId: row.documentId,
      documentLabel: row.label,
      versionId: null,
      versionNumber: null,
      pageFrom: null,
      pageTo: null,
      chunkIndex: null,
      excerpt: truncateExcerpt(row.cote ? `${row.label} (${row.cote})` : row.label),
      score: null,
    };
  }

  private async fulltextSearch(
    query: string,
    limit: number,
    user: AuthUser,
  ): Promise<GedSemanticSearchResponse> {
    return {
      mode: 'fulltext',
      message: GED_SEMANTIC_FALLBACK_MESSAGE,
      hits: await this.fulltextHits(query, limit, user),
    };
  }

  private async fulltextAsk(question: string, user: AuthUser): Promise<GedAskResponse> {
    return {
      mode: 'fulltext',
      answered: false,
      answer: '',
      citations: [],
      hits: await this.fulltextHits(question, GED_SEMANTIC_DEFAULT_LIMIT, user),
      message: GED_SEMANTIC_FALLBACK_MESSAGE,
      decisionId: null,
    };
  }

  /**
   * « Je ne sais pas » sans appel au modèle : décision journalisée avec un libellé FIXE (jamais le
   * texte de la question, qui n'a pas été masqué) + longueur et empreinte SHA-256 de la question.
   * Un échec du journal ne fait jamais échouer la requête.
   */
  private async recordUnknown(question: string, user: AuthUser): Promise<string | null> {
    try {
      const config = await this.ai.getEffectiveConfig();
      const digest = createHash('sha256').update(question).digest('hex');
      const id = await this.decisions.record({
        task: GedAiTask.Question,
        mode: config.mode === GedAiMode.Cloud ? 2 : 1,
        provider: config.provider,
        model: config.model ?? 'n/a',
        promptVersion: GED_QA_PROMPT_VERSION,
        inputText: `${UNSENT_INPUT_LABEL} longueur=${question.length} sha256=${digest}`,
        inputMasked: false,
        output: { answerable: false, answer: GED_QA_UNKNOWN_ANSWER, citations: [] },
        confidence: null,
        status: GedAiDecisionStatus.Proposee,
        documentId: null,
        requestedBy: user.userGroupId,
      });
      return id.toString();
    } catch (e) {
      this.logger.warn(
        `Écriture du journal IA impossible (${e instanceof Error ? e.name : 'erreur inconnue'}).`,
      );
      return null;
    }
  }
}
