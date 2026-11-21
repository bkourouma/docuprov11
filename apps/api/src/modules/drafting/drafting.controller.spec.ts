import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import {
  GED_DRAFT_INSTRUCTION_MAX_CHARS,
  GED_DRAFT_LABEL_MAX_CHARS,
  GED_DRAFT_MAX_CONTEXT_DOCUMENTS,
} from '@archivage/types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { DraftingRateLimitGuard } from './drafting-rate-limit.guard';
import { DraftingController } from './drafting.controller';

// Le vrai éditeur serveur charge sanitize-html (ESM) : doublure de test déjà utilisée par le module collab.
jest.mock('@archivage/editor/server', () => jest.requireActual('../collab/persistence/editor-server.fake'));

type PipeLike = { transform(value: unknown, metadata: never): unknown };
const meta = {} as never;

function bodyPipe(method: string): PipeLike {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, DraftingController, method) as Record<
    string,
    { pipes: PipeLike[] }
  >;
  const entry = Object.values(args).find((e) => e.pipes.some((p) => p instanceof ZodValidationPipe));
  if (!entry) throw new Error(`Aucun ZodValidationPipe sur ${method}`);
  return entry.pipes[0];
}

const proto = DraftingController.prototype as unknown as Record<string, object>;
const valid = { templateId: 'vide', instruction: 'Rédige une note' };

describe('DraftingController : métadonnées', () => {
  it('draft : 200, limiteur de débit ; documents : 201 par défaut', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.draft)).toBe(200);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.draft)).toEqual([DraftingRateLimitGuard]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.createDocument)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.createDocument)).toBeUndefined();
  });

  it('aucune route n’est publique (JWT global)', () => {
    for (const name of ['templates', 'template', 'draft', 'createDocument']) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto[name])).toBeUndefined();
    }
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, DraftingController)).toBeUndefined();
  });

  it('délègue au service avec l’utilisateur', async () => {
    const service = {
      listTemplates: jest.fn(async () => 'liste'),
      getTemplate: jest.fn(() => 'detail'),
      generate: jest.fn(async () => 'brouillon'),
      createDocumentFromTemplate: jest.fn(async () => 'cree'),
    };
    const c = new DraftingController(service as never);
    const user = { userId: 1, username: 'a', isAdmin: false, userGroupId: 1 };
    await expect(c.templates(user)).resolves.toBe('liste');
    expect(c.template('vide', user)).toBe('detail');
    expect(service.getTemplate).toHaveBeenCalledWith('vide', user);
    await expect(c.draft(valid, user)).resolves.toBe('brouillon');
    expect(service.generate).toHaveBeenCalledWith(valid, user);
    const create = { spaceId: 1, templateId: 'vide', label: 'X' };
    await expect(c.createDocument(create, user)).resolves.toBe('cree');
    expect(service.createDocumentFromTemplate).toHaveBeenCalledWith(create, user);
  });
});

describe('DraftingController : validation de POST /drafting/draft', () => {
  const pipe = () => bodyPipe('draft');

  it('accepte une demande valide (consigne rognée)', () => {
    expect(pipe().transform({ ...valid, instruction: '  Rédige  ' }, meta)).toMatchObject({ instruction: 'Rédige' });
    expect(pipe().transform({ ...valid, contextDocumentIds: [1, 2], dossierId: 4 }, meta)).toBeTruthy();
  });

  it('refuse un champ en trop', () => {
    expect(() => pipe().transform({ ...valid, extra: 1 }, meta)).toThrow(BadRequestException);
  });

  it('refuse une consigne trop courte ou trop longue', () => {
    expect(() => pipe().transform({ ...valid, instruction: 'ab' }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...valid, instruction: '   ' }, meta)).toThrow(BadRequestException);
    expect(() =>
      pipe().transform({ ...valid, instruction: 'a'.repeat(GED_DRAFT_INSTRUCTION_MAX_CHARS + 1) }, meta),
    ).toThrow(BadRequestException);
    expect(
      pipe().transform({ ...valid, instruction: 'a'.repeat(GED_DRAFT_INSTRUCTION_MAX_CHARS) }, meta),
    ).toBeTruthy();
  });

  it('refuse plus de 5 documents de contexte et les identifiants invalides', () => {
    const ids = Array.from({ length: GED_DRAFT_MAX_CONTEXT_DOCUMENTS + 1 }, (_, i) => i + 1);
    expect(() => pipe().transform({ ...valid, contextDocumentIds: ids }, meta)).toThrow(BadRequestException);
    expect(
      pipe().transform({ ...valid, contextDocumentIds: ids.slice(0, GED_DRAFT_MAX_CONTEXT_DOCUMENTS) }, meta),
    ).toBeTruthy();
    expect(() => pipe().transform({ ...valid, contextDocumentIds: [0] }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...valid, contextDocumentIds: [1.5] }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...valid, dossierId: -1 }, meta)).toThrow(BadRequestException);
  });

  it('refuse un templateId invalide ou absent', () => {
    for (const templateId of ['Vide', '-vide', 'a b', '', '../x', 'a'.repeat(61)]) {
      expect(() => pipe().transform({ ...valid, templateId }, meta)).toThrow(BadRequestException);
    }
    expect(() => pipe().transform({ instruction: 'Rédige une note' }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...valid, templateId: 42 }, meta)).toThrow(BadRequestException);
  });
});

describe('DraftingController : validation de POST /drafting/documents', () => {
  const pipe = () => bodyPipe('createDocument');
  const ok = { spaceId: 3, templateId: 'vide', label: 'Ma note' };

  it('accepte une demande valide', () => {
    expect(pipe().transform(ok, meta)).toEqual(ok);
  });

  it('refuse champ en trop, libellé vide ou trop long, espace invalide, modèle invalide', () => {
    expect(() => pipe().transform({ ...ok, extra: 1 }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...ok, label: '  ' }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...ok, label: 'a'.repeat(GED_DRAFT_LABEL_MAX_CHARS + 1) }, meta)).toThrow(
      BadRequestException,
    );
    expect(() => pipe().transform({ ...ok, spaceId: 0 }, meta)).toThrow(BadRequestException);
    expect(() => pipe().transform({ ...ok, templateId: 'BAD ID' }, meta)).toThrow(BadRequestException);
  });
});
