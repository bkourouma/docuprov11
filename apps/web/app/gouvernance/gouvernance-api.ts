// Client d'API de la gouvernance (lot 5). Le contrat vit dans @archivage/types.
// Client local (calque de recherche-ia/semantic-api.ts) : lib/api.ts ne conserve pas le code HTTP,
// or la page doit distinguer 403 / 404 / 409 (dont l'abaissement à confirmer) sans jamais afficher
// de détail technique brut. Les messages affichables sont construits côté page.
import type {
  GovernanceAnalyzeRequest,
  GovernanceAnalyzeResponse,
  GovernanceDashboard,
  GovernanceKind,
  GovernanceProposalDetail,
  GovernanceProposalPage,
  GovernanceReviewResponse,
} from '@archivage/types';
import { API_BASE } from '../lib/api';

export type GovernanceErrorKind =
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'lowering_required'
  | 'invalid'
  | 'unavailable'
  | 'generic';

/** Erreur typée : le message affichable est construit par la page, jamais repris de l'API. */
export class GovernanceApiError extends Error {
  constructor(readonly kind: GovernanceErrorKind) {
    super(kind);
    this.name = 'GovernanceApiError';
  }
}

/** Filtres de la liste (statut numérique : 0 proposée, 1 validée, 2 rejetée). */
export interface ProposalFilters {
  kind?: GovernanceKind;
  status?: number;
  groupKey?: string;
  minConfidence?: number;
  page: number;
  pageSize: number;
}

const LOWERING_PREFIX = 'LOWERING_CONFIRMATION_REQUIRED';

function authHeader(): Record<string, string> {
  try {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/** Lit le message d'une réponse d'erreur, uniquement pour reconnaître l'abaissement à confirmer. */
async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.join(' ');
  } catch {
    /* corps absent ou illisible */
  }
  return '';
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new GovernanceApiError('generic');
  }
  if (res.ok) return (await res.json()) as T;
  if (res.status === 401 && typeof window !== 'undefined') {
    // Session expirée : même comportement que lib/api.ts.
    try {
      window.localStorage.removeItem('token');
    } catch {
      /* stockage indisponible */
    }
    if (window.location.pathname !== '/login') window.location.href = '/login';
  }
  if (res.status === 403) throw new GovernanceApiError('forbidden');
  if (res.status === 404) throw new GovernanceApiError('not_found');
  if (res.status === 409) {
    const message = await readMessage(res);
    throw new GovernanceApiError(message.startsWith(LOWERING_PREFIX) ? 'lowering_required' : 'conflict');
  }
  if (res.status === 400) throw new GovernanceApiError('invalid');
  if (res.status === 503) throw new GovernanceApiError('unavailable');
  throw new GovernanceApiError('generic');
}

function listQuery(f: ProposalFilters): string {
  const p = new URLSearchParams();
  if (f.kind) p.set('kind', f.kind);
  if (f.status !== undefined) p.set('status', String(f.status));
  if (f.groupKey) p.set('groupKey', f.groupKey);
  if (f.minConfidence !== undefined) p.set('minConfidence', String(f.minConfidence));
  p.set('page', String(f.page));
  p.set('pageSize', String(f.pageSize));
  return p.toString();
}

export const governanceApi = {
  dashboard: (signal?: AbortSignal) =>
    request<GovernanceDashboard>('GET', '/governance/dashboard', undefined, signal),
  list: (filters: ProposalFilters, signal?: AbortSignal) =>
    request<GovernanceProposalPage>('GET', `/governance/proposals?${listQuery(filters)}`, undefined, signal),
  detail: (id: string, signal?: AbortSignal) =>
    request<GovernanceProposalDetail>(
      'GET',
      `/governance/proposals/${encodeURIComponent(id)}`,
      undefined,
      signal,
    ),
  /** `confirmLowering: true` uniquement après confirmation explicite de l'utilisateur. */
  validate: (id: string, confirmLowering = false) =>
    request<GovernanceReviewResponse>(
      'POST',
      `/governance/proposals/${encodeURIComponent(id)}/validate`,
      confirmLowering ? { confirmLowering: true } : {},
    ),
  reject: (id: string) =>
    request<GovernanceReviewResponse>('POST', `/governance/proposals/${encodeURIComponent(id)}/reject`, {}),
  analyze: (body: GovernanceAnalyzeRequest) =>
    request<GovernanceAnalyzeResponse>('POST', '/governance/analyze', body),
};

/** Message d'erreur affichable, sans détail technique. */
export function errorMessage(e: GovernanceApiError, context: 'load' | 'review' | 'analyze' = 'load'): string {
  switch (e.kind) {
    case 'forbidden':
      // Refus de revue (niveau d'accès insuffisant sur le document) ≠ pas d'accès au menu.
      if (context === 'review') return 'Votre niveau d’accès ne vous permet pas de relire cette proposition.';
      return 'Vous n’avez pas accès à la gouvernance.';
    case 'not_found':
      // Analyse : le 404 porte sur le DOCUMENT saisi (« Document introuvable. »), pas sur une proposition.
      if (context === 'analyze') {
        return 'Ce document est introuvable, n’est pas archivé ou ne vous est pas accessible.';
      }
      return 'Cette proposition n’existe plus ou n’est plus accessible.';
    case 'conflict':
      return 'Cette proposition a déjà été traitée ou n’est plus à jour. La liste a été actualisée.';
    case 'lowering_required':
      return 'Cette décision abaisse la confidentialité : une confirmation explicite est nécessaire.';
    case 'invalid':
      return context === 'analyze'
        ? 'Les numéros de documents ne sont pas valides. Vérifiez la saisie et réessayez.'
        : 'La demande n’a pas pu être traitée. Réessayez.';
    case 'unavailable':
      return 'Le service est momentanément indisponible. Réessayez dans un instant.';
    default:
      return context === 'review'
        ? 'La décision n’a pas pu être enregistrée. Réessayez dans un instant.'
        : 'Une erreur est survenue. Réessayez dans un instant.';
  }
}
