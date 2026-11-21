import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY } from '../auth/require-menu.decorator';
import { ConnectorsModule } from './connectors.module';
import { ConnectorsController } from './connectors.controller';
import { OAuthController } from './oauth.controller';

const user: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 5 };
const nonAdmin: AuthUser = { userId: 2, username: 'lecteur', isAdmin: false, userGroupId: 6 };

type PipeLike = { transform(value: unknown, metadata: never): unknown };
const meta = {} as never;

function pipeOf(method: string, key: string | undefined): PipeLike {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, OAuthController, method) as Record<
    string,
    { data?: string; pipes: PipeLike[] }
  >;
  const entry = Object.values(args).find((e) => e.data === key && e.pipes.length > 0);
  if (!entry) throw new Error(`Aucun pipe sur ${method}:${String(key)}`);
  return entry.pipes[0];
}

const handlerNames = Object.getOwnPropertyNames(OAuthController.prototype).filter(
  (n) => n !== 'constructor',
);

describe('OAuthController', () => {
  describe('accès refusé par défaut', () => {
    it('porte MenuPermissionGuard et REQUIRE_ADMIN_KEY sur le contrôleur entier', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, OAuthController) as unknown[];
      expect(guards).toContain(MenuPermissionGuard);
      expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, OAuthController)).toBe(true);
      expect(Reflect.getMetadata(PATH_METADATA, OAuthController)).toBe('ged/connectors');
    });

    it('aucune route ne lève l’exigence admin ni ne porte un garde plus laxiste', () => {
      const proto = OAuthController.prototype as unknown as Record<string, object>;
      expect(handlerNames.sort()).toEqual(['callback', 'start']);
      for (const name of handlerNames) {
        expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto[name])).not.toBe(false);
        expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toBeUndefined();
      }
    });

    it('le garde réel rejette un non-administrateur sur tous les handlers, accepte un admin', async () => {
      const guard = new MenuPermissionGuard(new Reflector(), {} as never);
      const proto = OAuthController.prototype as unknown as Record<string, () => unknown>;
      const ctxFor = (u: AuthUser, name: string) =>
        ({
          switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
          getHandler: () => proto[name],
          getClass: () => OAuthController,
        }) as unknown as ExecutionContext;
      for (const name of handlerNames) {
        await expect(guard.canActivate(ctxFor(nonAdmin, name))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(guard.canActivate(ctxFor(user, name))).resolves.toBe(true);
      }
    });
  });

  describe('ordre des routes', () => {
    it('le contrôleur OAuth précède ConnectorsController dans le module', () => {
      const controllers = Reflect.getMetadata('controllers', ConnectorsModule) as unknown[];
      expect(controllers.indexOf(OAuthController)).toBeGreaterThanOrEqual(0);
      expect(controllers.indexOf(OAuthController)).toBeLessThan(
        controllers.indexOf(ConnectorsController),
      );
    });

    it('oauth/callback est une route statique, déclarée avant la route paramétrée', () => {
      const proto = OAuthController.prototype as unknown as Record<string, object>;
      expect(Reflect.getMetadata(PATH_METADATA, proto.callback)).toBe('oauth/callback');
      expect(Reflect.getMetadata(PATH_METADATA, proto.start)).toBe(':id/oauth/start');
      const names = Object.getOwnPropertyNames(OAuthController.prototype);
      expect(names.indexOf('callback')).toBeLessThan(names.indexOf('start'));
    });
  });

  describe('délégation', () => {
    it('chaque handler appelle le service avec les bons arguments', async () => {
      const service = {
        start: jest.fn().mockResolvedValue({ authorizationUrl: 'u', expiresInSeconds: 600 }),
        callback: jest.fn().mockResolvedValue({ connectorId: 3, authorized: true, expiresAt: null }),
      };
      const c = new OAuthController(service as never);
      const startBody = { redirectUri: 'https://x.example/cb' };
      await c.start(3, startBody, user);
      expect(service.start).toHaveBeenCalledWith(3, startBody, user);
      const cbBody = { code: 'c', state: 's' };
      await c.callback(cbBody, user);
      expect(service.callback).toHaveBeenCalledWith(cbBody, user);
    });
  });

  describe('validation stricte', () => {
    it('start : id invalide => 400 ; corps non strict ou vide => 400', () => {
      const idPipe = pipeOf('start', 'id');
      for (const bad of [0, -1, 1.5, 'abc', '']) {
        expect(() => idPipe.transform(bad, meta)).toThrow(BadRequestException);
      }
      expect(idPipe.transform('7', meta)).toBe(7);
      const body = pipeOf('start', undefined);
      for (const bad of [
        {},
        { redirectUri: '' },
        { redirectUri: 'https://x.example/cb', extra: 1 },
        { redirectUri: 1 },
        { redirectUri: 'a'.repeat(2049) },
        null,
      ]) {
        expect(() => body.transform(bad, meta)).toThrow(BadRequestException);
      }
      expect(body.transform({ redirectUri: 'https://x.example/cb' }, meta)).toEqual({
        redirectUri: 'https://x.example/cb',
      });
    });

    it('callback : corps non strict, vide ou trop long => 400', () => {
      const body = pipeOf('callback', undefined);
      for (const bad of [
        {},
        { code: 'c' },
        { state: 's' },
        { code: '', state: 's' },
        { code: 'c', state: '' },
        { code: 'c', state: 's', extra: 1 },
        { code: 'c'.repeat(4097), state: 's' },
        { code: 'c', state: 's'.repeat(2049) },
        { code: 1, state: 's' },
      ]) {
        expect(() => body.transform(bad, meta)).toThrow(BadRequestException);
      }
      expect(body.transform({ code: 'c'.repeat(4096), state: 's'.repeat(2048) }, meta)).toEqual({
        code: 'c'.repeat(4096),
        state: 's'.repeat(2048),
      });
    });
  });
});
