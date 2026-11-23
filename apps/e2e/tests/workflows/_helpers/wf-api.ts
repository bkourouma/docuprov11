// Docu-Flow E2E : aides REST partagées par les specs `tests/workflows/**`.
//
// Elles créent les données par l'API (définition, publication, lancement, actions de boîte) pour que chaque
// test n'ait à manipuler à l'écran que ce qu'il vérifie. Le client est l'`ApiClient` des fixtures.
//
// Formes de réponse : celles de l'API (`packages/types/src/wf-dto.ts`, `apps/api/src/modules/workflows/**`).

import { expect } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';

/** Client REST des fixtures (`api`, ou celui rendu par `apiAs`). */
export type ApiLike = ApiClient;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Clés de menu Docu-Flow (`apps/api/src/modules/workflows/workflows.menus.ts`). */
export const WF_MENUS = {
  design: '/workflows/conception',
  launch: '/workflows/lancer',
  admin: '/workflows/administration',
} as const;

/** `wf_instance.status` (`packages/types/src/wf-enums.ts`). */
export const WF_INSTANCE_STATUS = {
  running: 0,
  waitingHuman: 1,
  completed: 2,
  failed: 3,
  cancelled: 4,
  suspended: 5,
} as const;

/** `wf_task.status`. */
export const WF_TASK_STATUS = { open: 0, claimed: 1, completed: 2, cancelled: 3, expired: 4, failed: 5 } as const;

/** `wf_inbox_item.status`. */
export const WF_INBOX_STATUS = { open: 0, claimed: 1, done: 2, rejected: 3, expired: 4, cancelled: 5 } as const;

/** `wf_definition.status` : 0 brouillon, 1 publiée, 2 archivée (voir WF_DEFINITION_STATUS_LABELS). */
export const WF_DEFINITION_STATUS = { draft: 0, published: 1, archived: 2 } as const;

// ---------------------------------------------------------------------------
// Graphes (forme `wfGraphSchema`, packages/types/src/wf-graph.ts)
// ---------------------------------------------------------------------------

export type WfAssignee =
  | { kind: 'user' | 'group' | 'role'; id: number }
  | { kind: 'initiator' | 'subject_owner' };

export interface WfEdge {
  to: string;
  label?: string;
  condition?: { field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'exists'; value?: unknown };
  isDefault?: boolean;
}

export interface WfStep {
  key: string;
  name: string;
  type: 'formulaire' | 'generation' | 'checklist' | 'affectation' | 'validation' | 'decision' | 'agent';
  description?: string;
  assignee?: WfAssignee;
  dueInHours?: number;
  reminderAfterHours?: number;
  config?: Record<string, unknown>;
  agent?: {
    objective: string;
    tools?: string[];
    confidenceThreshold?: number;
    autonomy?: 'suggere' | 'agit_avec_validation' | 'autonome';
    model?: string;
    maxCostPerRun?: number;
  };
  next?: WfEdge[];
}

export interface WfGraph {
  schemaVersion: 1;
  start: string;
  steps: WfStep[];
}

/** Graphe minimal publiable : une seule étape formulaire, assignée au lanceur, terminale. */
export function singleFormGraph(opts: { assignee?: WfAssignee; fields?: { key: string; label?: string; required?: boolean }[] } = {}): WfGraph {
  return {
    schemaVersion: 1,
    start: 'saisie',
    steps: [
      {
        key: 'saisie',
        name: 'Saisie de la demande',
        type: 'formulaire',
        assignee: opts.assignee ?? { kind: 'initiator' },
        config: { fields: opts.fields ?? [{ key: 'objet', label: 'Objet', required: true }] },
        next: [],
      },
    ],
  };
}

/**
 * Circuit de validation à deux personnes, avec voie de correction :
 *
 *   saisie (formulaire, lanceur)
 *     -> validation (validation, `validator`)
 *          approved = true  -> visa (validation, `secondValidator` ou `validator`) -> fin
 *          approved = false -> correction (formulaire, lanceur) -> validation (boucle de correction)
 *
 * Le refus (`reject`) emprunte la branche `approved = false` (docs/workflow-moteur.md 3.8). `visa` est
 * terminale. Toutes les étapes sont publiables (validateWorkflowGraph).
 */
export function approvalCircuitGraph(opts: { validator: WfAssignee; secondValidator?: WfAssignee }): WfGraph {
  return {
    schemaVersion: 1,
    start: 'saisie',
    steps: [
      {
        key: 'saisie',
        name: 'Saisie de la demande',
        type: 'formulaire',
        assignee: { kind: 'initiator' },
        config: { fields: [{ key: 'objet', label: 'Objet', required: true }, { key: 'montant', label: 'Montant' }] },
        next: [{ to: 'validation', label: 'Soumettre' }],
      },
      {
        key: 'validation',
        name: 'Validation du responsable',
        type: 'validation',
        assignee: opts.validator,
        next: [
          { to: 'visa', label: 'Accepté', condition: { field: 'last.approved', op: 'eq', value: true } },
          { to: 'correction', label: 'À corriger', condition: { field: 'last.approved', op: 'eq', value: false } },
        ],
      },
      {
        key: 'correction',
        name: 'Correction de la demande',
        type: 'formulaire',
        assignee: { kind: 'initiator' },
        config: { fields: [{ key: 'objet', label: 'Objet', required: true }, { key: 'montant', label: 'Montant' }] },
        next: [{ to: 'validation', label: 'Resoumettre' }],
      },
      {
        key: 'visa',
        name: 'Visa final',
        type: 'validation',
        assignee: opts.secondValidator ?? opts.validator,
        next: [],
      },
    ],
  };
}

/** Graphe NON publiable : l'étape `orpheline` n'est atteignable depuis aucune autre (UNREACHABLE_STEP). */
export function unreachableStepGraph(): WfGraph {
  return {
    schemaVersion: 1,
    start: 'debut',
    steps: [
      { key: 'debut', name: 'Début', type: 'formulaire', assignee: { kind: 'initiator' }, next: [] },
      { key: 'orpheline', name: 'Étape orpheline', type: 'formulaire', assignee: { kind: 'initiator' }, next: [] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Définitions
// ---------------------------------------------------------------------------

export interface WfDefinitionDto {
  wfDefinitionId: number;
  name: string;
  description: string | null;
  status: number;
  isLowRisk: boolean;
}

export interface WfDefinitionVersionDto {
  wfDefinitionVersionId: number;
  definitionId: number;
  versionNumber: number;
  status: number;
  graph: WfGraph;
}

export interface WfDefinitionWithVersion {
  definition: WfDefinitionDto;
  version: WfDefinitionVersionDto;
}

/** POST /workflows/definitions : crée la définition et sa version 1 en brouillon. */
export function createDefinition(
  api: ApiLike,
  input: { name: string; description?: string; graph: WfGraph },
): Promise<WfDefinitionWithVersion> {
  return api.post('/workflows/definitions', input);
}

/** PUT /workflows/definitions/:id/draft. */
export function updateDraft(
  api: ApiLike,
  definitionId: number,
  input: { name?: string; description?: string | null; graph?: WfGraph; changeNote?: string | null },
): Promise<WfDefinitionWithVersion> {
  return api.put(`/workflows/definitions/${definitionId}/draft`, input);
}

/** POST /workflows/definitions/:id/publish (422 + `issues` si le graphe n'est pas publiable). */
export function publishDefinition(api: ApiLike, definitionId: number): Promise<WfDefinitionWithVersion> {
  return api.post(`/workflows/definitions/${definitionId}/publish`, {});
}

/** POST /workflows/definitions/:id/archive. */
export function archiveDefinition(api: ApiLike, definitionId: number): Promise<WfDefinitionDto> {
  return api.post(`/workflows/definitions/${definitionId}/archive`, {});
}

/** Crée puis publie : renvoie la définition publiée et sa version. */
export async function createPublishedDefinition(
  api: ApiLike,
  input: { name: string; description?: string; graph: WfGraph },
): Promise<WfDefinitionWithVersion> {
  const created = await createDefinition(api, input);
  return publishDefinition(api, created.definition.wfDefinitionId);
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export interface WfInstanceDto {
  wfInstanceId: string;
  definitionId: number;
  definitionVersionId: number;
  status: number;
  context: Record<string, unknown>;
  startedBy: number;
  errorMessage: string | null;
  rowVersion: number;
  finishedAt: string | null;
}

export interface WfTaskDto {
  wfTaskId: string;
  instanceId: string;
  stepKey: string;
  taskType: number;
  status: number;
  title: string;
  attempt: number;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
  result: unknown;
  completedBy: number | null;
}

export interface WfEventLogDto {
  wfEventLogId: string;
  taskId: string | null;
  stepKey: string | null;
  eventType: string;
  actorKind: number;
  actorUserGroupId: number | null;
  validatedBy: number | null;
}

export interface WfInboxItemDto {
  wfInboxItemId: string;
  taskId: string;
  instanceId: string;
  kind: number;
  status: number;
  title: string;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
  dueAt: string | null;
  claimedBy: number | null;
  resolvedBy: number | null;
}

export interface WfInstanceDetail {
  instance: WfInstanceDto;
  definitionName: string;
  versionNumber: number;
  tasks: WfTaskDto[];
  events: WfEventLogDto[];
  inboxItems: WfInboxItemDto[];
}

export interface WfInboxEntry {
  item: WfInboxItemDto;
  task: { wfTaskId: string; stepKey: string; taskType: number; status: number; attempt: number };
  definitionName: string;
  instanceStatus: number;
}

/** POST /workflows/instances (menu lancer). Renvoie l'instance (201 créée, 200 rejeu d'idempotence). */
export function launchInstance(
  api: ApiLike,
  definitionId: number,
  opts: { context?: Record<string, unknown>; idempotencyKey?: string; subjectType?: string; subjectId?: string } = {},
): Promise<WfInstanceDto> {
  return api.post('/workflows/instances', { definitionId, ...opts });
}

/** GET /workflows/instances/:id (lanceur, assigné ou administration ; sinon 404). */
export function getInstance(api: ApiLike, instanceId: string): Promise<WfInstanceDetail> {
  return api.get(`/workflows/instances/${encodeURIComponent(instanceId)}`);
}

export function cancelInstance(api: ApiLike, instanceId: string, reason?: string): Promise<unknown> {
  return api.post(`/workflows/instances/${encodeURIComponent(instanceId)}/cancel`, reason ? { reason } : {});
}

export function suspendInstance(api: ApiLike, instanceId: string, reason?: string): Promise<unknown> {
  return api.post(`/workflows/instances/${encodeURIComponent(instanceId)}/suspend`, reason ? { reason } : {});
}

export function resumeInstance(api: ApiLike, instanceId: string): Promise<unknown> {
  return api.post(`/workflows/instances/${encodeURIComponent(instanceId)}/resume`, {});
}

/** Attend (sans délai arbitraire) que l'instance atteigne le statut voulu. */
export async function waitForInstanceStatus(api: ApiLike, instanceId: string, status: number): Promise<WfInstanceDetail> {
  await expect
    .poll(async () => (await getInstance(api, instanceId)).instance.status, {
      message: `statut de l'instance ${instanceId}`,
      timeout: 15_000,
    })
    .toBe(status);
  return getInstance(api, instanceId);
}

// ---------------------------------------------------------------------------
// Boîte de tâches (identifiants = ceux des ÉLÉMENTS de boîte)
// ---------------------------------------------------------------------------

/** GET /workflows/inbox (statuts « 0,1 » par défaut). */
export function listInbox(api: ApiLike, statuses?: number[]): Promise<{ items: WfInboxEntry[]; total: number }> {
  const query = statuses && statuses.length > 0 ? `?status=${statuses.join(',')}&limit=100` : '?limit=100';
  return api.get(`/workflows/inbox${query}`);
}

/**
 * Élément ouvert de la boîte de `api` pour cette instance (et cette étape si précisée). Attend qu'il
 * apparaisse : le moteur crée l'élément dans la transaction de la transition, mais un exécuteur peut
 * enchaîner après commit.
 */
export async function findInboxEntry(
  api: ApiLike,
  instanceId: string,
  stepKey?: string,
): Promise<WfInboxEntry> {
  let found: WfInboxEntry | undefined;
  await expect
    .poll(
      async () => {
        const { items } = await listInbox(api);
        found = items.find((e) => e.item.instanceId === instanceId && (!stepKey || e.task.stepKey === stepKey));
        return found !== undefined;
      },
      { message: `élément de boîte de l'instance ${instanceId}${stepKey ? ` (étape ${stepKey})` : ''}`, timeout: 15_000 },
    )
    .toBe(true);
  return found as WfInboxEntry;
}

export function claimItem(api: ApiLike, itemId: string): Promise<unknown> {
  return api.post(`/workflows/inbox/${encodeURIComponent(itemId)}/claim`, {});
}

export function completeItem(api: ApiLike, itemId: string, result: unknown, expectedRowVersion?: number): Promise<unknown> {
  return api.post(`/workflows/inbox/${encodeURIComponent(itemId)}/complete`, {
    result,
    ...(expectedRowVersion === undefined ? {} : { expectedRowVersion }),
  });
}

export function rejectItem(api: ApiLike, itemId: string, comment?: string): Promise<unknown> {
  return api.post(`/workflows/inbox/${encodeURIComponent(itemId)}/reject`, comment ? { comment } : {});
}

export function delegateItem(api: ApiLike, itemId: string, toUserGroupId: number, comment?: string): Promise<unknown> {
  return api.post(`/workflows/inbox/${encodeURIComponent(itemId)}/delegate`, {
    toUserGroupId,
    ...(comment ? { comment } : {}),
  });
}
