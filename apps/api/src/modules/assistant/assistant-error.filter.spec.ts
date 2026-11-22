import 'reflect-metadata';
import { ForbiddenException, Logger, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { z, ZodError } from 'zod';
import { ASST_ERROR_CODE_VALUES, ASST_ERROR_HTTP_STATUS } from '@archivage/types';
import { AssistantErrorFilter } from './assistant-error.filter';
import { AsstError } from './assistant.contracts';

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const host = { switchToHttp: () => ({ getResponse: () => ({ status, setHeader }) }) } as unknown as ArgumentsHost;
  new AssistantErrorFilter().catch(exception, host);
  return { status, json, setHeader, code: status.mock.calls[0]?.[0] as number, body: json.mock.calls[0]?.[0] as unknown };
}

describe('AssistantErrorFilter', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(ASST_ERROR_CODE_VALUES.map((c) => [c] as const))('AsstError(%s) : statut de ASST_ERROR_HTTP_STATUS', (code) => {
    const { code: status, body } = run(new AsstError(code, 'Message.'));
    expect(status).toBe(ASST_ERROR_HTTP_STATUS[code]);
    expect(body).toEqual({ statusCode: ASST_ERROR_HTTP_STATUS[code], errorCode: code, message: 'Message.' });
  });

  it('joint details et proposal seulement lorsqu’ils existent', () => {
    const proposal = { proposalId: '1' } as never;
    const full = run(new AsstError('effect_failed', 'Échec.', [{ a: 1 }], proposal));
    expect(full.body).toEqual({
      statusCode: 422,
      errorCode: 'effect_failed',
      message: 'Échec.',
      details: [{ a: 1 }],
      proposal: { proposalId: '1' },
    });
    const bare = run(new AsstError('not_found', 'Introuvable.')).body as Record<string, unknown>;
    expect('details' in bare).toBe(false);
    expect('proposal' in bare).toBe(false);
  });

  it('429 avec retryAfterSeconds entier >= 1 : en-tête Retry-After, corps inchangé', () => {
    const r = run(new AsstError('budget_exceeded', 'Trop.', { retryAfterSeconds: 42 }));
    expect(r.code).toBe(429);
    expect(r.setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(r.body).toEqual({ statusCode: 429, errorCode: 'budget_exceeded', message: 'Trop.', details: { retryAfterSeconds: 42 } });
  });

  it.each([[undefined], [{}], [{ retryAfterSeconds: 0 }], [{ retryAfterSeconds: 1.5 }], [{ retryAfterSeconds: '5' }], [{ retryAfterSeconds: -3 }], [[1]]])(
    '429 sans retryAfterSeconds valide (%j) : pas d’en-tête Retry-After',
    (details) => {
      const r = run(new AsstError('budget_exceeded', 'Plafond.', details));
      expect(r.code).toBe(429);
      expect(r.setHeader).not.toHaveBeenCalled();
    },
  );

  it('Retry-After uniquement sur 429', () => {
    const r = run(new AsstError('not_found', 'Non.', { retryAfterSeconds: 5 }));
    expect(r.setHeader).not.toHaveBeenCalled();
  });

  it('ZodError : 422 invalid_input avec le détail des champs', () => {
    const result = z.object({ a: z.string() }).strict().safeParse({ a: 1, b: 2 });
    if (result.success) throw new Error('attendu : échec');
    const { code, body } = run(result.error);
    expect(code).toBe(422);
    expect(body).toEqual({
      statusCode: 422,
      errorCode: 'invalid_input',
      message: 'Requête invalide.',
      details: expect.arrayContaining([expect.objectContaining({ path: 'a' })]),
    });
    expect(run(new ZodError([])).code).toBe(422);
  });

  it('HttpException (401/403/404…) : statut et corps inchangés', () => {
    const forbidden = run(new ForbiddenException('Non.'));
    expect(forbidden.code).toBe(403);
    expect(forbidden.body).toEqual(new ForbiddenException('Non.').getResponse());
    expect(run(new NotFoundException()).code).toBe(404);
  });

  it('erreur inconnue : 500 sans détail, cause journalisée', () => {
    const { code, body } = run(new Error('secret SQL : SELECT * FROM x'));
    expect(code).toBe(500);
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(Logger.prototype.error).toHaveBeenCalled();
  });

  it('errorCode inconnu porté par une AsstError : 500 sans détail', () => {
    const { code, body } = run(new AsstError('bidon' as never, 'x'));
    expect(code).toBe(500);
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('valeur levée non-Error : 500', () => {
    expect(run('boom').code).toBe(500);
  });
});
