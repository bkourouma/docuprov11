import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ConnectionOptions, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ACQUISITION_QUEUE, ACQUISITION_QUEUE_TOKEN } from './queue.constants';

@Global()
@Module({
  providers: [
    {
      provide: ACQUISITION_QUEUE_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Queue => {
        const connection = new IORedis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: null,
        });
        return new Queue(ACQUISITION_QUEUE, {
          connection: connection as unknown as ConnectionOptions,
        });
      },
    },
  ],
  exports: [ACQUISITION_QUEUE_TOKEN],
})
export class QueueModule {}
