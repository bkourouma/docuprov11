// Docu-Flow — client d'API du workflow (lot W4). Le contrat vit dans @archivage/types (DTO, graphe) et dans
// docs/workflow-moteur.md (routes). Les types propres à l'API (boîte, détail d'instance, réponses de
// transition) sont recopiés ici : apps/api n'est pas importable depuis le web.
//
// Client local (calque de gouvernance-api.ts) : lib/api.ts ne conserve pas le code HTTP, or l'interface doit
// distinguer 403 / 404 / 409 / 422 (dont la liste `issues` d'une publication refusée) et masquer
// les emplacements dont l'API n'existe pas encore (W2 outils d'agent, W3 déclencheurs : 404 => masqués).
import type {
  WfDefinitionDto,
  WfDefinitionVersionDto,
  WfEventLogDto,
  WfGraph,
  WfGraphIssueCode,
  WfInboxItemDto,
  WfInstanceDto,
  WfInstanceStatus,
  WfTaskDto,
  WfToolDto,
  WfTriggerDto,
} from '@archivage/types';
import { API_BASE } from './api';

// ---------------------------------------------------------------------------
// Types propres à l'API
// ---------------------------------------------------------------------------

export type WfDefinitionIssueCode = WfGraphIssueCode | 'ESCALATION_INVALID' | 'EXECUTOR_MISSING';

export interface WfDefinitionIssue {
  code: WfDefinitionIssueCode;
  message: string;
  stepKey?: string;
  path?: (string | number)[];
}

export interface WfDefinitionValidationResponse {
  ok: boolean;
  issues: WfDefinitionIssue[];
}

/** W2 : entrée du catalogue d'outils d'agent (`GET /workflows/agents/tools`, menu administration) : un `WfToolDto` sans identifiant ni date. */
export type WfToolCatalogEntry = Omit<WfToolDto, 'wfToolId' | 'createdAt'>;

export type WfDefinitionVersionSummary = Omit<WfDefinitionVersionDto, 'graph' | 'sourcePrompt'>;

export interface WfDefinitionDetail {
  definition: WfDefinitionDto;
  versions: WfDefinitionVersionSummary[];
}

export interface WfDefinitionWithVersion {
  definition: WfDefinitionDto;
  version: WfDefinitionVersionDto;
}

export interface WfInstanceDetail {
  instance: WfInstanceDto;
  definitionName: string;
  versionNumber: number;
  tasks: WfTaskDto[];
  /** Journal chronologique (plus ancien d'abord). */
  events: WfEventLogDto[];
  inboxItems: WfInboxItemDto[];
}

export interface WfInboxEntry {
  item: WfInboxItemDto;
  task: Pick<WfTaskDto, 'wfTaskId' | 'stepKey' | 'taskType' | 'status' | 'attempt' | 'dueAt' | 'instructions'>;
  definitionName: string;
  instanceStatus: WfInstanceStatus;
}

/** Réponse des transitions (boîte, annulation, suspension, reprise). */
export interface WfTransitionResult {
  instance: WfInstanceDto;
  closedTasks: WfTaskDto[];
  openedTasks: WfTaskDto[];
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface LaunchInstanceInput {
  definitionId: number;
  context?: Record<string, unknown>;
  subjectType?: string;
  subjectId?: string;
  idempotencyKey?: string;
}

// ---------------------------------------------------------------------------
// Erreur typée
// ---------------------------------------------------------------------------

export class WorkflowApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Code moteur (NOT_FOUND, CONFLICT, INVALID_STATE, INVALID_INPUT, IDEMPOTENCY_CONFLICT…) si fourni. */
    readonly code?: string,
    /** Liste des problèmes d'une publication refusée (HTTP 422). */
    readonly issues?: WfDefinitionIssue[],
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WorkflowApiError';
  }

  get forbidden(): boolean {
    return this.status === 403;
  }
  get notFound(): boolean {
    return this.status === 404;
  }
  get conflict(): boolean {
    return this.status === 409;
  }
  get invalid(): boolean {
    return this.status === 422 || this.status === 400;
  }
}

/** Champs cités par un message de validation brut (« name: Required », « graph.steps.0.name: … ») ; au plus 5. */
export function fieldsFromValidationMessage(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/(?:^|[\s,;])([A-Za-z_][\w.[\]]*):\s/g)) {
    const f = m[1];
    if (f && f !== 'root' && !out.includes(f)) out.push(f);
  }
  return out.slice(0, 5);
}

/**
 * Message affichable. Les erreurs 5xx et 400 n'affichent JAMAIS le texte de l'API : une panne serveur ne doit
 * rien divulguer, et un 400 est un message de validation brut (anglais, noms de champs techniques).
 * Les autres statuts reprennent le message de l'API (en français : moteur et services du workflow).
 */
export function workflowErrorMessage(e: unknown): string {
  if (e instanceof WorkflowApiError) {
    if (e.status === 401) return 'Votre session a expiré. Reconnectez-vous.';
    if (e.status >= 500) return 'Le service est momentanément indisponible. Réessayez dans un instant.';
    if (e.status === 400) {
      const fields = fieldsFromValidationMessage(e.message);
      return fields.length > 0
        ? `Les informations envoyées sont refusées par le serveur (champs concernés : ${fields.join(', ')}). Corrigez-les puis réessayez.`
        : 'Les informations envoyées sont refusées par le serveur. Corrigez-les puis réessayez.';
    }
    if (e.status === 0) return 'Le serveur est injoignable. Vérifiez votre connexion.';
    if (e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
    if (e.status === 403) return 'Votre niveau d’accès ne permet pas cette action.';
    if (e.status === 404) return 'Élément introuvable ou hors de votre périmètre.';
    if (e.status === 409) return 'L’état a changé entre-temps. Actualisez puis réessayez.';
    if (e.status === 422) return 'Les informations saisies sont refusées.';
  }
  return 'Une erreur est survenue. Réessayez.';
}

/** Identifiant BigInt décimal d'instance ou d'élément de boîte (même motif que l'API). */
export const WF_BIGINT_ID_RE = /^\d{1,18}$/;
export const isWorkflowBigintId = (id: unknown): id is string => typeof id === 'string' && WF_BIGINT_ID_RE.test(id);

/** Identifiant sûr pour un chemin : refuse tout ce qui n'est pas un entier décimal (404 local, aucun appel réseau). */
function pathId(id: string): string {
  if (!isWorkflowBigintId(id)) throw new WorkflowApiError(404, 'Élément introuvable ou hors de votre périmètre.');
  return encodeURIComponent(id);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function authHeader(): Record<string, string> {
  try {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

interface ErrorBody {
  message?: unknown;
  code?: unknown;
  issues?: unknown;
  details?: unknown;
}

function messageOf(body: ErrorBody): string {
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.message)) return body.message.filter((m) => typeof m === 'string').join(' ');
  return '';
}

function isIssueList(value: unknown): value is WfDefinitionIssue[] {
  return (
    Array.isArray(value) &&
    value.every((v) => typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string')
  );
}

async function toError(res: Response): Promise<WorkflowApiError> {
  let body: ErrorBody = {};
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    /* corps vide ou non JSON */
  }
  if (res.status === 401 && typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem('token');
      if (window.location.pathname !== '/login') window.location.href = '/login';
    } catch {
      /* stockage indisponible */
    }
  }
  return new WorkflowApiError(
    res.status,
    messageOf(body) || `HTTP ${res.status}`,
    typeof body.code === 'string' ? body.code : undefined,
    isIssueList(body.issues) ? body.issues : undefined,
    body.details,
  );
}

async function requestWithStatus<T>(path: string, init?: RequestInit): Promise<{ data: T; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeader(), ...(init?.headers ?? {}) },
    });
  } catch {
    throw new WorkflowApiError(0, 'Le serveur est injoignable. Vérifiez votre connexion.');
  }
  if (!res.ok) throw await toError(res);
  return { data: (await res.json()) as T, status: res.status };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestWithStatus<T>(path, init)).data;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Appel d'une API pas encore livrée (W2 outils, W3 déclencheurs) : 404, 405, 501 ou réponse vide
 * => `null` (l'interface masque l'emplacement). 403 => `null` aussi : rien à montrer à cet utilisateur.
 * Les autres erreurs (réseau, 5xx) sont relancées.
 */
export async function requestOptional<T>(path: string): Promise<T | null> {
  try {
    return await request<T>(path);
  } catch (e) {
    if (e instanceof WorkflowApiError && [403, 404, 405, 501].includes(e.status)) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Routes (docs/workflow-moteur.md section 6)
// ---------------------------------------------------------------------------

const BASE = '/workflows';

export const workflowsApi = {
  // Définitions
  listDefinitions: (status?: number) =>
    request<WfDefinitionDto[]>(`${BASE}/definitions${qs({ status })}`),
  listLaunchable: () => request<WfDefinitionDto[]>(`${BASE}/definitions/launchable`),
  getDefinition: (id: number) => request<WfDefinitionDetail>(`${BASE}/definitions/${id}`),
  getVersion: (id: number, versionNumber: number) =>
    request<WfDefinitionVersionDto>(`${BASE}/definitions/${id}/versions/${versionNumber}`),
  createDefinition: (input: { name: string; description?: string; graph: WfGraph }) =>
    post<WfDefinitionWithVersion>(`${BASE}/definitions`, input),
  /**
   * Enregistre le brouillon. Si la dernière version est publiée, l'API crée une copie en brouillon
   * (numéro suivant) : c'est ainsi qu'on « duplique une version publiée en nouveau brouillon » (sans `graph`).
   */
  updateDraft: (
    id: number,
    input: { name?: string; description?: string | null; graph?: WfGraph; changeNote?: string | null },
  ) => request<WfDefinitionWithVersion>(`${BASE}/definitions/${id}/draft`, { method: 'PUT', body: JSON.stringify(input) }),
  validateDraft: (id: number) => post<WfDefinitionValidationResponse>(`${BASE}/definitions/${id}/validate`),
  publish: (id: number) => post<WfDefinitionWithVersion>(`${BASE}/definitions/${id}/publish`),
  archive: (id: number) => post<WfDefinitionDto>(`${BASE}/definitions/${id}/archive`),
  /** Réservé aux administrateurs (HTTP 403 sinon). */
  setLowRisk: (id: number, isLowRisk: boolean) =>
    post<WfDefinitionDto>(`${BASE}/definitions/${id}/low-risk`, { isLowRisk }),

  // Instances
  /** 201 => `created: true` ; 200 => la clé d'idempotence avait déjà servi : l'instance existante est renvoyée. */
  launch: async (input: LaunchInstanceInput): Promise<{ instance: WfInstanceDto; created: boolean }> => {
    const { data, status } = await requestWithStatus<WfInstanceDto>(`${BASE}/instances`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return { instance: data, created: status === 201 };
  },
  listInstances: (q: { status?: number; definitionId?: number; mine?: boolean; limit?: number; offset?: number }) =>
    request<Paged<WfInstanceDto>>(`${BASE}/instances${qs(q)}`),
  getInstance: (id: string) => request<WfInstanceDetail>(`${BASE}/instances/${pathId(id)}`),
  cancelInstance: (id: string, reason?: string) =>
    post<WfTransitionResult>(`${BASE}/instances/${pathId(id)}/cancel`, reason ? { reason } : {}),
  suspendInstance: (id: string, reason?: string) =>
    post<WfTransitionResult>(`${BASE}/instances/${pathId(id)}/suspend`, reason ? { reason } : {}),
  resumeInstance: (id: string) => post<WfTransitionResult>(`${BASE}/instances/${pathId(id)}/resume`),

  // Boîte (les identifiants sont ceux des ÉLÉMENTS de boîte)
  listInbox: (q: { statuses?: number[]; limit?: number; offset?: number }) =>
    request<Paged<WfInboxEntry>>(
      `${BASE}/inbox${qs({ status: q.statuses?.length ? q.statuses.join(',') : undefined, limit: q.limit, offset: q.offset })}`,
    ),
  claim: (itemId: string) => post<WfTransitionResult>(`${BASE}/inbox/${pathId(itemId)}/claim`),
  complete: (itemId: string, result: unknown, expectedRowVersion?: number) =>
    post<WfTransitionResult>(`${BASE}/inbox/${pathId(itemId)}/complete`, { result, expectedRowVersion }),
  reject: (itemId: string, comment?: string) =>
    post<WfTransitionResult>(`${BASE}/inbox/${pathId(itemId)}/reject`, comment ? { comment } : {}),
  delegate: (itemId: string, toUserGroupId: number, comment?: string) =>
    post<WfTransitionResult>(`${BASE}/inbox/${pathId(itemId)}/delegate`, { toUserGroupId, comment }),

  // Emplacements des lots W2 / W3 : chemins supposés, `null` tant que l'API n'existe pas.
  /** W2 : catalogue des outils d'agent (menu administration : 403 ou 404 => `null`, saisie manuelle des clés). */
  listAgentTools: () => requestOptional<WfToolCatalogEntry[]>(`${BASE}/agents/tools`),
  /** W3 (chemin confirmé) : déclencheurs d'un workflow ; la réponse est un sur-ensemble de `WfTriggerDto`. */
  listTriggers: (definitionId: number) =>
    requestOptional<WfTriggerDto[]>(`${BASE}/triggers${qs({ definitionId, limit: 100 })}`),
  /**
   * W2 : aucune route d'évaluation n'existe à ce jour => `null` SANS appel réseau ; « Autonome » reste grisé.
   * À brancher quand W2 en publiera une.
   */
  getEvaluationStatus: async (_definitionId: number): Promise<{ hasPassedEvalRun: boolean } | null> => null,
};

// ---------------------------------------------------------------------------
// Annuaire facultatif (listes réservées aux administrateurs : 403 => saisie numérique)
// ---------------------------------------------------------------------------

export interface DirectoryRole {
  roleId: number;
  name: string;
}
export interface DirectoryGroup {
  groupId: number;
  name: string;
}

export const directoryApi = {
  roles: () => requestOptional<DirectoryRole[]>('/roles'),
  groups: () => requestOptional<DirectoryGroup[]>('/users/groups/all'),
};
