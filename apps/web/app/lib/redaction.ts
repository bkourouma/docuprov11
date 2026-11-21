// Client de la rédaction assistée par l'IA (lot 4c). Les contrats viennent de @archivage/types.
// Le brouillon est une PROPOSITION : rien n'est inséré ni enregistré sans action de l'utilisateur.
import {
  GED_DRAFT_EMPTY_TEMPLATE_ID,
  GED_DRAFT_INSTRUCTION_MAX_CHARS,
  GED_DRAFT_INSTRUCTION_MIN_CHARS,
  GED_DRAFT_OUTPUT_MAX_CHARS,
  type GedCollabCreated,
  type GedDraftCreateDocumentRequest,
  type GedDraftRequest,
  type GedDraftResponse,
  type GedDraftTemplateDetail,
  type GedDraftTemplatesResponse,
} from '@archivage/types';
import { API_BASE } from './api';

export {
  GED_DRAFT_EMPTY_TEMPLATE_ID,
  GED_DRAFT_INSTRUCTION_MAX_CHARS,
  GED_DRAFT_INSTRUCTION_MIN_CHARS,
  GED_DRAFT_OUTPUT_MAX_CHARS,
};
export type {
  GedDraftCreateDocumentRequest,
  GedDraftRequest,
  GedDraftResponse,
  GedDraftTemplateDetail,
  GedDraftTemplatesResponse,
};

/** Erreur d'API portant le statut HTTP (0 = réseau) et le délai `Retry-After` éventuel. */
export class RedactionApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'RedactionApiError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
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

/** Valeur de l'en-tête Retry-After (secondes entières) ; null si absente ou invalide. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.ceil(n) : null;
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
    throw new RedactionApiError('Le serveur est injoignable. Vérifiez votre connexion.', 0);
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.localStorage.removeItem('token');
      if (window.location.pathname !== '/login') window.location.href = '/login';
    }
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    const msg = Array.isArray(body.message)
      ? body.message.join(' ')
      : typeof body.message === 'string'
        ? body.message
        : `HTTP ${res.status}`;
    throw new RedactionApiError(msg, res.status, parseRetryAfter(res.headers.get('Retry-After')));
  }
  return res;
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const redactionApi = {
  listTemplates: async () => (await request('/drafting/templates')).json() as Promise<GedDraftTemplatesResponse>,
  getTemplate: async (id: string) =>
    (await request(`/drafting/templates/${encodeURIComponent(id)}`)).json() as Promise<GedDraftTemplateDetail>,
  draft: async (body: GedDraftRequest) =>
    (await request('/drafting/draft', postJson(body))).json() as Promise<GedDraftResponse>,
  createDocument: async (body: GedDraftCreateDocumentRequest) =>
    (await request('/drafting/documents', postJson(body))).json() as Promise<GedCollabCreated>,
};

/** Message français adapté à l'erreur ; ne reprend le message serveur que pour un 400 (utile à l'humain). */
export function describeDraftError(status: number, message: string): string {
  if (status === 0) return 'Le serveur est injoignable. Vérifiez votre connexion : votre consigne est conservée.';
  if (status === 429) return 'Trop de demandes, patientez quelques secondes.';
  if (status === 404) return 'Ce modèle ou ce document n’est plus accessible.';
  if (status === 409) return 'Opération impossible en l’état : le document a changé. Rechargez la page puis réessayez.';
  if (status === 502 || status === 503)
    return 'Le service de rédaction est momentanément indisponible. Réessayez dans un instant.';
  if (status === 400 && message.trim()) return message.trim();
  if (status === 403) return 'Vous n’avez pas le droit d’effectuer cette action.';
  return 'La rédaction a échoué. Réessayez.';
}

/** Un brouillon est insérable s'il n'est pas vide et reste sous la taille maximale du contrat. */
export function canInsertDraft(html: string): boolean {
  return html.trim().length > 0 && html.length <= GED_DRAFT_OUTPUT_MAX_CHARS;
}

/** Plage de sélection à remplacer ; null si la sélection est vide. */
export function selectionRange(selection: { from: number; to: number; empty: boolean }): { from: number; to: number } | null {
  if (selection.empty || selection.from === selection.to) return null;
  return { from: Math.min(selection.from, selection.to), to: Math.max(selection.from, selection.to) };
}

/** Consigne valide (après trim) : bornes du contrat. */
export function isInstructionValid(instruction: string): boolean {
  const n = instruction.trim().length;
  return n >= GED_DRAFT_INSTRUCTION_MIN_CHARS && n <= GED_DRAFT_INSTRUCTION_MAX_CHARS;
}

/** Corps de POST /drafting/draft. */
export function buildDraftRequest(input: {
  templateId: string;
  instruction: string;
  useContext: boolean;
  documentId: number;
}): GedDraftRequest {
  return {
    templateId: input.templateId,
    instruction: input.instruction.trim(),
    ...(input.useContext ? { contextDocumentIds: [input.documentId] } : {}),
  };
}

/** Modèles dont le squelette est proposable quand l'IA est désactivée (le modèle vide n'a pas de contenu). */
export function skeletonTemplates<T extends { id: string }>(templates: T[]): T[] {
  return templates.filter((t) => t.id !== GED_DRAFT_EMPTY_TEMPLATE_ID);
}

/** Modèle proposé par défaut dans le panneau : le premier modèle non vide, sinon le premier. */
export function defaultDraftTemplateId(templates: { id: string }[]): string | undefined {
  return (templates.find((t) => t.id !== GED_DRAFT_EMPTY_TEMPLATE_ID) ?? templates[0])?.id;
}

/** Vrai pour le modèle vide (ou absent). */
export function isEmptyTemplate(id: string | undefined): boolean {
  return !id || id === GED_DRAFT_EMPTY_TEMPLATE_ID;
}

/**
 * Verrou d'insertion d'une proposition (référence mutable, vérifiée ET posée de façon synchrone :
 * un double clic, qui déclenche deux gestionnaires avant tout nouveau rendu, n'insère qu'une fois).
 */
export interface InsertLock {
  current: boolean;
}

/** Pose le verrou ; renvoie `false` (rien à faire) s'il l'est déjà. */
export function acquireInsertLock(lock: InsertLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

/** Après une tentative : un échec relève le verrou (nouvel essai possible), un succès le garde. */
export function settleInsertLock(lock: InsertLock, inserted: boolean): void {
  if (!inserted) lock.current = false;
}

/** Nouvelle proposition, régénération ou rejet : l'insertion redevient possible. */
export function resetInsertLock(lock: InsertLock): void {
  lock.current = false;
}
