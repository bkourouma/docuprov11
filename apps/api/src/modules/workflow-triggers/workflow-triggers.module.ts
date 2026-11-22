import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CourriersModule } from '../courriers/courriers.module';
import { DocumentsService } from '../documents/documents.service';
import { PrincipalService } from '../workflows/principal.service';
import { WorkflowsModule } from '../workflows/workflows.module';
import { DocumentSubjectAccessChecker } from './access/document-subject-access.checker';
import { MailSubjectAccessChecker } from './access/mail-subject-access.checker';
import { WorkflowSubjectAccessRegistrar } from './access/subject-access.registrar';
import { WorkflowEventBusModule } from './bus/workflow-event-bus.module';
import { WF_EMERGENCY_STOP_GATE, WfBudgetEmergencyStopGate } from './dispatch/emergency-stop';
import { TriggerFailureTracker } from './dispatch/trigger-failure-tracker';
import { WorkflowTriggerDispatcher } from './dispatch/triggers.dispatcher';
import { WorkflowEventsConsumer } from './dispatch/workflow-events.consumer';
import { WorkflowTriggersController } from './triggers.controller';
import { WorkflowTriggersService } from './triggers.service';

/**
 * Docu-Flow W3 : déclencheurs par événement.
 *
 * - bus d'événements métier GLOBAL (`WorkflowEventBusModule`) : les modules émetteurs l'injectent en `@Optional()` ;
 * - répartiteur : événement -> déclencheurs -> `WF_TRIGGER_STARTER` (droits du lanceur, jamais plus) ;
 * - contrôleurs d'accès aux objets liés (courrier, document), enregistrés dans le `SubjectAccessRegistry` du
 *   module workflows ; accès refusé par défaut pour tout autre type ;
 * - consommateur BullMQ des événements produits par le worker (ingestion, échéances, seuils) ;
 * - CRUD de conception (menu `/workflows/conception`).
 *
 * `PrincipalService` et `DocumentsService` sont redéclarés ici (sans état, ils ne dépendent que de services
 * globaux ou du registre d'accès exporté par `WorkflowsModule`), comme le font déjà d'autres modules du dépôt.
 * L'arrêt d'urgence est lu dans `wf_budget` ; W2 peut fournir une autre implémentation sous `WF_EMERGENCY_STOP_GATE`.
 */
@Module({
  imports: [AuthModule, WorkflowsModule, CourriersModule, WorkflowEventBusModule],
  controllers: [WorkflowTriggersController],
  providers: [
    PrincipalService,
    DocumentsService,
    WorkflowTriggersService,
    MailSubjectAccessChecker,
    DocumentSubjectAccessChecker,
    WorkflowSubjectAccessRegistrar,
    TriggerFailureTracker,
    { provide: WF_EMERGENCY_STOP_GATE, useClass: WfBudgetEmergencyStopGate },
    WorkflowTriggerDispatcher,
    WorkflowEventsConsumer,
  ],
  exports: [WorkflowEventBusModule],
})
export class WorkflowTriggersModule {}
