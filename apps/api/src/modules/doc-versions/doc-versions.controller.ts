import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { GedDocumentVersionRow } from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import {
  MAX_VERSION_UPLOAD_BYTES,
  createVersionSchema,
  restoreVersionSchema,
  type CreateVersionDto,
  type RestoreVersionDto,
} from './doc-versions.dto';
import { DocVersionsService, type UploadedVersionFile } from './doc-versions.service';

@Controller('documents')
export class DocVersionsController {
  constructor(private readonly versions: DocVersionsService) {}

  @Get(':id/versions')
  list(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<GedDocumentVersionRow[]> {
    return this.versions.list(id, user);
  }

  @Post(':id/versions')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_VERSION_UPLOAD_BYTES } }))
  create(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: UploadedVersionFile | undefined,
    @Body(new ZodValidationPipe(createVersionSchema)) body: CreateVersionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedDocumentVersionRow> {
    return this.versions.create(id, file, body, user);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(201)
  restore(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Body(new ZodValidationPipe(restoreVersionSchema)) body: RestoreVersionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedDocumentVersionRow> {
    return this.versions.restore(id, versionId, body ?? {}, user);
  }

  @Get(':id/versions/:versionId/files/:fileId/content')
  content(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Param('fileId', ParseIntPipe) fileId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<StreamableFile> {
    return this.versions.openFileContent(id, versionId, fileId, user);
  }
}
