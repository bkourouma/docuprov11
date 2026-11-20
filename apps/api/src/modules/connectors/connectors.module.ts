import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createDefaultRegistry } from '@archivage/connectors';
import { AuthModule } from '../auth/auth.module';
import { ConnectorsController } from './connectors.controller';
import { GED_CONNECTOR_REGISTRY, ConnectorsService } from './connectors.service';
import {
  closeConnectorsQueue,
  connectorsQueueProvider,
  GED_CONNECTOR_QUEUE_TOKEN,
} from './connectors-queue.provider';

/**
 * Administration des connecteurs de sources GED (lot 2a). Indépendant d'`AiModule`. `PrismaService`
 * et `AuditService` sont globaux. Le registre est créé ici : ajouter un type de connecteur ne
 * touche que `createDefaultRegistry`.
 */
@Module({
  imports: [AuthModule],
  controllers: [ConnectorsController],
  providers: [
    ConnectorsService,
    connectorsQueueProvider,
    { provide: GED_CONNECTOR_REGISTRY, useFactory: createDefaultRegistry },
  ],
  exports: [ConnectorsService],
})
export class ConnectorsModule implements OnApplicationShutdown {
  constructor(@Inject(GED_CONNECTOR_QUEUE_TOKEN) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await closeConnectorsQueue(this.queue);
  }
}
