import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import type { AuthUser } from '../../auth/auth.types';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { REQUIRE_MENU_KEY } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import { AgentAdminController } from './agent-admin.controller';

const proto = AgentAdminController.prototype as unknown as Record<string, object>;

function ctxFor(handler: string, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => AgentAdminController,
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

const routes = Object.getOwnPropertyNames(AgentAdminController.prototype)
  .filter((n) => n !== 'constructor')
  .filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);

describe('AgentAdminController : routes et accès refusé par défaut', () => {
  it('préfixe workflows/agents, derrière MenuPermissionGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentAdminController)).toBe('workflows/agents');
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentAdminController)).toEqual([MenuPermissionGuard]);
  });

  it('quatre routes : GET status, GET budget, PUT budget, POST emergency-stop', () => {
    const table = routes
      .map((n) => `${Reflect.getMetadata(METHOD_METADATA, proto[n])}:${String(Reflect.getMetadata(PATH_METADATA, proto[n]))}`)
      .sort();
    expect(table).toEqual(
      [
        `${RequestMethod.GET}:status`,
        `${RequestMethod.GET}:budget`,
        `${RequestMethod.PUT}:budget`,
        `${RequestMethod.POST}:emergency-stop`,
      ].sort(),
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.emergencyStop)).toBe(200);
  });

  it('CHAQUE route exige le menu administration', () => {
    expect(routes).toHaveLength(4);
    for (const n of routes) {
      expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n])).toEqual([WORKFLOWS_MENUS.admin]);
    }
  });

  it('le garde réel refuse sans le menu administration (conception ou lancement ne suffisent pas)', async () => {
    const guard = guardWithMenus([WORKFLOWS_MENUS.design, WORKFLOWS_MENUS.launch]);
    for (const n of routes) {
      await expect(guard.canActivate(ctxFor(n, user))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('le garde réel laisse passer avec le menu administration', async () => {
    const guard = guardWithMenus([WORKFLOWS_MENUS.admin]);
    for (const n of routes) {
      await expect(guard.canActivate(ctxFor(n, user))).resolves.toBe(true);
    }
  });
});

describe('AgentAdminController : délégation au service', () => {
  const service = {
    status: jest.fn().mockResolvedValue({ aiEnabled: true, aiMode: 1, emergencyStopGlobal: false }),
    getBudget: jest.fn().mockResolvedValue({ global: {}, workflows: [] }),
    updateBudget: jest.fn().mockResolvedValue({ wfBudgetId: 1 }),
    setEmergencyStop: jest.fn().mockResolvedValue({ wfBudgetId: 1 }),
  };
  const controller = new AgentAdminController(service as never);

  it('transmet le corps validé et l’utilisateur courant', async () => {
    await controller.status(user);
    await controller.budget(user);
    await controller.updateBudget({ capAmount: 5 }, user);
    await controller.emergencyStop({ active: true, definitionId: 3 }, user);
    expect(service.status).toHaveBeenCalledWith(user);
    expect(service.getBudget).toHaveBeenCalledWith(user);
    expect(service.updateBudget).toHaveBeenCalledWith({ capAmount: 5 }, user);
    expect(service.setEmergencyStop).toHaveBeenCalledWith({ active: true, definitionId: 3 }, user);
  });
});
