import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { WfAssigneeRef, WfEngineEvent } from '../engine/engine.types';
import { WorkflowEventsPublisher } from './workflow-events';

/** Plafond de destinataires par événement (bénéficiaire groupe / rôle étendu à ses membres). */
export const MAX_NOTIFIED_MEMBERS = 200;
/** `notification.target_id` est un INT : au-delà, on n'ajoute pas de lien. */
const INT32_MAX = 2_147_483_647;

const INSTANCE_MESSAGES: Record<string, string> = {
  'instance.completed': 'Votre workflow est terminé.',
  'instance.failed': "Votre workflow a échoué : consultez le détail de l'instance.",
  'instance.cancelled': 'Votre workflow a été annulé.',
  'instance.suspended': 'Votre workflow a été suspendu.',
};

/**
 * Notifie via `NotificationsService` APRÈS commit (appelé par `WorkflowEventsPublisher`) :
 *  - task.assigned / task.delegated : le bénéficiaire ; un groupe ou un rôle est étendu à ses membres
 *    actifs (plafond {@link MAX_NOTIFIED_MEMBERS}) ;
 *  - instance.completed / failed / cancelled / suspended : le lanceur.
 * Un échec de notification (un destinataire ou tous) est journalisé et n'interrompt rien.
 */
@Injectable()
export class WorkflowNotificationsListener implements OnModuleInit {
  private readonly logger = new Logger(WorkflowNotificationsListener.name);

  constructor(
    private readonly publisher: WorkflowEventsPublisher,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.publisher.subscribe((events) => this.handle(events));
  }

  async handle(events: readonly WfEngineEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.handleOne(event);
      } catch (err) {
        this.logger.error(
          `notification workflow ${event.type} en échec (ignorée) : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleOne(event: WfEngineEvent): Promise<void> {
    if (event.type === 'task.assigned' || event.type === 'task.delegated') {
      if (!event.assignee) return;
      const recipients = await this.expandAssignee(event.assignee);
      const title = event.title ?? 'Tâche de workflow';
      const message =
        event.message ??
        (event.type === 'task.delegated'
          ? `Une tâche vous a été déléguée : ${title}.`
          : `Nouvelle tâche à traiter : ${title}.`);
      await this.notifyAll(recipients, message, event.taskId);
      return;
    }
    const fallback = INSTANCE_MESSAGES[event.type];
    if (fallback && event.startedBy != null) {
      await this.notifyAll([event.startedBy], event.message ?? fallback, undefined);
    }
  }

  /** Utilisateur => lui-même ; groupe / rôle => `user_group_id` des membres actifs (plafonné). */
  async expandAssignee(assignee: WfAssigneeRef): Promise<number[]> {
    if (assignee.userGroupId != null) return [assignee.userGroupId];
    if (assignee.groupId != null) {
      const rows = await this.prisma.appUserGroup.findMany({
        where: { groupId: assignee.groupId, group: { isActive: true }, user: { isDisabled: false } },
        select: { userGroupId: true },
        orderBy: { userGroupId: 'asc' },
        take: MAX_NOTIFIED_MEMBERS,
      });
      return [...new Set(rows.map((r) => r.userGroupId))];
    }
    if (assignee.roleId != null) {
      const rows = await this.prisma.appUserGroup.findMany({
        where: { user: { roleId: assignee.roleId, isDisabled: false, role: { isActive: true } } },
        select: { userGroupId: true },
        orderBy: { userGroupId: 'asc' },
        take: MAX_NOTIFIED_MEMBERS,
      });
      return [...new Set(rows.map((r) => r.userGroupId))];
    }
    return [];
  }

  private async notifyAll(recipients: readonly number[], message: string, taskId: string | undefined): Promise<void> {
    const parsed = taskId !== undefined && /^\d{1,18}$/.test(taskId) ? Number(taskId) : null;
    const targetId = parsed !== null && parsed <= INT32_MAX ? parsed : null;
    const results = await Promise.allSettled(
      recipients.map((recipientUserGroupId) =>
        this.notifications.create({
          recipientUserGroupId,
          message,
          targetType: 'workflow_task',
          targetId,
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger.error(
          `notification workflow non envoyée (ignorée) : ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    }
  }
}
