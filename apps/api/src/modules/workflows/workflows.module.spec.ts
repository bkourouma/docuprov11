import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { Provider, Type } from '@nestjs/common';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { DefinitionsController } from './definitions.controller';
import { DefinitionsService } from './definitions.service';
import { InboxController } from './inbox.controller';
import { InstancesController } from './instances.controller';
import { WORKFLOWS_MENUS } from './workflows.menus';
import { WorkflowsModule } from './workflows.module';
import { WF_ENGINE, WF_EXECUTOR_REGISTRY, WF_TRIGGER_STARTER } from './workflows.tokens';
import { WorkflowEventsPublisher } from './extension/workflow-events';
import { WF_GENERATION_SUGGESTER } from './extension/generation-suggester';
import { MENU_KEYS } from '../roles/menu-catalog';

// `@archivage/mailer` n'est pas compilé dans cet espace de travail : on remplace les notifications.
jest.mock('../notifications/notifications.service', () => ({ NotificationsService: class {} }));
jest.mock('../notifications/notifications.module', () => ({ NotificationsModule: class {} }));

// Le moteur est écrit en parallèle : on le remplace par un faux pour tester le CÂBLAGE du module.
const engineMock = {
  rescanExecutors: jest.fn(),
  getInstanceDetail: jest.fn(),
};
jest.mock('./engine', () => ({
  WfExecutorRegistry: class {
    private readonly m = new Map<string, unknown>();
    register(e: { taskType: string }) {
      this.m.set(e.taskType, e);
    }
    get(t: string) {
      return this.m.get(t);
    }
    has(t: string) {
      return this.m.has(t);
    }
  },
  WorkflowEngine: jest.fn().mockImplementation((_prisma: unknown, deps: unknown) => ({ ...engineMock, deps })),
}), { virtual: true });

const meta = <T>(key: string): T => Reflect.getMetadata(key, WorkflowsModule) as T;

async function compile(extra: Provider[] = []) {
  // AuthModule / NotificationsModule sont des dépendances d'infrastructure (JWT, SMTP) : on reprend les
  // fournisseurs et contrôleurs déclarés par le module et on remplace Prisma / Notifications / Definitions.
  const providers = meta<Provider[]>('providers').filter(
    (p) => (p as { provide?: unknown }).provide !== undefined || (p as Type) !== DefinitionsService,
  );
  return Test.createTestingModule({
    controllers: meta<Type[]>('controllers'),
    providers: [
      ...providers,
      { provide: PrismaService, useValue: {} },
      { provide: NotificationsService, useValue: { create: jest.fn() } },
      { provide: DefinitionsService, useValue: {} },
      WorkflowsModule as unknown as Provider,
      ...extra,
    ],
  })
    .overrideGuard(MenuPermissionGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

describe('WorkflowsModule : câblage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('déclare imports, contrôleurs et exports attendus', () => {
    expect(meta<unknown[]>('imports')).toHaveLength(2);
    expect(meta<unknown[]>('controllers')).toEqual([DefinitionsController, InstancesController, InboxController]);
    expect(meta<unknown[]>('exports')).toEqual(
      expect.arrayContaining([WF_ENGINE, WF_EXECUTOR_REGISTRY, WF_TRIGGER_STARTER, WorkflowEventsPublisher]),
    );
  });

  it('résout les contrôleurs, le moteur (annuaire = PrincipalService) et le démarreur de déclencheurs', async () => {
    const ref = await compile();
    expect(ref.get(InstancesController)).toBeInstanceOf(InstancesController);
    expect(ref.get(InboxController)).toBeInstanceOf(InboxController);
    expect(ref.get(DefinitionsController)).toBeInstanceOf(DefinitionsController);
    const engine = ref.get<{ deps: { directory: { canLaunch: unknown }; registry: unknown } }>(WF_ENGINE);
    expect(engine.deps.directory).toBeDefined();
    expect(engine.deps.registry).toBe(ref.get(WF_EXECUTOR_REGISTRY));
    expect(typeof ref.get<{ start: unknown }>(WF_TRIGGER_STARTER).start).toBe('function');
  });

  it('au démarrage : reprise des exécuteurs ; une erreur de reprise ne bloque pas le démarrage', async () => {
    engineMock.rescanExecutors.mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('db'));
    const ref = await compile();
    const mod = ref.get(WorkflowsModule);
    await expect(mod.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(mod.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(engineMock.rescanExecutors).toHaveBeenCalledTimes(2);
  });

  it('aucun exécuteur de génération sans fournisseur ; enregistré dès qu’un fournisseur est branché', async () => {
    const plain = await compile();
    plain.get(WorkflowsModule).onModuleInit();
    expect(plain.get<{ has(t: string): boolean }>(WF_EXECUTOR_REGISTRY).has('generation')).toBe(false);

    const withSuggester = await compile([{ provide: WF_GENERATION_SUGGESTER, useValue: { suggest: jest.fn() } }]);
    withSuggester.get(WorkflowsModule).onModuleInit();
    expect(withSuggester.get<{ has(t: string): boolean }>(WF_EXECUTOR_REGISTRY).has('generation')).toBe(true);
  });

  it('les menus Docu-Flow figurent au catalogue des permissions', () => {
    for (const key of Object.values(WORKFLOWS_MENUS)) expect(MENU_KEYS).toContain(key);
  });
});
