import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ArchivesComplianceService } from './archives-compliance.service';
import { ArchivesLendingService } from './archives-lending.service';
import { ARCHIVES_MENUS } from './archives.menus';
import {
  createLendingSchema,
  expiredQuerySchema,
  lendingCommentSchema,
  lendingQuerySchema,
  purgeDocumentsSchema,
  purgedQuerySchema,
  type CreateLendingDto,
  type ExpiredQueryDto,
  type LendingCommentDto,
  type LendingQueryDto,
  type PurgeDocumentsDto,
  type PurgedQueryDto,
} from './archives.dto';

/**
 * Menu « Docu-Archives » (opérationnel) : DUA expirés, documents épurés et communication de
 * documents.
 *
 * Contrairement au paramétrage, TOUT est ici sous permission de menu : ces écrans montrent des
 * documents nommés et permettent de les sortir de l'archive.
 */
@UseGuards(MenuPermissionGuard)
@Controller('archives')
export class ArchivesController {
  constructor(
    private readonly compliance: ArchivesComplianceService,
    private readonly lending: ArchivesLendingService,
  ) {}

  // ---- §1 DUA Expirés -----------------------------------------------------

  @RequireMenu(ARCHIVES_MENUS.duaExpired)
  @Get('dua-expired')
  listExpired(@Query(new ZodValidationPipe(expiredQuerySchema)) query: ExpiredQueryDto) {
    return this.compliance.listExpired(query);
  }

  /**
   * Épuration des documents sélectionnés (passage à l'état « Épuré »). `@HttpCode(200)` : c'est
   * une transition d'état sur des ressources existantes, pas une création.
   */
  @RequireMenu(ARCHIVES_MENUS.duaExpired)
  @Post('dua-expired/purge')
  @HttpCode(200)
  purge(@Body(new ZodValidationPipe(purgeDocumentsSchema)) body: PurgeDocumentsDto) {
    return this.compliance.purge(body.documentIds);
  }

  // ---- §2 Documents Épurés ------------------------------------------------

  @RequireMenu(ARCHIVES_MENUS.purged)
  @Get('purged')
  listPurged(@Query(new ZodValidationPipe(purgedQuerySchema)) query: PurgedQueryDto) {
    return this.compliance.listPurged(query);
  }

  // ---- §3 Communiquer un document -----------------------------------------

  /** Documents communicables d'un dossier — lookup du formulaire de communication. */
  @RequireMenu(ARCHIVES_MENUS.communicate)
  @Get('lendings/dossiers/:dossierId/documents')
  lendableDocuments(@Param('dossierId', ParseIntPipe) dossierId: number) {
    return this.lending.listLendableDocuments(dossierId);
  }

  @RequireMenu(ARCHIVES_MENUS.communicate)
  @Post('lendings')
  createLending(
    @Body(new ZodValidationPipe(createLendingSchema)) body: CreateLendingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lending.createLending(body, user.userGroupId);
  }

  // ---- §4 Documents Communiqués -------------------------------------------

  @RequireMenu(ARCHIVES_MENUS.lentDocuments)
  @Get('lendings/out')
  listOut(@Query(new ZodValidationPipe(lendingQuerySchema)) query: LendingQueryDto) {
    return this.lending.listOut(query);
  }

  // ---- §5 Mes Documents Communiqués ---------------------------------------

  @RequireMenu(ARCHIVES_MENUS.myLentDocuments)
  @Get('lendings/mine')
  listMine(
    @Query(new ZodValidationPipe(lendingQuerySchema)) query: LendingQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lending.listMine(query, user.userId);
  }

  // ---- §6 Historique ------------------------------------------------------

  @RequireMenu(ARCHIVES_MENUS.lendingHistory)
  @Get('lendings/history')
  listHistory(@Query(new ZodValidationPipe(lendingQuerySchema)) query: LendingQueryDto) {
    return this.lending.listHistory(query);
  }

  // ---- Retour et commentaires ---------------------------------------------

  /**
   * Retour d'un document prêté. Accessible depuis « Documents communiqués » comme depuis « Mes
   * documents communiqués » : ce sont deux vues du même geste, à des périmètres différents.
   */
  @RequireMenu(ARCHIVES_MENUS.lentDocuments, ARCHIVES_MENUS.myLentDocuments)
  @Post('lendings/details/:id/return')
  @HttpCode(200)
  returnDetail(@Param('id', ParseIntPipe) id: number) {
    return this.lending.returnDetail(id);
  }

  @RequireMenu(
    ARCHIVES_MENUS.lentDocuments,
    ARCHIVES_MENUS.myLentDocuments,
    ARCHIVES_MENUS.lendingHistory,
  )
  @Get('lendings/:id')
  getLending(@Param('id', ParseIntPipe) id: number) {
    return this.lending.getLending(id);
  }

  @RequireMenu(ARCHIVES_MENUS.lentDocuments, ARCHIVES_MENUS.myLentDocuments)
  @Post('lendings/comments')
  addComment(
    @Body(new ZodValidationPipe(lendingCommentSchema)) body: LendingCommentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.lending.addComment(body.lendingDocumentId, body.comments, user.userGroupId);
  }
}
