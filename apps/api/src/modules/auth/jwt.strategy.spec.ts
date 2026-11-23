import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.types';
import { JwtStrategy } from './jwt.strategy';

type Account = { isAdmin: boolean; isDisabled: boolean } | null;

function strategy(account: Account) {
  const findUnique = jest.fn().mockResolvedValue(account);
  const prisma = { appUser: { findUnique } } as unknown as PrismaService;
  const config = { getOrThrow: () => 'secret-de-test' } as unknown as ConfigService;
  return { s: new JwtStrategy(config, prisma), findUnique };
}

const payload = (over: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 42,
  username: 'agent',
  isAdmin: false,
  userGroupId: 7,
  fullName: 'Agent Test',
  ...over,
});

describe('JwtStrategy.validate — relecture du compte à chaque requête', () => {
  it('rend l’identité du jeton pour un compte actif, en une seule lecture minimale', async () => {
    const { s, findUnique } = strategy({ isAdmin: false, isDisabled: false });
    await expect(s.validate(payload())).resolves.toEqual({
      userId: 42,
      username: 'agent',
      isAdmin: false,
      userGroupId: 7,
      fullName: 'Agent Test',
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId: 42 },
      select: { isAdmin: true, isDisabled: true },
    });
  });

  it('refuse (401) un compte désactivé alors que le jeton est encore valide', async () => {
    const { s } = strategy({ isAdmin: false, isDisabled: true });
    await expect(s.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuse (401) un compte supprimé', async () => {
    const { s } = strategy(null);
    await expect(s.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuse (401) un administrateur désactivé', async () => {
    const { s } = strategy({ isAdmin: true, isDisabled: true });
    await expect(s.validate(payload({ isAdmin: true }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('prend isAdmin de la base : un administrateur rétrogradé perd le statut aussitôt', async () => {
    const { s } = strategy({ isAdmin: false, isDisabled: false });
    const user = await s.validate(payload({ isAdmin: true }));
    expect(user.isAdmin).toBe(false);
  });

  it('prend isAdmin de la base : une promotion vaut sans reconnexion', async () => {
    const { s } = strategy({ isAdmin: true, isDisabled: false });
    const user = await s.validate(payload({ isAdmin: false }));
    expect(user.isAdmin).toBe(true);
  });

  it('ne pose jamais isScanAgent depuis un jeton', async () => {
    const { s } = strategy({ isAdmin: false, isDisabled: false });
    const forged = { ...payload(), isScanAgent: true } as unknown as JwtPayload;
    const user = await s.validate(forged);
    expect(user).not.toHaveProperty('isScanAgent');
  });

  it('normalise un jeton ancien sans fullName ni userGroupId', async () => {
    const { s } = strategy({ isAdmin: false, isDisabled: false });
    const legacy = { sub: 42, username: 'agent', isAdmin: false } as unknown as JwtPayload;
    const user = await s.validate(legacy);
    expect(user.fullName).toBeNull();
    expect(user.userGroupId).toBeNull();
  });

  it('refuse (401) un sujet absent ou invalide sans interroger la base', async () => {
    for (const sub of [undefined, 0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
      const { s, findUnique } = strategy({ isAdmin: true, isDisabled: false });
      const bad = { ...payload(), sub } as unknown as JwtPayload;
      await expect(s.validate(bad)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(findUnique).not.toHaveBeenCalled();
    }
  });
});
