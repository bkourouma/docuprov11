import { Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { WHATSAPP_SIGNATURE_HEADER } from '@archivage/connectors';
import { Public } from '../auth/public.decorator';
import { WHATSAPP_WEBHOOK_ROUTE } from './whatsapp-raw-body';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

/** Requête vue par le contrôleur (Express) : seuls ces champs sont lus. */
interface WebhookRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
  /** Buffer posé par `whatsapp-raw-body` (jamais un objet analysé). */
  body?: unknown;
}

/** Réponse (Express) : seule l'écriture d'en-tête est utilisée. */
interface HeaderWriter {
  setHeader(name: string, value: string): unknown;
}

/**
 * Webhook PUBLIC du connecteur WhatsApp Business (lot 2c) : `/api/ged/webhooks/whatsapp/:connectorId`.
 *
 * Isolé de `ConnectorsController` (réservé aux administrateurs) : c'est la seule route sans JWT du
 * lot. L'authentification est celle de Meta : jeton de vérification (GET) et signature HMAC du corps
 * brut (POST), vérifiés par `WhatsappWebhookService` avant toute autre opération. Aucun garde
 * applicatif n'est ajouté (Meta ne porte ni JWT ni rôle) et aucune donnée n'est renvoyée hors du
 * challenge et de `{ received: true }`.
 */
@Public()
@Controller(WHATSAPP_WEBHOOK_ROUTE)
export class WhatsappWebhookController {
  constructor(private readonly service: WhatsappWebhookService) {}

  /** Abonnement : Meta envoie `hub.mode`, `hub.verify_token`, `hub.challenge` ; on renvoie le challenge. */
  @Get(':connectorId')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async verify(
    @Param('connectorId') connectorId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: WebhookRequest,
    @Res({ passthrough: true }) res: HeaderWriter,
  ): Promise<string> {
    const challenge = await this.service.verifySubscription(connectorId, query ?? {}, req);
    // Posé seulement en cas de succès : `@Header` s'appliquerait aussi aux réponses d'erreur
    // (JSON du filtre d'exceptions alors annoncé en text/plain).
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return challenge;
  }

  /** Notification : 200 `{ received: true }` une fois les messages enregistrés et mis en file. */
  @Post(':connectorId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  receive(
    @Param('connectorId') connectorId: string,
    @Req() req: WebhookRequest,
  ): Promise<{ received: true }> {
    return this.service.receiveNotification({
      connectorId,
      body: req.body,
      signature: req.headers[WHATSAPP_SIGNATURE_HEADER],
      req,
    });
  }
}
