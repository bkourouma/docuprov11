import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { AuthUser } from '../auth/auth.types';
import { MenuPermissionGuard } from '../auth/menu-permission.guard';
import { REQUIRE_ADMIN_KEY } from '../auth/require-menu.decorator';
import { AiController } from './ai.controller';
import { listAiDecisionsQuerySchema } from './ai-decision.dto';
import { updateAiSettingsSchema } from './ai-settings.dto';

const user: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 5 };

function setup(enabled: boolean) {
  const ai = { status: jest.fn().mockResolvedValue({ enabled, mode: enabled ? 2 : 0 }) };
  const queue = { add: jest.fn().mockResolvedValue({ id: '1' }) };
  const controller = new AiController(
    { getView: jest.fn(), update: jest.fn(), listMaskingRules: jest.fn() } as never,
    { list: jest.fn(), get: jest.fn(), validate: jest.fn(), reject: jest.fn() } as never,
    ai as never,
    queue as never,
  );
  return { controller, ai, queue };
}

describe('AiController', () => {
  describe('accès refusé par défaut', () => {
    it('porte MenuPermissionGuard sur le contrôleur entier', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, AiController) as unknown[];
      expect(guards).toContain(MenuPermissionGuard);
    });

    it('porte REQUIRE_ADMIN_KEY (réservé aux administrateurs) sur le contrôleur entier', () => {
      expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, AiController)).toBe(true);
    });

    it('aucune route ne lève l’exigence admin ni ne porte son propre garde plus laxiste', () => {
      const proto = AiController.prototype as unknown as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(AiController.prototype)) {
        if (name === 'constructor') continue;
        const handler = proto[name] as object;
        expect(Reflect.getMetadata(REQUIRE_ADMIN_KEY, handler)).not.toBe(false);
        expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
      }
    });
  });

  describe('POST documents/:documentId/analyze', () => {
    it('IA désactivée : 200 { disabled, message } SANS mise en file', async () => {
      const { controller, queue } = setup(false);
      await expect(controller.analyze(12, user)).resolves.toEqual({
        disabled: true,
        message: 'IA désactivée',
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('IA active : met en file un job GedAiPipelineJobData et répond { queued: true }', async () => {
      const { controller, queue } = setup(true);
      await expect(controller.analyze(12, user)).resolves.toEqual({ queued: true });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'pipeline',
        { documentId: 12, requestedBy: 5 },
        expect.any(Object),
      );
    });
  });

  it('GET status délègue à AiService.status()', async () => {
    const { controller, ai } = setup(true);
    await expect(controller.status()).resolves.toEqual({ enabled: true, mode: 2 });
    expect(ai.status).toHaveBeenCalled();
  });

  /** Récupère le pipe posé sur le paramètre nommé `key` d'une méthode du contrôleur. */
  type PipeLike = { transform(value: unknown, metadata: never): unknown };
  function pipeOf(method: string, key: string): PipeLike {
    const meta = Reflect.getMetadata(ROUTE_ARGS_METADATA, AiController, method) as Record<
      string,
      { data?: string; pipes: PipeLike[] }
    >;
    const entry = Object.values(meta).find((e) => e.data === key);
    if (!entry || entry.pipes.length === 0) throw new Error(`Aucun pipe sur ${method}:${key}`);
    return entry.pipes[0];
  }
  const meta = {} as never;

  describe('identifiants de route', () => {
    it.each([0, -1, 1.5, 'abc', '', '2147483648', 2147483648, 'NaN'])('documentId %p : 400', (value) => {
      const pipe = pipeOf('analyze', 'documentId');
      expect(() => pipe.transform(value, meta)).toThrow(BadRequestException);
    });

    it.each([
      ['1', 1],
      ['12', 12],
      ['2147483647', 2147483647],
    ])('documentId %p accepté', (v, n) => {
      expect(pipeOf('analyze', 'documentId').transform(v, meta)).toBe(n);
    });

    it.each(['getDecision', 'validate', 'reject'])('%s : id de décision invalide => 400', (m) => {
      const pipe = pipeOf(m, 'id');
      for (const bad of [0, -3, 1.5, 'abc', '']) {
        expect(() => pipe.transform(bad, meta)).toThrow(BadRequestException);
      }
      expect(pipe.transform('7', meta)).toBe(7);
    });
  });

  describe('schémas de requête', () => {
    it('le pipe de paramétrage refuse un champ inconnu (400)', () => {
      const pipe = new ZodValidationPipe(updateAiSettingsSchema);
      expect(() => pipe.transform({ mode: 1, inconnu: true })).toThrow(BadRequestException);
    });

    it('un filtre de liste vide est refusé (400)', () => {
      const pipe = new ZodValidationPipe(listAiDecisionsQuerySchema);
      expect(() => pipe.transform({ status: '' })).toThrow(BadRequestException);
    });
  });
});
