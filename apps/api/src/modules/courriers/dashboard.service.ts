import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { MailsService } from './mails.service';
import { HIDDEN_MENU_KEYS } from '../roles/menu-catalog';
import {
  MAIL_STATUS_LABELS,
  MAIL_TYPE_LABELS,
  MailInputationTypeId,
  MailStatus,
  MailType,
} from '@archivage/types';
import {
  agregerSla,
  ANCIENNETE_LABELS,
  bucketAnciennete,
  bucketPalier,
  evalSla,
  PALIER_LABELS,
  periodePrecedente,
  regrouperTopN,
  variation,
  type MailScope,
  type PalierEcheance,
  type TrancheAnciennete,
} from './domain';
import { SEUIL_EFFECTIF_CHARGE } from './dashboard.dto';
import type {
  AgentCharge,
  AlertesResponse,
  ChargeResponse,
  DashboardFilterDto,
  ServiceCharge,
  DelaisResponse,
  DelaiStat,
  FileCompteur,
  HygieneIndicateur,
  HygieneResponse,
  FilesResponse,
  FluxResponse,
  RepartitionDimension,
  RepartitionFilterDto,
  RepartitionResponse,
  RetardsBucket,
  RetardsResponse,
  SyntheseResponse,
} from './dashboard.dto';

/**
 * Agrégats du tableau de bord Docu-Courriers.
 *
 * Tout est en **SQL brut** : Prisma `groupBy` ne sait faire ni `date_trunc`, ni `percentile_cont`,
 * ni les compteurs conditionnels `FILTER (WHERE …)` qui permettent de calculer sept files en une
 * seule passe. Règles suivies (identiques au module `analytics`) :
 *   - `$queryRaw` + `Prisma.sql`, valeurs TOUJOURS en paramètres liés ;
 *   - `Prisma.raw` réservé aux noms de colonnes issus d'une liste blanche ;
 *   - `$executeRaw` pour toute instruction ne renvoyant pas de lignes (bug `void → P2010`).
 *
 * Deux invariants portent la justesse des chiffres :
 *   1. le **socle commun** (§3.9) — `is_deleted = false` + règle de visibilité — appliqué partout ;
 *   2. le **périmètre** (`MailScope`) résolu côté serveur via `MailsService.mailScope`, jamais reçu
 *      du client.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mails: MailsService,
  ) {}

  // -------------------------------------------------------------------------
  // Fragments SQL partagés
  // -------------------------------------------------------------------------

  /**
   * Règle de visibilité générale (§3.4) : une Arrivée reste visible même en Rédaction, les autres
   * types seulement une fois sortis de Rédaction. Miroir exact de `MailsService.visibility()`.
   */
  private visibilite(): Prisma.Sql {
    return Prisma.sql`(m.status <> ${MailStatus.Redaction} OR m.mail_type = ${MailType.Arrivee})`;
  }

  /**
   * Périmètre utilisateur. `none` est court-circuité par les appelants (aucune requête émise).
   * `imputed` = l'utilisateur porte une imputation sur le courrier, traitée ou non — c'est
   * l'existence du lien qui compte, comme dans `paginateInScope`.
   */
  private scopeCond(scope: MailScope, user: AuthUser): Prisma.Sql {
    if (scope !== 'imputed') return Prisma.empty;
    return Prisma.sql` AND EXISTS (SELECT 1 FROM mail_inputation mi_s
      WHERE mi_s.mail_id = m.mail_id AND mi_s.user_id = ${user.userGroupId ?? -1})`;
  }

  /**
   * Filtres de dimension. Le filtre « service » remonte les DESCENDANTS via le materialized-path :
   * filtrer sur le seul nœud exact ne rendrait rien pour une direction dont le courrier est porté
   * par ses services. Le `/` final des chemins (`/1/14/`) garantit que `/3/` ne capture pas `/30/`.
   */
  private filtres(f: DashboardFilterDto): Prisma.Sql {
    const conds: Prisma.Sql[] = [];
    if (f.mailType !== undefined) conds.push(Prisma.sql`m.mail_type = ${f.mailType}`);
    if (f.externalEntityId) conds.push(Prisma.sql`m.external_entity_id = ${f.externalEntityId}`);
    if (f.organigrammeId) {
      conds.push(Prisma.sql`m.organigramme_id IN (
        SELECT enfant.organigramme_id FROM organigramme racine
        JOIN organigramme enfant ON enfant.path LIKE racine.path || '%'
        WHERE racine.organigramme_id = ${f.organigrammeId})`);
    }
    return conds.length ? Prisma.sql` AND ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  }

  /** Socle appliqué à toute requête : soft-delete exclu + filtres de dimension + périmètre. */
  private socle(f: DashboardFilterDto, scope: MailScope, user: AuthUser): Prisma.Sql {
    return Prisma.sql`m.is_deleted = false${this.filtres(f)}${this.scopeCond(scope, user)}`;
  }

  /** Colonne de période (liste blanche → `Prisma.raw` sûr). */
  private colonneDate(f: DashboardFilterDto): Prisma.Sql {
    if (f.basis === 'mail_date') return Prisma.raw('m.mail_date::timestamptz');
    if (f.basis === 'created_at') return Prisma.raw('m.created_at');
    return Prisma.raw('m.date_enregistrement_courrier');
  }

  /** Fenêtre analysée (défaut : 30 derniers jours) + la fenêtre précédente de même durée. */
  private periode(f: DashboardFilterDto): {
    from: Date;
    toExcl: Date;
    precFrom: Date;
    precToExcl: Date;
    label: { from: string; to: string };
  } {
    const iso = (d: Date): string => d.toISOString().slice(0, 10);
    const aujourdhui = new Date();
    const to = f.dateTo ? new Date(`${f.dateTo}T00:00:00Z`) : aujourdhui;
    const from = f.dateFrom
      ? new Date(`${f.dateFrom}T00:00:00Z`)
      : new Date(aujourdhui.getTime() - 29 * 86_400_000);

    const prec = periodePrecedente(from, to);
    // Bornes hautes EXCLUSIVES : `< lendemain` évite de perdre les événements du dernier jour.
    return {
      from,
      toExcl: new Date(to.getTime() + 86_400_000),
      precFrom: prec.debut,
      precToExcl: new Date(prec.fin.getTime() + 86_400_000),
      label: { from: iso(from), to: iso(to) },
    };
  }

  private compteur(count: number, age: number | null): FileCompteur {
    return { count, oldestDays: count > 0 && age !== null ? age : null };
  }

  /**
   * Lien de correction — `null` si l'écran cible est masqué (`HIDDEN_MENU_KEYS`).
   *
   * Certains écrans de paramétrage (natures, objets, confidentialités) sont retirés de la barre
   * latérale ET non assignables à un rôle : y renvoyer produirait un cul-de-sac pour tout
   * utilisateur non-admin. Le filtre est fait ICI plutôt que dans l'écran, pour que le jour où l'un
   * d'eux sera démasqué le lien réapparaisse sans qu'on ait à y repenser.
   */
  private lienUtilisable(cleMenu: string): string | null {
    return HIDDEN_MENU_KEYS.includes(cleMenu) ? null : cleMenu;
  }

  // -------------------------------------------------------------------------
  // Zone 1 — Alertes (D1, D3, E5). Hors période : un retard n'appartient pas à une fenêtre.
  // -------------------------------------------------------------------------

  async alertes(user: AuthUser, f: DashboardFilterDto): Promise<AlertesResponse> {
    const scope = await this.mails.mailScope(user);
    if (scope === 'none') {
      return { scope, courriersEnRetard: 0, imputationsEnRetard: 0, sansImputation: 0 };
    }

    const socle = this.socle(f, scope, user);

    const [courriers] = await this.prisma.$queryRaw<
      Array<{ en_retard: number; sans_imputation: number }>
    >(Prisma.sql`
      SELECT
        count(*) FILTER (
          WHERE m.date_butoire < now() AND m.date_traited IS NULL
        )::int AS en_retard,
        count(*) FILTER (
          WHERE m.date_traited IS NULL
            AND NOT EXISTS (SELECT 1 FROM mail_inputation mi WHERE mi.mail_id = m.mail_id)
        )::int AS sans_imputation
      FROM mail m
      WHERE ${socle} AND ${this.visibilite()}
    `);

    // D3 — l'angle mort : `shouldRemindInputation` cesse de relancer dès `deadline < now`, ces
    // imputations sont donc devenues muettes. En périmètre « imputed », on ne compte que les
    // siennes ; en périmètre global, toutes celles des courriers visibles.
    const filtreImpute =
      scope === 'imputed' ? Prisma.sql` AND mi.user_id = ${user.userGroupId ?? -1}` : Prisma.empty;

    const [imputations] = await this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM mail_inputation mi
      JOIN mail m ON m.mail_id = mi.mail_id
      WHERE mi.deadline < now() AND mi.date_treated IS NULL${filtreImpute}
        AND ${socle} AND ${this.visibilite()}
    `);

    return {
      scope,
      courriersEnRetard: courriers?.en_retard ?? 0,
      imputationsEnRetard: imputations?.n ?? 0,
      sansImputation: courriers?.sans_imputation ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Zone 2 — Tour de contrôle (B1…B7)
  // -------------------------------------------------------------------------

  /**
   * Chaque compteur reprend le `where` RÉEL de son écran, quirks compris (règle §1.2) : c'est ce
   * que l'utilisateur recoupe visuellement, et un compteur « corrigé » passerait pour un bug.
   *
   * Deux quirks délibérément reproduits :
   *   - **B3** n'applique NI la règle de visibilité NI de filtre `validation_direction` — le drapeau
   *     est posé en même temps que `date_traited`, le filtrer masquerait un courrier validé non traité ;
   *   - **B5** se fonde sur l'absence d'un document `decharge = true`, et NON sur le drapeau
   *     `mail.decharge` : seule la pièce signée atteste la décharge (§3.1).
   *
   * ⚠️ Divergence assumée : B1 et B2 sont PERSONNELS dans l'application (filtrés sur le
   * destinataire / l'imputé). En périmètre global, on en calcule la version « tous services » —
   * c'est un compteur différent, que l'écran doit libeller comme tel.
   */
  async files(user: AuthUser, f: DashboardFilterDto): Promise<FilesResponse> {
    const scope = await this.mails.mailScope(user);
    const vide = this.compteur(0, null);
    if (scope === 'none') {
      return {
        scope,
        aControler: vide,
        parapheur: vide,
        validationDirection: vide,
        validationDg: vide,
        decharge: vide,
        scans: vide,
        enCours: vide,
      };
    }

    const socle = this.socle(f, scope, user);
    const visible = this.visibilite();

    const [r] = await this.prisma.$queryRaw<Array<Record<string, number | null>>>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE b1)::int AS b1, max(age) FILTER (WHERE b1)::int AS b1_age,
        count(*) FILTER (WHERE b2)::int AS b2, max(age) FILTER (WHERE b2)::int AS b2_age,
        count(*) FILTER (WHERE b3)::int AS b3, max(age) FILTER (WHERE b3)::int AS b3_age,
        count(*) FILTER (WHERE b4)::int AS b4, max(age) FILTER (WHERE b4)::int AS b4_age,
        count(*) FILTER (WHERE b5)::int AS b5, max(age) FILTER (WHERE b5)::int AS b5_age,
        count(*) FILTER (WHERE b7)::int AS b7, max(age) FILTER (WHERE b7)::int AS b7_age
      FROM (
        SELECT
          -- date_enregistrement_courrier est nullable : created_at prend le relais, sinon
          -- l'ancienneté du plus vieil élément serait silencieusement fausse.
          EXTRACT(day FROM now() - COALESCE(m.date_enregistrement_courrier, m.created_at))::int AS age,
          (m.valider = false AND ${visible}) AS b1,
          (${visible} AND EXISTS (
            SELECT 1 FROM mail_inputation mi
            WHERE mi.mail_id = m.mail_id AND mi.date_treated IS NULL
              AND mi.mail_inputation_type_id <> ${MailInputationTypeId.EnCopie})) AS b2,
          (m.valider = true AND m.date_traited IS NULL) AS b3,
          (m.valider = true AND EXISTS (
            SELECT 1 FROM mail_inputation mi
            WHERE mi.mail_id = m.mail_id AND mi.date_treated IS NULL
              AND mi.mail_inputation_type_id = ${MailInputationTypeId.ValidationDG})) AS b4,
          (m.mail_type = ${MailType.Depart} AND NOT EXISTS (
            SELECT 1 FROM mail_document md
            WHERE md.mail_id = m.mail_id AND md.decharge = true)) AS b5,
          (m.date_traited IS NULL AND ${visible}) AS b7
        FROM mail m
        WHERE ${socle}
      ) t
    `);

    // B6 — file de numérisation : table distincte, sans lien utilisateur ni dimension courrier,
    // donc ni périmètre ni filtres applicables.
    const [scans] = await this.prisma.$queryRaw<Array<{ n: number; age: number | null }>>(
      Prisma.sql`
        SELECT count(*)::int AS n,
               max(EXTRACT(day FROM now() - date_scanned))::int AS age
        FROM mail_scanned_document WHERE is_traite = false
      `,
    );

    const lire = (cle: string): FileCompteur =>
      this.compteur(Number(r?.[cle] ?? 0), r?.[`${cle}_age`] ?? null);

    return {
      scope,
      aControler: lire('b1'),
      parapheur: lire('b2'),
      validationDirection: lire('b3'),
      validationDg: lire('b4'),
      decharge: lire('b5'),
      scans: this.compteur(scans?.n ?? 0, scans?.age ?? null),
      enCours: lire('b7'),
    };
  }

  // -------------------------------------------------------------------------
  // Zone 3 — Synthèse (A1, A4, A5, C3)
  // -------------------------------------------------------------------------

  async synthese(user: AuthUser, f: DashboardFilterDto): Promise<SyntheseResponse> {
    const scope = await this.mails.mailScope(user);
    const p = this.periode(f);

    if (scope === 'none') {
      return {
        scope,
        periode: p.label,
        enregistres: variation(0, 0),
        traites: variation(0, 0),
        enCours: 0,
        delaiMedianJours: null,
        delaiP90Jours: null,
        parType: [],
      };
    }

    const socle = this.socle(f, scope, user);
    const dc = this.colonneDate(f);

    // `archivage` applique le CASE du §3.7 : sans lui, la totalité des Départs disparaîtrait des
    // statistiques d'archivage. `percentile_cont` ignore les NULL, d'où le CASE dans l'ORDER BY qui
    // restreint le délai aux courriers archivés PENDANT la période, sans avoir besoin de FILTER.
    const [r] = await this.prisma.$queryRaw<
      Array<{
        enregistres: number;
        enregistres_prec: number;
        traites: number;
        traites_prec: number;
        en_cours: number;
        delai_median: number | null;
        delai_p90: number | null;
      }>
    >(Prisma.sql`
      WITH base AS (
        SELECT ${dc} AS reference_date,
               m.date_enregistrement_courrier AS enreg,
               m.date_traited,
               (CASE WHEN m.mail_type = ${MailType.Depart} THEN m.date_decharge ELSE m.date_traited END) AS archivage
        FROM mail m
        WHERE ${socle} AND ${this.visibilite()}
      )
      SELECT
        count(*) FILTER (WHERE reference_date >= ${p.from} AND reference_date < ${p.toExcl})::int AS enregistres,
        count(*) FILTER (WHERE reference_date >= ${p.precFrom} AND reference_date < ${p.precToExcl})::int AS enregistres_prec,
        count(*) FILTER (WHERE archivage >= ${p.from} AND archivage < ${p.toExcl})::int AS traites,
        count(*) FILTER (WHERE archivage >= ${p.precFrom} AND archivage < ${p.precToExcl})::int AS traites_prec,
        count(*) FILTER (WHERE date_traited IS NULL)::int AS en_cours,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY (
          CASE WHEN archivage >= ${p.from} AND archivage < ${p.toExcl} AND enreg IS NOT NULL
               THEN EXTRACT(day FROM archivage - enreg) END)) AS delai_median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY (
          CASE WHEN archivage >= ${p.from} AND archivage < ${p.toExcl} AND enreg IS NOT NULL
               THEN EXTRACT(day FROM archivage - enreg) END)) AS delai_p90
      FROM base
    `);

    const parType = await this.prisma.$queryRaw<
      Array<{ mail_type: number; enregistres: number; traites: number; en_cours: number }>
    >(Prisma.sql`
      SELECT m.mail_type,
        count(*) FILTER (WHERE ${dc} >= ${p.from} AND ${dc} < ${p.toExcl})::int AS enregistres,
        count(*) FILTER (
          WHERE (CASE WHEN m.mail_type = ${MailType.Depart} THEN m.date_decharge ELSE m.date_traited END)
                >= ${p.from}
            AND (CASE WHEN m.mail_type = ${MailType.Depart} THEN m.date_decharge ELSE m.date_traited END)
                < ${p.toExcl})::int AS traites,
        count(*) FILTER (WHERE m.date_traited IS NULL)::int AS en_cours
      FROM mail m
      WHERE ${socle} AND ${this.visibilite()}
      GROUP BY m.mail_type ORDER BY m.mail_type
    `);

    const arrondir = (v: number | null): number | null =>
      v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

    return {
      scope,
      periode: p.label,
      enregistres: variation(r?.enregistres ?? 0, r?.enregistres_prec ?? 0),
      traites: variation(r?.traites ?? 0, r?.traites_prec ?? 0),
      enCours: r?.en_cours ?? 0,
      delaiMedianJours: arrondir(r?.delai_median ?? null),
      delaiP90Jours: arrondir(r?.delai_p90 ?? null),
      parType: parType.map(
        (t: { mail_type: number; enregistres: number; traites: number; en_cours: number }) => ({
          mailType: t.mail_type,
          enregistres: t.enregistres,
          traites: t.traites,
          enCours: t.en_cours,
        }),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Zone 4 — Flux entrées/sorties et backlog cumulé (A7, A8)
  // -------------------------------------------------------------------------

  /** Pas de la série, par granularité (liste blanche → jamais de valeur client dans le SQL). */
  private pas(granularity: DashboardFilterDto['granularity']): string {
    switch (granularity) {
      case 'week':
        return '1 week';
      case 'month':
        return '1 month';
      case 'quarter':
        return '3 months';
      case 'year':
        return '1 year';
      default:
        return '1 day';
    }
  }

  /**
   * Série temporelle des entrées et des sorties, plus le backlog cumulé.
   *
   * Deux précautions sans lesquelles le graphe ment :
   *  1. **`generate_series` + `LEFT JOIN`** : les seaux sans activité valent 0 et restent présents.
   *     Un simple `GROUP BY` les ferait disparaître, et la courbe relierait deux dates non
   *     contiguës comme si rien ne s'était passé entre elles.
   *  2. **Amorce (`backlogInitial`)** : le stock accumulé AVANT la fenêtre. Sans lui, la courbe
   *     cumulée repartirait de zéro à chaque changement de période et afficherait un backlog
   *     grossièrement sous-évalué.
   */
  async flux(user: AuthUser, f: DashboardFilterDto): Promise<FluxResponse> {
    const scope = await this.mails.mailScope(user);
    const p = this.periode(f);

    if (scope === 'none') {
      return {
        scope,
        granularity: f.granularity,
        periode: p.label,
        backlogInitial: 0,
        points: [],
      };
    }

    const dc = this.colonneDate(f);
    const gran = f.granularity; // paramètre lié : date_trunc accepte du texte
    const pas = this.pas(f.granularity);

    const lignes = await this.prisma.$queryRaw<
      Array<{ bucket: Date; entrees: number; sorties: number; backlog_net: number }>
    >(Prisma.sql`
      WITH faits AS (
        SELECT
          date_trunc(${gran}, ${dc}) AS b_in,
          date_trunc(${gran}, (CASE WHEN m.mail_type = ${MailType.Depart}
                                    THEN m.date_decharge ELSE m.date_traited END)) AS b_out
        FROM mail m
        WHERE ${this.socle(f, scope, user)} AND ${this.visibilite()}
      ),
      debut AS (SELECT date_trunc(${gran}, ${p.from}::timestamptz) AS d0),
      serie AS (
        SELECT generate_series((SELECT d0 FROM debut), ${p.toExcl}::timestamptz, ${pas}::interval) AS bucket
      ),
      entrees AS (SELECT b_in AS bucket, count(*)::int AS n FROM faits WHERE b_in IS NOT NULL GROUP BY 1),
      sorties AS (SELECT b_out AS bucket, count(*)::int AS n FROM faits WHERE b_out IS NOT NULL GROUP BY 1),
      amorce AS (
        SELECT (
          (SELECT count(*) FROM faits WHERE b_in  < (SELECT d0 FROM debut))
        - (SELECT count(*) FROM faits WHERE b_out < (SELECT d0 FROM debut))
        )::int AS init
      )
      SELECT s.bucket,
             COALESCE(e.n, 0) AS entrees,
             COALESCE(x.n, 0) AS sorties,
             ((SELECT init FROM amorce)
              + SUM(COALESCE(e.n, 0) - COALESCE(x.n, 0)) OVER (ORDER BY s.bucket))::int AS backlog_net
      FROM serie s
      LEFT JOIN entrees e ON e.bucket = s.bucket
      LEFT JOIN sorties x ON x.bucket = s.bucket
      -- generate_series inclut sa borne haute quand elle tombe juste : sans ce filtre, le graphe
      -- afficherait un seau AU-DELÀ de la période demandée.
      WHERE s.bucket < ${p.toExcl}::timestamptz
      ORDER BY s.bucket
    `);

    const [amorce] = await this.prisma.$queryRaw<Array<{ init: number }>>(Prisma.sql`
      WITH faits AS (
        SELECT ${dc} AS d_in,
               (CASE WHEN m.mail_type = ${MailType.Depart}
                     THEN m.date_decharge ELSE m.date_traited END) AS d_out
        FROM mail m
        WHERE ${this.socle(f, scope, user)} AND ${this.visibilite()}
      )
      SELECT ((SELECT count(*) FROM faits WHERE d_in  < ${p.from})
            - (SELECT count(*) FROM faits WHERE d_out < ${p.from}))::int AS init
    `);

    return {
      scope,
      granularity: f.granularity,
      periode: p.label,
      backlogInitial: amorce?.init ?? 0,
      points: lignes.map((l) => ({
        bucket: new Date(l.bucket).toISOString().slice(0, 10),
        entrees: l.entrees,
        sorties: l.sorties,
        backlogNet: l.backlog_net,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Zone 5 — Répartitions (A2, A3, F1–F4)
  // -------------------------------------------------------------------------

  /**
   * Traduction dimension → (colonne de libellé, jointures). Les valeurs viennent d'un `z.enum`,
   * donc `Prisma.raw` est sûr ici : aucune chaîne client n'y transite.
   *
   * ⚠️ Toutes les jointures sont des **LEFT JOIN sans filtre `is_active`**. Un référentiel
   * désactivé reste référencé par les courriers historiques : filtrer sur l'actif ferait
   * silencieusement disparaître ces courriers du camembert, et le total ne réconcilierait plus.
   */
  private dimension(d: RepartitionDimension): { colonne: Prisma.Sql; jointures: Prisma.Sql } {
    const rien = Prisma.empty;
    switch (d) {
      case 'statut':
        return { colonne: Prisma.raw('m.status::text'), jointures: rien };
      case 'type':
        return { colonne: Prisma.raw('m.mail_type::text'), jointures: rien };
      case 'correspondant':
        return {
          colonne: Prisma.raw('ee.label'),
          jointures: Prisma.sql` LEFT JOIN external_entity ee ON ee.external_entity_id = m.external_entity_id`,
        };
      case 'type_entite':
        return {
          colonne: Prisma.raw('eet.label'),
          jointures: Prisma.sql` LEFT JOIN external_entity ee ON ee.external_entity_id = m.external_entity_id
            LEFT JOIN external_entity_type eet ON eet.external_entity_type_id = ee.external_entity_type_id`,
        };
      case 'nature':
        return {
          colonne: Prisma.raw('mn.label'),
          jointures: Prisma.sql` LEFT JOIN mail_nature mn ON mn.mail_nature_id = m.mail_nature_id`,
        };
      case 'objet':
        return {
          colonne: Prisma.raw('mo.label'),
          jointures: Prisma.sql` LEFT JOIN mail_objet mo ON mo.mail_objet_id = m.mail_objet_id`,
        };
      case 'confidentialite':
        return {
          colonne: Prisma.raw('mc.label'),
          jointures: Prisma.sql` LEFT JOIN mail_confidentialite mc ON mc.mail_confidentialite_id = m.confidentialite_id`,
        };
      case 'type_depart':
        return {
          colonne: Prisma.raw('mdt.label'),
          jointures: Prisma.sql` LEFT JOIN mail_depart_type mdt ON mdt.mail_depart_type_id = m.mail_depart_type_id`,
        };
      case 'service':
        return {
          colonne: Prisma.raw('org.label'),
          jointures: Prisma.sql` LEFT JOIN organigramme org ON org.organigramme_id = m.organigramme_id`,
        };
    }
  }

  /** Libellé de la tranche « non renseignée », adapté à la dimension. */
  private labelNul(d: RepartitionDimension): string {
    if (d === 'service') return '— Non rattaché —';
    if (d === 'correspondant' || d === 'type_entite') return '— Sans correspondant —';
    return '— Non renseigné —';
  }

  async repartition(user: AuthUser, f: RepartitionFilterDto): Promise<RepartitionResponse> {
    const scope = await this.mails.mailScope(user);
    const p = this.periode(f);

    if (scope === 'none') {
      return { scope, dimension: f.dimension, periode: p.label, total: 0, tranches: [] };
    }

    const { colonne, jointures } = this.dimension(f.dimension);
    const dc = this.colonneDate(f);

    const lignes = await this.prisma.$queryRaw<Array<{ cle: string | null; valeur: number }>>(
      Prisma.sql`
        SELECT ${colonne} AS cle, count(*)::int AS valeur
        FROM mail m${jointures}
        WHERE ${this.socle(f, scope, user)} AND ${this.visibilite()}
          AND ${dc} >= ${p.from} AND ${dc} < ${p.toExcl}
        GROUP BY ${colonne}
        ORDER BY valeur DESC
      `,
    );

    // Les codes numériques (statut, type) deviennent des libellés métier AVANT le regroupement,
    // sinon le Top N trierait des chaînes « 0 », « 1 »… illisibles à l'écran.
    const nommees = lignes.map((l) => ({
      cle: this.libelleDimension(f.dimension, l.cle),
      valeur: l.valeur,
    }));

    const tranches = regrouperTopN(nommees, { labelNull: this.labelNul(f.dimension) });

    return {
      scope,
      dimension: f.dimension,
      periode: p.label,
      total: nommees.reduce((acc, l) => acc + l.valeur, 0),
      tranches,
    };
  }

  private libelleDimension(d: RepartitionDimension, cle: string | null): string | null {
    if (cle === null) return null;
    if (d === 'statut') return MAIL_STATUS_LABELS[Number(cle) as MailStatus] ?? `Statut ${cle}`;
    if (d === 'type') return MAIL_TYPE_LABELS[Number(cle) as MailType] ?? `Type ${cle}`;
    return cle;
  }

  // -------------------------------------------------------------------------
  // Zone 6a — Retards (D4 paliers, D5 ancienneté, D6 top)
  // -------------------------------------------------------------------------

  /**
   * Le SQL agrège par **nombre de jours**, pas par tranche : le regroupement final est fait par
   * `bucketPalier` / `bucketAnciennete`, les fonctions pures du domaine.
   *
   * C'est délibéré. Coder les bornes une seconde fois en SQL les ferait diverger du jour où l'une
   * des deux changerait, et les tests du domaine ne protégeraient plus rien. Le volume transféré
   * reste borné (une ligne par valeur de jour distincte, pas une par courrier).
   */
  async retards(user: AuthUser, f: DashboardFilterDto): Promise<RetardsResponse> {
    const scope = await this.mails.mailScope(user);
    if (scope === 'none') {
      return { scope, paliers: [], anciennete: [], top: [], sansEcheance: 0 };
    }

    const socle = this.socle(f, scope, user);
    const visible = this.visibilite();

    const [parJour, parAge, top, sansEcheance] = await Promise.all([
      this.prisma.$queryRaw<Array<{ j: number; n: number }>>(Prisma.sql`
        SELECT EXTRACT(day FROM m.date_butoire - now())::int AS j, count(*)::int AS n
        FROM mail m
        WHERE ${socle} AND ${visible}
          AND m.date_traited IS NULL AND m.date_butoire IS NOT NULL
        GROUP BY 1
      `),
      this.prisma.$queryRaw<Array<{ a: number; n: number }>>(Prisma.sql`
        SELECT EXTRACT(day FROM now() - COALESCE(m.date_enregistrement_courrier, m.created_at))::int AS a,
               count(*)::int AS n
        FROM mail m
        WHERE ${socle} AND ${visible} AND m.date_traited IS NULL
        GROUP BY 1
      `),
      this.prisma.$queryRaw<
        Array<{ mail_id: number; title: string; reference: string | null; jours: number }>
      >(Prisma.sql`
        SELECT m.mail_id, m.title, m.reference,
               EXTRACT(day FROM now() - m.date_butoire)::int AS jours
        FROM mail m
        WHERE ${socle} AND ${visible}
          AND m.date_traited IS NULL AND m.date_butoire < now()
        ORDER BY jours DESC, m.mail_id
        LIMIT 20
      `),
      this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS n FROM mail m
        WHERE ${socle} AND ${visible}
          AND m.date_traited IS NULL AND m.date_butoire IS NULL
      `),
    ]);

    const paliers = new Map<PalierEcheance, number>();
    for (const { j, n } of parJour) {
      const cle = bucketPalier(j);
      paliers.set(cle, (paliers.get(cle) ?? 0) + n);
    }
    const anciennete = new Map<TrancheAnciennete, number>();
    for (const { a, n } of parAge) {
      const cle = bucketAnciennete(a);
      anciennete.set(cle, (anciennete.get(cle) ?? 0) + n);
    }

    // Toutes les tranches sont rendues, y compris à zéro : un palier absent du graphe se lit
    // comme « pas de données », un palier à zéro se lit comme « rien en retard ».
    const rendre = <T extends string>(
      libelles: Record<T, string>,
      compte: Map<T, number>,
    ): RetardsBucket[] =>
      (Object.keys(libelles) as T[]).map((cle) => ({
        cle,
        label: libelles[cle],
        count: compte.get(cle) ?? 0,
      }));

    return {
      scope,
      paliers: rendre(PALIER_LABELS, paliers),
      anciennete: rendre(ANCIENNETE_LABELS, anciennete),
      top: top.map((t) => ({
        mailId: t.mail_id,
        title: t.title,
        reference: t.reference,
        joursRetard: t.jours,
      })),
      sansEcheance: sansEcheance[0]?.n ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Zone 6b — Délais (C1, C3, C4, C5)
  // -------------------------------------------------------------------------

  private stat(row?: { mediane: number | null; p90: number | null; n: number }): DelaiStat {
    const arrondir = (v: number | null | undefined): number | null =>
      v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;
    return {
      medianeJours: arrondir(row?.mediane),
      p90Jours: arrondir(row?.p90),
      n: row?.n ?? 0,
    };
  }

  async delais(user: AuthUser, f: DashboardFilterDto): Promise<DelaisResponse> {
    const scope = await this.mails.mailScope(user);
    const p = this.periode(f);
    const vide = this.stat();

    if (scope === 'none') {
      return {
        scope,
        periode: p.label,
        priseEnCharge: vide,
        traitementGlobal: vide,
        sla: {
          configure: false,
          dansLesDelais: 0,
          horsDelais: 0,
          nonEvalues: 0,
          objetsSansDuree: 0,
          lienConfiguration: null,
        },
        imputations: { auto: vide, manuel: vide },
      };
    }

    const socle = this.socle(f, scope, user);
    const visible = this.visibilite();
    const archivage = Prisma.sql`(CASE WHEN m.mail_type = ${MailType.Depart}
                                       THEN m.date_decharge ELSE m.date_traited END)`;

    const [priseEnCharge, traitement, slaLignes, objetsSansDuree, imputations] = await Promise.all([
      // C1 — la date du courrier est un `date` : cast obligatoire pour la soustraction.
      this.prisma.$queryRaw<Array<{ mediane: number | null; p90: number | null; n: number }>>(
        Prisma.sql`
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d) AS mediane,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY d) AS p90,
                 count(*)::int AS n
          FROM (
            SELECT EXTRACT(day FROM m.date_enregistrement_courrier - m.mail_date::timestamptz) AS d
            FROM mail m
            WHERE ${socle} AND ${visible}
              AND m.date_enregistrement_courrier IS NOT NULL
              AND m.date_enregistrement_courrier >= ${p.from}
              AND m.date_enregistrement_courrier < ${p.toExcl}
          ) t WHERE d IS NOT NULL
        `,
      ),
      // C3 — sur les courriers ARCHIVÉS pendant la période (date d'archivage selon le type).
      this.prisma.$queryRaw<Array<{ mediane: number | null; p90: number | null; n: number }>>(
        Prisma.sql`
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d) AS mediane,
                 percentile_cont(0.9) WITHIN GROUP (ORDER BY d) AS p90,
                 count(*)::int AS n
          FROM (
            SELECT EXTRACT(day FROM ${archivage} - m.date_enregistrement_courrier) AS d
            FROM mail m
            WHERE ${socle} AND ${visible}
              AND m.date_enregistrement_courrier IS NOT NULL
              AND ${archivage} >= ${p.from} AND ${archivage} < ${p.toExcl}
          ) t WHERE d IS NOT NULL
        `,
      ),
      // C4 — agrégé par (type, durées, délai) : la cardinalité reste faible, et le verdict est
      // rendu par `evalSla`, seul détenteur de la règle « 0 = non configuré ».
      this.prisma.$queryRaw<
        Array<{
          mail_type: number;
          duree_ext: number | null;
          duree_int: number | null;
          d: number | null;
          n: number;
        }>
      >(Prisma.sql`
        SELECT m.mail_type,
               o.duree_suivi_externe AS duree_ext,
               o.duree_suivi_interne AS duree_int,
               EXTRACT(day FROM ${archivage} - m.date_enregistrement_courrier)::int AS d,
               count(*)::int AS n
        FROM mail m
        LEFT JOIN mail_objet o ON o.mail_objet_id = m.mail_objet_id
        WHERE ${socle} AND ${visible}
          AND m.date_enregistrement_courrier IS NOT NULL
          AND ${archivage} >= ${p.from} AND ${archivage} < ${p.toExcl}
        GROUP BY 1, 2, 3, 4
      `),
      // G4 — la cause corrigeable, affichée quand le SLA n'est pas calculable.
      this.prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(*)::int AS n FROM mail_objet
        WHERE is_active = true AND duree_suivi_externe = 0 AND duree_suivi_interne = 0
      `),
      // C5 — ségrégé par le drapeau `suivi` du TYPE d'imputation (auto-traitement à la lecture).
      this.prisma.$queryRaw<
        Array<{ suivi: boolean; mediane: number | null; p90: number | null; n: number }>
      >(Prisma.sql`
        SELECT mit.suivi,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(day FROM mi.date_treated - mi.created_at)) AS mediane,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(day FROM mi.date_treated - mi.created_at)) AS p90,
               count(*)::int AS n
        FROM mail_inputation mi
        JOIN mail_inputation_type mit ON mit.mail_inputation_type_id = mi.mail_inputation_type_id
        JOIN mail m ON m.mail_id = mi.mail_id
        WHERE ${socle} AND ${visible}
          AND mi.date_treated IS NOT NULL
          AND mi.date_treated >= ${p.from} AND mi.date_treated < ${p.toExcl}
        GROUP BY mit.suivi
      `),
    ]);

    // Chaque ligne agrégée pèse `n` courriers : on répète l'évaluation pour conserver les effectifs.
    const evaluations = slaLignes.flatMap((l) =>
      Array.from({ length: l.n }, () =>
        evalSla(l.d, l.mail_type as MailType, l.duree_ext, l.duree_int),
      ),
    );
    const sla = agregerSla(evaluations);

    const auto = imputations.find((i) => i.suivi === true);
    const manuel = imputations.find((i) => i.suivi === false);

    return {
      scope,
      periode: p.label,
      priseEnCharge: this.stat(priseEnCharge[0]),
      traitementGlobal: this.stat(traitement[0]),
      sla: {
        ...sla,
        objetsSansDuree: objetsSansDuree[0]?.n ?? 0,
        lienConfiguration: this.lienUtilisable('/admin/courriers/objets'),
      },
      imputations: { auto: this.stat(auto), manuel: this.stat(manuel) },
    };
  }

  // -------------------------------------------------------------------------
  // Zone 7 — Charge de travail (E1, E2, E3, C7) — restitution nominative
  // -------------------------------------------------------------------------

  /**
   * Charge par agent et par service.
   *
   * ⚠️ **403 hors périmètre global.** Ce n'est pas du masquage d'interface : un agent qui
   * interrogerait l'endpoint directement obtiendrait sinon le classement de ses collègues. La
   * restriction vit donc ici, pas dans l'écran.
   *
   * Le délai médian est tu sous `SEUIL_EFFECTIF_CHARGE` dossiers — un percentile calculé sur deux
   * imputations n'est pas une performance, c'est du bruit qu'un classement rendrait tranchant.
   * Les compteurs, eux, sont rendus : ce sont des faits, pas des statistiques.
   */
  async charge(user: AuthUser, f: DashboardFilterDto): Promise<ChargeResponse> {
    const scope = await this.mails.mailScope(user);
    if (scope !== 'all') {
      throw new ForbiddenException(
        'La charge de travail n’est consultable qu’avec la permission de suivi permanent.',
      );
    }

    const p = this.periode(f);
    const socle = this.socle(f, scope, user);
    const visible = this.visibilite();

    const [agents, services, nonRattache] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          user_group_id: number;
          nom: string | null;
          username: string;
          groupe: string | null;
          ouvertes: number;
          traitees: number;
          en_retard: number;
          mediane: number | null;
          n: number;
        }>
      >(Prisma.sql`
        SELECT ug.user_group_id, u.full_name AS nom, u.username, g.name AS groupe,
          count(*) FILTER (WHERE mi.date_treated IS NULL)::int AS ouvertes,
          count(*) FILTER (
            WHERE mi.date_treated >= ${p.from} AND mi.date_treated < ${p.toExcl}
          )::int AS traitees,
          count(*) FILTER (
            WHERE mi.date_treated IS NULL AND mi.deadline < now()
          )::int AS en_retard,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY (
            CASE WHEN mi.date_treated >= ${p.from} AND mi.date_treated < ${p.toExcl}
                 THEN EXTRACT(day FROM mi.date_treated - mi.created_at) END)) AS mediane,
          count(*) FILTER (
            WHERE mi.date_treated >= ${p.from} AND mi.date_treated < ${p.toExcl}
          )::int AS n
        FROM mail_inputation mi
        JOIN mail m ON m.mail_id = mi.mail_id
        JOIN app_user_group ug ON ug.user_group_id = mi.user_id
        JOIN app_user u ON u.user_id = ug.user_id
        LEFT JOIN app_group g ON g.group_id = ug.group_id
        WHERE ${socle} AND ${visible} AND u.is_disabled = false
        GROUP BY ug.user_group_id, u.full_name, u.username, g.name
        HAVING count(*) FILTER (WHERE mi.date_treated IS NULL) > 0
            OR count(*) FILTER (WHERE mi.date_treated >= ${p.from} AND mi.date_treated < ${p.toExcl}) > 0
        ORDER BY ouvertes DESC, traitees DESC
      `),
      // Rollup materialized-path : un nœud parent agrège ses descendants. Le `/` final des chemins
      // évite que `/3/` capture `/30/`.
      this.prisma.$queryRaw<
        Array<{ organigramme_id: number; label: string; depth: number; ouvertes: number }>
      >(Prisma.sql`
        SELECT racine.organigramme_id, racine.label, racine.depth,
               (SELECT count(*)::int
                  FROM mail_inputation mi
                  JOIN mail m ON m.mail_id = mi.mail_id
                 WHERE mi.date_treated IS NULL
                   AND ${socle} AND ${visible}
                   AND m.organigramme_id IN (
                     SELECT enfant.organigramme_id FROM organigramme enfant
                      WHERE enfant.path LIKE racine.path || '%')) AS ouvertes
        FROM organigramme racine
        WHERE racine.is_active = true
        ORDER BY racine.path
      `),
      // Tranche « Non rattaché » : jamais un WHERE ... IS NOT NULL silencieux — ces courriers
      // existent, et leur absence de rattachement est précisément l'information utile (G9).
      this.prisma.$queryRaw<Array<{ ouvertes: number }>>(Prisma.sql`
        SELECT count(*)::int AS ouvertes
        FROM mail_inputation mi
        JOIN mail m ON m.mail_id = mi.mail_id
        WHERE mi.date_treated IS NULL AND m.organigramme_id IS NULL
          AND ${socle} AND ${visible}
      `),
    ]);

    const arrondir = (v: number | null): number | null =>
      v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

    const lignesAgents: AgentCharge[] = agents.map((a) => ({
      userGroupId: a.user_group_id,
      label: `${a.nom?.trim() || a.username}${a.groupe ? ` — ${a.groupe}` : ''}`,
      ouvertes: a.ouvertes,
      traitees: a.traitees,
      enRetard: a.en_retard,
      delaiMedianJours: a.n >= SEUIL_EFFECTIF_CHARGE ? arrondir(a.mediane) : null,
      n: a.n,
    }));

    const lignesServices: ServiceCharge[] = services.map((s) => ({
      organigrammeId: s.organigramme_id,
      label: s.label,
      depth: s.depth,
      ouvertes: s.ouvertes,
    }));
    const orphelins = nonRattache[0]?.ouvertes ?? 0;
    if (orphelins > 0) {
      lignesServices.push({
        organigrammeId: null,
        label: '— Non rattaché —',
        depth: 0,
        ouvertes: orphelins,
      });
    }

    return {
      scope,
      periode: p.label,
      agents: lignesAgents,
      services: lignesServices,
      seuilEffectif: SEUIL_EFFECTIF_CHARGE,
    };
  }

  // -------------------------------------------------------------------------
  // Zone 9 — Hygiène des données (G1–G9)
  // -------------------------------------------------------------------------

  /**
   * Défauts de saisie et de paramétrage qui **dégradent silencieusement les autres indicateurs**.
   *
   * Chaque entrée dit sa conséquence, pas seulement son compteur : « 17 courriers sans échéance »
   * n'appelle aucune action, « 17 courriers qu'aucune relance ne signalera jamais » si.
   *
   * Requête unique à base de sous-`SELECT` : neuf comptages indépendants sur des tables différentes,
   * un aller-retour.
   */
  async hygiene(user: AuthUser, f: DashboardFilterDto): Promise<HygieneResponse> {
    const scope = await this.mails.mailScope(user);
    if (scope === 'none') return { scope, indicateurs: [] };

    const socle = this.socle(f, scope, user);
    const visible = this.visibilite();

    const [r] = await this.prisma.$queryRaw<
      Array<{
        g1: number;
        g2: number;
        g3: number;
        g4: number;
        g5: number;
        g6: number;
        g7: number;
        g8: number;
        g9: number;
      }>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM mail m
          WHERE ${socle} AND ${visible}
            AND m.date_butoire IS NULL AND m.date_traited IS NULL) AS g1,

        (SELECT count(*)::int FROM mail_inputation mi
          JOIN mail m ON m.mail_id = mi.mail_id
          WHERE ${socle} AND mi.deadline IS NULL AND mi.date_treated IS NULL) AS g2,

        (SELECT count(*)::int FROM mail_scanned_document
          WHERE is_traite = false AND date_scanned < now() - interval '30 days') AS g3,

        (SELECT count(*)::int FROM mail_objet
          WHERE is_active = true AND duree_suivi_externe = 0 AND duree_suivi_interne = 0) AS g4,

        -- G5 : référentiels DÉSACTIVÉS encore portés par des courriers. Ce n'est pas une erreur en
        -- soi (l'historique doit rester lisible), mais un référentiel retiré trop tôt fait
        -- apparaître dans les répartitions des libellés qu'on ne peut plus administrer.
        (SELECT count(DISTINCT m.mail_id)::int FROM mail m
          LEFT JOIN mail_nature n ON n.mail_nature_id = m.mail_nature_id
          LEFT JOIN mail_objet o ON o.mail_objet_id = m.mail_objet_id
          LEFT JOIN mail_confidentialite c ON c.mail_confidentialite_id = m.confidentialite_id
          LEFT JOIN external_entity e ON e.external_entity_id = m.external_entity_id
          WHERE ${socle}
            AND (n.is_active = false OR o.is_active = false
                 OR c.is_active = false OR e.is_active = false)) AS g5,

        (SELECT count(*)::int FROM mail WHERE is_deleted = true) AS g6,

        (SELECT count(*)::int FROM notification WHERE is_read = false) AS g7,

        -- G8 : correspondants en doublon probable. createExternalEntity est le seul create du
        -- module qui NE vérifie PAS l'unicité du libellé, et deux écrans peuvent en créer : les
        -- doublons fractionnent silencieusement le Top correspondants.
        (SELECT coalesce(sum(n - 1), 0)::int FROM (
            SELECT count(*)::int AS n FROM external_entity
            WHERE is_active = true
            GROUP BY lower(replace(label, ' ', ''))
            HAVING count(*) > 1) d) AS g8,

        (SELECT count(*)::int FROM mail m
          WHERE ${socle} AND ${visible}
            AND m.mail_type = ${MailType.Arrivee} AND m.organigramme_id IS NULL) AS g9
    `);

    const n = (v: number | undefined): number => v ?? 0;
    const indicateurs: HygieneIndicateur[] = [
      {
        cle: 'g1',
        label: 'Courriers en cours sans échéance',
        consequence:
          "Jamais « en retard » : aucune relance ne les signalera, seule l'ancienneté les rattrape.",
        count: n(r?.g1),
        lien: '/courriers/suivi',
      },
      {
        cle: 'g2',
        label: 'Imputations ouvertes sans échéance',
        consequence:
          'Le worker ne relance que sur une date butoir : celles-ci sont muettes par construction.',
        count: n(r?.g2),
        lien: '/courriers/parapheur',
      },
      {
        cle: 'g3',
        label: 'Scans en attente depuis plus de 30 jours',
        consequence:
          "Backlog de numérisation oublié : ces documents n'existent dans aucun courrier.",
        count: n(r?.g3),
        lien: '/courriers/documents-scannes',
      },
      {
        cle: 'g4',
        label: 'Objets de courrier sans durée de suivi',
        consequence: 'Rend le respect des délais (SLA) incalculable pour les courriers concernés.',
        count: n(r?.g4),
        lien: this.lienUtilisable('/admin/courriers/objets'),
      },
      {
        cle: 'g5',
        label: 'Courriers pointant un référentiel désactivé',
        consequence:
          'Des libellés apparaissent dans les répartitions sans pouvoir être administrés.',
        count: n(r?.g5),
        lien: null,
      },
      {
        cle: 'g6',
        label: 'Courriers supprimés',
        consequence: "Exclus de tous les indicateurs — contrôle d'usage de la suppression logique.",
        count: n(r?.g6),
        lien: null,
      },
      {
        cle: 'g7',
        label: 'Notifications non lues',
        consequence:
          'Un volume élevé suggère que les alertes ne parviennent plus à leurs destinataires.',
        count: n(r?.g7),
        lien: null,
      },
      {
        cle: 'g8',
        label: 'Correspondants en doublon probable',
        consequence: 'Fractionnent le Top correspondants : un même organisme y compte deux fois.',
        count: n(r?.g8),
        lien: this.lienUtilisable('/admin/courriers/entites-externes'),
      },
      {
        cle: 'g9',
        label: 'Arrivées sans rattachement organisationnel',
        consequence:
          "Invisibles de toute analyse par service (le rôle destinataire n'a pas d'organigramme).",
        count: n(r?.g9),
        lien: this.lienUtilisable('/admin/courriers/role-organigramme'),
      },
    ];

    return { scope, indicateurs };
  }
}
