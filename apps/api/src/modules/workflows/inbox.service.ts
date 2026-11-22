import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { WfInboxEntry, WfPrincipal, WfTransitionResult, WorkflowEngineApi } from './engine/engine.types';
import { WorkflowEventsPublisher } from './extension/workflow-events';
import { PrincipalService } from './principal.service';
import type { CompleteTaskBody, DelegateTaskBody, ListInboxQuery, RejectTaskBody } from './workflows.dto';
import { WF_ENGINE } from './workflows.tokens';
import { withEngineErrors } from './workflow-errors';

/**
 * Boîte de tâches. Le périmètre est l'ASSIGNATION : seuls les éléments dont l'utilisateur (ou l'un de ses
 * groupes, ou son rôle actif) est le bénéficiaire sont visibles et actionnables.
 *
 * Aucun passe-droit : ni `isAdmin`, ni le menu ADMIN des workflows n'ouvrent la boîte d'autrui, et ce
 * service ne contourne jamais `isTaskAssignee` du moteur (qui reste l'autorité finale).
 *
 * Choix de réponse : un élément inexistant OU n'appartenant pas à l'utilisateur donne 404 (jamais 403)
 * pour ne pas révéler son existence. Les refus 403 ne viennent que du moteur (ex. tâche déjà prise par
 * un autre membre du même groupe).
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(WF_ENGINE) private readonly engine: WorkflowEngineApi,
    private readonly prisma: PrismaService,
    private readonly principals: PrincipalService,
    private readonly events: WorkflowEventsPublisher,
  ) {}

  async list(user: AuthUser, query: ListInboxQuery): Promise<{ items: WfInboxEntry[]; total: number }> {
    const principal = await this.principals.buildPrincipal(user);
    return withEngineErrors(() =>
      this.engine.listInbox(principal, { statuses: query.status, limit: query.limit, offset: query.offset }),
    );
  }

  async claim(user: AuthUser, itemId: string): Promise<WfTransitionResult> {
    const { principal, taskId } = await this.resolve(user, itemId);
    return this.run(() => this.engine.claimTask({ taskId, principal }));
  }

  async complete(user: AuthUser, itemId: string, body: CompleteTaskBody): Promise<WfTransitionResult> {
    const { principal, taskId } = await this.resolve(user, itemId);
    return this.run(() =>
      this.engine.completeTask({
        taskId,
        principal,
        result: body.result,
        expectedRowVersion: body.expectedRowVersion,
      }),
    );
  }

  async reject(user: AuthUser, itemId: string, body: RejectTaskBody): Promise<WfTransitionResult> {
    const { principal, taskId } = await this.resolve(user, itemId);
    return this.run(() => this.engine.rejectTask({ taskId, principal, comment: body.comment }));
  }

  async delegate(user: AuthUser, itemId: string, body: DelegateTaskBody): Promise<WfTransitionResult> {
    const { principal, taskId } = await this.resolve(user, itemId);
    if (body.toUserGroupId === principal.userGroupId) {
      throw new UnprocessableEntityException('Vous ne pouvez pas déléguer une tâche à vous-même.');
    }
    if (!(await this.principals.isActiveUserGroup(body.toUserGroupId))) {
      throw new UnprocessableEntityException('Le destinataire de la délégation doit être un utilisateur actif.');
    }
    return this.run(() =>
      this.engine.delegateTask({
        taskId,
        principal,
        toUserGroupId: body.toUserGroupId,
        comment: body.comment,
      }),
    );
  }

  private async run(fn: () => Promise<WfTransitionResult>): Promise<WfTransitionResult> {
    const result = await withEngineErrors(fn);
    await this.events.publish(result.events);
    return result;
  }

  /** Retrouve la tâche d'un élément de boîte ; 404 si l'élément n'est pas à l'utilisateur. */
  private async resolve(user: AuthUser, itemId: string): Promise<{ principal: WfPrincipal; taskId: string }> {
    const principal = await this.principals.buildPrincipal(user);
    const item = await this.prisma.wfInboxItem.findUnique({
      where: { wfInboxItemId: BigInt(itemId) },
      select: {
        taskId: true,
        assigneeUserGroupId: true,
        assigneeGroupId: true,
        assigneeRoleId: true,
        claimedBy: true,
      },
    });
    const mine =
      !!item &&
      (item.assigneeUserGroupId === principal.userGroupId ||
        item.claimedBy === principal.userGroupId ||
        (item.assigneeGroupId != null && principal.groupIds.includes(item.assigneeGroupId)) ||
        (item.assigneeRoleId != null && item.assigneeRoleId === principal.roleId));
    if (!item || !mine) throw new NotFoundException('Élément de boîte introuvable.');
    return { principal, taskId: item.taskId.toString() };
  }
}
