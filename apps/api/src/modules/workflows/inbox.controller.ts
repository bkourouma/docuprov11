import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { WfInboxEntry, WfTransitionResult } from './engine/engine.types';
import { InboxService } from './inbox.service';
import {
  bigintIdSchema,
  completeTaskSchema,
  delegateTaskSchema,
  listInboxQuerySchema,
  rejectTaskSchema,
  type CompleteTaskBody,
  type DelegateTaskBody,
  type ListInboxQuery,
  type RejectTaskBody,
  zodPipe,
} from './workflows.dto';

const itemIdPipe = new ZodValidationPipe(bigintIdSchema);

/**
 * Boîte de tâches de l'utilisateur. VOLONTAIREMENT sans `MenuPermissionGuard` ni `@RequireMenu` : le
 * `JwtAuthGuard` global suffit, le périmètre est l'assignation (bénéficiaire = l'utilisateur, l'un de ses
 * groupes ou son rôle actif) et les identités sans `userGroupId` (clé de l'agent de numérisation) sont
 * refusées par le service. Aucun droit d'administrateur ici. Les identifiants de chemin sont des ids
 * d'ÉLÉMENT de boîte.
 */
@Controller('workflows/inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  list(
    @Query(zodPipe(listInboxQuerySchema)) query: ListInboxQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<{ items: WfInboxEntry[]; total: number }> {
    return this.inbox.list(user, query);
  }

  @Post(':itemId/claim')
  @HttpCode(200)
  claim(@Param('itemId', itemIdPipe) itemId: string, @CurrentUser() user: AuthUser): Promise<WfTransitionResult> {
    return this.inbox.claim(user, itemId);
  }

  @Post(':itemId/complete')
  @HttpCode(200)
  complete(
    @Param('itemId', itemIdPipe) itemId: string,
    @Body(zodPipe(completeTaskSchema)) body: CompleteTaskBody,
    @CurrentUser() user: AuthUser,
  ): Promise<WfTransitionResult> {
    return this.inbox.complete(user, itemId, body);
  }

  @Post(':itemId/reject')
  @HttpCode(200)
  reject(
    @Param('itemId', itemIdPipe) itemId: string,
    @Body(zodPipe(rejectTaskSchema)) body: RejectTaskBody,
    @CurrentUser() user: AuthUser,
  ): Promise<WfTransitionResult> {
    return this.inbox.reject(user, itemId, body);
  }

  @Post(':itemId/delegate')
  @HttpCode(200)
  delegate(
    @Param('itemId', itemIdPipe) itemId: string,
    @Body(zodPipe(delegateTaskSchema)) body: DelegateTaskBody,
    @CurrentUser() user: AuthUser,
  ): Promise<WfTransitionResult> {
    return this.inbox.delegate(user, itemId, body);
  }
}
