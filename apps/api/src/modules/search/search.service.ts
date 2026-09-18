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

/** Comptes-groupes de la PERSONNE — un utilisateur peut en avoir plusieurs, le jeton n'en porte qu'un. */
const actorGroups = (userId: number) =>
  Prisma.sql`SELECT user_group_id FROM app_user_group WHERE user_id = ${userId}`;

/** Profils de la personne (`app_group`), bénéficiaire collectif des droits sur UN document. */
const actorProfiles = (userId: number) =>
  Prisma.sql`SELECT group_id FROM app_user_group WHERE user_id = ${userId}`;

/** Un droit n'est effectif que dans sa fenêtre de validité (`null` d'un côté = pas de borne). */
const inForce = (t: string) =>
  Prisma.raw(
    `(${t}.start_date IS NULL OR ${t}.start_date <= now()) AND (${t}.end_date IS NULL OR ${t}.end_date >= now())`,
  );

/**
 * « L'utilisateur bénéficie d'un droit EN VIGUEUR sur CE document » (par compte-acteur ou par
 * profil). Factorisée parce qu'elle sert aux DEUX axes : elle autorise l'accès malgré le type,
 * et elle lève aussi l'exigence de confidentialité (cf. `buildWhere`).
 */
const ownDocumentGrant = (userId: number) => Prisma.sql`EXISTS (
  SELECT 1 FROM document_permission dg
  WHERE dg.document_id = d.document_id AND dg.permission_level_id >= 2 AND ${inForce('dg')}
    AND (dg.user_group_id IN (${actorGroups(userId)})
         OR dg.group_id IN (${actorProfiles(userId)}))
)`;

/**
 * Filtre de VISIBILITÉ par droits explicites (`document_permission` / `document_type_permission`,
 * menu « Sécurité Documentaire ») — appliqué depuis le 2026-09-08 à la demande du propriétaire du
 * produit. Doit rester IDENTIQUE à `DocumentsService.canAccess` : dès que les deux divergent, la
 * recherche ment (elle masque ce qui s'ouvre par URL, ou l'inverse).
 *
 * Règle, dans l'ordre :
 *  1. un refus explicite (`Denied`, niveau 1) en vigueur masque la pièce — seul cas où une ligne
 *     d'ACL RETIRE un accès, et il l'emporte sur le passe-droit du créateur : un refus est posé
 *     délibérément par un administrateur ;
 *  2. le CRÉATEUR voit toujours sa pièce (même garde-fou que la confidentialité) ;
 *  3. un document dont NI lui NI son type ne porte de droit en vigueur n'est pas restreint —
 *     c'est le cas de la majorité du fonds, rien n'y change ;
 *  4. sinon, il faut bénéficier d'un droit en vigueur, sur le document (compte-acteur ou profil)
 *     ou sur son type (compte-acteur ou rôle).
 *
 * « Accorder » commence au niveau 2 (Consultation) : `Denied` n'est jamais proposé à l'écran,
 * « l'absence de droit EST le refus » (cf. `AccessTab.tsx`).
 *
 * Bénéficiaire = la PERSONNE, pas le compte-groupe porté par le jeton : sinon un droit accordé à
 * l'un de ses autres comptes-groupes ne s'appliquerait jamais. Même résolution que le créateur.
 */
function permissionCondition(userId: number): Prisma.Sql {
  return Prisma.sql`(
    NOT EXISTS (
      SELECT 1 FROM document_permission dn
      WHERE dn.document_id = d.document_id AND dn.permission_level_id = 1 AND ${inForce('dn')}
        AND (dn.user_group_id IN (${actorGroups(userId)})
             OR dn.group_id IN (${actorProfiles(userId)}))
    )
    AND (
      d.created_by IN (${actorGroups(userId)})
      OR (
        NOT EXISTS (
          SELECT 1 FROM document_permission dp
          WHERE dp.document_id = d.document_id AND dp.permission_level_id >= 2 AND ${inForce('dp')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM document_type_permission tp
          WHERE tp.document_type_id = d.document_type_id AND tp.permission_level_id >= 2
            AND ${inForce('tp')}
        )
      )
      OR ${ownDocumentGrant(userId)}
      OR EXISTS (
        SELECT 1 FROM document_type_permission tp
        WHERE tp.document_type_id = d.document_type_id AND tp.permission_level_id >= 2
          AND ${inForce('tp')}
          AND (tp.user_group_id IN (${actorGroups(userId)})
               OR tp.role_id = (SELECT role_id FROM app_user WHERE user_id = ${userId}))
      )
    )
  )`;
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the WHERE clause. Filtre par CONFIDENTIALITÉ (fin de l'override D-17 pour cet axe,
   * 2026-08-04) — même règle que `DocumentsService.canAccess` : un document sans confidentialité
   * requise reste visible à tous ; sinon il faut être admin, avoir un rang suffisant, ou **être
   * le créateur du document**.
   *
   * Le passe-droit du créateur manquait ici alors que `canAccess` l'applique (2026-09-08) : un
   * agent qui numérisait dans un type plus confidentiel que sa propre habilitation pouvait
   * ouvrir sa pièce par son URL, mais ne la retrouvait JAMAIS dans la recherche. Les deux règles
   * doivent rester identiques, sinon la recherche ment dans un sens ou dans l'autre.
   *
   * Le créateur est la PERSONNE, pas le compte-groupe : `created_by` porte un `user_group_id` et
   * un même utilisateur peut en avoir plusieurs, dont un seul est le défaut porté par le jeton.
   * On compare donc sur l'ensemble de ses groupes, des deux côtés.
   *
   * DÉROGATION par droit nominatif (2026-09-08) : un droit accordé sur CE document précis
   * (onglets « Accès par utilisateur » / « Accès par profil ») lève AUSSI l'exigence de
   * confidentialité. Accorder l'accès à une pièce nommée est une décision délibérée et
   * spécifique ; sans cette dérogation, le droit accordé à l'écran restait sans effet dès que le
   * document portait un niveau supérieur à l'habilitation — et l'administrateur n'avait aucun
   * moyen de comprendre pourquoi. Un droit par TYPE, lui, reste générique : il ne déroge pas.
   */
  private buildWhere(params: SearchDto, user: AuthUser): Prisma.Sql {
    // La recherche porte sur l'ARCHIVE : seuls les documents validés (archivés) y figurent.
    // Un lot acquis mais non validé (ex. abandonné après une alerte de doublon) ne pollue donc pas
    // les résultats avec des documents « Lot N – document 1 (sans type) » vides.
    const conditions: Prisma.Sql[] = [Prisma.sql`d.is_archived = true`];

    if (params.documentTypeId)
      conditions.push(Prisma.sql`d.document_type_id = ${params.documentTypeId}`);
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
    if (params.documentDateFrom)
      conditions.push(Prisma.sql`d.document_date >= ${params.documentDateFrom}::date`);
    if (params.documentDateTo)
      conditions.push(Prisma.sql`d.document_date <= ${params.documentDateTo}::date`);

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
        d.confidentialite_id IS NULL
        OR d.created_by IN (SELECT user_group_id FROM app_user_group WHERE user_id = ${user.userId})
        OR ${ownDocumentGrant(user.userId)}
        OR EXISTS (
          SELECT 1 FROM app_user u
          JOIN confidentialite uc ON uc.confidentialite_id = u.confidentialite_id
          JOIN confidentialite dc ON dc.confidentialite_id = d.confidentialite_id
          WHERE u.user_id = ${user.userId} AND uc.rank >= dc.rank
        )
      )`);
      conditions.push(permissionCondition(user.userId));
    }

    return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  }

  private buildOrder(params: SearchDto): Prisma.Sql {
    const parts = (params.sort ?? [])
      .filter((s) => SORT_COLUMNS[s.field])
      .map((s) => `${SORT_COLUMNS[s.field]} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
    return parts.length
      ? Prisma.raw(`ORDER BY ${parts.join(', ')}`)
      : Prisma.raw('ORDER BY d.document_id DESC');
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
