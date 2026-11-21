import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { PrincipalService } from './principal.service';
import { WORKFLOWS_MENUS } from './workflows.menus';

const user: AuthUser = { userId: 5, username: 'u', isAdmin: false, userGroupId: 50 };

function makePrisma() {
  return {
    appUserGroup: { findUnique: jest.fn(), findMany: jest.fn() },
    appUser: { findUnique: jest.fn() },
  };
}

function build(prisma = makePrisma()) {
  return { prisma, svc: new PrincipalService(prisma as unknown as PrismaService) };
}

const role = (menus: string[], extra: Record<string, unknown> = {}) => ({
  isActive: true,
  isSystem: false,
  menus: menus.map((menuKey) => ({ menuKey })),
  ...extra,
});

describe('PrincipalService.buildPrincipal', () => {
  it('construit le principal depuis la base (groupes, rôle actif)', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue({
      userId: 5,
      user: { isDisabled: false, roleId: 9, role: { isActive: true } },
    });
    prisma.appUserGroup.findMany.mockResolvedValue([{ groupId: 1 }, { groupId: 2 }, { groupId: 1 }]);
    await expect(svc.buildPrincipal(user)).resolves.toEqual({
      userGroupId: 50,
      userId: 5,
      groupIds: [1, 2],
      roleId: 9,
    });
  });

  it('ignore un rôle désactivé', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue({
      userId: 5,
      user: { isDisabled: false, roleId: 9, role: { isActive: false } },
    });
    prisma.appUserGroup.findMany.mockResolvedValue([]);
    expect((await svc.buildPrincipal(user)).roleId).toBeNull();
  });

  it('refuse l’identité machine et tout jeton sans userGroupId, sans lire la base', async () => {
    const { prisma, svc } = build();
    await expect(svc.buildPrincipal({ ...user, isScanAgent: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.buildPrincipal({ ...user, userGroupId: null })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });

  it('refuse un utilisateur désactivé, un acteur inconnu ou appartenant à un autre compte', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValueOnce({ userId: 5, user: { isDisabled: true, roleId: null, role: null } });
    await expect(svc.buildPrincipal(user)).rejects.toBeInstanceOf(ForbiddenException);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(null);
    await expect(svc.buildPrincipal(user)).rejects.toBeInstanceOf(ForbiddenException);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce({ userId: 99, user: { isDisabled: false, roleId: null, role: null } });
    await expect(svc.buildPrincipal(user)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PrincipalService menus / annuaire', () => {
  it('hasAdminMenu : admin et rôle système oui ; rôle sans la clé non ; compte désactivé non', async () => {
    const { prisma, svc } = build();
    prisma.appUser.findUnique.mockResolvedValueOnce({ isAdmin: true, isDisabled: false, role: null });
    await expect(svc.hasAdminMenu(user)).resolves.toBe(true);
    prisma.appUser.findUnique.mockResolvedValueOnce({ isAdmin: false, isDisabled: false, role: role([WORKFLOWS_MENUS.admin]) });
    await expect(svc.hasAdminMenu(user)).resolves.toBe(true);
    prisma.appUser.findUnique.mockResolvedValueOnce({ isAdmin: false, isDisabled: false, role: role([WORKFLOWS_MENUS.launch]) });
    await expect(svc.hasAdminMenu(user)).resolves.toBe(false);
    prisma.appUser.findUnique.mockResolvedValueOnce({ isAdmin: true, isDisabled: true, role: null });
    await expect(svc.hasAdminMenu(user)).resolves.toBe(false);
    await expect(svc.hasAdminMenu({ ...user, isScanAgent: true })).resolves.toBe(false);
  });

  it('isUserGroupActive / isActiveUserGroup', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValueOnce({ user: { isDisabled: false } });
    await expect(svc.isUserGroupActive(1)).resolves.toBe(true);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce({ user: { isDisabled: true } });
    await expect(svc.isActiveUserGroup(1)).resolves.toBe(false);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(null);
    await expect(svc.isUserGroupActive(1)).resolves.toBe(false);
  });

  it('canLaunch : exige le menu LANCER (admin compris), un compte actif', async () => {
    const { prisma, svc } = build();
    const row = (isDisabled: boolean, isAdmin: boolean, r: unknown) => ({ user: { isDisabled, isAdmin, role: r } });
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(row(false, false, role([WORKFLOWS_MENUS.launch])));
    await expect(svc.canLaunch(1)).resolves.toBe(true);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(row(false, true, null));
    await expect(svc.canLaunch(1)).resolves.toBe(true);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(row(false, false, role([WORKFLOWS_MENUS.design])));
    await expect(svc.canLaunch(1)).resolves.toBe(false);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(row(false, false, role([WORKFLOWS_MENUS.launch], { isActive: false })));
    await expect(svc.canLaunch(1)).resolves.toBe(false);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(row(true, true, null));
    await expect(svc.canLaunch(1)).resolves.toBe(false);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(null);
    await expect(svc.canLaunch(1)).resolves.toBe(false);
  });
});
