import {
  Inject,
  Logger,
  Module,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../prisma/prisma.service';
import { DefinitionsController } from './definitions.controller';
import { DefinitionsService } from './definitions.service';
import { WorkflowEngine, WfExecutorRegistry } from './engine';
import type { WfTaskExecutorRegistry, WorkflowEngineApi } from './engine/engine.types';
import {
  createGenerationSuggestionExecutor,
  WF_GENERATION_SUGGESTER,
  type WfGenerationSuggester,
} from './extension/generation-suggester';
import { SubjectAccessRegistry } from './extension/subject-access';
import { WorkflowTriggerStarterService } from './extension/trigger-starter';
import { WorkflowEventsPublisher } from './extension/workflow-events';
import { WorkflowNotificationsListener } from './extension/workflow-notifications.listener';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { PrincipalService } from './principal.service';
import { WF_ENGINE, WF_EXECUTOR_REGISTRY, WF_TRIGGER_STARTER } from './workflows.tokens';

/**
 * Docu-Flow (workflows). `PrismaService` est global. Le moteur est une classe SANS Nest, construite ici en
 * usine avec l'annuaire (`PrincipalService`) et le registre d'exécuteurs (vide en W1 : W2 y enregistre
 * l'exécuteur 'agent'). Exports : le moteur, le registre, le démarreur de déclencheurs (W3), l'éditeur
 * d'événements et le registre des contrôleurs d'accès aux objets liés.
 */
@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [DefinitionsController, InstancesController, InboxController],
  providers: [
    { provide: WF_EXECUTOR_REGISTRY, useValue: new WfExecutorRegistry() },
    {
      provide: WF_ENGINE,
      inject: [PrismaService, WF_EXECUTOR_REGISTRY, PrincipalService, WorkflowEventsPublisher],
      useFactory: (
        prisma: PrismaService,
        registry: WfTaskExecutorRegistry,
        directory: PrincipalService,
        publisher: WorkflowEventsPublisher,
      ): WorkflowEngineApi => {
        const logger = new Logger('WorkflowEngine');
        return new WorkflowEngine(prisma, {
          registry,
          directory,
          // Événements produits hors requête (exécuteurs en arrière-plan) : mêmes écouteurs que les routes.
          onEvents: (events) => publisher.publish(events),
          onBackgroundError: (err, ctx) =>
            logger.error(
              `échec en arrière-plan (${ctx.stage}${ctx.taskId ? `, tâche ${ctx.taskId}` : ''}) : ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
        });
      },
    },
    PrincipalService,
    SubjectAccessRegistry,
    WorkflowEventsPublisher,
    WorkflowNotificationsListener,
    DefinitionsService,
    InstancesService,
    InboxService,
    { provide: WF_TRIGGER_STARTER, useClass: WorkflowTriggerStarterService },
  ],
  exports: [WF_ENGINE, WF_EXECUTOR_REGISTRY, WF_TRIGGER_STARTER, WorkflowEventsPublisher, SubjectAccessRegistry],
})
export class WorkflowsModule implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(WorkflowsModule.name);

  constructor(
    @Inject(WF_ENGINE) private readonly engine: WorkflowEngineApi,
    @Inject(WF_EXECUTOR_REGISTRY) private readonly registry: WfTaskExecutorRegistry,
    @Optional() @Inject(WF_GENERATION_SUGGESTER) private readonly suggester?: WfGenerationSuggester,
  ) {}

  /** L'exécuteur de suggestion n'existe que si un fournisseur est branché (aucun en W1). */
  onModuleInit(): void {
    if (this.suggester && !this.registry.has('generation')) {
      this.registry.register(createGenerationSuggestionExecutor(this.suggester));
    }
  }

  /** Reprise après redémarrage : relance les exécuteurs des tâches ouvertes. Ne bloque jamais le démarrage. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.engine.rescanExecutors();
      if (n > 0) this.logger.log(`${n} tâche(s) de workflow relancée(s) après redémarrage.`);
    } catch (err) {
      this.logger.error(
        `reprise des exécuteurs de workflow impossible : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
