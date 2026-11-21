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
// --- Lot 2c : webhook public WhatsApp ---
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappWebhookService, whatsappRateLimiterProviders } from './whatsapp-webhook.service';
import {
  closeWhatsappQueue,
  GED_WHATSAPP_QUEUE_TOKEN,
  whatsappQueueProvider,
} from './whatsapp-queue.provider';
// --- fin Lot 2c ---

/**
 * Administration des connecteurs de sources GED (lots 2a, 2b et 2c). Indépendant d'`AiModule`.
 * `PrismaService` et `AuditService` sont globaux. Le registre est créé ici : ajouter un type de
 * connecteur ne touche que `createDefaultRegistry`.
 *
 * `OAuthController` précède `ConnectorsController` : `oauth/callback` ne doit pas être pris pour `:id`.
 *
 * Lot 2c : webhook PUBLIC WhatsApp (`WhatsappWebhookController`, `@Public`), isolé du contrôleur
 * d'administration, avec sa file `ged-whatsapp-inbound` et ses limiteurs de débit.
 */
@Module({
  imports: [AuthModule],
  controllers: [OAuthController, ConnectorsController, WhatsappWebhookController],
  providers: [
    ConnectorsService,
    OAuthService,
    connectorsQueueProvider,
    oauthStateStoreProvider,
    { provide: GED_CONNECTOR_REGISTRY, useFactory: createDefaultRegistry },
    // Lot 2c
    WhatsappWebhookService,
    whatsappQueueProvider,
    ...whatsappRateLimiterProviders,
  ],
  exports: [ConnectorsService],
})
export class ConnectorsModule implements OnApplicationShutdown {
  constructor(
    @Inject(GED_CONNECTOR_QUEUE_TOKEN) private readonly queue: Queue,
    @Inject(GED_OAUTH_STATE_STORE) private readonly oauthStore: OAuthStateStore,
    @Inject(GED_WHATSAPP_QUEUE_TOKEN) private readonly whatsappQueue: Queue,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Toutes les files et le magasin d'état sont fermés même si une fermeture échoue.
    try {
      await closeConnectorsQueue(this.queue);
    } finally {
      try {
        await closeWhatsappQueue(this.whatsappQueue);
      } finally {
        await closeOAuthStateStore(this.oauthStore);
      }
    }
  }
}
