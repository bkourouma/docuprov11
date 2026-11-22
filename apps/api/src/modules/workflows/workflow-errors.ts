import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WfEngineError } from './engine/engine.types';

/**
 * Traduit une erreur du moteur en exception HTTP. Les autres erreurs (bug, base indisponible) sont
 * renvoyées telles quelles : Nest les transforme en 500 sans divulguer de détail.
 *
 * NOT_FOUND 404, FORBIDDEN 403, CONFLICT 409, INVALID_STATE 409, INVALID_INPUT 422,
 * DEFINITION_NOT_PUBLISHED 409, IDEMPOTENCY_CONFLICT 409.
 */
export function toHttpException(err: unknown): unknown {
  if (!(err instanceof WfEngineError)) return err;
  const body = { message: err.message, code: err.code, details: err.details };
  switch (err.code) {
    case 'NOT_FOUND':
      return new NotFoundException(body);
    case 'FORBIDDEN':
      return new ForbiddenException(body);
    case 'INVALID_INPUT':
      return new UnprocessableEntityException(body);
    case 'CONFLICT':
    case 'INVALID_STATE':
    case 'DEFINITION_NOT_PUBLISHED':
    case 'IDEMPOTENCY_CONFLICT':
      return new ConflictException(body);
    default:
      return new HttpException(body, 500);
  }
}

/** Exécute `fn` et relance toute erreur du moteur sous forme d'exception HTTP. */
export async function withEngineErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpException(err);
  }
}
