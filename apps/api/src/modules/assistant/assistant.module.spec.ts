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
  AsstError,
} from './assistant.contracts';
import { AssistantModule } from './assistant.module';
import { AsstConversationsService } from './conversations/asst-conversations.service';
import { AsstGateService } from './gate/asst-gate.service';
import { AsstIdentityService } from './identity/asst-identity.service';
import { NotImplementedExecutor } from './not-implemented';
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

  it('branche les implémentations A1 (porte, planificateur, magasin, conversations) et garde l’exécuteur « non branché » tant que A2 n’est pas fusionné', async () => {
    const ref = await compile();
    expect(ref.get(AssistantController)).toBeInstanceOf(AssistantController);
    expect(ref.get(ASST_IDENTITY)).toBeInstanceOf(AsstIdentityService);
    expect(ref.get(ASST_GATE)).toBeInstanceOf(AsstGateService);
    expect(ref.get(ASST_PLANNER)).toBeInstanceOf(AsstPlannerService);
    expect(ref.get(ASST_PROPOSAL_STORE)).toBeInstanceOf(AsstProposalStoreService);
    expect(ref.get(ASST_CONVERSATIONS)).toBeInstanceOf(AsstConversationsService);
    expect(ref.get(ASST_PLANNER_DATA)).toBeInstanceOf(AsstPlannerDataAdapter);
    expect(ref.get(ASST_ACTION_VALIDATOR)).toBeDefined();
    expect(ref.get(ASST_EXECUTOR)).toBeInstanceOf(NotImplementedExecutor);
  });

  it('chaque méthode de l’exécuteur « non branché » échoue en not_implemented', async () => {
    const ref = await compile();
    const port = ref.get<Record<string, unknown>>(ASST_EXECUTOR);
    const methods = Object.keys(port).filter((k) => typeof port[k] === 'function');
    expect(methods.length).toBeGreaterThan(0);
    for (const name of methods) {
      const err: unknown = await (port[name] as () => Promise<unknown>)().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AsstError);
      expect(err).toMatchObject({ errorCode: 'not_implemented', message: 'Fonction pas encore disponible.' });
    }
  });
});
