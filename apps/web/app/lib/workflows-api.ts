// Docu-Flow — client d'API du workflow (lot W4). Le contrat vit dans @archivage/types (DTO, graphe) et dans
// docs/workflow-moteur.md (routes). Les types propres à l'API (boîte, détail d'instance, réponses de
// transition) sont recopiés ici : apps/api n'est pas importable depuis le web.
//
// Client local (calque de gouvernance-api.ts) : lib/api.ts ne conserve pas le code HTTP, or l'interface doit
// distinguer 403 / 404 / 409 / 422 (dont la liste `issues` d'une publication refusée). Les routes des agents
// (outils et autorisations, évaluation, budget et arrêt d'urgence, configuration des étapes agent) existent
// désormais : les méthodes strictes lèvent `WorkflowApiError`. Seuls `listAgentTools`, `listTriggers`,
// `listTemplates` et `getEvalStatus` renvoient `null` quand l'accès est refusé ou la route absente
// (403 / 404 / 405 / 501) afin que l'interface masque l'emplacement.
import type {
  UpsertWfAgentConfigInput,
  WfAgentConfigDetailDto,
  WfAuthoringExplanation,
  WfAuthoringGenerateInput,
  WfAuthoringGenerateResponse,
  WfBudgetDto,
  WfBudgetPeriodKind,
  WfDefinitionDto,
  WfDefinitionVersionDto,
  WfEvalCaseDto,
  WfEvalRunDto,
  WfEvalSetDto,
  WfEventLogDto,
  WfGraph,
  WfGraphIssueCode,
  WfInboxItemDto,
  WfInstanceDto,
  WfInstanceStatus,
  WfTaskDto,
  WfTemplateSummary,
  WfToolDto,
  WfTriggerDto,
} from '@archivage/types';
import { API_BASE } from './api';

// ---------------------------------------------------------------------------
// Types propres à l'API
// ---------------------------------------------------------------------------

export type WfDefinitionIssueCode =
  | WfGraphIssueCode
  | 'ESCALATION_INVALID'
  | 'EXECUTOR_MISSING'
  | 'AUTHORING_TO_COMPLETE'
  // Étapes agent, émis à la validation et à la publication (apps/api/.../workflows/definitions-agents.ts).
  | 'AGENT_CONFIG_INVALID'
  | 'AGENT_TOOL_UNKNOWN'
  | 'AGENT_TOOL_NOT_GRANTED'
  | 'AGENT_AUTONOMY_NOT_ELIGIBLE';

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

/** Autorisation d'outil d'un workflow (`GET /workflows/agents/definitions/:id/tool-grants`, menu administration). */
export interface WfToolGrantEntry {
  toolKey: string;
  maxCallsPerInstance: number | null;
}

/** Entrée du remplacement des autorisations : `maxCallsPerInstance` absent ou nul = pas de limite. */
export interface WfToolGrantInput {
  toolKey: string;
  maxCallsPerInstance?: number | null;
}

export interface WfToolGrantsResponse {
  grants: WfToolGrantEntry[];
  /** Avertissements non bloquants en français (ex. autorisation retirée mais encore utilisée par le brouillon). */
  warnings: string[];
}

// Évaluation des agents (`/workflows/agents/eval-*`, menu conception).

/** Entrée d'un cas : blocs de texte non fiables, objet lié, contexte (champs inconnus refusés par l'API). */
export interface WfEvalCaseInputPayload {
  untrusted?: { label: string; origin: 'mail' | 'document' | 'ocr' | 'form' | 'context'; text: string }[];
  subject?: { type: string | null; id: string | null };
  context?: Record<string, unknown>;
}

/** Résultat attendu d'un cas : au moins un critère non vide. */
export interface WfEvalExpectedPayload {
  result?: Record<string, unknown>;
  returnsToHuman?: boolean;
  suspicionInjection?: boolean;
  /** 0..1 */
  minConfidence?: number;
}

export interface CreateEvalSetInput {
  definitionId: number;
  /** Étape agent visée ; nul ou absent = jeu général du workflow. */
  stepKey?: string | null;
  name: string;
  description?: string | null;
  /** Précision minimale, 0..1, au plus 3 décimales. */
  minAccuracy?: number;
}

/** Le workflow d'un jeu ne change jamais (`definitionId` est donc absent ici). */
export interface UpdateEvalSetInput {
  stepKey?: string | null;
  name?: string;
  description?: string | null;
  minAccuracy?: number;
  isActive?: boolean;
}

export interface CreateEvalCaseInput {
  label: string;
  input: WfEvalCaseInputPayload;
  expected: WfEvalExpectedPayload;
  /** 1..1000 */
  weight?: number;
  sortOrder?: number;
}

export interface UpdateEvalCaseInput {
  label?: string;
  input?: WfEvalCaseInputPayload;
  expected?: WfEvalExpectedPayload;
  weight?: number;
  sortOrder?: number;
  isActive?: boolean;
}

export interface RunEvalSetInput {
  definitionVersionId?: number;
  stepKey?: string;
}

/** `GET /workflows/agents/eval-status?definitionId=` (menu conception) : éligibilité à « autonome » par étape agent. */
export interface WfEvalStatusStep {
  stepKey: string;
  evalSetId: number | null;
  /** Éligibilité réelle à « autonome » (faible risque et dernier run réussi compris). */
  eligible: boolean;
  /** Raison en français quand l'étape n'est pas éligible ; nul sinon. */
  reason: string | null;
}

export interface WfEvalStatus {
  definitionId: number;
  definitionVersionId: number;
  versionNumber: number;
  steps: WfEvalStatusStep[];
}

// Administration des agents (`/workflows/agents/status|budget|emergency-stop`, menu administration).

export interface WfAgentStatus {
  aiEnabled: boolean;
  aiMode: number;
  emergencyStopGlobal: boolean;
}

export interface WfAgentBudgetOverview {
  global: WfBudgetDto;
  workflows: WfBudgetDto[];
}

/** `definitionId` absent ou nul = budget global. Un champ absent n'est pas modifié ; `capAmount: null` retire le plafond. */
export interface UpdateAgentBudgetInput {
  definitionId?: number | null;
  /** 0 .. 9 999 999 999, ou nul. */
  capAmount?: number | null;
  /** 0 = mensuel, 1 = journalier, 2 = cumulé. */
  periodKind?: WfBudgetPeriodKind;
  /** 0..1 */
  alertThreshold?: number;
  /** 3 lettres majuscules (ex. XOF). */
  currency?: string;
}

export interface SetEmergencyStopInput {
  /** Absent ou nul = arrêt d'urgence global. */
  definitionId?: number | null;
  active: boolean;
  /** 500 caractères au plus. */
  reason?: string;
}

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
    /** HTTP 429 : délai avant nouvel essai, en secondes (en-tête `Retry-After`), si fourni et valide. */
    readonly retryAfterSeconds?: number,
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
    if (e.status === 429) return 'Trop de demandes en peu de temps. Patientez quelques instants puis réessayez.';
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

/** Identifiant entier positif (définition, jeu, cas…) pour un chemin ou une requête : sinon 404 local, aucun appel réseau. */
function intId(id: number): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new WorkflowApiError(404, 'Élément introuvable ou hors de votre périmètre.');
  }
  return id;
}

/** Clé d'étape pour un chemin (même motif que l'API : minuscule puis minuscules, chiffres, « _ » ; 100 caractères au plus). */
function stepKeyPath(stepKey: string): string {
  if (typeof stepKey !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(stepKey)) {
    throw new WorkflowApiError(404, 'Étape introuvable.');
  }
  return encodeURIComponent(stepKey);
}

const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

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
  /** Code texte du moteur (ex. IDEMPOTENCY_CONFLICT) : l'API renvoie `code` NUMÉRIQUE (statut) et ce champ en plus. */
  errorCode?: unknown;
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

/** `Retry-After` en secondes entières (1 à 86400) ; une date HTTP ou une valeur invalide donne `undefined`. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,6}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= 86400 ? n : undefined;
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
    typeof body.errorCode === 'string' ? body.errorCode : typeof body.code === 'string' ? body.code : undefined,
    isIssueList(body.issues) ? body.issues : undefined,
    body.details,
    res.status === 429 ? parseRetryAfter(res.headers?.get?.('Retry-After')) : undefined,
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

/** Clé de modèle (W6) : minuscules, chiffres, « _ », « . », « - » ; 1 à 100 caractères. */
export const WF_TEMPLATE_KEY_RE = /^[a-z0-9_.-]{1,100}$/;

function templatePath(key: string): string {
  if (typeof key !== 'string' || !WF_TEMPLATE_KEY_RE.test(key)) {
    throw new WorkflowApiError(404, 'Modèle introuvable.');
  }
  return encodeURIComponent(key);
}

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

  // Agents (lots W2 / W3) : les routes existent.
  /** Catalogue des outils d'agent, version TOLÉRANTE (menu administration : 403 ou 404 => `null`, saisie manuelle des clés). */
  listAgentTools: () => requestOptional<WfToolCatalogEntry[]>(`${BASE}/agents/tools`),
  /** Catalogue des outils d'agent, version STRICTE : toute erreur (dont 403 et 404) lève `WorkflowApiError`. Menu administration. */
  getAgentToolCatalog: () => request<WfToolCatalogEntry[]>(`${BASE}/agents/tools`),
  /** Outils autorisés pour ce workflow (menu administration). */
  getToolGrants: (definitionId: number) =>
    request<WfToolGrantEntry[]>(`${BASE}/agents/definitions/${intId(definitionId)}/tool-grants`),
  /** Remplace l'ensemble des autorisations du workflow (menu administration) ; `warnings` : avertissements non bloquants. */
  replaceToolGrants: (definitionId: number, grants: WfToolGrantInput[]) =>
    put<WfToolGrantsResponse>(`${BASE}/agents/definitions/${intId(definitionId)}/tool-grants`, { grants }),

  // Évaluation des agents (menu conception).
  listEvalSets: (definitionId?: number) =>
    request<WfEvalSetDto[]>(
      `${BASE}/agents/eval-sets${qs({ definitionId: definitionId === undefined ? undefined : intId(definitionId) })}`,
    ),
  createEvalSet: (input: CreateEvalSetInput) => post<WfEvalSetDto>(`${BASE}/agents/eval-sets`, input),
  updateEvalSet: (setId: number, input: UpdateEvalSetInput) =>
    patch<WfEvalSetDto>(`${BASE}/agents/eval-sets/${intId(setId)}`, input),
  listEvalCases: (setId: number, includeInactive?: boolean) =>
    request<WfEvalCaseDto[]>(
      `${BASE}/agents/eval-sets/${intId(setId)}/cases${qs({ includeInactive })}`,
    ),
  addEvalCase: (setId: number, input: CreateEvalCaseInput) =>
    post<WfEvalCaseDto>(`${BASE}/agents/eval-sets/${intId(setId)}/cases`, input),
  updateEvalCase: (setId: number, caseId: number, input: UpdateEvalCaseInput) =>
    patch<WfEvalCaseDto>(`${BASE}/agents/eval-sets/${intId(setId)}/cases/${intId(caseId)}`, input),
  /** « Supprimer » un cas = le désactiver (les runs passés restent lisibles) ; renvoie le cas désactivé. */
  removeEvalCase: (setId: number, caseId: number) =>
    request<WfEvalCaseDto>(`${BASE}/agents/eval-sets/${intId(setId)}/cases/${intId(caseId)}`, { method: 'DELETE' }),
  listEvalRuns: (setId: number) => request<WfEvalRunDto[]>(`${BASE}/agents/eval-sets/${intId(setId)}/runs`),
  /** HTTP 202 : le run est créé « en cours » et s'exécute en arrière-plan ; relire avec `getEvalRun`. */
  runEvalSet: (setId: number, input: RunEvalSetInput = {}) =>
    post<WfEvalRunDto>(`${BASE}/agents/eval-sets/${intId(setId)}/runs`, input),
  /** `runId` : identifiant décimal (BigInt) d'un run, en chaîne. */
  getEvalRun: (runId: string) => request<WfEvalRunDto>(`${BASE}/agents/eval-runs/${pathId(runId)}`),
  /** Étapes agent du brouillon avec leur jeu d'évaluation lié (`evalSetId`) ; menu conception. */
  listDraftAgents: (definitionId: number) =>
    request<WfAgentConfigDetailDto[]>(`${BASE}/definitions/${intId(definitionId)}/draft/agents`),
  /** Met à jour une étape agent du brouillon, dont le lien `evalSetId` (nul = délier). */
  updateDraftAgent: (definitionId: number, stepKey: string, input: UpsertWfAgentConfigInput) =>
    put<WfAgentConfigDetailDto>(`${BASE}/definitions/${intId(definitionId)}/draft/agents/${stepKeyPath(stepKey)}`, input),
  /** Éligibilité à « autonome » par étape agent de la dernière version : 403, 404, 405 ou 501 => `null`. */
  getEvalStatus: (definitionId: number) =>
    requestOptional<WfEvalStatus>(`${BASE}/agents/eval-status${qs({ definitionId: intId(definitionId) })}`),

  // Administration des agents (menu administration).
  getAgentStatus: () => request<WfAgentStatus>(`${BASE}/agents/status`),
  getAgentBudget: () => request<WfAgentBudgetOverview>(`${BASE}/agents/budget`),
  updateAgentBudget: (input: UpdateAgentBudgetInput) => put<WfBudgetDto>(`${BASE}/agents/budget`, input),
  /** Arrêt d'urgence (global si `definitionId` est absent ou nul) ; renvoie la ligne de budget modifiée. */
  setEmergencyStop: (input: SetEmergencyStopInput) => post<WfBudgetDto>(`${BASE}/agents/emergency-stop`, input),

  /** W3 (chemin confirmé) : déclencheurs d'un workflow ; la réponse est un sur-ensemble de `WfTriggerDto`. */
  listTriggers: (definitionId: number) =>
    requestOptional<WfTriggerDto[]>(`${BASE}/triggers${qs({ definitionId, limit: 100 })}`),
  /**
   * Compatibilité de l'éditeur actuel : au moins une étape agent éligible à « autonome » => `hasPassedEvalRun`.
   * Route absente ou refusée (`getEvalStatus` => `null`) => `null` : « Autonome » reste grisé. Le détail
   * par étape est dans `getEvalStatus`.
   */
  getEvaluationStatus: async (definitionId: number): Promise<{ hasPassedEvalRun: boolean } | null> => {
    const status = await workflowsApi.getEvalStatus(definitionId);
    return status === null ? null : { hasPassedEvalRun: status.steps.some((s) => s.eligible) };
  },

  // W5 : création en langage naturel (brouillon, jamais publié).
  /** `signal` : annulation de l'attente côté navigateur (la génération côté serveur peut aboutir quand même). */
  authoringGenerate: (input: WfAuthoringGenerateInput, signal?: AbortSignal) =>
    request<WfAuthoringGenerateResponse>(`${BASE}/authoring/generate`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    }),
  authoringExplain: (definitionId: number) =>
    post<WfAuthoringExplanation>(`${BASE}/authoring/explain/${encodeURIComponent(String(definitionId))}`),
  // W6 (lot parallèle) : 403, 404, 405 ou 501 => `null` tant que l'API n'est pas livrée (bouton masqué).
  listTemplates: () => requestOptional<WfTemplateSummary[]>(`${BASE}/templates`),
  instantiateTemplate: async (key: string) => {
    const path = templatePath(key); // clé invalide : rejet immédiat, aucun appel réseau
    return post<{ definitionId: number }>(`${BASE}/templates/${path}/instantiate`);
  },
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
