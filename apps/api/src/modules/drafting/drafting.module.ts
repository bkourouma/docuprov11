import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CollabModule } from '../collab/collab.module';
import { DocumentsService } from '../documents/documents.service';
import { DraftingContextService } from './drafting-context.service';
import { DraftingRateLimitGuard } from './drafting-rate-limit.guard';
import { DraftingController } from './drafting.controller';
import { DraftingService } from './drafting.service';

/**
 * Rédaction assistée par l'IA (lot 4c). `AiModule` fournit `AiService` (masquage, journal) et
 * `CollabModule` `CollabDocumentsService` (création depuis un modèle). `DocumentsService` est
 * déclaré ici (sans état ; `PrismaService`, `AuditService`, `ConfigService` sont globaux), comme
 * le fait `CollabModule`.
 */
@Module({
  imports: [AiModule, CollabModule],
  controllers: [DraftingController],
  providers: [DraftingService, DraftingContextService, DraftingRateLimitGuard, DocumentsService],
  exports: [DraftingService, DraftingContextService],
})
export class DraftingModule {}
