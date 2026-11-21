import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WfEngineError, type WfEngineErrorCode } from './engine/engine.types';
import { toHttpException, withEngineErrors } from './workflow-errors';

describe('workflow-errors', () => {
  const cases: Array<[WfEngineErrorCode, new (...a: never[]) => Error, number]> = [
    ['NOT_FOUND', NotFoundException, 404],
    ['FORBIDDEN', ForbiddenException, 403],
    ['CONFLICT', ConflictException, 409],
    ['INVALID_STATE', ConflictException, 409],
    ['INVALID_INPUT', UnprocessableEntityException, 422],
    ['DEFINITION_NOT_PUBLISHED', ConflictException, 409],
    ['IDEMPOTENCY_CONFLICT', ConflictException, 409],
  ];

  it.each(cases)('%s -> %s (%d)', (code, ctor, status) => {
    const out = toHttpException(new WfEngineError(code, 'msg', { x: 1 })) as Error & {
      getStatus(): number;
      getResponse(): { code: string; message: string; details: unknown };
    };
    expect(out).toBeInstanceOf(ctor);
    expect(out.getStatus()).toBe(status);
    expect(out.getResponse()).toMatchObject({ code, message: 'msg', details: { x: 1 } });
  });

  it('propage telles quelles les erreurs inconnues', async () => {
    const boom = new Error('base indisponible');
    expect(toHttpException(boom)).toBe(boom);
    await expect(withEngineErrors(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('withEngineErrors traduit une erreur du moteur et renvoie la valeur sinon', async () => {
    await expect(withEngineErrors(async () => 7)).resolves.toBe(7);
    await expect(
      withEngineErrors(() => Promise.reject(new WfEngineError('NOT_FOUND', 'absent'))),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
