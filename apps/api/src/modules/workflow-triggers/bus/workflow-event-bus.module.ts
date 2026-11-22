import { Global, Module } from '@nestjs/common';
import { WorkflowEventBus } from './workflow-event-bus';

/**
 * Bus d'événements métier, GLOBAL : les modules émetteurs (courriers…) l'injectent avec `@Optional()` sans rien
 * importer, et continuent de fonctionner (sans émission) quand le module des déclencheurs n'est pas chargé.
 */
@Global()
@Module({
  providers: [WorkflowEventBus],
  exports: [WorkflowEventBus],
})
export class WorkflowEventBusModule {}
