import { Injectable, Logger } from '@nestjs/common';
import { WF_EVENT_BUS_MAX_PENDING, type WfDomainEvent } from '../domain/contracts';
import { parseDomainEvent } from '../domain/events';

export type WfDomainEventListener = (event: WfDomainEvent) => Promise<void> | void;

/**
 * Bus d'événements métier INTERNE (un processus). Petit service typé : aucune dépendance d'événements externe.
 *
 * Garanties pour les modules qui émettent (courriers, ingestion…) :
 *  - `emit` ne lève JAMAIS et ne bloque JAMAIS : l'événement est validé, mis en file mémoire bornée puis traité
 *    plus tard, un par un, hors de la requête qui l'a produit. Un événement invalide ou une file pleine est
 *    journalisé et abandonné : l'enregistrement du courrier n'est jamais cassé par l'émission ;
 *  - l'appelant l'invoque APRÈS commit, jamais dans une transaction ;
 *  - un écouteur qui échoue est journalisé et ignoré ; les écouteurs tournent séquentiellement (ce qui sérialise
 *    aussi le comptage des plafonds de lancement dans ce processus) ;
 *  - rien n'est durable : un arrêt du processus perd les événements en file. Les balayages du worker
 *    (échéances, seuils) rattrapent leurs propres événements, pas ceux d'un courrier ou d'un dépôt.
 */
@Injectable()
export class WorkflowEventBus {
  private readonly logger = new Logger(WorkflowEventBus.name);
  private readonly listeners: WfDomainEventListener[] = [];
  private readonly pending: WfDomainEvent[] = [];
  private draining = false;

  subscribe(listener: WfDomainEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Émet un événement sans jamais lever ni attendre. Renvoie `true` si l'événement a été accepté. */
  emit(event: unknown): boolean {
    try {
      const parsed = parseDomainEvent(event);
      if (!parsed.ok) {
        this.logger.warn(`événement workflow invalide ignoré : ${parsed.issues.join('; ')}`);
        return false;
      }
      if (this.pending.length >= WF_EVENT_BUS_MAX_PENDING) {
        this.logger.error(
          `file d'événements workflow pleine (${WF_EVENT_BUS_MAX_PENDING}) : événement ${parsed.value.type} abandonné`,
        );
        return false;
      }
      this.pending.push(parsed.value);
      if (!this.draining) {
        this.draining = true;
        setImmediate(() => void this.drain());
      }
      return true;
    } catch (err) {
      this.logger.error(`émission d'événement workflow impossible : ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Traite la file jusqu'à épuisement (une seule boucle à la fois). */
  private async drain(): Promise<void> {
    try {
      for (let event = this.pending.shift(); event; event = this.pending.shift()) {
        for (const listener of [...this.listeners]) {
          try {
            await listener(event);
          } catch (err) {
            this.logger.error(
              `écouteur d'événements workflow en échec (ignoré) : ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    } finally {
      this.draining = false;
      // Un événement arrivé pendant la sortie de boucle ne doit pas rester en file.
      if (this.pending.length > 0 && !this.draining) {
        this.draining = true;
        setImmediate(() => void this.drain());
      }
    }
  }

  /** Attend que la file soit vide (tests, arrêt propre). */
  async idle(): Promise<void> {
    while (this.draining || this.pending.length > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Nombre d'événements en attente (supervision, tests). */
  get pendingCount(): number {
    return this.pending.length;
  }
}
