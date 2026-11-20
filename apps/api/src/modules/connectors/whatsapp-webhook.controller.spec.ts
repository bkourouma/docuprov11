import { type ExecutionContext, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRE_ADMIN_KEY } from '../auth/require-menu.decorator';
import { ConnectorsController } from './connectors.controller';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import type { WhatsappWebhookService } from './whatsapp-webhook.service';

const proto = WhatsappWebhookController.prototype as unknown as Record<string, object>;
const handlerNames = Object.getOwnPropertyNames(WhatsappWebhookController.prototype).filter(
  (n) => n !== 'constructor',
);

function contextFor(cls: object, handler: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

describe('WhatsappWebhookController', () => {
  describe('routage et exposition', () => {
    it('est @Public au niveau du contrôleur, sous ged/webhooks/whatsapp', () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, WhatsappWebhookController)).toBe(true);
      expect(Reflect.getMetadata(PATH_METADATA, WhatsappWebhookController)).toBe('ged/webhooks/whatsapp');
    });

    it('n’expose que GET et POST :connectorId, sans garde ni exigence admin', () => {
      expect(handlerNames.sort()).toEqual(['receive', 'verify']);
      expect(Reflect.getMetadata(METHOD_METADATA, proto.verify!)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(PATH_METADATA, proto.verify!)).toBe(':connectorId');
      expect(Reflect.getMetadata(METHOD_METADATA, proto.receive!)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(PATH_METADATA, proto.receive!)).toBe(':connectorId');
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.receive!)).toBe(200);
      expect(Reflect.getMetadata(GUARDS_METADATA, WhatsappWebhookController)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, WhatsappWebhookController)).toBeUndefined();
    });

    it('challenge non mis en cache, sans reniflage ; text/plain posé seulement en cas de succès', () => {
      const headers = Reflect.getMetadata(HEADERS_METADATA, proto.verify!) as { name: string; value: string }[];
      const map = Object.fromEntries(headers.map((h) => [h.name.toLowerCase(), h.value]));
      expect(map['content-type']).toBeUndefined();
      expect(map['cache-control']).toBe('no-store');
      expect(map['x-content-type-options']).toBe('nosniff');
    });

    it('le garde JWT global laisse passer ses deux routes sans jeton', () => {
      const guard = new JwtAuthGuard(new Reflector(), { get: () => undefined } as never);
      for (const name of handlerNames) {
        expect(guard.canActivate(contextFor(WhatsappWebhookController, proto[name]!))).toBe(true);
      }
    });
  });

  describe('ConnectorsController reste réservé aux administrateurs', () => {
    it('ni @Public ni route publique ; MenuPermissionGuard et @RequireAdmin conservés', () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, ConnectorsController)).toBeUndefined();
      expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, ConnectorsController)).toBe(true);
      expect(Reflect.getMetadata(GUARDS_METADATA, ConnectorsController)).toContain(MenuPermissionGuard);
      const adminProto = ConnectorsController.prototype as unknown as Record<string, object>;
      for (const name of Object.getOwnPropertyNames(ConnectorsController.prototype)) {
        if (name === 'constructor') continue;
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, adminProto[name]!)).toBeUndefined();
      }
      // Les deux contrôleurs ne partagent pas de préfixe : aucune route admin sous le webhook.
      expect(Reflect.getMetadata(PATH_METADATA, ConnectorsController)).toBe('ged/connectors');
    });

    it('le garde JWT global n’ouvre pas ConnectorsController (délègue à passport)', () => {
      const guard = new JwtAuthGuard(new Reflector(), { get: () => undefined } as never);
      const parent = Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: () => unknown };
      const delegated = jest.spyOn(parent, 'canActivate').mockReturnValue(false);
      const adminProto = ConnectorsController.prototype as unknown as Record<string, object>;
      expect(guard.canActivate(contextFor(ConnectorsController, adminProto.list!))).toBe(false);
      expect(delegated).toHaveBeenCalledTimes(1);
      delegated.mockRestore();
    });
  });

  describe('délégation au service', () => {
    const service = {
      verifySubscription: jest.fn(async () => 'challenge-1'),
      receiveNotification: jest.fn(async () => ({ received: true as const })),
    };
    const controller = new WhatsappWebhookController(service as unknown as WhatsappWebhookService);

    beforeEach(() => jest.clearAllMocks());

    it('GET : identifiant brut, requête et query transmis tels quels ; text/plain sur succès', async () => {
      const req = { headers: {}, socket: { remoteAddress: '203.0.113.1' } };
      const res = { setHeader: jest.fn() };
      const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 't', 'hub.challenge': 'c' };
      await expect(controller.verify('12', query, req, res)).resolves.toBe('challenge-1');
      expect(service.verifySubscription).toHaveBeenCalledWith('12', query, req);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    });

    it('GET en échec : aucune en-tête text/plain posée (le filtre répond en JSON)', async () => {
      const res = { setHeader: jest.fn() };
      service.verifySubscription.mockRejectedValueOnce(new Error('refus'));
      await expect(controller.verify('12', {}, { headers: {} }, res)).rejects.toThrow('refus');
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('POST : corps brut (Buffer) et en-tête de signature transmis, jamais analysés', async () => {
      const body = Buffer.from('{"a":1}');
      const req = { headers: { 'x-hub-signature-256': 'sha256=abc' }, body, socket: {} };
      await expect(controller.receive('12', req)).resolves.toEqual({ received: true });
      expect(service.receiveNotification).toHaveBeenCalledWith({
        connectorId: '12',
        body,
        signature: 'sha256=abc',
        req,
      });
    });
  });
});
