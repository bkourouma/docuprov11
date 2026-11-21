import { Injectable, Logger } from '@nestjs/common';
import type { WfEngineEvent } from '../engine/engine.types';

export type WorkflowEventListener = (events: readonly WfEngineEvent[]) => Promise<void> | void;

/**
 * Diffuse les événements du moteur APRÈS commit. Un écouteur qui échoue est journalisé puis ignoré :
 * aucun consommateur (notification, temps réel) ne doit faire échouer l'action métier déjà validée.
 */
@Injectable()
export class WorkflowEventsPublisher {
  private readonly logger = new Logger(WorkflowEventsPublisher.name);
  private readonly listeners: WorkflowEventListener[] = [];

  /** Abonne un écouteur ; renvoie la fonction de désabonnement. */
  subscribe(listener: WorkflowEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async publish(events: readonly WfEngineEvent[] | undefined): Promise<void> {
    if (!events?.length) return;
    for (const listener of [...this.listeners]) {
      try {
        await listener(events);
      } catch (err) {
        this.logger.error(
          `écouteur d'événements workflow en échec (ignoré) : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
