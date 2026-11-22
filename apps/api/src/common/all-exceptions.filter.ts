import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface MinimalResponse {
  status(code: number): { json(body: unknown): void };
}

const ERROR_CODE_MAX = 100;
const ISSUES_MAX = 200;
const JSON_MAX_DEPTH = 6;
const JSON_MAX_KEYS = 30;
const JSON_STRING_MAX = 1000;

/** Copie JSON simple et bornée (profondeur, clés, chaînes) ; jamais d'objet interne ni de clé de prototype. */
function plainJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > JSON_STRING_MAX ? value.slice(0, JSON_STRING_MAX) : value;
  if (depth >= JSON_MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, ISSUES_MAX).map((v) => plainJson(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const key of Object.keys(value as object)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (n++ >= JSON_MAX_KEYS) break;
      out[key] = plainJson((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return undefined; // fonction, symbole, bigint : ignorés
}

/**
 * Champs ADDITIFS d'une réponse d'erreur 4xx : `errorCode` (code texte du moteur, ex. IDEMPOTENCY_CONFLICT) et
 * `issues` (liste de problèmes, ex. publication refusée), quand le corps de l'exception les porte. `code` (numérique)
 * et `message` restent inchangés. Jamais pour un 5xx (réponse générique).
 */
function additiveFields(body: unknown): { errorCode?: string; issues?: unknown[] } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  const payload = body as { code?: unknown; issues?: unknown };
  const extra: { errorCode?: string; issues?: unknown[] } = {};
  if (typeof payload.code === 'string' && payload.code.length > 0) {
    extra.errorCode = payload.code.slice(0, ERROR_CODE_MAX);
  }
  if (Array.isArray(payload.issues)) {
    extra.issues = payload.issues.slice(0, ISSUES_MAX).map((i) => plainJson(i)).filter((i) => i !== undefined);
  }
  return extra;
}

/**
 * Converts any thrown error into the { code, message } shape (see contracts/openapi.yaml), plus the optional
 * `errorCode` / `issues` fields when a 4xx exception carries them.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: unknown = 'Internal server error';
    let extra: { errorCode?: string; issues?: unknown[] } = {};
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? body);
      if (status < HttpStatus.INTERNAL_SERVER_ERROR) extra = additiveFields(body);
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception);
    }

    response.status(status).json({ code: status, message, ...extra });
  }
}
