import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type {
  GedDraftCreateDocumentResponse,
  GedDraftResponse,
  GedDraftTemplateDetail,
  GedDraftTemplatesResponse,
} from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { DraftingRateLimitGuard } from './drafting-rate-limit.guard';
import {
  gedDraftCreateDocumentSchema,
  gedDraftRequestSchema,
  type GedDraftCreateDocumentRequest,
  type GedDraftRequest,
} from './drafting.dto';
import { DraftingService } from './drafting.service';

/** Rédaction assistée : JWT global (aucun `@Public`) ; droits sur les documents dans le service. */
@Controller('drafting')
export class DraftingController {
  constructor(private readonly service: DraftingService) {}

  @Get('templates')
  templates(@CurrentUser() user: AuthUser): Promise<GedDraftTemplatesResponse> {
    return this.service.listTemplates(user);
  }

  @Get('templates/:id')
  template(@Param('id') id: string, @CurrentUser() user: AuthUser): GedDraftTemplateDetail {
    return this.service.getTemplate(id, user);
  }

  @Post('draft')
  @HttpCode(200)
  @UseGuards(DraftingRateLimitGuard)
  draft(
    @Body(new ZodValidationPipe<GedDraftRequest>(gedDraftRequestSchema as never)) body: GedDraftRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<GedDraftResponse> {
    return this.service.generate(body, user);
  }

  @Post('documents')
  createDocument(
    @Body(new ZodValidationPipe<GedDraftCreateDocumentRequest>(gedDraftCreateDocumentSchema as never))
    body: GedDraftCreateDocumentRequest,
    @CurrentUser() user: AuthUser,
  ): Promise<GedDraftCreateDocumentResponse> {
    return this.service.createDocumentFromTemplate(body, user);
  }
}
