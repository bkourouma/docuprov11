import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { WF_EVENT_BUS_MAX_PENDING } from '../domain/contracts';
import { WorkflowEventBus } from '../bus/workflow-event-bus';
import { documentDepositedEvent, mailArrivedEvent } from '../domain/events';
import { WorkflowEventsConsumer } from './workflow-events.consumer';

jest.mock('bullmq', () => ({ Worker: jest.fn() }));
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Worker } = require('bullmq') as { Worker: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const IORedis = (require('ioredis') as { default: jest.Mock }).default;

const config = (redisUrl?: string): ConfigService =>
  ({ get: (k: string) => (k === 'REDIS_URL' ? redisUrl : undefined) }) as unknown as ConfigService;

describe('WorkflowEventsConsumer', () => {
  let bus: WorkflowEventBus;
  const env = { ...process.env };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    Worker.mockReset();
    IORedis.mockReset();
    bus = new WorkflowEventBus();
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('processJob : événement valide remis au bus', async () => {
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.type);
    });
    const consumer = new WorkflowEventsConsumer(config(), bus);
    expect(consumer.processJob(documentDepositedEvent({ documentId: 3 }, { source: 'acquisition' }))).toEqual({
      accepted: true,
    });
    await bus.idle();
    expect(seen).toEqual(['document.deposited']);
  });

  it('processJob : mail.arrived refusé (non émis par le worker), sans lever ni émettre', () => {
    const consumer = new WorkflowEventsConsumer(config(), bus);
    const emit = jest.spyOn(bus, 'emit');
    expect(consumer.processJob(mailArrivedEvent({ mailId: 3, mailType: 0, status: 1 }))).toEqual({ accepted: false });
    expect(emit).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('processJob : file du bus pleine = lève (rejeu BullMQ) ; événement invalide = abandon sans lever', () => {
    const consumer = new WorkflowEventsConsumer(config(), bus);
    jest.spyOn(bus, 'pendingCount', 'get').mockReturnValue(WF_EVENT_BUS_MAX_PENDING);
    const emit = jest.spyOn(bus, 'emit');
    const valid = documentDepositedEvent({ documentId: 3 }, { source: 'acquisition' });
    expect(() => consumer.processJob(valid)).toThrow(/pleine/);
    expect(emit).not.toHaveBeenCalled();
    expect(consumer.processJob({ n: 'invalide' })).toEqual({ accepted: false });
  });

  it('processJob : événement invalide ignoré sans lever', () => {
    const consumer = new WorkflowEventsConsumer(config(), bus);
    const emit = jest.spyOn(bus, 'emit');
    expect(consumer.processJob({ n: 'importe quoi' })).toEqual({ accepted: false });
    expect(consumer.processJob(undefined)).toEqual({ accepted: false });
    expect(emit).not.toHaveBeenCalled();
  });

  it('processJob : type hors catalogue ou champ hors catalogue refusés', () => {
    const consumer = new WorkflowEventsConsumer(config(), bus);
    const base = mailArrivedEvent({ mailId: 3, mailType: 0, status: 1 });
    expect(consumer.processJob({ ...base, type: 'mail.deleted' })).toEqual({ accepted: false });
    expect(consumer.processJob({ ...base, fields: { ...base.fields, objet: 'texte libre' } })).toEqual({ accepted: false });
  });

  it('aucun démarrage Redis quand NODE_ENV=test', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.WF_EVENTS_CONSUMER_DISABLED;
    new WorkflowEventsConsumer(config('redis://127.0.0.1:6379'), bus).onApplicationBootstrap();
    expect(IORedis).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });

  it('aucun démarrage sans REDIS_URL ni quand WF_EVENTS_CONSUMER_DISABLED=true', () => {
    process.env.NODE_ENV = 'production';
    new WorkflowEventsConsumer(config(undefined), bus).onApplicationBootstrap();
    process.env.WF_EVENTS_CONSUMER_DISABLED = 'true';
    new WorkflowEventsConsumer(config('redis://127.0.0.1:6379'), bus).onApplicationBootstrap();
    expect(IORedis).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled();
  });

  it('démarre un worker (concurrence 1) puis le ferme proprement avec sa connexion', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WF_EVENTS_CONSUMER_DISABLED;
    const disconnect = jest.fn();
    const close = jest.fn().mockResolvedValue(undefined);
    IORedis.mockImplementation(() => ({ disconnect }));
    Worker.mockImplementation(() => ({ on: jest.fn(), close }));
    const consumer = new WorkflowEventsConsumer(config('redis://127.0.0.1:6379'), bus);
    consumer.onApplicationBootstrap();
    expect(IORedis).toHaveBeenCalledWith('redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
    expect(Worker).toHaveBeenCalledWith('wf-events', expect.any(Function), expect.objectContaining({ concurrency: 1 }));
    await consumer.onApplicationShutdown();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
