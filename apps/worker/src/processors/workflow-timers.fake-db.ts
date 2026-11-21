// Docu-Flow W1 — PrismaClient SIMULÉ en mémoire, pour les tests des minuteries (aucune base requise).
// Il imite juste ce que le processeur utilise : réclamation par bail, verrou d'instance, CAS, transaction
// avec annulation (instantané restauré si la fonction lève). Fichier d'aide de test uniquement.
import type { PrismaClient } from '@prisma/client';

export interface FakeTimer {
  wfTimerId: bigint;
  instanceId: bigint;
  taskId: bigint | null;
  stepKey: string;
  kind: number;
  status: number;
  fireAt: Date;
  firedAt: Date | null;
  attempts: number;
  payload: unknown;
  lockedBy: string | null;
  lockedUntil: Date | null;
}
export interface FakeInstance {
  wfInstanceId: bigint;
  status: number;
  definitionVersionId: number;
  startedBy: number;
  rowVersion: number;
}
export interface FakeTask {
  wfTaskId: bigint;
  instanceId: bigint;
  stepKey: string;
  status: number;
  title: string;
  attempt: number;
  dueAt: Date | null;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
}
export interface FakeInbox {
  taskId: bigint;
  kind: number;
  status: number;
  dueAt: Date | null;
  assigneeUserGroupId: number | null;
  assigneeGroupId: number | null;
  assigneeRoleId: number | null;
  claimedBy: number | null;
  claimedAt: Date | null;
}
export interface FakeEvent {
  instanceId: bigint;
  taskId: bigint | null;
  stepKey: string | null;
  eventType: string;
  actorKind: number;
  decision?: unknown;
  explanation?: string;
  occurredAt: Date;
}
export interface FakeMember {
  userGroupId: number;
  userId: number;
  groupId: number;
  roleId: number | null;
  isDisabled: boolean;
}

export interface FakeStore {
  timers: FakeTimer[];
  instances: FakeInstance[];
  tasks: FakeTask[];
  inbox: FakeInbox[];
  events: FakeEvent[];
  graphs: Record<number, unknown>;
  members: FakeMember[];
  notifications: object[];
  /** Appelé juste après la réclamation (simule une course avec un autre worker, une suspension…). */
  afterClaim?: (store: FakeStore) => void;
  /** Fait échouer l'écriture du journal pour ce type d'événement (simule une panne en cours de transaction). */
  failEventType?: string;
  /** Cibles d'escalade actives ; absent = toutes actives. */
  targets?: { users: number[]; groups: number[]; roles: number[] };
  /** Fait échouer la lecture des membres (simule une panne d'annuaire). */
  failMembers?: boolean;
  /** SQL reçu par `$queryRaw` (texte et valeurs), dans l'ordre. */
  sqlLog: Array<{ sql: string; values: unknown[] }>;
  /** Arguments des lectures de membres. */
  memberQueries: Array<Record<string, unknown>>;
  nextId: number;
}

export function emptyStore(): FakeStore {
  return {
    timers: [],
    instances: [],
    tasks: [],
    inbox: [],
    events: [],
    graphs: {},
    members: [],
    notifications: [],
    sqlLog: [],
    memberQueries: [],
    nextId: 1000,
  };
}

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && 'in' in (cond as Row)) {
      return ((cond as { in: unknown[] }).in).includes(row[key]);
    }
    return row[key] === cond;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date) && 'increment' in (value as Row)) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else {
      row[key] = value;
    }
  }
}

function restore(store: FakeStore, snapshot: FakeStore): void {
  store.timers = snapshot.timers;
  store.instances = snapshot.instances;
  store.tasks = snapshot.tasks;
  store.inbox = snapshot.inbox;
  store.events = snapshot.events;
}

export function makeFakePrisma(store: FakeStore): PrismaClient {
  const updateMany = <T extends object>(rows: T[]) =>
    async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r as Row, where));
      hit.forEach((r) => applyData(r as Row, data));
      return { count: hit.length };
    };

  const db = {
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      store.sqlLog.push({ sql: query.sql, values: query.values });
      if (query.sql.includes('UPDATE "wf_timer"')) {
        // values : worker, bail, now (x2), lot — on lit les paramètres par position.
        const [workerId, leaseUntil, now, , batchSize] = query.values as [string, Date, Date, Date, number];
        const due = store.timers
          .filter((t) => {
            const inst = store.instances.find((i) => i.wfInstanceId === t.instanceId);
            return (
              t.status === 0 &&
              t.fireAt <= now &&
              (t.lockedUntil === null || t.lockedUntil < now) &&
              inst !== undefined &&
              (inst.status === 0 || inst.status === 1)
            );
          })
          .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
          .slice(0, batchSize);
        due.forEach((t) => {
          t.lockedBy = workerId;
          t.lockedUntil = leaseUntil;
          t.attempts += 1;
        });
        const out = due.map((t) => ({
          wf_timer_id: t.wfTimerId,
          instance_id: t.instanceId,
          task_id: t.taskId,
          step_key: t.stepKey,
          kind: t.kind,
          attempts: t.attempts,
          payload: t.payload,
        }));
        store.afterClaim?.(store);
        return out;
      }
      if (query.sql.includes('FROM "wf_instance"') && query.sql.includes('FOR UPDATE')) {
        const id = query.values[0] as bigint;
        const inst = store.instances.find((i) => i.wfInstanceId === id);
        return inst
          ? [
              {
                wf_instance_id: inst.wfInstanceId,
                status: inst.status,
                definition_version_id: inst.definitionVersionId,
                started_by: inst.startedBy,
              },
            ]
          : [];
      }
      throw new Error(`SQL inattendu : ${query.sql}`);
    },
    wfTimer: {
      updateMany: updateMany(store.timers),
      create: async ({ data }: { data: Row }) => {
        const clash = store.timers.some(
          (t) =>
            t.status === 0 &&
            t.instanceId === data.instanceId &&
            t.stepKey === data.stepKey &&
            t.kind === data.kind,
        );
        if (clash) throw new Error('ux_wf_timer_active');
        const row: FakeTimer = {
          wfTimerId: BigInt(store.nextId++),
          instanceId: data.instanceId as bigint,
          taskId: (data.taskId as bigint | null) ?? null,
          stepKey: data.stepKey as string,
          kind: data.kind as number,
          status: 0,
          fireAt: data.fireAt as Date,
          firedAt: null,
          attempts: 0,
          payload: data.payload ?? null,
          lockedBy: null,
          lockedUntil: null,
        };
        store.timers.push(row);
        return row;
      },
    },
    wfTask: {
      findUnique: async ({ where }: { where: { wfTaskId: bigint } }) =>
        store.tasks.find((t) => t.wfTaskId === where.wfTaskId) ?? null,
      update: async ({ where, data }: { where: { wfTaskId: bigint }; data: Row }) => {
        const row = store.tasks.find((t) => t.wfTaskId === where.wfTaskId);
        if (!row) throw new Error('tâche introuvable');
        applyData(row as unknown as Row, data);
        return row;
      },
    },
    wfInboxItem: { updateMany: updateMany(store.inbox) },
    wfInstance: { updateMany: updateMany(store.instances) },
    wfEventLog: {
      create: async ({ data }: { data: Row }) => {
        if (store.failEventType && data.eventType === store.failEventType) {
          throw new Error('panne simulée du journal');
        }
        store.events.push(data as unknown as FakeEvent);
        return data;
      },
      count: async ({ where }: { where: Row }) => store.events.filter((e) => matches(e as unknown as Row, where)).length,
    },
    wfDefinitionVersion: {
      findUnique: async ({ where }: { where: { wfDefinitionVersionId: number } }) => {
        const graph = store.graphs[where.wfDefinitionVersionId];
        return graph === undefined ? null : { graph };
      },
    },
    appUserGroup: {
      findFirst: async ({ where }: { where: { userGroupId: number } }) =>
        !store.targets || store.targets.users.includes(where.userGroupId) ? { userGroupId: where.userGroupId } : null,
      findMany: async (args: { where: { groupId?: number; user: { roleId?: number; isDisabled: boolean } } }) => {
        store.memberQueries.push(args as unknown as Row);
        if (store.failMembers) throw new Error('annuaire indisponible');
        const { groupId, user } = args.where;
        const seen = new Set<number>();
        return store.members
          .filter(
            (m) =>
              (groupId === undefined || m.groupId === groupId) &&
              (user.roleId === undefined || m.roleId === user.roleId) &&
              m.isDisabled === user.isDisabled,
          )
          .filter((m) => (seen.has(m.userId) ? false : (seen.add(m.userId), true)))
          .map((m) => ({ userGroupId: m.userGroupId }));
      },
    },
    role: {
      findFirst: async ({ where }: { where: { roleId: number } }) =>
        !store.targets || store.targets.roles.includes(where.roleId) ? { roleId: where.roleId } : null,
    },
    appGroup: {
      findFirst: async ({ where }: { where: { groupId: number } }) =>
        !store.targets || store.targets.groups.includes(where.groupId) ? { groupId: where.groupId } : null,
    },
    notification: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        store.notifications.push(...data);
        return { count: data.length };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const snapshot = structuredClone({
        timers: store.timers,
        instances: store.instances,
        tasks: store.tasks,
        inbox: store.inbox,
        events: store.events,
      }) as FakeStore;
      try {
        return await fn(db);
      } catch (err) {
        restore(store, snapshot);
        // Les delegates capturent les tableaux d'origine : on les rebranche sur les tableaux restaurés.
        rebind();
        throw err;
      }
    },
  };

  // Après une annulation, les `updateMany` doivent viser les tableaux restaurés.
  function rebind(): void {
    db.wfTimer.updateMany = updateMany(store.timers);
    db.wfInboxItem.updateMany = updateMany(store.inbox);
    db.wfInstance.updateMany = updateMany(store.instances);
  }

  return db as unknown as PrismaClient;
}
