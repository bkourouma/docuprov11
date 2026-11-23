import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import { MENU_DASHBOARD_ARCHIVES } from '../roles/menu-catalog';
import { AnalyticsController } from './analytics.controller';

type Handler = 'overview' | 'targets' | 'export';

const proto = AnalyticsController.prototype as unknown as Record<string, unknown>;

function ctx(handler: string, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => AnalyticsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** Garde réel + vrai Reflector, utilisateur ordinaire portant les menus donnés. */
function guardWithMenus(menus: string[]): MenuPermissionGuard {
  const prisma = {
    appUser: {
      findUnique: jest.fn(async () => ({
        isAdmin: false,
        role: { isActive: true, isSystem: false, menus: menus.map((menuKey) => ({ menuKey })) },
      })),
    },
  } as unknown as PrismaService;
  return new MenuPermissionGuard(new Reflector(), prisma);
}

const agent: AuthUser = { userId: 5, username: 'agent', isAdmin: false, userGroupId: 9 };

const STATS: Handler[] = ['overview', 'targets', 'export'];

describe('AnalyticsController — statistiques réservées au menu Tableaux de bord', () => {
  it.each(STATS)('%s porte @RequireMenu(/dashboards)', (handler) => {
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[handler] as object)).toEqual([
      MENU_DASHBOARD_ARCHIVES,
    ]);
  });

  it.each(STATS)('%s est refusé (403) sans le menu /dashboards', async (handler) => {
    await expect(
      guardWithMenus(['/search']).canActivate(ctx(handler, agent)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(STATS)('%s est autorisé au titulaire du menu /dashboards', async (handler) => {
    await expect(
      guardWithMenus([MENU_DASHBOARD_ARCHIVES]).canActivate(ctx(handler, agent)),
    ).resolves.toBe(true);
  });
});
