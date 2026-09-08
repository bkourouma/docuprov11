import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AccessInquiriesService } from './access-inquiries.service';
import { SECURITY_MENUS } from './security.menus';
import {
  createAccessInquirySchema,
  decideAccessInquirySchema,
  type CreateAccessInquiryDto,
  type DecideAccessInquiryDto,
} from './access-inquiries.dto';

@UseGuards(MenuPermissionGuard)
@Controller('access-inquiries')
export class AccessInquiriesController {
  constructor(private readonly service: AccessInquiriesService) {}

  /** Soumission — ouverte à tout utilisateur connecté (bouton « Demander l'accès » de la fiche document). */
  @Post()
  create(
    @Body(new ZodValidationPipe(createAccessInquirySchema)) body: CreateAccessInquiryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(body, user);
  }

  @RequireMenu(SECURITY_MENUS.accessInquiries)
  @Get()
  list() {
    return this.service.list();
  }

  @RequireMenu(SECURITY_MENUS.accessInquiries)
  @Patch(':id/decide')
  decide(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(decideAccessInquirySchema)) body: DecideAccessInquiryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.decide(id, body.accept, user);
  }
}
