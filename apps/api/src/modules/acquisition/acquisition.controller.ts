import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AcquisitionService, type UploadedPdf } from './acquisition.service';
import { createBatchSchema, type CreateBatchDto } from './acquisition.dto';

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
