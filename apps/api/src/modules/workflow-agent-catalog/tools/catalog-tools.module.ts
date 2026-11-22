import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { CourriersModule } from '../../courriers/courriers.module';
import { DocumentsService } from '../../documents/documents.service';
import { DraftingModule } from '../../drafting/drafting.module';
import { SemanticSearchModule } from '../../semantic-search/semantic-search.module';
import { WF_TOOL_REGISTRY, type WfToolRegistryPort } from '../../workflow-agents/agent.contracts';
import { AgentDataAdapter } from '../../workflow-agents/tools/agent-data.adapter';
import { WorkflowAgentsModule } from '../../workflow-agents/workflow-agents.module';
import { CatalogAppliersModule } from '../appliers/catalog-appliers.module';
import { CatalogDataAdapter } from './catalog-data.adapter';
import { WF_CATALOG_DATA, type CatalogDataPort } from './catalog-data.port';
import { registerCatalogTools } from './catalog-tools';

/**
 * Outils du catalogue d'agents (lot W6). Les huit outils sont enregistrés dans le registre de W2
 * (`WF_TOOL_REGISTRY`, exporté par `WorkflowAgentsModule`) à l'initialisation ; la synchronisation vers
 * `wf_tool` se fait ensuite au démarrage de l'application (`WfToolSyncService`).
 *
 * `AgentDataAdapter` (règle d'accès aux courriers) est déclaré ici en second exemplaire (sans état) car
 * `WorkflowAgentsModule` ne l'exporte pas. `DocumentsService` est déclaré comme dans `WorkflowAgentsModule`.
 * Le port `WF_IMPUTABLE_ACTORS` vient de `CatalogAppliersModule`.
 */
@Module({
  imports: [
    WorkflowAgentsModule,
    CourriersModule,
    DraftingModule,
    SemanticSearchModule,
    CatalogAppliersModule,
  ],
  providers: [
    DocumentsService,
    AgentDataAdapter,
    CatalogDataAdapter,
    { provide: WF_CATALOG_DATA, useExisting: CatalogDataAdapter },
  ],
})
export class CatalogToolsModule implements OnModuleInit {
  private readonly logger = new Logger(CatalogToolsModule.name);

  constructor(
    @Inject(WF_TOOL_REGISTRY) private readonly registry: WfToolRegistryPort,
    @Inject(WF_CATALOG_DATA) private readonly data: CatalogDataPort,
  ) {}

  /** Enregistrement idempotent : un outil déjà présent (même clé) est ignoré, sans lever. */
  onModuleInit(): void {
    const added = registerCatalogTools(this.registry, this.data);
    this.logger.log(`Outils du catalogue enregistrés : ${added}.`);
  }
}
