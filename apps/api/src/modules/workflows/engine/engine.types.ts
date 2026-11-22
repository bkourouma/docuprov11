import type {
  WfEventLogDto,
  WfInboxItemDto,
  WfInstanceDto,
  WfInstanceStatus,
  WfStep,
  WfTaskDto,
} from '@archivage/types';
import type { Prisma } from '@prisma/client';

// Docu-Flow — CONTRAT PUBLIC du moteur (lot W1). Types seulement ; l'implémentation est dans engine.ts /
// interpreter.ts. Le moteur est SANS dépendance NestJS (classe simple construite avec un PrismaClient) pour
// rester testable et relocalisable dans un package partagé. Les minuteries (échéances, relances, escalade)
// sont exécutées par le worker (apps/worker/src/processors/workflow-timers.processor.ts) ; le moteur ne fait
// que les CRÉER (wf_timer) dans la transaction de la transition.
//
// Conventions : ids d'instance / tâche / boîte en `string` (BigInt décimal) ; acteurs en `number`
// (`app_user_group.user_group_id`) ; dates `Date` côté moteur, ISO UTC dans les DTO.

export type WfEngineErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN' // pas l'assigné (ni groupe, ni rôle) : aucun pouvoir implicite, pas même l'administrateur
  | 'CONFLICT' // verrou optimiste (row_version), tâche déjà prise ou déjà traitée
  | 'INVALID_STATE' // transition impossible depuis l'état courant
  | 'INVALID_INPUT' // résultat refusé par le type de tâche
  | 'DEFINITION_NOT_PUBLISHED'
  | 'IDEMPOTENCY_CONFLICT'; // même clé d'idempotence, autre lanceur

export class WfEngineError extends Error {
  constructor(
    readonly code: WfEngineErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WfEngineError';
  }
}

/** Humain qui agit. Construit par l'api (jeton + base) ; `isTaskAssignee` est la SEULE règle de droit d'agir. */
export interface WfPrincipal {
  /** Acteur effectif (`app_user_group.user_group_id`). */
  userGroupId: number;
  userId: number;
  /** `app_group.group_id` dont l'utilisateur est membre. */
  groupIds: readonly number[];
  /** Rôle ACTIF de l'utilisateur, sinon null. */
  roleId: number | null;
}

/** Auteur d'une transition journalisée. */
export interface WfActorRef {
  kind: 'system' | 'user' | 'agent';
  /** Obligatoire quand kind = 'user' (CHECK du journal). */
  userGroupId?: number;
}

/** Bénéficiaire d'une tâche : au plus un des trois (CHECK `ck_wf_task_assignee`). */
export interface WfAssigneeRef {
  userGroupId?: number | null;
  groupId?: number | null;
  roleId?: number | null;
}

export type WfEngineEventType =
  | 'instance.started'
  | 'instance.completed'
  | 'instance.failed'
  | 'instance.cancelled'
  | 'instance.suspended'
  | 'instance.resumed'
  | 'task.assigned' // nouvelle tâche ou ré-affectation : notifier le bénéficiaire
  | 'task.completed'
  | 'task.rejected'
  | 'task.delegated';

/**
 * Événement émis APRÈS validation de la transaction (jamais avant). Les consommateurs (notifications,
 * boîte temps réel) ne doivent jamais faire échouer l'action métier.
 */
export interface WfEngineEvent {
  type: WfEngineEventType;
  instanceId: string;
  taskId?: string;
  inboxItemId?: string;
  stepKey?: string;
  /** Bénéficiaire à notifier (task.assigned, task.delegated). */
  assignee?: WfAssigneeRef;
  /** Lanceur de l'instance (instance.* : à informer de l'issue). */
  startedBy?: number;
  title?: string;
  /** Texte court en français, prêt à afficher. */
  message?: string;
}

export interface WfTransitionResult {
  instance: WfInstanceDto;
  closedTasks: WfTaskDto[];
  openedTasks: WfTaskDto[];
  events: WfEngineEvent[];
}

// ---------------------------------------------------------------------------
// Extension : exécuteurs de tâches (W2 y branchera 'agent')
// ---------------------------------------------------------------------------

export interface WfExecutorContext {
  instanceId: string;
  taskId: string;
  attempt: number;
  step: WfStep;
  /** Contexte de l'instance : { input, steps, last, assignedTo? }. Lecture seule. */
  context: Readonly<Record<string, unknown>>;
  /** Droits d'exécution : ceux du lanceur (`started_by`), JAMAIS davantage. */
  runAs: { userGroupId: number };
  /** (Ajout W2) Définition et VERSION de l'instance (config d'agent, jeu d'évaluation, budget par workflow). */
  definitionId: number;
  definitionVersionId: number;
  /** (Ajout W2) Objet lié de l'instance (courrier, document…), s'il existe. */
  subject: { type: string | null; id: string | null };
}

/**
 * (Ajout W2) Éléments d'audit d'une action d'agent, copiés dans le journal (`wf_event_log`). Jamais de
 * contenu de document ni de secret : instruction masquée, sources résumées. Tout champ absent reste nul.
 */
export interface WfAgentAudit {
  instruction?: string;
  sources?: unknown;
  decision?: unknown;
  confidence?: number;
  /** 0 suggère, 1 agit avec validation, 2 autonome. */
  autonomyLevel?: 0 | 1 | 2;
  model?: string | null;
  /** Identifiant décimal de `ged_ai_decision` (BigInt en chaîne). */
  aiDecisionId?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  costAmount?: number | null;
}

export type WfExecutorOutcome =
  /** Rien à faire seul : la tâche reste ouverte pour son bénéficiaire (comportement humain). */
  | {
      kind: 'wait';
      /** (Ajout W2) Escalade d'une étape agent : journalisée (`agent.escalated`) avant le passage à l'humain. */
      escalation?: { reason: string; explanation: string; audit?: WfAgentAudit };
    }
  /** Résultat produit : le moteur termine la tâche (acteur 'agent'/'system') et avance. */
  | { kind: 'complete'; result: unknown; explanation?: string; audit?: WfAgentAudit }
  /** Proposition à valider par un humain : déposée dans `wf_inbox_item` (kind = 1) ; tâche ouverte. */
  | {
      kind: 'propose';
      proposal: unknown;
      explanation?: string;
      sources?: unknown;
      confidence?: number;
      audit?: WfAgentAudit;
    }
  | { kind: 'fail'; error: string };

export interface WfTaskExecutor {
  /** Clé de type de tâche prise en charge (`WF_TASK_TYPE_KEYS` : 'agent', 'generation'…). */
  readonly taskType: string;
  /** Appelé APRÈS le commit de la transaction qui a créé la tâche, HORS transaction. */
  execute(ctx: WfExecutorContext): Promise<WfExecutorOutcome>;
}

export interface WfTaskExecutorRegistry {
  register(executor: WfTaskExecutor): void;
  get(taskType: string): WfTaskExecutor | undefined;
  has(taskType: string): boolean;
}

/** Port facultatif (annuaire). Absent => vérifications sautées. */
export interface WfDirectory {
  /** L'acteur existe et son compte n'est pas désactivé. */
  isUserGroupActive(userGroupId: number): Promise<boolean>;
  /** Propriétaire d'un objet lié (`assignee.kind = 'subject_owner'`) ; null si inconnu. */
  resolveSubjectOwner?(subjectType: string, subjectId: string): Promise<number | null>;
  /**
   * (Ajout W1, facultatif) Libellé lisible d'un acteur (« Prénom Nom ») pour l'explication des éléments
   * de boîte ; null / absent => « l'utilisateur n°… ». Ne doit renvoyer aucune donnée sensible.
   */
  describeUserGroup?(userGroupId: number): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// (Ajout W6) Applicateur d'effets : actions préparées par un agent, appliquées à la validation humaine
// ---------------------------------------------------------------------------

/** Action préparée validée (même forme que `WfPreparedAction` des agents), déjà filtrée par le moteur. */
export interface WfEffectAction {
  tool: string;
  arguments: Record<string, unknown>;
  sideEffect: 0 | 1 | 2;
  requiresValidation: boolean;
  preview: string;
}

/** Entrée de l'applicateur : TOUTE écriture passe par `tx` (transaction de la validation). */
export interface WfEffectApplyInput {
  tx: Prisma.TransactionClient;
  now: Date;
  instanceId: string;
  taskId: string;
  stepKey: string;
  definitionVersionId: number;
  subject: { type: string | null; id: string | null };
  /** `context.input` de l'instance (lecture seule). */
  input: Readonly<Record<string, unknown>>;
  /** `step.config` de l'étape agent (lecture seule). */
  stepConfig: Readonly<Record<string, unknown>>;
  /** Humain qui valide (bénéficiaire de la tâche). */
  validator: WfPrincipal;
  /** Lanceur de l'instance (`started_by`) : ses droits bornent aussi l'effet. */
  launcherUserGroupId: number;
  outcome: 'accepted' | 'modified';
  actions: readonly WfEffectAction[];
}

/** Effet résumé (jamais de contenu de courrier). `skipped` (pas d'applicateur) : refusé par le moteur (échec fermé). */
export interface WfEffectSummary {
  tool: string;
  summary: Record<string, unknown>;
  skipped?: boolean;
}

export interface WfEffectApplyOutput {
  effects: WfEffectSummary[];
  /** Annulation des effets NON transactionnels, appelée si la transaction échoue ensuite. Ne lève jamais. */
  compensate?: () => Promise<void>;
}

export interface WfEffectApplierPort {
  /** Lève `WfEffectApplyError` (refus explicable) ; toute autre erreur est un échec technique. */
  apply(input: WfEffectApplyInput): Promise<WfEffectApplyOutput>;
}

/** Source de l'applicateur (support mutable : branché après la construction du moteur). */
export interface WfEffectApplierSource {
  get(): WfEffectApplierPort | undefined;
}

/**
 * Refus d'appliquer : message en français SANS contenu de courrier. Le moteur le traduit en
 * `WfEngineError('INVALID_INPUT', message, { code, tool })` ; la transaction est annulée, puis les
 * compensations déjà collectées (`compensate`) sont appelées.
 */
export class WfEffectApplyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly tool: string | null = null,
    readonly compensate?: () => Promise<void>,
  ) {
    super(message);
    this.name = 'WfEffectApplyError';
  }
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export interface WfInstanceDetail {
  instance: WfInstanceDto;
  definitionName: string;
  versionNumber: number;
  tasks: WfTaskDto[];
  /** Journal chronologique (plus ancien d'abord), borné par `eventLimit`. */
  events: WfEventLogDto[];
  inboxItems: WfInboxItemDto[];
}

export interface WfInboxEntry {
  item: WfInboxItemDto;
  task: Pick<WfTaskDto, 'wfTaskId' | 'stepKey' | 'taskType' | 'status' | 'attempt' | 'dueAt' | 'instructions'>;
  definitionName: string;
  instanceStatus: WfInstanceStatus;
}

export interface WfInboxFilter {
  /** Défaut : ouvertes et prises en charge (statuts 0 et 1). */
  statuses?: number[];
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Moteur
// ---------------------------------------------------------------------------

export interface WfStartInstanceInput {
  definitionId: number;
  /** `user_group_id` dont les droits s'appliquent à toute l'exécution. */
  startedBy: number;
  /** Données d'entrée : rangées dans `context.input`. */
  context?: Record<string, unknown>;
  subjectType?: string | null;
  subjectId?: string | null;
  /** Rejouer la même clé ne crée pas de doublon (unique par définition). */
  idempotencyKey?: string | null;
  triggerId?: number | null;
  dueAt?: Date | null;
}

export interface WfStartInstanceResult extends WfTransitionResult {
  /** false si l'instance existait déjà pour cette clé d'idempotence (même lanceur). */
  created: boolean;
}

export interface WorkflowEngineApi {
  /** Crée l'instance sur la version PUBLIÉE de la définition et entre dans l'étape de départ. */
  startInstance(input: WfStartInstanceInput): Promise<WfStartInstanceResult>;

  getInstanceDetail(instanceId: string, opts?: { eventLimit?: number }): Promise<WfInstanceDetail | null>;
  listInstances(filter: {
    startedBy?: number;
    definitionId?: number;
    statuses?: number[];
    limit: number;
    offset: number;
  }): Promise<{ items: WfInstanceDto[]; total: number }>;
  /** Éléments dont le bénéficiaire est l'utilisateur, l'un de ses groupes ou son rôle actif — rien d'autre. */
  listInbox(principal: WfPrincipal, filter: WfInboxFilter): Promise<{ items: WfInboxEntry[]; total: number }>;

  /** Prend en charge un élément de boîte (réserve la tâche à celui qui la prend). */
  claimTask(input: { taskId: string; principal: WfPrincipal }): Promise<WfTransitionResult>;
  /** Termine la tâche avec un résultat validé par son type, puis avance dans le graphe. */
  completeTask(input: {
    taskId: string;
    principal: WfPrincipal;
    result: unknown;
    expectedRowVersion?: number;
  }): Promise<WfTransitionResult>;
  /** Refus : tâche close avec `{ rejected: true, approved: false, comment }` ; seules les arêtes CONDITIONNÉES s'appliquent. */
  rejectTask(input: { taskId: string; principal: WfPrincipal; comment?: string }): Promise<WfTransitionResult>;
  /** Ré-affecte la tâche à un autre utilisateur (l'appelant doit en être l'assigné). */
  delegateTask(input: {
    taskId: string;
    principal: WfPrincipal;
    toUserGroupId: number;
    comment?: string;
  }): Promise<WfTransitionResult>;

  cancelInstance(input: { instanceId: string; actor: WfActorRef; reason?: string }): Promise<WfTransitionResult>;
  suspendInstance(input: { instanceId: string; actor: WfActorRef; reason?: string }): Promise<WfTransitionResult>;
  resumeInstance(input: { instanceId: string; actor: WfActorRef }): Promise<WfTransitionResult>;

  /**
   * Reprise après redémarrage de l'api : relance les exécuteurs des tâches ouvertes qui en ont un
   * (jamais pour les tâches humaines). Renvoie le nombre de tâches relancées.
   */
  rescanExecutors(): Promise<number>;
}
