import type { AuthUser } from '../../auth/auth.types';
import { IMPUTABLE_LIST_MAX, ImputableActorsService } from './imputable-actors.service';

type Role = { isActive: boolean; isSystem: boolean; menus: { menuKey: string }[] } | null;
type UserRow = { isAdmin: boolean; isDisabled: boolean; role: Role };
const role = (keys: string[], over: Partial<{ isActive: boolean; isSystem: boolean }> = {}): Role => ({
  isActive: true,
  isSystem: false,
  menus: keys.map((menuKey) => ({ menuKey })),
  ...over,
});

const imputer: AuthUser = { userId: 1, username: 'imputeur', isAdmin: false, userGroupId: 100 };

function setup(users: Record<number, UserRow | null>, actors: Record<number, UserRow | null>, listed: unknown[] = []) {
  const prisma = {
    appUser: { findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => users[where.userId] ?? null) },
    appUserGroup: {
      findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) => {
        const u = actors[where.userGroupId];
        return u ? { user: u } : null;
      }),
      findMany: jest.fn(async (_args: unknown) => listed),
    },
  };
  return { service: new ImputableActorsService(prisma as never), prisma };
}

describe('ImputableActorsService.canImpute', () => {
  it('administrateur ou menu d’imputation (contrôle, parapheur, validation) ; sinon non', async () => {
    const cases: Array<[UserRow | null, boolean]> = [
      [{ isAdmin: true, isDisabled: false, role: null }, true],
      [{ isAdmin: false, isDisabled: false, role: role(['/courriers/controle']) }, true],
      [{ isAdmin: false, isDisabled: false, role: role(['/courriers/parapheur']) }, true],
      [{ isAdmin: false, isDisabled: false, role: role(['/courriers/validation']) }, true],
      [{ isAdmin: false, isDisabled: false, role: role([], { isSystem: true }) }, true],
      [{ isAdmin: false, isDisabled: false, role: role(['/courriers/suivi']) }, false],
      [{ isAdmin: false, isDisabled: false, role: role(['/courriers/parapheur'], { isActive: false }) }, false],
      [{ isAdmin: true, isDisabled: true, role: null }, false],
      [null, false],
    ];
    for (const [row, expected] of cases) {
      const { service } = setup({ 1: row }, {});
      expect(await service.canImpute(imputer)).toBe(expected);
    }
  });

  it('identité machine ou jeton sans acteur : jamais, sans lecture de la base', async () => {
    const { service, prisma } = setup({ 1: { isAdmin: true, isDisabled: false, role: null } }, {});
    expect(await service.canImpute({ ...imputer, isScanAgent: true })).toBe(false);
    expect(await service.canImpute({ ...imputer, userGroupId: null })).toBe(false);
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
  });
});

describe('ImputableActorsService.isImputable', () => {
  const canImpute = { 1: { isAdmin: false, isDisabled: false, role: role(['/courriers/parapheur']) } };

  it('cible active avec un menu courrier (ou administrateur) : oui ; sinon non', async () => {
    const { service } = setup(canImpute, {
      2: { isAdmin: false, isDisabled: false, role: role(['/courriers/suivi-dc']) },
      3: { isAdmin: true, isDisabled: false, role: null },
      4: { isAdmin: false, isDisabled: true, role: role(['/courriers/suivi']) },
      5: { isAdmin: false, isDisabled: false, role: role(['/ged/recherche']) },
      6: { isAdmin: false, isDisabled: false, role: role(['/courriers/suivi'], { isActive: false }) },
      7: { isAdmin: false, isDisabled: false, role: null },
    });
    expect(await service.isImputable(imputer, 2)).toBe(true);
    expect(await service.isImputable(imputer, 3)).toBe(true);
    expect(await service.isImputable(imputer, 4)).toBe(false);
    expect(await service.isImputable(imputer, 5)).toBe(false);
    expect(await service.isImputable(imputer, 6)).toBe(false);
    expect(await service.isImputable(imputer, 7)).toBe(false);
    expect(await service.isImputable(imputer, 999)).toBe(false);
    expect(await service.isImputable(imputer, 0)).toBe(false);
    expect(await service.isImputable(imputer, 1.5)).toBe(false);
  });

  it('imputeur sans droit d’imputer : jamais imputable', async () => {
    const { service, prisma } = setup(
      { 1: { isAdmin: false, isDisabled: false, role: role(['/courriers/suivi']) } },
      { 2: { isAdmin: true, isDisabled: false, role: null } },
    );
    expect(await service.isImputable(imputer, 2)).toBe(false);
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });
});

describe('ImputableActorsService.list', () => {
  const canImpute = { 1: { isAdmin: false, isDisabled: false, role: role(['/courriers/controle']) } };

  it('libellé « Nom — Groupe », rôle actif et organigramme ; aucune donnée sensible', async () => {
    const { service, prisma } = setup(canImpute, {}, [
      {
        userGroupId: 30,
        group: { name: 'Direction RH' },
        user: {
          fullName: 'Awa Traoré',
          firstName: 'Awa',
          lastName: 'Traoré',
          role: { roleId: 4, name: 'Chef de service', isActive: true, organigramme: { label: 'RH', isActive: true } },
        },
      },
      {
        userGroupId: 31,
        group: null,
        user: { fullName: null, firstName: 'Ali', lastName: 'Keita', role: { roleId: 5, name: 'Ancien', isActive: false, organigramme: null } },
      },
    ]);
    const out = await service.list(imputer, { search: '  traoré ', limit: 500 });
    expect(out).toEqual([
      { userGroupId: 30, label: 'Awa Traoré — Direction RH', roleId: 4, roleName: 'Chef de service', organigrammeLabel: 'RH' },
      { userGroupId: 31, label: 'Ali Keita', roleId: null, roleName: null, organigrammeLabel: null },
    ]);
    const args = prisma.appUserGroup.findMany.mock.calls[0][0] as {
      take: number;
      where: Record<string, unknown>;
      select: { user: { select: Record<string, unknown> } };
    };
    expect(args.take).toBe(IMPUTABLE_LIST_MAX);
    expect(JSON.stringify(args.where)).toContain('traoré');
    expect(JSON.stringify(args.where)).not.toContain('username');
    expect(Object.keys(args.select.user.select)).not.toEqual(expect.arrayContaining(['email']));
    expect(Object.keys(args.select.user.select)).not.toContain('username');
    expect(args.where).toMatchObject({ user: { isDisabled: false } });
  });

  it('borne par défaut 50, minimum 1 ; imputeur sans droit : liste vide sans requête', async () => {
    const { service, prisma } = setup(canImpute, {}, []);
    await service.list(imputer);
    await service.list(imputer, { limit: 0 });
    expect(prisma.appUserGroup.findMany.mock.calls[0][0]).toMatchObject({ take: 50 });
    expect(prisma.appUserGroup.findMany.mock.calls[1][0]).toMatchObject({ take: 1 });

    const denied = setup({ 1: null }, {}, [{ userGroupId: 1 }]);
    expect(await denied.service.list(imputer)).toEqual([]);
    expect(denied.prisma.appUserGroup.findMany).not.toHaveBeenCalled();
  });
});
