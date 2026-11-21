// Docu-Flow W1 — traitement des minuteries durables (`wf_timer`) : relance, échéance (avec escalade
// par ré-affectation), expiration + suspension, et points d'extension pour les natures 0 / 3.
//
// Le worker NE contient PAS le moteur : le moteur (api) crée les minuteries, le worker les consomme.
// Garanties :
//  - réclamation par bail (`locked_by` / `locked_until`) en SQL paramétré, `FOR UPDATE OF t SKIP LOCKED` :
//    deux workers ne prennent jamais la même minuterie, et une minuterie dont le bail a expiré (worker
//    mort, redémarrage) est reprise ;
//  - UNE transaction par minuterie : CAS sur la minuterie (0 -> 1 avec `locked_by` = ce worker), puis
//    l'effet ET le journal `wf_event_log` dans la même transaction => exactement une fois, aucun effet partiel ;
//  - seules les instances actives (statut 0 ou 1) sont traitées ;
//  - la notification est écrite APRÈS le commit et ne fait jamais échouer le traitement.
// Journalisation : compteurs et identifiants uniquement, jamais de donnée métier.
import { hostname } from 'node:os';
import { Prisma, type PrismaClient } from '@prisma/client';
import { wfEscalationConfigSchema, type WfEscalationConfig } from '@archivage/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Natures de minuterie (`wf_timer.kind`). */
export const WF_TIMER_KIND = { wait: 0, reminder: 1, deadline: 2, resume: 3 } as const;

export const WF_TIMERS_DEFAULTS = {
  batchSize: 50,
  leaseSeconds: 120,
  maxAttempts: 5,
  /** Plafond de membres notifiés pour un bénéficiaire groupe / rôle. */
  maxRecipients: 200,
  /** Nombre maximal de lots enchaînés par tick. */
  maxRoundsPerTick: 20,
} as const;

const TARGET_TYPE = 'workflow_task';
const INT4_MAX = 2147483647;

export interface WorkflowTimersLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const silentLog: WorkflowTimersLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Minuterie réclamée (ligne retournée par la requête de bail). */
export interface ClaimedTimer {
  timerId: bigint;
  instanceId: bigint;
  taskId: bigint | null;
  stepKey: string;
  kind: number;
  attempts: number;
  payload: unknown;
}

export interface TimerInstance {
  instanceId: bigint;
  status: number;
  definitionVersionId: number;
  startedBy: number;
}

export type WorkflowTx = Prisma.TransactionClient;

export interface WorkflowTimerHandlerContext {
  tx: WorkflowTx;
  timer: ClaimedTimer;
  instance: TimerInstance;
  now: Date;
}

/**
 * Point d'extension des natures 0 (attente) et 3 (reprise). Appelé DANS la transaction, après le CAS :
 * si le gestionnaire lève, tout est annulé et la minuterie sera reprise au bail suivant.
 */
export type WorkflowTimerHandler = (ctx: WorkflowTimerHandlerContext) => Promise<void>;

const registry = new Map<number, WorkflowTimerHandler>();

/** Enregistre le gestionnaire d'une nature de minuterie (0 attente, 3 reprise). */
export function registerTimerHandler(kind: number, handler: WorkflowTimerHandler): void {
  if (kind !== WF_TIMER_KIND.wait && kind !== WF_TIMER_KIND.resume) {
    throw new Error('Seules les minuteries de nature 0 (attente) et 3 (reprise) acceptent un gestionnaire.');
  }
  registry.set(kind, handler);
}

/** Bénéficiaire d'une notification, avant extension aux membres d'un groupe / rôle. */
export interface PendingNotification {
  beneficiary: { userGroupId?: number; groupId?: number; roleId?: number };
  message: string;
  taskId: bigint;
}

/** Notification prête à écrire dans la table `notification`. */
export interface NotificationRow {
  recipientUserGroupId: number;
  message: string;
  targetType: string;
  targetId: number | null;
}

export type NotifyFn = (rows: NotificationRow[]) => Promise<void>;

export type TimerOutcome =
  | 'reminded'
  | 'escalated'
  | 'expired'
  | 'handled'
  | 'noop'
  | 'lost'
  | 'skipped'
  | 'abandoned'
  | 'failed';

export interface RunDueTimersOptions {
  now: Date;
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  /** Écriture des notifications ; défaut : insertion directe dans `notification`. */
  notify?: NotifyFn;
  /** Gestionnaires injectés (surchargent ceux de `registerTimerHandler`). */
  handlers?: Partial<Record<number, WorkflowTimerHandler>>;
  log?: WorkflowTimersLog;
}

export interface RunDueTimersResult {
  claimed: number;
  reminded: number;
  escalated: number;
  expired: number;
  handled: number;
  noop: number;
  lost: number;
  skipped: number;
  abandoned: number;
  failed: number;
  notified: number;
}

interface TimerEffect {
  outcome: TimerOutcome;
  notifications: PendingNotification[];
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBigInt(value: unknown): bigint {
  return typeof value === 'bigint' ? value : BigInt(value as number | string);
}

function toTargetId(taskId: bigint): number | null {
  return taskId <= BigInt(INT4_MAX) ? Number(taskId) : null;
}

function errorLabel(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? `${err.name}:${code}` : err.name;
  }
  return 'UnknownError';
}

/** Paramètres d'étape lus dans le graphe de la version de l'instance (lecture tolérante). */
interface StepParams {
  dueInHours: number | null;
  reminderAfterHours: number | null;
  /** `undefined` : aucune escalade déclarée ; `null` : déclarée mais invalide ; sinon valide. */
  escalation: WfEscalationConfig | null | undefined;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function readStepParams(graph: unknown, stepKey: string): StepParams {
  const empty: StepParams = { dueInHours: null, reminderAfterHours: null, escalation: undefined };
  if (!isRecord(graph) || !Array.isArray(graph.steps)) return empty;
  const step = graph.steps.find((s): s is Record<string, unknown> => isRecord(s) && s.key === stepKey);
  if (!step) return empty;
  const config = isRecord(step.config) ? step.config : undefined;
  let escalation: StepParams['escalation'];
  if (config && config.escalation !== undefined && config.escalation !== null) {
    const parsed = wfEscalationConfigSchema.safeParse(config.escalation);
    escalation = parsed.success ? parsed.data : null;
  }
  return {
    dueInHours: positiveInt(step.dueInHours),
    reminderAfterHours: positiveInt(step.reminderAfterHours),
    escalation,
  };
}

function exclusiveAssignee(a: { kind: 'user' | 'group' | 'role'; id: number }): {
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
} {
  return {
    assigneeUserGroupId: a.kind === 'user' ? a.id : null,
    assigneeGroupId: a.kind === 'group' ? a.id : null,
    assigneeRoleId: a.kind === 'role' ? a.id : null,
  };
}

type TaskRow = {
  wfTaskId: bigint;
  status: number;
  title: string;
  attempt: number;
  dueAt: Date | null;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
};

function beneficiaryOf(task: TaskRow): PendingNotification['beneficiary'] {
  if (task.assigneeUserGroupId != null) return { userGroupId: task.assigneeUserGroupId };
  if (task.assigneeGroupId != null) return { groupId: task.assigneeGroupId };
  if (task.assigneeRoleId != null) return { roleId: task.assigneeRoleId };
  return {};
}

function describeAssignee(a: {
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
}): Prisma.InputJsonValue {
  if (a.assigneeUserGroupId != null) return { kind: 'user', id: a.assigneeUserGroupId };
  if (a.assigneeGroupId != null) return { kind: 'group', id: a.assigneeGroupId };
  if (a.assigneeRoleId != null) return { kind: 'role', id: a.assigneeRoleId };
  return { kind: 'none' };
}

async function logEvent(
  tx: WorkflowTx,
  timer: ClaimedTimer,
  now: Date,
  eventType: string,
  decision?: Prisma.InputJsonValue,
  explanation?: string,
): Promise<void> {
  await tx.wfEventLog.create({
    data: {
      instanceId: timer.instanceId,
      taskId: timer.taskId,
      stepKey: timer.stepKey,
      eventType,
      actorKind: 0,
      ...(decision !== undefined ? { decision } : {}),
      ...(explanation !== undefined ? { explanation } : {}),
      occurredAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Réclamation par bail
// ---------------------------------------------------------------------------

interface ClaimRow {
  wf_timer_id: bigint | number;
  instance_id: bigint | number;
  task_id: bigint | number | null;
  step_key: string;
  kind: number;
  attempts: number;
  payload: unknown;
}

/** Colonne `task_id`, à défaut `payload.taskId` (le moteur écrit `{ taskId, attempt }`). */
function resolveTaskId(column: bigint | number | null, payload: unknown): bigint | null {
  if (column != null) return toBigInt(column);
  if (isRecord(payload) && (typeof payload.taskId === 'string' || typeof payload.taskId === 'number')) {
    try {
      return BigInt(payload.taskId);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Réclame un lot de minuteries échues : SQL paramétré (aucune interpolation de chaîne). `FOR UPDATE OF t
 * SKIP LOCKED` : un autre worker en train de réclamer les mêmes lignes ne bloque pas celui-ci ; la jointure
 * sur l'instance écarte les instances non actives (suspendues, terminées, annulées).
 */
export async function claimDueTimers(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  opts: { now: Date; workerId: string; batchSize: number; leaseSeconds: number },
): Promise<ClaimedTimer[]> {
  const leaseUntil = new Date(opts.now.getTime() + opts.leaseSeconds * 1000);
  const rows = await prisma.$queryRaw<ClaimRow[]>(Prisma.sql`
    UPDATE "wf_timer" AS u
       SET "locked_by" = ${opts.workerId},
           "locked_until" = ${leaseUntil}::timestamptz,
           "attempts" = u."attempts" + 1
     WHERE u."wf_timer_id" IN (
       SELECT t."wf_timer_id"
         FROM "wf_timer" t
         JOIN "wf_instance" i ON i."wf_instance_id" = t."instance_id"
        WHERE t."status" = 0
          AND t."fire_at" <= ${opts.now}::timestamptz
          AND (t."locked_until" IS NULL OR t."locked_until" < ${opts.now}::timestamptz)
          AND i."status" IN (0, 1)
        ORDER BY t."fire_at", t."wf_timer_id"
        LIMIT ${opts.batchSize}
        FOR UPDATE OF t SKIP LOCKED
     )
    RETURNING u."wf_timer_id", u."instance_id", u."task_id", u."step_key", u."kind", u."attempts", u."payload"
  `);
  return rows.map((r) => ({
    timerId: toBigInt(r.wf_timer_id),
    instanceId: toBigInt(r.instance_id),
    taskId: resolveTaskId(r.task_id, r.payload),
    stepKey: r.step_key,
    kind: Number(r.kind),
    attempts: Number(r.attempts),
    payload: r.payload,
  }));
}

// ---------------------------------------------------------------------------
// Effets
// ---------------------------------------------------------------------------

interface InstanceLockRow {
  wf_instance_id: bigint | number;
  status: number;
  definition_version_id: number;
  started_by: number;
}

async function processInTransaction(
  tx: WorkflowTx,
  timer: ClaimedTimer,
  ctx: { now: Date; workerId: string; handlers: Partial<Record<number, WorkflowTimerHandler>> },
): Promise<TimerEffect> {
  const { now, workerId } = ctx;

  // 1. Verrou de l'instance (sérialise avec le moteur, qui prend le même verrou en premier).
  const rows = await tx.$queryRaw<InstanceLockRow[]>(Prisma.sql`
    SELECT "wf_instance_id", "status", "definition_version_id", "started_by"
      FROM "wf_instance"
     WHERE "wf_instance_id" = ${timer.instanceId}
       FOR UPDATE
  `);
  const row = rows[0];
  if (!row || (Number(row.status) !== 0 && Number(row.status) !== 1)) {
    // Suspendue / terminée entre la réclamation et maintenant : on rend la minuterie (bail levé), sans effet.
    await tx.wfTimer.updateMany({
      where: { wfTimerId: timer.timerId, status: 0, lockedBy: workerId },
      data: { lockedBy: null, lockedUntil: null },
    });
    return { outcome: 'skipped', notifications: [] };
  }
  const instance: TimerInstance = {
    instanceId: toBigInt(row.wf_instance_id),
    status: Number(row.status),
    definitionVersionId: Number(row.definition_version_id),
    startedBy: Number(row.started_by),
  };

  // 2. CAS sur la minuterie : encore active ET toujours à nous.
  const cas = await tx.wfTimer.updateMany({
    where: { wfTimerId: timer.timerId, status: 0, lockedBy: workerId },
    data: { status: 1, firedAt: now, lockedBy: null, lockedUntil: null },
  });
  if (cas.count !== 1) return { outcome: 'lost', notifications: [] };

  // 3. Effet selon la nature.
  if (timer.kind === WF_TIMER_KIND.reminder || timer.kind === WF_TIMER_KIND.deadline) {
    return timer.kind === WF_TIMER_KIND.reminder
      ? applyReminder(tx, timer, instance, now)
      : applyDeadline(tx, timer, instance, now);
  }
  // Natures 0 / 3 : événement + point d'extension, aucun effet par défaut.
  await logEvent(tx, timer, now, 'timer.fired', { kind: timer.kind });
  const handler = ctx.handlers[timer.kind] ?? registry.get(timer.kind);
  if (handler) await handler({ tx, timer, instance, now });
  return { outcome: 'handled', notifications: [] };
}

const TASK_SELECT = {
  wfTaskId: true,
  status: true,
  title: true,
  attempt: true,
  dueAt: true,
  assigneeUserGroupId: true,
  assigneeGroupId: true,
  assigneeRoleId: true,
} as const;

async function loadOpenTask(tx: WorkflowTx, timer: ClaimedTimer): Promise<TaskRow | null> {
  if (timer.taskId == null) return null;
  const task = await tx.wfTask.findUnique({ where: { wfTaskId: timer.taskId }, select: TASK_SELECT });
  if (!task || (task.status !== 0 && task.status !== 1)) return null;
  return task;
}

async function loadStepParams(tx: WorkflowTx, instance: TimerInstance, stepKey: string): Promise<StepParams> {
  const version = await tx.wfDefinitionVersion.findUnique({
    where: { wfDefinitionVersionId: instance.definitionVersionId },
    select: { graph: true },
  });
  return readStepParams(version?.graph, stepKey);
}

/** Nature 1 : relance au bénéficiaire, puis ré-armement borné par l'échéance de la tâche. */
async function applyReminder(
  tx: WorkflowTx,
  timer: ClaimedTimer,
  instance: TimerInstance,
  now: Date,
): Promise<TimerEffect> {
  const task = await loadOpenTask(tx, timer);
  if (!task) {
    // Tâche déjà terminée / annulée : aucun effet, mais la minuterie est tracée comme déclenchée.
    await logEvent(tx, timer, now, 'timer.fired', { noop: true });
    return { outcome: 'noop', notifications: [] };
  }
  await logEvent(tx, timer, now, 'timer.fired', { kind: 'reminder', attempt: task.attempt });

  const params = await loadStepParams(tx, instance, timer.stepKey);
  if (params.reminderAfterHours !== null && task.dueAt) {
    const next = addHours(now, params.reminderAfterHours);
    if (next < task.dueAt) {
      await tx.wfTimer.create({
        data: {
          instanceId: timer.instanceId,
          taskId: task.wfTaskId,
          stepKey: timer.stepKey,
          kind: WF_TIMER_KIND.reminder,
          fireAt: next,
          payload: { taskId: task.wfTaskId.toString(), attempt: task.attempt },
        },
      });
      await logEvent(tx, timer, now, 'timer.scheduled', { kind: 'reminder', fireAt: next.toISOString() });
    }
  }
  return {
    outcome: 'reminded',
    notifications: [
      {
        beneficiary: beneficiaryOf(task),
        message: `Relance : la tâche « ${task.title} » est en attente de traitement.`,
        taskId: task.wfTaskId,
      },
    ],
  };
}

/** Le bénéficiaire d'escalade existe-t-il et est-il actif (compte non désactivé, groupe actif, rôle actif) ? */
async function isEscalationTargetActive(
  tx: WorkflowTx,
  a: { kind: 'user' | 'group' | 'role'; id: number },
): Promise<boolean> {
  if (a.kind === 'user') {
    return (await tx.appUserGroup.findFirst({
      where: { userGroupId: a.id, user: { isDisabled: false } },
      select: { userGroupId: true },
    })) !== null;
  }
  if (a.kind === 'group') {
    return (await tx.appGroup.findFirst({ where: { groupId: a.id, isActive: true }, select: { groupId: true } })) !== null;
  }
  return (await tx.role.findFirst({ where: { roleId: a.id, isActive: true }, select: { roleId: true } })) !== null;
}

/** Nature 2 : échéance dépassée => escalade par ré-affectation, sinon expiration + suspension. */
async function applyDeadline(
  tx: WorkflowTx,
  timer: ClaimedTimer,
  instance: TimerInstance,
  now: Date,
): Promise<TimerEffect> {
  const task = await loadOpenTask(tx, timer);
  if (!task) {
    // Tâche déjà terminée / annulée : aucun effet, mais la minuterie est tracée comme déclenchée.
    await logEvent(tx, timer, now, 'timer.fired', { noop: true });
    return { outcome: 'noop', notifications: [] };
  }

  const params = await loadStepParams(tx, instance, timer.stepKey);
  const escalationInvalid = params.escalation === null;
  const escalation = params.escalation ?? undefined;
  const previous = escalation
    ? await tx.wfEventLog.count({ where: { taskId: task.wfTaskId, eventType: 'task.escalated' } })
    : 0;
  const maxEscalations = escalation?.maxEscalations ?? 1;
  // Cible vérifiée à l'exécution : compte actif / groupe actif / rôle actif, sinon repli sur l'expiration.
  const targetOk = escalation ? await isEscalationTargetActive(tx, escalation.assignee) : false;

  if (escalation && previous < maxEscalations && targetOk) {
    const target = exclusiveAssignee(escalation.assignee);
    const newDue = addHours(now, escalation.dueInHours);
    await tx.wfTask.update({
      where: { wfTaskId: task.wfTaskId },
      data: { ...target, status: 0, dueAt: newDue },
    });
    await tx.wfInboxItem.updateMany({
      where: { taskId: task.wfTaskId, status: { in: [0, 1] } },
      data: { ...target, status: 0, dueAt: newDue, claimedBy: null, claimedAt: null },
    });
    await tx.wfInstance.updateMany({
      where: { wfInstanceId: instance.instanceId },
      data: { rowVersion: { increment: 1 } },
    });
    await logEvent(tx, timer, now, 'timer.fired', { kind: 'deadline', action: 'escalation' });
    await logEvent(tx, timer, now, 'task.escalated', {
      from: describeAssignee(task),
      to: describeAssignee(target),
      escalation: previous + 1,
      maxEscalations,
    }, 'Échéance dépassée : tâche ré-affectée par escalade.');
    {
      await tx.wfTimer.create({
        data: {
          instanceId: timer.instanceId,
          taskId: task.wfTaskId,
          stepKey: timer.stepKey,
          kind: WF_TIMER_KIND.deadline,
          fireAt: newDue,
          payload: { taskId: task.wfTaskId.toString(), attempt: task.attempt },
        },
      });
      await logEvent(tx, timer, now, 'timer.scheduled', { kind: 'deadline', fireAt: newDue.toISOString() });
    }
    const extra = escalation.message ? ` ${escalation.message}` : '';
    return {
      outcome: 'escalated',
      notifications: [
        {
          beneficiary: beneficiaryOf({ ...task, ...target }),
          message: `La tâche « ${task.title} » vous a été ré-affectée : l’échéance est dépassée.${extra}`,
          taskId: task.wfTaskId,
        },
      ],
    };
  }

  // Pas d'escalade (ou épuisée) : expiration de la tâche, suspension de l'instance.
  await tx.wfTask.update({ where: { wfTaskId: task.wfTaskId }, data: { status: 4 } });
  await tx.wfInboxItem.updateMany({
    where: { taskId: task.wfTaskId, status: { in: [0, 1] } },
    data: { status: 4 },
  });
  // Les autres minuteries actives de cette tâche (relance…) n'ont plus d'objet.
  await tx.wfTimer.updateMany({
    where: { instanceId: timer.instanceId, taskId: task.wfTaskId, status: 0 },
    data: { status: 2, lockedBy: null, lockedUntil: null },
  });
  const suspended = await tx.wfInstance.updateMany({
    where: { wfInstanceId: instance.instanceId, status: { in: [0, 1] } },
    data: { status: 5, rowVersion: { increment: 1 } },
  });
  if (suspended.count !== 1) throw new Error('Suspension de l’instance impossible (état modifié).');
  await logEvent(tx, timer, now, 'timer.fired', {
    kind: 'deadline',
    action: 'expiration',
    ...(escalationInvalid ? { escalation: 'invalid_config' } : {}),
    ...(escalation ? { escalationsDone: previous } : {}),
    ...(escalation && previous < maxEscalations && !targetOk ? { escalation: 'target_inactive' } : {}),
  });
  await logEvent(tx, timer, now, 'task.expired', { attempt: task.attempt });
  await logEvent(tx, timer, now, 'instance.suspended', { reason: 'deadline_exceeded' }, 'Échéance dépassée.');
  return {
    outcome: 'expired',
    notifications: [
      {
        beneficiary: { userGroupId: instance.startedBy },
        message: `La tâche « ${task.title} » a expiré : le workflow est suspendu et nécessite une reprise manuelle.`,
        taskId: task.wfTaskId,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Notifications (après commit)
// ---------------------------------------------------------------------------

/** Étend un bénéficiaire groupe / rôle à ses membres actifs (plafond 200, un seul compte par personne). */
export async function expandRecipients(
  prisma: PrismaClient,
  pending: PendingNotification[],
): Promise<NotificationRow[]> {
  const out: NotificationRow[] = [];
  for (const p of pending) {
    const { userGroupId, groupId, roleId } = p.beneficiary;
    let ids: number[] = [];
    if (userGroupId != null) {
      ids = [userGroupId];
    } else if (groupId != null || roleId != null) {
      const members = await prisma.appUserGroup.findMany({
        where:
          groupId != null
            ? { groupId, user: { isDisabled: false } }
            : { user: { roleId, isDisabled: false } },
        select: { userGroupId: true },
        distinct: ['userId'],
        orderBy: { userGroupId: 'asc' },
        take: WF_TIMERS_DEFAULTS.maxRecipients,
      });
      ids = members.map((m) => m.userGroupId);
    }
    for (const id of ids) {
      out.push({
        recipientUserGroupId: id,
        message: p.message,
        targetType: TARGET_TYPE,
        targetId: toTargetId(p.taskId),
      });
    }
  }
  return out;
}

function defaultNotify(prisma: PrismaClient): NotifyFn {
  return async (rows) => {
    if (rows.length === 0) return;
    await prisma.notification.createMany({ data: rows });
  };
}

// ---------------------------------------------------------------------------
// Boucle
// ---------------------------------------------------------------------------

/** Abandon d'une minuterie qui a épuisé ses tentatives : annulée + événement `timer.failed`. */
async function abandonTimer(
  prisma: PrismaClient,
  timer: ClaimedTimer,
  now: Date,
  workerId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const res = await tx.wfTimer.updateMany({
      where: { wfTimerId: timer.timerId, status: 0, lockedBy: workerId },
      data: { status: 2, lockedBy: null, lockedUntil: null },
    });
    if (res.count !== 1) return false;
    await logEvent(tx, timer, now, 'timer.failed', { kind: timer.kind, attempts: timer.attempts });
    return true;
  });
}

const EMPTY_RESULT = (): RunDueTimersResult => ({
  claimed: 0,
  reminded: 0,
  escalated: 0,
  expired: 0,
  handled: 0,
  noop: 0,
  lost: 0,
  skipped: 0,
  abandoned: 0,
  failed: 0,
  notified: 0,
});

/**
 * Traite UN lot de minuteries échues (réclamation par bail puis une transaction par minuterie).
 * Ne lève jamais pour une minuterie en échec : elle sera reprise quand son bail expirera.
 */
export async function runDueTimers(
  prisma: PrismaClient,
  options: RunDueTimersOptions,
): Promise<RunDueTimersResult> {
  const {
    now,
    workerId,
    batchSize = WF_TIMERS_DEFAULTS.batchSize,
    leaseSeconds = WF_TIMERS_DEFAULTS.leaseSeconds,
    maxAttempts = WF_TIMERS_DEFAULTS.maxAttempts,
    handlers = {},
    log = silentLog,
  } = options;
  const notify = options.notify ?? defaultNotify(prisma);
  const result = EMPTY_RESULT();

  const claimed = await claimDueTimers(prisma, { now, workerId, batchSize, leaseSeconds });
  result.claimed = claimed.length;

  for (const timer of claimed) {
    let effect: TimerEffect;
    try {
      if (timer.attempts > maxAttempts) {
        const done = await abandonTimer(prisma, timer, now, workerId);
        result[done ? 'abandoned' : 'lost'] += 1;
        if (done) log.warn({ timerId: String(timer.timerId), kind: timer.kind, attempts: timer.attempts }, 'minuterie abandonnée');
        continue;
      }
      effect = await prisma.$transaction((tx) => processInTransaction(tx, timer, { now, workerId, handlers }), {
        maxWait: 5000,
        timeout: 30000,
      });
    } catch (err) {
      result.failed += 1;
      log.error(
        { timerId: String(timer.timerId), kind: timer.kind, attempts: timer.attempts, err: errorLabel(err) },
        'minuterie en échec (reprise au prochain bail)',
      );
      continue;
    }
    result[effect.outcome] += 1;

    // Après commit : jamais d'échec propagé.
    if (effect.notifications.length > 0) {
      try {
        const rows = await expandRecipients(prisma, effect.notifications);
        await notify(rows);
        result.notified += rows.length;
      } catch (err) {
        log.warn({ timerId: String(timer.timerId), err: errorLabel(err) }, 'notification de minuterie non écrite');
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Processeur (un tick)
// ---------------------------------------------------------------------------

export interface WorkflowTimersDeps {
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  notify?: NotifyFn;
  handlers?: Partial<Record<number, WorkflowTimerHandler>>;
  log?: WorkflowTimersLog;
  /** Horloge injectable (tests). */
  clock?: () => Date;
  maxRoundsPerTick?: number;
}

export function defaultWorkerId(): string {
  return `${hostname()}:${process.pid}`;
}

/** Un tick : enchaîne les lots tant qu'un lot est plein (plafonné), et additionne les compteurs. */
export function createWorkflowTimersProcessor(
  prisma: PrismaClient,
  deps: WorkflowTimersDeps = {},
): () => Promise<RunDueTimersResult> {
  const workerId = deps.workerId ?? defaultWorkerId();
  const batchSize = deps.batchSize ?? WF_TIMERS_DEFAULTS.batchSize;
  const rounds = deps.maxRoundsPerTick ?? WF_TIMERS_DEFAULTS.maxRoundsPerTick;
  const clock = deps.clock ?? (() => new Date());
  return async () => {
    const total = EMPTY_RESULT();
    for (let i = 0; i < rounds; i += 1) {
      const res = await runDueTimers(prisma, {
        now: clock(),
        workerId,
        batchSize,
        ...(deps.leaseSeconds !== undefined ? { leaseSeconds: deps.leaseSeconds } : {}),
        ...(deps.maxAttempts !== undefined ? { maxAttempts: deps.maxAttempts } : {}),
        ...(deps.notify ? { notify: deps.notify } : {}),
        ...(deps.handlers ? { handlers: deps.handlers } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      });
      for (const key of Object.keys(total) as (keyof RunDueTimersResult)[]) total[key] += res[key];
      if (res.claimed < batchSize) break;
    }
    return total;
  };
}
