import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SubjectAccessRegistry } from '../../workflows/extension/subject-access';
import type { WfTriggerStarter } from '../../workflows/extension/trigger-starter';
import { PrincipalService } from '../../workflows/principal.service';
import { WF_TRIGGER_STARTER } from '../../workflows/workflows.tokens';
import { WorkflowEventBus } from '../bus/workflow-event-bus';
import { matchesConditions, parseTriggerConditions, resolveLimits } from '../domain/conditions';
import { WF_TRIGGER_MAX_CONSECUTIVE_FAILURES, type WfDomainEvent } from '../domain/contracts';
import { buildInstanceInput, triggerIdempotencyKey } from '../domain/events';
import { WF_EMERGENCY_STOP_GATE, type WfEmergencyStopGate } from './emergency-stop';
import { TriggerFailureTracker } from './trigger-failure-tracker';

/** Jeton de l'horloge (millisecondes epoch), remplaçable dans les tests. */
export const WF_TRIGGER_CLOCK = 'WF_TRIGGER_CLOCK';

export type DispatchStatus =
  | 'started'
  | 'duplicate'
  | 'no_match'
  | 'stopped'
  | 'cap_reached'
  | 'launcher_inactive'
  | 'subject_denied'
  | 'definition_unavailable'
  | 'invalid_config'
  | 'auto_disabled'
  | 'error';

export interface DispatchOutcome {
  triggerId: number;
  status: DispatchStatus;
  instanceId?: string;
}

/** Nombre maximal de déclencheurs évalués pour un même événement. */
const MAX_TRIGGERS_PER_EVENT = 200;
/** Un même message de journal (déclencheur, nature) n'est écrit qu'une fois par cette durée. */
const JOURNAL_WINDOW_MS = 5 * 60_000;
const JOURNAL_MAX_KEYS = 10_000;
const ACTOR_NAME = 'Déclencheur workflow';

interface TriggerRow {
  wfTriggerId: number;
  definitionId: number;
  eventType: string;
  conditions: unknown;
  runAsUserGroupId: number;
  updatedAt: Date;
}

/**
 * Répartiteur des déclencheurs par événement. Pour chaque événement du bus, évalue les déclencheurs actifs du
 * type et lance leur workflow avec les droits du compte `run_as` (jamais davantage), après toutes les
 * protections : conditions, arrêt d'urgence, idempotence, plafond, lanceur actif, accès à l'objet.
 *
 * `handle` ne lève JAMAIS. Les messages d'audit ne contiennent que des identifiants et des codes : jamais de
 * texte issu de l'événement (un courrier entrant est de la donnée, pas une instruction).
 */
@Injectable()
export class WorkflowTriggerDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowTriggerDispatcher.name);
  private readonly tracker: TriggerFailureTracker;
  private readonly journalSeen = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: WorkflowEventBus,
    private readonly principals: PrincipalService,
    private readonly subjects: SubjectAccessRegistry,
    @Inject(WF_TRIGGER_STARTER) private readonly starter: WfTriggerStarter,
    @Inject(WF_EMERGENCY_STOP_GATE) private readonly gate: WfEmergencyStopGate,
    private readonly audit: AuditService,
    @Optional() tracker?: TriggerFailureTracker,
    @Optional() @Inject(WF_TRIGGER_CLOCK) private readonly clock: () => number = () => Date.now(),
  ) {
    this.tracker = tracker ?? new TriggerFailureTracker();
  }

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe(async (event) => {
      await this.handle(event);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Évalue tous les déclencheurs concernés par l'événement, un par un. Ne lève jamais. */
  async handle(event: WfDomainEvent): Promise<DispatchOutcome[]> {
    const outcomes: DispatchOutcome[] = [];
    let triggers: TriggerRow[];
    try {
      triggers = await this.prisma.wfTrigger.findMany({
        where: {
          isActive: true,
          eventType: event.type,
          ...(event.triggerId ? { wfTriggerId: event.triggerId } : {}),
        },
        select: {
          wfTriggerId: true,
          definitionId: true,
          eventType: true,
          conditions: true,
          runAsUserGroupId: true,
          updatedAt: true,
        },
        orderBy: { wfTriggerId: 'asc' },
        take: MAX_TRIGGERS_PER_EVENT,
      });
    } catch (err) {
      this.logger.error(`chargement des déclencheurs impossible (${event.type}) : ${errMessage(err)}`);
      return outcomes;
    }

    for (const trigger of triggers) {
      try {
        outcomes.push(await this.dispatchOne(trigger, event));
      } catch (err) {
        // Panne inattendue (base indisponible…) : PAS comptée comme un échec du déclencheur, sinon une coupure de
        // base désactiverait tous les déclencheurs.
        this.logger.error(`déclencheur n° ${trigger.wfTriggerId} : erreur inattendue : ${errMessage(err)}`);
        outcomes.push({ triggerId: trigger.wfTriggerId, status: 'error' });
      }
    }
    return outcomes;
  }

  // -------------------------------------------------------------------------

  private async dispatchOne(trigger: TriggerRow, event: WfDomainEvent): Promise<DispatchOutcome> {
    const id = trigger.wfTriggerId;
    const out = (status: DispatchStatus, instanceId?: string): DispatchOutcome =>
      instanceId === undefined ? { triggerId: id, status } : { triggerId: id, status, instanceId };

    // 2. Un humain a modifié ou réactivé le déclencheur : la série d'échecs repart de zéro.
    this.tracker.observe(id, trigger.updatedAt.getTime());

    // 3. Configuration invalide : échec compté.
    const parsed = parseTriggerConditions(event.type, trigger.conditions);
    if (!parsed.ok) {
      await this.journal(id, 'invalid_config', `Déclencheur n° ${id} : conditions invalides (${parsed.issues.length} anomalie(s)).`);
      return out(await this.recordFailure(trigger, 'invalid_config', 'invalid_config'));
    }
    const conditions = parsed.value;

    // 4. Conditions non satisfaites : silence total.
    if (!matchesConditions(conditions, event)) return out('no_match');

    // 5. Arrêt d'urgence (fail-closed si la barrière est en panne). Pas un échec du déclencheur.
    try {
      if (await this.gate.isStopped(trigger.definitionId)) {
        await this.journal(id, 'stopped', `Déclencheur n° ${id} : lancement bloqué par l'arrêt d'urgence.`, false);
        return out('stopped');
      }
    } catch (err) {
      this.logger.error(`déclencheur n° ${id} : barrière d'arrêt d'urgence indisponible, lancement refusé : ${errMessage(err)}`);
      return out('stopped');
    }

    // 6. Idempotence rapide (rejeu).
    const key = triggerIdempotencyKey(id, event);
    const existing = await this.prisma.wfInstance.findFirst({
      where: { definitionId: trigger.definitionId, idempotencyKey: key },
      select: { wfInstanceId: true },
    });
    if (existing) return out('duplicate');

    // 7. Boucle d'échecs d'instances : les N dernières instances du déclencheur ont toutes échoué. Seules comptent
    //    les instances démarrées APRÈS `updatedAt` (avancé par la désactivation automatique comme par la
    //    réactivation humaine ; `touchLastFired` le conserve) : une réactivation repart d'un compteur neuf.
    const recent = await this.prisma.wfInstance.findMany({
      where: { triggerId: id, startedAt: { gt: trigger.updatedAt } },
      orderBy: { startedAt: 'desc' },
      take: WF_TRIGGER_MAX_CONSECUTIVE_FAILURES,
      select: { status: true },
    });
    if (recent.length >= WF_TRIGGER_MAX_CONSECUTIVE_FAILURES && recent.every((r) => r.status === 3)) {
      return out(await this.disable(trigger, 'instances_en_echec'));
    }

    // 8. Plafond de lancements sur la fenêtre glissante. Pas un échec, ne désactive pas.
    const limits = resolveLimits(conditions);
    const since = new Date(this.clock() - limits.windowMinutes * 60_000);
    const launched = await this.prisma.wfInstance.count({ where: { triggerId: id, startedAt: { gte: since } } });
    if (launched >= limits.maxLaunches) {
      await this.journal(
        id,
        'cap_reached',
        `Déclencheur n° ${id} : plafond de ${limits.maxLaunches} lancement(s) par ${limits.windowMinutes} min atteint.`,
      );
      return out('cap_reached');
    }

    // 9. Le lanceur existe, est actif et possède le menu Lancer. Échec compté.
    const runAs = trigger.runAsUserGroupId;
    if (!(await this.principals.canLaunch(runAs))) {
      await this.journal(id, 'launcher_inactive', `Déclencheur n° ${id} : le compte d'exécution n° ${runAs} ne peut pas lancer de workflow.`);
      return out(await this.recordFailure(trigger, 'launcher_inactive', 'launcher_inactive'));
    }

    // 10. Accès du lanceur à l'objet. Pas une panne du déclencheur : aucun échec compté.
    try {
      await this.subjects.assertAccess({ userGroupId: runAs }, event.subjectType, event.subjectId);
    } catch (err) {
      if (err instanceof ForbiddenException) return out(await this.subjectDenied(id, event));
      throw err;
    }

    // 11. Lancement.
    try {
      const result = await this.starter.start({
        definitionId: trigger.definitionId,
        startedBy: runAs,
        idempotencyKey: key,
        triggerId: id,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        context: buildInstanceInput(id, event),
      });
      if (!result.created) return out('duplicate', result.instance.wfInstanceId);
      this.tracker.success(id);
      await this.touchLastFired(trigger);
      return out('started', result.instance.wfInstanceId);
    } catch (err) {
      if (err instanceof ConflictException) {
        await this.journal(
          id,
          'definition_unavailable',
          `Déclencheur n° ${id} : définition n° ${trigger.definitionId} indisponible (non publiée ou conflit).`,
        );
        return out(await this.recordFailure(trigger, 'definition_unavailable', 'definition_unavailable'));
      }
      if (err instanceof ForbiddenException) {
        if (/compte d'exécution/i.test(err.message)) {
          await this.journal(id, 'launcher_inactive', `Déclencheur n° ${id} : le compte d'exécution n° ${runAs} a été refusé au lancement.`);
          return out('launcher_inactive');
        }
        return out(await this.subjectDenied(id, event));
      }
      this.logger.error(`déclencheur n° ${id} : échec du lancement : ${errMessage(err)}`);
      return out(await this.recordFailure(trigger, 'error', 'error'));
    }
  }

  private async subjectDenied(id: number, event: WfDomainEvent): Promise<DispatchStatus> {
    await this.journal(
      id,
      'subject_denied',
      `Déclencheur n° ${id} : accès refusé à l'objet ${event.subjectType} n° ${event.subjectId} pour le compte d'exécution.`,
    );
    return 'subject_denied';
  }

  /** Compte un échec ; au seuil, désactive le déclencheur. Renvoie le statut final du résultat. */
  private async recordFailure(trigger: TriggerRow, reason: string, status: DispatchStatus): Promise<DispatchStatus> {
    this.tracker.fail(trigger.wfTriggerId, reason);
    if (this.tracker.reached(trigger.wfTriggerId)) return this.disable(trigger, reason);
    return status;
  }

  /** Désactive le déclencheur (idempotent) et écrit un journal NON rate-limité. */
  private async disable(trigger: TriggerRow, reason: string): Promise<DispatchStatus> {
    const id = trigger.wfTriggerId;
    try {
      await this.prisma.wfTrigger.updateMany({ where: { wfTriggerId: id, isActive: true }, data: { isActive: false } });
    } catch (err) {
      this.logger.error(`déclencheur n° ${id} : désactivation automatique impossible : ${errMessage(err)}`);
      return 'error';
    }
    const message = `Désactivation automatique du déclencheur n° ${id} : ${reason}`;
    this.logger.error(message);
    await this.writeAudit(id, 'auto_disabled', message);
    return 'auto_disabled';
  }

  private async touchLastFired(trigger: TriggerRow): Promise<void> {
    try {
      // Écriture ciblée sur `last_fired_at` : `updated_at` n'est JAMAIS touché (un lancement n'est pas une modification
      // humaine, et une modification humaine concurrente ne doit ni être écrasée ni perdre le reset du compteur).
      await this.prisma.$executeRaw`UPDATE "wf_trigger" SET "last_fired_at" = ${new Date(this.clock())} WHERE "wf_trigger_id" = ${trigger.wfTriggerId}`;
    } catch (err) {
      this.logger.warn(`déclencheur n° ${trigger.wfTriggerId} : lastFiredAt non mis à jour : ${errMessage(err)}`);
    }
  }

  /**
   * Journal d'audit + Logger, limité à une entrée par (déclencheur, nature) et par 5 minutes. Un échec du
   * journal ne remonte jamais.
   */
  private async journal(triggerId: number, kind: string, message: string, audit = true): Promise<void> {
    const now = this.clock();
    const key = `${triggerId}:${kind}`;
    const last = this.journalSeen.get(key);
    if (last !== undefined && now - last < JOURNAL_WINDOW_MS) return;
    if (this.journalSeen.size >= JOURNAL_MAX_KEYS) this.journalSeen.clear();
    this.journalSeen.set(key, now);
    this.logger.warn(message);
    if (audit) await this.writeAudit(triggerId, kind, message);
  }

  private async writeAudit(triggerId: number, kind: string, message: string): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: null,
        actorFullName: ACTOR_NAME,
        objectRef: `wf_trigger:${triggerId}`,
        oldValue: kind,
        newValue: message,
      });
    } catch (err) {
      this.logger.error(`journal d'audit du déclencheur n° ${triggerId} impossible : ${errMessage(err)}`);
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
