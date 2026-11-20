import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY } from '../auth/require-menu.decorator';
import { ConnectorsController } from './connectors.controller';

const user: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 5 };
const nonAdmin: AuthUser = { userId: 2, username: 'lecteur', isAdmin: false, userGroupId: 6 };

type PipeLike = { transform(value: unknown, metadata: never): unknown };
const meta = {} as never;

function pipeOf(method: string, key: string): PipeLike {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ConnectorsController, method) as Record<
    string,
    { data?: string; pipes: PipeLike[] }
  >;
  const entry = Object.values(args).find((e) => e.data === key && e.pipes.length > 0);
  if (!entry) throw new Error(`Aucun pipe sur ${method}:${key}`);
  return entry.pipes[0];
}

const handlerNames = Object.getOwnPropertyNames(ConnectorsController.prototype).filter(
  (n) => n !== 'constructor',
);

describe('ConnectorsController', () => {
  describe('accès refusé par défaut', () => {
    it('porte MenuPermissionGuard et REQUIRE_ADMIN_KEY sur le contrôleur entier', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, ConnectorsController) as unknown[];
      expect(guards).toContain(MenuPermissionGuard);
      expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, ConnectorsController)).toBe(true);
    });

    it('aucune route ne lève l’exigence admin ni ne porte un garde plus laxiste', () => {
      const proto = ConnectorsController.prototype as unknown as Record<string, object>;
      for (const name of handlerNames) {
        expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto[name])).not.toBe(false);
        expect(Reflect.getMetadata(GUARDS_METADATA, proto[name])).toBeUndefined();
      }
    });

    it('le garde réel rejette un non-administrateur sur TOUS les handlers', async () => {
      const guard = new MenuPermissionGuard(new Reflector(), {} as never);
      const proto = ConnectorsController.prototype as unknown as Record<string, () => unknown>;
      expect(handlerNames.length).toBeGreaterThanOrEqual(13);
      for (const name of handlerNames) {
        const ctx = {
          switchToHttp: () => ({ getRequest: () => ({ user: nonAdmin }) }),
          getHandler: () => proto[name],
          getClass: () => ConnectorsController,
        } as unknown as ExecutionContext;
        await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it('le garde réel laisse passer un administrateur', async () => {
      const guard = new MenuPermissionGuard(new Reflector(), {} as never);
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
        getHandler: () => ConnectorsController.prototype.list,
        getClass: () => ConnectorsController,
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('ordre des routes', () => {
    it('les routes statiques sont déclarées avant les routes paramétrées', () => {
      const idx = (n: string) => handlerNames.indexOf(n);
      expect(idx('listTypes')).toBeLessThan(idx('get'));
      expect(idx('rotateKeys')).toBeLessThan(idx('get'));
      expect(idx('rotateKeys')).toBeLessThan(idx('deactivate'));
    });
  });

  describe('délégation', () => {
    it('chaque handler appelle le service avec les bons arguments', async () => {
      const service = {
        listTypes: jest.fn().mockReturnValue(['t']),
        list: jest.fn().mockResolvedValue(['l']),
        create: jest.fn().mockResolvedValue('c'),
        rotateKeys: jest.fn().mockResolvedValue({ reencrypted: 2 }),
        get: jest.fn().mockResolvedValue('g'),
        update: jest.fn().mockResolvedValue('u'),
        deactivate: jest.fn().mockResolvedValue('d'),
        activate: jest.fn().mockResolvedValue('a'),
        testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'm' }),
        requestSync: jest.fn().mockResolvedValue({ queued: true }),
        listRuns: jest.fn().mockResolvedValue([]),
        listItems: jest.fn().mockResolvedValue({}),
        getItem: jest.fn().mockResolvedValue({}),
      };
      const c = new ConnectorsController(service as never);
      const body = { label: 'x' } as never;

      expect(c.listTypes()).toEqual(['t']);
      await c.list();
      await c.create(body, user);
      expect(service.create).toHaveBeenCalledWith(body, user);
      await expect(c.rotateKeys(user)).resolves.toEqual({ reencrypted: 2 });
      expect(service.rotateKeys).toHaveBeenCalledWith(user);
      await c.get(3);
      expect(service.get).toHaveBeenCalledWith(3);
      await c.update(3, body, user);
      expect(service.update).toHaveBeenCalledWith(3, body, user);
      await c.deactivate(3, user);
      await c.activate(3, user);
      await c.test(3);
      expect(service.testConnection).toHaveBeenCalledWith(3);
      await c.sync(3, user);
      expect(service.requestSync).toHaveBeenCalledWith(3, user);
      await c.runs(3, { limit: 5 });
      expect(service.listRuns).toHaveBeenCalledWith(3, { limit: 5 });
      await c.items(3, { page: 2 });
      expect(service.listItems).toHaveBeenCalledWith(3, { page: 2 });
      await c.item(3, 8);
      expect(service.getItem).toHaveBeenCalledWith(3, 8);
    });
  });

  describe('identifiants de route', () => {
    const routesWithId = [
      'get',
      'update',
      'deactivate',
      'activate',
      'test',
      'sync',
      'runs',
      'items',
      'item',
    ];

    it.each(routesWithId)('%s : id invalide => 400', (method) => {
      const pipe = pipeOf(method, 'id');
      for (const bad of [0, -1, 1.5, 'abc', '', '2147483648', 'NaN']) {
        expect(() => pipe.transform(bad, meta)).toThrow(BadRequestException);
      }
      expect(pipe.transform('7', meta)).toBe(7);
      expect(pipe.transform('2147483647', meta)).toBe(2147483647);
    });

    it('item : itemId (BigInt) entier > 0 représentable exactement', () => {
      const pipe = pipeOf('item', 'itemId');
      for (const bad of [0, -1, 1.5, 'abc', '', '9007199254740992']) {
        expect(() => pipe.transform(bad, meta)).toThrow(BadRequestException);
      }
      expect(pipe.transform('9007199254740991', meta)).toBe(9007199254740991);
    });
  });

  describe('corps et requêtes validés par zod strict', () => {
    it('create refuse un champ inconnu ; update refuse connectorType', () => {
      expect(() =>
        pipeOf('create', undefined as never).transform(
          { label: 'x', connectorType: 'fake', mode: 0, inconnu: 1 },
          meta,
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        pipeOf('update', undefined as never).transform({ connectorType: 'imap' }, meta),
      ).toThrow(BadRequestException);
    });

    it('items : pageSize > 100 => 400', () => {
      expect(() =>
        pipeOf('items', undefined as never).transform({ pageSize: '101' }, meta),
      ).toThrow(BadRequestException);
    });
  });
});
