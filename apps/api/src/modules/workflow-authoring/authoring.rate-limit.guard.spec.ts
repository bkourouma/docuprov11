import { HttpException, HttpStatus, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import {
  AUTHORING_RATE_LIMIT_PER_MINUTE,
  AUTHORING_RATE_MAX_KEYS,
  AUTHORING_RATE_WINDOW_MS,
  AuthoringRateLimitGuard,
} from './authoring.rate-limit.guard';

function ctx(user: AuthUser | undefined, setHeader = jest.fn()): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }), getResponse: () => ({ setHeader }) }),
  } as unknown as ExecutionContext;
}

const u = (userId: number): AuthUser => ({ userId, username: `u${userId}`, isAdmin: false, userGroupId: userId });

function setup(start = 1_000_000) {
  const guard = new AuthoringRateLimitGuard();
  let now = start;
  guard.clock = () => now;
  return { guard, advance: (ms: number) => (now += ms) };
}

describe('AuthoringRateLimitGuard', () => {
  it('la limite est de 5 générations par minute', () => {
    expect(AUTHORING_RATE_LIMIT_PER_MINUTE).toBe(5);
  });

  it('autorise 5 requêtes puis refuse la 6e en 429 français avec Retry-After', () => {
    const { guard, advance } = setup();
    for (let i = 0; i < 5; i++) {
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
    expect((err as HttpException).message).toMatch(/Trop de requêtes/);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '55');
  });

  it('libère après la fenêtre glissante', () => {
    const { guard, advance } = setup();
    for (let i = 0; i < 5; i++) guard.canActivate(ctx(u(1)));
    expect(() => guard.canActivate(ctx(u(1)))).toThrow(HttpException);
    advance(AUTHORING_RATE_WINDOW_MS + 1);
    expect(guard.canActivate(ctx(u(1)))).toBe(true);
  });

  it('utilisateurs indépendants ; non authentifié laissé aux autres gardes', () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) guard.canActivate(ctx(u(1)));
    expect(guard.canActivate(ctx(u(2)))).toBe(true);
    expect(guard.canActivate(ctx(undefined))).toBe(true);
  });

  it('mémoire bornée : au plus AUTHORING_RATE_MAX_KEYS utilisateurs suivis', () => {
    const { guard } = setup();
    for (let i = 1; i <= AUTHORING_RATE_MAX_KEYS + 10; i++) guard.canActivate(ctx(u(i)));
    expect(guard.trackedKeys).toBe(AUTHORING_RATE_MAX_KEYS);
  });
});
