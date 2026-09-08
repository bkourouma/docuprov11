import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ALLOW_SCAN_AGENT_KEY } from './scan-agent-key.decorator';

const KEY = 'k'.repeat(48);

type Request = { headers: Record<string, string | string[] | undefined>; user?: AuthUser };

function context(headers: Request['headers'] = {}): {
  ctx: ExecutionContext;
  request: Request;
} {
  const request: Request = { headers };
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

/** Reflector simulé : `metadata` liste les clés que la route porte. */
function reflector(...metadata: string[]): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata.includes(key) || undefined,
  } as unknown as Reflector;
}

function config(apiKey?: string): ConfigService {
  return { get: () => apiKey } as unknown as ConfigService;
}

/**
 * `super.canActivate` déclenche Passport, hors de portée d'un test unitaire : on le remplace par
 * un marqueur, ce qui rend visible « la requête est retombée sur le JWT » — l'assertion qui compte
 * pour prouver qu'aucune porte n'est ouverte.
 */
function guard(reflectorInstance: Reflector, configInstance: ConfigService): JwtAuthGuard {
  const g = new JwtAuthGuard(reflectorInstance, configInstance);
  Object.getPrototypeOf(Object.getPrototypeOf(g)).canActivate = () => 'jwt-fallback';
  return g;
}

describe('JwtAuthGuard — clé de service', () => {
  it('accepte la clé sur une route qui l’autorise, avec une identité machine sans compte', () => {
    const { ctx, request } = context({ 'x-api-key': KEY });
    const ok = guard(reflector(ALLOW_SCAN_AGENT_KEY), config(KEY)).canActivate(ctx);

    expect(ok).toBe(true);
    expect(request.user).toEqual({
      userId: -1,
      username: 'scan-agent',
      isAdmin: false,
      userGroupId: null,
      isScanAgent: true,
    });
  });

  it('ignore la clé sur une route qui ne l’autorise pas', () => {
    const { ctx, request } = context({ 'x-api-key': KEY });
    expect(guard(reflector(), config(KEY)).canActivate(ctx)).toBe('jwt-fallback');
    expect(request.user).toBeUndefined();
  });

  it('n’ouvre rien quand aucune clé n’est configurée sur le serveur', () => {
    const { ctx, request } = context({ 'x-api-key': KEY });
    expect(guard(reflector(ALLOW_SCAN_AGENT_KEY), config()).canActivate(ctx)).toBe('jwt-fallback');
    expect(request.user).toBeUndefined();
  });

  it('refuse une clé fausse, une clé vide ou une clé absente', () => {
    for (const headers of [{ 'x-api-key': 'x'.repeat(48) }, { 'x-api-key': '' }, {}]) {
      const { ctx, request } = context(headers);
      expect(guard(reflector(ALLOW_SCAN_AGENT_KEY), config(KEY)).canActivate(ctx)).toBe(
        'jwt-fallback',
      );
      expect(request.user).toBeUndefined();
    }
  });

  it('refuse une clé de longueur différente sans lever (timingSafeEqual exige l’égalité)', () => {
    const { ctx } = context({ 'x-api-key': 'court' });
    expect(() =>
      guard(reflector(ALLOW_SCAN_AGENT_KEY), config(KEY)).canActivate(ctx),
    ).not.toThrow();
  });

  it('laisse passer une route publique sans rien regarder', () => {
    const { ctx, request } = context();
    expect(guard(reflector(IS_PUBLIC_KEY), config(KEY)).canActivate(ctx)).toBe(true);
    expect(request.user).toBeUndefined();
  });
});
