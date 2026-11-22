import { BadRequestException, ForbiddenException, RequestMethod, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import type { AuthUser } from '../../auth/auth.types';
import { MenuPermissionGuard } from '../../auth/menu-permission.guard';
import { REQUIRE_MENU_KEY } from '../../auth/require-menu.decorator';
import { WORKFLOWS_MENUS } from '../../workflows/workflows.menus';
import type { ZodSchema } from 'zod';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import {
  bigIntIdSchema,
  createEvalCaseSchema,
  createEvalSetSchema,
  evalStatusQuerySchema,
  intIdSchema,
  listEvalSetsQuerySchema,
  runEvalSetSchema,
  updateEvalCaseSchema,
  updateEvalSetSchema,
} from './eval.dto';
import { EvalController } from './eval.controller';

const proto = EvalController.prototype as unknown as Record<string, object>;

function ctxFor(handler: string, user: AuthUser): ExecutionContext {
  return {
    getHandler: () => proto[handler],
    getClass: () => EvalController,
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

const user: AuthUser = { userId: 7, username: 'u', isAdmin: false, userGroupId: 70 };

const routes = Object.getOwnPropertyNames(EvalController.prototype)
  .filter((n) => n !== 'constructor')
  .filter((n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined);

const tableOf = (): string[] =>
  routes.map((n) => `${Reflect.getMetadata(METHOD_METADATA, proto[n])}:${String(Reflect.getMetadata(PATH_METADATA, proto[n]))}`).sort();

describe('EvalController : routes et accès refusé par défaut', () => {
  it('préfixe workflows/agents, derrière MenuPermissionGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EvalController)).toBe('workflows/agents');
    expect(Reflect.getMetadata(GUARDS_METADATA, EvalController)).toEqual([MenuPermissionGuard]);
  });

  it('les 12 routes attendues', () => {
    const G = RequestMethod.GET;
    const P = RequestMethod.POST;
    const PA = RequestMethod.PATCH;
    const D = RequestMethod.DELETE;
    expect(tableOf()).toEqual(
      [
        `${G}:eval-status`,
        `${G}:eval-sets`,
        `${P}:eval-sets`,
        `${G}:eval-sets/:id`,
        `${PA}:eval-sets/:id`,
        `${G}:eval-sets/:id/cases`,
        `${P}:eval-sets/:id/cases`,
        `${PA}:eval-sets/:id/cases/:caseId`,
        `${D}:eval-sets/:id/cases/:caseId`,
        `${G}:eval-sets/:id/runs`,
        `${P}:eval-sets/:id/runs`,
        `${G}:eval-runs/:runId`,
      ].sort(),
    );
  });

  it('lancer un run répond 202', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.runSet)).toBe(202);
  });

  it('CHAQUE route exige le menu conception', () => {
    expect(routes).toHaveLength(12);
    for (const n of routes) {
      expect(Reflect.getMetadata(REQUIRE_MENU_KEY, proto[n])).toEqual([WORKFLOWS_MENUS.design]);
    }
  });

  it('le garde réel refuse sans le menu conception (lancement ou administration ne suffisent pas)', async () => {
    const guard = guardWithMenus([WORKFLOWS_MENUS.launch, WORKFLOWS_MENUS.admin]);
    for (const n of routes) {
      await expect(guard.canActivate(ctxFor(n, user))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('le garde réel laisse passer avec le menu conception', async () => {
    const guard = guardWithMenus([WORKFLOWS_MENUS.design]);
    for (const n of routes) {
      await expect(guard.canActivate(ctxFor(n, user))).resolves.toBe(true);
    }
  });
});

describe('EvalController : validation des corps (zod)', () => {
  const validate = (schema: ZodSchema<unknown>, value: unknown): unknown => new ZodValidationPipe(schema).transform(value);

  it('eval-status : definitionId entier positif obligatoire (chaîne numérique acceptée), inconnu refusé', () => {
    expect(validate(evalStatusQuerySchema, { definitionId: '5' })).toEqual({ definitionId: 5 });
    expect(() => validate(evalStatusQuerySchema, {})).toThrow(BadRequestException);
    expect(() => validate(evalStatusQuerySchema, { definitionId: 'abc' })).toThrow(BadRequestException);
    expect(() => validate(evalStatusQuerySchema, { definitionId: '0' })).toThrow(BadRequestException);
    expect(() => validate(evalStatusQuerySchema, { definitionId: '1.5' })).toThrow(BadRequestException);
    expect(() => validate(evalStatusQuerySchema, { definitionId: '5', extra: 1 })).toThrow(BadRequestException);
  });

  it('création de jeu : champs requis, champs inconnus refusés, précision à 3 décimales au plus', () => {
    const ok = { definitionId: 5, name: 'Jeu', minAccuracy: 0.85 };
    expect(validate(createEvalSetSchema, ok)).toEqual(ok);
    expect(() => validate(createEvalSetSchema, { name: 'x' })).toThrow(BadRequestException);
    expect(() => validate(createEvalSetSchema, { ...ok, extra: 1 })).toThrow(BadRequestException);
    expect(() => validate(createEvalSetSchema, { ...ok, minAccuracy: 1.5 })).toThrow(BadRequestException);
    expect(() => validate(createEvalSetSchema, { ...ok, minAccuracy: 0.8004 })).toThrow(BadRequestException);
    expect(() => validate(createEvalSetSchema, { ...ok, name: '   ' })).toThrow(BadRequestException);
  });

  it('création de jeu : un seuil sous le plancher passe la validation de forme (le service répond 422)', () => {
    expect(() => validate(createEvalSetSchema, { definitionId: 5, name: 'x', minAccuracy: 0.5 })).not.toThrow();
  });

  it('modification de jeu : aucune clé inconnue (createdBy, isLowRisk…), definitionId accepté pour être refusé par le service', () => {
    expect(() => validate(updateEvalSetSchema, { createdBy: 3 })).toThrow(BadRequestException);
    expect(() => validate(updateEvalSetSchema, { definitionId: 6 })).not.toThrow();
    expect(() => validate(updateEvalSetSchema, { isActive: 'oui' })).toThrow(BadRequestException);
  });

  it('création de cas : label, entrée, attendu, poids > 0', () => {
    const ok = { label: 'Cas', input: { untrusted: [{ label: 'M', origin: 'mail', text: 'x' }] }, expected: { returnsToHuman: true } };
    expect(() => validate(createEvalCaseSchema, ok)).not.toThrow();
    expect(() => validate(createEvalCaseSchema, { ...ok, weight: 0 })).toThrow(BadRequestException);
    expect(() => validate(createEvalCaseSchema, { ...ok, expected: {} })).toThrow(BadRequestException);
    expect(() => validate(createEvalCaseSchema, { ...ok, input: { untrusted: [{ label: 'M', origin: 'x', text: 'x' }] } })).toThrow(
      BadRequestException,
    );
    expect(() => validate(createEvalCaseSchema, { ...ok, evalSetId: 9 })).toThrow(BadRequestException);
    expect(() => validate(updateEvalCaseSchema, { weight: -2 })).toThrow(BadRequestException);
    expect(() => validate(updateEvalCaseSchema, { isActive: false })).not.toThrow();
  });

  it('lancement : seulement version et étape ; corps vide accepté', () => {
    expect(() => validate(runEvalSetSchema, {})).not.toThrow();
    expect(() => validate(runEvalSetSchema, { definitionVersionId: 3, stepKey: 'tri' })).not.toThrow();
    expect(() => validate(runEvalSetSchema, { requiredAccuracy: 0.1 })).toThrow(BadRequestException);
    expect(() => validate(runEvalSetSchema, { definitionVersionId: -1 })).toThrow(BadRequestException);
  });

  it('identifiants : entier positif pour les jeux et cas, chaîne décimale de BigInt pour les runs', () => {
    expect(validate(intIdSchema, '12')).toBe(12);
    expect(() => validate(intIdSchema, 'abc')).toThrow(BadRequestException);
    expect(() => validate(intIdSchema, '0')).toThrow(BadRequestException);
    expect(validate(bigIntIdSchema, '123456789012345678')).toBe('123456789012345678');
    expect(() => validate(bigIntIdSchema, '0123')).toThrow(BadRequestException);
    expect(() => validate(bigIntIdSchema, '12a')).toThrow(BadRequestException);
    expect(() => validate(bigIntIdSchema, '1234567890123456789')).toThrow(BadRequestException);
  });

  it('filtre ?definitionId= converti en nombre', () => {
    expect(validate(listEvalSetsQuerySchema, { definitionId: '5' })).toEqual({ definitionId: 5 });
    expect(validate(listEvalSetsQuerySchema, {})).toEqual({});
    expect(() => validate(listEvalSetsQuerySchema, { definitionId: 'x' })).toThrow(BadRequestException);
  });
});

describe('EvalController : délégation au service', () => {
  it('transmet l’utilisateur courant et un corps absent devient {} pour le lancement', async () => {
    const service = { runSet: jest.fn().mockResolvedValue({ wfEvalRunId: '1' }), listSets: jest.fn().mockResolvedValue([]) };
    const controller = new EvalController(service as never);
    await expect(controller.runSet(3, undefined, user)).resolves.toEqual({ wfEvalRunId: '1' });
    expect(service.runSet).toHaveBeenCalledWith(3, {}, user);
    await controller.listSets({ definitionId: 5 });
    expect(service.listSets).toHaveBeenCalledWith(5);
  });
});
