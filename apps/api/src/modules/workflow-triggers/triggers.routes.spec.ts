import 'reflect-metadata';
import { ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../workflows/workflows.menus';
import { WorkflowTriggersController } from './triggers.controller';

interface Route {
  handler: string;
  method: RequestMethod;
  path: string;
  menus: string[] | undefined;
  admin: boolean;
  httpCode: number | undefined;
  order: number;
}

function routes(): Route[] {
  const ctrl = WorkflowTriggersController;
  const proto = ctrl.prototype as unknown as Record<string, unknown>;
  const out: Route[] = [];
  Object.getOwnPropertyNames(proto).forEach((name, order) => {
    const fn = proto[name];
    if (name === 'constructor' || typeof fn !== 'function') return;
    const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
    if (method === undefined) return;
    out.push({
      handler: name,
      method,
      path: String(Reflect.getMetadata(PATH_METADATA, fn)),
      menus: (Reflect.getMetadata(REQUIRE_MENU_KEY, fn) ?? Reflect.getMetadata(REQUIRE_MENU_KEY, ctrl)) as string[] | undefined,
      admin: !!(Reflect.getMetadata(REQUIRE_ADMIN_KEY, fn) ?? Reflect.getMetadata(REQUIRE_ADMIN_KEY, ctrl)),
      httpCode: Reflect.getMetadata(HTTP_CODE_METADATA, fn) as number | undefined,
      order,
    });
  });
  return out;
}

describe('routes des déclencheurs : accès refusé par défaut', () => {
  it('le contrôleur est servi sous workflows/triggers derrière MenuPermissionGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkflowTriggersController)).toBe('workflows/triggers');
    const guards = (Reflect.getMetadata(GUARDS_METADATA, WorkflowTriggersController) as unknown[]) ?? [];
    expect(guards).toContain(MenuPermissionGuard);
  });

  it('TOUTES les routes exigent exactement le menu conception', () => {
    const all = routes();
    expect(all.length).toBe(6);
    for (const r of all) {
      expect({ route: r.handler, menus: r.menus }).toEqual({ route: r.handler, menus: [WORKFLOWS_MENUS.design] });
    }
  });

  it('expose liste, catalogue, détail, création, mise à jour et suppression', () => {
    const sig = routes()
      .map((r) => `${RequestMethod[r.method]} ${r.path}`)
      .sort();
    expect(sig).toEqual(['DELETE :id', 'GET /', 'GET :id', 'GET catalog', 'POST /', 'PUT :id'].sort());
  });

  it('catalog est déclarée AVANT :id (sinon « catalog » serait pris pour un identifiant)', () => {
    const all = routes();
    const catalog = all.find((r) => r.handler === 'catalog');
    const get = all.find((r) => r.handler === 'get');
    expect(catalog && get && catalog.order < get.order).toBe(true);
  });

  it('suppression : 200 ; création : code par défaut (201)', () => {
    const byHandler = Object.fromEntries(routes().map((r) => [r.handler, r]));
    expect(byHandler.remove?.httpCode).toBe(200);
    expect(byHandler.create?.httpCode).toBeUndefined();
  });
});

describe('routes des déclencheurs : garde réel', () => {
  const proto = WorkflowTriggersController.prototype as unknown as Record<string, object>;
  const user: AuthUser = { userId: 7, username: 'conc', isAdmin: false, userGroupId: 70 };

  const ctxFor = (handler: string): ExecutionContext =>
    ({
      getHandler: () => proto[handler],
      getClass: () => WorkflowTriggersController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  const guardWith = (menuKeys: string[]) =>
    new MenuPermissionGuard(new Reflector(), {
      appUser: {
        findUnique: jest.fn().mockResolvedValue({
          isAdmin: false,
          role: { isActive: true, isSystem: false, menus: menuKeys.map((menuKey) => ({ menuKey })) },
        }),
      },
    } as never);

  it('sans menu conception (même avec LANCER) : 403 sur chaque route', async () => {
    const g = guardWith([WORKFLOWS_MENUS.launch]);
    for (const h of ['list', 'catalog', 'get', 'create', 'update', 'remove']) {
      await expect(g.canActivate(ctxFor(h))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('avec le menu conception : toutes les routes passent', async () => {
    const g = guardWith([WORKFLOWS_MENUS.design]);
    for (const h of ['list', 'catalog', 'get', 'create', 'update', 'remove']) {
      await expect(g.canActivate(ctxFor(h))).resolves.toBe(true);
    }
  });
});
