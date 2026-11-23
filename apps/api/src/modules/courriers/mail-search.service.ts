import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Critères de recherche multicritères courrier (§11). */
export interface MailSearchParams {
  fullText?: string; // Objet/Description/Référence/NReference
  mailType?: number;
  status?: number;
  externalEntityId?: number;
  mailNatureId?: number;
  mailObjetId?: number;
  dateFrom?: string; // YYYY-MM-DD (mail.date)
  dateTo?: string;
  page?: number;
  pageSize?: number;
  sort?: Array<{ field: string; dir: 'asc' | 'desc' }>;
}

export interface MailSearchRow {
  mailId: number;
  title: string;
  nReference: string | null;
  reference: string | null;
  mailType: number;
  status: number;
  date: string | null;
  externalEntity: string | null;
  destinataire: string | null;
}

export interface MailSearchResult {
  total: number;
  page: number;
  pageSize: number;
  rows: MailSearchRow[];
}

/**
 * Borne de date de la recherche : jour calendaire `AAAA-MM-JJ`, ou absente (chaîne vide comprise,
 * déjà ignorée par `buildWhere`). Sans ce contrôle, une valeur comme « abc » ou « 2026-13-01 »
 * atteignait le cast SQL `::date` et la requête échouait en 500 au lieu d'un 400 explicite.
 */
function assertJour(value: string | undefined, champ: 'dateFrom' | 'dateTo'): void {
  if (value === undefined || value === '') return;
  const d = new Date(`${value}T00:00:00Z`);
  const valide =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === value;
  if (!valide) {
    throw new BadRequestException(`${champ} : date invalide (format AAAA-MM-JJ attendu)`);
  }
}

// Colonnes de tri autorisées (valeurs = SQL de confiance, clés validées en amont).
const SORT_COLUMNS: Record<string, string> = {
  title: 'm.title',
  nReference: 'm.n_reference',
  reference: 'm.reference',
  date: 'm.mail_date',
  status: 'm.status',
  mailType: 'm.mail_type',
};

/**
 * Recherche multicritères plein-texte sur les courriers ARCHIVÉS (§11) — le fonds documentaire du
 * module, par opposition aux files de travail qui ne montrent que le courrier en cours. Réutilise
 * le pattern V6 : index d'expression tsvector-GIN `french` (ix_mail_fts), `$queryRaw` paramétré,
 * pagination/tri serveur avec colonnes whitelistées. Exclut toujours les courriers supprimés
 * (is_deleted) et ceux qui ne sont pas encore archivés (cf. `buildWhere`).
 */
@Injectable()
export class MailSearchService {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(p: MailSearchParams): Prisma.Sql {
    // §11 : la recherche est l'ARCHIVE du module — elle ne porte que sur les courriers clos.
    // `date_traited` est le tampon d'archivage (posé par `archiveEffect`) : c'est lui, et non le
    // statut, qui retire un courrier des files actives. Un Arrivée archivé parce qu'un Départ y a
    // répondu (§12) garde son statut d'origine — le filtrer sur `status` en laisserait passer les
    // uns et manquerait les autres.
    const conditions: Prisma.Sql[] = [
      Prisma.sql`m.is_deleted = false`,
      Prisma.sql`m.date_traited IS NOT NULL`,
    ];
    if (p.mailType !== undefined) conditions.push(Prisma.sql`m.mail_type = ${p.mailType}`);
    if (p.status !== undefined) conditions.push(Prisma.sql`m.status = ${p.status}`);
    if (p.externalEntityId)
      conditions.push(Prisma.sql`m.external_entity_id = ${p.externalEntityId}`);
    if (p.mailNatureId) conditions.push(Prisma.sql`m.mail_nature_id = ${p.mailNatureId}`);
    if (p.mailObjetId) conditions.push(Prisma.sql`m.mail_objet_id = ${p.mailObjetId}`);
    if (p.dateFrom) conditions.push(Prisma.sql`m.mail_date >= ${p.dateFrom}::date`);
    if (p.dateTo) conditions.push(Prisma.sql`m.mail_date <= ${p.dateTo}::date`);

    const q = p.fullText?.trim();
    if (q) {
      conditions.push(Prisma.sql`(
        to_tsvector('french',
          coalesce(m.title, '') || ' ' || coalesce(m.description, '') || ' ' ||
          coalesce(m.reference, '') || ' ' || coalesce(m.n_reference, '')
        ) @@ websearch_to_tsquery('french', ${q})
        OR m.title ILIKE ${'%' + q + '%'}
        OR m.n_reference ILIKE ${'%' + q + '%'}
        OR m.reference ILIKE ${'%' + q + '%'}
      )`);
    }
    return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
  }

  private buildOrder(p: MailSearchParams): Prisma.Sql {
    const parts = (p.sort ?? [])
      .filter((s) => SORT_COLUMNS[s.field])
      .map((s) => `${SORT_COLUMNS[s.field]} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
    return parts.length
      ? Prisma.raw(`ORDER BY ${parts.join(', ')}`)
      : Prisma.raw('ORDER BY m.mail_id DESC');
  }

  async search(p: MailSearchParams): Promise<MailSearchResult> {
    // Plage inversée (dateFrom > dateTo) : volontairement NON rejetée — elle ne contredit aucun
    // format et ne correspond simplement à aucun courrier (résultat vide).
    assertJour(p.dateFrom, 'dateFrom');
    assertJour(p.dateTo, 'dateTo');
    const where = this.buildWhere(p);
    const order = this.buildOrder(p);
    const page = Math.max(1, p.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, p.pageSize ?? 25));
    const offset = (page - 1) * pageSize;

    const rows = await this.prisma.$queryRaw<MailSearchRow[]>(Prisma.sql`
      SELECT m.mail_id AS "mailId", m.title, m.n_reference AS "nReference", m.reference,
             m.mail_type AS "mailType", m.status,
             to_char(m.mail_date, 'YYYY-MM-DD') AS "date",
             ee.label AS "externalEntity",
             -- Destinataire = un rôle (Arrivée §05) ou un acteur nommé (Départ §12) ; les deux
             -- colonnes s'excluent, le coalesce restitue donc celui des deux qui est renseigné.
             coalesce(r.name, au.full_name, au.username) AS "destinataire"
      FROM mail m
      LEFT JOIN external_entity ee ON ee.external_entity_id = m.external_entity_id
      LEFT JOIN app_user_group aug ON aug.user_group_id = m.destinataire_expediteur
      LEFT JOIN app_user au ON au.user_id = aug.user_id
      LEFT JOIN role r ON r.role_id = m.destinataire_role_id
      ${where}
      ${order}
      LIMIT ${pageSize} OFFSET ${offset}`);

    const totalRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT count(*)::bigint AS count FROM mail m ${where}`,
    );

    return { total: Number(totalRows[0]?.count ?? 0), page, pageSize, rows };
  }
}
