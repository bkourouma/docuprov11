import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import { ASSIGNABLE_MENU_KEYS } from '../roles/menu-catalog';
import {
  INTERCALAIRES_MENU,
  IntercalairesController,
} from '../intercalaires/intercalaires.controller';
import { ACQUISITION_MENU, AcquisitionController } from './acquisition.controller';

/**
 * ANO-ARC-T1-01 — les lots d'acquisition (`/batches`) et la génération d'intercalaires
 * (`/intercalaires`) n'étaient gardés que par le JWT : tout compte authentifié, même sans le menu,
 * pouvait créer un lot, relancer un traitement (qui supprime et recrée les documents du lot) ou
 * lister les documents de n'importe quel lot. Ce fichier fige la règle « accès au menu ⟹ accès aux
 * données » sur ces deux contrôleurs.
 */

type Ctrl = typeof AcquisitionController | typeof IntercalairesController;

function handlers(ctrl: Ctrl): string[] {
  const proto = ctrl.prototype as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter((name) => {
    const fn = proto[name];
    return (
      name !== 'constructor' &&
      typeof fn === 'function' &&
      Reflect.getMetadata(METHOD_METADATA, fn) !== undefined
    );
  });
}

function menusOf(ctrl: Ctrl, handler: string): string[] | undefined {
  const fn = (ctrl.prototype as unknown as Record<string, object>)[handler]!;
  return (Reflect.getMetadata(REQUIRE_MENU_KEY, fn) ??
    Reflect.getMetadata(REQUIRE_MENU_KEY, ctrl)) as string[] | undefined;
}

const user: AuthUser = { userId: 42, username: 'agent', isAdmin: false, userGroupId: 420 };

function ctxFor(ctrl: Ctrl, handler: string): ExecutionContext {
  const proto = ctrl.prototype as unknown as Record<string, object>;
  return {
    getHandler: () => proto[handler],
    getClass: () => ctrl,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(menuKeys: string[]): MenuPermissionGuard {
  return new MenuPermissionGuard(new Reflector(), {
    appUser: {
      findUnique: jest.fn().mockResolvedValue({
        isAdmin: false,
        role: { isActive: true, isSystem: false, menus: menuKeys.map((menuKey) => ({ menuKey })) },
      }),
    },
  } as never);
}

const cases: Array<{ name: string; ctrl: Ctrl; path: string; menu: string; count: number }> = [
  {
    name: 'lots d’acquisition',
    ctrl: AcquisitionController,
    path: 'batches',
    menu: ACQUISITION_MENU,
    count: 5,
  },
  {
    name: 'intercalaires',
    ctrl: IntercalairesController,
    path: 'intercalaires',
    menu: INTERCALAIRES_MENU,
    count: 3,
  },
];

describe.each(cases)(
  'routes des $name : accès refusé par défaut',
  ({ ctrl, path, menu, count }) => {
    it('le menu requis est une clé assignable du catalogue (une faute de frappe bloquerait tout le monde)', () => {
      expect(ASSIGNABLE_MENU_KEYS).toContain(menu);
    });

    it(`le contrôleur est servi sous ${path} derrière MenuPermissionGuard`, () => {
      expect(Reflect.getMetadata(PATH_METADATA, ctrl)).toBe(path);
      const guards = (Reflect.getMetadata(GUARDS_METADATA, ctrl) as unknown[]) ?? [];
      expect(guards).toContain(MenuPermissionGuard);
    });

    it('TOUTES les routes exigent exactement ce menu', () => {
      const all = handlers(ctrl);
      expect(all).toHaveLength(count);
      for (const h of all) {
        expect({ route: h, menus: menusOf(ctrl, h) }).toEqual({ route: h, menus: [menu] });
      }
    });

    it('sans le menu (avec un autre menu) : 403 sur chaque route', async () => {
      const g = guardWith(['/search']);
      for (const h of handlers(ctrl)) {
        await expect(g.canActivate(ctxFor(ctrl, h))).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it('avec le menu : toutes les routes passent', async () => {
      const g = guardWith([menu]);
      for (const h of handlers(ctrl)) {
        await expect(g.canActivate(ctxFor(ctrl, h))).resolves.toBe(true);
      }
    });
  },
);
