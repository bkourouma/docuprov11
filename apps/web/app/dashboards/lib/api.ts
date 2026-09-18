import { API_BASE, apiJson } from '../../lib/api';

// Contrat consommé depuis l'API NestJS (module analytics). Garder synchronisé
// avec apps/api/src/modules/analytics/analytics.service.ts.

export interface KpiBlock {
  totalDocuments: number;
  documentsArchived: number;
  documentsPending: number;
  documentsFrozen: number;
  documentTypes: number;
  dossiers: number;
  totalPages: number;
  totalBytes: number;
  periodDocuments: number;
  previousPeriodDocuments: number;
  indexationRate: number;
  anomalies: { sansType: number; sansDossier: number; sansDate: number; sansCote: number };
}

export interface TimelinePoint {
  bucket: string;
  count: number;
  cumulative: number;
}

export interface DistributionSlice {
  name: string;
  value: number;
}

export interface ObjectiveBlock {
  hasTarget: boolean;
  metric: 'documents' | 'pages';
  target: number;
  realized: number;
  pct: number;
  dayOfMonth: number;
  daysInMonth: number;
  projectedEndOfMonth: number;
  requiredDailyRate: number;
}

export interface PipelineBlock {
  total: number;
  termines: number;
  echecs: number;
  ouverts: number;
  failureRate: number;
}

export interface AnalyticsOverview {
  period: { from: string; to: string; previousFrom: string; previousTo: string };
  basis: 'created_at' | 'document_date' | 'validated_at';
  granularity: 'day' | 'week' | 'month' | 'quarter' | 'year';
  kpis: KpiBlock;
  timeline: TimelinePoint[];
  objective: ObjectiveBlock;
  byType: DistributionSlice[];
  byDossier: DistributionSlice[];
  byPlan: DistributionSlice[];
  pipeline: PipelineBlock;
}

export type Granularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type Basis = 'created_at' | 'document_date' | 'validated_at';

export interface AnalyticsFilter {
  dateFrom?: string;
  dateTo?: string;
  dossierId?: number;
  documentTypeId?: number;
  locationId?: number;
  granularity: Granularity;
  basis: Basis;
}

/** Une cible « objectif vs réalisé » (GET liste via POST /analytics/targets). */
export interface TargetRow {
  targetId: number;
  scope: 'global' | 'programme' | 'type';
  scopeRefId: number | null;
  scopeLabel: string;
  metric: 'documents' | 'pages';
  periodKind: 'month' | 'quarter' | 'year';
  periodStart: string;
  targetValue: number;
  realized: number;
  progressPct: number;
}

export interface TargetsQuery {
  periodKind: 'month' | 'quarter' | 'year';
  periodStart?: string;
  scope?: 'global' | 'programme' | 'type';
}

// ---------------------------------------------------------------------------
// Agencement personnalisable — miroir de analytics/dashboard-layout.service.ts
// ---------------------------------------------------------------------------

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
  minW: number;
  minH: number;
}

export interface WidgetDefinition {
  id: string;
  titre: string;
  description: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export interface AgencementResponse {
  colonnes: number;
  widgets: WidgetResolu[];
  /** Catalogue autorisé pour cet utilisateur — alimente la modale d'ajout. */
  disponibles: WidgetDefinition[];
  parDefaut: boolean;
}

export const fetchAgencement = (): Promise<AgencementResponse> =>
  apiJson<AgencementResponse>('/analytics/layout');

export const saveAgencement = (widgets: WidgetPlacement[]): Promise<AgencementResponse> =>
  apiJson<AgencementResponse>('/analytics/layout', {
    method: 'PUT',
    body: JSON.stringify({ widgets }),
  });

/** Supprime la personnalisation : l'utilisateur repart de l'agencement livré. */
export const resetAgencement = (): Promise<AgencementResponse> =>
  apiJson<AgencementResponse>('/analytics/layout', { method: 'DELETE' });

export function fetchOverview(filter: AnalyticsFilter): Promise<AnalyticsOverview> {
  return apiJson<AnalyticsOverview>('/analytics/overview', {
    method: 'POST',
    body: JSON.stringify(filter),
  });
}

/** Cibles « objectif vs réalisé » d'une période (toutes, ou filtrées par scope). */
export function fetchTargets(query: TargetsQuery): Promise<TargetRow[]> {
  return apiJson<TargetRow[]>('/analytics/targets', {
    method: 'POST',
    body: JSON.stringify(query),
  });
}

/**
 * Export de la synthèse (endpoint POST → on poste le corps puis on déclenche un
 * « Enregistrer sous ». Renvoie false en cas d'échec pour afficher un toast.
 */
export async function downloadOverviewExport(
  filter: AnalyticsFilter,
  format: 'xlsx' | 'csv' | 'pdf' | 'docx',
): Promise<boolean> {
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  const res = await fetch(`${API_BASE}/analytics/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ...filter, format }),
  });
  if (!res.ok) return false;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `tableau-de-bord.${format}`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
