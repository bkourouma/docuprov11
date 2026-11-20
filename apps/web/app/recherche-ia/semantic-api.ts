// Client d'API de la recherche IA (lot 3). Le contrat vit dans @archivage/types.
// Client local : lib/api.ts ne conserve ni le code HTTP ni l'en-tête Retry-After, or la page
// doit distinguer 403 / 429 / 503 sans jamais afficher de détail technique brut.
import type {
  GedAskResponse,
  GedSemanticSearchResponse,
} from '@archivage/types';
import { API_BASE } from '../lib/api';

export type { GedAskResponse, GedSemanticSearchResponse };

export type SemanticErrorKind = 'forbidden' | 'rate_limited' | 'unavailable' | 'invalid' | 'generic';

/** Erreur typée : le message affichable est construit par la page, jamais repris de l'API. */
export class SemanticApiError extends Error {
  constructor(
    readonly kind: SemanticErrorKind,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(kind);
    this.name = 'SemanticApiError';
  }
}

function authHeader(): Record<string, string> {
  try {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const s = Math.ceil((date - Date.now()) / 1000);
    return s > 0 ? s : null;
  }
  return null;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new SemanticApiError('generic');
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
  if (res.status === 403) throw new SemanticApiError('forbidden');
  if (res.status === 429) throw new SemanticApiError('rate_limited', parseRetryAfter(res.headers.get('Retry-After')));
  if (res.status === 503) throw new SemanticApiError('unavailable');
  if (res.status === 400) throw new SemanticApiError('invalid');
  throw new SemanticApiError('generic');
}

export const semanticApi = {
  search: (query: string, signal?: AbortSignal) =>
    post<GedSemanticSearchResponse>('/semantic-search', { query }, signal),
  ask: (question: string, signal?: AbortSignal) =>
    post<GedAskResponse>('/semantic-search/ask', { question }, signal),
};

/** Message d'erreur affichable, sans détail technique. */
export function errorMessage(e: SemanticApiError): string {
  switch (e.kind) {
    case 'forbidden':
      return 'Vous n’avez pas accès à la recherche IA.';
    case 'rate_limited':
      return e.retryAfterSeconds
        ? `Trop de demandes en peu de temps. Réessayez dans ${e.retryAfterSeconds} s.`
        : 'Trop de demandes en peu de temps. Réessayez dans quelques instants.';
    case 'unavailable':
      return 'Le service d’IA est momentanément indisponible.';
    case 'invalid':
      return 'Votre question n’a pas pu être traitée. Reformulez-la et réessayez.';
    default:
      return 'Une erreur est survenue. Réessayez dans un instant.';
  }
}
