import type { DocumentsService } from '../../documents/documents.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { DocumentSubjectAccessChecker } from './document-subject-access.checker';

const ACTOR = { userGroupId: 50, userId: 5 };

const actorRow = (user: Record<string, unknown> = {}) => ({
  userId: 5,
  user: { userId: 5, username: 'u', isAdmin: false, isDisabled: false, roleId: 9, role: { isActive: true }, ...user },
});

function makeCtx(actor: unknown = actorRow(), canAccess = true) {
  const prisma = {
    appUserGroup: { findUnique: jest.fn().mockResolvedValue(actor) },
    document: { findUnique: jest.fn().mockResolvedValue({ createdBy: 60 }) },
  };
  const documents = { canAccess: jest.fn().mockResolvedValue(canAccess) };
  const checker = new DocumentSubjectAccessChecker(
    prisma as unknown as PrismaService,
    documents as unknown as DocumentsService,
  );
  jest.spyOn(checker['logger'], 'warn').mockImplementation(() => undefined);
  return { prisma, documents, checker };
}

describe('DocumentSubjectAccessChecker.canAccess', () => {
  it('a le type « document »', () => {
    expect(makeCtx().checker.subjectType).toBe('document');
  });

  it.each(['abc', '0', '-3', '', '1234567890', '2.5'])('refuse un identifiant invalide (%j)', async (id) => {
    const { checker, documents } = makeCtx();
    await expect(checker.canAccess(ACTOR, id)).resolves.toBe(false);
    expect(documents.canAccess).not.toHaveBeenCalled();
  });

  it('refuse un acteur inexistant, désactivé ou incohérent', async () => {
    await expect(makeCtx(null).checker.canAccess(ACTOR, '3')).resolves.toBe(false);
    await expect(makeCtx(actorRow({ isDisabled: true })).checker.canAccess(ACTOR, '3')).resolves.toBe(false);
    await expect(makeCtx().checker.canAccess({ userGroupId: 50, userId: 99 }, '3')).resolves.toBe(false);
  });

  it('délègue à DocumentsService.canAccess avec l\'AuthUser reconstruit depuis la base', async () => {
    const { checker, documents } = makeCtx(actorRow({ isAdmin: false }));
    await expect(checker.canAccess(ACTOR, '3')).resolves.toBe(true);
    expect(documents.canAccess).toHaveBeenCalledWith(3, { userId: 5, username: 'u', isAdmin: false, userGroupId: 50 });
  });

  it('isAdmin vient de la base et non de l\'appelant', async () => {
    const { checker, documents } = makeCtx(actorRow({ isAdmin: true }));
    await checker.canAccess({ ...ACTOR, isAdmin: false } as never, '3');
    expect(documents.canAccess.mock.calls[0][1].isAdmin).toBe(true);
    const other = makeCtx(actorRow({ isAdmin: false }));
    await other.checker.canAccess({ ...ACTOR, isAdmin: true } as never, '3');
    expect(other.documents.canAccess.mock.calls[0][1].isAdmin).toBe(false);
  });

  it('refuse si canAccess est faux', async () => {
    const { checker } = makeCtx(actorRow(), false);
    await expect(checker.canAccess(ACTOR, '3')).resolves.toBe(false);
  });

  it('une exception interne donne un refus', async () => {
    const { checker, documents } = makeCtx();
    documents.canAccess.mockRejectedValue(new Error('boom'));
    await expect(checker.canAccess(ACTOR, '3')).resolves.toBe(false);
  });
});

describe('DocumentSubjectAccessChecker.resolveOwner', () => {
  it('renvoie le créateur si son compte est actif', async () => {
    const { checker, prisma } = makeCtx();
    prisma.appUserGroup.findUnique.mockResolvedValue({ user: { isDisabled: false } });
    await expect(checker.resolveOwner('3')).resolves.toBe(60);
  });

  it('renvoie null si le compte est désactivé, absent, ou sans créateur', async () => {
    const a = makeCtx();
    a.prisma.appUserGroup.findUnique.mockResolvedValue({ user: { isDisabled: true } });
    await expect(a.checker.resolveOwner('3')).resolves.toBeNull();
    const b = makeCtx();
    b.prisma.document.findUnique.mockResolvedValue(null);
    await expect(b.checker.resolveOwner('3')).resolves.toBeNull();
    const c = makeCtx();
    c.prisma.document.findUnique.mockResolvedValue({ createdBy: null });
    await expect(c.checker.resolveOwner('3')).resolves.toBeNull();
    await expect(makeCtx().checker.resolveOwner('abc')).resolves.toBeNull();
  });

  it('renvoie null sur exception interne', async () => {
    const { checker, prisma } = makeCtx();
    prisma.document.findUnique.mockRejectedValue(new Error('boom'));
    await expect(checker.resolveOwner('3')).resolves.toBeNull();
  });
});
