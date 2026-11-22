import { BadRequestException, ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import type { AuthUser } from '../../auth/auth.types';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { REQUIRE_MENU_KEY } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { instantiateTemplateSchema, templateKeySchema, TemplatesController } from './templates.controller';

jest.mock('../eval/aiguilleur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('aiguilleur'), { virtual: true });
jest.mock('../eval/redacteur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('redacteur'), { virtual: true });
jest.mock('../eval/controleur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('controleur'), { virtual: true });
jest.mock('../eval/relanceur.eval', () => jest.requireActual('./test-support/mock-eval').loadEvalOrFake('relanceur'), { virtual: true });

const proto = TemplatesController.prototype as unknown as Record<string, object>;

function ctxFor(handler: string, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => TemplatesController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWithMenus(menuKeys: string[]): MenuPermissionGuard {
  const prisma = {
    appUser: {
      findUnique: jest.fn().mockResolvedValue({
        isAdmin: false,
        role: { isActive: true, isSystem: false, menus: menuKeys.map((menuKey) => ({ menuKey })) },
      }),
    },
  };
  return new MenuPermissionGuard(new Reflector(), prisma as never);
}

const designer: AuthUser = { userId: 7, username: 'conc', isAdmin: false, userGroupId: 70 };

describe('TemplatesController : routes et droits', () => {
  it('chemin, garde de menu et verbes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, TemplatesController)).toBe('workflows/templates');
    expect(Reflect.getMetadata(GUARDS_METADATA, TemplatesController)).toEqual([MenuPermissionGuard]);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.list)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.list)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.instantiate)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, proto.instantiate)).toBe(':key/instantiate');
  });

  it('chaque route exige le menu conception', () => {
    const names = Object.getOwnPropertyNames(TemplatesController.prototype).filter((n) => n !== 'constructor');
    const routed = names.filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);
    expect(routed).toHaveLength(2);
    for (const n of routed) expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n])).toEqual([WORKFLOWS_MENUS.design]);
  });

  it('sans le menu conception : 403 ; avec : accès accordé', async () => {
    const none = guardWithMenus([]);
    await expect(none.canActivate(ctxFor('list', designer))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(none.canActivate(ctxFor('instantiate', designer))).rejects.toBeInstanceOf(ForbiddenException);
    const launcherOnly = guardWithMenus([WORKFLOWS_MENUS.launch]);
    await expect(launcherOnly.canActivate(ctxFor('instantiate', designer))).rejects.toBeInstanceOf(ForbiddenException);
    const design = guardWithMenus([WORKFLOWS_MENUS.design]);
    await expect(design.canActivate(ctxFor('list', designer))).resolves.toBe(true);
    await expect(design.canActivate(ctxFor('instantiate', designer))).resolves.toBe(true);
  });

  it('délègue au service avec l’utilisateur courant et le nom facultatif', async () => {
    const service = { list: jest.fn().mockReturnValue([]), instantiate: jest.fn().mockResolvedValue({ definitionId: 9 }) };
    const controller = new TemplatesController(service as never);
    expect(controller.list()).toEqual([]);
    await expect(controller.instantiate('agent-aiguilleur', { name: 'Mon aiguilleur' }, designer)).resolves.toEqual({ definitionId: 9 });
    expect(service.instantiate).toHaveBeenCalledWith('agent-aiguilleur', 'Mon aiguilleur', designer);
    await controller.instantiate('agent-aiguilleur', undefined, designer);
    expect(service.instantiate).toHaveBeenLastCalledWith('agent-aiguilleur', undefined, designer);
  });
});

describe('TemplatesController : validation des entrées', () => {
  const keyPipe = new ZodValidationPipe(templateKeySchema);
  const bodyPipe = new ZodValidationPipe(instantiateTemplateSchema);

  it('refuse une clé hors du format ^[a-z0-9-]+$', () => {
    expect(keyPipe.transform('agent-aiguilleur')).toBe('agent-aiguilleur');
    for (const bad of ['Agent', 'agent_aiguilleur', 'a b', '../x', '', 'é']) {
      expect(() => keyPipe.transform(bad)).toThrow(BadRequestException);
    }
  });

  it('accepte un corps absent, vide ou avec un nom ; refuse le reste', () => {
    expect(bodyPipe.transform(undefined)).toBeUndefined();
    expect(bodyPipe.transform({})).toEqual({});
    expect(bodyPipe.transform({ name: '  Mon modèle ' })).toEqual({ name: 'Mon modèle' });
    expect(() => bodyPipe.transform({ name: '' })).toThrow(BadRequestException);
    expect(() => bodyPipe.transform({ name: 'x'.repeat(201) })).toThrow(BadRequestException);
    expect(() => bodyPipe.transform({ name: 3 })).toThrow(BadRequestException);
    expect(() => bodyPipe.transform({ autre: 'x' })).toThrow(BadRequestException);
  });
});
