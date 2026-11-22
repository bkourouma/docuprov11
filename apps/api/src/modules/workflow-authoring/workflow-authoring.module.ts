import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { WorkflowAgentsModule } from '../workflow-agents/workflow-agents.module';
import { AuthoringController } from './authoring.controller';
import { AuthoringRateLimitGuard } from './authoring.rate-limit.guard';
import { AuthoringService } from './authoring.service';

/**
 * Docu-Flow W5 : création d'un workflow en langage naturel (brouillon seulement, jamais publié).
 *
 * `WorkflowAgentsModule` exporte `WF_AGENT_GATE` (budget global, arrêt d'urgence) ; `AiModule` exporte `AiService`
 * (masquage cloud obligatoire). `PrismaService` et `AuditService` sont globaux.
 */
@Module({
  imports: [AuthModule, AiModule, WorkflowAgentsModule],
  controllers: [AuthoringController],
  providers: [AuthoringService, AuthoringRateLimitGuard],
})
export class WorkflowAuthoringModule {}
