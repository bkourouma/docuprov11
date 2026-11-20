import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { DocumentsService } from '../documents/documents.service';
import { closeGovernanceQueue, GED_GOVERNANCE_QUEUE_TOKEN, governanceQueueProvider } from './governance-queue.provider';
import { GovernanceController } from './governance.controller';
import { GovernanceQueryService } from './governance-query.service';
import { GovernanceReviewService } from './governance-review.service';

/**
 * Nettoyage et gouvernance. `DocumentsService` n'est exporté par aucun module : il est redéclaré ici
 * comme provider (même schéma que SemanticSearchModule pour `SearchService`) ; ses dépendances
 * (`PrismaService`, `AuditService`, `ConfigService`) sont globales.
 */
@Module({
  imports: [AiModule, AuthModule],
  controllers: [GovernanceController],
  providers: [GovernanceQueryService, GovernanceReviewService, DocumentsService, governanceQueueProvider],
})
export class GovernanceModule implements OnApplicationShutdown {
  constructor(@Inject(GED_GOVERNANCE_QUEUE_TOKEN) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await closeGovernanceQueue(this.queue);
  }
}
