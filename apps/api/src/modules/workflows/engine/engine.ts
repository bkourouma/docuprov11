import { Prisma, type PrismaClient, type WfEventLog, type WfInboxItem, type WfInstance, type WfTask } from '@prisma/client';
import {
  WF_KEY_PATTERN,
  WF_SUBJECT_TYPE_MAX_LENGTH,
  WF_TASK_TYPE_KEYS,
  WfActorKind,
  WfInboxItemKind,
  WfInboxItemStatus,
  WfInstanceStatus,
  WfTaskStatus,
  WfTaskType,
  WfTimerKind,
  WfTimerStatus,
  isWfTaskType,
  wfGraphSchema,
  wfTaskTypeFromKey,
  wfTaskTypeToKey,
  type WfActorKind as WfActorKindValue,
  type WfAutonomyLevel,
  type WfEventLogDto,
  type WfGraph,
  type WfInboxItemDto,
  type WfInboxItemKind as WfInboxItemKindValue,
  type WfInboxItemStatus as WfInboxItemStatusValue,
  type WfInstanceDto,
  type WfInstanceStatus as WfInstanceStatusValue,
  type WfStep,
  type WfTaskDto,
  type WfTaskPriority,
  type WfTaskStatus as WfTaskStatusValue,
  type WfTaskTypeKey,
} from '@archivage/types';
import {
  WfEngineError,
  type WfActorRef,
  type WfAgentAudit,
  type WfAssigneeRef,
  type WfDirectory,
  type WfEngineEvent,
  type WfExecutorOutcome,
  type WfInboxEntry,
  type WfInboxFilter,
  type WfInstanceDetail,
  type WfPrincipal,
  type WfStartInstanceInput,
  type WfStartInstanceResult,
  type WfTaskExecutorRegistry,
  type WfTransitionResult,
  type WorkflowEngineApi,
} from './engine.types';
import {
  WF_AUTO_CHAIN_LIMIT,
  WF_COMMENT_MAX,
  WF_CONTEXT_INPUT_MAX_BYTES,
  WF_INBOX_SUMMARY_MAX,
  WF_LOG_INSTRUCTION_MAX,
  WF_RESULT_MAX_BYTES,
  WF_TITLE_MAX,
  applyStepResult,
  assigneeSourceNote,
  assignmentFromResult,
  attemptLimitMessage,
  autoChainLimitMessage,
  boundJson,
  buildInboxExplanation,
  buildRejectionResult,
  buildTaskSpec,
  canonicalJson,
  chooseNextEdge,
  findStep,
  initialContext,
  isAttemptAllowed,
  isAutomaticDecision,
  isPlainObject,
  isTaskAssignee,
  jsonByteLength,
  normalizeContext,
  resolvePriority,
  summarizeResultForLog,
  truncateText,
  validateTaskResult,
  type WfInstanceContext,
} from './interpreter';

// Docu-Flow — moteur d'exécution (lot W1). Classe SANS Nest, construite avec un PrismaClient.
//
// Règles de concurrence (toutes les transitions) :
//  1. transaction interactive (READ COMMITTED) ;
//  2. `SELECT … FOR UPDATE` de la ligne wf_instance : toutes les lectures qui décident d'une écriture
//     sont faites APRÈS ce verrou (chaque requête voit alors les écritures validées par le précédent
//     détenteur) ;
//  3. écritures + journal (wf_event_log) dans la MÊME transaction ;
//  4. `UPDATE wf_instance … WHERE row_version = <lu>` (compteur + 1) : 0 ligne => CONFLICT (rollback).
// Les exécuteurs sont appelés APRÈS commit, hors transaction ; leur résultat est appliqué par une
// nouvelle transition verrouillée qui revérifie que la tâche est toujours ouverte (sinon : ignoré).

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export interface WorkflowEngineDeps {
  registry?: WfTaskExecutorRegistry;
  directory?: WfDirectory;
  now?: () => Date;
  /**
   * Événements produits HORS d'un appel (résultat d'un exécuteur en arrière-plan). Les événements d'un
   * appel direct sont, eux, renvoyés dans `WfTransitionResult.events` (jamais publiés deux fois).
   */
  onEvents?: (events: WfEngineEvent[]) => void | Promise<void>;
  /** Erreur d'un traitement d'arrière-plan (exécuteur, publication) : jamais propagée. */
  onBackgroundError?: (error: unknown, context: { taskId?: string; stage: string }) => void;
  /** Délai maximal d'une transaction (ms). Défaut 15 000. */
  transactionTimeoutMs?: number;
}

interface Run {
  tx: Tx;
  now: Date;
  instanceId: bigint;
  /** row_version lu sous verrou (0 pour une instance créée dans la transaction). */
  lockedRowVersion: number;
  row: WfInstance;
  graph: WfGraph;
  definitionName: string;
  status: WfInstanceStatusValue;
  context: WfInstanceContext;
  errorMessage: string | null;
  finishedAt: Date | null;
  closedTasks: WfTask[];
  openedTasks: WfTask[];
  events: WfEngineEvent[];
  executorJobs: bigint[];
  /** Étapes entrées pendant cette transition (garde-fou d'enchaînement automatique). */
  chain: number;
  launcherLabel?: string;
  /** Au moins une écriture : l'instance doit être mise à jour (row_version + 1). */
  dirty: boolean;
}

interface LogEntry {
  type: string;
  actor: WfActorRef;
  taskId?: bigint | null;
  stepKey?: string | null;
  instruction?: string | null;
  decision?: unknown;
  explanation?: string | null;
  sources?: unknown;
  confidence?: number | null;
  validatedBy?: number | null;
  validatedAt?: Date | null;
  /** Éléments d'audit d'agent (colonnes existantes du journal). */
  autonomyLevel?: 0 | 1 | 2 | null;
  model?: string | null;
  aiDecisionId?: bigint | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costAmount?: number | null;
}

interface TaskScope {
  task: WfTask;
  step: WfStep;
  /** Éléments de boîte OUVERTS (statuts 0, 1) de la tâche. */
  items: WfInboxItem[];
  claimedBy: number | null;
}

type InternalOutcome = WfExecutorOutcome | { kind: 'error'; message: string };

const SYSTEM: WfActorRef = { kind: 'system' };
const AGENT: WfActorRef = { kind: 'agent' };
const ACTIVE_INSTANCE: readonly number[] = [WfInstanceStatus.Running, WfInstanceStatus.Waiting];
const OPEN_TASK: readonly number[] = [WfTaskStatus.Todo, WfTaskStatus.InProgress];
const OPEN_INBOX: readonly number[] = [WfInboxItemStatus.Open, WfInboxItemStatus.Claimed];
const MAX_BIGINT = 9223372036854775807n;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;
const MAX_PAGE = 200;
const ERROR_MESSAGE_MAX = 2000;
const REASON_MAX = 500;
const MODEL_MAX = 200;
const INT32_MAX = 2147483647;
const COST_MAX = 9999999999.9999; // Decimal(14, 4)

export class WorkflowEngine implements WorkflowEngineApi {
  private readonly registry?: WfTaskExecutorRegistry;
  private readonly directory?: WfDirectory;
  private readonly clock: () => Date;
  private readonly onEvents?: WorkflowEngineDeps['onEvents'];
  private readonly onBackgroundError?: WorkflowEngineDeps['onBackgroundError'];
  private readonly txTimeout: number;
  private readonly graphCache = new Map<number, WfGraph>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaClient,
    deps: WorkflowEngineDeps = {},
  ) {
    this.registry = deps.registry;
    this.directory = deps.directory;
    this.clock = deps.now ?? (() => new Date());
    this.onEvents = deps.onEvents;
    this.onBackgroundError = deps.onBackgroundError;
    this.txTimeout = deps.transactionTimeoutMs ?? 15_000;
  }

  /** Attend la fin des exécuteurs lancés en arrière-plan (tests, arrêt propre). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  // =========================================================================
  // Lancement
  // =========================================================================

  async startInstance(input: WfStartInstanceInput): Promise<WfStartInstanceResult> {
    const definitionId = requirePositiveInt(input.definitionId, 'définition');
    const startedBy = requirePositiveInt(input.startedBy, 'lanceur');
    const contextInput = input.context ?? {};
    if (!isPlainObject(contextInput)) {
      throw new WfEngineError('INVALID_INPUT', "Les données d'entrée doivent être un objet.");
    }
    if (jsonByteLength(contextInput) > WF_CONTEXT_INPUT_MAX_BYTES) {
      throw new WfEngineError('INVALID_INPUT', `Les données d'entrée dépassent ${WF_CONTEXT_INPUT_MAX_BYTES} octets.`);
    }
    const subject = parseSubject(input.subjectType, input.subjectId);
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    const triggerId = input.triggerId == null ? null : requirePositiveInt(input.triggerId, 'déclencheur');
    if (input.dueAt != null && (!(input.dueAt instanceof Date) || Number.isNaN(input.dueAt.getTime()))) {
      throw new WfEngineError('INVALID_INPUT', "L'échéance de l'instance est invalide.");
    }

    if (idempotencyKey !== null) {
      const existing = await this.findByIdempotencyKey(definitionId, idempotencyKey);
      if (existing) return this.idempotentReplay(existing, startedBy);
    }

    let run: Run;
    try {
      run = await this.transact(async (tx) => {
        const now = this.clock();
        const definition = await tx.wfDefinition.findUnique({
          where: { wfDefinitionId: definitionId },
          select: { name: true, status: true },
        });
        const version =
          definition && definition.status === 1
            ? await tx.wfDefinitionVersion.findFirst({
                where: { definitionId, status: 1 },
                select: { wfDefinitionVersionId: true, graph: true },
              })
            : null;
        if (!definition || !version) {
          throw new WfEngineError(
            'DEFINITION_NOT_PUBLISHED',
            "Ce workflow n'a pas de version publiée (ou il est archivé) : lancement impossible.",
          );
        }
        const graph = this.parseGraph(version.wfDefinitionVersionId, version.graph);
        const context = initialContext(contextInput);
        const row = await tx.wfInstance.create({
          data: {
            definitionId,
            definitionVersionId: version.wfDefinitionVersionId,
            status: WfInstanceStatus.Running,
            context: toJson(context),
            startedBy,
            triggerId,
            subjectType: subject?.type ?? null,
            subjectId: subject?.id ?? null,
            idempotencyKey,
            dueAt: input.dueAt ?? null,
            rowVersion: 0,
            startedAt: now,
            updatedAt: now,
          },
        });
        const r = this.newRun(tx, now, row, graph, definition.name, 0);
        await this.log(r, {
          type: 'instance.started',
          actor: triggerId !== null ? SYSTEM : { kind: 'user', userGroupId: startedBy },
          decision: {
            definitionVersionId: version.wfDefinitionVersionId,
            triggerId,
            runAs: startedBy,
            subjectType: subject?.type ?? null,
            subjectId: subject ? subject.id.toString() : null,
          },
        });
        r.events.push({
          type: 'instance.started',
          instanceId: row.wfInstanceId.toString(),
          startedBy,
          title: definition.name,
          message: `Le workflow « ${definition.name} » a démarré.`,
        });
        await this.enterStep(r, graph.start);
        r.row = await this.finalize(r);
        return r;
      });
    } catch (err) {
      // Course : deux lancements simultanés avec la même clé — le second viole l'unique partiel.
      if (idempotencyKey !== null && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(definitionId, idempotencyKey);
        if (existing) return this.idempotentReplay(existing, startedBy);
      }
      throw err;
    }
    this.afterCommit(run, false);
    return { ...this.toResult(run), created: true };
  }

  private findByIdempotencyKey(definitionId: number, key: string): Promise<WfInstance | null> {
    return this.prisma.wfInstance.findFirst({ where: { definitionId, idempotencyKey: key } });
  }

  /** Rejeu d'une clé : même lanceur => l'instance existante, sans aucune écriture ; sinon refus muet. */
  private idempotentReplay(existing: WfInstance, startedBy: number): WfStartInstanceResult {
    if (existing.startedBy !== startedBy) {
      throw new WfEngineError('IDEMPOTENCY_CONFLICT', "Cette clé d'idempotence est déjà utilisée.");
    }
    return { instance: toInstanceDto(existing), closedTasks: [], openedTasks: [], events: [], created: false };
  }

  // =========================================================================
  // Lecture
  // =========================================================================

  async getInstanceDetail(instanceId: string, opts: { eventLimit?: number } = {}): Promise<WfInstanceDetail | null> {
    const id = tryParseId(instanceId);
    if (id === null) return null;
    const row = await this.prisma.wfInstance.findUnique({
      where: { wfInstanceId: id },
      include: {
        definition: { select: { name: true } },
        definitionVersion: { select: { versionNumber: true } },
      },
    });
    if (!row) return null;
    const limit = clampInt(opts.eventLimit, 1, MAX_EVENT_LIMIT, DEFAULT_EVENT_LIMIT);
    const [tasks, events, inboxItems] = await Promise.all([
      this.prisma.wfTask.findMany({ where: { instanceId: id }, orderBy: { wfTaskId: 'asc' } }),
      this.prisma.wfEventLog.findMany({
        where: { instanceId: id },
        orderBy: [{ occurredAt: 'desc' }, { wfEventLogId: 'desc' }],
        take: limit,
      }),
      this.prisma.wfInboxItem.findMany({ where: { instanceId: id }, orderBy: { wfInboxItemId: 'asc' } }),
    ]);
    return {
      instance: toInstanceDto(row),
      definitionName: row.definition.name,
      versionNumber: row.definitionVersion.versionNumber,
      tasks: tasks.map(toTaskDto),
      // Les `limit` événements les plus récents, présentés du plus ancien au plus récent.
      events: events.reverse().map(toEventDto),
      inboxItems: inboxItems.map(toInboxDto),
    };
  }

  async listInstances(filter: {
    startedBy?: number;
    definitionId?: number;
    statuses?: number[];
    limit: number;
    offset: number;
  }): Promise<{ items: WfInstanceDto[]; total: number }> {
    const where: Prisma.WfInstanceWhereInput = {};
    if (filter.startedBy !== undefined) where.startedBy = requirePositiveInt(filter.startedBy, 'lanceur');
    if (filter.definitionId !== undefined) where.definitionId = requirePositiveInt(filter.definitionId, 'définition');
    if (filter.statuses && filter.statuses.length > 0) where.status = { in: sanitizeStatuses(filter.statuses, 5) };
    const take = clampInt(filter.limit, 1, MAX_PAGE, 50);
    const skip = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const [rows, total] = await Promise.all([
      this.prisma.wfInstance.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { wfInstanceId: 'desc' }],
        take,
        skip,
      }),
      this.prisma.wfInstance.count({ where }),
    ]);
    return { items: rows.map(toInstanceDto), total };
  }

  async listInbox(principal: WfPrincipal, filter: WfInboxFilter): Promise<{ items: WfInboxEntry[]; total: number }> {
    assertPrincipal(principal);
    const statuses =
      filter.statuses && filter.statuses.length > 0 ? sanitizeStatuses(filter.statuses, 5) : [...OPEN_INBOX];
    // Bénéficiaires de l'utilisateur, et RIEN d'autre (aucun pouvoir implicite, pas même administrateur).
    const audience: Prisma.WfInboxItemWhereInput[] = [{ assigneeUserGroupId: principal.userGroupId }];
    const groupIds = [...new Set(principal.groupIds.filter(isPositiveInt))];
    if (groupIds.length > 0) audience.push({ assigneeGroupId: { in: groupIds } });
    if (principal.roleId !== null && isPositiveInt(principal.roleId)) audience.push({ assigneeRoleId: principal.roleId });
    const where: Prisma.WfInboxItemWhereInput = { status: { in: statuses }, OR: audience };
    const take = clampInt(filter.limit, 1, MAX_PAGE, 50);
    const skip = clampInt(filter.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const [rows, total] = await Promise.all([
      this.prisma.wfInboxItem.findMany({
        where,
        include: {
          task: {
            select: {
              wfTaskId: true,
              stepKey: true,
              taskType: true,
              status: true,
              attempt: true,
              dueAt: true,
              instructions: true,
            },
          },
          instance: { select: { status: true, definition: { select: { name: true } } } },
        },
        orderBy: [
          { priority: 'desc' },
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
          { wfInboxItemId: 'asc' },
        ],
        take,
        skip,
      }),
      this.prisma.wfInboxItem.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        item: toInboxDto(r),
        task: {
          wfTaskId: r.task.wfTaskId.toString(),
          stepKey: r.task.stepKey,
          taskType: r.task.taskType as WfTaskDto['taskType'],
          status: r.task.status as WfTaskStatusValue,
          attempt: r.task.attempt,
          dueAt: iso(r.task.dueAt),
          instructions: r.task.instructions,
        },
        definitionName: r.instance.definition.name,
        instanceStatus: r.instance.status as WfInstanceStatusValue,
      })),
      total,
    };
  }

  // =========================================================================
  // Actions sur une tâche (bénéficiaire uniquement)
  // =========================================================================

  async claimTask(input: { taskId: string; principal: WfPrincipal }): Promise<WfTransitionResult> {
    return this.taskTransition(input.taskId, input.principal, undefined, async (run, scope) => {
      const actorId = input.principal.userGroupId;
      if (scope.claimedBy === actorId) return; // déjà prise par l'acteur : rien à écrire
      const { task } = scope;
      await run.tx.wfTask.update({
        where: { wfTaskId: task.wfTaskId },
        data: { status: WfTaskStatus.InProgress, startedAt: task.startedAt ?? run.now },
      });
      await run.tx.wfInboxItem.updateMany({
        where: { taskId: task.wfTaskId, status: { in: [...OPEN_INBOX] } },
        data: { status: WfInboxItemStatus.Claimed, claimedBy: actorId, claimedAt: run.now },
      });
      await this.log(run, {
        type: 'task.claimed',
        actor: { kind: 'user', userGroupId: actorId },
        taskId: task.wfTaskId,
        stepKey: task.stepKey,
      });
    });
  }

  async completeTask(input: {
    taskId: string;
    principal: WfPrincipal;
    result: unknown;
    expectedRowVersion?: number;
  }): Promise<WfTransitionResult> {
    return this.taskTransition(input.taskId, input.principal, input.expectedRowVersion, async (run, scope) => {
      const validation = validateTaskResult(scope.step, input.result);
      if (!validation.ok) {
        throw new WfEngineError(
          'INVALID_INPUT',
          `Résultat refusé pour l'étape « ${scope.step.name} » : ${validation.issues.join(' ; ')}.`,
          { issues: validation.issues },
        );
      }
      if (scope.step.type === 'affectation') {
        const target = assignmentFromResult(validation.value);
        if (target?.userGroupId != null && this.directory && !(await this.directory.isUserGroupActive(target.userGroupId))) {
          throw new WfEngineError('INVALID_INPUT', "La personne désignée est introuvable ou son compte est désactivé.");
        }
      }
      await this.closeTaskAndAdvance(run, scope, {
        result: validation.value,
        actor: { kind: 'user', userGroupId: input.principal.userGroupId },
        mode: 'normal',
      });
    });
  }

  async rejectTask(input: { taskId: string; principal: WfPrincipal; comment?: string }): Promise<WfTransitionResult> {
    return this.taskTransition(input.taskId, input.principal, undefined, async (run, scope) => {
      const result = buildRejectionResult(typeof input.comment === 'string' ? input.comment : undefined);
      await this.closeTaskAndAdvance(run, scope, {
        result,
        actor: { kind: 'user', userGroupId: input.principal.userGroupId },
        mode: 'rejected',
        comment: typeof result.comment === 'string' ? result.comment : undefined,
      });
    });
  }

  async delegateTask(input: {
    taskId: string;
    principal: WfPrincipal;
    toUserGroupId: number;
    comment?: string;
  }): Promise<WfTransitionResult> {
    return this.taskTransition(input.taskId, input.principal, undefined, async (run, scope) => {
      const to = input.toUserGroupId;
      if (!isPositiveInt(to)) throw new WfEngineError('INVALID_INPUT', 'Destinataire de la délégation invalide.');
      const { task } = scope;
      if (task.assigneeUserGroupId === to) {
        throw new WfEngineError('INVALID_INPUT', 'La tâche est déjà affectée à cette personne.');
      }
      if (this.directory && !(await this.directory.isUserGroupActive(to))) {
        throw new WfEngineError('INVALID_INPUT', 'Le destinataire de la délégation est introuvable ou son compte est désactivé.');
      }
      const comment = typeof input.comment === 'string' && input.comment.trim() ? truncateText(input.comment.trim(), WF_COMMENT_MAX) : null;
      await run.tx.wfTask.update({
        where: { wfTaskId: task.wfTaskId },
        data: { assigneeUserGroupId: to, assigneeGroupId: null, assigneeRoleId: null, status: WfTaskStatus.Todo },
      });
      await run.tx.wfInboxItem.updateMany({
        where: { taskId: task.wfTaskId, status: { in: [...OPEN_INBOX] } },
        data: {
          assigneeUserGroupId: to,
          assigneeGroupId: null,
          assigneeRoleId: null,
          status: WfInboxItemStatus.Open,
          claimedBy: null,
          claimedAt: null,
        },
      });
      await this.log(run, {
        type: 'task.delegated',
        actor: { kind: 'user', userGroupId: input.principal.userGroupId },
        taskId: task.wfTaskId,
        stepKey: task.stepKey,
        decision: {
          from: {
            userGroupId: task.assigneeUserGroupId,
            groupId: task.assigneeGroupId,
            roleId: task.assigneeRoleId,
          },
          to: { userGroupId: to },
        },
        explanation: comment,
      });
      run.events.push({
        type: 'task.delegated',
        instanceId: run.instanceId.toString(),
        taskId: task.wfTaskId.toString(),
        inboxItemId: scope.items[0]?.wfInboxItemId.toString(),
        stepKey: task.stepKey,
        assignee: { userGroupId: to },
        startedBy: run.row.startedBy,
        title: task.title,
        message: `Une tâche vous a été déléguée : « ${task.title} » (workflow « ${run.definitionName} »).`,
      });
    });
  }

  /**
   * Prélude commun : tâche -> instance (identifiant immuable), VERROU de l'instance, relecture de la tâche
   * sous verrou, droit d'agir, état de l'instance, version attendue, état de la tâche, prise en charge.
   */
  private async taskTransition(
    taskIdRaw: string,
    principal: WfPrincipal,
    expectedRowVersion: number | undefined,
    body: (run: Run, scope: TaskScope) => Promise<void>,
  ): Promise<WfTransitionResult> {
    assertPrincipal(principal);
    const taskId = parseId(taskIdRaw, 'Tâche');
    if (expectedRowVersion !== undefined && !(Number.isInteger(expectedRowVersion) && expectedRowVersion >= 0)) {
      throw new WfEngineError('INVALID_INPUT', 'Version attendue invalide.');
    }
    const ref = await this.prisma.wfTask.findUnique({ where: { wfTaskId: taskId }, select: { instanceId: true } });
    if (!ref) throw new WfEngineError('NOT_FOUND', 'Tâche introuvable.');

    const run = await this.transact(async (tx) => {
      const r = await this.lockRun(tx, ref.instanceId);
      const task = await tx.wfTask.findUnique({ where: { wfTaskId: taskId } });
      if (!task) throw new WfEngineError('NOT_FOUND', 'Tâche introuvable.');
      if (!isTaskAssignee(principal, task)) {
        throw new WfEngineError('FORBIDDEN', "Vous n'êtes pas le bénéficiaire de cette tâche.");
      }
      this.assertActive(r);
      if (expectedRowVersion !== undefined && expectedRowVersion !== r.lockedRowVersion) {
        throw new WfEngineError('CONFLICT', "L'instance a été modifiée entre-temps : recharger puis réessayer.");
      }
      if (task.status === WfTaskStatus.Done) {
        throw new WfEngineError('CONFLICT', 'Cette tâche a déjà été traitée.');
      }
      if (!OPEN_TASK.includes(task.status)) {
        throw new WfEngineError('INVALID_STATE', "Cette tâche n'est plus ouverte.");
      }
      const step = findStep(r.graph.steps, task.stepKey);
      if (!step) throw new WfEngineError('INVALID_STATE', "L'étape de cette tâche n'existe pas dans la version du workflow.");
      const items = await tx.wfInboxItem.findMany({
        where: { taskId, status: { in: [...OPEN_INBOX] } },
        orderBy: { wfInboxItemId: 'asc' },
      });
      const claimedBy = items.find((i) => i.claimedBy !== null)?.claimedBy ?? null;
      if (claimedBy !== null && claimedBy !== principal.userGroupId) {
        throw new WfEngineError('CONFLICT', 'Cette tâche est déjà prise en charge par une autre personne.');
      }
      await body(r, { task, step, items, claimedBy });
      if (r.dirty) r.row = await this.finalize(r);
      return r;
    });
    this.afterCommit(run, false);
    return this.toResult(run);
  }

  // =========================================================================
  // Cycle de vie de l'instance (droits vérifiés par la couche service)
  // =========================================================================

  async cancelInstance(input: { instanceId: string; actor: WfActorRef; reason?: string }): Promise<WfTransitionResult> {
    const actor = assertActor(input.actor);
    const reason = cleanReason(input.reason);
    return this.instanceTransition(input.instanceId, async (run) => {
      if (isTerminal(run.status)) {
        throw new WfEngineError('INVALID_STATE', "L'instance est déjà terminée, échouée ou annulée.");
      }
      await this.closeOpenWork(run, actor, 'annulation');
      run.status = WfInstanceStatus.Cancelled;
      run.finishedAt = run.now;
      await this.log(run, { type: 'instance.cancelled', actor, decision: { reason } });
      run.events.push(this.instanceEvent(run, 'instance.cancelled', `Le workflow « ${run.definitionName} » a été annulé.`));
    });
  }

  async suspendInstance(input: { instanceId: string; actor: WfActorRef; reason?: string }): Promise<WfTransitionResult> {
    const actor = assertActor(input.actor);
    const reason = cleanReason(input.reason) ?? 'Suspension manuelle.';
    return this.instanceTransition(input.instanceId, async (run) => {
      if (!ACTIVE_INSTANCE.includes(run.status)) {
        throw new WfEngineError('INVALID_STATE', 'Seule une instance en cours ou en attente peut être suspendue.');
      }
      await this.suspendRun(run, actor, reason);
    });
  }

  async resumeInstance(input: { instanceId: string; actor: WfActorRef }): Promise<WfTransitionResult> {
    const actor = assertActor(input.actor);
    return this.instanceTransition(input.instanceId, async (run) => {
      if (run.status !== WfInstanceStatus.Suspended) {
        throw new WfEngineError('INVALID_STATE', "Seule une instance suspendue peut être reprise.");
      }
      const { tx, instanceId } = run;
      const suspended = await tx.wfEventLog.findFirst({
        where: { instanceId, eventType: 'instance.suspended' },
        orderBy: [{ occurredAt: 'desc' }, { wfEventLogId: 'desc' }],
        select: { occurredAt: true },
      });
      const pausedSeconds = suspended
        ? Math.max(0, Math.round((run.now.getTime() - suspended.occurredAt.getTime()) / 1000))
        : 0;
      if (pausedSeconds > 0) {
        // Les échéances et minuteries ne courent pas pendant la suspension : on les décale d'autant.
        await tx.$executeRaw`UPDATE "wf_timer" SET "fire_at" = "fire_at" + make_interval(secs => CAST(${pausedSeconds} AS double precision))
          WHERE "instance_id" = ${instanceId} AND "status" = 0`;
        await tx.$executeRaw`UPDATE "wf_task" SET "due_at" = "due_at" + make_interval(secs => CAST(${pausedSeconds} AS double precision)), "updated_at" = ${run.now}
          WHERE "instance_id" = ${instanceId} AND "status" IN (0, 1) AND "due_at" IS NOT NULL`;
        await tx.$executeRaw`UPDATE "wf_inbox_item" SET "due_at" = "due_at" + make_interval(secs => CAST(${pausedSeconds} AS double precision)), "updated_at" = ${run.now}
          WHERE "instance_id" = ${instanceId} AND "status" IN (0, 1) AND "due_at" IS NOT NULL`;
      }
      const open = await tx.wfTask.findMany({
        where: { instanceId, status: { in: [...OPEN_TASK] } },
        orderBy: { wfTaskId: 'asc' },
      });
      await this.log(run, { type: 'instance.resumed', actor, decision: { pausedSeconds, openTasks: open.length } });
      run.events.push(this.instanceEvent(run, 'instance.resumed', `Le workflow « ${run.definitionName} » a repris.`));
      run.status = WfInstanceStatus.Running;
      if (open.length > 0) {
        const openItems = await tx.wfInboxItem.count({ where: { instanceId, status: { in: [...OPEN_INBOX] } } });
        const human = openItems > 0 || open.some((t) => t.taskType !== WfTaskType.Agent);
        run.status = human ? WfInstanceStatus.Waiting : WfInstanceStatus.Running;
        for (const t of open) {
          if (await this.isExecutorEligible(tx, t)) run.executorJobs.push(t.wfTaskId);
        }
        return;
      }
      // Aucune tâche ouverte (suspendue après expiration ou refus sans voie) : on rouvre la dernière étape.
      const last = await tx.wfTask.findFirst({ where: { instanceId }, orderBy: { wfTaskId: 'desc' } });
      await this.enterStep(run, last ? last.stepKey : run.graph.start);
    });
  }

  private async instanceTransition(instanceIdRaw: string, body: (run: Run) => Promise<void>): Promise<WfTransitionResult> {
    const instanceId = parseId(instanceIdRaw, 'Instance');
    const run = await this.transact(async (tx) => {
      const r = await this.lockRun(tx, instanceId);
      await body(r);
      if (r.dirty) r.row = await this.finalize(r);
      return r;
    });
    this.afterCommit(run, false);
    return this.toResult(run);
  }

  // =========================================================================
  // Exécuteurs (après commit, hors transaction)
  // =========================================================================

  async rescanExecutors(): Promise<number> {
    const registry = this.registry;
    if (!registry) return 0;
    const types = WF_TASK_TYPE_KEYS.filter((k) => registry.has(k)).map((k) => wfTaskTypeFromKey(k));
    if (types.length === 0) return 0;
    const tasks = await this.prisma.wfTask.findMany({
      where: {
        status: { in: [...OPEN_TASK] },
        taskType: { in: types },
        instance: { status: { in: [...ACTIVE_INSTANCE] } },
      },
      orderBy: { wfTaskId: 'asc' },
      take: 1000,
    });
    let count = 0;
    for (const task of tasks) {
      if (await this.isExecutorEligible(this.prisma, task)) {
        this.dispatchExecutor(task.wfTaskId);
        count++;
      }
    }
    return count;
  }

  /**
   * Une tâche ouverte relève de son exécuteur tant qu'aucune proposition n'attend un humain et, pour une
   * étape agent, tant qu'un humain n'a pas pris le relais (élément de boîte kind 0 ouvert).
   */
  private async isExecutorEligible(db: Db, task: WfTask): Promise<boolean> {
    if (!this.registry || !OPEN_TASK.includes(task.status) || !isWfTaskType(task.taskType)) return false;
    if (!this.registry.has(wfTaskTypeToKey(task.taskType))) return false;
    const items = await db.wfInboxItem.findMany({
      where: { taskId: task.wfTaskId, status: { in: [...OPEN_INBOX] } },
      select: { kind: true },
    });
    if (items.some((i) => i.kind === WfInboxItemKind.AgentValidation)) return false;
    if (task.taskType === WfTaskType.Agent && items.some((i) => i.kind === WfInboxItemKind.HumanTask)) return false;
    return true;
  }

  private dispatchExecutor(taskId: bigint): void {
    const job = this.runExecutor(taskId).catch((err: unknown) =>
      this.reportBackgroundError(err, { taskId: taskId.toString(), stage: 'executor' }),
    );
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }

  private async runExecutor(taskId: bigint): Promise<void> {
    const task = await this.prisma.wfTask.findUnique({ where: { wfTaskId: taskId }, include: { instance: true } });
    if (!task || !OPEN_TASK.includes(task.status) || !ACTIVE_INSTANCE.includes(task.instance.status)) return;
    if (!isWfTaskType(task.taskType)) return;
    const typeKey = wfTaskTypeToKey(task.taskType);
    const executor = this.registry?.get(typeKey);
    if (!executor) return;
    const version = await this.prisma.wfDefinitionVersion.findUnique({
      where: { wfDefinitionVersionId: task.instance.definitionVersionId },
      select: { graph: true },
    });
    if (!version) return;
    const step = findStep(this.parseGraph(task.instance.definitionVersionId, version.graph).steps, task.stepKey);
    if (!step) return;

    let outcome: InternalOutcome;
    try {
      const raw = await executor.execute({
        instanceId: task.instanceId.toString(),
        taskId: task.wfTaskId.toString(),
        attempt: task.attempt,
        step: structuredClone(step),
        context: structuredClone(normalizeContext(task.instance.context)) as unknown as Record<string, unknown>,
        runAs: { userGroupId: task.instance.startedBy },
        definitionId: task.instance.definitionId,
        definitionVersionId: task.instance.definitionVersionId,
        subject: {
          type: task.instance.subjectType ?? null,
          id: task.instance.subjectId === null ? null : task.instance.subjectId.toString(),
        },
      });
      outcome = normalizeOutcome(raw);
    } catch (err) {
      outcome = { kind: 'error', message: `l'exécuteur a levé une erreur : ${errorText(err)}` };
    }

    const run = await this.transact((tx) => this.applyExecutorOutcome(tx, task.wfTaskId, task.attempt, typeKey, outcome));
    if (run) this.afterCommit(run, true);
  }

  /** Applique le résultat d'un exécuteur sous verrou ; null si la tâche n'est plus concernée (rien écrit). */
  private async applyExecutorOutcome(
    tx: Tx,
    taskId: bigint,
    attempt: number,
    typeKey: WfTaskTypeKey,
    outcome: InternalOutcome,
  ): Promise<Run | null> {
    const ref = await tx.wfTask.findUnique({ where: { wfTaskId: taskId }, select: { instanceId: true } });
    if (!ref) return null;
    const run = await this.lockRun(tx, ref.instanceId);
    const task = await tx.wfTask.findUnique({ where: { wfTaskId: taskId } });
    if (!task || task.attempt !== attempt || !OPEN_TASK.includes(task.status) || !ACTIVE_INSTANCE.includes(run.status)) {
      return null;
    }
    const step = findStep(run.graph.steps, task.stepKey);
    if (!step) return null;
    const items = await tx.wfInboxItem.findMany({
      where: { taskId, status: { in: [...OPEN_INBOX] } },
      orderBy: { wfInboxItemId: 'asc' },
    });
    // Étape agent déjà reprise par un humain (élément kind 0 ouvert) : la réponse tardive de l'agent est ignorée.
    if (typeKey === 'agent' && items.some((i) => i.kind === WfInboxItemKind.HumanTask)) return null;
    const scope: TaskScope = { task, step, items, claimedBy: items.find((i) => i.claimedBy !== null)?.claimedBy ?? null };

    let effective: InternalOutcome = outcome;
    // Pour un type HUMAIN, un exécuteur ne fait que suggérer : « complete » devient une proposition.
    if (effective.kind === 'complete' && typeKey !== 'agent') {
      effective = {
        kind: 'propose',
        proposal: effective.result,
        explanation: effective.explanation,
        audit: effective.audit,
      };
    }
    if (effective.kind === 'complete') {
      const validation = validateTaskResult(step, effective.result);
      if (!validation.ok) {
        effective = { kind: 'error', message: `résultat de l'agent refusé : ${validation.issues.join(' ; ')}` };
      } else {
        // « Rien d'appliqué sans événement journalisé » : l'acte de l'agent est inscrit AVANT la clôture,
        // dans la même transaction.
        await this.log(run, {
          type: 'agent.acted',
          actor: AGENT,
          taskId,
          stepKey: task.stepKey,
          ...auditFields(effective.audit),
          decision:
            effective.audit?.decision !== undefined
              ? effective.audit.decision
              : summarizeResultForLog(typeKey, validation.value),
          explanation: effective.explanation ? truncateText(effective.explanation, WF_LOG_INSTRUCTION_MAX) : null,
        });
        await this.closeTaskAndAdvance(run, scope, {
          result: validation.value,
          actor: AGENT,
          mode: 'normal',
          explanation: effective.explanation,
        });
      }
    }
    if (effective.kind === 'propose' && jsonByteLength(effective.proposal ?? null) > WF_RESULT_MAX_BYTES) {
      effective = { kind: 'error', message: `proposition trop volumineuse (plus de ${WF_RESULT_MAX_BYTES} octets)` };
    }
    switch (effective.kind) {
      case 'complete':
        break;
      case 'wait':
        if (typeKey === 'agent') {
          if (effective.escalation) {
            await this.log(run, {
              type: 'agent.escalated',
              actor: AGENT,
              taskId,
              stepKey: task.stepKey,
              ...auditFields(effective.escalation.audit),
              // Le détail de l'audit (suspicion_injection, raisons, outil refusé, appels d'outils) est conservé ; `reason` fait foi.
              decision: {
                ...(isPlainObject(effective.escalation.audit?.decision) ? effective.escalation.audit.decision : {}),
                reason: truncateText(effective.escalation.reason, REASON_MAX),
              },
              explanation: truncateText(effective.escalation.explanation, WF_LOG_INSTRUCTION_MAX),
            });
          }
          await this.handToHuman(run, scope, "L'agent n'a pas conclu : tâche confiée à son bénéficiaire.");
        }
        break;
      case 'error':
        await this.log(run, {
          type: 'executor.error',
          actor: SYSTEM,
          taskId,
          stepKey: task.stepKey,
          explanation: truncateText(effective.message, REASON_MAX),
        });
        if (typeKey === 'agent') await this.handToHuman(run, scope, "L'agent a échoué : tâche confiée à son bénéficiaire.");
        break;
      case 'propose':
        await this.recordProposal(run, scope, typeKey, effective);
        break;
      case 'fail': {
        const message = truncateText(effective.error || 'échec sans précision', REASON_MAX);
        const failed = await tx.wfTask.update({ where: { wfTaskId: taskId }, data: { status: WfTaskStatus.Failed } });
        run.closedTasks.push(failed);
        await this.log(run, { type: 'task.failed', actor: AGENT, taskId, stepKey: task.stepKey, explanation: message });
        await this.failInstance(run, `Échec de l'étape « ${step.name} » : ${message}`);
        break;
      }
    }
    if (!run.dirty) return null;
    run.row = await this.finalize(run);
    return run;
  }

  /** Proposition d'un exécuteur : élément de boîte kind 1 (jamais appliquée seule). */
  private async recordProposal(
    run: Run,
    scope: TaskScope,
    typeKey: WfTaskTypeKey,
    outcome: Extract<WfExecutorOutcome, { kind: 'propose' }>,
  ): Promise<void> {
    const { task } = scope;
    if (scope.items.some((i) => i.kind === WfInboxItemKind.AgentValidation)) return; // une proposition attend déjà
    const explanation =
      typeof outcome.explanation === 'string' && outcome.explanation.trim()
        ? truncateText(outcome.explanation.trim(), WF_LOG_INSTRUCTION_MAX)
        : "Aucune explication fournie par l'exécuteur : vérifier la proposition avant de l'accepter.";
    const audit = outcome.audit;
    const confidence = normalizeConfidence(outcome.confidence ?? audit?.confidence);
    const rawSources = outcome.sources !== undefined ? outcome.sources : audit?.sources;
    const sources = rawSources === undefined ? null : boundJson(rawSources);
    const proposal = toJson(outcome.proposal ?? null);
    const eventId = await this.log(run, {
      type: 'agent.proposed',
      actor: AGENT,
      taskId: task.wfTaskId,
      stepKey: task.stepKey,
      ...auditFields(audit),
      decision: audit?.decision !== undefined ? audit.decision : summarizeResultForLog(typeKey, outcome.proposal),
      explanation,
      sources,
      confidence,
    });
    const item = await run.tx.wfInboxItem.create({
      data: {
        taskId: task.wfTaskId,
        instanceId: run.instanceId,
        kind: WfInboxItemKind.AgentValidation,
        status: WfInboxItemStatus.Open,
        priority: task.priority,
        title: truncateText(`Proposition à valider : ${task.title}`, WF_TITLE_MAX),
        summary: task.instructions ? truncateText(task.instructions, WF_INBOX_SUMMARY_MAX) : null,
        proposal,
        explanation,
        sources: sources === null ? undefined : toJson(sources),
        confidence: confidence === null ? null : new Prisma.Decimal(confidence.toFixed(3)),
        agentEventId: eventId,
        assigneeUserGroupId: task.assigneeUserGroupId,
        assigneeGroupId: task.assigneeGroupId,
        assigneeRoleId: task.assigneeRoleId,
        dueAt: task.dueAt,
        createdAt: run.now,
        updatedAt: run.now,
      },
    });
    if (typeKey === 'generation') {
      const previous = isPlainObject(task.input) ? task.input : {};
      await run.tx.wfTask.update({
        where: { wfTaskId: task.wfTaskId },
        data: { input: toJson({ ...previous, suggestion: outcome.proposal ?? null }) },
      });
    }
    run.status = WfInstanceStatus.Waiting;
    run.events.push({
      type: 'task.assigned',
      instanceId: run.instanceId.toString(),
      taskId: task.wfTaskId.toString(),
      inboxItemId: item.wfInboxItemId.toString(),
      stepKey: task.stepKey,
      assignee: assigneeRefOf(task),
      startedBy: run.row.startedBy,
      title: item.title,
      message: `Une proposition attend votre validation : « ${task.title} » (workflow « ${run.definitionName} »).`,
    });
  }

  /** Étape agent sans conclusion : la tâche passe à son bénéficiaire humain (élément de boîte kind 0). */
  private async handToHuman(run: Run, scope: TaskScope, explanation: string): Promise<void> {
    if (scope.items.some((i) => i.kind === WfInboxItemKind.HumanTask)) return;
    const step = scope.step;
    const item = await this.createInboxItem(run, scope.task, step);
    await this.log(run, {
      type: 'task.assigned',
      actor: SYSTEM,
      taskId: scope.task.wfTaskId,
      stepKey: scope.task.stepKey,
      decision: { assignee: assigneeRefOf(scope.task), source: 'agent_fallback' },
      explanation,
    });
    run.status = WfInstanceStatus.Waiting;
    run.events.push(this.assignedEvent(run, scope.task, item));
  }

  // =========================================================================
  // Cœur : clôture d'une tâche, routage, entrée dans une étape
  // =========================================================================

  private async closeTaskAndAdvance(
    run: Run,
    scope: TaskScope,
    args: {
      result: Record<string, unknown>;
      actor: WfActorRef;
      mode: 'normal' | 'rejected';
      comment?: string;
      explanation?: string;
    },
  ): Promise<void> {
    const { tx, now } = run;
    const { task, step, items } = scope;
    const rejected = args.mode === 'rejected';
    const userId = args.actor.kind === 'user' ? (args.actor.userGroupId ?? null) : null;

    const closed = await tx.wfTask.update({
      where: { wfTaskId: task.wfTaskId },
      data: {
        status: WfTaskStatus.Done,
        result: toJson(args.result),
        completedAt: now,
        completedBy: userId,
        startedAt: task.startedAt ?? now,
      },
    });
    for (const item of items) {
      let resolution: Record<string, unknown> | null = null;
      if (rejected) resolution = { outcome: 'rejected' };
      else if (item.kind === WfInboxItemKind.AgentValidation) {
        resolution = { outcome: canonicalJson(item.proposal) === canonicalJson(args.result) ? 'accepted' : 'modified' };
      }
      await tx.wfInboxItem.update({
        where: { wfInboxItemId: item.wfInboxItemId },
        data: {
          status: rejected ? WfInboxItemStatus.Rejected : WfInboxItemStatus.Done,
          resolvedBy: userId,
          resolvedAt: now,
          resolution: resolution === null ? undefined : toJson(resolution),
          resolutionComment: args.comment ?? null,
        },
      });
    }
    await this.cancelStepTimers(run, step.key);

    const assignedTo = !rejected && step.type === 'affectation' ? assignmentFromResult(args.result) : null;
    run.context = applyStepResult(run.context, step.key, args.result, assignedTo ? { assignedTo } : {});
    run.status = WfInstanceStatus.Running;
    const choice = chooseNextEdge(step, run.context, args.mode);

    await this.log(run, {
      type: rejected ? 'task.rejected' : 'task.completed',
      actor: args.actor,
      taskId: task.wfTaskId,
      stepKey: step.key,
      instruction: step.description ?? null,
      decision: {
        result: summarizeResultForLog(step.type, args.result),
        next: choice.kind === 'edge' ? choice.edge.to : null,
        matchedCondition: choice.kind === 'edge' ? choice.matchedCondition : false,
      },
      explanation: args.explanation ? truncateText(args.explanation, WF_LOG_INSTRUCTION_MAX) : null,
    });
    if (step.type === 'validation') {
      const approved = !rejected && args.result.approved === true;
      await this.log(run, {
        type: approved ? 'validation.accepted' : 'validation.rejected',
        actor: args.actor,
        taskId: task.wfTaskId,
        stepKey: step.key,
        decision: { approved },
        validatedBy: userId,
        validatedAt: userId !== null ? now : null,
      });
    }
    // Validation humaine d'une proposition d'agent (élément kind 1) : accepter / modifier / refuser est
    // journalisé dans la même transaction. Les étapes de type validation ont déjà leur événement ci-dessus.
    if (userId !== null && step.type !== 'validation') {
      for (const item of items) {
        if (item.kind !== WfInboxItemKind.AgentValidation) continue;
        const outcome = rejected
          ? 'rejected'
          : canonicalJson(item.proposal) === canonicalJson(args.result)
            ? 'accepted'
            : 'modified';
        await this.log(run, {
          type: `validation.${outcome}`,
          actor: args.actor,
          taskId: task.wfTaskId,
          stepKey: step.key,
          decision: { outcome, itemId: item.wfInboxItemId.toString() },
          explanation: rejected && args.comment ? truncateText(args.comment, WF_LOG_INSTRUCTION_MAX) : null,
          confidence: item.confidence === null ? null : normalizeConfidence(Number(item.confidence)),
          validatedBy: userId,
          validatedAt: now,
        });
      }
    }
    run.closedTasks.push(closed);
    run.events.push({
      type: rejected ? 'task.rejected' : 'task.completed',
      instanceId: run.instanceId.toString(),
      taskId: task.wfTaskId.toString(),
      stepKey: step.key,
      startedBy: run.row.startedBy,
      title: task.title,
      message: rejected
        ? `L'étape « ${step.name} » a été refusée (workflow « ${run.definitionName} »).`
        : `L'étape « ${step.name} » est terminée (workflow « ${run.definitionName} »).`,
    });

    if (choice.kind === 'terminal') {
      await this.completeInstance(run);
    } else if (choice.kind === 'none') {
      if (rejected) await this.suspendRun(run, SYSTEM, choice.reason);
      else await this.failInstance(run, choice.reason);
    } else {
      await this.enterStep(run, choice.edge.to);
    }
  }

  /**
   * Entre dans une étape : crée sa tâche (ou l'évalue si décision automatique, puis enchaîne), ses
   * éléments de boîte et ses minuteries. Ne lève pas sur une erreur métier : l'instance passe « échouée »
   * dans la même transaction (le journal garde la raison).
   */
  private async enterStep(run: Run, firstStepKey: string): Promise<void> {
    const { tx } = run;
    let stepKey = firstStepKey;
    for (;;) {
      const step = findStep(run.graph.steps, stepKey);
      if (!step) {
        await this.failInstance(run, `Étape « ${stepKey} » introuvable dans la version publiée du workflow.`);
        return;
      }
      run.chain += 1;
      if (run.chain > WF_AUTO_CHAIN_LIMIT) {
        await this.failInstance(run, autoChainLimitMessage());
        return;
      }
      const agg = await tx.wfTask.aggregate({
        where: { instanceId: run.instanceId, stepKey },
        _max: { attempt: true },
      });
      const attempt = (agg._max.attempt ?? 0) + 1;
      if (!isAttemptAllowed(step, attempt)) {
        await this.failInstance(run, attemptLimitMessage(step));
        return;
      }
      await this.cancelStepTimers(run, stepKey);

      if (isAutomaticDecision(step)) {
        const next = await this.runAutomaticDecision(run, step, attempt);
        if (next === null) return;
        stepKey = next;
        continue;
      }

      if (step.type === 'agent' && !this.registry?.has('agent')) {
        const failed = await tx.wfTask.create({
          data: {
            instanceId: run.instanceId,
            stepKey,
            taskType: WfTaskType.Agent,
            status: WfTaskStatus.Failed,
            title: truncateText(step.name, WF_TITLE_MAX),
            instructions: step.description?.trim() || null,
            priority: resolvePriority(step),
            attempt,
            createdAt: run.now,
            updatedAt: run.now,
          },
        });
        const message = `L'étape agent « ${step.name} » ne peut pas s'exécuter : aucun exécuteur « agent » n'est enregistré.`;
        await this.log(run, { type: 'task.created', actor: SYSTEM, taskId: failed.wfTaskId, stepKey, decision: { taskType: 'agent', attempt } });
        await this.log(run, { type: 'task.failed', actor: SYSTEM, taskId: failed.wfTaskId, stepKey, explanation: message });
        run.closedTasks.push(failed);
        await this.failInstance(run, message);
        return;
      }

      await this.openTask(run, step, attempt);
      return;
    }
  }

  /** Décision automatique : tâche déjà terminée (traçabilité) ; renvoie l'étape suivante ou null (fin / échec). */
  private async runAutomaticDecision(run: Run, step: WfStep, attempt: number): Promise<string | null> {
    const choice = chooseNextEdge(step, run.context, 'normal');
    const decision =
      choice.kind === 'edge'
        ? { chosen: choice.edge.to, edgeLabel: choice.edge.label ?? null, matchedCondition: choice.matchedCondition }
        : { chosen: null, edgeLabel: null, matchedCondition: false };
    const task = await run.tx.wfTask.create({
      data: {
        instanceId: run.instanceId,
        stepKey: step.key,
        taskType: WfTaskType.Decision,
        status: WfTaskStatus.Done,
        title: truncateText(step.name, WF_TITLE_MAX),
        instructions: step.description?.trim() || null,
        priority: resolvePriority(step),
        attempt,
        result: toJson({ decision }),
        startedAt: run.now,
        completedAt: run.now,
        completedBy: null,
        createdAt: run.now,
        updatedAt: run.now,
      },
    });
    await this.log(run, {
      type: 'task.created',
      actor: SYSTEM,
      taskId: task.wfTaskId,
      stepKey: step.key,
      decision: { taskType: 'decision', attempt, automatic: true },
    });
    await this.log(run, {
      type: 'task.completed',
      actor: SYSTEM,
      taskId: task.wfTaskId,
      stepKey: step.key,
      instruction: step.description ?? null,
      decision,
      explanation: choice.kind === 'none' ? choice.reason : null,
    });
    run.closedTasks.push(task);
    // Simple aiguillage : `last` reste le dernier résultat humain.
    run.context = applyStepResult(run.context, step.key, { decision }, { setLast: false });
    if (choice.kind === 'terminal') {
      await this.completeInstance(run);
      return null;
    }
    if (choice.kind === 'none') {
      await this.failInstance(run, choice.reason);
      return null;
    }
    return choice.edge.to;
  }

  /** Tâche humaine (ou agent avec exécuteur) : bénéficiaire jamais vide, boîte, minuteries. */
  private async openTask(run: Run, step: WfStep, attempt: number): Promise<void> {
    const { tx } = run;
    let subjectOwner: number | null = null;
    if (
      step.assignee?.kind === 'subject_owner' &&
      run.row.subjectType !== null &&
      run.row.subjectId !== null &&
      this.directory?.resolveSubjectOwner
    ) {
      try {
        subjectOwner = await this.directory.resolveSubjectOwner(run.row.subjectType, run.row.subjectId.toString());
      } catch {
        subjectOwner = null; // repli sur le lanceur, expliqué dans le journal
      }
    }
    const spec = buildTaskSpec({
      step,
      context: run.context,
      startedBy: run.row.startedBy,
      attempt,
      now: run.now,
      subjectOwner,
    });
    const task = await tx.wfTask.create({
      data: {
        instanceId: run.instanceId,
        stepKey: step.key,
        taskType: spec.taskType,
        status: WfTaskStatus.Todo,
        title: spec.title,
        instructions: spec.instructions,
        priority: spec.priority,
        assigneeUserGroupId: spec.assignee.userGroupId,
        assigneeGroupId: spec.assignee.groupId,
        assigneeRoleId: spec.assignee.roleId,
        dueAt: spec.dueAt,
        attempt,
        createdAt: run.now,
        updatedAt: run.now,
      },
    });
    await this.log(run, {
      type: 'task.created',
      actor: SYSTEM,
      taskId: task.wfTaskId,
      stepKey: step.key,
      instruction: step.description ?? null,
      decision: { taskType: spec.typeKey, attempt, dueAt: iso(spec.dueAt) },
    });
    await this.log(run, {
      type: 'task.assigned',
      actor: SYSTEM,
      taskId: task.wfTaskId,
      stepKey: step.key,
      decision: { assignee: spec.assignee, source: spec.assigneeSource },
      explanation: assigneeSourceNote(spec.assigneeSource),
    });
    if (spec.dueAt) await this.createTimer(run, task, WfTimerKind.Deadline, spec.dueAt);
    if (spec.reminderAt) await this.createTimer(run, task, WfTimerKind.Reminder, spec.reminderAt);
    run.openedTasks.push(task);
    if (spec.isHuman) {
      const item = await this.createInboxItem(run, task, step);
      run.status = WfInstanceStatus.Waiting;
      run.events.push(this.assignedEvent(run, task, item));
    } else {
      run.status = WfInstanceStatus.Running;
    }
    if (this.registry?.has(step.type)) run.executorJobs.push(task.wfTaskId);
  }

  private async createInboxItem(run: Run, task: WfTask, step: WfStep): Promise<WfInboxItem> {
    const launcher = await this.launcherLabel(run);
    return run.tx.wfInboxItem.create({
      data: {
        taskId: task.wfTaskId,
        instanceId: run.instanceId,
        kind: WfInboxItemKind.HumanTask,
        status: WfInboxItemStatus.Open,
        priority: task.priority,
        title: task.title,
        summary: task.instructions ? truncateText(task.instructions, WF_INBOX_SUMMARY_MAX) : null,
        explanation: buildInboxExplanation(step.name, run.definitionName, launcher),
        assigneeUserGroupId: task.assigneeUserGroupId,
        assigneeGroupId: task.assigneeGroupId,
        assigneeRoleId: task.assigneeRoleId,
        dueAt: task.dueAt,
        createdAt: run.now,
        updatedAt: run.now,
      },
    });
  }

  private async createTimer(run: Run, task: WfTask, kind: number, fireAt: Date): Promise<void> {
    const timer = await run.tx.wfTimer.create({
      data: {
        instanceId: run.instanceId,
        taskId: task.wfTaskId,
        stepKey: task.stepKey,
        kind,
        status: WfTimerStatus.Active,
        fireAt,
        payload: toJson({ taskId: task.wfTaskId.toString(), attempt: task.attempt }),
        createdAt: run.now,
      },
    });
    await this.log(run, {
      type: 'timer.scheduled',
      actor: SYSTEM,
      taskId: task.wfTaskId,
      stepKey: task.stepKey,
      decision: { timerId: timer.wfTimerId.toString(), kind, fireAt: fireAt.toISOString() },
    });
  }

  /** Annule les minuteries ACTIVES de l'étape (quittée, ou ré-entrée en boucle de correction). */
  private async cancelStepTimers(run: Run, stepKey: string): Promise<void> {
    const res = await run.tx.wfTimer.updateMany({
      where: { instanceId: run.instanceId, stepKey, status: WfTimerStatus.Active },
      data: { status: WfTimerStatus.Cancelled, lockedBy: null, lockedUntil: null },
    });
    if (res.count > 0) {
      await this.log(run, { type: 'timer.cancelled', actor: SYSTEM, stepKey, decision: { count: res.count } });
    }
  }

  private async completeInstance(run: Run): Promise<void> {
    await this.cancelAllTimers(run);
    run.status = WfInstanceStatus.Completed;
    run.finishedAt = run.now;
    run.errorMessage = null;
    await this.log(run, { type: 'instance.completed', actor: SYSTEM });
    run.events.push(this.instanceEvent(run, 'instance.completed', `Le workflow « ${run.definitionName} » est terminé.`));
  }

  private async failInstance(run: Run, message: string): Promise<void> {
    await this.closeOpenWork(run, SYSTEM, 'échec');
    run.status = WfInstanceStatus.Failed;
    run.finishedAt = run.now;
    run.errorMessage = truncateText(message, ERROR_MESSAGE_MAX);
    await this.log(run, { type: 'instance.failed', actor: SYSTEM, decision: { reason: run.errorMessage } });
    run.events.push(
      this.instanceEvent(run, 'instance.failed', `Le workflow « ${run.definitionName} » a échoué : ${run.errorMessage}`),
    );
  }

  /** Suspension : les tâches restent ouvertes (toute action refusée), les minuteries sont gelées. */
  private async suspendRun(run: Run, actor: WfActorRef, reason: string): Promise<void> {
    const previous = run.status;
    run.status = WfInstanceStatus.Suspended;
    await this.log(run, { type: 'instance.suspended', actor, decision: { reason, previousStatus: previous } });
    run.events.push(
      this.instanceEvent(run, 'instance.suspended', `Le workflow « ${run.definitionName} » est suspendu : ${reason}`),
    );
  }

  /** Tâches ouvertes -> annulées, boîte -> annulée, minuteries -> annulées (annulation ou échec). */
  private async closeOpenWork(run: Run, actor: WfActorRef, cause: string): Promise<void> {
    const { tx, instanceId } = run;
    const open = await tx.wfTask.findMany({ where: { instanceId, status: { in: [...OPEN_TASK] } }, orderBy: { wfTaskId: 'asc' } });
    for (const task of open) {
      const cancelled = await tx.wfTask.update({
        where: { wfTaskId: task.wfTaskId },
        data: { status: WfTaskStatus.Cancelled },
      });
      run.closedTasks.push(cancelled);
      await this.log(run, { type: 'task.cancelled', actor, taskId: task.wfTaskId, stepKey: task.stepKey, decision: { cause } });
    }
    await tx.wfInboxItem.updateMany({
      where: { instanceId, status: { in: [...OPEN_INBOX] } },
      data: { status: WfInboxItemStatus.Cancelled },
    });
    await this.cancelAllTimers(run);
  }

  private async cancelAllTimers(run: Run): Promise<void> {
    const res = await run.tx.wfTimer.updateMany({
      where: { instanceId: run.instanceId, status: WfTimerStatus.Active },
      data: { status: WfTimerStatus.Cancelled, lockedBy: null, lockedUntil: null },
    });
    if (res.count > 0) {
      await this.log(run, { type: 'timer.cancelled', actor: SYSTEM, decision: { count: res.count } });
    }
  }

  // =========================================================================
  // Verrou, journal, finalisation
  // =========================================================================

  private transact<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: this.txTimeout,
      timeout: this.txTimeout,
    });
  }

  /** `SELECT … FOR UPDATE` de l'instance, puis lecture de l'état SOUS verrou. */
  private async lockRun(tx: Tx, instanceId: bigint): Promise<Run> {
    const locked = await tx.$queryRaw<Array<{ row_version: number }>>`
      SELECT "row_version" FROM "wf_instance" WHERE "wf_instance_id" = ${instanceId} FOR UPDATE`;
    if (locked.length === 0) throw new WfEngineError('NOT_FOUND', 'Instance de workflow introuvable.');
    const row = await tx.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: instanceId } });
    const version = await tx.wfDefinitionVersion.findUniqueOrThrow({
      where: { wfDefinitionVersionId: row.definitionVersionId },
      select: { graph: true, definition: { select: { name: true } } },
    });
    const graph = this.parseGraph(row.definitionVersionId, version.graph);
    return this.newRun(tx, this.clock(), row, graph, version.definition.name, row.rowVersion);
  }

  private newRun(tx: Tx, now: Date, row: WfInstance, graph: WfGraph, definitionName: string, rowVersion: number): Run {
    return {
      tx,
      now,
      instanceId: row.wfInstanceId,
      lockedRowVersion: rowVersion,
      row,
      graph,
      definitionName,
      status: row.status as WfInstanceStatusValue,
      context: normalizeContext(row.context),
      errorMessage: row.errorMessage,
      finishedAt: row.finishedAt,
      closedTasks: [],
      openedTasks: [],
      events: [],
      executorJobs: [],
      chain: 0,
      dirty: false,
    };
  }

  /** UPDATE conditionnel sur row_version (compteur + 1) ; 0 ligne => CONFLICT (rollback complet). */
  private async finalize(run: Run): Promise<WfInstance> {
    const res = await run.tx.wfInstance.updateMany({
      where: { wfInstanceId: run.instanceId, rowVersion: run.lockedRowVersion },
      data: {
        status: run.status,
        context: toJson(run.context),
        errorMessage: run.errorMessage,
        finishedAt: run.finishedAt,
        rowVersion: { increment: 1 },
        updatedAt: run.now,
      },
    });
    if (res.count !== 1) {
      throw new WfEngineError('CONFLICT', "L'instance a été modifiée entre-temps : recharger puis réessayer.");
    }
    return run.tx.wfInstance.findUniqueOrThrow({ where: { wfInstanceId: run.instanceId } });
  }

  private assertActive(run: Run): void {
    if (run.status === WfInstanceStatus.Suspended) {
      throw new WfEngineError('INVALID_STATE', "L'instance est suspendue : aucune action n'est possible avant sa reprise.");
    }
    if (!ACTIVE_INSTANCE.includes(run.status)) {
      throw new WfEngineError('INVALID_STATE', "L'instance n'est plus active (terminée, échouée ou annulée).");
    }
  }

  private async log(run: Run, entry: LogEntry): Promise<bigint> {
    const actorKind: WfActorKindValue =
      entry.actor.kind === 'user' ? WfActorKind.User : entry.actor.kind === 'agent' ? WfActorKind.Agent : WfActorKind.System;
    const actorUserGroupId = entry.actor.userGroupId ?? null;
    if (actorKind === WfActorKind.User && actorUserGroupId === null) {
      throw new WfEngineError('INVALID_INPUT', "Un événement d'utilisateur doit nommer l'utilisateur.");
    }
    const decision = entry.decision === undefined ? null : boundJson(entry.decision);
    const sources = entry.sources === undefined || entry.sources === null ? null : boundJson(entry.sources);
    const created = await run.tx.wfEventLog.create({
      data: {
        instanceId: run.instanceId,
        taskId: entry.taskId ?? null,
        stepKey: entry.stepKey ?? null,
        eventType: entry.type,
        actorKind,
        actorUserGroupId,
        instruction: entry.instruction ? truncateText(entry.instruction, WF_LOG_INSTRUCTION_MAX) : null,
        decision: decision === null ? undefined : toJson(decision),
        sources: sources === null ? undefined : toJson(sources),
        explanation: entry.explanation ? truncateText(entry.explanation, WF_LOG_INSTRUCTION_MAX) : null,
        confidence: entry.confidence == null ? null : new Prisma.Decimal(entry.confidence.toFixed(3)),
        autonomyLevel: entry.autonomyLevel ?? null,
        model: entry.model ? truncateText(entry.model, MODEL_MAX) : null,
        aiDecisionId: entry.aiDecisionId ?? null,
        promptTokens: entry.promptTokens ?? null,
        completionTokens: entry.completionTokens ?? null,
        costAmount: entry.costAmount == null ? null : new Prisma.Decimal(entry.costAmount.toFixed(4)),
        validatedBy: entry.validatedBy ?? null,
        validatedAt: entry.validatedAt ?? null,
        occurredAt: run.now,
      },
      select: { wfEventLogId: true },
    });
    run.dirty = true;
    return created.wfEventLogId;
  }

  private async launcherLabel(run: Run): Promise<string> {
    if (run.launcherLabel === undefined) {
      let label: string | null = null;
      try {
        label = (await this.directory?.describeUserGroup?.(run.row.startedBy)) ?? null;
      } catch {
        label = null;
      }
      run.launcherLabel = label && label.trim() ? truncateText(label.trim(), 200) : `l'utilisateur n°${run.row.startedBy}`;
    }
    return run.launcherLabel;
  }

  private parseGraph(versionId: number, raw: unknown): WfGraph {
    const cached = this.graphCache.get(versionId);
    if (cached) return cached;
    const parsed = wfGraphSchema.safeParse(raw);
    if (!parsed.success) {
      throw new WfEngineError('INVALID_STATE', 'Le graphe de la version publiée est illisible.');
    }
    // Une version publiée est immuable (déclencheur SQL) : le cache ne peut pas devenir faux.
    if (this.graphCache.size > 500) this.graphCache.clear();
    this.graphCache.set(versionId, parsed.data);
    return parsed.data;
  }

  private assignedEvent(run: Run, task: WfTask, item: WfInboxItem): WfEngineEvent {
    return {
      type: 'task.assigned',
      instanceId: run.instanceId.toString(),
      taskId: task.wfTaskId.toString(),
      inboxItemId: item.wfInboxItemId.toString(),
      stepKey: task.stepKey,
      assignee: assigneeRefOf(task),
      startedBy: run.row.startedBy,
      title: task.title,
      message: `Nouvelle tâche : « ${task.title} » (workflow « ${run.definitionName} »).`,
    };
  }

  private instanceEvent(run: Run, type: WfEngineEvent['type'], message: string): WfEngineEvent {
    return {
      type,
      instanceId: run.instanceId.toString(),
      startedBy: run.row.startedBy,
      title: run.definitionName,
      message,
    };
  }

  /** Après commit : lance les exécuteurs ; publie les événements d'un traitement d'arrière-plan. */
  private afterCommit(run: Run, background: boolean): void {
    for (const taskId of run.executorJobs) this.dispatchExecutor(taskId);
    if (background && run.events.length > 0 && this.onEvents) {
      const events = run.events;
      const publish = Promise.resolve()
        .then(() => this.onEvents?.(events))
        .catch((err: unknown) => this.reportBackgroundError(err, { stage: 'events' }));
      this.pending.add(publish);
      void publish.finally(() => this.pending.delete(publish));
    }
  }

  private reportBackgroundError(error: unknown, context: { taskId?: string; stage: string }): void {
    try {
      this.onBackgroundError?.(error, context);
    } catch {
      // un rapporteur défaillant ne doit rien casser
    }
  }

  private toResult(run: Run): WfTransitionResult {
    return {
      instance: toInstanceDto(run.row),
      closedTasks: run.closedTasks.map(toTaskDto),
      openedTasks: run.openedTasks.map(toTaskDto),
      events: run.events,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation des entrées
// ---------------------------------------------------------------------------

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function requirePositiveInt(value: unknown, what: string): number {
  if (!isPositiveInt(value)) throw new WfEngineError('INVALID_INPUT', `Identifiant de ${what} invalide.`);
  return value;
}

function tryParseId(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,18}$/.test(raw)) return null;
  const value = BigInt(raw);
  return value > MAX_BIGINT ? null : value;
}

function parseId(raw: unknown, what: string): bigint {
  const id = tryParseId(raw);
  if (id === null) throw new WfEngineError('NOT_FOUND', `${what} introuvable.`);
  return id;
}

function assertPrincipal(principal: WfPrincipal): void {
  if (
    !principal ||
    !isPositiveInt(principal.userGroupId) ||
    !Array.isArray(principal.groupIds) ||
    !(principal.roleId === null || isPositiveInt(principal.roleId))
  ) {
    throw new WfEngineError('FORBIDDEN', 'Identité de l’utilisateur invalide.');
  }
}

function assertActor(actor: WfActorRef): WfActorRef {
  if (!actor || !['system', 'user', 'agent'].includes(actor.kind)) {
    throw new WfEngineError('INVALID_INPUT', 'Auteur de la transition invalide.');
  }
  if (actor.kind === 'user' && !isPositiveInt(actor.userGroupId)) {
    throw new WfEngineError('INVALID_INPUT', "Une action d'utilisateur doit nommer l'utilisateur.");
  }
  if (actor.userGroupId !== undefined && !isPositiveInt(actor.userGroupId)) {
    throw new WfEngineError('INVALID_INPUT', 'Auteur de la transition invalide.');
  }
  return actor.userGroupId === undefined ? { kind: actor.kind } : { kind: actor.kind, userGroupId: actor.userGroupId };
}

function cleanReason(reason: unknown): string | null {
  return typeof reason === 'string' && reason.trim() ? truncateText(reason.trim(), REASON_MAX) : null;
}

function parseSubject(type: string | null | undefined, id: string | null | undefined): { type: string; id: bigint } | null {
  const hasType = type !== null && type !== undefined && type !== '';
  const hasId = id !== null && id !== undefined && id !== '';
  if (!hasType && !hasId) return null;
  if (!hasType || !hasId) {
    throw new WfEngineError('INVALID_INPUT', "L'objet lié exige un type ET un identifiant.");
  }
  if (typeof type !== 'string' || type.length > WF_SUBJECT_TYPE_MAX_LENGTH || !WF_KEY_PATTERN.test(type)) {
    throw new WfEngineError('INVALID_INPUT', "Type d'objet lié invalide.");
  }
  const parsed = tryParseId(id);
  if (parsed === null) throw new WfEngineError('INVALID_INPUT', "Identifiant d'objet lié invalide.");
  return { type, id: parsed };
}

function parseIdempotencyKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new WfEngineError('INVALID_INPUT', "Clé d'idempotence invalide.");
  const key = raw.trim();
  if (key.length === 0) return null;
  if (key.length > 200) throw new WfEngineError('INVALID_INPUT', "Clé d'idempotence trop longue (200 caractères au plus).");
  return key;
}

function sanitizeStatuses(statuses: number[], max: number): number[] {
  const valid = statuses.filter((s) => Number.isInteger(s) && s >= 0 && s <= max);
  if (valid.length !== statuses.length) throw new WfEngineError('INVALID_INPUT', 'Filtre de statut invalide.');
  return [...new Set(valid)];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function isTerminal(status: number): boolean {
  return (
    status === WfInstanceStatus.Completed || status === WfInstanceStatus.Failed || status === WfInstanceStatus.Cancelled
  );
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function normalizeConfidence(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function errorText(err: unknown): string {
  return truncateText(err instanceof Error ? err.message : String(err), REASON_MAX);
}

/** Résultat d'exécuteur mal formé => erreur (la tâche reste à l'humain), jamais une exception. */
export function normalizeOutcome(raw: unknown): InternalOutcome {
  if (!isPlainObject(raw)) return { kind: 'error', message: "réponse d'exécuteur invalide" };
  switch (raw.kind) {
    case 'wait': {
      const esc = raw.escalation;
      if (isPlainObject(esc) && typeof esc.reason === 'string' && esc.reason.trim()) {
        return {
          kind: 'wait',
          escalation: {
            reason: esc.reason,
            explanation: typeof esc.explanation === 'string' ? esc.explanation : '',
            audit: normalizeAudit(esc.audit),
          },
        };
      }
      return { kind: 'wait' };
    }
    case 'complete':
      return {
        kind: 'complete',
        result: raw.result,
        explanation: typeof raw.explanation === 'string' ? raw.explanation : undefined,
        audit: normalizeAudit(raw.audit),
      };
    case 'propose':
      return {
        kind: 'propose',
        proposal: raw.proposal,
        explanation: typeof raw.explanation === 'string' ? raw.explanation : undefined,
        sources: raw.sources,
        confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
        audit: normalizeAudit(raw.audit),
      };
    case 'fail':
      return { kind: 'fail', error: typeof raw.error === 'string' ? raw.error : 'échec sans précision' };
    default:
      return { kind: 'error', message: "réponse d'exécuteur invalide" };
  }
}

/**
 * Audit d'agent fourni par un exécuteur : chaque champ est vérifié, ce qui est inconnu ou mal typé est
 * ignoré (jamais d'exception : une valeur douteuse ne doit pas bloquer l'écriture du journal).
 */
export function normalizeAudit(raw: unknown): WfAgentAudit | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: WfAgentAudit = {};
  if (typeof raw.instruction === 'string') out.instruction = raw.instruction;
  if (raw.sources !== undefined) out.sources = raw.sources;
  if (raw.decision !== undefined) out.decision = raw.decision;
  const confidence = normalizeConfidence(raw.confidence);
  if (confidence !== null) out.confidence = confidence;
  if (raw.autonomyLevel === 0 || raw.autonomyLevel === 1 || raw.autonomyLevel === 2) {
    out.autonomyLevel = raw.autonomyLevel;
  }
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = truncateText(raw.model.trim(), MODEL_MAX);
  else if (raw.model === null) out.model = null;
  if (typeof raw.aiDecisionId === 'string' && /^[0-9]{1,19}$/.test(raw.aiDecisionId) && BigInt(raw.aiDecisionId) <= MAX_BIGINT) {
    out.aiDecisionId = raw.aiDecisionId;
  } else if (raw.aiDecisionId === null) out.aiDecisionId = null;
  for (const key of ['promptTokens', 'completionTokens'] as const) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= INT32_MAX) out[key] = v;
    else if (v === null) out[key] = null;
  }
  const cost = raw.costAmount;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= COST_MAX) out.costAmount = cost;
  else if (cost === null) out.costAmount = null;
  return out;
}

/** Champs d'audit d'un événement de journal (identifiant décimal -> BigInt pour `ai_decision_id`). */
function auditFields(audit: WfAgentAudit | undefined): Partial<LogEntry> {
  if (!audit) return {};
  return {
    instruction: audit.instruction ?? null,
    sources: audit.sources,
    confidence: audit.confidence ?? null,
    autonomyLevel: audit.autonomyLevel ?? null,
    model: audit.model ?? null,
    aiDecisionId: audit.aiDecisionId ? BigInt(audit.aiDecisionId) : null,
    promptTokens: audit.promptTokens ?? null,
    completionTokens: audit.completionTokens ?? null,
    costAmount: audit.costAmount ?? null,
  };
}

/** Valeur JSON écrivable par Prisma (aller-retour JSON : pas d'undefined, pas de prototype). */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function assigneeRefOf(row: { assigneeUserGroupId: number | null; assigneeGroupId: number | null; assigneeRoleId: number | null }): WfAssigneeRef {
  if (row.assigneeUserGroupId !== null) return { userGroupId: row.assigneeUserGroupId };
  if (row.assigneeGroupId !== null) return { groupId: row.assigneeGroupId };
  if (row.assigneeRoleId !== null) return { roleId: row.assigneeRoleId };
  return {};
}

// ---------------------------------------------------------------------------
// Lignes Prisma -> DTO (@archivage/types)
// ---------------------------------------------------------------------------

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function decimalText(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

export function toInstanceDto(r: WfInstance): WfInstanceDto {
  return {
    wfInstanceId: r.wfInstanceId.toString(),
    definitionId: r.definitionId,
    definitionVersionId: r.definitionVersionId,
    status: r.status as WfInstanceStatusValue,
    context: isPlainObject(r.context) ? r.context : {},
    startedBy: r.startedBy,
    triggerId: r.triggerId,
    parentInstanceId: r.parentInstanceId === null ? null : r.parentInstanceId.toString(),
    subjectType: r.subjectType,
    subjectId: r.subjectId === null ? null : r.subjectId.toString(),
    idempotencyKey: r.idempotencyKey,
    dueAt: iso(r.dueAt),
    errorMessage: r.errorMessage,
    rowVersion: r.rowVersion,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toTaskDto(r: WfTask): WfTaskDto {
  return {
    wfTaskId: r.wfTaskId.toString(),
    instanceId: r.instanceId.toString(),
    stepKey: r.stepKey,
    taskType: r.taskType as WfTaskDto['taskType'],
    status: r.status as WfTaskStatusValue,
    title: r.title,
    instructions: r.instructions,
    priority: r.priority as WfTaskPriority,
    assigneeUserGroupId: r.assigneeUserGroupId,
    assigneeGroupId: r.assigneeGroupId,
    assigneeRoleId: r.assigneeRoleId,
    dueAt: iso(r.dueAt),
    attempt: r.attempt,
    input: r.input,
    result: r.result,
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    completedBy: r.completedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toEventDto(r: WfEventLog): WfEventLogDto {
  return {
    wfEventLogId: r.wfEventLogId.toString(),
    instanceId: r.instanceId.toString(),
    taskId: r.taskId === null ? null : r.taskId.toString(),
    stepKey: r.stepKey,
    eventType: r.eventType,
    actorKind: r.actorKind as WfActorKindValue,
    actorUserGroupId: r.actorUserGroupId,
    instruction: r.instruction,
    sources: r.sources,
    decision: r.decision,
    explanation: r.explanation,
    confidence: decimalText(r.confidence),
    autonomyLevel: r.autonomyLevel as WfAutonomyLevel | null,
    model: r.model,
    aiDecisionId: r.aiDecisionId === null ? null : r.aiDecisionId.toString(),
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    costAmount: decimalText(r.costAmount),
    validatedBy: r.validatedBy,
    validatedAt: iso(r.validatedAt),
    correctsEventId: r.correctsEventId === null ? null : r.correctsEventId.toString(),
    occurredAt: r.occurredAt.toISOString(),
  };
}

export function toInboxDto(r: WfInboxItem): WfInboxItemDto {
  return {
    wfInboxItemId: r.wfInboxItemId.toString(),
    taskId: r.taskId.toString(),
    instanceId: r.instanceId.toString(),
    kind: r.kind as WfInboxItemKindValue,
    status: r.status as WfInboxItemStatusValue,
    priority: r.priority as WfTaskPriority,
    title: r.title,
    summary: r.summary,
    proposal: r.proposal,
    explanation: r.explanation,
    sources: r.sources,
    confidence: decimalText(r.confidence),
    agentEventId: r.agentEventId === null ? null : r.agentEventId.toString(),
    assigneeUserGroupId: r.assigneeUserGroupId,
    assigneeGroupId: r.assigneeGroupId,
    assigneeRoleId: r.assigneeRoleId,
    dueAt: iso(r.dueAt),
    claimedBy: r.claimedBy,
    claimedAt: iso(r.claimedAt),
    resolvedBy: r.resolvedBy,
    resolvedAt: iso(r.resolvedAt),
    resolution: r.resolution,
    resolutionComment: r.resolutionComment,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
