import type { ConfigService } from '@nestjs/config';
import { DocumentState } from '@archivage/types';
import { sign, type SignOptions } from 'jsonwebtoken';
import type { AuthUser } from '../../auth/auth.types';
import type { DocumentsService } from '../../documents/documents.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { CollabAccessService, CollabAuthError } from './collab-access.service';

// Clé de TEST uniquement (aucun secret réel).
const SECRET = 'cle-de-test-collab-0123456789abcdef';

function token(payload: Record<string, unknown>, opts: SignOptions = { expiresIn: '1h' }) {
  return sign(payload, SECRET, opts);
}

const PAYLOAD = { sub: 7, username: 'alice', isAdmin: false, userGroupId: 70, fullName: 'Alice Martin' };
const ALICE: AuthUser = { userId: 7, username: 'alice', isAdmin: false, userGroupId: 70, fullName: 'Alice' };

interface FakeDoc {
  canAccess: boolean;
  level: number | null;
  isFrozen: boolean;
  documentState: number;
}

function setup(doc: FakeDoc | null) {
  const calls: string[] = [];
  const documents = {
    canAccess: jest.fn(async () => {
      calls.push('canAccess');
      return doc?.canAccess ?? false;
    }),
    getEffectivePermissionLevel: jest.fn(async () => {
      calls.push('level');
      return doc ? doc.level : null;
    }),
  };
  const prisma = {
    document: {
      findUnique: jest.fn(async () =>
        doc ? { isFrozen: doc.isFrozen, documentState: doc.documentState } : null,
      ),
    },
  };
  const config = { getOrThrow: () => SECRET } as unknown as ConfigService;
  const service = new CollabAccessService(
    documents as unknown as DocumentsService,
    prisma as unknown as PrismaService,
    config,
  );
  return { service, documents, prisma, calls };
}

const base: FakeDoc = {
  canAccess: true,
  level: 3,
  isFrozen: false,
  documentState: DocumentState.Archive,
};

describe('CollabAccessService.verifyToken', () => {
  const { service } = setup(base);

  it('accepte un JWT valide et le projette comme JwtStrategy', async () => {
    const verified = service.verifyToken(token(PAYLOAD));
    expect(verified.user).toEqual({
      userId: 7,
      username: 'alice',
      isAdmin: false,
      userGroupId: 70,
      fullName: 'Alice Martin',
    });
    expect(verified.expiresAt).toBeGreaterThan(Date.now());
    await expect(service.authenticate(token(PAYLOAD))).resolves.toMatchObject({ userId: 7 });
  });

  it('ne pose jamais isScanAgent depuis un JWT', () => {
    const verified = service.verifyToken(token({ ...PAYLOAD, isScanAgent: true }));
    expect(verified.user.isScanAgent).toBeUndefined();
  });

  it.each([
    ['absent', ''],
    ['non chaîne', 42],
    ['malformé', 'pas.un.jwt'],
    ['trop long', 'a'.repeat(9000)],
    ['autre secret', sign(PAYLOAD, 'autre-cle-de-test-0123456789abcdef', { expiresIn: '1h' })],
    ['expiré', token({ ...PAYLOAD, exp: Math.floor(Date.now() / 1000) - 10 }, {})],
    ['sans exp', token(PAYLOAD, {})],
    ['algorithme HS512', sign(PAYLOAD, SECRET, { algorithm: 'HS512', expiresIn: '1h' })],
    ['algorithme none', sign(PAYLOAD, '', { algorithm: 'none', expiresIn: '1h' } as never)],
    ['sub manquant', token({ ...PAYLOAD, sub: undefined })],
    ['sub texte', token({ ...PAYLOAD, sub: '7' })],
    ['userGroupId texte', token({ ...PAYLOAD, userGroupId: '70' })],
  ])('refuse un jeton %s', async (_label, raw) => {
    expect(() => service.verifyToken(raw)).toThrow(CollabAuthError);
    await expect(service.authenticate(raw as string)).rejects.toBeInstanceOf(CollabAuthError);
  });

  it('ne divulgue aucun détail dans l’erreur', () => {
    try {
      service.verifyToken(token({ ...PAYLOAD, exp: 1 }, {}));
      throw new Error('aurait dû échouer');
    } catch (error) {
      expect((error as Error).message).toBe('Jeton invalide');
    }
  });
});

describe('CollabAccessService.resolveMode', () => {
  it('niveau >= 3 => écriture', async () => {
    const { service } = setup(base);
    await expect(service.resolveMode(5, ALICE)).resolves.toBe('write');
  });

  it('niveau 2 (Consultation) => lecture seule', async () => {
    const { service } = setup({ ...base, level: 2 });
    await expect(service.resolveMode(5, ALICE)).resolves.toBe('read');
  });

  it('document gelé => lecture seule même au niveau 5', async () => {
    const { service } = setup({ ...base, level: 5, isFrozen: true });
    await expect(service.resolveMode(5, ALICE)).resolves.toBe('read');
  });

  it('document épuré => lecture seule', async () => {
    const { service } = setup({ ...base, documentState: DocumentState.Epure });
    await expect(service.resolveMode(5, ALICE)).resolves.toBe('read');
  });

  it('canAccess faux => refus, et le niveau n’est même pas consulté (canAccess prioritaire)', async () => {
    const { service, calls } = setup({ ...base, canAccess: false, level: 5 });
    await expect(service.resolveMode(5, ALICE)).resolves.toBeNull();
    expect(calls).toEqual(['canAccess']);
  });

  it('document inconnu => refus', async () => {
    const { service } = setup(null);
    await expect(service.resolveMode(5, ALICE)).resolves.toBeNull();
  });

  it('niveau introuvable (document disparu entre-temps) => refus', async () => {
    const { service } = setup({ ...base, level: null });
    await expect(service.resolveMode(5, ALICE)).resolves.toBeNull();
  });

  it('identité machine (agent de numérisation) => refus', async () => {
    const { service, calls } = setup(base);
    await expect(service.resolveMode(5, { ...ALICE, isScanAgent: true })).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('id %p invalide => refus sans requête', async (id) => {
    const { service, calls } = setup(base);
    await expect(service.resolveMode(id, ALICE)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
