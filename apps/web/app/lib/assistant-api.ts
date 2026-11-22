// Client d'API de l'assistant (lot 3). Le contrat vit dans @archivage/types et docs/assistant-api.md.
// Client local : lib/api.ts ne conserve ni le code HTTP, ni l'errorCode, ni Retry-After.
// Aucun corps de réponse n'est journalisé ; les messages affichables sont construits ici.
import {
  ASST_ROUTES,
  AsstErrorCode,
  isAsstErrorCode,
  type AsstConfirmProposalBody,
  type AsstConfirmProposalResponse,
  type AsstConversationDetailResponse,
  type AsstCreateConversationBody,
  type AsstCreateConversationResponse,
  type AsstGetProposalResponse,
  type AsstListConversationsResponse,
  type AsstPostMessageBody,
  type AsstPostMessageResponse,
  type AsstProposalDto,
  type AsstRefuseProposalBody,
  type AsstRefuseProposalResponse,
  type AsstRouteKey,
} from '@archivage/types';
import { API_BASE } from './api';

export type {
  AsstConfirmProposalResponse,
  AsstConversationDetailResponse,
  AsstCreateConversationBody,
  AsstCreateConversationResponse,
  AsstGetProposalResponse,
  AsstListConversationsResponse,
  AsstPostMessageBody,
  AsstPostMessageResponse,
  AsstProposalDto,
  AsstRefuseProposalResponse,
};
export { AsstErrorCode };

/** Erreur typée de l'assistant : `errorCode` null si absent ou inconnu (guard NestJS, 500, limiteur). */
export class AssistantApiError extends Error {
  readonly status: number;
  readonly errorCode: AsstErrorCode | null;
  readonly retryAfterSeconds: number | null;
  readonly proposal: AsstProposalDto | null;
  readonly details: unknown;
  readonly serverMessage: string | null;
  readonly kind: 'network' | 'http';

  constructor(init: {
    status: number;
    errorCode?: AsstErrorCode | null;
    retryAfterSeconds?: number | null;
    proposal?: AsstProposalDto | null;
    details?: unknown;
    serverMessage?: string | null;
    kind?: 'network' | 'http';
  }) {
    super(init.errorCode ?? `http_${init.status}`);
    this.name = 'AssistantApiError';
    this.status = init.status;
    this.errorCode = init.errorCode ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.proposal = init.proposal ?? null;
    this.details = init.details;
    this.serverMessage = init.serverMessage ?? null;
    this.kind = init.kind ?? 'http';
  }
}

/** Erreur locale de validation (aucun appel réseau). */
function invalidInput(): AssistantApiError {
  return new AssistantApiError({ status: 0, errorCode: AsstErrorCode.InvalidInput });
}

function dans(seconds: number | null): string {
  return seconds ? `dans ${seconds} s` : 'dans quelques instants';
}

/** Message français affichable, sans détail technique brut. */
export function assistantErrorMessage(err: AssistantApiError): string {
  // Le message serveur n'est repris que pour les codes dont le contrat le permet (français, sans courrier).
  const extra = err.serverMessage && err.serverMessage.trim() ? ` ${err.serverMessage.trim()}` : '';
  switch (err.errorCode) {
    case AsstErrorCode.NotImplemented:
      return 'Fonction indisponible pour l’instant.';
    case AsstErrorCode.NotFound:
      return 'Élément introuvable. Il a peut-être été supprimé.';
    case AsstErrorCode.IdentityRefused:
      return `Accès refusé pour ce compte. Reconnectez-vous ou contactez un administrateur.${extra}`;
    case AsstErrorCode.ProposalExpired:
      return 'Cette proposition a expiré. Reformulez votre demande.';
    case AsstErrorCode.ProposalNotPending:
      return 'Cette proposition n’est plus en attente.';
    case AsstErrorCode.Conflict:
      return 'La proposition a changé. Relisez-la avant de confirmer.';
    case AsstErrorCode.EffectForbidden:
      return `Vos droits ne permettent pas d’appliquer cette action.${extra}`;
    case AsstErrorCode.EffectFailed:
      return `L’action n’a pas pu être appliquée.${extra}`;
    case AsstErrorCode.BudgetExceeded:
      return err.retryAfterSeconds
        ? `Le plafond d’utilisation de l’assistant est atteint. Réessayez dans ${err.retryAfterSeconds} s.`
        : 'Le plafond d’utilisation de l’assistant est atteint. Réessayez plus tard.';
    case AsstErrorCode.AssistantUnavailable:
      return 'L’assistant est indisponible pour le moment (désactivé ou arrêt d’urgence).';
    case AsstErrorCode.InvalidInput:
      return 'Votre demande n’a pas pu être traitée. Vérifiez la saisie et réessayez.';
    default:
      break;
  }
  if (err.kind === 'network') return 'Impossible de joindre le serveur. Vérifiez votre connexion.';
  switch (err.status) {
    case 401:
      return 'Votre session a expiré. Reconnectez-vous.';
    case 403:
      return 'Vous n’avez pas accès à l’assistant.';
    case 429:
      return `Trop de demandes en peu de temps. Réessayez ${dans(err.retryAfterSeconds)}.`;
    case 503:
      return 'L’assistant est indisponible pour le moment (désactivé ou arrêt d’urgence).';
    case 501:
      return 'Fonction indisponible pour l’instant.';
    default:
      return 'Une erreur est survenue. Réessayez dans un instant.';
  }
}

export function isAssistantUnavailable(err: AssistantApiError): boolean {
  return err.errorCode === AsstErrorCode.AssistantUnavailable || err.status === 503;
}

export function isAssistantNotImplemented(err: AssistantApiError): boolean {
  return err.status === 501 || err.errorCode === AsstErrorCode.NotImplemented;
}

export function isRateLimited(err: AssistantApiError): boolean {
  return err.errorCode === AsstErrorCode.BudgetExceeded || (err.errorCode === null && err.status === 429);
}

// ---------------------------------------------------------------------------
// Plomberie HTTP
// ---------------------------------------------------------------------------

function authHeader(): Record<string, string> {
  try {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/** Retry-After : secondes entières ou date HTTP. */
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

/** Chemin d'une route du catalogue (méthode vérifiée, `:id` encodé). */
function routePath(key: AsstRouteKey, method: 'GET' | 'POST' | 'DELETE', id?: string): string {
  const def = ASST_ROUTES.find((r) => r.key === key);
  if (!def || def.method !== method) throw new Error(`Route assistant inconnue : ${key}`);
  return id === undefined ? def.path : def.path.replace(':id', encodeURIComponent(id));
}

const ID_RE = /^\d{1,18}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function checkId(id: string): void {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw invalidInput();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const qs = opts.query && Object.keys(opts.query).length ? `?${new URLSearchParams(opts.query).toString()}` : '';
  const hasBody = opts.body !== undefined;
  const headers: Record<string, string> = { ...authHeader() };
  if (hasBody) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${qs}`, {
      method,
      signal: opts.signal,
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    // Annulation volontaire : relancée telle quelle.
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw new AssistantApiError({ status: 0, kind: 'network' });
  }

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  if (res.status === 401 && typeof window !== 'undefined') {
    // Session expirée : même comportement que lib/api.ts.
    try {
      window.localStorage.removeItem('token');
    } catch {
      /* stockage indisponible */
    }
    try {
      if (window.location.pathname !== '/login') window.location.href = '/login';
    } catch {
      /* navigation indisponible */
    }
  }

  const raw: unknown = await res.json().catch(() => ({}));
  const body = isRecord(raw) ? raw : {};
  throw new AssistantApiError({
    status: res.status,
    errorCode: isAsstErrorCode(body.errorCode) ? body.errorCode : null,
    retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')),
    proposal: isRecord(body.proposal) ? (body.proposal as AsstProposalDto) : null,
    details: body.details,
    serverMessage: typeof body.message === 'string' ? body.message : null,
  });
}

// ---------------------------------------------------------------------------
// Les 8 appels
// ---------------------------------------------------------------------------

export async function createConversation(
  body: AsstCreateConversationBody = {},
  signal?: AbortSignal,
): Promise<AsstCreateConversationResponse> {
  return request('POST', routePath('createConversation', 'POST'), { body, signal });
}

export async function listConversations(
  query: { limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<AsstListConversationsResponse> {
  const q: Record<string, string> = {};
  if (query.limit !== undefined) q.limit = String(query.limit);
  if (query.offset !== undefined) q.offset = String(query.offset);
  return request('GET', routePath('listConversations', 'GET'), { query: q, signal });
}

export async function getConversation(id: string, signal?: AbortSignal): Promise<AsstConversationDetailResponse> {
  checkId(id);
  return request('GET', routePath('getConversation', 'GET', id), { signal });
}

export async function postMessage(
  conversationId: string,
  body: AsstPostMessageBody,
  signal?: AbortSignal,
): Promise<AsstPostMessageResponse> {
  checkId(conversationId);
  return request('POST', routePath('postMessage', 'POST', conversationId), { body, signal });
}

/** Le hash est envoyé tel quel (aucune normalisation) ; un format invalide est refusé localement. */
export async function confirmProposal(
  proposalId: string,
  argsHash: string,
  signal?: AbortSignal,
): Promise<AsstConfirmProposalResponse> {
  checkId(proposalId);
  if (typeof argsHash !== 'string' || !HASH_RE.test(argsHash)) throw invalidInput();
  const body: AsstConfirmProposalBody = { argsHash };
  return request('POST', routePath('confirmProposal', 'POST', proposalId), { body, signal });
}

/** `reason` : trim, omis si vide, tronqué à 500 caractères. */
export async function refuseProposal(
  proposalId: string,
  reason?: string,
  signal?: AbortSignal,
): Promise<AsstRefuseProposalResponse> {
  checkId(proposalId);
  const trimmed = (reason ?? '').trim().slice(0, 500).trim();
  const body: AsstRefuseProposalBody = trimmed ? { reason: trimmed } : {};
  return request('POST', routePath('refuseProposal', 'POST', proposalId), { body, signal });
}

export async function getProposal(proposalId: string, signal?: AbortSignal): Promise<AsstGetProposalResponse> {
  checkId(proposalId);
  return request('GET', routePath('getProposal', 'GET', proposalId), { signal });
}

export async function deleteConversation(id: string, signal?: AbortSignal): Promise<void> {
  checkId(id);
  return request<void>('DELETE', routePath('deleteConversation', 'DELETE', id), { signal });
}

export const assistantApi = {
  createConversation,
  listConversations,
  getConversation,
  postMessage,
  confirmProposal,
  refuseProposal,
  getProposal,
  deleteConversation,
};
