import { ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import type { AuthUser } from '../../auth/auth.types';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { REQUIRE_MENU_KEY } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import { ToolGrantsController } from './tool-grants.controller';

const proto = ToolGrantsController.prototype as unknown as Record<string, object>;

function ctxFor(handler: string, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => ToolGrantsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWithMenus(menuKeys: string[]): MenuPermissionGuard {
  const prisma = {
    appUser: {
      findUnique: jest.fn().mockResolvedValue({
        isAdmin: false,
        role: { isActive: true, isSystem: false, menus: menuKeys.map((menuKey) => ({ menuKey })) },
      }),
    },
  };
  return new MenuPermissionGuard(new Reflector(), prisma as never);
}

const user: AuthUser = { userId: 7, username: 'u', isAdmin: false, userGroupId: 70 };
const ROUTES = ['catalog', 'grants', 'replace'];

describe('ToolGrantsController : accès refusé par défaut', () => {
  it('chemins et garde de menu au niveau du contrôleur', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ToolGrantsController)).toEqual([MenuPermissionGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, ToolGrantsController)).toBe('workflows/agents');
    expect(Reflect.getMetadata(PATH_METADATA, proto.catalog)).toBe('tools');
    expect(Reflect.getMetadata(PATH_METADATA, proto.grants)).toBe('definitions/:id/tool-grants');
    expect(Reflect.getMetadata(PATH_METADATA, proto.replace)).toBe('definitions/:id/tool-grants');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.replace)).toBe(RequestMethod.PUT);
  });

  it('chaque route exige le menu d’administration des workflows', () => {
    const names = Object.getOwnPropertyNames(ToolGrantsController.prototype).filter((n) => n !== 'constructor');
    const routed = names.filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);
    expect(routed.sort()).toEqual([...ROUTES].sort());
    for (const n of routed) {
      expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n])).toEqual([WORKFLOWS_MENUS.admin]);
    }
  });

  it.each(ROUTES)('%s : refusé sans le menu (concepteur ou lanceur seuls)', async (route) => {
    const guard = guardWithMenus([WORKFLOWS_MENUS.design, WORKFLOWS_MENUS.launch]);
    await expect(guard.canActivate(ctxFor(route, user))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(ROUTES)('%s : autorisé avec le menu d’administration', async (route) => {
    const guard = guardWithMenus([WORKFLOWS_MENUS.admin]);
    await expect(guard.canActivate(ctxFor(route, user))).resolves.toBe(true);
  });
});
