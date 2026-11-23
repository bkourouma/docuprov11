import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DocumentState } from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import { expiryCutoff, toIsoDate } from './domain';
import type { ExpiredQueryDto, PurgedQueryDto } from './archives.dto';

/** Ligne des écrans « DUA Expirés » et « Documents Épurés ». */
export interface ComplianceRow {
  documentId: number;
  label: string;
  cote: string | null;
  documentDate: string | null;
  documentTypeName: string | null;
  dossierName: string | null;
  finalFateName: string | null;
  destructionModeName: string | null;
  /** Point de départ du décompte (date métier, à défaut date de création). */
  startDate: string | null;
  /** Échéance de DUA. `null` sur l'écran « Épurés » quand plus aucune règle ne s'applique. */
  usefulnessLifespan: string | null;
  complianceLifespan: string | null;
  documentState: number;
}

export interface ComplianceResult {
  total: number;
  page: number;
  pageSize: number;
  /** Date de coupure appliquée — l'écran l'affiche pour que le périmètre soit explicite. */
  cutoff: string;
  rows: ComplianceRow[];
}

/** Colonnes de tri autorisées (valeurs = SQL de confiance, clés validées par zod). */
const EXPIRED_SORT: Record<string, string> = {
  label: 'd.label',
  documentType: 'dt.label',
  usefulnessLifespan: 'usefulness_due',
  complianceLifespan: 'compliance_due',
  startDate: 'start_date',
};

const PURGED_SORT: Record<string, string> = {
  label: 'd.label',
  documentType: 'dt.label',
  documentDate: 'd.document_date',
};

/**
 * Écrans « DUA Expirés » et « Documents Épurés » (Docu-Archives §1 et §2).
 *
 * Le calcul d'échéance est fait EN SQL et non en TypeScript : sur une archive de plusieurs
 * centaines de milliers de documents, filtrer et paginer côté application supposerait de tout
 * charger. `make_interval(months => …)` reproduit exactement l'arithmétique de `addMonths()`
 * (domain/dua.ts), écrêtage de fin de mois compris — les deux sont testés sur les mêmes cas.
 *
 * Priorité des règles, comme dans le source : le cycle de vie propre au DOCUMENT
 * (`document_life_cycle`, saisi à la main) l'emporte sur la règle de son TYPE
 * (`document_type_life_cycle`). Un document dont ni l'un ni l'autre n'existe n'a pas d'échéance :
 * il n'apparaît pas — on ne va pas proposer d'épurer ce qu'aucune règle ne régit.
 */
@Injectable()
export class ArchivesComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Expression des échéances, partagée par le comptage et la page de résultats pour qu'ils ne
   * puissent pas diverger. `created_at` est ramené à une date civile dans le fuseau de la base
   * (`::date`), cohérent avec `lifeCycleStartDate()` qui fait de même côté TypeScript.
   */
  private readonly dueSelect = Prisma.sql`
    COALESCE(d.document_date, d.created_at::date) AS start_date,
    COALESCE(
      dlc.usefulness_lifespan,
      (COALESCE(d.document_date, d.created_at::date) + make_interval(months => dtlc.usefulness_lifespan))::date
    ) AS usefulness_due,
    COALESCE(
      dlc.compliance_lifespan,
      (COALESCE(d.document_date, d.created_at::date) + make_interval(months => dtlc.compliance_lifespan))::date
    ) AS compliance_due,
    COALESCE(ff_doc.label, ff_type.label) AS final_fate_name,
    COALESCE(dm_doc.label, dm_type.label) AS destruction_mode_name
  `;

  private readonly joins = Prisma.sql`
    FROM document d
    LEFT JOIN document_type dt ON dt.document_type_id = d.document_type_id
    LEFT JOIN dossier dos ON dos.dossier_id = d.dossier_id
    LEFT JOIN document_life_cycle dlc ON dlc.document_id = d.document_id
    LEFT JOIN document_type_life_cycle dtlc ON dtlc.document_type_id = d.document_type_id
    LEFT JOIN final_fate ff_doc ON ff_doc.final_fate_id = dlc.final_fate_id
    LEFT JOIN final_fate ff_type ON ff_type.final_fate_id = dtlc.final_fate_id
    LEFT JOIN destruction_mode dm_doc ON dm_doc.destruction_mode_id = dlc.destruction_mode_id
    LEFT JOIN destruction_mode dm_type ON dm_type.destruction_mode_id = dtlc.destruction_mode_id
  `;

  /** Recherche plein-texte simple sur le libellé, la cote et le type — comme le `search` du source. */
  private searchClause(search?: string): Prisma.Sql {
    if (!search?.trim()) return Prisma.empty;
    const like = `%${search.trim()}%`;
    return Prisma.sql`AND (d.label ILIKE ${like} OR d.cote ILIKE ${like} OR dt.label ILIKE ${like})`;
  }

  private orderBy(map: Record<string, string>, sorting: string, direction: 'asc' | 'desc'): Prisma.Sql {
    const column = map[sorting] ?? Object.values(map)[0];
    // `direction` vient d'un enum zod : les deux seules valeurs possibles sont sûres.
    return Prisma.raw(`ORDER BY ${column} ${direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, d.document_id ASC`);
  }

  /**
   * « La DUA du document est échue à la date `cutoff` » — UNE seule expression SQL, partagée par la
   * liste « DUA expirés » et par le contrôle de l'épuration (ANO-ARC-T3-06) : ce que l'écran
   * propose et ce que l'API accepte d'épurer ne peuvent pas diverger. Un document qu'aucune règle
   * ne régit (ni cycle propre, ni règle de son type) n'est jamais échu.
   */
  private usefulnessDueBy(cutoff: string): Prisma.Sql {
    return Prisma.sql`(dlc.document_life_cycle_id IS NOT NULL OR dtlc.document_type_life_cycle_id IS NOT NULL)
        AND COALESCE(
              dlc.usefulness_lifespan,
              (COALESCE(d.document_date, d.created_at::date) + make_interval(months => dtlc.usefulness_lifespan))::date
            ) <= ${cutoff}::date`;
  }

  /**
   * Documents dont la DUA est arrivée à échéance et qui ne sont pas déjà épurés.
   * `monthsAhead` ouvre une fenêtre d'anticipation (0 = strictement échu).
   */
  async listExpired(query: ExpiredQueryDto): Promise<ComplianceResult> {
    const cutoff = toIsoDate(expiryCutoff(new Date(), query.monthsAhead));
    const where = Prisma.sql`
      WHERE d.document_state <> ${DocumentState.Epure}
        AND ${this.usefulnessDueBy(cutoff)}
        ${this.searchClause(query.search)}
    `;
    return this.paginate(where, EXPIRED_SORT, query, cutoff);
  }

  /** Documents déjà épurés (état « Épuré »), pour consultation. */
  async listPurged(query: PurgedQueryDto): Promise<ComplianceResult> {
    const where = Prisma.sql`
      WHERE d.document_state = ${DocumentState.Epure}
        ${this.searchClause(query.search)}
    `;
    return this.paginate(where, PURGED_SORT, query, toIsoDate(new Date()));
  }

  private async paginate(
    where: Prisma.Sql,
    sortMap: Record<string, string>,
    query: { page: number; pageSize: number; sorting: string; sortDirection: 'asc' | 'desc' },
    cutoff: string,
  ): Promise<ComplianceResult> {
    const [{ total }] = await this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS total ${this.joins} ${where}
    `);

    const rows = await this.prisma.$queryRaw<
      Array<{
        document_id: number;
        label: string;
        cote: string | null;
        document_date: Date | null;
        document_state: number;
        document_type_name: string | null;
        dossier_name: string | null;
        start_date: Date | null;
        usefulness_due: Date | null;
        compliance_due: Date | null;
        final_fate_name: string | null;
        destruction_mode_name: string | null;
      }>
    >(Prisma.sql`
      SELECT
        d.document_id, d.label, d.cote, d.document_date, d.document_state,
        dt.label AS document_type_name,
        dos.label AS dossier_name,
        ${this.dueSelect}
      ${this.joins}
      ${where}
      ${this.orderBy(sortMap, query.sorting, query.sortDirection)}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    `);

    return {
      total: Number(total),
      page: query.page,
      pageSize: query.pageSize,
      cutoff,
      rows: rows.map((r) => ({
        documentId: r.document_id,
        label: r.label,
        cote: r.cote,
        documentDate: r.document_date ? toIsoDate(r.document_date) : null,
        documentTypeName: r.document_type_name,
        dossierName: r.dossier_name,
        finalFateName: r.final_fate_name,
        destructionModeName: r.destruction_mode_name,
        startDate: r.start_date ? toIsoDate(r.start_date) : null,
        usefulnessLifespan: r.usefulness_due ? toIsoDate(r.usefulness_due) : null,
        complianceLifespan: r.compliance_due ? toIsoDate(r.compliance_due) : null,
        documentState: r.document_state,
      })),
    };
  }

  /**
   * Épuration : bascule les documents sélectionnés à l'état « Épuré ».
   *
   * Écart assumé avec le source, qui posait l'état sans autre contrôle : un document ENCORE PRÊTÉ
   * n'est pas épuré. Le déclarer épuré pendant qu'un agent le détient rendrait les deux écrans
   * incohérents (« communiqué » d'un côté, « épuré » de l'autre) et ferait disparaître une
   * communication en cours. Les documents concernés sont renvoyés à l'écran, qui les signale.
   *
   * Le binaire disque n'est PAS supprimé : « épuré » est un état fonctionnel, la destruction
   * physique relève du mode de destruction et reste une opération séparée.
   *
   * Contrôles refusés EN BLOC, avant toute écriture (ANO-ARC-T3-06 : l'API épurait tout
   * identifiant reçu, l'écran étant seul à ne proposer que des échus) :
   *  - identifiant inexistant → 404 ;
   *  - DUA non échue AUJOURD'HUI (même règle que « DUA expirés » sans anticipation, y compris pour
   *    un document qu'aucune règle ne régit) → 409 qui nomme les documents. La fenêtre
   *    d'anticipation de l'écran sert à PRÉPARER une campagne, pas à épurer par avance.
   * Un document déjà épuré n'est pas un refus : l'épuration reste idempotente (`purged: 0`).
   */
  async purge(documentIds: number[]) {
    const ids = [...new Set(documentIds)];
    const cutoff = toIsoDate(expiryCutoff(new Date(), 0));
    const states = await this.prisma.$queryRaw<
      Array<{ document_id: number; label: string; document_state: number; is_due: boolean }>
    >(Prisma.sql`
      SELECT d.document_id, d.label, d.document_state,
             COALESCE((${this.usefulnessDueBy(cutoff)}), false) AS is_due
      ${this.joins}
      WHERE d.document_id IN (${Prisma.join(ids)})
    `);

    const missing = ids.filter((id) => !states.some((s) => s.document_id === id));
    if (missing.length) {
      throw new NotFoundException(`Document(s) introuvable(s) : ${missing.join(', ')}`);
    }
    const notDue = states.filter((s) => s.document_state !== DocumentState.Epure && !s.is_due);
    if (notDue.length) {
      throw new ConflictException(
        `Document(s) dont la DUA n'est pas échue : ${notDue
          .map((s) => s.label)
          .join(', ')}. Aucun document n'a été épuré.`,
      );
    }

    const stillLent = await this.prisma.lendingDocumentDetail.findMany({
      where: { documentId: { in: ids }, returnedDate: null },
      select: { documentId: true, document: { select: { label: true } } },
    });
    const blocked = new Map(stillLent.map((l) => [l.documentId, l.document.label]));
    const eligible = ids.filter((id) => !blocked.has(id));

    const { count } = eligible.length
      ? await this.prisma.document.updateMany({
          where: { documentId: { in: eligible }, documentState: { not: DocumentState.Epure } },
          data: { documentState: DocumentState.Epure },
        })
      : { count: 0 };

    return {
      purged: count,
      blocked: [...blocked.entries()].map(([documentId, label]) => ({ documentId, label })),
    };
  }
}
