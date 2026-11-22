import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CourriersModule } from '../courriers/courriers.module';
import { DocumentsService } from '../documents/documents.service';
import { DraftingModule } from '../drafting/drafting.module';
import { SemanticSearchModule } from '../semantic-search/semantic-search.module';
import type { WfTaskExecutorRegistry } from '../workflows/engine/engine.types';
import { createGenerationSuggestionExecutor } from '../workflows/extension/generation-suggester';
import { WorkflowsModule } from '../workflows/workflows.module';
import { WF_EXECUTOR_REGISTRY } from '../workflows/workflows.tokens';
import { AgentConfigLoader } from './agent-config.loader';
import {
  WF_AGENT_EVENT_SINK,
  WF_AGENT_GATE,
  WF_AGENT_IDENTITY,
  WF_AGENT_RUNNER,
} from './agent.contracts';
import { AgentEventSink } from './agent-event-sink.service';
import { AgentAdminController } from './budget/agent-admin.controller';
import { AgentAdminService } from './budget/agent-admin.service';
import { AgentGateService } from './budget/agent-gate.service';
import { DraftingGenerationSuggester } from './drafting/drafting-generation-suggester';
import { AutonomyEligibilityService } from './eval/autonomy-eligibility.service';
import { EvalController } from './eval/eval.controller';
import { EvalService } from './eval/eval.service';
import { AgentTaskExecutor } from './executor/agent-executor';
import { AgentIdentityService } from './identity/agent-identity.service';
import { AgentRunner } from './runner/agent-runner';
import { AgentDataAdapter } from './tools/agent-data.adapter';
import { ToolGrantsController } from './tools/tool-grants.controller';
import { ToolGrantsService } from './tools/tool-grants.service';
import { WfToolSyncService } from './tools/tool-sync.service';
import { agentDataProvider, toolRegistryProvider } from './tools/tools.provider';

/**
 * Agents Docu-Flow (lot W2) : exécuteur de tâche « agent », outils, garde-fous (budget, arrêt d'urgence,
 * anti-injection), évaluation. Branché sur `WorkflowsModule` par le registre d'exécuteurs (`WF_EXECUTOR_REGISTRY`) :
 * l'exécuteur 'agent' s'enregistre à l'initialisation, ce qui lève la restriction de publication de W1.
 *
 * `SemanticSearchService` vient de `SemanticSearchModule` (exporté), `DraftingService` / `DraftingContextService`
 * de `DraftingModule`, `MailsService` de `CourriersModule`. `DocumentsService` (sans état) est déclaré comme dans
 * DraftingModule. `PrismaService` et `AuditService` sont globaux.
 */
@Module({
  imports: [AuthModule, AiModule, WorkflowsModule, CourriersModule, DraftingModule, SemanticSearchModule],
  controllers: [AgentAdminController, ToolGrantsController, EvalController],
  providers: [
    // Données avec droits du lanceur
    DocumentsService,
    AgentDataAdapter,
    agentDataProvider,
    toolRegistryProvider,
    WfToolSyncService,
    ToolGrantsService,
    // Identité, garde, journal, runner
    AgentIdentityService,
    { provide: WF_AGENT_IDENTITY, useExisting: AgentIdentityService },
    AgentGateService,
    { provide: WF_AGENT_GATE, useExisting: AgentGateService },
    AgentAdminService,
    AgentEventSink,
    { provide: WF_AGENT_EVENT_SINK, useExisting: AgentEventSink },
    AgentRunner,
    { provide: WF_AGENT_RUNNER, useExisting: AgentRunner },
    AgentConfigLoader,
    // Évaluation et exécuteur
    AutonomyEligibilityService,
    EvalService,
    AgentTaskExecutor,
    DraftingGenerationSuggester,
  ],
  exports: [WF_AGENT_GATE, WF_AGENT_RUNNER, WF_AGENT_IDENTITY, AutonomyEligibilityService, EvalService],
})
export class WorkflowAgentsModule implements OnModuleInit {
  private readonly logger = new Logger(WorkflowAgentsModule.name);

  constructor(
    @Inject(WF_EXECUTOR_REGISTRY) private readonly registry: WfTaskExecutorRegistry,
    private readonly executor: AgentTaskExecutor,
    private readonly suggester: DraftingGenerationSuggester,
  ) {}

  /** Enregistre l'exécuteur 'agent' (et la suggestion de rédaction, qui ne fait que PROPOSER). */
  onModuleInit(): void {
    if (!this.registry.has('agent')) this.registry.register(this.executor);
    if (!this.registry.has('generation')) {
      this.registry.register(createGenerationSuggestionExecutor(this.suggester));
    }
    this.logger.log("Exécuteur de tâche « agent » enregistré.");
  }
}
