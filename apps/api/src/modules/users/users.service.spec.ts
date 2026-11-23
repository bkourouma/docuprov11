import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { UsersController } from './users.controller';
import {
  createUserSchema,
  resetPasswordSchema,
  updateUserSchema,
  type CreateUserDto,
} from './users.dto';
import { UsersService } from './users.service';

// bcrypt coût 12 : ~250 ms par appel, sans intérêt ici.
jest.mock('bcrypt', () => ({
  __esModule: true,
  default: { hash: jest.fn(async () => 'hash') },
}));

const ADMIN: Pick<AuthUser, 'isAdmin'> = { isAdmin: true };
const MANAGER: Pick<AuthUser, 'isAdmin'> = { isAdmin: false }; // titulaire du menu « Utilisateurs »

interface Target {
  username: string;
  firstName?: string;
  lastName?: string;
  isAdmin: boolean;
  roleId?: number | null;
}

/**
 * Prisma simulé : `target` = compte visé, `byUsername` = compte trouvé par identifiant (doublon),
 * `role` = rôle trouvé par `role.findUnique`.
 */
function setup(opts: {
  target?: Target | null;
  byUsername?: unknown;
  role?: { isSystem: boolean } | null;
  createError?: unknown;
  updateError?: unknown;
} = {}) {
  const tx = {
    appUser: {
      create: jest.fn(async () => {
        if (opts.createError) throw opts.createError;
        return { userId: 10, username: 'nouveau' };
      }),
    },
    appUserGroup: { create: jest.fn(async () => ({})) },
  };
  const appUser = {
    findUnique: jest.fn(async (args: { where: { userId?: number; username?: string } }) =>
      args.where.username !== undefined
        ? (opts.byUsername ?? null)
        : opts.target === undefined
          ? null
          : opts.target,
    ),
    update: jest.fn(async () => {
      if (opts.updateError) throw opts.updateError;
      return { userId: 5 };
    }),
    delete: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
  };
  const prisma = {
    appUser,
    role: { findUnique: jest.fn(async () => (opts.role === undefined ? null : opts.role)) },
    appUserGroup: { upsert: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new UsersService(prisma as unknown as PrismaService), prisma, tx };
}

const newUser = (over: Partial<CreateUserDto> = {}): CreateUserDto => ({
  username: 'nouveau',
  firstName: 'Awa',
  lastName: 'Koné',
  email: 'awa@exemple.ci',
  password: 'secret1',
  ...over,
});

const plainUser: Target = { username: 'agent', firstName: 'A', lastName: 'B', isAdmin: false, roleId: 3 };
const otherAdmin: Target = { username: 'chef', firstName: 'C', lastName: 'D', isAdmin: true, roleId: null };

describe('UsersService — statut administrateur réservé aux administrateurs (F2)', () => {
  it('refuse à un non-admin la création d’un compte administrateur', async () => {
    const { service, tx } = setup();
    await expect(service.createUser(newUser({ isAdmin: true }), MANAGER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.appUser.create).not.toHaveBeenCalled();
  });

  it('laisse un administrateur créer un compte administrateur', async () => {
    const { service, tx } = setup();
    await expect(service.createUser(newUser({ isAdmin: true }), ADMIN)).resolves.toEqual({
      userId: 10,
      username: 'nouveau',
    });
    expect(tx.appUser.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAdmin: true, mustChangePwd: true }) }),
    );
  });

  it('laisse un non-admin créer un compte ordinaire', async () => {
    const { service, tx } = setup();
    await service.createUser(newUser(), MANAGER);
    expect(tx.appUser.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAdmin: false }) }),
    );
  });

  it('refuse à un non-admin de promouvoir un compte (y compris le sien)', async () => {
    const { service, prisma } = setup({ target: plainUser });
    await expect(service.updateUser(5, { isAdmin: true }, MANAGER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('accepte isAdmin:false d’un non-admin sur un compte ordinaire (sans effet)', async () => {
    const { service, prisma } = setup({ target: plainUser });
    await service.updateUser(5, { isAdmin: false, email: 'x@y.ci' }, MANAGER);
    expect(prisma.appUser.update).toHaveBeenCalled();
  });

  it.each([
    ['modifier', (s: UsersService) => s.updateUser(5, { email: 'x@y.ci' }, MANAGER)],
    ['désactiver', (s: UsersService) => s.updateUser(5, { isDisabled: true }, MANAGER)],
    ['rétrograder', (s: UsersService) => s.updateUser(5, { isAdmin: false }, MANAGER)],
    ['réinitialiser le mot de passe', (s: UsersService) => s.resetPassword(5, 'nouveau1', MANAGER)],
    ['supprimer', (s: UsersService) => s.deleteUser(5, MANAGER)],
    ['affecter un profil', (s: UsersService) => s.assignGroup(5, 2, true, MANAGER)],
  ])('refuse à un non-admin de %s un compte administrateur', async (_label, act) => {
    const { service, prisma } = setup({ target: otherAdmin });
    await expect(act(service)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.appUser.update).not.toHaveBeenCalled();
    expect(prisma.appUser.delete).not.toHaveBeenCalled();
    expect(prisma.appUserGroup.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['modifier', (s: UsersService) => s.updateUser(5, { email: 'x@y.ci' }, ADMIN)],
    ['réinitialiser le mot de passe', (s: UsersService) => s.resetPassword(5, 'nouveau1', ADMIN)],
    ['supprimer', (s: UsersService) => s.deleteUser(5, ADMIN)],
  ])('laisse un administrateur %s un autre compte administrateur', async (_label, act) => {
    const { service } = setup({ target: otherAdmin });
    await expect(act(service)).resolves.toBeDefined();
  });

  it('refuse à un non-admin la réinitialisation du compte `admin` protégé (même si isAdmin a dérivé)', async () => {
    const { service, prisma } = setup({ target: { username: 'admin', isAdmin: false } });
    await expect(service.resetPassword(1, 'nouveau1', MANAGER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('garde le refus historique (400) pour modifier ou supprimer le compte `admin`, même par un admin', async () => {
    const { service } = setup({ target: { username: 'admin', isAdmin: true } });
    await expect(service.updateUser(1, { email: 'x@y.ci' }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.deleteUser(1, ADMIN)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('laisse un non-admin gérer un compte ordinaire (réinitialisation, suppression)', async () => {
    const { service, prisma } = setup({ target: plainUser });
    await expect(service.resetPassword(5, 'nouveau1', MANAGER)).resolves.toEqual({ reset: true });
    expect(prisma.appUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mustChangePwd: true }) }),
    );
    await expect(service.deleteUser(5, MANAGER)).resolves.toEqual({ deleted: true });
  });
});

describe('UsersService — rôle système réservé aux administrateurs', () => {
  it('refuse à un non-admin d’attribuer le rôle système (création et modification)', async () => {
    const { service, tx, prisma } = setup({ target: plainUser, role: { isSystem: true } });
    await expect(service.createUser(newUser({ roleId: 1 }), MANAGER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tx.appUser.create).not.toHaveBeenCalled();
    await expect(service.updateUser(5, { roleId: 1 }, MANAGER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('laisse un administrateur attribuer le rôle système', async () => {
    const { service } = setup({ target: plainUser, role: { isSystem: true } });
    await expect(service.updateUser(5, { roleId: 1 }, ADMIN)).resolves.toBeDefined();
  });

  it('ne revérifie pas un rôle inchangé (l’écran renvoie le rôle courant à chaque enregistrement)', async () => {
    const { service, prisma } = setup({ target: { ...plainUser, roleId: 1 }, role: { isSystem: true } });
    await expect(service.updateUser(5, { roleId: 1, email: 'x@y.ci' }, MANAGER)).resolves.toBeDefined();
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('laisse un non-admin attribuer un rôle ordinaire', async () => {
    const { service } = setup({ target: plainUser, role: { isSystem: false } });
    await expect(service.updateUser(5, { roleId: 4 }, MANAGER)).resolves.toBeDefined();
  });

  it('rend 400 (et non 500) pour un rôle inexistant', async () => {
    const { service } = setup({ target: plainUser, role: null });
    await expect(service.updateUser(5, { roleId: 999 }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.createUser(newUser({ roleId: 999 }), ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('UsersService — erreurs rendues lisibles', () => {
  it('rend 404 (et non 500 P2025) pour réinitialiser un compte inexistant', async () => {
    const { service, prisma } = setup({ target: null });
    await expect(service.resetPassword(999, 'nouveau1', ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.appUser.update).not.toHaveBeenCalled();
  });

  it('rend 404 pour affecter un profil à un compte inexistant', async () => {
    const { service } = setup({ target: null });
    await expect(service.assignGroup(999, 1, true, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rend 409 pour un identifiant déjà utilisé', async () => {
    const { service } = setup({ byUsername: { userId: 3 } });
    await expect(service.createUser(newUser(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rend 409 quand l’identifiant est pris entre la vérification et l’écriture (P2002)', async () => {
    const { service } = setup({ createError: { code: 'P2002' } });
    await expect(service.createUser(newUser(), ADMIN)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rend 400 pour une habilitation ou un profil inexistant (P2003)', async () => {
    const { service } = setup({ createError: { code: 'P2003' } });
    await expect(
      service.createUser(newUser({ confidentialiteId: 999 }), ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    const upd = setup({ target: plainUser, updateError: { code: 'P2003' } });
    await expect(
      upd.service.updateUser(5, { confidentialiteId: 999 }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('crée compte et profil dans une même transaction', async () => {
    const { service, prisma, tx } = setup();
    await service.createUser(newUser({ groupId: 2 }), ADMIN);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.appUserGroup.create).toHaveBeenCalledWith({
      data: { userId: 10, groupId: 2, isDefault: true },
    });
  });

  it('rend 400 pour une affectation en masse vers un niveau inexistant ou désactivé', async () => {
    const { service, prisma } = setup();
    const findFirst = jest.fn(async () => null);
    (prisma as unknown as { confidentialite: unknown }).confidentialite = { findFirst };
    await expect(service.setConfidentialite([5], 999)).rejects.toBeInstanceOf(BadRequestException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { confidentialiteId: 999, isActive: true } }),
    );
    expect(prisma.appUser.updateMany).not.toHaveBeenCalled();
  });

  it('accepte un niveau actif et le retrait (null) en masse', async () => {
    const { service, prisma } = setup();
    const findFirst = jest.fn(async () => ({ confidentialiteId: 2 }));
    (prisma as unknown as { confidentialite: unknown }).confidentialite = { findFirst };
    await expect(service.setConfidentialite([5], 2)).resolves.toEqual({ updated: 1 });
    await expect(service.setConfidentialite([5], null)).resolves.toEqual({ updated: 1 });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('un mot de passe fixé depuis la fiche redevient provisoire (mustChangePwd)', async () => {
    const { service, prisma } = setup({ target: plainUser });
    await service.updateUser(5, { password: 'Fiche-9876!' }, ADMIN);
    expect(prisma.appUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mustChangePwd: true }) }),
    );
    prisma.appUser.update.mockClear();
    await service.updateUser(5, { email: 'x@exemple.ci' }, ADMIN);
    const data = (prisma.appUser.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.mustChangePwd).toBeUndefined();
  });

  it('laisse passer une erreur inattendue telle quelle', async () => {
    const boom = new Error('base indisponible');
    const { service } = setup({ createError: boom });
    await expect(service.createUser(newUser(), ADMIN)).rejects.toBe(boom);
  });
});

describe('UsersController — transmet l’acteur au service', () => {
  it('passe l’utilisateur courant à chaque écriture', async () => {
    const service = {
      createUser: jest.fn(),
      updateUser: jest.fn(),
      deleteUser: jest.fn(),
      resetPassword: jest.fn(),
      assignGroup: jest.fn(),
    };
    const c = new UsersController(service as unknown as UsersService);
    const actor = { userId: 9, username: 'x', isAdmin: false, userGroupId: null } as AuthUser;
    c.create(newUser(), actor);
    c.update(5, { email: 'x@y.ci' }, actor);
    c.remove(5, actor);
    c.resetPassword(5, { newPassword: 'nouveau1' }, actor);
    c.assignGroup(5, { groupId: 2 }, actor);
    expect(service.createUser).toHaveBeenCalledWith(expect.anything(), actor);
    expect(service.updateUser).toHaveBeenCalledWith(5, expect.anything(), actor);
    expect(service.deleteUser).toHaveBeenCalledWith(5, actor);
    expect(service.resetPassword).toHaveBeenCalledWith(5, 'nouveau1', actor);
    expect(service.assignGroup).toHaveBeenCalledWith(5, 2, false, actor);
  });
});

describe('users.dto — saisies refusées en 400 plutôt qu’en 500', () => {
  const base = { username: 'u', firstName: 'A', lastName: 'B', email: 'a@b.ci', password: 'secret' };

  it('rogne l’identifiant et refuse un identifiant fait d’espaces', () => {
    expect(createUserSchema.parse({ ...base, username: '  agent ' }).username).toBe('agent');
    expect(createUserSchema.safeParse({ ...base, username: '   ' }).success).toBe(false);
  });

  it('refuse un e-mail absent ou invalide, et un mot de passe de moins de 6 caractères', () => {
    expect(createUserSchema.safeParse({ ...base, email: undefined }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, email: 'pas-une-adresse' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, password: '12345' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, password: '123456' }).success).toBe(true);
  });

  it('refuse un mot de passe qui commence ou finit par une espace (impossible à saisir à la connexion)', () => {
    for (const pw of [' secret1', 'secret1 ', '	secret1']) {
      expect(createUserSchema.safeParse({ ...base, password: pw }).success).toBe(false);
      expect(updateUserSchema.safeParse({ password: pw }).success).toBe(false);
      expect(resetPasswordSchema.safeParse({ newPassword: pw }).success).toBe(false);
    }
    expect(createUserSchema.safeParse({ ...base, password: 'sec ret1' }).success).toBe(true);
  });

  it('borne les champs à la taille des colonnes', () => {
    expect(createUserSchema.safeParse({ ...base, firstName: 'x'.repeat(51) }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, lastName: 'x'.repeat(51) }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, username: 'x'.repeat(401) }).success).toBe(false);
    expect(
      createUserSchema.safeParse({ ...base, email: `${'x'.repeat(196)}@b.ci` }).success,
    ).toBe(false);
    expect(updateUserSchema.safeParse({ firstName: 'x'.repeat(51) }).success).toBe(false);
  });
});
