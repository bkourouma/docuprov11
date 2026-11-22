import {
  ConflictException,
  Controller,
  Get,
  type INestApplication,
  InternalServerErrorException,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MenuPermissionGuard } from '../modules/auth/menu-permission.guard';
import { DefinitionsController } from '../modules/workflows/definitions.controller';
import { DefinitionsService } from '../modules/workflows/definitions.service';
import { AllExceptionsFilter } from './all-exceptions.filter';

const ISSUES = [
  { code: 'NO_TERMINAL_STEP', message: 'Aucune étape finale.', stepKey: 'a', path: ['steps', 0] },
  { code: 'AUTHORING_TO_COMPLETE', message: 'Affectation à compléter à l’étape « b ».', stepKey: 'b' },
];

@Controller('probe')
class ProbeController {
  @Get('simple')
  simple(): never {
    throw new ConflictException('Déjà pris.');
  }

  @Get('code')
  withCode(): never {
    throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Clé déjà utilisée.' });
  }

  @Get('issues')
  withIssues(): never {
    throw new UnprocessableEntityException({ message: 'Refusé.', code: 'AUTHORING_INVALID', issues: ISSUES });
  }

  @Get('hostile')
  hostile(): never {
    const big = Array.from({ length: 500 }, (_, i) => ({ code: `C${i}`, message: 'x'.repeat(5000), nested: { a: { b: { c: { d: { e: { f: 1 } } } } } } }));
    const proto = JSON.parse('{"code":"X","message":"m","__proto__":{"polluted":true},"constructor":{"x":1}}') as Record<string, unknown>;
    throw new UnprocessableEntityException({ message: 'Refusé.', code: 'Z'.repeat(500), issues: [...big, proto] });
  }

  @Get('server')
  server(): never {
    throw new InternalServerErrorException({ message: 'Détail interne', code: 'DB_DOWN', issues: ISSUES });
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret: stack interne');
  }

  @Post('string')
  str(): never {
    throw new ConflictException({ message: ['a', 'b'] });
  }
}

describe('AllExceptionsFilter (HTTP réel)', () => {
  let app: INestApplication;
  let definitions: { publish: jest.Mock };

  beforeAll(async () => {
    definitions = { publish: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController, DefinitionsController],
      providers: [{ provide: DefinitionsService, useValue: definitions }],
    })
      .overrideGuard(MenuPermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rétro-compatible : { code: statut numérique, message } sans champ en plus', async () => {
    const res = await request(app.getHttpServer()).get('/probe/simple').expect(409);
    expect(res.body).toEqual({ code: 409, message: 'Déjà pris.' });
  });

  it('code texte du moteur exposé dans errorCode, code reste numérique', async () => {
    const res = await request(app.getHttpServer()).get('/probe/code').expect(409);
    expect(res.body).toEqual({ code: 409, message: 'Clé déjà utilisée.', errorCode: 'IDEMPOTENCY_CONFLICT' });
  });

  it('issues conservées avec leur code texte', async () => {
    const res = await request(app.getHttpServer()).get('/probe/issues').expect(422);
    expect(res.body).toEqual({ code: 422, message: 'Refusé.', errorCode: 'AUTHORING_INVALID', issues: ISSUES });
  });

  it('message en tableau conservé tel quel', async () => {
    const res = await request(app.getHttpServer()).post('/probe/string').expect(409);
    expect(res.body).toEqual({ code: 409, message: ['a', 'b'] });
  });

  it('entrées hostiles : bornées, assainies, sans clé de prototype', async () => {
    const res = await request(app.getHttpServer()).get('/probe/hostile').expect(422);
    expect(res.body.code).toBe(422);
    expect(res.body.errorCode).toHaveLength(100);
    expect(res.body.issues.length).toBeLessThanOrEqual(200);
    expect(res.body.issues[0].message).toHaveLength(1000);
    expect(JSON.stringify(res.body)).not.toMatch(/polluted|"constructor"|__proto__/);
    expect(res.body.issues[0].nested.a.b.c.d.e).toBeNull(); // profondeur bornée
  });

  it('5xx : réponse générique, jamais de errorCode ni d’issues ni de stack', async () => {
    const a = await request(app.getHttpServer()).get('/probe/server').expect(500);
    expect(a.body.errorCode).toBeUndefined();
    expect(a.body.issues).toBeUndefined();
    const b = await request(app.getHttpServer()).get('/probe/boom').expect(500);
    expect(b.body).toEqual({ code: 500, message: 'Internal server error' });
    expect(JSON.stringify(b.body)).not.toMatch(/secret|stack/);
  });

  it('route de publication réelle : 422 avec la liste des problèmes de publication', async () => {
    definitions.publish.mockRejectedValueOnce(
      new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Le workflow ne peut pas être publié : corrigez les problèmes signalés.',
        issues: ISSUES,
      }),
    );
    const res = await request(app.getHttpServer()).post('/workflows/definitions/5/publish').expect(422);
    expect(res.body).toEqual({
      code: 422,
      message: 'Le workflow ne peut pas être publié : corrigez les problèmes signalés.',
      issues: ISSUES,
    });
  });
});
