import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConnectionOptions, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GED_GOVERNANCE_QUEUE } from '@archivage/types';

/** Jeton d'injection de la file `ged-governance` (analyses de gouvernance, consommées par le worker). */
export const GED_GOVERNANCE_QUEUE_TOKEN = 'GED_GOVERNANCE_QUEUE_TOKEN';

/** Connexion Redis propre à chaque file, pour pouvoir la fermer avec elle à l'arrêt. */
const connections = new WeakMap<Queue, IORedis>();

export const governanceQueueProvider: Provider = {
  provide: GED_GOVERNANCE_QUEUE_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Queue => {
    const connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    const queue = new Queue(GED_GOVERNANCE_QUEUE, {
      connection: connection as unknown as ConnectionOptions,
    });
    connections.set(queue, connection);
    return queue;
  },
};

/** Ferme la file puis sa connexion (BullMQ ne ferme pas une connexion qu'on lui a fournie). */
export async function closeGovernanceQueue(queue: Queue): Promise<void> {
  await queue.close();
  const connection = connections.get(queue);
  if (connection) {
    connections.delete(queue);
    connection.disconnect();
  }
}
