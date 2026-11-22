import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ASST_ERROR_HTTP_STATUS, AsstErrorCode, isAsstErrorCode, type AsstErrorBodyDto } from '@archivage/types';
import { AsstError } from './assistant.contracts';

/**
 * Filtre d'erreurs de /assistant/** :
 *  - `AsstError` -> `{statusCode, errorCode, message, details?, proposal?}` au statut de `ASST_ERROR_HTTP_STATUS` ;
 *  - `ZodError` (validation hors pipe) -> 422 `invalid_input` ;
 *  - `HttpException` (401/403 du guard, etc.) -> laissée telle quelle (même réponse que le comportement par défaut) ;
 *  - toute autre erreur (y compris un `errorCode` inconnu) -> 500 sans détail, cause journalisée côté serveur.
 */
@Catch()
export class AssistantErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Assistant');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof AsstError && isAsstErrorCode(exception.errorCode)) {
      const statusCode = ASST_ERROR_HTTP_STATUS[exception.errorCode];
      const body: AsstErrorBodyDto = { statusCode, errorCode: exception.errorCode, message: exception.message };
      if (exception.details !== undefined) body.details = exception.details;
      if (exception.proposal !== undefined) body.proposal = exception.proposal;
      res.status(statusCode).json(body);
      return;
    }

    if (exception instanceof ZodError) {
      const body: AsstErrorBodyDto = {
        statusCode: ASST_ERROR_HTTP_STATUS[AsstErrorCode.InvalidInput],
        errorCode: AsstErrorCode.InvalidInput,
        message: 'Requête invalide.',
        details: exception.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
      };
      res.status(body.statusCode).json(body);
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}
