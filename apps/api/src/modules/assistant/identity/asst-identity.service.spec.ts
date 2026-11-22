import type { AuthUser } from '../../auth/auth.types';
import type { PrismaService } from '../../prisma/prisma.service';
import { AsstError } from '../assistant.contracts';
import { AsstIdentityService } from './asst-identity.service';

const user: AuthUser = { userId: 5, username: 'jeton', isAdmin: false, userGroupId: 50 };

function makePrisma() {
  return { appUserGroup: { findUnique: jest.fn(), findMany: jest.fn() } };
}

function build() {
  const prisma = makePrisma();
  return { prisma, svc: new AsstIdentityService(prisma as unknown as PrismaService) };
}

const actorRow = (over: Record<string, unknown> = {}) => ({
  userId: 5,
  user: {
    username: 'alice',
    fullName: 'Alice Martin',
    isAdmin: false,
    isDisabled: false,
    roleId: 9,
    role: { isActive: true },
    ...over,
  },
});

async function refusal(p: Promise<unknown>): Promise<AsstError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AsstError);
    return e as AsstError;
  }
  throw new Error('refus attendu');
}

describe('AsstIdentityService.resolve', () => {
  it('cas nominal : identité reconstruite depuis la base', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue(actorRow());
    prisma.appUserGroup.findMany.mockResolvedValue([{ groupId: 1 }, { groupId: 2 }]);
    await expect(svc.resolve(user)).resolves.toEqual({
      user: { userId: 5, username: 'alice', isAdmin: false, userGroupId: 50, fullName: 'Alice Martin' },
      principal: { userGroupId: 50, userId: 5, groupIds: [1, 2], roleId: 9 },
    });
  });

  it('relit isAdmin en base : un jeton qui prétend admin ne l’est pas', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue(actorRow({ isAdmin: false }));
    prisma.appUserGroup.findMany.mockResolvedValue([]);
    expect((await svc.resolve({ ...user, isAdmin: true })).user.isAdmin).toBe(false);
  });

  it('relit isAdmin en base : un administrateur réel l’est même si le jeton dit non', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue(actorRow({ isAdmin: true }));
    prisma.appUserGroup.findMany.mockResolvedValue([]);
    expect((await svc.resolve(user)).user.isAdmin).toBe(true);
  });

  it('rôle désactivé ou absent : roleId null, sans refus', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findMany.mockResolvedValue([]);
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(actorRow({ role: { isActive: false } }));
    expect((await svc.resolve(user)).principal.roleId).toBeNull();
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(actorRow({ roleId: null, role: null }));
    expect((await svc.resolve(user)).principal.roleId).toBeNull();
  });

  it('dédoublonne les groupes', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue(actorRow());
    prisma.appUserGroup.findMany.mockResolvedValue([{ groupId: 3 }, { groupId: 1 }, { groupId: 3 }]);
    expect((await svc.resolve(user)).principal.groupIds).toEqual([3, 1]);
  });

  it('fullName absent en base : null', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValue(actorRow({ fullName: undefined }));
    prisma.appUserGroup.findMany.mockResolvedValue([]);
    expect((await svc.resolve(user)).user.fullName).toBeNull();
  });

  it('refuse l’identité machine et le jeton sans userGroupId, sans lire la base', async () => {
    const { prisma, svc } = build();
    const e1 = await refusal(svc.resolve({ ...user, isScanAgent: true }));
    const e2 = await refusal(svc.resolve({ ...user, userGroupId: null }));
    expect(e1.errorCode).toBe('identity_refused');
    expect(e2.errorCode).toBe('identity_refused');
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });

  it('refuse un acteur inconnu, un autre utilisateur ou un compte désactivé', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(null);
    expect((await refusal(svc.resolve(user))).errorCode).toBe('identity_refused');
    prisma.appUserGroup.findUnique.mockResolvedValueOnce({ ...actorRow(), userId: 99 });
    expect((await refusal(svc.resolve(user))).errorCode).toBe('identity_refused');
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(actorRow({ isDisabled: true }));
    expect((await refusal(svc.resolve(user))).errorCode).toBe('identity_refused');
    expect(prisma.appUserGroup.findMany).not.toHaveBeenCalled();
  });

  it('les messages de refus ne divulguent rien (même texte, aucun identifiant ni nom)', async () => {
    const { prisma, svc } = build();
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(null);
    const a = await refusal(svc.resolve(user));
    prisma.appUserGroup.findUnique.mockResolvedValueOnce(actorRow({ isDisabled: true }));
    const b = await refusal(svc.resolve(user));
    expect(a.message).toBe(b.message);
    expect(a.message).not.toMatch(/alice|jeton|50|\b5\b|désactiv/i);
  });
});
