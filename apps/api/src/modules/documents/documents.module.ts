import { Module } from '@nestjs/common';
import { SearchService } from '../search/search.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentTabsService } from './document-tabs.service';
import { SealingKeyService } from './sealing-key.service';

@Module({
  controllers: [DocumentsController],
  providers: [SearchService, DocumentsService, DocumentTabsService, SealingKeyService],
  // `DocumentTabsService` : réutilisé par `AccessInquiriesModule` (acceptation d'une demande
  // d'accès = même upsert `document_permission` que l'onglet « Accès par Utilisateur »).
  exports: [DocumentTabsService],
})
export class DocumentsModule {}
