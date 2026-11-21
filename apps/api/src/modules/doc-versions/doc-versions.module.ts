import { Module } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { DocVersionsController } from './doc-versions.controller';
import { DocVersionsService } from './doc-versions.service';

/**
 * Versions d'un document (GED). `DocumentsService` est déclaré ici car `DocumentsModule` ne
 * l'exporte pas : `PrismaService`, `AuditService` et `ConfigService` sont globaux.
 */
@Module({
  controllers: [DocVersionsController],
  providers: [DocumentsService, DocVersionsService],
})
export class DocVersionsModule {}
