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
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import {
  closeOAuthStateStore,
  GED_OAUTH_STATE_STORE,
  oauthStateStoreProvider,
  type OAuthStateStore,
} from './oauth-state.store';

/**
 * Administration des connecteurs de sources GED (lots 2a et 2b). Indépendant d'`AiModule`.
 * `PrismaService` et `AuditService` sont globaux. Le registre est créé ici : ajouter un type de
 * connecteur ne touche que `createDefaultRegistry`.
 *
 * `OAuthController` précède `ConnectorsController` : `oauth/callback` ne doit pas être pris pour `:id`.
 */
@Module({
  imports: [AuthModule],
  controllers: [OAuthController, ConnectorsController],
  providers: [
    ConnectorsService,
    OAuthService,
    connectorsQueueProvider,
    oauthStateStoreProvider,
    { provide: GED_CONNECTOR_REGISTRY, useFactory: createDefaultRegistry },
  ],
  exports: [ConnectorsService],
})
export class ConnectorsModule implements OnApplicationShutdown {
  constructor(
    @Inject(GED_CONNECTOR_QUEUE_TOKEN) private readonly queue: Queue,
    @Inject(GED_OAUTH_STATE_STORE) private readonly oauthStore: OAuthStateStore,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await closeConnectorsQueue(this.queue);
    await closeOAuthStateStore(this.oauthStore);
  }
}
