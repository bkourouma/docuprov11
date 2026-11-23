// Client de l'éditeur natif collaboratif (lot 4b). Les contrats (DTO, chemin WebSocket, extension
// de la pièce d'état) viennent de @archivage/types : le web ne redéclare rien.
import {
  GED_COLLAB_STATE_EXTENSION,
  type GedCollabCreated,
  type GedCollabImportResult,
  type GedCollabMentionCandidate,
  type GedCollabSaveVersionResult,
  type GedCollabSession,
  type GedDocumentVersionRow,
} from '@archivage/types';
import { API_BASE } from './api';
import { colors } from '../theme/tokens';

export { GED_COLLAB_STATE_EXTENSION };
export type {
  GedCollabCreated,
  GedCollabImportResult,
  GedCollabMentionCandidate,
  GedCollabSaveVersionResult,
  GedCollabSession,
};

/** Erreur d'API portant le statut HTTP : l'éditeur distingue 404 (inaccessible) d'une panne réseau. */
export class EditeurApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'EditeurApiError';
    this.status = status;
  }
}

function readToken(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
  } catch {
    return null;
  }
}

function authHeader(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Session expirée : même comportement que `lib/api.ts` (jeton effacé, retour à la connexion). */
function handleUnauthorized(status: number): void {
  if (status === 401 && typeof window !== 'undefined') {
    window.localStorage.removeItem('token');
    if (window.location.pathname !== '/login') window.location.href = '/login';
  }
}

async function toError(res: Response): Promise<EditeurApiError> {
  handleUnauthorized(res.status);
  const body = (await res.json().catch(() => ({}))) as { message?: unknown };
  const msg = Array.isArray(body.message)
    ? body.message.join(' ')
    : typeof body.message === 'string'
      ? body.message
      : `HTTP ${res.status}`;
  return new EditeurApiError(msg, res.status);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...authHeader(), ...(init.headers ?? {}) },
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new EditeurApiError('Le serveur est injoignable. Vérifiez votre connexion.', 0);
  }
  if (!res.ok) throw await toError(res);
  return res;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const editeurApi = {
  createDocument: async (spaceId: number, label: string) =>
    (await request('/collab/documents', jsonInit('POST', { spaceId, label }))).json() as Promise<GedCollabCreated>,

  importAsNew: async (file: File, spaceId: number, label?: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('spaceId', String(spaceId));
    if (label?.trim()) form.append('label', label.trim());
    return (await request('/collab/documents/import', { method: 'POST', body: form })).json() as Promise<GedCollabCreated>;
  },

  getSession: async (documentId: number) =>
    (await request(`/collab/documents/${documentId}/session`)).json() as Promise<GedCollabSession>,

  saveVersion: async (documentId: number, changeSummary?: string) =>
    (
      await request(
        `/collab/documents/${documentId}/versions`,
        jsonInit('POST', { changeSummary: changeSummary?.trim() || undefined }),
      )
    ).json() as Promise<GedCollabSaveVersionResult>,

  restore: async (documentId: number, versionId: number, changeSummary?: string) =>
    (
      await request(
        `/collab/documents/${documentId}/restore`,
        jsonInit('POST', { versionId, changeSummary: changeSummary?.trim() || undefined }),
      )
    ).json() as Promise<GedDocumentVersionRow>,

  importDocx: async (documentId: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return (
      await request(`/collab/documents/${documentId}/import`, { method: 'POST', body: form })
    ).json() as Promise<GedCollabImportResult>;
  },

  /** Télécharge le DOCX (jeton en en-tête : un simple lien serait refusé en 401). */
  async exportDocx(documentId: number, filename: string): Promise<void> {
    const res = await request(`/collab/documents/${documentId}/export.docx`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sanitizeFilename(filename)}.docx`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  mentionCandidates: async (documentId: number, q: string, signal?: AbortSignal) =>
    (
      await request(
        `/collab/documents/${documentId}/mention-candidates?q=${encodeURIComponent(q)}`,
        { signal },
      )
    ).json() as Promise<GedCollabMentionCandidate[]>,
};

/** Nom de fichier sûr : sans séparateurs ni caractères réservés, jamais vide. */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'document').slice(0, 120);
}

/**
 * Numéro de version à afficher après « Enregistrer une version » : celui de la version créée, sinon
 * (contenu identique, rien créé) le numéro déjà affiché. Sans cela, la barre d'état gardait le
 * numéro lu à l'ouverture de la session.
 */
export function versionNumberAfterSave(
  displayed: number,
  result: { created: boolean; version: { versionNumber: number } | null },
): number {
  return result.created && result.version ? result.version.versionNumber : displayed;
}

/** Numéro de la version courante d'une liste de versions ; `fallback` si aucune n'est courante. */
export function currentVersionNumber(
  rows: ReadonlyArray<{ isCurrent: boolean; versionNumber: number }>,
  fallback: number,
): number {
  return rows.find((r) => r.isCurrent)?.versionNumber ?? fallback;
}

/** Vrai si la version courante porte la pièce d'état Yjs : le document est un texte natif. */
export function isCollabDocument(
  files: ReadonlyArray<{ fileExtension: string }> | null | undefined,
): boolean {
  return !!files?.some((f) => f.fileExtension.toLowerCase() === GED_COLLAB_STATE_EXTENSION);
}

/**
 * URL WebSocket : `NEXT_PUBLIC_COLLAB_WS_URL` si définie, sinon dérivée de l'adresse de la page
 * et du `wsPath` renvoyé par la session (jamais de chemin en dur). Le jeton n'est jamais dans l'URL.
 */
export function deriveWsUrl(
  wsPath: string,
  loc: { protocol: string; host: string },
  envUrl?: string | null,
): string {
  const fromEnv = envUrl?.trim();
  if (fromEnv) return fromEnv;
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  const path = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
  return `${scheme}://${loc.host}${path}`;
}

export type CollabCloseKind =
  | 'unauthorized'
  | 'session-expired'
  | 'structure'
  | 'limit'
  | 'reset'
  | 'other';

/** Codes de fermeture applicatifs du serveur collaboratif. */
export const COLLAB_CLOSE = { UNAUTHORIZED: 4401, LIMIT: 4409, RESET: 4410 } as const;

/**
 * Interprète un code de fermeture. Pour 4401, la raison « session-expired » (JWT expiré, émise par
 * le serveur) est distinguée d'un accès refusé ; comparaison tolérante (casse, variantes).
 */
export function interpretCloseCode(
  code: number | undefined | null,
  reason?: string | null,
): CollabCloseKind {
  switch (code) {
    case COLLAB_CLOSE.UNAUTHORIZED:
      return /expire/i.test(reason ?? '') ? 'session-expired' : 'unauthorized';
    case COLLAB_CLOSE.LIMIT:
      // « structure » : mise à jour refusée (invalide / dépendances manquantes) ; le reste = débit/taille/connexions.
      return /structure/i.test(reason ?? '') ? 'structure' : 'limit';
    case COLLAB_CLOSE.RESET:
      return 'reset';
    default:
      return 'other';
  }
}

/** Délais de reconnexion après un dépassement de limite (croissants, plafonnés à 30 s). */
export const LIMIT_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000, 30000] as const;
export const LIMIT_MAX_ATTEMPTS = LIMIT_RETRY_DELAYS_MS.length;
/** Durée de connexion stable après laquelle le compteur de tentatives repart à zéro. */
export const STABLE_CONNECTION_MS = 30000;

export type CloseAction =
  | 'disconnect-and-reload'
  | 'give-up'
  | 'none'
  | { retryInMs: number; attempt: number };

/**
 * Décision pure après une fermeture. `attempts` = reconnexions déjà tentées depuis la dernière
 * connexion stable. « structure » ne reconnecte JAMAIS automatiquement (le Y.Doc local contient la
 * modification refusée : il serait renvoyé en boucle) ; « limit » reconnecte avec un délai borné.
 */
export function closeAction(kind: CollabCloseKind, attempts: number): CloseAction {
  if (kind === 'structure') return 'disconnect-and-reload';
  if (kind !== 'limit') return 'none';
  const n = Math.max(0, Math.trunc(attempts));
  if (n >= LIMIT_MAX_ATTEMPTS) return 'give-up';
  return { retryInMs: LIMIT_RETRY_DELAYS_MS[n] ?? 30000, attempt: n + 1 };
}

/**
 * Quand recréer un Y.Doc et un provider propres (remontage de l'éditeur via `key`) :
 * « reset » immédiatement, « structure » seulement après l'action « Recharger » de la personne.
 */
export function docRecreation(kind: CollabCloseKind): 'immediate' | 'on-user-action' | 'never' {
  if (kind === 'reset') return 'immediate';
  if (kind === 'structure') return 'on-user-action';
  return 'never';
}

/** Session expirée : même comportement que `handleUnauthorized` (jeton effacé, retour à la connexion). */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem('token');
  } catch {
    /* stockage indisponible */
  }
  if (window.location.pathname !== '/login') window.location.href = '/login';
}

/** Couleurs de présence : uniquement des jetons du design system (sémantiques vives + primaire). */
const PRESENCE_COLORS = [
  colors.primaryHover,
  colors.successVivid,
  colors.infoVivid,
  colors.warningVivid,
  colors.dangerVivid,
  colors.secondaryStrong,
] as const;

/** Couleur stable pour une personne (même id => même couleur chez tous les participants). */
export function presenceColor(userGroupId: number): string {
  const i = Math.abs(Math.trunc(userGroupId)) % PRESENCE_COLORS.length;
  return PRESENCE_COLORS[i] ?? colors.primaryHover;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const a = parts[0]?.[0] ?? '';
  const b = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (a + b).toUpperCase();
}
