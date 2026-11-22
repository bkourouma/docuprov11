import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CourriersModule } from '../../courriers/courriers.module';
import { WorkflowAgentsModule } from '../../workflow-agents/workflow-agents.module';
import type { WfEffectApplierHolder } from '../../workflows/engine/effect-applier';
import { WorkflowsModule } from '../../workflows/workflows.module';
import { WF_EFFECT_APPLIER } from '../../workflows/workflows.tokens';
import { WF_IMPUTABLE_ACTORS } from '../catalog.contracts';
import { ActionApplierRegistry } from './action-applier.registry';
import { ApplierRightsService } from './applier-rights';
import { EffectDispatcher } from './effect-dispatcher';
import { ImputableActorsService } from './imputable-actors.service';
import { ImputationBaseApplier, ImputationCourrierApplier } from './imputation.applier';

/**
 * Applicateurs d'effets du catalogue (lot W6). Fournit et exporte le registre des applicateurs, le répartiteur
 * (`EffectDispatcher`, port `WfEffectApplierPort` du moteur), le port des acteurs imputables
 * (`WF_IMPUTABLE_ACTORS`) et le service de droits conjoints. À l'initialisation : enregistre les applicateurs
 * d'imputation et branche le répartiteur sur le moteur (`WF_EFFECT_APPLIER`). Les autres applicateurs
 * s'enregistrent depuis leur propre module (`extra/catalog-extra-appliers.module.ts`), qui importe celui-ci.
 *
 * `AgentDataAdapter` et `WF_AGENT_IDENTITY` viennent de `WorkflowAgentsModule` ; `PrismaService` est global.
 */
@Module({
  imports: [AuthModule, CourriersModule, WorkflowsModule, WorkflowAgentsModule],
  providers: [
    ActionApplierRegistry,
    ApplierRightsService,
    ImputableActorsService,
    { provide: WF_IMPUTABLE_ACTORS, useExisting: ImputableActorsService },
    EffectDispatcher,
    ImputationCourrierApplier,
    ImputationBaseApplier,
  ],
  exports: [ActionApplierRegistry, EffectDispatcher, WF_IMPUTABLE_ACTORS, ImputableActorsService, ApplierRightsService],
})
export class CatalogAppliersModule implements OnModuleInit {
  private readonly logger = new Logger(CatalogAppliersModule.name);

  constructor(
    private readonly registry: ActionApplierRegistry,
    private readonly dispatcher: EffectDispatcher,
    @Inject(WF_EFFECT_APPLIER) private readonly holder: WfEffectApplierHolder,
    private readonly imputationCourrier: ImputationCourrierApplier,
    private readonly imputationBase: ImputationBaseApplier,
  ) {}

  onModuleInit(): void {
    for (const applier of [this.imputationCourrier, this.imputationBase]) {
      if (!this.registry.has(applier.toolKey)) this.registry.register(applier);
    }
    this.holder.set(this.dispatcher);
    this.logger.log("Applicateur des actions validées branché sur le moteur de workflow.");
  }
}
