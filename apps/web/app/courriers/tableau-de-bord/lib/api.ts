import { apiJson } from '../../../lib/api';

// Contrat consommé depuis l'API NestJS (module courriers / DashboardService).
// Garder synchronisé avec apps/api/src/modules/courriers/dashboard.dto.ts.

export type MailScope = 'all' | 'imputed' | 'none';
export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type Basis = 'date_enregistrement_courrier' | 'mail_date' | 'created_at';

/**
 * Filtre commun. ⚠️ Le schéma Zod côté API est `.strict()` : tout champ inconnu provoque un 400.
 * Le périmètre n'y figure volontairement pas — il est résolu côté serveur.
 */
export interface DashboardFilter {
  dateFrom?: string;
  dateTo?: string;
  mailType?: 0 | 1 | 2;
  organigrammeId?: number;
  externalEntityId?: number;
  granularity?: Granularity;
  basis?: Basis;
}

/** Le filtre de répartition ajoute la dimension ; le schéma serveur est `.strict()`. */
export interface RepartitionFilter extends DashboardFilter {
  dimension: RepartitionDimension;
}

export interface FileCompteur {
  count: number;
  oldestDays: number | null;
}

export interface AlertesResponse {
  scope: MailScope;
  courriersEnRetard: number;
  imputationsEnRetard: number;
  sansImputation: number;
}

export interface FilesResponse {
  scope: MailScope;
  aControler: FileCompteur;
  parapheur: FileCompteur;
  validationDirection: FileCompteur;
  validationDg: FileCompteur;
  decharge: FileCompteur;
  scans: FileCompteur;
  enCours: FileCompteur;
}

export interface Variation {
  valeur: number;
  precedent: number | null;
  /** Ratio signé (0.25 = +25 %). `null` = variation sans signification (précédent à 0). */
  ratio: number | null;
  sens: 'hausse' | 'baisse' | 'stable' | 'indetermine';
}

export interface SyntheseParType {
  mailType: number;
  enregistres: number;
  traites: number;
  enCours: number;
}

export interface SyntheseResponse {
  scope: MailScope;
  periode: { from: string; to: string };
  enregistres: Variation;
  traites: Variation;
  enCours: number;
  delaiMedianJours: number | null;
  delaiP90Jours: number | null;
  parType: SyntheseParType[];
}

export interface FluxPoint {
  bucket: string;
  entrees: number;
  sorties: number;
  backlogNet: number;
}

export interface FluxResponse {
  scope: MailScope;
  granularity: string;
  periode: { from: string; to: string };
  /** Encours antérieur à la fenêtre : amorce de la courbe cumulée. */
  backlogInitial: number;
  points: FluxPoint[];
}

export type RepartitionDimension =
  | 'statut'
  | 'type'
  | 'correspondant'
  | 'type_entite'
  | 'nature'
  | 'objet'
  | 'confidentialite'
  | 'type_depart'
  | 'service';

export interface RepartitionTranche {
  label: string;
  valeur: number;
}

export interface RepartitionResponse {
  scope: MailScope;
  dimension: RepartitionDimension;
  periode: { from: string; to: string };
  total: number;
  tranches: RepartitionTranche[];
}

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
  paliers: RetardsBucket[];
  anciennete: RetardsBucket[];
  top: TopRetard[];
  /** Courriers en cours sans échéance : invisibles des paliers, rattrapés par l'ancienneté seule. */
  sansEcheance: number;
}

export interface DelaiStat {
  medianeJours: number | null;
  p90Jours: number | null;
  n: number;
}

export interface DelaisResponse {
  scope: MailScope;
  periode: { from: string; to: string };
  priseEnCharge: DelaiStat;
  traitementGlobal: DelaiStat;
  sla: {
    configure: boolean;
    dansLesDelais: number;
    horsDelais: number;
    nonEvalues: number;
    objetsSansDuree: number;
    /** `null` quand l'écran de paramétrage est masqué : on affiche la cause sans lien mort. */
    lienConfiguration: string | null;
  };
  imputations: { auto: DelaiStat; manuel: DelaiStat };
}

export interface AgentCharge {
  userGroupId: number;
  label: string;
  ouvertes: number;
  traitees: number;
  enRetard: number;
  /** `null` quand l'effectif est sous `seuilEffectif` : une médiane n'y aurait pas de sens. */
  delaiMedianJours: number | null;
  n: number;
}

export interface ServiceCharge {
  organigrammeId: number | null;
  label: string;
  depth: number;
  ouvertes: number;
}

export interface ChargeResponse {
  scope: MailScope;
  periode: { from: string; to: string };
  agents: AgentCharge[];
  services: ServiceCharge[];
  seuilEffectif: number;
}

export interface HygieneIndicateur {
  cle: string;
  label: string;
  /** Ce que le défaut empêche de voir — l'argument, pas le compteur. */
  consequence: string;
  count: number;
  lien: string | null;
}

export interface HygieneResponse {
  scope: MailScope;
  indicateurs: HygieneIndicateur[];
}

// ---------------------------------------------------------------------------
// Agencement personnalisable — miroir de dashboard-layout.service.ts
// ---------------------------------------------------------------------------

/** Jeu de données requis par un widget : la page ne charge que ceux réellement placés. */
export type WidgetDataKey =
  | 'alertes'
  | 'files'
  | 'synthese'
  | 'flux'
  | 'repartition'
  | 'retards'
  | 'delais'
  | 'charge'
  | 'hygiene';

/** Position d'un widget dans la grille — la seule chose qui soit persistée, avec son id. */
export interface WidgetPlacement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Widget placé, enrichi des métadonnées du CATALOGUE (jamais du JSON stocké). */
export interface WidgetResolu extends WidgetPlacement {
  titre: string;
  description: string;
  dataKey: WidgetDataKey;
  minW: number;
  minH: number;
}

export interface WidgetDefinition {
  id: string;
  titre: string;
  description: string;
  dataKey: WidgetDataKey;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export interface AgencementResponse {
  scope: MailScope;
  colonnes: number;
  widgets: WidgetResolu[];
  /** Catalogue autorisé pour cet utilisateur — alimente la modale d'ajout. */
  disponibles: WidgetDefinition[];
  parDefaut: boolean;
  dataKeys: WidgetDataKey[];
}

export const fetchAgencement = (): Promise<AgencementResponse> =>
  apiJson<AgencementResponse>('/courriers/dashboard/layout');

export const saveAgencement = (widgets: WidgetPlacement[]): Promise<AgencementResponse> =>
  apiJson<AgencementResponse>('/courriers/dashboard/layout', {
    method: 'PUT',
    body: JSON.stringify({ widgets }),
  });

/** Supprime la personnalisation : l'utilisateur repart de l'agencement livré. */
export const resetAgencement = (): Promise<AgencementResponse> =>
  apiJson<AgencementResponse>('/courriers/dashboard/layout', { method: 'DELETE' });

function post<T>(chemin: string, filtre: DashboardFilter | RepartitionFilter): Promise<T> {
  return apiJson<T>(`/courriers/dashboard/${chemin}`, {
    method: 'POST',
    body: JSON.stringify(filtre),
  });
}

/**
 * Alertes et files mesurent un **stock**, pas un flux : les bornes de période leur sont
 * délibérément inapplicables côté serveur. Un courrier en retard depuis trois mois doit rester
 * visible sous un filtre « 30 derniers jours » — c'est justement celui qu'il faut voir. Seules les
 * dimensions (type, service, correspondant) les filtrent.
 */
export const fetchAlertes = (f: DashboardFilter): Promise<AlertesResponse> => post('alertes', f);
export const fetchFiles = (f: DashboardFilter): Promise<FilesResponse> => post('files', f);
export const fetchSynthese = (f: DashboardFilter): Promise<SyntheseResponse> => post('synthese', f);
export const fetchFlux = (f: DashboardFilter): Promise<FluxResponse> => post('flux', f);
export const fetchRepartition = (f: RepartitionFilter): Promise<RepartitionResponse> =>
  post('repartition', f);
/** Comme les alertes, les retards sont un STOCK : les bornes de période ne s'y appliquent pas. */
export const fetchRetards = (f: DashboardFilter): Promise<RetardsResponse> => post('retards', f);
export const fetchDelais = (f: DashboardFilter): Promise<DelaisResponse> => post('delais', f);
export const fetchHygiene = (f: DashboardFilter): Promise<HygieneResponse> => post('hygiene', f);
/** ⚠️ Renvoie 403 hors périmètre global — l'appelant doit gérer le rejet, pas seulement masquer. */
export const fetchCharge = (f: DashboardFilter): Promise<ChargeResponse> => post('charge', f);

export const MAIL_TYPE_LABELS: Record<number, string> = {
  0: 'Arrivée',
  1: 'Départ',
  2: 'Interne',
};
