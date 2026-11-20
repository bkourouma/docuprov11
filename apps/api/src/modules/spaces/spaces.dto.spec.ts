import {
  addMemberSchema,
  attachDocumentSchema,
  createSpaceSchema,
  listDocumentsQuerySchema,
  publishSpaceSchema,
  updateSpaceSchema,
} from './spaces.dto';

describe('spaces.dto', () => {
  it('création : kind 0..2 seulement, champs inconnus refusés', () => {
    expect(createSpaceSchema.safeParse({ label: 'A', kind: 1 }).success).toBe(true);
    expect(createSpaceSchema.safeParse({ label: 'A', kind: 3 }).success).toBe(false);
    expect(createSpaceSchema.safeParse({ label: 'A', kind: 1, ownerUserGroupId: 1 }).success).toBe(
      false,
    );
    expect(createSpaceSchema.safeParse({ label: ' ', kind: 1 }).success).toBe(false);
    expect(createSpaceSchema.safeParse({ label: 'x'.repeat(201), kind: 1 }).success).toBe(false);
    expect(
      createSpaceSchema.safeParse({ label: 'A', kind: 1, description: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('modification : ni kind 3 ni slug', () => {
    expect(updateSpaceSchema.safeParse({ kind: 3 }).success).toBe(false);
    expect(updateSpaceSchema.safeParse({ publicationSlug: 'abc' }).success).toBe(false);
    expect(updateSpaceSchema.safeParse({}).success).toBe(false);
    const parsed = updateSpaceSchema.parse({ description: '' });
    expect(parsed.description).toBeNull();
  });

  it('membre : exactement un bénéficiaire', () => {
    expect(addMemberSchema.safeParse({ userGroupId: 1, permission: 0 }).success).toBe(true);
    expect(addMemberSchema.safeParse({ roleId: 1, permission: 2 }).success).toBe(true);
    expect(addMemberSchema.safeParse({ userGroupId: 1, roleId: 1, permission: 0 }).success).toBe(
      false,
    );
    expect(addMemberSchema.safeParse({ permission: 0 }).success).toBe(false);
    expect(addMemberSchema.safeParse({ userGroupId: 1, permission: 3 }).success).toBe(false);
  });

  it('document et publication', () => {
    expect(attachDocumentSchema.safeParse({ documentId: 0 }).success).toBe(false);
    expect(publishSpaceSchema.safeParse(undefined).success).toBe(true);
    expect(publishSpaceSchema.safeParse({ slug: 'rapport-2026' }).success).toBe(true);
    expect(publishSpaceSchema.safeParse({ slug: 'Rapport 2026' }).success).toBe(false);
    expect(publishSpaceSchema.safeParse({ slug: 'ab' }).success).toBe(false);
  });

  it('pagination des documents : défauts 100/0, bornes 1..200, offset ≥ 0, chaînes converties', () => {
    expect(listDocumentsQuerySchema.parse({})).toEqual({ limit: 100, offset: 0 });
    expect(listDocumentsQuerySchema.parse({ limit: '20', offset: '40' })).toEqual({
      limit: 20,
      offset: 40,
    });
    expect(listDocumentsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listDocumentsQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(listDocumentsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
    expect(listDocumentsQuerySchema.safeParse({ limit: '2.5' }).success).toBe(false);
    expect(listDocumentsQuerySchema.safeParse({ page: '1' }).success).toBe(false);
  });
});
