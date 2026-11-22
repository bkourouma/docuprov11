import { ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { upsertWfAgentConfigSchema } from '@archivage/types';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import { DefinitionsController } from './definitions.controller';
import { WORKFLOWS_MENUS } from './workflows.menus';

const proto = DefinitionsController.prototype as unknown as Record<string, object>;

/** Contexte HTTP minimal pour le garde réel, branché sur le VRAI contrôleur (métadonnées réelles). */
function ctxFor(handler: string, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => DefinitionsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWithMenus(menuKeys: string[], role = true): MenuPermissionGuard {
  const prisma = {
    appUser: {
      findUnique: jest.fn().mockResolvedValue({
        isAdmin: false,
        role: role
          ? { isActive: true, isSystem: false, menus: menuKeys.map((menuKey) => ({ menuKey })) }
          : null,
      }),
    },
  };
  return new MenuPermissionGuard(new Reflector(), prisma as never);
}

const designer: AuthUser = { userId: 7, username: 'conc', isAdmin: false, userGroupId: 70 };
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10 };

describe('DefinitionsController : accès refusé par défaut', () => {
  it('garde de menu au niveau du contrôleur', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DefinitionsController)).toEqual([MenuPermissionGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, DefinitionsController)).toBe('workflows/definitions');
  });

  it('chaque route exige un menu (ou admin) : aucune n’est ouverte à tout utilisateur authentifié', () => {
    const names = Object.getOwnPropertyNames(DefinitionsController.prototype).filter((n) => n !== 'constructor');
    const routed = names.filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);
    expect(routed).toHaveLength(12);
    for (const n of routed) {
      const menus = Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n]) as string[] | undefined;
      const adminOnly = Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto[n]) as boolean | undefined;
      expect(menus?.length || adminOnly).toBeTruthy();
    }
  });

  it('les écritures exigent le menu conception ; le faible risque est réservé aux administrateurs', () => {
    for (const n of ['create', 'updateDraft', 'listAgents', 'upsertAgent', 'validate', 'publish', 'archive']) {
      expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n])).toEqual([WORKFLOWS_MENUS.design]);
    }
    expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto.setLowRisk)).toBe(true);
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto.setLowRisk)).toBeUndefined();
  });

  it('launchable accepte LANCER ou CONCEVOIR, et est déclarée avant « :id » (sinon capturée par lui)', () => {
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto.launchable)).toEqual([
      WORKFLOWS_MENUS.launch,
      WORKFLOWS_MENUS.design,
    ]);
    const order = Object.getOwnPropertyNames(DefinitionsController.prototype);
    expect(order.indexOf('launchable')).toBeLessThan(order.indexOf('get'));
  });

  it('sans aucun menu : 403 sur la conception ; avec LANCER seul : launchable passe, la conception non', async () => {
    const none = guardWithMenus([]);
    await expect(none.canActivate(ctxFor('list', designer))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(none.canActivate(ctxFor('publish', designer))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(none.canActivate(ctxFor('launchable', designer))).rejects.toBeInstanceOf(ForbiddenException);

    const launcher = guardWithMenus([WORKFLOWS_MENUS.launch]);
    await expect(launcher.canActivate(ctxFor('launchable', designer))).resolves.toBe(true);
    await expect(launcher.canActivate(ctxFor('create', designer))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('un non-administrateur, même concepteur, est refusé sur le marquage faible risque', async () => {
    const g = guardWithMenus([WORKFLOWS_MENUS.design, WORKFLOWS_MENUS.admin]);
    await expect(g.canActivate(ctxFor('setLowRisk', designer))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(g.canActivate(ctxFor('setLowRisk', admin))).resolves.toBe(true);
    await expect(guardWithMenus([WORKFLOWS_MENUS.design]).canActivate(ctxFor('publish', designer))).resolves.toBe(true);
  });

  it('délègue au service avec l’acteur courant', async () => {
    const service = {
      publish: jest.fn().mockResolvedValue({ ok: true }),
      setLowRisk: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new DefinitionsController(service as never);
    await controller.publish(3, designer);
    await controller.setLowRisk(3, { isLowRisk: true }, admin);
    expect(service.publish).toHaveBeenCalledWith(3, designer);
    expect(service.setLowRisk).toHaveBeenCalledWith(3, true, admin);
  });

  it('config d’agent : chemins, méthodes et garde de menu (concevoir, administrateur non exempté)', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.listAgents)).toBe(':id/draft/agents');
    expect(Reflect.getMetadata(PATH_METADATA, proto.upsertAgent)).toBe(':id/draft/agents/:stepKey');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.listAgents)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.upsertAgent)).toBe(RequestMethod.PUT);
    for (const n of ['listAgents', 'upsertAgent']) {
      await expect(guardWithMenus([]).canActivate(ctxFor(n, designer))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guardWithMenus([WORKFLOWS_MENUS.launch]).canActivate(ctxFor(n, designer))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(guardWithMenus([WORKFLOWS_MENUS.design]).canActivate(ctxFor(n, designer))).resolves.toBe(true);
    }
  });

  it('config d’agent : délègue au service avec l’identifiant, la clé d’étape, le corps et l’acteur', async () => {
    const service = {
      listAgentConfigs: jest.fn().mockResolvedValue([]),
      upsertAgentConfig: jest.fn().mockResolvedValue({ stepKey: 'ia' }),
    };
    const controller = new DefinitionsController(service as never);
    await controller.listAgents(3, designer);
    await controller.upsertAgent(3, 'ia', { confidenceThreshold: 0.9 }, designer);
    expect(service.listAgentConfigs).toHaveBeenCalledWith(3, designer);
    expect(service.upsertAgentConfig).toHaveBeenCalledWith(3, 'ia', { confidenceThreshold: 0.9 }, designer);
  });

  it('config d’agent : corps zod borné comme le SQL', () => {
    const ok = (v: unknown) => upsertWfAgentConfigSchema.safeParse(v).success;
    expect(ok({ confidenceThreshold: 0.5 })).toBe(true);
    expect(ok({})).toBe(false); // aucune modification
    expect(ok({ confidenceThreshold: 1.1 })).toBe(false);
    expect(ok({ confidenceThreshold: -0.1 })).toBe(false);
    expect(ok({ maxSteps: 0 })).toBe(false);
    expect(ok({ maxSteps: 51 })).toBe(false);
    expect(ok({ maxSteps: 50 })).toBe(true);
    expect(ok({ timeoutSeconds: 0 })).toBe(false);
    expect(ok({ timeoutSeconds: 3601 })).toBe(false);
    expect(ok({ maxCostPerRun: -1 })).toBe(false);
    expect(ok({ maxCostPerRun: null, model: null, evalSetId: null })).toBe(true);
    expect(ok({ evalSetId: 0 })).toBe(false);
    expect(ok({ tools: ['doc.read', 'doc.read'] })).toBe(false);
    expect(ok({ tools: ['Doc Read'] })).toBe(false);
    expect(ok({ autonomy: 'autonome' })).toBe(true);
    expect(ok({ autonomy: 'libre' })).toBe(false);
    expect(ok({ objective: 'x', inconnu: 1 })).toBe(false);
  });
});
