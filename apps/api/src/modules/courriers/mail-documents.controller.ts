import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { MailDocumentsService } from './mail-documents.service';
import { linkDocumentSchema, type LinkDocumentDto } from './mails.dto';

/** Liaison courrier ↔ document GED (§02.6). */
@UseGuards(MenuPermissionGuard)
@Controller('courriers')
export class MailDocumentsController {
  constructor(private readonly service: MailDocumentsService) {}

  @Get(':id/documents')
  list(@Param('id', ParseIntPipe) id: number) {
    return this.service.listForMail(id);
  }

  @RequireMenu('/courriers/parapheur')
  @Post(':id/documents')
  link(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(linkDocumentSchema)) body: LinkDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.link(id, body.documentId, body.decharge ?? false, user);
  }

  @RequireMenu('/courriers/parapheur')
  @Delete(':id/documents/:documentId')
  unlink(
    @Param('id', ParseIntPipe) id: number,
    @Param('documentId', ParseIntPipe) documentId: number,
  ) {
    return this.service.unlink(id, documentId);
  }
}
