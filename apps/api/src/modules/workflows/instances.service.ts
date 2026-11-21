import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { WfInstanceDto } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import type {
  WfActorRef,
  WfInstanceDetail,
  WfPrincipal,
  WfTransitionResult,
  WorkflowEngineApi,
} from './engine/engine.types';
import { WorkflowEventsPublisher } from './extension/workflow-events';
import { SubjectAccessRegistry } from './extension/subject-access';
import { PrincipalService } from './principal.service';
import { WF_ENGINE } from './workflows.tokens';
import type { LaunchInstanceBody, ListInstancesQuery } from './workflows.dto';
import { withEngineErrors } from './workflow-errors';

export interface LaunchResult {
  created: boolean;
  instance: WfInstanceDto;
}

type VisibleInstance = {
  detail: WfInstanceDetail;
  principal: WfPrincipal;
  isStarter: boolean;
  isAdminMenu: boolean;
};

/**
 * Instances de workflow : lancement, lecture, annulation / suspension / reprise.
 *
 * Droits (accès refusé par défaut) :
 *  - le lanceur est TOUJOURS l'utilisateur authentifié (jamais un autre) ;
 *  - lecture : lanceur, assigné d'une des tâches (utilisateur, groupe ou rôle) ou détenteur du menu
 *    ADMIN ; sinon 404 (l'existence n'est pas révélée) ;
 *  - annuler / suspendre / reprendre : lanceur ou détenteur du menu ADMIN ; un assigné qui peut lire
 *    mais n'est pas lanceur reçoit 403. Ce pouvoir ne donne AUCUN droit sur les tâches (boîte).
 */
@Injectable()
export class InstancesService {
  constructor(
    @Inject(WF_ENGINE) private readonly engine: WorkflowEngineApi,
    private readonly principals: PrincipalService,
    private readonly events: WorkflowEventsPublisher,
    private readonly subjects: SubjectAccessRegistry,
  ) {}

  async launch(user: AuthUser, body: LaunchInstanceBody): Promise<LaunchResult> {
    const principal = await this.principals.buildPrincipal(user);
    await this.subjects.assertAccess(
      { userGroupId: principal.userGroupId, userId: principal.userId },
      body.subjectType,
      body.subjectId,
    );
    const result = await withEngineErrors(() =>
      this.engine.startInstance({
        definitionId: body.definitionId,
        startedBy: principal.userGroupId,
        context: body.context,
        subjectType: body.subjectType ?? null,
        subjectId: body.subjectId ?? null,
        idempotencyKey: body.idempotencyKey ?? null,
      }),
    );
    // Rejeu d'une clé déjà utilisée : rien n'a été écrit, donc aucun événement à publier.
    if (result.created) await this.events.publish(result.events);
    return { created: result.created, instance: result.instance };
  }

  async list(user: AuthUser, query: ListInstancesQuery): Promise<{ items: WfInstanceDto[]; total: number }> {
    const principal = await this.principals.buildPrincipal(user);
    const seeAll = !query.mine && (await this.principals.hasAdminMenu(user));
    return withEngineErrors(() =>
      this.engine.listInstances({
        startedBy: seeAll ? undefined : principal.userGroupId,
        definitionId: query.definitionId,
        statuses: query.status === undefined ? undefined : [query.status],
        limit: query.limit,
        offset: query.offset,
      }),
    );
  }

  async detail(user: AuthUser, instanceId: string): Promise<WfInstanceDetail> {
    return (await this.loadVisible(user, instanceId)).detail;
  }

  cancel(user: AuthUser, instanceId: string, reason?: string): Promise<WfTransitionResult> {
    return this.transition(user, instanceId, (actor) =>
      this.engine.cancelInstance({ instanceId, actor, reason }),
    );
  }

  suspend(user: AuthUser, instanceId: string, reason?: string): Promise<WfTransitionResult> {
    return this.transition(user, instanceId, (actor) =>
      this.engine.suspendInstance({ instanceId, actor, reason }),
    );
  }

  resume(user: AuthUser, instanceId: string): Promise<WfTransitionResult> {
    return this.transition(user, instanceId, (actor) => this.engine.resumeInstance({ instanceId, actor }));
  }

  private async transition(
    user: AuthUser,
    instanceId: string,
    run: (actor: WfActorRef) => Promise<WfTransitionResult>,
  ): Promise<WfTransitionResult> {
    const v = await this.loadVisible(user, instanceId);
    if (!v.isStarter && !v.isAdminMenu) {
      throw new ForbiddenException("Seul le lanceur ou un administrateur des workflows peut agir sur cette instance.");
    }
    const result = await withEngineErrors(() => run({ kind: 'user', userGroupId: v.principal.userGroupId }));
    await this.events.publish(result.events);
    return result;
  }

  /** Charge l'instance ou répond 404 si l'utilisateur n'a aucun droit de lecture dessus. */
  private async loadVisible(user: AuthUser, instanceId: string): Promise<VisibleInstance> {
    const principal = await this.principals.buildPrincipal(user);
    const detail = await withEngineErrors(() => this.engine.getInstanceDetail(instanceId));
    if (!detail) throw new NotFoundException('Instance introuvable.');

    const isStarter = detail.instance.startedBy === principal.userGroupId;
    const isAssignee = detail.tasks.some(
      (t) =>
        t.assigneeUserGroupId === principal.userGroupId ||
        (t.assigneeGroupId != null && principal.groupIds.includes(t.assigneeGroupId)) ||
        (t.assigneeRoleId != null && t.assigneeRoleId === principal.roleId),
    );
    const isAdminMenu = await this.principals.hasAdminMenu(user);
    if (!isStarter && !isAssignee && !isAdminMenu) {
      throw new NotFoundException('Instance introuvable.');
    }
    return { detail, principal, isStarter, isAdminMenu };
  }
}
