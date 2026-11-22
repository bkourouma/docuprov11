import 'reflect-metadata';
import type { Provider, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { MailSearchService } from '../courriers/mail-search.service';
import { MailsService } from '../courriers/mails.service';
import { DraftingService } from '../drafting/drafting.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActionApplierRegistry } from '../workflow-agent-catalog/appliers/action-applier.registry';
import { ApplierRightsService } from '../workflow-agent-catalog/appliers/applier-rights';
import { ImputableActorsService } from '../workflow-agent-catalog/appliers/imputable-actors.service';
import { WF_IMPUTABLE_ACTORS } from '../workflow-agent-catalog/catalog.contracts';
import { WF_AGENT_GATE } from '../workflow-agents/agent.contracts';
import { AgentDataAdapter } from '../workflow-agents/tools/agent-data.adapter';
import { AssistantController } from './assistant.controller';
import {
  ASST_CONVERSATIONS,
  ASST_EXECUTOR,
  ASST_GATE,
  ASST_IDENTITY,
  ASST_PLANNER,
  ASST_PROPOSAL_STORE,
} from './assistant.contracts';
import { AssistantModule } from './assistant.module';
import { AsstConversationsService } from './conversations/asst-conversations.service';
import { AsstConfirmLimiter } from './executor/asst-confirm-limiter';
import { AsstExecutorService } from './executor/asst-executor.service';
import { AsstExpirySweeper } from './executor/asst-expiry-sweeper';
import { AsstGateService } from './gate/asst-gate.service';
import { AsstIdentityService } from './identity/asst-identity.service';
import { AsstPlannerService } from './planner/asst-planner.service';
import { AsstPlannerDataAdapter } from './planner/planner-data.adapter';
import { ASST_ACTION_VALIDATOR, ASST_PLANNER_DATA } from './planner/planner.types';
import { AsstProposalStoreService } from './store/asst-proposal-store.service';

// Le service de rédaction tire l'éditeur collaboratif (ESM non transformé par Jest) : simulé.
jest.mock('../drafting/drafting.service', () => ({ DraftingService: class DraftingService {} }));
// Les modules d'infrastructure importés par l'assistant tirent ce même éditeur : remplacés par des modules vides.
jest.mock('../drafting/drafting.module', () => ({ DraftingModule: class DraftingModule {} }));
jest.mock('../courriers/courriers.module', () => ({ CourriersModule: class CourriersModule {} }));
jest.mock('../workflow-agents/workflow-agents.module', () => ({ WorkflowAgentsModule: class WorkflowAgentsModule {} }));
jest.mock('../workflow-agent-catalog/appliers/catalog-appliers.module', () => ({ CatalogAppliersModule: class CatalogAppliersModule {} }));
jest.mock('../workflow-agent-catalog/appliers/extra/catalog-extra-appliers.module', () => ({
  CatalogExtraAppliersModule: class CatalogExtraAppliersModule {},
}));

const meta = <T>(key: string): T => Reflect.getMetadata(key, AssistantModule) as T;

async function compile() {
  // Modules d'infrastructure (JWT, IA, courriers, agents…) remplacés par des doublures : on vérifie le câblage propre
  // à l'assistant.
  const stubs: Provider[] = [
    { provide: PrismaService, useValue: {} },
    { provide: AuditService, useValue: {} }, // global en production
    { provide: ConfigService, useValue: {} }, // global en production
    { provide: AiService, useValue: {} },
    { provide: WF_AGENT_GATE, useValue: { costOf: () => 0 } },
    { provide: AgentDataAdapter, useValue: {} },
    { provide: MailsService, useValue: {} },
    { provide: MailSearchService, useValue: {} },
    { provide: DraftingService, useValue: {} },
    { provide: ImputableActorsService, useValue: {} },
    { provide: WF_IMPUTABLE_ACTORS, useValue: {} },
    { provide: ActionApplierRegistry, useValue: { get: () => undefined } },
    { provide: ApplierRightsService, useValue: {} },
  ];
  return Test.createTestingModule({
    controllers: meta<Type[]>('controllers'),
    providers: [...meta<Provider[]>('providers'), ...stubs],
  })
    .overrideGuard(MenuPermissionGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

const ALL_TOKENS = [ASST_IDENTITY, ASST_GATE, ASST_PLANNER, ASST_PROPOSAL_STORE, ASST_CONVERSATIONS, ASST_EXECUTOR];

describe('AssistantModule : câblage', () => {
  it('déclare le contrôleur, importe les modules nécessaires et exporte tous les jetons', () => {
    expect(meta<unknown[]>('controllers')).toEqual([AssistantController]);
    expect(meta<unknown[]>('imports')).toHaveLength(7);
    expect(meta<unknown[]>('exports')).toEqual(expect.arrayContaining(ALL_TOKENS));
  });

  it('branche les implémentations A1 (porte, planificateur, magasin, conversations) et A2 (exécuteur, limiteur, balayeur)', async () => {
    const ref = await compile();
    expect(ref.get(AssistantController)).toBeInstanceOf(AssistantController);
    expect(ref.get(ASST_IDENTITY)).toBeInstanceOf(AsstIdentityService);
    expect(ref.get(ASST_GATE)).toBeInstanceOf(AsstGateService);
    expect(ref.get(ASST_PLANNER)).toBeInstanceOf(AsstPlannerService);
    expect(ref.get(ASST_PROPOSAL_STORE)).toBeInstanceOf(AsstProposalStoreService);
    expect(ref.get(ASST_CONVERSATIONS)).toBeInstanceOf(AsstConversationsService);
    expect(ref.get(ASST_PLANNER_DATA)).toBeInstanceOf(AsstPlannerDataAdapter);
    expect(ref.get(ASST_ACTION_VALIDATOR)).toBeDefined();
    expect(ref.get(ASST_EXECUTOR)).toBeInstanceOf(AsstExecutorService);
    expect(ref.get(AsstConfirmLimiter)).toBeInstanceOf(AsstConfirmLimiter);
    expect(ref.get(AsstExpirySweeper)).toBeInstanceOf(AsstExpirySweeper);
  });

  it('aucun jeton ne reste « non branché » : chaque port répond par une vraie classe', async () => {
    const ref = await compile();
    for (const token of ALL_TOKENS) {
      const port = ref.get<object>(token);
      expect(port.constructor.name).not.toMatch(/^(NotImplemented|Unavailable)/);
    }
  });
});
