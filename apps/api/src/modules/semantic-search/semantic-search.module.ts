import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { SearchService } from '../search/search.service';
import {
  closeEmbeddingQueue,
  embeddingQueueProvider,
  GED_EMBEDDING_QUEUE_TOKEN,
} from './embedding-queue.provider';
import { SemanticRateLimitGuard } from './semantic-rate-limit.guard';
import { SemanticSearchController } from './semantic-search.controller';
import { SemanticSearchService } from './semantic-search.service';

/**
 * Recherche sémantique avec droits + questions-réponses. `SearchService` (repli plein texte) n'est
 * exporté par aucun module : il est redéclaré ici comme provider (même schéma que DocumentsModule).
 * `PrismaService` est global.
 */
@Module({
  imports: [AiModule, AuthModule],
  controllers: [SemanticSearchController],
  providers: [SemanticSearchService, SemanticRateLimitGuard, SearchService, embeddingQueueProvider],
  // Exporté pour les agents Docu-Flow (outil de recherche avec droits du lanceur).
  exports: [SemanticSearchService],
})
export class SemanticSearchModule implements OnApplicationShutdown {
  constructor(@Inject(GED_EMBEDDING_QUEUE_TOKEN) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await closeEmbeddingQueue(this.queue);
  }
}
