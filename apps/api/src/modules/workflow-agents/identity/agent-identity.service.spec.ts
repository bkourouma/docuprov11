import type { PrismaService } from '../../prisma/prisma.service';
import { PrincipalService } from '../../workflows/principal.service';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import { AgentIdentityError } from '../agent.contracts';
import { AgentIdentityService } from './agent-identity.service';

interface Row {
  userId: number;
  user: {
    username: string;
    fullName: string | null;
    isAdmin: boolean;
    isDisabled: boolean;
    roleId: number | null;
    role: { isActive: boolean; isSystem: boolean; menus: Array<{ menuKey: string }> } | null;
  };
}

function row(over: Partial<Row['user']> = {}, userId = 5): Row {
  return {
    userId,
    user: {
      username: 'lanceur',
      fullName: 'Awa Lanceur',
      isAdmin: false,
      isDisabled: false,
      roleId: 9,
      role: { isActive: true, isSystem: false, menus: [{ menuKey: WORKFLOWS_MENUS.launch }] },
      ...over,
    },
  };
}

function build(found: Row | null) {
  const prisma = {
    appUserGroup: {
      findUnique: jest.fn().mockResolvedValue(found),
      findMany: jest.fn().mockResolvedValue([{ groupId: 1 }, { groupId: 2 }]),
    },
  };
  const principals = new PrincipalService(prisma as unknown as PrismaService);
  return { prisma, svc: new AgentIdentityService(prisma as unknown as PrismaService, principals) };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AgentIdentityError);
    return (e as AgentIdentityError).code;
  }
  throw new Error('une AgentIdentityError était attendue');
}

describe('AgentIdentityService.resolve', () => {
  it('reconstruit l’identité complète en base (AuthUser + principal)', async () => {
    const { svc } = build(row());
    await expect(svc.resolve(50)).resolves.toEqual({
      user: { userId: 5, username: 'lanceur', isAdmin: false, userGroupId: 50, fullName: 'Awa Lanceur' },
      principal: { userGroupId: 50, userId: 5, groupIds: [1, 2], roleId: 9 },
    });
  });

  it('acteur inconnu => not_found', async () => {
    const { svc } = build(null);
    expect(await codeOf(svc.resolve(50))).toBe('not_found');
  });

  it('compte désactivé => disabled', async () => {
    const { svc } = build(row({ isDisabled: true }));
    expect(await codeOf(svc.resolve(50))).toBe('disabled');
  });

  it('droit de lancer retiré => no_launch_right', async () => {
    const { svc } = build(row({ role: { isActive: true, isSystem: false, menus: [] } }));
    expect(await codeOf(svc.resolve(50))).toBe('no_launch_right');
  });

  it('rôle désactivé => plus de droit de lancer', async () => {
    const { svc } = build(
      row({ role: { isActive: false, isSystem: false, menus: [{ menuKey: WORKFLOWS_MENUS.launch }] } }),
    );
    expect(await codeOf(svc.resolve(50))).toBe('no_launch_right');
  });

  it('identifiant invalide => invalid, sans toucher la base', async () => {
    const { svc, prisma } = build(row());
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(await codeOf(svc.resolve(bad))).toBe('invalid');
    }
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });

  it('isAdmin est relu en base : un non-admin ne devient jamais administrateur', async () => {
    const { svc } = build(row({ isAdmin: false }));
    expect((await svc.resolve(50)).user.isAdmin).toBe(false);
  });

  it('un administrateur en base l’est dans l’identité (relu, pas déduit d’un paramètre)', async () => {
    const { svc } = build(row({ isAdmin: true, role: null, roleId: null }));
    const id = await svc.resolve(50);
    expect(id.user.isAdmin).toBe(true);
    expect(id.principal.roleId).toBeNull();
  });

  it('administrateur rétrogradé depuis : l’identité n’est plus administrateur', async () => {
    const first = build(row({ isAdmin: true }));
    expect((await first.svc.resolve(50)).user.isAdmin).toBe(true);
    const later = build(row({ isAdmin: false }));
    expect((await later.svc.resolve(50)).user.isAdmin).toBe(false);
  });

  it('l’acteur lu pour un autre identifiant ne fuit pas : le userGroupId demandé est celui de l’identité', async () => {
    const { svc } = build(row());
    const id = await svc.resolve(50);
    expect(id.user.userGroupId).toBe(50);
    expect(id.principal.userGroupId).toBe(50);
  });
});
