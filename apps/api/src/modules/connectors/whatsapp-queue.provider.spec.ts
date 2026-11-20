import type { FactoryProvider } from '@nestjs/common';
import { GED_WHATSAPP_QUEUE } from '@archivage/types';
import {
  closeWhatsappQueue,
  GED_WHATSAPP_QUEUE_TOKEN,
  whatsappQueueProvider,
} from './whatsapp-queue.provider';

// Aucun Redis réel : connexion et file simulées.
const redisInstances: { url: string; opts: unknown; disconnect: jest.Mock }[] = [];
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string, opts: unknown) => {
    const inst = { url, opts, disconnect: jest.fn() };
    redisInstances.push(inst);
    return inst;
  }),
}));
const queueInstances: { name: string; opts: { connection: unknown }; close: jest.Mock }[] = [];
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string, opts: { connection: unknown }) => {
    const inst = { name, opts, close: jest.fn(async () => undefined) };
    queueInstances.push(inst);
    return inst;
  }),
}));

describe('whatsappQueueProvider', () => {
  const provider = whatsappQueueProvider as FactoryProvider;
  const config = { getOrThrow: jest.fn(() => 'redis://cache.test:6379') };

  beforeEach(() => {
    redisInstances.length = 0;
    queueInstances.length = 0;
  });

  it('crée la file ged-whatsapp-inbound sur sa propre connexion Redis', () => {
    expect(provider.provide).toBe(GED_WHATSAPP_QUEUE_TOKEN);
    const queue = provider.useFactory(config);
    expect(config.getOrThrow).toHaveBeenCalledWith('REDIS_URL');
    expect(redisInstances).toHaveLength(1);
    expect(redisInstances[0]!.opts).toEqual({ maxRetriesPerRequest: null });
    expect(queueInstances[0]!.name).toBe(GED_WHATSAPP_QUEUE);
    expect(queueInstances[0]!.opts.connection).toBe(redisInstances[0]);
    expect(queue).toBe(queueInstances[0]);
  });

  it('ferme la file puis sa connexion, même si la fermeture de la file échoue', async () => {
    const queue = provider.useFactory(config);
    await closeWhatsappQueue(queue);
    expect(queueInstances[0]!.close).toHaveBeenCalledTimes(1);
    expect(redisInstances[0]!.disconnect).toHaveBeenCalledTimes(1);

    const failing = provider.useFactory(config);
    queueInstances[1]!.close.mockRejectedValueOnce(new Error('déjà fermée'));
    await expect(closeWhatsappQueue(failing)).rejects.toThrow('déjà fermée');
    expect(redisInstances[1]!.disconnect).toHaveBeenCalledTimes(1);
  });
});
