import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { RequireMenu } from '../auth/require-menu.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AcquisitionService, type UploadedPdf } from './acquisition.service';
import { createBatchSchema, type CreateBatchDto } from './acquisition.dto';

/** Clé du menu « Acquisition par lot » (déclarée aussi dans `roles/menu-catalog.ts`). */
export const ACQUISITION_MENU = '/acquisition';

/**
 * Lots d'acquisition. Sous permission de menu (« accès au menu ⟹ accès aux données ») : ces routes
 * créent des documents dans un dossier, relancent un traitement qui supprime et recrée les
 * documents d'un lot, et listent les documents d'un lot (libellés, cotes, métadonnées) sans
 * contrôle par document. Elles n'étaient protégées que par le JWT : tout compte authentifié, même
 * sans le menu, pouvait les appeler (ANO-ARC-T1-01).
 */
@UseGuards(MenuPermissionGuard)
@RequireMenu(ACQUISITION_MENU)
@Controller('batches')
export class AcquisitionController {
  constructor(private readonly service: AcquisitionService) {}

  @Post()
  create(
    @Body(new ZodValidationPipe(createBatchSchema)) body: CreateBatchDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.createBatch(body, user.userGroupId);
  }

  @Post(':id/files')
  @UseInterceptors(FilesInterceptor('files'))
  upload(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: UploadedPdf[],
    @Query('finalize') finalize?: string,
  ) {
    // Uploads arrive in sequential chunks; only the last one (finalize=true, the default
    // for a single-shot upload) enqueues the processing job.
    return this.service.ingestUpload(id, files ?? [], finalize !== 'false');
  }

  @Get(':id')
  status(@Param('id', ParseIntPipe) id: number) {
    return this.service.getStatus(id);
  }

  @Get(':id/documents')
  documents(@Param('id', ParseIntPipe) id: number) {
    return this.service.listBatchDocuments(id);
  }

  @Post(':id/reprocess')
  reprocess(@Param('id', ParseIntPipe) id: number) {
    return this.service.reprocess(id);
  }
}
