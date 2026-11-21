import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import { GED_DRAFT_RATE_LIMIT_PER_MINUTE } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import {
  DRAFTING_RATE_MAX_KEYS,
  DRAFTING_RATE_WINDOW_MS,
  DraftingRateLimitGuard,
} from './drafting-rate-limit.guard';

function ctx(user: AuthUser | undefined, setHeader = jest.fn()): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
}

const u = (userId: number): AuthUser => ({ userId, username: `u${userId}`, isAdmin: false, userGroupId: userId });

function setup(start = 1_000_000) {
  const guard = new DraftingRateLimitGuard();
  let now = start;
  guard.clock = () => now;
  return { guard, advance: (ms: number) => (now += ms) };
}

describe('DraftingRateLimitGuard', () => {
  it('autorise la limite puis refuse la requête suivante en 429 avec Retry-After', () => {
    const { guard, advance } = setup();
    for (let i = 0; i < GED_DRAFT_RATE_LIMIT_PER_MINUTE; i++) {
      expect(guard.canActivate(ctx(u(1)))).toBe(true);
      advance(1000);
    }
    const setHeader = jest.fn();
    let err: unknown;
    try {
      guard.canActivate(ctx(u(1), setHeader));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // La plus ancienne requête date de 5 s : 55 s restantes.
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '55');
  });

  it('la 6e requête échoue (limite de 5 par minute)', () => {
    expect(GED_DRAFT_RATE_LIMIT_PER_MINUTE).toBe(5);
    const { guard } = setup();
    for (let i = 0; i < 5; i++) guard.canActivate(ctx(u(1)));
    expect(() => guard.canActivate(ctx(u(1)))).toThrow(HttpException);
  });

  it('utilisateurs indépendants', () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) guard.canActivate(ctx(u(1)));
    expect(() => guard.canActivate(ctx(u(1)))).toThrow(HttpException);
    expect(guard.canActivate(ctx(u(2)))).toBe(true);
  });

  it('la fenêtre glisse : la requête redevient possible une fois la plus ancienne expirée', () => {
    const { guard, advance } = setup();
    for (let i = 0; i < 5; i++) guard.canActivate(ctx(u(1)));
    expect(() => guard.canActivate(ctx(u(1)))).toThrow(HttpException);
    advance(DRAFTING_RATE_WINDOW_MS + 1);
    expect(guard.canActivate(ctx(u(1)))).toBe(true);
  });

  it('une requête refusée n’est pas comptée (pas de prolongation du blocage)', () => {
    const { guard, advance } = setup();
    for (let i = 0; i < 5; i++) guard.canActivate(ctx(u(1)));
    for (let i = 0; i < 3; i++) expect(() => guard.canActivate(ctx(u(1)))).toThrow(HttpException);
    advance(DRAFTING_RATE_WINDOW_MS + 1);
    for (let i = 0; i < 5; i++) expect(guard.canActivate(ctx(u(1)))).toBe(true);
  });

  it('sans utilisateur : laisse passer sans rien compter', () => {
    const { guard } = setup();
    expect(guard.canActivate(ctx(undefined))).toBe(true);
    expect(guard.trackedKeys).toBe(0);
  });

  it('les clés inactives sont purgées', () => {
    const { guard, advance } = setup();
    for (let i = 1; i <= 50; i++) guard.canActivate(ctx(u(i)));
    expect(guard.trackedKeys).toBe(50);
    advance(DRAFTING_RATE_WINDOW_MS * 2);
    guard.canActivate(ctx(u(999)));
    expect(guard.trackedKeys).toBe(1);
  });

  it('mémoire bornée : jamais plus de DRAFTING_RATE_MAX_KEYS clés', () => {
    const { guard } = setup();
    for (let i = 1; i <= DRAFTING_RATE_MAX_KEYS + 50; i++) guard.canActivate(ctx(u(i)));
    expect(guard.trackedKeys).toBe(DRAFTING_RATE_MAX_KEYS);
  });
});
