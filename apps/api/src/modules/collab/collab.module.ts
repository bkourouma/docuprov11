import { Module } from '@nestjs/common';
import { DocVersionsService } from '../doc-versions/doc-versions.service';
import { DocumentsService } from '../documents/documents.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { CollabAccessService } from './access/collab-access.service';
import { CollabDocumentsController } from './documents/collab-documents.controller';
import { CollabDocumentsService } from './documents/collab-documents.service';
import { CollabPersistenceService } from './persistence/collab-persistence.service';
import { COLLAB_PERSISTENCE } from './server/collab-server.options';
import { CollabServerService } from './server/collab-server.service';

/**
 * Éditeur natif collaboratif (lot 4b) : serveur temps réel Hocuspocus greffé sur le serveur HTTP
 * de Nest (`/api/collab`, hors garde JWT HTTP — il authentifie lui-même dans le protocole),
 * persistance Yjs et API REST des documents texte.
 *
 * `DocumentsService` et `DocVersionsService` sont déclarés ICI (leurs modules ne les exportent
 * pas) : sans état, `PrismaService`, `AuditService` et `ConfigService` étant globaux. Le port de
 * persistance est exposé au serveur sous `COLLAB_PERSISTENCE` (le serveur ne dépend que du contrat).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [CollabDocumentsController],
  providers: [
    DocumentsService,
    DocVersionsService,
    CollabAccessService,
    CollabPersistenceService,
    { provide: COLLAB_PERSISTENCE, useExisting: CollabPersistenceService },
    CollabServerService,
    CollabDocumentsService,
  ],
  exports: [CollabAccessService, CollabServerService],
})
export class CollabModule {}
