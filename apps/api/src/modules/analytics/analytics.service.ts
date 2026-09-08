import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { AnalyticsFilterDto, AnalyticsTargetsDto } from './analytics.dto';

// ---- Formes de réponse (contrat consommé par apps/web) ----

export interface KpiBlock {
  totalDocuments: number;
  documentsArchived: number; // is_archived = true (validés)
  documentsPending: number; // is_archived = false (en attente QA)
  documentsFrozen: number; // is_frozen = true (gelés)
  totalPages: number;
  totalBytes: number;
  periodDocuments: number;
  previousPeriodDocuments: number;
  indexationRate: number; // 0..1
  anomalies: { sansType: number; sansDossier: number; sansDate: number; sansCote: number };
}

export interface TimelinePoint {
  bucket: string; // 'YYYY-MM-DD'
  count: number; // production de la période
  cumulative: number; // fonds cumulé (baseline + cumul de la fenêtre)
}

export interface DistributionSlice {
  name: string;
  value: number;
}

export interface TreemapNode {
  id: number;
  name: string;
  value: number; // documents du sous-arbre (rollup via path)
}

export interface ObjectiveBlock {
  hasTarget: boolean;
  metric: 'documents' | 'pages';
  target: number;
  realized: number;
  pct: number; // 0..1
  dayOfMonth: number;
  daysInMonth: number;
  projectedEndOfMonth: number; // au rythme courant
  requiredDailyRate: number; // pour tenir la cible sur les jours restants
}

export interface PipelineBlock {
  total: number;
  termines: number;
  echecs: number;
  ouverts: number;
  failureRate: number; // 0..1
}

export interface AnalyticsOverview {
  period: { from: string; to: string; previousFrom: string; previousTo: string };
  basis: 'created_at' | 'document_date' | 'validated_at';
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
  kpis: KpiBlock;
  timeline: TimelinePoint[];
  objective: ObjectiveBlock;
  byType: DistributionSlice[];
  byLocation: DistributionSlice[];
  byPlan: DistributionSlice[];
  byProgramme: TreemapNode[];
  pipeline: PipelineBlock;
}

/** Une cible « objectif vs réalisé » (consommé par la section Objectifs du dashboard). */
export interface TargetRow {
  targetId: number;
  scope: 'global' | 'programme' | 'type';
  scopeRefId: number | null;
  scopeLabel: string; // « Global », ou libellé du dossier / type
  metric: 'documents' | 'pages';
  periodKind: 'month' | 'quarter' | 'year';
  periodStart: string; // 'YYYY-MM-DD'
  targetValue: number;
  realized: number;
  progressPct: number; // arrondi (peut dépasser 100)
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // -- Helpers de composition SQL (paramétrés ; aucune valeur libre interpolée) --

  /**
   * Tableau de bord : vue GLOBALE accessible à tous les utilisateurs connectés.
   * Décision produit — contrairement à la recherche (deny-by-default ACL D-17),
   * le tableau de bord n'applique AUCUN filtre ACL : `null` = aucun filtre, donc
   * tout utilisateur voit l'ensemble des données.
   */
  private aclCond(_user: AuthUser): Prisma.Sql | null {
    return null;
  }

  /** Conditions de dimension (dossier/type/localisation) + ACL, sur l'alias `d`. */
  private filterConds(params: AnalyticsFilterDto, user: AuthUser): Prisma.Sql[] {
    const c: Prisma.Sql[] = [];
    if (params.dossierId) c.push(Prisma.sql`d.dossier_id = ${params.dossierId}`);
    if (params.documentTypeId) c.push(Prisma.sql`d.document_type_id = ${params.documentTypeId}`);
    if (params.locationId) c.push(Prisma.sql`d.location_id = ${params.locationId}`);
    const acl = this.aclCond(user);
    if (acl) c.push(acl);
    return c;
  }

  private whereOf(conds: Prisma.Sql[]): Prisma.Sql {
    return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  }

  /** Colonne de date selon `basis` (enum whitelisté → Prisma.raw sûr). */
  private dateCol(params: AnalyticsFilterDto): Prisma.Sql {
    if (params.basis === 'document_date') return Prisma.raw('d.document_date');
    if (params.basis === 'validated_at') return Prisma.raw('d.validated_at');
    return Prisma.raw('d.created_at');
  }

  /** Résout la fenêtre de période (défaut : 30 derniers jours) + la fenêtre précédente. */
  private resolvePeriod(params: AnalyticsFilterDto): {
    from: string;
    to: string;
    previousFrom: string;
    previousTo: string;
  } {
    const today = new Date();
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const to = params.dateTo ?? iso(today);
    const from = params.dateFrom ?? iso(new Date(today.getTime() - 29 * 86_400_000));
    const fromD = new Date(`${from}T00:00:00Z`);
    const toD = new Date(`${to}T00:00:00Z`);
    const lenDays = Math.floor((toD.getTime() - fromD.getTime()) / 86_400_000) + 1;
    const previousTo = iso(new Date(fromD.getTime() - 86_400_000));
    const previousFrom = iso(new Date(fromD.getTime() - lenDays * 86_400_000));
    return { from, to, previousFrom, previousTo };
  }

  // -- Requêtes (toutes ensemblistes, agrégées côté PostgreSQL) --

  private async queryKpis(
    params: AnalyticsFilterDto,
    user: AuthUser,
    from: string,
    to: string,
  ): Promise<KpiBlock> {
    const where = this.whereOf(this.filterConds(params, user));
    const dc = this.dateCol(params);

    const [counts] = await this.prisma.$queryRaw<
      Array<{
        total: number;
        archived: number;
        pending: number;
        frozen: number;
        period: number;
        prev: number;
        index_complete: number;
        sans_type: number;
        sans_dossier: number;
        sans_date: number;
        sans_cote: number;
      }>
    >(Prisma.sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE is_archived)::int AS archived,
        count(*) FILTER (WHERE NOT is_archived)::int AS pending,
        count(*) FILTER (WHERE is_frozen)::int AS frozen,
        count(*) FILTER (WHERE ${dc} >= ${from}::date AND ${dc} < (${to}::date + 1))::int AS period,
        count(*) FILTER (WHERE ${dc} >= (${from}::date - ((${to}::date - ${from}::date) + 1)) AND ${dc} < ${from}::date)::int AS prev,
        count(*) FILTER (WHERE document_type_id IS NOT NULL AND dossier_id IS NOT NULL AND plan_id IS NOT NULL
                           AND location_id IS NOT NULL AND document_date IS NOT NULL AND cote IS NOT NULL)::int AS index_complete,
        count(*) FILTER (WHERE document_type_id IS NULL)::int AS sans_type,
        count(*) FILTER (WHERE dossier_id IS NULL)::int AS sans_dossier,
        count(*) FILTER (WHERE document_date IS NULL)::int AS sans_date,
        count(*) FILTER (WHERE cote IS NULL)::int AS sans_cote
      FROM document d
      ${where}`);

    const [files] = await this.prisma.$queryRaw<Array<{ pages: number; bytes: bigint }>>(Prisma.sql`
      SELECT COALESCE(SUM(f.page_count), 0)::int AS pages, COALESCE(SUM(f.byte_length), 0)::bigint AS bytes
      FROM document d
      JOIN document_version dv ON dv.document_id = d.document_id AND dv.is_current
      JOIN document_file f ON f.document_version_id = dv.document_version_id
      ${where}`);

    const total = counts?.total ?? 0;
    return {
      totalDocuments: total,
      documentsArchived: counts?.archived ?? 0,
      documentsPending: counts?.pending ?? 0,
      documentsFrozen: counts?.frozen ?? 0,
      totalPages: files?.pages ?? 0,
      totalBytes: Number(files?.bytes ?? 0),
      periodDocuments: counts?.period ?? 0,
      previousPeriodDocuments: counts?.prev ?? 0,
      indexationRate: total > 0 ? (counts?.index_complete ?? 0) / total : 0,
      anomalies: {
        sansType: counts?.sans_type ?? 0,
        sansDossier: counts?.sans_dossier ?? 0,
        sansDate: counts?.sans_date ?? 0,
        sansCote: counts?.sans_cote ?? 0,
      },
    };
  }

  private async queryTimeline(
    params: AnalyticsFilterDto,
    user: AuthUser,
    from: string,
    to: string,
  ): Promise<TimelinePoint[]> {
    const conds = this.filterConds(params, user);
    const dc = this.dateCol(params);
    const gran = params.granularity; // bound as text param to date_trunc (safe)
    const step =
      gran === 'year'
        ? '1 year'
        : gran === 'quarter'
          ? '3 months'
          : gran === 'month'
            ? '1 month'
            : gran === 'week'
              ? '1 week'
              : '1 day';

    // Baseline = fonds existant avant la fenêtre (pour une courbe cumulée fidèle).
    const baselineConds = [...conds, Prisma.sql`${dc} < ${from}::date`];
    const [base] = await this.prisma.$queryRaw<Array<{ baseline: number }>>(Prisma.sql`
      SELECT count(*)::int AS baseline FROM document d ${this.whereOf(baselineConds)}`);

    const windowConds = [
      ...conds,
      Prisma.sql`${dc} >= ${from}::date`,
      Prisma.sql`${dc} < (${to}::date + 1)`,
    ];
    const rows = await this.prisma.$queryRaw<Array<{ bucket: string; count: number }>>(Prisma.sql`
      WITH buckets AS (
        SELECT generate_series(
          date_trunc(${gran}, ${from}::date),
          date_trunc(${gran}, ${to}::date),
          ${step}::interval
        ) AS b
      ),
      counts AS (
        SELECT date_trunc(${gran}, ${dc}) AS b, count(*)::int AS n
        FROM document d
        ${this.whereOf(windowConds)}
        GROUP BY 1
      )
      SELECT to_char(buckets.b, 'YYYY-MM-DD') AS bucket, COALESCE(counts.n, 0)::int AS count
      FROM buckets LEFT JOIN counts ON counts.b = buckets.b
      ORDER BY buckets.b`);

    let running = base?.baseline ?? 0;
    return rows.map((r) => {
      running += r.count;
      return { bucket: r.bucket, count: r.count, cumulative: running };
    });
  }

  private async queryObjective(params: AnalyticsFilterDto, user: AuthUser): Promise<ObjectiveBlock> {
    const acl = this.aclCond(user);
    const aclWhere = acl ? Prisma.sql`AND ${acl}` : Prisma.empty;

    const [tgt] = await this.prisma.$queryRaw<Array<{ metric: string; target_value: number }>>(Prisma.sql`
      SELECT metric, target_value::int AS target_value
      FROM analytics_target
      WHERE scope = 'global' AND period_kind = 'month' AND period_start = date_trunc('month', now())::date
      ORDER BY (metric = 'documents') DESC
      LIMIT 1`);

    const [m] = await this.prisma.$queryRaw<
      Array<{ realized: number; day_of_month: number; days_in_month: number }>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM document d
          WHERE d.created_at >= date_trunc('month', now())
            AND d.created_at < (date_trunc('month', now()) + interval '1 month')
            ${aclWhere}) AS realized,
        extract(day FROM now())::int AS day_of_month,
        extract(day FROM (date_trunc('month', now()) + interval '1 month' - interval '1 day'))::int AS days_in_month`);

    const target = tgt?.target_value ?? 0;
    const realized = m?.realized ?? 0;
    const dayOfMonth = m?.day_of_month ?? 1;
    const daysInMonth = m?.days_in_month ?? 30;
    const projectedEndOfMonth = dayOfMonth > 0 ? Math.round((realized / dayOfMonth) * daysInMonth) : realized;
    const remaining = Math.max(daysInMonth - dayOfMonth, 0);
    const requiredDailyRate = remaining > 0 ? Math.max(target - realized, 0) / remaining : 0;

    return {
      hasTarget: Boolean(tgt),
      metric: (tgt?.metric as 'documents' | 'pages') ?? 'documents',
      target,
      realized,
      pct: target > 0 ? realized / target : 0,
      dayOfMonth,
      daysInMonth,
      projectedEndOfMonth,
      requiredDailyRate: Math.round(requiredDailyRate * 10) / 10,
    };
  }

  /**
   * Répartition « Top N + Autres » sur une dimension catégorielle, ACL appliquée.
   * `join`/`label` sont des fragments SQL de confiance (jamais d'entrée utilisateur) ;
   * la tranche `noneLabel` (valeur NULL) est conservée distincte, hors Top N.
   */
  private async queryDistribution(
    params: AnalyticsFilterDto,
    user: AuthUser,
    opts: { join: Prisma.Sql; label: Prisma.Sql; noneLabel: string; top?: number },
  ): Promise<DistributionSlice[]> {
    const where = this.whereOf(this.filterConds(params, user));
    const rows = await this.prisma.$queryRaw<Array<{ name: string; value: number }>>(Prisma.sql`
      SELECT COALESCE(${opts.label}, ${opts.noneLabel}) AS name, count(*)::int AS value
      FROM document d
      ${opts.join}
      ${where}
      GROUP BY 1
      ORDER BY value DESC`);

    const TOP = opts.top ?? 8;
    const none = rows.find((r) => r.name === opts.noneLabel);
    const named = rows.filter((r) => r.name !== opts.noneLabel);
    const out: DistributionSlice[] = named.slice(0, TOP);
    const rest = named.slice(TOP);
    if (rest.length) out.push({ name: 'Autres', value: rest.reduce((s, r) => s + r.value, 0) });
    if (none) out.push(none); // tranche « sans <dimension> » toujours en fin
    return out;
  }

  private async queryByProgramme(params: AnalyticsFilterDto, user: AuthUser): Promise<TreemapNode[]> {
    const acl = this.aclCond(user);
    const aclWhere = acl ? Prisma.sql`AND ${acl}` : Prisma.empty;
    // Rollup ensembliste par sous-arbre via la materialized path (path indexée).
    // Le suffixe '/' de la path racine évite les faux préfixes (/3/ ne matche pas /30/).
    const rows = await this.prisma.$queryRaw<Array<{ id: number; name: string; value: number }>>(Prisma.sql`
      SELECT r.dossier_id AS id, r.label AS name,
        (SELECT count(*)::int
           FROM document d
           JOIN dossier s ON s.dossier_id = d.dossier_id AND s.path LIKE r.path || '%'
           WHERE TRUE ${aclWhere}) AS value
      FROM dossier r
      WHERE r.parent_id IS NULL AND r.is_active
      ORDER BY value DESC, r.label ASC`);
    return rows.filter((r) => r.value > 0);
  }

  private async queryPipeline(
    params: AnalyticsFilterDto,
    from: string,
    to: string,
  ): Promise<PipelineBlock> {
    // Les lots ne portent pas d'ACL par document → vue opérationnelle (santé du pipeline).
    const [row] = await this.prisma.$queryRaw<
      Array<{ total: number; termines: number; echecs: number; ouverts: number }>
    >(Prisma.sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 1)::int AS termines,
        count(*) FILTER (WHERE status = 2)::int AS echecs,
        count(*) FILTER (WHERE status = 0)::int AS ouverts
      FROM acquisition_batch
      WHERE scan_date >= ${from}::date AND scan_date < (${to}::date + 1)`);
    const total = row?.total ?? 0;
    return {
      total,
      termines: row?.termines ?? 0,
      echecs: row?.echecs ?? 0,
      ouverts: row?.ouverts ?? 0,
      failureRate: total > 0 ? (row?.echecs ?? 0) / total : 0,
    };
  }

  /** Agrégat « Vue d'ensemble » : toutes les requêtes en parallèle. */
  async overview(params: AnalyticsFilterDto, user: AuthUser): Promise<AnalyticsOverview> {
    const period = this.resolvePeriod(params);
    const [kpis, timeline, objective, byType, byLocation, byPlan, byProgramme, pipeline] =
      await Promise.all([
        this.queryKpis(params, user, period.from, period.to),
        this.queryTimeline(params, user, period.from, period.to),
        this.queryObjective(params, user),
        this.queryDistribution(params, user, {
          join: Prisma.raw('LEFT JOIN document_type dt ON dt.document_type_id = d.document_type_id'),
          label: Prisma.raw('dt.label'),
          noneLabel: '— Sans type —',
        }),
        this.queryDistribution(params, user, {
          join: Prisma.raw('LEFT JOIN location loc ON loc.location_id = d.location_id'),
          label: Prisma.raw('loc.label'),
          noneLabel: '— Sans localisation —',
        }),
        this.queryDistribution(params, user, {
          join: Prisma.raw('LEFT JOIN classification_plan cp ON cp.plan_id = d.plan_id'),
          label: Prisma.raw('cp.label'),
          noneLabel: '— Sans plan —',
        }),
        this.queryByProgramme(params, user),
        this.queryPipeline(params, period.from, period.to),
      ]);
    return {
      period,
      basis: params.basis,
      granularity: params.granularity,
      kpis,
      timeline,
      objective,
      byType,
      byLocation,
      byPlan,
      byProgramme,
      pipeline,
    };
  }

  /** Pas d'unité d'intervalle Postgres « quarter » → on mappe vers '3 months'. */
  private periodInterval(kind: 'month' | 'quarter' | 'year'): string {
    return kind === 'year' ? '1 year' : kind === 'quarter' ? '3 months' : '1 month';
  }

  /**
   * Réalisé d'une cible sur sa fenêtre [period_start, period_start + 1 période) :
   * comptage de documents (metric=documents) ou somme des pages des versions
   * courantes (metric=pages), filtré par scope et ACL. Base de date : created_at.
   */
  private async realizedForTarget(
    r: {
      scope: 'global' | 'programme' | 'type';
      scope_ref_id: number | null;
      metric: 'documents' | 'pages';
      period_kind: 'month' | 'quarter' | 'year';
      period_start: string;
    },
    acl: Prisma.Sql | null,
  ): Promise<number> {
    const aclCond = acl ? Prisma.sql`AND ${acl}` : Prisma.empty;
    const scopeCond =
      r.scope === 'programme'
        ? Prisma.sql`AND d.dossier_id = ${r.scope_ref_id}`
        : r.scope === 'type'
          ? Prisma.sql`AND d.document_type_id = ${r.scope_ref_id}`
          : Prisma.empty;
    const step = this.periodInterval(r.period_kind);
    const windowCond = Prisma.sql`d.created_at >= ${r.period_start}::date
      AND d.created_at < (${r.period_start}::date + ${step}::interval)`;

    if (r.metric === 'pages') {
      const [row] = await this.prisma.$queryRaw<Array<{ v: number }>>(Prisma.sql`
        SELECT COALESCE(SUM(f.page_count), 0)::int AS v
        FROM document d
        JOIN document_version dv ON dv.document_id = d.document_id AND dv.is_current
        JOIN document_file f ON f.document_version_id = dv.document_version_id
        WHERE ${windowCond} ${scopeCond} ${aclCond}`);
      return row?.v ?? 0;
    }
    const [row] = await this.prisma.$queryRaw<Array<{ v: number }>>(Prisma.sql`
      SELECT count(*)::int AS v FROM document d
      WHERE ${windowCond} ${scopeCond} ${aclCond}`);
    return row?.v ?? 0;
  }

  /** Cibles « objectif vs réalisé » d'une période (toutes, ou filtrées par scope). */
  async targets(params: AnalyticsTargetsDto, user: AuthUser): Promise<TargetRow[]> {
    const acl = this.aclCond(user);
    const scopeFilter = params.scope ? Prisma.sql`AND t.scope = ${params.scope}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{
        target_id: number;
        scope: 'global' | 'programme' | 'type';
        scope_ref_id: number | null;
        metric: 'documents' | 'pages';
        period_kind: 'month' | 'quarter' | 'year';
        period_start: string;
        target_value: number;
        scope_label: string;
      }>
    >(Prisma.sql`
      SELECT t.target_id, t.scope, t.scope_ref_id, t.metric, t.period_kind,
        to_char(t.period_start, 'YYYY-MM-DD') AS period_start, t.target_value::int AS target_value,
        CASE
          WHEN t.scope = 'global' THEN 'Global'
          WHEN t.scope = 'programme' THEN COALESCE(dos.label, 'Programme #' || t.scope_ref_id)
          ELSE COALESCE(dt.label, 'Type #' || t.scope_ref_id)
        END AS scope_label
      FROM analytics_target t
      LEFT JOIN dossier dos ON t.scope = 'programme' AND dos.dossier_id = t.scope_ref_id
      LEFT JOIN document_type dt ON t.scope = 'type' AND dt.document_type_id = t.scope_ref_id
      WHERE t.period_kind = ${params.periodKind}
        AND t.period_start = COALESCE(${params.periodStart ?? null}::date, date_trunc(${params.periodKind}, now())::date)
        ${scopeFilter}
      ORDER BY t.scope, scope_label`);

    return Promise.all(
      rows.map(async (r) => {
        const realized = await this.realizedForTarget(r, acl);
        return {
          targetId: r.target_id,
          scope: r.scope,
          scopeRefId: r.scope_ref_id,
          scopeLabel: r.scope_label,
          metric: r.metric,
          periodKind: r.period_kind,
          periodStart: r.period_start,
          targetValue: r.target_value,
          realized,
          progressPct: r.target_value > 0 ? Math.round((100 * realized) / r.target_value) : 0,
        };
      }),
    );
  }

  /** Lignes pour l'export (cohérent avec les filtres) : synthèse KPI + répartition par type. */
  async overviewRows(params: AnalyticsFilterDto, user: AuthUser): Promise<Array<Record<string, unknown>>> {
    const o = await this.overview(params, user);
    const rows: Array<Record<string, unknown>> = [
      { section: 'Synthèse', libelle: 'Total archivé (documents)', valeur: o.kpis.totalDocuments },
      { section: 'Synthèse', libelle: 'Pages numérisées', valeur: o.kpis.totalPages },
      { section: 'Synthèse', libelle: 'Volume (octets)', valeur: o.kpis.totalBytes },
      { section: 'Synthèse', libelle: 'Documents sur la période', valeur: o.kpis.periodDocuments },
      { section: 'Synthèse', libelle: "Taux d'indexation", valeur: `${Math.round(o.kpis.indexationRate * 100)}%` },
      { section: 'Synthèse', libelle: "Taux d'échec des lots", valeur: `${Math.round(o.pipeline.failureRate * 100)}%` },
    ];
    for (const t of o.byType) rows.push({ section: 'Par type', libelle: t.name, valeur: t.value });
    for (const p of o.byProgramme) rows.push({ section: 'Par programme', libelle: p.name, valeur: p.value });
    return rows;
  }
}
