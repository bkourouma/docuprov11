import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type {
  AsstConfirmProposalResponse,
  AsstConversationDetailResponse,
  AsstCreateConversationResponse,
  AsstGetProposalResponse,
  AsstListConversationsResponse,
  AsstPostMessageResponse,
  AsstRefuseProposalResponse,
} from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { AssistantErrorFilter } from './assistant-error.filter';
import {
  ASST_CONVERSATIONS,
  ASST_EXECUTOR,
  ASST_IDENTITY,
  type AsstConversationsPort,
  type AsstExecutorPort,
  type AsstIdentityPort,
} from './assistant.contracts';
import { ASSISTANT_MENU } from './assistant.menus';
import {
  confirmProposalPipe,
  conversationIdPipe,
  createConversationPipe,
  listConversationsPipe,
  postMessagePipe,
  proposalIdPipe,
  refuseProposalPipe,
  type AsstConfirmProposalBody,
  type AsstCreateConversationBody,
  type AsstListConversationsQuery,
  type AsstPostMessageBody,
  type AsstRefuseProposalBody,
} from './dto/assistant.dto';

/**
 * Assistant « qui agit ». Accès refusé par défaut : `MenuPermissionGuard` + menu `/assistant`. Le contrôleur
 * ne porte AUCUNE logique métier : il valide l'entrée (zod, 422 `invalid_input`), résout l'identité de
 * l'utilisateur du JETON (relue en base) puis délègue. Les routes de conversation vont à ASST_CONVERSATIONS,
 * celles des propositions à ASST_EXECUTOR. Catalogue des routes : `ASST_ROUTES` (@archivage/types).
 */
@Controller('assistant')
@UseGuards(MenuPermissionGuard)
@UseFilters(AssistantErrorFilter)
@RequireMenu(ASSISTANT_MENU)
export class AssistantController {
  constructor(
    @Inject(ASST_IDENTITY) private readonly identity: AsstIdentityPort,
    @Inject(ASST_CONVERSATIONS) private readonly conversations: AsstConversationsPort,
    @Inject(ASST_EXECUTOR) private readonly executor: AsstExecutorPort,
  ) {}

  @Post('conversations')
  async createConversation(
    @Body(createConversationPipe) body: AsstCreateConversationBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstCreateConversationResponse> {
    return this.conversations.create(await this.identity.resolve(user), body);
  }

  @Get('conversations')
  async listConversations(
    @Query(listConversationsPipe) query: AsstListConversationsQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstListConversationsResponse> {
    return this.conversations.list(await this.identity.resolve(user), query);
  }

  @Get('conversations/:id')
  async getConversation(
    @Param('id', conversationIdPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstConversationDetailResponse> {
    return this.conversations.detail(await this.identity.resolve(user), id);
  }

  @Post('conversations/:id/messages')
  async postMessage(
    @Param('id', conversationIdPipe) id: string,
    @Body(postMessagePipe) body: AsstPostMessageBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstPostMessageResponse> {
    return this.conversations.postMessage(await this.identity.resolve(user), id, body);
  }

  @Post('proposals/:id/confirm')
  @HttpCode(200)
  async confirmProposal(
    @Param('id', proposalIdPipe) id: string,
    @Body(confirmProposalPipe) body: AsstConfirmProposalBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstConfirmProposalResponse> {
    return this.executor.confirm(await this.identity.resolve(user), id, body);
  }

  @Post('proposals/:id/refuse')
  @HttpCode(200)
  async refuseProposal(
    @Param('id', proposalIdPipe) id: string,
    @Body(refuseProposalPipe) body: AsstRefuseProposalBody,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstRefuseProposalResponse> {
    return this.executor.refuse(await this.identity.resolve(user), id, body.reason);
  }

  @Get('proposals/:id')
  async getProposal(
    @Param('id', proposalIdPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<AsstGetProposalResponse> {
    return this.executor.get(await this.identity.resolve(user), id);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async deleteConversation(@Param('id', conversationIdPipe) id: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.conversations.remove(await this.identity.resolve(user), id);
  }
}
