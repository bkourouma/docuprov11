import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type {
  GedCollabCreated,
  GedCollabImportResult,
  GedCollabMentionCandidate,
  GedCollabSaveVersionResult,
  GedCollabSession,
  GedDocumentVersionRow,
} from '@archivage/types';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import type { AuthUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import {
  MAX_DOCX_UPLOAD_BYTES,
  createCollabDocumentSchema,
  importCollabDocumentSchema,
  mentionCandidatesQuerySchema,
  restoreCollabVersionSchema,
  saveCollabVersionSchema,
  type CreateCollabDocumentDto,
  type ImportCollabDocumentDto,
  type MentionCandidatesQueryDto,
  type RestoreCollabVersionDto,
  type SaveCollabVersionDto,
} from './collab-documents.dto';
import {
  CollabDocumentsService,
  DOCX_CONTENT_TYPE,
  buildContentDisposition,
  type UploadedDocxFile,
} from './collab-documents.service';

/** Limites multer : un seul fichier, 10 Mo ; au-delà, multer répond 413 avant tout traitement. */
const DOCX_UPLOAD = FileInterceptor('file', {
  limits: { fileSize: MAX_DOCX_UPLOAD_BYTES, files: 1 },
});

/**
 * Éditeur natif collaboratif : routes REST (le préfixe global `api` est ajouté par `main.ts`).
 * Le temps réel (`/api/collab`, WebSocket) est servi à part par `CollabServerService`.
 */
@Controller('collab')
export class CollabDocumentsController {
  constructor(private readonly service: CollabDocumentsService) {}

  @Post('documents')
  create(
    @Body(new ZodValidationPipe(createCollabDocumentSchema)) body: CreateCollabDocumentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedCollabCreated> {
    return this.service.createDocument(body, user);
  }

  @Post('documents/import')
  @UseInterceptors(DOCX_UPLOAD)
  importNew(
    @UploadedFile() file: UploadedDocxFile | undefined,
    @Body(new ZodValidationPipe(importCollabDocumentSchema)) body: ImportCollabDocumentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedCollabCreated> {
    return this.service.importNewDocument(file, body, user);
  }

  @Get('documents/:id/session')
  session(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<GedCollabSession> {
    return this.service.getSession(id, user);
  }

  @Post('documents/:id/versions')
  saveVersion(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(saveCollabVersionSchema)) body: SaveCollabVersionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedCollabSaveVersionResult> {
    return this.service.saveVersion(id, body, user);
  }

  @Post('documents/:id/restore')
  @HttpCode(201)
  restore(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(restoreCollabVersionSchema)) body: RestoreCollabVersionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedDocumentVersionRow> {
    return this.service.restore(id, body, user);
  }

  @Get('documents/:id/export.docx')
  async exportDocx(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.service.exportDocx(id, user);
    return new StreamableFile(buffer, {
      type: DOCX_CONTENT_TYPE,
      disposition: buildContentDisposition(fileName),
      length: buffer.length,
    });
  }

  @Post('documents/:id/import')
  @UseInterceptors(DOCX_UPLOAD)
  importInto(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: UploadedDocxFile | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<GedCollabImportResult> {
    return this.service.importIntoDocument(id, file, user);
  }

  @Get('documents/:id/mention-candidates')
  mentionCandidates(
    @Param('id', ParseIntPipe) id: number,
    @Query(new ZodValidationPipe(mentionCandidatesQuerySchema)) query: MentionCandidatesQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GedCollabMentionCandidate[]> {
    return this.service.mentionCandidates(id, query.q, user);
  }
}
