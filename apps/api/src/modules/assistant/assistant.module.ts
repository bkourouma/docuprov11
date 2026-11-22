import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { CourriersModule } from '../courriers/courriers.module';
import { DocumentsService } from '../documents/documents.service';
import { DraftingModule } from '../drafting/drafting.module';
import { SpacesService } from '../spaces/spaces.service';
import { CatalogAppliersModule } from '../workflow-agent-catalog/appliers/catalog-appliers.module';
import { CatalogExtraAppliersModule } from '../workflow-agent-catalog/appliers/extra/catalog-extra-appliers.module';
import { CatalogDataAdapter } from '../workflow-agent-catalog/tools/catalog-data.adapter';
import { WF_CATALOG_DATA } from '../workflow-agent-catalog/tools/catalog-data.port';
import { WorkflowAgentsModule } from '../workflow-agents/workflow-agents.module';
import { AssistantController } from './assistant.controller';
import {
  ASST_CONVERSATIONS,
  ASST_EXECUTOR,
  ASST_GATE,
  ASST_IDENTITY,
  ASST_PLANNER,
  ASST_PROPOSAL_STORE,
} from './assistant.contracts';
import { AsstConversationsService } from './conversations/asst-conversations.service';
import { AsstGateService } from './gate/asst-gate.service';
import { AsstIdentityService } from './identity/asst-identity.service';
import { AsstActionValidatorService } from './planner/action-validator';
import { AsstPlannerService } from './planner/asst-planner.service';
import { AsstPlannerDataAdapter } from './planner/planner-data.adapter';
import { ASST_ACTION_VALIDATOR, ASST_PLANNER_DATA } from './planner/planner.types';
import { AsstProposalStoreService } from './store/asst-proposal-store.service';
import { AsstPurgeService } from './store/asst-purge.service';
import { NotImplementedExecutor } from './not-implemented';

/**
 * Assistant « qui agit ». `PrismaService` est global. Une ligne par jeton : les lots suivants ne modifient que
 * les lignes marquées A1 / A2. Tant qu'un port n'est pas branché, il répond 501 `not_implemented`.
 */
@Module({
  imports: [
    AuthModule,
    // A1 : IA, courriers, rédaction, agents (porte globale `WF_AGENT_GATE`, `AgentDataAdapter`) et applicateurs du catalogue.
    AiModule,
    CourriersModule,
    DraftingModule,
    WorkflowAgentsModule,
    CatalogAppliersModule,
    CatalogExtraAppliersModule,
  ],
  controllers: [AssistantController],
  providers: [
    { provide: ASST_IDENTITY, useClass: AsstIdentityService },
    { provide: ASST_GATE, useClass: AsstGateService }, // A1
    { provide: ASST_PLANNER, useClass: AsstPlannerService }, // A1
    { provide: ASST_PROPOSAL_STORE, useClass: AsstProposalStoreService }, // A1
    { provide: ASST_CONVERSATIONS, useClass: AsstConversationsService }, // A1
    // A1 : données du planificateur (services sans état, déclarés ici comme dans `CatalogToolsModule`).
    DocumentsService, // A1
    SpacesService, // A1
    CatalogDataAdapter, // A1
    { provide: WF_CATALOG_DATA, useExisting: CatalogDataAdapter }, // A1
    AsstPlannerDataAdapter, // A1
    { provide: ASST_PLANNER_DATA, useExisting: AsstPlannerDataAdapter }, // A1
    AsstActionValidatorService, // A1
    { provide: ASST_ACTION_VALIDATOR, useExisting: AsstActionValidatorService }, // A1
    AsstPurgeService, // A1
    { provide: ASST_EXECUTOR, useClass: NotImplementedExecutor }, // A2 : remplacer par l'exécuteur de propositions (AsstExecutorService)
  ],
  exports: [ASST_IDENTITY, ASST_GATE, ASST_PLANNER, ASST_PROPOSAL_STORE, ASST_CONVERSATIONS, ASST_EXECUTOR],
})
export class AssistantModule {}
