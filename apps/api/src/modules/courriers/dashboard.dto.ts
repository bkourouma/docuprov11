import { z } from 'zod';
import type { MailScope } from './domain';
import type { Variation } from './domain';

/**
 * Filtre commun du tableau de bord (§4.1 du plan). Aligné sur `analyticsFilterSchema` du module
 * analytics : même forme, mêmes noms, pour que les deux tableaux de bord se ressemblent.
 *
 * ⚠️ `ZodValidationPipe` exige `input = output` : utiliser `z.coerce.*` et JAMAIS `.transform()`.
 * ⚠️ Le périmètre (`MailScope`) n'est délibérément PAS un champ : il est résolu côté serveur à
 * partir des menus du rôle. L'accepter du client permettrait à un agent de demander la vue globale.
 */
export const dashboardFilterSchema = z
  .object({
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /** 0 Arrivée · 1 Départ · 2 Interne */
    mailType: z.coerce.number().int().min(0).max(2).optional(),
    /** Filtre par service : inclut les descendants (materialized-path). */
    organigrammeId: z.coerce.number().int().positive().optional(),
    externalEntityId: z.coerce.number().int().positive().optional(),
    granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).default('day'),
    basis: z
      .enum(['date_enregistrement_courrier', 'mail_date', 'created_at'])
      .default('date_enregistrement_courrier'),
  })
  .strict();

export type DashboardFilterDto = z.infer<typeof dashboardFilterSchema>;

/**
 * Agencement soumis par l'écran. Volontairement permissif sur les valeurs : le service borne
 * ensuite chaque position au catalogue (taille minimale, nombre de colonnes) plutôt que de rejeter
 * la requête — un arrondi de la grille ne doit pas faire échouer un enregistrement.
 */
export const agencementSchema = z
  .object({
    widgets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(80),
            x: z.coerce.number().int().min(0).max(200),
            y: z.coerce.number().int().min(0).max(2000),
            w: z.coerce.number().int().min(1).max(48),
            h: z.coerce.number().int().min(1).max(200),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type AgencementDto = z.infer<typeof agencementSchema>;

/**
 * Dimensions de répartition. Liste blanche STRICTE : chaque valeur est traduite côté service en un
 * couple (colonne, jointure) via `Prisma.raw`. Aucune chaîne venue du client n'atteint le SQL.
 *
 * `nature`, `objet` et `confidentialite` restent proposées bien que leurs écrans de paramétrage
 * soient masqués (HIDDEN_MENU_KEYS) : les colonnes sont peuplées à la saisie, la dimension est donc
 * valide en lecture.
 */
export const REPARTITION_DIMENSIONS = [
  'statut',
  'type',
  'correspondant',
  'type_entite',
  'nature',
  'objet',
  'confidentialite',
  'type_depart',
  'service',
] as const;
export type RepartitionDimension = (typeof REPARTITION_DIMENSIONS)[number];

export const repartitionFilterSchema = dashboardFilterSchema
  .extend({ dimension: z.enum(REPARTITION_DIMENSIONS) })
  .strict();

export type RepartitionFilterDto = z.infer<typeof repartitionFilterSchema>;

// ---------------------------------------------------------------------------
// Formes de réponse — source de vérité, recopiée à la main côté web (convention du dépôt).
// ---------------------------------------------------------------------------

/** Compteur de file + ancienneté de son plus vieil élément (en jours). */
export interface FileCompteur {
  count: number;
  /** `null` quand la file est vide. Une file courte mais ancienne est plus alarmante qu'une longue et fraîche. */
  oldestDays: number | null;
}

/** Zone 1 — alertes. Hors période : un retard n'appartient pas à une fenêtre temporelle. */
export interface AlertesResponse {
  scope: MailScope;
  /** D1 — échéance dépassée, non traité. */
  courriersEnRetard: number;
  /** D3 — imputation échue et non traitée : le worker a cessé de relancer (§3.6). */
  imputationsEnRetard: number;
  /** E5 — non traité et personne n'est imputé. */
  sansImputation: number;
}

/** Zone 2 — tour de contrôle. Chaque compteur reprend le `where` réel de son écran (§1.2). */
export interface FilesResponse {
  scope: MailScope;
  aControler: FileCompteur; // B1
  parapheur: FileCompteur; // B2
  validationDirection: FileCompteur; // B3
  validationDg: FileCompteur; // B4
  decharge: FileCompteur; // B5
  scans: FileCompteur; // B6
  enCours: FileCompteur; // B7
}

export interface SyntheseParType {
  mailType: number;
  enregistres: number;
  traites: number;
  enCours: number;
}

/** Zone 3 — chiffres clés de la période, avec comparaison à la période précédente. */
export interface SyntheseResponse {
  scope: MailScope;
  periode: { from: string; to: string };
  /** A1 — enregistrés sur la période. */
  enregistres: Variation;
  /** A5 — archivés sur la période (date d'archivage selon le type, §3.7). */
  traites: Variation;
  /** A4 — stock courant, VOLONTAIREMENT hors période. */
  enCours: number;
  /** C3 — délai de traitement, en jours. Médiane et P90 : jamais la moyenne seule. */
  delaiMedianJours: number | null;
  delaiP90Jours: number | null;
  /**
   * Ventilation par type. Arrivées et Départs n'ont pas le même cycle de vie : un Départ porte une
   * date d'archivage dès sa rédaction (§3.1), si bien qu'il peut être compté « archivé » (A5) tout
   * en restant « en cours » (A4). Exposer le détail permet à l'écran de séparer les deux flux sans
   * nouvelle route, en attendant l'arbitrage.
   */
  parType: SyntheseParType[];
}

/** Zone 4 — flux d'entrées/sorties et backlog cumulé. */
export interface FluxPoint {
  /** Début du seau, en ISO (`YYYY-MM-DD`). */
  bucket: string;
  /** A7 — courriers enregistrés dans le seau. */
  entrees: number;
  /** A7 — courriers archivés dans le seau (date d'archivage selon le type, §3.7). */
  sorties: number;
  /** A8 — stock cumulé, amorcé par le backlog antérieur à la fenêtre. */
  backlogNet: number;
}

export interface FluxResponse {
  scope: MailScope;
  granularity: string;
  periode: { from: string; to: string };
  /** Backlog à l'entrée de la fenêtre — sans lui, la courbe cumulée démarrerait faussement à zéro. */
  backlogInitial: number;
  points: FluxPoint[];
}

/** Zone 6a — tranches de retard et d'ancienneté. */
export interface RetardsBucket {
  cle: string;
  label: string;
  count: number;
}

export interface TopRetard {
  mailId: number;
  title: string;
  reference: string | null;
  joursRetard: number;
}

export interface RetardsResponse {
  scope: MailScope;
  /** D4 — paliers d'échéance des courriers non traités. */
  paliers: RetardsBucket[];
  /** D5 — ancienneté du backlog, INDÉPENDANTE de l'échéance. */
  anciennete: RetardsBucket[];
  /** D6 — les plus anciens retards, actionnables. */
  top: TopRetard[];
  /**
   * G1 — courriers en cours SANS échéance. Ils sont absents des paliers par construction : sans
   * date butoir, ils ne sont jamais « en retard », donc rien ne les signale. D5 est leur seul filet.
   */
  sansEcheance: number;
}

/** Zone 6b — statistiques de délai. Médiane + P90, jamais la moyenne seule. */
export interface DelaiStat {
  medianeJours: number | null;
  p90Jours: number | null;
  /** Effectif ayant servi au calcul — un percentile sur 2 dossiers ne veut rien dire. */
  n: number;
}

export interface DelaisResponse {
  scope: MailScope;
  periode: { from: string; to: string };
  /** C1 — de la date du courrier à sa prise en charge au bureau d'ordre. */
  priseEnCharge: DelaiStat;
  /** C3 — de la prise en charge à l'archivage (date selon le type, §3.7). Le KPI phare. */
  traitementGlobal: DelaiStat;
  /**
   * C4 — respect des durées de suivi de l'objet. `configure: false` quand aucune durée exploitable
   * n'existe : l'écran affiche alors « SLA non configuré » plutôt qu'un graphique vide.
   */
  sla: {
    configure: boolean;
    dansLesDelais: number;
    horsDelais: number;
    /** Courriers écartés faute de durée — rend l'angle mort visible plutôt que muet. */
    nonEvalues: number;
    /** G4 — objets de courrier sans aucune durée renseignée : la cause corrigeable. */
    objetsSansDuree: number;
    /**
     * Écran où renseigner les durées — `null` quand il est masqué (`HIDDEN_MENU_KEYS`) et donc
     * inatteignable pour un non-admin. L'écran affiche alors la cause sans lien mort.
     */
    lienConfiguration: string | null;
  };
  /**
   * C5 — délai de traitement des imputations, SÉGRÉGÉ. Les types portant `suivi = true` sont
   * traités automatiquement à la simple lecture du courrier : leur délai frôle zéro sans qu'aucun
   * travail n'ait eu lieu. Les mélanger ferait passer un artefact pour une performance.
   */
  imputations: {
    auto: DelaiStat;
    manuel: DelaiStat;
  };
}

/**
 * Zone 7 — charge de travail (E1, E2, E3, C7).
 *
 * **Restitution nominative, arbitrée par le commanditaire (arbitrage 4).** Deux garde-fous
 * subsistent, qui ne relèvent pas de cet arbitrage :
 *  - la zone n'est servie qu'en périmètre `all` — exposer un classement d'agents à un agent serait
 *    une fuite d'information, pas un choix d'affichage ;
 *  - le délai médian n'est pas rendu sous `SEUIL_EFFECTIF_CHARGE` dossiers : ce n'est pas de la
 *    pudeur, c'est qu'un percentile sur deux dossiers ne mesure rien.
 */
export const SEUIL_EFFECTIF_CHARGE = 5;

export interface AgentCharge {
  userGroupId: number;
  label: string;
  /** E1 — imputations ouvertes : la charge courante. */
  ouvertes: number;
  /** E3 — imputations traitées sur la période : le débit. */
  traitees: number;
  /** Ouvertes dont l'échéance est dépassée. */
  enRetard: number;
  /** C7 — `null` si l'effectif est sous le seuil. */
  delaiMedianJours: number | null;
  /** Effectif ayant servi au délai — rend le seuil vérifiable par le lecteur. */
  n: number;
}

export interface ServiceCharge {
  organigrammeId: number | null;
  label: string;
  /** Profondeur dans l'arbre, pour l'indentation. `0` pour la tranche « Non rattaché ». */
  depth: number;
  /** Inclut les nœuds descendants (rollup materialized-path). */
  ouvertes: number;
}

export interface ChargeResponse {
  scope: MailScope;
  periode: { from: string; to: string };
  agents: AgentCharge[];
  services: ServiceCharge[];
  /** Seuil sous lequel `delaiMedianJours` est masqué. Exposé pour que l'écran puisse l'expliquer. */
  seuilEffectif: number;
}

/**
 * Zone 9 — hygiène des données (G1–G9).
 *
 * Famille souvent négligée, à fort rendement : elle explique **pourquoi** les autres indicateurs
 * sont incomplets et donne le geste correctif. Chaque entrée porte donc un lien d'action.
 */
export interface HygieneIndicateur {
  cle: string;
  label: string;
  /** Ce que le défaut empêche de voir — c'est l'argument, pas le compteur. */
  consequence: string;
  count: number;
  /** Écran où corriger, quand il en existe un. */
  lien: string | null;
}

export interface HygieneResponse {
  scope: MailScope;
  indicateurs: HygieneIndicateur[];
}

/** Zone 5 — répartition. Top N + « Autres » ; la tranche non renseignée est épinglée en dernier. */
export interface RepartitionTranche {
  label: string;
  valeur: number;
}

export interface RepartitionResponse {
  scope: MailScope;
  dimension: RepartitionDimension;
  periode: { from: string; to: string };
  /** Somme de toutes les tranches — permet à l'écran de vérifier qu'il n'a rien perdu. */
  total: number;
  tranches: RepartitionTranche[];
}
