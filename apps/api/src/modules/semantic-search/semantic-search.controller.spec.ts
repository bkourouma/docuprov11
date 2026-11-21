import { BadRequestException, HttpException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { GED_SEMANTIC_QUERY_MAX_CHARS } from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { IS_PUBLIC_KEY as PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRE_ADMIN_KEY, REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';
import {
  SEMANTIC_RATE_LIMITS,
  SEMANTIC_RATE_MAX_KEYS,
  SEMANTIC_RATE_WINDOW_MS,
  SemanticRateLimitGuard,
} from './semantic-rate-limit.guard';
import { SemanticSearchController } from './semantic-search.controller';
import { SEMANTIC_SEARCH_MENU } from './semantic-search.menus';

const user: AuthUser = { userId: 7, username: 'agent', isAdmin: false, userGroupId: 70 };

type PipeLike = { transform(value: unknown, metadata: never): unknown };
const meta = {} as never;

function bodyPipe(method: string): PipeLike {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, SemanticSearchController, method) as Record<
    string,
    { data?: string; pipes: PipeLike[] }
  >;
  const entry = Object.values(args).find((e) => e.pipes.some((p) => p instanceof ZodValidationPipe));
  if (!entry) throw new Error(`Aucun ZodValidationPipe sur ${method}`);
  return entry.pipes[0];
}

describe('SemanticSearchController : métadonnées', () => {
  const proto = SemanticSearchController.prototype as unknown as Record<string, object>;

  it('MenuPermissionGuard puis SemanticRateLimitGuard sur le contrôleur', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SemanticSearchController)).toEqual([
      MenuPermissionGuard,
      SemanticRateLimitGuard,
    ]);
  });

  it.each(['search', 'ask'])('%s : @RequireMenu(SEMANTIC_SEARCH_MENU), 200, pas public', (m) => {
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[m])).toEqual([SEMANTIC_SEARCH_MENU]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto[m])).toBe(200);
    expect(Reflect.getMetadata(PUBLIC_KEY, proto[m])).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto[m])).toBeUndefined();
  });

  it('reindex : @RequireAdmin', () => {
    expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, proto.reindex)).toBe(true);
    expect(Reflect.getMetadata(PUBLIC_KEY, proto.reindex)).toBeUndefined();
  });

  it('le menu requis est bien la clé /recherche-ia', () => {
    expect(SEMANTIC_SEARCH_MENU).toBe('/recherche-ia');
  });

  it('aucune route ne porte @Public', () => {
    for (const name of ['search', 'ask', 'reindex']) {
      expect(Reflect.getMetadata(PUBLIC_KEY, proto[name])).toBeUndefined();
    }
    expect(Reflect.getMetadata(PUBLIC_KEY, SemanticSearchController)).toBeUndefined();
  });
});

describe('SemanticSearchController : corps stricts', () => {
  it('search : champ inconnu => 400, valeurs par défaut appliquées', () => {
    const pipe = bodyPipe('search');
    expect(() => pipe.transform({ query: 'contrat', extra: 1 }, meta)).toThrow(BadRequestException);
    expect(pipe.transform({ query: 'contrat' }, meta)).toMatchObject({ query: 'contrat', limit: 10 });
  });

  it('search : requête trop longue, trop courte ou limite hors bornes => 400', () => {
    const pipe = bodyPipe('search');
    expect(() => pipe.transform({ query: 'a'.repeat(GED_SEMANTIC_QUERY_MAX_CHARS + 1) }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ query: 'a' }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ query: 'contrat', limit: 21 }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ query: 'contrat', limit: 0 }, meta)).toThrow(BadRequestException);
  });

  it('ask : champ inconnu => 400 ; question trop longue => 400', () => {
    const pipe = bodyPipe('ask');
    expect(() => pipe.transform({ question: 'Que dit le contrat ?', x: 1 }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ question: 'a'.repeat(GED_SEMANTIC_QUERY_MAX_CHARS + 1) }, meta)).toThrow(BadRequestException);
    expect(pipe.transform({ question: 'Que dit le contrat ?' }, meta)).toEqual({ question: 'Que dit le contrat ?' });
  });

  it('reindex : {} ou { documentId } seulement', () => {
    const pipe = bodyPipe('reindex');
    expect(pipe.transform({}, meta)).toEqual({});
    expect(pipe.transform({ documentId: 5 }, meta)).toEqual({ documentId: 5 });
    expect(() => pipe.transform({ documentId: 0 }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ documentId: 2147483648 }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ documentId: '5' }, meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ other: 1 }, meta)).toThrow(BadRequestException);
  });
});

describe('SemanticSearchController : délégation', () => {
  it('reindex : sans documentId => reindexAll ; avec => reindexDocument', async () => {
    const service = {
      search: jest.fn(),
      ask: jest.fn(),
      reindexAll: jest.fn().mockResolvedValue({ queued: true }),
      reindexDocument: jest.fn().mockResolvedValue({ queued: true }),
    };
    const c = new SemanticSearchController(service as never);
    await c.reindex({}, user);
    expect(service.reindexAll).toHaveBeenCalledWith(user);
    await c.reindex({ documentId: 9 }, user);
    expect(service.reindexDocument).toHaveBeenCalledWith(9, user);
  });
});

describe('SemanticRateLimitGuard', () => {
  const proto = SemanticSearchController.prototype as unknown as Record<string, () => unknown>;

  function make() {
    const guard = new SemanticRateLimitGuard(new Reflector());
    let now = 1_000_000;
    guard.clock = () => now;
    const headers: Record<string, string> = {};
    const ctx = (handler: string, u: AuthUser | null = user) =>
      ({
        getHandler: () => proto[handler],
        getClass: () => SemanticSearchController,
        switchToHttp: () => ({
          getRequest: () => ({ user: u ?? undefined }),
          getResponse: () => ({ setHeader: (k: string, v: string) => (headers[k] = v) }),
        }),
      }) as unknown as ExecutionContext;
    return { guard, ctx, headers, advance: (ms: number) => (now += ms), time: () => now };
  }

  it('21e requête de recherche dans la minute => 429 avec Retry-After', () => {
    const { guard, ctx, headers } = make();
    for (let i = 0; i < SEMANTIC_RATE_LIMITS.search; i++) expect(guard.canActivate(ctx('search'))).toBe(true);
    let err: unknown;
    try {
      guard.canActivate(ctx('search'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(String((err as HttpException).message)).toMatch(/Trop de requêtes/);
    expect(Number(headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect(Number(headers['Retry-After'])).toBeLessThanOrEqual(60);
  });

  it('ask : 7e requête => 429 ; compteurs séparés', () => {
    const { guard, ctx } = make();
    for (let i = 0; i < SEMANTIC_RATE_LIMITS.ask; i++) expect(guard.canActivate(ctx('ask'))).toBe(true);
    expect(() => guard.canActivate(ctx('ask'))).toThrow(HttpException);
    // Le compteur de recherche n'est pas entamé par /ask.
    expect(guard.canActivate(ctx('search'))).toBe(true);
    // Et inversement : saturer la recherche ne bloque pas /ask d'un autre utilisateur.
    const other: AuthUser = { ...user, userId: 8 };
    expect(guard.canActivate(ctx('ask', other))).toBe(true);
  });

  it('la fenêtre se libère avec l’horloge simulée (glissante)', () => {
    const { guard, ctx, advance } = make();
    for (let i = 0; i < 20; i++) {
      guard.canActivate(ctx('search'));
      advance(1000); // une requête par seconde pendant 20 s
    }
    expect(() => guard.canActivate(ctx('search'))).toThrow(HttpException);
    advance(SEMANTIC_RATE_WINDOW_MS - 20_000); // la 1re requête sort de la fenêtre
    expect(guard.canActivate(ctx('search'))).toBe(true);
    expect(() => guard.canActivate(ctx('search'))).toThrow(HttpException);
    advance(SEMANTIC_RATE_WINDOW_MS + 1);
    for (let i = 0; i < 20; i++) expect(guard.canActivate(ctx('search'))).toBe(true);
  });

  it('une requête refusée ne prolonge pas le blocage', () => {
    const { guard, ctx, advance } = make();
    for (let i = 0; i < 20; i++) guard.canActivate(ctx('search'));
    for (let i = 0; i < 50; i++) expect(() => guard.canActivate(ctx('search'))).toThrow(HttpException);
    advance(SEMANTIC_RATE_WINDOW_MS + 1);
    expect(guard.canActivate(ctx('search'))).toBe(true);
  });

  it('route sans compteur (reindex) ou sans utilisateur : pas de limite', () => {
    const { guard, ctx } = make();
    for (let i = 0; i < 100; i++) expect(guard.canActivate(ctx('reindex'))).toBe(true);
    for (let i = 0; i < 100; i++) expect(guard.canActivate(ctx('search', null))).toBe(true);
  });

  it('purge les clés expirées et borne la table', () => {
    const { guard, ctx, advance } = make();
    for (let id = 1; id <= 50; id++) guard.canActivate(ctx('search', { ...user, userId: id }));
    expect(guard.trackedKeys).toBe(50);
    advance(2 * SEMANTIC_RATE_WINDOW_MS);
    guard.canActivate(ctx('search', { ...user, userId: 999 }));
    expect(guard.trackedKeys).toBe(1);
    expect(SEMANTIC_RATE_MAX_KEYS).toBeGreaterThan(0);
  });
});
