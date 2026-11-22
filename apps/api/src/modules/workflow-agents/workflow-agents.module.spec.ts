import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Provider, Type } from '@nestjs/common';
import { AiDecisionService } from '../ai/ai-decision.service';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { MailsService } from '../courriers/mails.service';
import { DraftingContextService } from '../drafting/drafting-context.service';
import { DraftingService } from '../drafting/drafting.service';
import { PrismaService } from '../prisma/prisma.service';
import { SemanticSearchService } from '../semantic-search/semantic-search.service';
import { WfExecutorRegistry } from '../workflows/engine/executor-registry';
import { PrincipalService } from '../workflows/principal.service';
import { WF_EXECUTOR_REGISTRY } from '../workflows/workflows.tokens';
import { AgentTaskExecutor } from './executor/agent-executor';
import { WF_AGENT_GATE, WF_AGENT_IDENTITY, WF_AGENT_RUNNER, WF_TOOL_REGISTRY } from './agent.contracts';
import { WorkflowAgentsModule } from './workflow-agents.module';

// Modules d'infrastructure ou ESM (éditeur) : seuls les fournisseurs du module sont composés ici.
jest.mock('../drafting/drafting.service', () => ({ DraftingService: class {} }));
jest.mock('../drafting/drafting.module', () => ({ DraftingModule: class {} }));
jest.mock('../courriers/courriers.module', () => ({ CourriersModule: class {} }));
jest.mock('../courriers/mails.service', () => ({ MailsService: class {} }));
jest.mock('../semantic-search/semantic-search.module', () => ({ SemanticSearchModule: class {} }));
jest.mock('../workflows/workflows.module', () => ({ WorkflowsModule: class {} }));
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));

const meta = <T>(key: string): T => Reflect.getMetadata(key, WorkflowAgentsModule) as T;

describe('WorkflowAgentsModule : câblage', () => {
  async function compile() {
    const providers = meta<Provider[]>('providers');
    return Test.createTestingModule({
      controllers: meta<Type[]>('controllers'),
      providers: [
        ...providers,
        WorkflowAgentsModule as unknown as Provider,
        { provide: SemanticSearchService, useValue: { search: jest.fn() } },
        { provide: WF_EXECUTOR_REGISTRY, useValue: new WfExecutorRegistry() },
        { provide: PrismaService, useValue: {} },
        { provide: AuditService, useValue: { dataChange: jest.fn() } },
        { provide: AiService, useValue: { status: jest.fn(), run: jest.fn() } },
        { provide: AiDecisionService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn(), getOrThrow: jest.fn() } },
        { provide: PrincipalService, useValue: {} },
        { provide: MailsService, useValue: {} },
        { provide: DraftingContextService, useValue: {} },
        { provide: DraftingService, useValue: {} },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
  }

  it('compose tous les fournisseurs, contrôleurs et jetons', async () => {
    const ref = await compile();
    for (const token of [WF_AGENT_GATE, WF_AGENT_IDENTITY, WF_AGENT_RUNNER, WF_TOOL_REGISTRY]) {
      expect(ref.get(token)).toBeDefined();
    }
    for (const controller of meta<Type[]>('controllers')) {
      expect(ref.get(controller)).toBeInstanceOf(controller);
    }
  });

  it("enregistre l'exécuteur 'agent' (et 'generation') à l'initialisation, une seule fois", async () => {
    const ref = await compile();
    const registry = ref.get<WfExecutorRegistry>(WF_EXECUTOR_REGISTRY);
    expect(registry.has('agent')).toBe(false);
    const mod = ref.get(WorkflowAgentsModule);
    mod.onModuleInit();
    expect(registry.get('agent')).toBe(ref.get(AgentTaskExecutor));
    expect(registry.has('generation')).toBe(true);
    expect(() => mod.onModuleInit()).not.toThrow();
  });

  it('le registre contient les cinq outils de base, sans outil d’envoi', async () => {
    const ref = await compile();
    const keys = ref.get<{ list(): Array<{ key: string }> }>(WF_TOOL_REGISTRY).list().map((t) => t.key).sort();
    expect(keys).toEqual(
      ['lire_courrier', 'lire_document', 'proposer_imputation', 'proposer_reponse', 'rechercher_documents'].sort(),
    );
  });
});
