import 'reflect-metadata';
import { WfEffectApplierHolder } from '../../workflows/engine/effect-applier';
import { WF_EFFECT_APPLIER } from '../../workflows/workflows.tokens';
import { WF_IMPUTABLE_ACTORS } from '../catalog.contracts';
import { ActionApplierRegistry } from './action-applier.registry';
import { ApplierRightsService } from './applier-rights';
import { CatalogAppliersModule } from './catalog-appliers.module';
import { EffectDispatcher } from './effect-dispatcher';
import { ImputableActorsService } from './imputable-actors.service';
import { ImputationBaseApplier, ImputationCourrierApplier } from './imputation.applier';

// Modules d'infrastructure ou ESM (éditeur) : seuls les fournisseurs du module sont vérifiés ici.
jest.mock('../../workflow-agents/workflow-agents.module', () => ({ WorkflowAgentsModule: class {} }));
jest.mock('../../workflows/workflows.module', () => ({ WorkflowsModule: class {} }));
jest.mock('../../courriers/courriers.module', () => ({ CourriersModule: class {} }));
jest.mock('../../workflow-agents/tools/agent-data.adapter', () => ({ AgentDataAdapter: class {} }));

describe('CatalogAppliersModule', () => {
  it('fournit et exporte le registre, le répartiteur, le port des acteurs imputables et le service de droits', () => {
    const exportsMeta = Reflect.getMetadata('exports', CatalogAppliersModule) as unknown[];
    expect(exportsMeta).toEqual(
      expect.arrayContaining([ActionApplierRegistry, EffectDispatcher, WF_IMPUTABLE_ACTORS, ImputableActorsService, ApplierRightsService]),
    );
    const providers = Reflect.getMetadata('providers', CatalogAppliersModule) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        ActionApplierRegistry,
        EffectDispatcher,
        ImputationCourrierApplier,
        ImputationBaseApplier,
        { provide: WF_IMPUTABLE_ACTORS, useExisting: ImputableActorsService },
      ]),
    );
    expect(WF_EFFECT_APPLIER).toBe('WF_EFFECT_APPLIER');
  });

  it('à l’initialisation : enregistre les applicateurs d’imputation et branche le répartiteur sur le moteur', () => {
    const registry = new ActionApplierRegistry();
    const holder = new WfEffectApplierHolder();
    const dispatcher = { apply: jest.fn() } as unknown as EffectDispatcher;
    const actors = { canImpute: jest.fn(), isImputable: jest.fn(), list: jest.fn() };
    const mod = new CatalogAppliersModule(
      registry,
      dispatcher,
      holder,
      new ImputationCourrierApplier(actors),
      new ImputationBaseApplier(actors),
    );
    mod.onModuleInit();
    mod.onModuleInit(); // idempotent
    expect(registry.has('proposer_imputation_courrier')).toBe(true);
    expect(registry.has('proposer_imputation')).toBe(true);
    expect(holder.get()).toBe(dispatcher);
  });
});
