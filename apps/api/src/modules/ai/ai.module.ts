import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiMaskingService } from './ai-masking.service';
import { AiDecisionService } from './ai-decision.service';
import { aiQueueProvider, closeAiQueue, GED_AI_QUEUE_TOKEN } from './ai-queue.provider';
import { AiSettingsService } from './ai-settings.service';
import { AiService } from './ai.service';

/**
 * Socle IA de la GED : configuration, masquage, journal des décisions et point d'entrée unique
 * `AiService`. Les autres modules importent ce module et n'injectent QUE `AiService` (jamais un
 * fournisseur). `PrismaService` est global.
 */
@Module({
  imports: [AuthModule],
  controllers: [AiController],
  providers: [AiSettingsService, AiDecisionService, AiService, AiMaskingService, aiQueueProvider],
  exports: [AiService, AiSettingsService, AiDecisionService],
})
export class AiModule implements OnApplicationShutdown {
  constructor(@Inject(GED_AI_QUEUE_TOKEN) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await closeAiQueue(this.queue);
  }
}
