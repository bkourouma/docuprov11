import {
  createCollabDocumentSchema,
  importCollabDocumentSchema,
  mentionCandidatesQuerySchema,
  restoreCollabVersionSchema,
  saveCollabVersionSchema,
} from './collab-documents.dto';

describe('createCollabDocumentSchema', () => {
  it('accepte un espace et un libellé, retire les espaces superflus', () => {
    expect(createCollabDocumentSchema.parse({ spaceId: 3, label: '  Note  ' })).toEqual({
      spaceId: 3,
      label: 'Note',
    });
  });

  it.each([
    [{ spaceId: 0, label: 'x' }],
    [{ spaceId: 1.5, label: 'x' }],
    [{ spaceId: 2_147_483_648, label: 'x' }],
    [{ spaceId: 3, label: '   ' }],
    [{ spaceId: 3, label: 'x'.repeat(501) }],
    [{ spaceId: 3, label: 'x', extra: true }],
  ])('refuse %j', (body) => {
    expect(createCollabDocumentSchema.safeParse(body).success).toBe(false);
  });
});

describe('importCollabDocumentSchema', () => {
  it('refuse un champ inattendu (strict)', () => {
    expect(importCollabDocumentSchema.safeParse({ spaceId: '3', extra: 'x' }).success).toBe(false);
  });

  it('convertit l’espace reçu en chaîne multipart ; libellé vide = absent', () => {
    expect(importCollabDocumentSchema.parse({ spaceId: '5', label: '' })).toEqual({
      spaceId: 5,
      label: undefined,
    });
  });

  it('refuse un espace invalide', () => {
    expect(importCollabDocumentSchema.safeParse({ spaceId: 'abc' }).success).toBe(false);
    expect(importCollabDocumentSchema.safeParse({ spaceId: '-1' }).success).toBe(false);
  });
});

describe('saveCollabVersionSchema / restoreCollabVersionSchema / mentionCandidatesQuerySchema', () => {
  it('le corps de sauvegarde est facultatif', () => {
    expect(saveCollabVersionSchema.parse(undefined)).toEqual({ changeSummary: undefined });
    expect(saveCollabVersionSchema.parse({ changeSummary: ' Relu ' })).toEqual({ changeSummary: 'Relu' });
  });

  it('la restauration exige un identifiant de version valide', () => {
    expect(restoreCollabVersionSchema.parse({ versionId: 4 }).versionId).toBe(4);
    expect(restoreCollabVersionSchema.safeParse({}).success).toBe(false);
    expect(restoreCollabVersionSchema.safeParse({ versionId: -2 }).success).toBe(false);
  });

  it('q est borné et vaut vide par défaut', () => {
    expect(mentionCandidatesQuerySchema.parse({})).toEqual({ q: '' });
    expect(mentionCandidatesQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});
