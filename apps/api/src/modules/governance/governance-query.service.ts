import { createHash } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  DocumentState,
  GED_GOVERNANCE_AI_OFF_MESSAGE,
  GED_GOVERNANCE_BATCH_SIZE,
  GED_GOVERNANCE_JOBS,
  GED_GOVERNANCE_PROMPT_VERSION,
  GOVERNANCE_KIND_VALUES,
  GOVERNANCE_STATUSES,
  GovernanceKind,
  parseGovernanceOutput,
  type GedGovernanceBatchJobData,
  type GedGovernanceDocumentJobData,
  type GovernanceAnalyzeRequest,
  type GovernanceAnalyzeResponse,
  type GovernanceDashboard,
  type GovernanceDocumentSummary,
  type GovernanceKindCounts,
  type GovernanceListQuery,
  type GovernanceOutput,
  type GovernanceProposalDetail,
  type GovernanceProposalPage,
  type GovernanceProposalView,
  type GovernanceStatus,
} from '@archivage/types';
import { AiService } from '../ai/ai.service';
import type { AuthUser } from '../auth/auth.types';
import { DocumentsService } from '../documents/documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildGovernanceAccessFilter, buildProposalVisibilityFilter } from './governance-access-filter';
import { GED_GOVERNANCE_QUEUE_TOKEN } from './governance-queue.provider';

/** Tâches IA sous lesquelles sont consignées les propositions (cf. `GOVERNANCE_KIND_TASK`). */
const GOVERNANCE_TASKS = [5, 7] as const;
/** Longueur maximale de l'aperçu de synthèse renvoyé dans la comparaison. */
export const GOVERNANCE_OVERVIEW_EXCERPT_CHARS = 300;
/** Longueur maximale de l'extrait d'entrée (déjà masqué et tronqué par le journal du socle IA). */
const INPUT_EXCERPT_MAX_CHARS = 500;
const NOT_FOUND_MESSAGE = 'Proposition introuvable.';
const DOC_NOT_FOUND_MESSAGE = 'Document introuvable.';

interface DecisionRow {
  ged_ai_decision_id: bigint;
  document_id: number | null;
  provider: string | null;
  model: string;
  input_excerpt: string | null;
  input_masked: boolean;
  output: unknown;
  confidence: Prisma.Decimal | number | string | null;
  status: number;
  validated_by: number | null;
  validated_at: Date | null;
  created_at: Date;
}

interface ParsedRow {
  row: DecisionRow;
  output: GovernanceOutput;
}

interface DashboardRow {
  kind: string | null;
  status: number | null;
  n: number | bigint;
  open_groups: number | bigint;
}

const DUPLICATE_KINDS = [GovernanceKind.DoublonExact, GovernanceKind.QuasiDoublon];

/**
 * Conditions SQL peu coûteuses reproduisant l'ESSENTIEL de `parseGovernanceOutput` (le filtrage Node
 * reste en défense en profondeur). Chaque transtypage est évité (comparaisons textuelles et
 * `jsonb_typeof`), et les accès dépendants sont gardés par `CASE` : jamais d'erreur SQL sur un
 * `output` mal formé.
 *
 * DIVERGENCE RÉSIDUELLE (assumée) : SQL ne contrôle PAS les champs secondaires du schéma zod strict
 * (clés inconnues, `method`, `similarity`, `groupKey`, `proposedAction`, `applied`, bornes de
 * `score` / `proposedRank` / `reasons`, détail des éléments de `findings`, `detection`). Une ligne
 * invalide sur ces seuls points est donc comptée par `total` et le tableau de bord mais écartée par
 * la liste Node : l'écart ne peut être que d'un EN PLUS dans les compteurs, jamais d'un en moins.
 * `withDocumentLink` (faux pour la revue d'orphelin) omet `duplicateDocumentId = document_id`.
 */
function validityCondition(withDocumentLink: boolean): Prisma.Sql {
  const positiveInt = (field: string) =>
    Prisma.raw(
      `(jsonb_typeof(a.output->'${field}') = 'number' AND a.output->>'${field}' ~ '^[1-9][0-9]{0,9}$')`,
    );
  const duplicateLink = withDocumentLink
    ? Prisma.sql`AND a.document_id IS NOT NULL AND a.output->>'duplicateDocumentId' = a.document_id::text`
    : Prisma.empty;
  return Prisma.sql`(
    jsonb_typeof(a.output) = 'object'
    AND jsonb_typeof(a.output->'schemaVersion') = 'number'
    AND a.output->>'schemaVersion' = '1'
    AND (
      (
        a.output->>'kind' IN (${Prisma.join(DUPLICATE_KINDS)})
        AND ${positiveInt('duplicateDocumentId')}
        AND ${positiveInt('originalDocumentId')}
        ${duplicateLink}
      )
      OR (
        a.output->>'kind' = ${GovernanceKind.Sensibilite}
        AND ${positiveInt('proposedConfidentialiteId')}
      )
      OR (
        a.output->>'kind' = ${GovernanceKind.DonneesPersonnelles}
        AND CASE WHEN jsonb_typeof(a.output->'findings') = 'array'
                 THEN jsonb_array_length(a.output->'findings') > 0
                 ELSE FALSE END
      )
    )
  )`;
}

function emptyCounts(): GovernanceKindCounts {
  return { proposee: 0, validee: 0, rejetee: 0, total: 0 };
}

function addCount(counts: GovernanceKindCounts, status: number, n: number): void {
  if (status === 0) counts.proposee += n;
  else if (status === 1) counts.validee += n;
  else if (status === 2) counts.rejetee += n;
  else return;
  counts.total += n;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function toNumber(value: number | bigint | null | undefined): number {
  return value == null ? 0 : Number(value);
}

@Injectable()
export class GovernanceQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly ai: AiService,
    @Inject(GED_GOVERNANCE_QUEUE_TOKEN) private readonly queue: Queue,
  ) {}

  // --- Lecture ---------------------------------------------------------------------------------

  /**
   * Périmètre OBLIGATOIRE (propositions de gouvernance dans un statut affiché), VALIDITÉ de `output`
   * (voir `validityCondition`) ET visibilité de l'utilisateur (document concerné + original, via
   * `buildProposalVisibilityFilter`). Toute requête brute vers `ged_ai_decision` de ce service passe
   * par ici : le même WHERE sert à la liste, au COUNT, au détail et au tableau de bord, de sorte que
   * ce que SQL compte est ce que la liste renvoie.
   *
   * `adminReview` (lecture réservée à la revue d'un orphelin par un administrateur) retire la
   * visibilité et le lien `duplicateDocumentId = document_id` (NULL pour un orphelin), jamais le
   * périmètre ni la validité.
   */
  private scopeWhere(
    user: AuthUser,
    extra: Prisma.Sql[] = [],
    opts: { adminReview?: boolean } = {},
  ): Prisma.Sql {
    const adminReview = opts.adminReview === true;
    const conditions: Prisma.Sql[] = [
      Prisma.sql`a.prompt_version = ${GED_GOVERNANCE_PROMPT_VERSION}`,
      Prisma.sql`a.task IN (${Prisma.join([...GOVERNANCE_TASKS])})`,
      Prisma.sql`a.status IN (${Prisma.join([...GOVERNANCE_STATUSES])})`,
      Prisma.sql`a.output->>'kind' IN (${Prisma.join([...GOVERNANCE_KIND_VALUES])})`,
      validityCondition(!adminReview),
      ...(adminReview ? [] : [Prisma.sql`(${buildProposalVisibilityFilter(user, 'a')})`]),
      ...extra,
    ];
    return Prisma.join(conditions, ' AND ');
  }

  async list(query: GovernanceListQuery, user: AuthUser): Promise<GovernanceProposalPage> {
    const extra: Prisma.Sql[] = [];
    if (query.kind !== undefined) extra.push(Prisma.sql`a.output->>'kind' = ${query.kind}`);
    if (query.status !== undefined) extra.push(Prisma.sql`a.status = ${query.status}`);
    if (query.documentId !== undefined) extra.push(Prisma.sql`a.document_id = ${query.documentId}`);
    if (query.groupKey !== undefined) extra.push(Prisma.sql`a.output->>'groupKey' = ${query.groupKey}`);
    if (query.minConfidence !== undefined) extra.push(Prisma.sql`a.confidence >= ${query.minConfidence}`);
    const where = this.scopeWhere(user, extra);

    const offset = (query.page - 1) * query.pageSize;
    const rows = await this.prisma.$queryRaw<DecisionRow[]>(Prisma.sql`
      SELECT a.ged_ai_decision_id, a.document_id, a.provider, a.model, a.input_excerpt,
             a.input_masked, a.output, a.confidence, a.status, a.validated_by, a.validated_at,
             a.created_at
        FROM ged_ai_decision a
       WHERE ${where}
       ORDER BY a.created_at DESC, a.ged_ai_decision_id DESC
       LIMIT ${query.pageSize} OFFSET ${offset}`);
    const counted = await this.prisma.$queryRaw<{ total: number | bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS total
        FROM ged_ai_decision a
       WHERE ${where}`);

    const parsed = this.parseRows(rows);
    return {
      items: await this.toViews(parsed),
      total: toNumber(counted[0]?.total),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: number, user: AuthUser): Promise<GovernanceProposalDetail> {
    const where = this.scopeWhere(user, [Prisma.sql`a.ged_ai_decision_id = ${BigInt(id)}`]);
    const rows = await this.prisma.$queryRaw<DecisionRow[]>(Prisma.sql`
      SELECT a.ged_ai_decision_id, a.document_id, a.provider, a.model, a.input_excerpt,
             a.input_masked, a.output, a.confidence, a.status, a.validated_by, a.validated_at,
             a.created_at
        FROM ged_ai_decision a
       WHERE ${where}
       LIMIT 1`);
    const [parsed] = this.parseRows(rows);
    if (!parsed) throw new NotFoundException(NOT_FOUND_MESSAGE);

    const [view] = await this.toViews([parsed]);
    let comparison: GovernanceProposalDetail['comparison'] = null;
    const output = parsed.output;
    if (output.kind === GovernanceKind.DoublonExact || output.kind === GovernanceKind.QuasiDoublon) {
      const [original, duplicate] = await Promise.all([
        this.documentSummary(output.originalDocumentId),
        this.documentSummary(output.duplicateDocumentId),
      ]);
      if (original && duplicate) comparison = { original, duplicate };
    }
    return { ...view, comparison };
  }

  /**
   * Vue d'une proposition pour la réponse de REJET d'un orphelin (document ou original supprimé),
   * réservée à un administrateur humain. Sans filtre de visibilité (un orphelin est invisible pour
   * tous), mais toujours avec le périmètre gouvernance et un `output` valide. Aucune comparaison ;
   * les libellés d'un document supprimé valent `null` (rien n'est lu pour lui). 404 uniforme sinon.
   */
  async getForAdminReview(id: number, user: AuthUser): Promise<GovernanceProposalView> {
    if (user?.isAdmin !== true || user.isScanAgent === true) throw new NotFoundException(NOT_FOUND_MESSAGE);
    const where = this.scopeWhere(user, [Prisma.sql`a.ged_ai_decision_id = ${BigInt(id)}`], {
      adminReview: true,
    });
    const rows = await this.prisma.$queryRaw<DecisionRow[]>(Prisma.sql`
      SELECT a.ged_ai_decision_id, a.document_id, a.provider, a.model, a.input_excerpt,
             a.input_masked, a.output, a.confidence, a.status, a.validated_by, a.validated_at,
             a.created_at
        FROM ged_ai_decision a
       WHERE ${where}
       LIMIT 1`);
    const [parsed] = this.parseRows(rows);
    if (!parsed) throw new NotFoundException(NOT_FOUND_MESSAGE);
    const [view] = await this.toViews([parsed]);
    return view;
  }

  /**
   * Un SEUL GROUP BY sur (kind, status) avec le même périmètre + visibilité que la liste : un
   * gestionnaire ne compte que ce qu'il peut voir. Le jeu de regroupement vide (`()`) fournit, dans
   * la même requête, le nombre de groupes de doublons distincts encore ouverts (un `groupKey` peut
   * être partagé par un doublon exact et un quasi-doublon : on ne somme pas les lignes).
   */
  async dashboard(user: AuthUser): Promise<GovernanceDashboard> {
    const where = this.scopeWhere(user);
    const rows = await this.prisma.$queryRaw<DashboardRow[]>(Prisma.sql`
      SELECT a.output->>'kind' AS kind,
             a.status AS status,
             COUNT(*)::int AS n,
             COUNT(DISTINCT a.output->>'groupKey') FILTER (
               WHERE a.status = 0 AND a.output->>'kind' IN (${Prisma.join(DUPLICATE_KINDS)})
             )::int AS open_groups
        FROM ged_ai_decision a
       WHERE ${where}
       GROUP BY GROUPING SETS ((a.output->>'kind', a.status), ())`);

    const byKind = Object.fromEntries(
      GOVERNANCE_KIND_VALUES.map((kind) => [kind, emptyCounts()]),
    ) as Record<GovernanceKind, GovernanceKindCounts>;
    const totals = emptyCounts();
    let openDuplicateGroups = 0;
    for (const row of rows) {
      if (row.kind === null && row.status === null) {
        openDuplicateGroups = toNumber(row.open_groups);
        continue;
      }
      const counts = byKind[row.kind as GovernanceKind];
      if (!counts || row.status === null) continue;
      const n = toNumber(row.n);
      addCount(counts, Number(row.status), n);
      addCount(totals, Number(row.status), n);
    }

    const status = await this.ai.status();
    return {
      aiEnabled: status.enabled,
      aiMessage: status.enabled ? null : GED_GOVERNANCE_AI_OFF_MESSAGE,
      byKind,
      totals,
      openDuplicateGroups,
      generatedAt: new Date().toISOString(),
    };
  }

  // --- Analyse ---------------------------------------------------------------------------------

  async analyze(request: GovernanceAnalyzeRequest, user: AuthUser): Promise<GovernanceAnalyzeResponse> {
    let queued = 0;
    let ignored = 0;

    if ('all' in request) {
      if (!user.isAdmin) throw new ForbiddenException('Réservé aux administrateurs');
      const counted = await this.prisma.$queryRaw<{ total: number | bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS total
          FROM document d
         WHERE d.is_archived = true AND d.document_state <> ${DocumentState.Epure}`);
      const data: GedGovernanceBatchJobData = { scope: 'all', requestedBy: user.userGroupId };
      await this.enqueue(GED_GOVERNANCE_JOBS.analyzeBatch, data, 'governance-all');
      queued = toNumber(counted[0]?.total);
    } else if ('documentId' in request) {
      const id = request.documentId;
      if (!(await this.documents.canAccess(id, user))) throw new NotFoundException(DOC_NOT_FOUND_MESSAGE);
      const retained = await this.analyzableIds([id], user, false);
      if (retained.length === 0) throw new NotFoundException(DOC_NOT_FOUND_MESSAGE);
      const data: GedGovernanceDocumentJobData = { documentId: id, requestedBy: user.userGroupId };
      await this.enqueue(GED_GOVERNANCE_JOBS.analyzeDocument, data, `governance-doc-${id}`);
      queued = 1;
    } else {
      const submitted = [...new Set(request.documentIds)];
      const retained = await this.analyzableIds(submitted, user, true);
      ignored = submitted.length - retained.length;
      for (let i = 0; i < retained.length; i += GED_GOVERNANCE_BATCH_SIZE) {
        const chunk = retained.slice(i, i + GED_GOVERNANCE_BATCH_SIZE);
        const data: GedGovernanceBatchJobData = {
          scope: 'documents',
          documentIds: chunk,
          requestedBy: user.userGroupId,
        };
        const digest = createHash('sha1').update(chunk.join(',')).digest('hex').slice(0, 16);
        await this.enqueue(GED_GOVERNANCE_JOBS.analyzeBatch, data, `governance-batch-${digest}`);
      }
      queued = retained.length;
    }

    const status = await this.ai.status();
    return {
      queued,
      ignored,
      aiEnabled: status.enabled,
      message: status.enabled ? null : GED_GOVERNANCE_AI_OFF_MESSAGE,
    };
  }

  // --- Internes --------------------------------------------------------------------------------

  /**
   * Documents analysables : archivés, non épurés ; avec `withAccess`, en plus ouvrables par
   * l'utilisateur (filtre en SQL, jamais après coup).
   */
  private async analyzableIds(ids: number[], user: AuthUser, withAccess: boolean): Promise<number[]> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`d.document_id IN (${Prisma.join(ids)})`,
      Prisma.sql`d.is_archived = true`,
      Prisma.sql`d.document_state <> ${DocumentState.Epure}`,
    ];
    if (withAccess) conditions.push(Prisma.sql`(${buildGovernanceAccessFilter(user, 'd')})`);
    const rows = await this.prisma.$queryRaw<{ document_id: number }[]>(Prisma.sql`
      SELECT d.document_id
        FROM document d
       WHERE ${Prisma.join(conditions, ' AND ')}
       ORDER BY d.document_id`);
    return rows.map((r) => Number(r.document_id));
  }

  /**
   * `jobId` stable (sans ':') : une demande identique en cours n'est pas dupliquée. Les jobs
   * terminés ou en échec sont supprimés aussitôt (sinon leur id bloquerait toute relance).
   */
  private enqueue(name: string, data: object, jobId: string): Promise<unknown> {
    return this.queue.add(name, data, { jobId, removeOnComplete: true, removeOnFail: true });
  }

  /** Les lignes dont `output` n'est pas une proposition valide sont ignorées. */
  private parseRows(rows: DecisionRow[]): ParsedRow[] {
    const parsed: ParsedRow[] = [];
    for (const row of rows) {
      const output = parseGovernanceOutput(row.output);
      if (output) parsed.push({ row, output });
    }
    return parsed;
  }

  /** Étiquettes lues APRÈS la requête, uniquement pour les identifiants de la page (déjà visibles). */
  private async toViews(parsed: ParsedRow[]): Promise<GovernanceProposalView[]> {
    if (parsed.length === 0) return [];
    const documentIds = new Set<number>();
    const confIds = new Set<number>();
    for (const { row, output } of parsed) {
      if (row.document_id != null) documentIds.add(row.document_id);
      if (output.kind === GovernanceKind.DoublonExact || output.kind === GovernanceKind.QuasiDoublon) {
        documentIds.add(output.originalDocumentId);
      } else if (output.kind === GovernanceKind.Sensibilite) {
        if (output.currentConfidentialiteId != null) confIds.add(output.currentConfidentialiteId);
        confIds.add(output.proposedConfidentialiteId);
      }
    }

    const docs = await this.prisma.document.findMany({
      where: { documentId: { in: [...documentIds] } },
      select: { documentId: true, label: true, confidentialiteId: true },
    });
    const docById = new Map(docs.map((d) => [d.documentId, d]));
    // Rang vivant : la confidentialité COURANTE du document peut avoir changé depuis la proposition.
    for (const d of docs) if (d.confidentialiteId != null) confIds.add(d.confidentialiteId);
    const confs = await this.prisma.confidentialite.findMany({
      where: { confidentialiteId: { in: [...confIds] } },
      select: { confidentialiteId: true, label: true, rank: true },
    });
    const confById = new Map(confs.map((c) => [c.confidentialiteId, c]));

    return parsed.map(({ row, output }) => {
      const doc = row.document_id != null ? docById.get(row.document_id) : undefined;
      const confidence = row.confidence == null ? null : Number(row.confidence);

      let groupKey: string | null = null;
      let originalId: number | null = null;
      let currentLabel: string | null = null;
      let proposedLabel: string | null = null;
      let requiresLowering = false;

      if (output.kind === GovernanceKind.DoublonExact || output.kind === GovernanceKind.QuasiDoublon) {
        groupKey = output.groupKey;
        originalId = output.originalDocumentId;
      } else if (output.kind === GovernanceKind.Sensibilite) {
        currentLabel =
          output.currentConfidentialiteId != null
            ? (confById.get(output.currentConfidentialiteId)?.label ?? null)
            : null;
        const proposed = confById.get(output.proposedConfidentialiteId);
        proposedLabel = proposed?.label ?? null;
        const proposedRank = proposed?.rank ?? output.proposedRank;
        const live = doc?.confidentialiteId != null ? confById.get(doc.confidentialiteId) : undefined;
        if (!doc) requiresLowering = true; // document introuvable : en cas de doute, confirmation exigée
        else if (doc.confidentialiteId == null) requiresLowering = false; // aucun niveau : pose = élévation
        else if (!live) requiresLowering = true; // niveau courant introuvable : doute
        else requiresLowering = proposedRank < live.rank;
      }

      return {
        id: row.ged_ai_decision_id.toString(),
        kind: output.kind,
        status: Number(row.status) as GovernanceStatus,
        confidence: confidence !== null && Number.isFinite(confidence) ? confidence : null,
        documentId: row.document_id,
        documentLabel: doc?.label ?? null,
        originalDocumentId: originalId,
        originalDocumentLabel: originalId != null ? (docById.get(originalId)?.label ?? null) : null,
        groupKey,
        currentConfidentialiteLabel: currentLabel,
        proposedConfidentialiteLabel: proposedLabel,
        excerpt: row.input_excerpt == null ? null : truncate(row.input_excerpt, INPUT_EXCERPT_MAX_CHARS),
        output,
        provider: row.provider,
        model: row.model,
        inputMasked: row.input_masked,
        createdAt: row.created_at.toISOString(),
        validatedBy: row.validated_by,
        validatedAt: row.validated_at ? row.validated_at.toISOString() : null,
        requiresLoweringConfirmation: requiresLowering,
      };
    });
  }

  /** Résumé d'un document (version courante) pour la comparaison côte à côte. */
  private async documentSummary(documentId: number): Promise<GovernanceDocumentSummary | null> {
    const doc = await this.prisma.document.findUnique({
      where: { documentId },
      select: {
        documentId: true,
        label: true,
        cote: true,
        documentDate: true,
        createdAt: true,
        isFrozen: true,
        overview: true,
        documentType: { select: { label: true } },
        confidentialite: { select: { label: true } },
        versions: {
          where: { isCurrent: true },
          take: 1,
          select: { files: { select: { byteLength: true, pageCount: true } } },
        },
      },
    });
    if (!doc) return null;
    const files = doc.versions[0]?.files ?? [];
    const pages = files.filter((f) => f.pageCount != null);
    const sizes = files.filter((f) => f.byteLength != null);
    return {
      documentId: doc.documentId,
      label: doc.label,
      cote: doc.cote,
      documentDate: doc.documentDate ? doc.documentDate.toISOString().slice(0, 10) : null,
      documentTypeLabel: doc.documentType?.label ?? null,
      confidentialiteLabel: doc.confidentialite?.label ?? null,
      createdAt: doc.createdAt.toISOString(),
      fileCount: files.length,
      pageCount: pages.length ? pages.reduce((s, f) => s + (f.pageCount ?? 0), 0) : null,
      byteLength: sizes.length ? sizes.reduce((s, f) => s + Number(f.byteLength), 0) : null,
      overviewExcerpt: doc.overview ? truncate(doc.overview, GOVERNANCE_OVERVIEW_EXCERPT_CHARS) : null,
      isFrozen: doc.isFrozen,
    };
  }
}
