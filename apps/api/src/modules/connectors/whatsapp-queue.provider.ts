import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConnectionOptions, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GED_WHATSAPP_QUEUE } from '@archivage/types';

/**
 * Jeton d'injection de la file `ged-whatsapp-inbound` (lot 2c). Producteur : le webhook public de
 * cette API ; consommateur : le worker (téléchargement du média, ingestion, accusé, refus).
 */
export const GED_WHATSAPP_QUEUE_TOKEN = 'GED_WHATSAPP_QUEUE_TOKEN';

/** Connexion Redis propre à la file, pour la fermer avec elle à l'arrêt. */
const connections = new WeakMap<Queue, IORedis>();

export const whatsappQueueProvider: Provider = {
  provide: GED_WHATSAPP_QUEUE_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Queue => {
    const connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue(GED_WHATSAPP_QUEUE, {
      connection: connection as unknown as ConnectionOptions,
    });
    connections.set(queue, connection);
    return queue;
  },
};

/** Ferme la file puis sa connexion (BullMQ ne ferme pas une connexion qu'on lui a fournie). */
export async function closeWhatsappQueue(queue: Queue): Promise<void> {
  try {
    await queue.close();
  } finally {
    const connection = connections.get(queue);
    if (connection) {
      connections.delete(queue);
      connection.disconnect();
    }
  }
}
