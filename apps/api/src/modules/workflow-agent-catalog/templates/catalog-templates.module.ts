import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { WorkflowAgentsModule } from '../../workflow-agents/workflow-agents.module';
import { WorkflowsModule } from '../../workflows/workflows.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

/**
 * Modèles de workflow prêts à l'emploi (API `GET /workflows/templates`, `POST /workflows/templates/:key/instantiate`).
 * `DefinitionsService` vient de `WorkflowsModule` (exporté : une seule instance, avec le registre d'exécuteurs du
 * moteur pour les contrôles de publication). `EvalService` vient de `WorkflowAgentsModule` (exporté) ;
 * `AuditService` est global.
 */
@Module({
  imports: [AuthModule, WorkflowsModule, WorkflowAgentsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
})
export class CatalogTemplatesModule {}
