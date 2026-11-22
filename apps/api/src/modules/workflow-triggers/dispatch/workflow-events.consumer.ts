import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConnectionOptions, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { WorkflowEventBus } from '../bus/workflow-event-bus';
import { WF_EVENT_BUS_MAX_PENDING, WF_EVENTS_QUEUE } from '../domain/contracts';
import { parseDomainEvent } from '../domain/events';

/** Types que le worker émet dans la file ; `mail.arrived` n'est émis que dans l'api, jamais par la file. */
const QUEUE_EVENT_TYPES: ReadonlySet<string> = new Set(['document.deposited', 'deadline.reached', 'threshold.crossed']);

/**
 * Consomme la file BullMQ `wf-events`, alimentée par le worker (balayage d'échéances et de seuils, ingestion) :
 * chaque job est un événement métier, NON fiable (revalidé), remis au bus interne.
 *
 * Le consommateur ne démarre que si `REDIS_URL` est défini, hors tests (`NODE_ENV=test`) et sans
 * `WF_EVENTS_CONSUMER_DISABLED=true` : les tests de module n'ouvrent jamais de connexion Redis.
 */
@Injectable()
export class WorkflowEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkflowEventsConsumer.name);
  private worker: Worker | null = null;
  private connection: IORedis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly bus: WorkflowEventBus,
  ) {}

  onApplicationBootstrap(): void {
    const url = this.config.get<string>('REDIS_URL');
    if (!url || process.env.NODE_ENV === 'test' || process.env.WF_EVENTS_CONSUMER_DISABLED === 'true') return;
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
    this.worker = new Worker(WF_EVENTS_QUEUE, (job) => Promise.resolve(void this.processJob(job.data)), {
      connection: this.connection as unknown as ConnectionOptions,
      concurrency: 1,
    });
    this.worker.on('error', (err) => this.logger.error(`file ${WF_EVENTS_QUEUE} : ${err.message}`));
    this.logger.log(`consommation de la file ${WF_EVENTS_QUEUE} démarrée`);
  }

  /**
   * Valide puis remet un événement au bus. Un événement invalide est journalisé et abandonné SANS lever : le job
   * est considéré traité, aucune nouvelle tentative ne le rendrait valide. Un type que le worker n'émet pas
   * (`mail.arrived`) est refusé de la même façon. Si la file du bus est PLEINE, le job lève : BullMQ rejoue
   * avec backoff.
   */
  processJob(data: unknown): { accepted: boolean } {
    const parsed = parseDomainEvent(data);
    if (!parsed.ok) {
      this.logger.warn(`job ${WF_EVENTS_QUEUE} invalide ignoré : ${parsed.issues.join('; ')}`);
      return { accepted: false };
    }
    if (!QUEUE_EVENT_TYPES.has(parsed.value.type)) {
      this.logger.warn(`job ${WF_EVENTS_QUEUE} : type « ${parsed.value.type} » non admis par la file, ignoré`);
      return { accepted: false };
    }
    if (this.bus.pendingCount >= WF_EVENT_BUS_MAX_PENDING) {
      throw new Error("file interne du bus d'événements pleine : nouvelle tentative différée");
    }
    return { accepted: this.bus.emit(parsed.value) };
  }

  async onApplicationShutdown(): Promise<void> {
    const worker = this.worker;
    const connection = this.connection;
    this.worker = null;
    this.connection = null;
    try {
      await worker?.close();
    } catch (err) {
      this.logger.warn(`fermeture du worker impossible : ${err instanceof Error ? err.message : String(err)}`);
    }
    connection?.disconnect();
  }
}
