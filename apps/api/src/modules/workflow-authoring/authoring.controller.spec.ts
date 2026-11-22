import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../workflows/workflows.menus';
import { AuthoringController } from './authoring.controller';
import { AuthoringRateLimitGuard } from './authoring.rate-limit.guard';

const proto = AuthoringController.prototype as unknown as Record<string, (...a: never[]) => unknown>;
const meta = <T>(key: string, target: object): T | undefined => Reflect.getMetadata(key, target) as T | undefined;

describe('AuthoringController : accès refusé par défaut', () => {
  it('le contrôleur est sous MenuPermissionGuard et sous le préfixe workflows/authoring', () => {
    expect(meta<unknown[]>(GUARDS_METADATA, AuthoringController)).toContain(MenuPermissionGuard);
    expect(meta<string>(PATH_METADATA, AuthoringController)).toBe('workflows/authoring');
  });

  it('chaque route exige le menu conception', () => {
    const routes = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && meta(METHOD_METADATA, proto[n]) !== undefined,
    );
    expect(routes.sort()).toEqual(['explain', 'generate']);
    for (const name of routes) {
      expect(meta<string[]>(REQUIRE_MENU_KEY, proto[name])).toEqual([WORKFLOWS_MENUS.design]);
      expect(meta(METHOD_METADATA, proto[name])).toBe(RequestMethod.POST);
      expect(meta(REQUIRE_ADMIN_KEY, proto[name])).toBeUndefined();
    }
  });

  it('generate : POST generate, limiteur de débit, code 201 par défaut', () => {
    expect(meta<string>(PATH_METADATA, proto.generate)).toBe('generate');
    expect(meta<unknown[]>(GUARDS_METADATA, proto.generate)).toEqual([AuthoringRateLimitGuard]);
    expect(meta(HTTP_CODE_METADATA, proto.generate)).toBeUndefined(); // POST => 201
  });

  it('explain : POST explain/:definitionId, code 200, sans limiteur', () => {
    expect(meta<string>(PATH_METADATA, proto.explain)).toBe('explain/:definitionId');
    expect(meta(HTTP_CODE_METADATA, proto.explain)).toBe(200);
    expect(meta(GUARDS_METADATA, proto.explain)).toBeUndefined();
  });

  it('délègue au service avec l’utilisateur courant', async () => {
    const service = {
      generate: jest.fn().mockResolvedValue({ definitionId: 1 }),
      explain: jest.fn().mockResolvedValue({ s: 1 }),
    };
    const ctrl = new AuthoringController(service as never);
    const user = { userId: 1 } as never;
    await expect(ctrl.generate({ description: 'x' }, user)).resolves.toEqual({ definitionId: 1 });
    expect(service.generate).toHaveBeenCalledWith({ description: 'x' }, user);
    await ctrl.explain(5, user);
    expect(service.explain).toHaveBeenCalledWith(5, user);
  });
});
