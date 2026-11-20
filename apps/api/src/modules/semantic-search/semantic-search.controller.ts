import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type {
  GedAskRequest,
  GedAskResponse,
  GedSemanticSearchRequest,
  GedSemanticSearchResponse,
} from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireAdmin, RequireMenu } from '../auth/require-menu.decorator';
import {
  gedAskRequestSchema,
  gedSemanticSearchRequestSchema,
  semanticReindexRequestSchema,
  type SemanticReindexRequest,
} from './semantic-search.dto';
import { SEMANTIC_SEARCH_MENU } from './semantic-search.menus';
import { SemanticRateLimit, SemanticRateLimitGuard } from './semantic-rate-limit.guard';
import { SemanticSearchService } from './semantic-search.service';

/**
 * Recherche sémantique et questions-réponses. Accès refusé par défaut : sans le menu
 * « Recherche IA », 403 (aucun `@Public`). Les droits sur les documents sont appliqués dans la
 * requête SQL du service, pas ici.
 */
@Controller('semantic-search')
@UseGuards(MenuPermissionGuard, SemanticRateLimitGuard)
export class SemanticSearchController {
  constructor(private readonly service: SemanticSearchService) {}

  @Post()
  @HttpCode(200)
  @RequireMenu(SEMANTIC_SEARCH_MENU)
  @SemanticRateLimit('search')
  search(
    @Body(new ZodValidationPipe<GedSemanticSearchRequest>(gedSemanticSearchRequestSchema as never))
    body: GedSemanticSearchRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<GedSemanticSearchResponse> {
    return this.service.search(body, user);
  }

  @Post('ask')
  @HttpCode(200)
  @RequireMenu(SEMANTIC_SEARCH_MENU)
  @SemanticRateLimit('ask')
  ask(
    @Body(new ZodValidationPipe(gedAskRequestSchema)) body: GedAskRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<GedAskResponse> {
    return this.service.ask(body, user);
  }

  /** Réindexation : administrateurs uniquement ; `{}` = tout, `{ documentId }` = un document. */
  @Post('reindex')
  @HttpCode(200)
  @RequireAdmin()
  reindex(
    @Body(new ZodValidationPipe(semanticReindexRequestSchema)) body: SemanticReindexRequest,
    @CurrentUser() user: AuthUser,
  ) {
    return body.documentId !== undefined
      ? this.service.reindexDocument(body.documentId, user)
      : this.service.reindexAll(user);
  }
}
