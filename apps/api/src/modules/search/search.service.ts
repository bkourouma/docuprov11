import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { SearchDto } from './search.dto';

export interface DocumentRow {
  documentId: number;
  label: string;
  documentType: string | null;
  cote: string | null;
  documentDate: string | null;
  /** Date d'enregistrement SYSTÈME (`document.created_at`) — distincte de `documentDate`, la date
   *  métier du document. C'est elle que la liste de résultats affiche (FR: colonne « Enregistré le »). */
  createdAt: string;
  dossier: string | null;
  plan: string | null;
  location: string | null;
}

export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  rows: DocumentRow[];
}

// Whitelisted sort columns (values are trusted SQL, keys validated by zod).
const SORT_COLUMNS: Record<string, string> = {
  label: 'd.label',
  documentType: 'dt.label',
  cote: 'd.cote',
  documentDate: 'd.document_date',
  createdAt: 'd.created_at',
  dossier: 'dos.label',
  plan: 'cp.label',
  location: 'loc.label',
};

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the WHERE clause. Filtre par CONFIDENTIALITÉ (fin de l'override D-17 pour cet axe,
   * 2026-08-04) — même règle que `DocumentsService.canAccess` : un document sans confidentialité
   * requise reste visible à tous ; sinon il faut être admin ou avoir un rang suffisant. Cohérent
   * avec l'ouverture directe : un document qu'on ne peut pas ouvrir ne doit pas apparaître ici.
   */
  private buildWhere(params: SearchDto, user: AuthUser): Prisma.Sql {
    // La recherche porte sur l'ARCHIVE : seuls les documents validés (archivés) y figurent.
    // Un lot acquis mais non validé (ex. abandonné après une alerte de doublon) ne pollue donc pas
    // les résultats avec des documents « Lot N – document 1 (sans type) » vides.
    const conditions: Prisma.Sql[] = [Prisma.sql`d.is_archived = true`];

    if (params.documentTypeId) conditions.push(Prisma.sql`d.document_type_id = ${params.documentTypeId}`);
    if (params.dossierId) conditions.push(Prisma.sql`d.dossier_id = ${params.dossierId}`);
    if (params.planId) conditions.push(Prisma.sql`d.plan_id = ${params.planId}`);
    if (params.locationId) conditions.push(Prisma.sql`d.location_id = ${params.locationId}`);
    // « Ajouté par » : created_by stores a user_group_id; match any group account of the chosen user.
    if (params.createdByUserId) {
      conditions.push(Prisma.sql`d.created_by IN (
        SELECT user_group_id FROM app_user_group WHERE user_id = ${params.createdByUserId}
      )`);
    }
    // « Type de fichier » : the document has at least one file of this type (any version).
    if (params.fileTypeId) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM document_file df
        JOIN document_version dv ON df.document_version_id = dv.document_version_id
        WHERE dv.document_id = d.document_id AND df.file_type_id = ${params.fileTypeId}
      )`);
    }
    if (params.documentDateFrom) conditions.push(Prisma.sql`d.document_date >= ${params.documentDateFrom}::date`);
    if (params.documentDateTo) conditions.push(Prisma.sql`d.document_date <= ${params.documentDateTo}::date`);

    const q = params.fullText?.trim();
    if (q) {
      const like = `%${q}%`;
      conditions.push(Prisma.sql`(
        d.label ILIKE ${like} OR d.cote ILIKE ${like} OR EXISTS (
          SELECT 1 FROM document_file df
          JOIN document_version dv ON df.document_version_id = dv.document_version_id
          WHERE dv.document_id = d.document_id
            AND to_tsvector('french', coalesce(df.ocr_text, '')) @@ websearch_to_tsquery('french', ${q})
        )
      )`);
    }

    if (!user.isAdmin && !user.isScanAgent) {
      conditions.push(Prisma.sql`(
        d.confidentialite_id IS NULL OR EXISTS (
          SELECT 1 FROM app_user u
          JOIN confidentialite uc ON uc.confidentialite_id = u.confidentialite_id
          JOIN confidentialite dc ON dc.confidentialite_id = d.confidentialite_id
          WHERE u.user_id = ${user.userId} AND uc.rank >= dc.rank
        )
      )`);
    }

    return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  }

  private buildOrder(params: SearchDto): Prisma.Sql {
    const parts = (params.sort ?? [])
      .filter((s) => SORT_COLUMNS[s.field])
      .map((s) => `${SORT_COLUMNS[s.field]} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
    return parts.length ? Prisma.raw(`ORDER BY ${parts.join(', ')}`) : Prisma.raw('ORDER BY d.document_id DESC');
  }

  async search(params: SearchDto, user: AuthUser): Promise<SearchResult> {
    const where = this.buildWhere(params, user);
    const order = this.buildOrder(params);
    const offset = (params.page - 1) * params.pageSize;

    const rows = await this.prisma.$queryRaw<DocumentRow[]>(Prisma.sql`
      SELECT d.document_id AS "documentId", d.label,
             dt.label AS "documentType", d.cote,
             to_char(d.document_date, 'YYYY-MM-DD') AS "documentDate",
             d.created_at AS "createdAt",
             dos.label AS dossier, cp.label AS plan, loc.label AS location
      FROM document d
      LEFT JOIN document_type dt ON dt.document_type_id = d.document_type_id
      LEFT JOIN dossier dos ON dos.dossier_id = d.dossier_id
      LEFT JOIN classification_plan cp ON cp.plan_id = d.plan_id
      LEFT JOIN location loc ON loc.location_id = d.location_id
      ${where}
      ${order}
      LIMIT ${params.pageSize} OFFSET ${offset}`);

    const totalRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*)::bigint AS count FROM document d ${where}`,
    );

    return {
      total: Number(totalRows[0]?.count ?? 0),
      page: params.page,
      pageSize: params.pageSize,
      rows,
    };
  }

  /** All matching rows (no pagination), for export — reflects the same filter/sort (FR-025). */
  async searchAll(params: SearchDto, user: AuthUser, cap = 5000): Promise<DocumentRow[]> {
    const { rows } = await this.search({ ...params, page: 1, pageSize: cap }, user);
    return rows;
  }
}
