import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import { ReferentialsController } from './referentials.controller';

type Handler = keyof ReferentialsController;

const proto = ReferentialsController.prototype;

function ctx(handler: Handler, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => ReferentialsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

/** Garde réel + vrai Reflector : prouve l'effet des décorateurs posés sur le contrôleur. */
function guard(): MenuPermissionGuard {
  const prisma = {
    appUser: {
      // Rôle actif, non système, sans aucun menu : un utilisateur authentifié ordinaire.
      findUnique: jest.fn(async () => ({
        isAdmin: false,
        role: { isActive: true, isSystem: false, menus: [] },
      })),
    },
  } as unknown as PrismaService;
  return new MenuPermissionGuard(new Reflector(), prisma);
}

const agent: AuthUser = { userId: 5, username: 'agent', isAdmin: false, userGroupId: 9 };
const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 1 };

describe('ReferentialsController — POST /referentials/document-permissions (F3)', () => {
  it('porte @RequireAdmin()', () => {
    expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto.grantDocumentPermission)).toBe(true);
  });

  it('est refusé (403) à un utilisateur authentifié non administrateur', async () => {
    await expect(guard().canActivate(ctx('grantDocumentPermission', agent))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('reste ouvert à un administrateur', async () => {
    await expect(guard().canActivate(ctx('grantDocumentPermission', admin))).resolves.toBe(true);
  });
});

/** Guard réel dont l'utilisateur porte les menus donnés. */
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

/**
 * Droits par TYPE : réservés aux titulaires des écrans « Type par utilisateur » / « Type par
 * profil » (décision de l'utilisateur du 2026-11-22). La lecture s'ouvre aussi à « par classification ».
 */
describe('ReferentialsController — droits par type réservés aux menus de sécurité', () => {
  it.each<Handler>(['grantTypePermission', 'revokeTypePermission', 'listTypePermissions'])(
    '%s est refusé (403) sans menu de sécurité par type',
    async (handler) => {
      await expect(guard().canActivate(ctx(handler, agent))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        guardWithMenus(['/admin/dossiers']).canActivate(ctx(handler, agent)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each<[Handler, string]>([
    ['grantTypePermission', '/admin/securite/type-par-utilisateur'],
    ['grantTypePermission', '/admin/securite/type-par-profil'],
    ['revokeTypePermission', '/admin/securite/type-par-utilisateur'],
    ['revokeTypePermission', '/admin/securite/type-par-profil'],
    ['listTypePermissions', '/admin/securite/type-par-utilisateur'],
    ['listTypePermissions', '/admin/securite/type-par-profil'],
    ['listTypePermissions', '/admin/securite/par-classification'],
  ])('%s est autorisé au titulaire de %s', async (handler, menu) => {
    await expect(guardWithMenus([menu]).canActivate(ctx(handler, agent))).resolves.toBe(true);
  });

  it.each<Handler>(['grantTypePermission', 'revokeTypePermission'])(
    '%s n’est pas ouvert au seul menu « par classification » (lecture seule)',
    async (handler) => {
      await expect(
        guardWithMenus(['/admin/securite/par-classification']).canActivate(ctx(handler, agent)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('porte la liste exacte des menus requis', () => {
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto.grantTypePermission)).toEqual([
      '/admin/securite/type-par-utilisateur',
      '/admin/securite/type-par-profil',
    ]);
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto.revokeTypePermission)).toEqual([
      '/admin/securite/type-par-utilisateur',
      '/admin/securite/type-par-profil',
    ]);
  });
});
