import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConnectionOptions, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GED_CONNECTOR_SYNC_QUEUE } from '@archivage/types';

/** Jeton d'injection de la file `ged-connector-sync` (producteur : cette API, consommateur : le worker). */
export const GED_CONNECTOR_QUEUE_TOKEN = 'GED_CONNECTOR_QUEUE_TOKEN';

/** Connexion Redis propre à la file, pour la fermer avec elle à l'arrêt. */
const connections = new WeakMap<Queue, IORedis>();

export const connectorsQueueProvider: Provider = {
  provide: GED_CONNECTOR_QUEUE_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Queue => {
    const connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue(GED_CONNECTOR_SYNC_QUEUE, {
      connection: connection as unknown as ConnectionOptions,
    });
    connections.set(queue, connection);
    return queue;
  },
};

/** Ferme la file puis sa connexion (BullMQ ne ferme pas une connexion qu'on lui a fournie). */
export async function closeConnectorsQueue(queue: Queue): Promise<void> {
  await queue.close();
  const connection = connections.get(queue);
  if (connection) {
    connections.delete(queue);
    connection.disconnect();
  }
}
