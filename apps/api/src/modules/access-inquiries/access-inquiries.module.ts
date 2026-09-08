import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { AccessInquiriesController } from './access-inquiries.controller';
import { AccessInquiriesService } from './access-inquiries.service';

/**
 * Sécurité Documentaire — demandes d'accès document. Importe `DocumentsModule` pour réutiliser
 * `DocumentTabsService.grantPermission` à l'acceptation (voir `access-inquiries.service.ts`),
 * exporté par ce module à cet effet.
 */
@Module({
  imports: [DocumentsModule],
  controllers: [AccessInquiriesController],
  providers: [AccessInquiriesService],
})
export class AccessInquiriesModule {}
