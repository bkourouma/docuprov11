import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogAppliersModule } from '../workflow-agent-catalog/appliers/catalog-appliers.module';
import { CatalogExtraAppliersModule } from '../workflow-agent-catalog/appliers/extra/catalog-extra-appliers.module';
import { AssistantController } from './assistant.controller';
import {
  ASST_CONVERSATIONS,
  ASST_EXECUTOR,
  ASST_GATE,
  ASST_IDENTITY,
  ASST_PLANNER,
  ASST_PROPOSAL_STORE,
} from './assistant.contracts';
import { AsstConfirmLimiter } from './executor/asst-confirm-limiter';
import { AsstExecutorService } from './executor/asst-executor.service';
import { AsstExpirySweeper } from './executor/asst-expiry-sweeper';
import { AsstIdentityService } from './identity/asst-identity.service';
import {
  NotImplementedConversations,
  NotImplementedGate,
  NotImplementedPlanner,
  NotImplementedProposalStore,
} from './not-implemented';

/**
 * Assistant « qui agit ». `PrismaService` est global. Une ligne par jeton : les lots suivants ne modifient que
 * les lignes marquées A1 / A2. Tant qu'un port n'est pas branché, il répond 501 `not_implemented`.
 */
@Module({
  imports: [AuthModule, CatalogAppliersModule, CatalogExtraAppliersModule],
  controllers: [AssistantController],
  providers: [
    { provide: ASST_IDENTITY, useClass: AsstIdentityService },
    { provide: ASST_GATE, useClass: NotImplementedGate }, // A1 : remplacer par la porte de coût (AsstGateService)
    { provide: ASST_PLANNER, useClass: NotImplementedPlanner }, // A1 : remplacer par le planificateur (AsstPlannerService)
    { provide: ASST_PROPOSAL_STORE, useClass: NotImplementedProposalStore }, // A1 : remplacer par le magasin Prisma (AsstProposalStoreService)
    { provide: ASST_CONVERSATIONS, useClass: NotImplementedConversations }, // A1 : remplacer par le service de conversations (AssistantService)
    AsstConfirmLimiter, // A2
    AsstExecutorService, // A2
    { provide: ASST_EXECUTOR, useExisting: AsstExecutorService }, // A2
    AsstExpirySweeper, // A2
  ],
  exports: [ASST_IDENTITY, ASST_GATE, ASST_PLANNER, ASST_PROPOSAL_STORE, ASST_CONVERSATIONS, ASST_EXECUTOR],
})
export class AssistantModule {}
