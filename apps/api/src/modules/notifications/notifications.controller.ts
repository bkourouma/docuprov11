import { Controller, Get, Param, ParseIntPipe, Patch, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { NotificationsService } from './notifications.service';
import { notificationListQuerySchema, type NotificationListQueryDto } from './notifications.dto';

/**
 * Inbox de l'utilisateur courant + badge (comptage non-lus). Protégé par le JwtAuthGuard global :
 * chaque acteur ne voit que SES propres notifications (recipientUserGroupId = son user_group).
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(notificationListQuerySchema)) q: NotificationListQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    if (user.userGroupId == null) return { total: 0, unread: 0, page: 1, pageSize: 20, rows: [] };
    return this.service.list(user.userGroupId, {
      unreadOnly: q.unreadOnly === 'true',
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser): Promise<{ count: number }> {
    const count = user.userGroupId == null ? 0 : await this.service.unreadCount(user.userGroupId);
    return { count };
  }

  @Patch(':id/read')
  markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    if (user.userGroupId == null) return { updated: 0 };
    return this.service.markRead(id, user.userGroupId, new Date());
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    if (user.userGroupId == null) return { updated: 0 };
    return this.service.markAllRead(user.userGroupId, new Date());
  }
}
