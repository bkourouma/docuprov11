import 'reflect-metadata';
import type { Provider, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { ActionApplierRegistry } from '../workflow-agent-catalog/appliers/action-applier.registry';
import { ApplierRightsService } from '../workflow-agent-catalog/appliers/applier-rights';
import { PrismaService } from '../prisma/prisma.service';
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
import { AsstExecutorService } from './executor/asst-executor.service';
import { AsstIdentityService } from './identity/asst-identity.service';
import {
  NotImplementedConversations,
  NotImplementedGate,
  NotImplementedPlanner,
  NotImplementedProposalStore,
} from './not-implemented';

// Les modules catalogue tirent transitivement l'éditeur collaboratif (ESM non transformé par jest) : doubles vides.
jest.mock('../workflow-agent-catalog/appliers/catalog-appliers.module', () => ({ CatalogAppliersModule: class {} }));
jest.mock('../workflow-agent-catalog/appliers/extra/catalog-extra-appliers.module', () => ({
  CatalogExtraAppliersModule: class {},
}));

const meta = <T>(key: string): T => Reflect.getMetadata(key, AssistantModule) as T;

async function compile() {
  // AuthModule (JWT) est une dépendance d'infrastructure : on reprend contrôleurs et fournisseurs du module.
  return Test.createTestingModule({
    controllers: meta<Type[]>('controllers'),
    providers: [
      ...meta<Provider[]>('providers'),
      { provide: PrismaService, useValue: {} },
      { provide: ActionApplierRegistry, useValue: {} },
      { provide: ApplierRightsService, useValue: {} },
    ],
  })
    .overrideGuard(MenuPermissionGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

const ALL_TOKENS = [ASST_IDENTITY, ASST_GATE, ASST_PLANNER, ASST_PROPOSAL_STORE, ASST_CONVERSATIONS, ASST_EXECUTOR];

describe('AssistantModule : câblage', () => {
  it('déclare le contrôleur, importe AuthModule et exporte tous les jetons', () => {
    expect(meta<unknown[]>('controllers')).toEqual([AssistantController]);
    expect(meta<unknown[]>('imports')).toHaveLength(3);
    expect(meta<unknown[]>('exports')).toEqual(expect.arrayContaining(ALL_TOKENS));
  });

  it('se compile avec les valeurs par défaut : identité réelle, autres ports « non branchés »', async () => {
    const ref = await compile();
    expect(ref.get(AssistantController)).toBeInstanceOf(AssistantController);
    expect(ref.get(ASST_IDENTITY)).toBeInstanceOf(AsstIdentityService);
    expect(ref.get(ASST_GATE)).toBeInstanceOf(NotImplementedGate);
    expect(ref.get(ASST_PLANNER)).toBeInstanceOf(NotImplementedPlanner);
    expect(ref.get(ASST_PROPOSAL_STORE)).toBeInstanceOf(NotImplementedProposalStore);
    expect(ref.get(ASST_CONVERSATIONS)).toBeInstanceOf(NotImplementedConversations);
    expect(ref.get(ASST_EXECUTOR)).toBeInstanceOf(AsstExecutorService);
  });

  it('chaque méthode des implémentations par défaut échoue en not_implemented', async () => {
    const ref = await compile();
    for (const token of [ASST_GATE, ASST_PLANNER, ASST_PROPOSAL_STORE, ASST_CONVERSATIONS]) {
      const port = ref.get<Record<string, unknown>>(token);
      const methods = Object.keys(port).filter((k) => typeof port[k] === 'function');
      expect(methods.length).toBeGreaterThan(0);
      for (const name of methods) {
        const err: unknown = await (port[name] as () => Promise<unknown>)().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AsstError);
        expect(err).toMatchObject({ errorCode: 'not_implemented', message: 'Fonction pas encore disponible.' });
      }
    }
  });
});
