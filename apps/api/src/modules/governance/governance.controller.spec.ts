import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { IS_PUBLIC_KEY as PUBLIC_KEY } from '../auth/public.decorator';
import { REQUIRE_MENU_KEY } from '../auth/require-menu.decorator';

// Les services (T3 et lecture) ne sont pas nécessaires ici : seuls leurs jetons d'injection le sont.
jest.mock('./governance-review.service', () => ({ GovernanceReviewService: class {} }));
jest.mock('./governance-query.service', () => ({ GovernanceQueryService: class {} }));
jest.mock('../documents/documents.service', () => ({ DocumentsService: class {} }));
jest.mock('./governance-access-filter', () => ({
  buildProposalVisibilityFilter: jest.fn(),
  buildGovernanceAccessFilter: jest.fn(),
}));

import { GovernanceController } from './governance.controller';
import { GovernanceModule } from './governance.module';
import { GED_GOVERNANCE_QUEUE_TOKEN } from './governance-queue.provider';
import { GOVERNANCE_MENU } from './governance.menus';

const user: AuthUser = { userId: 7, username: 'gest', isAdmin: false, userGroupId: 70 };
const adminUser: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 10 };
const meta = {} as never;
type PipeLike = { transform(value: unknown, metadata: never): unknown };

const proto = GovernanceController.prototype as unknown as Record<string, object>;
const ROUTES: Array<[string, string, string]> = [
  ['dashboard', 'GET', 'dashboard'],
  ['list', 'GET', 'proposals'],
  ['get', 'GET', 'proposals/:id'],
  ['validate', 'POST', 'proposals/:id/validate'],
  ['reject', 'POST', 'proposals/:id/reject'],
  ['analyze', 'POST', 'analyze'],
];

/** Pipes d'un argument du handler (premier paramètre de type `type`, ou l'argument de nom `data`). */
function pipesOf(method: string, data?: string): PipeLike[] {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, GovernanceController, method) as Record<
    string,
    { data?: string; pipes: PipeLike[] }
  >;
  const entry = Object.values(args).find((e) => e.pipes.length > 0 && (data === undefined || e.data === data));
  if (!entry) throw new Error(`Aucun pipe sur ${method}`);
  return entry.pipes;
}
const pipe = (method: string, data?: string) => pipesOf(method, data)[0];

describe('GovernanceController : accès refusé par défaut', () => {
  it('MenuPermissionGuard + @RequireMenu(GOVERNANCE_MENU) au niveau du contrôleur', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, GovernanceController)).toEqual([MenuPermissionGuard]);
    expect(Reflect.getMetadata(REQUIRE_MENU_KEY, GovernanceController)).toEqual([GOVERNANCE_MENU]);
    expect(GOVERNANCE_MENU).toBe('/gouvernance');
  });

  it('chaque route du contrôleur est connue ; aucune n’est @Public ni ne contourne le menu', () => {
    const names = Object.getOwnPropertyNames(GovernanceController.prototype).filter((n) => n !== 'constructor');
    const routed = names.filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);
    expect(routed.sort()).toEqual(ROUTES.map((r) => r[0]).sort());
    for (const n of routed) {
      expect(Reflect.getMetadata(PUBLIC_KEY, proto[n])).toBeUndefined();
      // Le menu requis est résolu par le garde via getAllAndOverride(handler, classe) : si un handler
      // le redéfinit, ce doit être le même menu.
      const own = Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n]);
      if (own !== undefined) expect(own).toEqual([GOVERNANCE_MENU]);
    }
    expect(Reflect.getMetadata(PUBLIC_KEY, GovernanceController)).toBeUndefined();
  });

  it.each(ROUTES)('%s : verbe, chemin et code HTTP', (name, verb, path) => {
    const methodCode = { GET: 0, POST: 1 }[verb as 'GET' | 'POST'];
    expect(Reflect.getMetadata(METHOD_METADATA, proto[name])).toBe(methodCode);
    expect(Reflect.getMetadata(PATH_METADATA, proto[name])).toBe(path);
    const code = Reflect.getMetadata(HTTP_CODE_METADATA, proto[name]);
    if (name === 'analyze') expect(code).toBe(202);
    else if (name === 'validate' || name === 'reject') expect(code).toBe(200);
    else expect(code).toBeUndefined();
  });

  it('le contrôleur est monté sur /governance', () => {
    expect(Reflect.getMetadata(PATH_METADATA, GovernanceController)).toBe('governance');
  });
});

describe('GovernanceController : validation stricte', () => {
  it.each(['get', 'validate', 'reject'])('%s : identifiant de chemin entier strictement positif', (m) => {
    const p = pipe(m, 'id');
    expect(p.transform('12', meta)).toBe(12);
    for (const bad of ['-1', '0', 'abc', '1.5', '', '99999999999', '1e3x']) {
      expect(() => p.transform(bad, meta)).toThrow(BadRequestException);
    }
  });

  it('liste : valeurs par défaut, statut inconnu, pageSize > 100, clé inconnue => 400', () => {
    const p = pipe('list');
    expect(p.transform({}, meta)).toMatchObject({ page: 1, pageSize: 25 });
    expect(p.transform({ status: '1', kind: 'pii', pageSize: '100' }, meta)).toMatchObject({ status: 1, kind: 'pii', pageSize: 100 });
    expect(() => p.transform({ status: '9' }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ status: '3' }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ pageSize: '101' }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ page: '0' }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ kind: 'inconnu' }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ minConfidence: '1.5' }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ nope: 1 }, meta)).toThrow(BadRequestException);
  });

  it('validate : corps strict (clé inconnue => rejet), confirmLowering booléen', () => {
    const p = pipe('validate', undefined as never);
    // Le premier pipe trouvé sur `validate` est celui de l'id : on cible le corps explicitement.
    const body = (Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, GovernanceController, 'validate')) as Array<{ data?: string; pipes: PipeLike[] }>).find(
      (e) => e.data === undefined && e.pipes.length > 0,
    )!.pipes[0];
    expect(p).toBeDefined();
    expect(body.transform({}, meta)).toEqual({});
    expect(body.transform({ confirmLowering: true }, meta)).toEqual({ confirmLowering: true });
    expect(() => body.transform({ confirmLowering: 'oui' }, meta)).toThrow(BadRequestException);
    expect(() => body.transform({ confirmLowering: true, extra: 1 }, meta)).toThrow(BadRequestException);
  });

  it('analyze : un document, une liste, ou all:true ; rien d’autre', () => {
    const p = pipe('analyze');
    expect(p.transform({ documentId: 5 }, meta)).toEqual({ documentId: 5 });
    expect(p.transform({ documentIds: [1, 2] }, meta)).toEqual({ documentIds: [1, 2] });
    expect(p.transform({ all: true }, meta)).toEqual({ all: true });
    expect(() => p.transform({}, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ all: false }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ documentId: 5, all: true }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ documentIds: [] }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ documentIds: Array.from({ length: 201 }, (_, i) => i + 1) }, meta)).toThrow(BadRequestException);
    expect(() => p.transform({ documentId: -3 }, meta)).toThrow(BadRequestException);
  });

  it('tous les pipes de corps/requête sont des ZodValidationPipe', () => {
    for (const m of ['list', 'get', 'validate', 'reject', 'analyze']) {
      for (const pp of pipesOf(m)) expect(pp).toBeInstanceOf(ZodValidationPipe);
    }
  });
});

describe('GovernanceController : délégation', () => {
  const view = { id: '11', kind: 'duplicate_exact', comparison: { original: {}, duplicate: {} } };

  function make() {
    const query = {
      dashboard: jest.fn().mockResolvedValue('dash'),
      list: jest.fn().mockResolvedValue('page'),
      get: jest.fn().mockResolvedValue(view),
      getForAdminReview: jest.fn().mockResolvedValue({ id: '11', kind: 'duplicate_exact', orphan: true }),
      analyze: jest.fn().mockResolvedValue('analyse'),
    };
    const review = {
      validate: jest.fn().mockResolvedValue({ applied: { action: 'duplicate_archived', at: 'x', by: 70 } }),
      reject: jest.fn().mockResolvedValue(undefined),
    };
    return { query, review, c: new GovernanceController(query as never, review as never) };
  }

  it('lecture et analyse : délégation au service de lecture avec l’utilisateur', async () => {
    const { c, query } = make();
    expect(await c.dashboard(user)).toBe('dash');
    expect(await c.list({ page: 1, pageSize: 25 }, user)).toBe('page');
    expect(query.list).toHaveBeenCalledWith({ page: 1, pageSize: 25 }, user);
    await c.get(11, user);
    expect(query.get).toHaveBeenCalledWith(11, user);
    expect(await c.analyze({ documentId: 5 }, user)).toBe('analyse');
    expect(query.analyze).toHaveBeenCalledWith({ documentId: 5 }, user);
  });

  it('validate : service de revue puis vue SANS comparaison + applied', async () => {
    const { c, review, query } = make();
    const res = await c.validate(11, { confirmLowering: true }, user);
    expect(review.validate).toHaveBeenCalledWith(11, user, { confirmLowering: true });
    expect(query.get).toHaveBeenCalledWith(11, user);
    expect(res.applied).toEqual({ action: 'duplicate_archived', at: 'x', by: 70 });
    expect(res.proposal).toEqual({ id: '11', kind: 'duplicate_exact' });
    expect('comparison' in res.proposal).toBe(false);
  });

  it('validate sans effet (applied absent) => applied null', async () => {
    const { c, review } = make();
    review.validate.mockResolvedValue({});
    expect((await c.validate(11, {}, user)).applied).toBeNull();
  });

  it('reject : service de revue, applied = null', async () => {
    const { c, review } = make();
    const res = await c.reject(11, user);
    expect(review.reject).toHaveBeenCalledWith(11, user);
    expect(res.applied).toBeNull();
    expect('comparison' in res.proposal).toBe(false);
  });

  it('reject d un orphelin par un administrateur : get 404 => vue de getForAdminReview', async () => {
    const { c, query } = make();
    query.get.mockRejectedValue(new NotFoundException());
    const res = await c.reject(11, adminUser);
    expect(query.getForAdminReview).toHaveBeenCalledWith(11, adminUser);
    expect(res).toEqual({ proposal: { id: '11', kind: 'duplicate_exact', orphan: true }, applied: null });
  });

  it('reject : get 404 pour un non-administrateur => 404 propage, sans vue d administration', async () => {
    const { c, query } = make();
    query.get.mockRejectedValue(new NotFoundException());
    await expect(c.reject(11, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(query.getForAdminReview).not.toHaveBeenCalled();
  });

  it('validate : jamais de repli administrateur (get 404 propage)', async () => {
    const { c, query } = make();
    query.get.mockRejectedValue(new NotFoundException());
    await expect(c.validate(11, {}, adminUser)).rejects.toBeInstanceOf(NotFoundException);
    expect(query.getForAdminReview).not.toHaveBeenCalled();
  });

  it('reject : une autre erreur de get n est pas masquee par le repli', async () => {
    const { c, query } = make();
    query.get.mockRejectedValue(new Error('base indisponible'));
    await expect(c.reject(11, adminUser)).rejects.toThrow('base indisponible');
    expect(query.getForAdminReview).not.toHaveBeenCalled();
  });

  it('une erreur du service de revue interrompt la réponse (pas de lecture ensuite)', async () => {
    const { c, review, query } = make();
    review.reject.mockRejectedValue(new Error('refus'));
    await expect(c.reject(11, user)).rejects.toThrow('refus');
    expect(query.get).not.toHaveBeenCalled();
  });
});

describe('GovernanceModule', () => {
  it('déclare imports, contrôleur et providers attendus (DocumentsService redéclaré)', () => {
    const imports = Reflect.getMetadata('imports', GovernanceModule) as unknown[];
    expect(imports).toHaveLength(2);
    expect(Reflect.getMetadata('controllers', GovernanceModule)).toEqual([GovernanceController]);
    const providers = Reflect.getMetadata('providers', GovernanceModule) as Array<{ name?: string; provide?: unknown }>;
    const names = providers.map((p) => p.name ?? String(p.provide));
    expect(names).toEqual(expect.arrayContaining(['GovernanceQueryService', 'GovernanceReviewService', 'DocumentsService', GED_GOVERNANCE_QUEUE_TOKEN]));
  });

  it('compile avec une file simulée (sans Redis) et ferme la file à l’arrêt', async () => {
    const queue = { close: jest.fn().mockResolvedValue(undefined) };
    const moduleRef = await Test.createTestingModule({
      controllers: [GovernanceController],
      providers: [
        { provide: (await import('./governance-query.service')).GovernanceQueryService, useValue: {} },
        { provide: (await import('./governance-review.service')).GovernanceReviewService, useValue: {} },
        { provide: GED_GOVERNANCE_QUEUE_TOKEN, useValue: queue },
      ],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect(moduleRef.get(GovernanceController)).toBeInstanceOf(GovernanceController);

    const mod = new GovernanceModule(queue as unknown as Queue);
    await mod.onApplicationShutdown();
    expect(queue.close).toHaveBeenCalledTimes(1);
  });
});
