import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { DocumentsService } from './documents.service';

// Le coffre disque n'intervient pas dans l'indexation.
jest.mock('@archivage/storage', () => ({ DiskFileStore: class {} }));

/**
 * `PATCH /documents/:id/indexation` (`DocumentsService.indexDocument`) : `canAccess` AVANT le
 * niveau effectif (2026-11-22). Le niveau ignore la confidentialité et les refus explicites ; seul,
 * il laissait un droit par type >= 3 indexer une pièce que son titulaire ne peut pas ouvrir.
 *
 * Base en mémoire : `canAccess` et `getEffectivePermissionLevel` tournent pour de vrai sur ces
 * lignes (les filtres Prisma utilisés — égalité, `in`, `gte`, `lte`, `OR`, `AND` — sont évalués).
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Évalue un `where` Prisma simple (ceux de `DocumentsService`) sur une ligne. */
function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; gte?: number | Date; lte?: number | Date };
      if (c.in && !c.in.includes(value)) return false;
      if (c.notIn && c.notIn.includes(value)) return false;
      if (c.gte !== undefined && (value === null || (value as number) < (c.gte as number))) return false;
      if (c.lte !== undefined && (value === null || (value as number) > (c.lte as number))) return false;
      return true;
    }
    return value === cond;
  });
}

interface Fixture {
  documents: Row[];
  userGroups: Array<{ userGroupId: number; userId: number; groupId: number }>;
  docPermissions: Row[];
  typePermissions: Row[];
  /** confidentialiteId -> rang requis */
  confidentialites: Record<number, number>;
  /** userId -> compte (rôle, rang d'habilitation) */
  users: Record<number, { roleId: number | null; rank: number | null }>;
}

function build(f: Fixture) {
  const count = (rows: Row[]) => jest.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)).length);
  const findMany = (rows: Row[]) => jest.fn(async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)));
  const tx = {
    document: { update: jest.fn(async ({ where }: { where: { documentId: number } }) => ({ documentId: where.documentId, isArchived: true })) },
    documentVersion: { updateMany: jest.fn(async () => ({ count: 1 })) },
    metaDataDocumentType: { findMany: jest.fn(async () => []) },
    documentMetadataValue: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    metaDataListItem: { findUnique: jest.fn(async () => null) },
  };
  const prisma = {
    document: {
      findUnique: jest.fn(async ({ where }: { where: { documentId: number } }) =>
        f.documents.find((d) => d.documentId === where.documentId) ?? null,
      ),
    },
    appUserGroup: {
      findMany: findMany(f.userGroups as unknown as Row[]),
      count: count(f.userGroups as unknown as Row[]),
      findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) =>
        f.userGroups.find((g) => g.userGroupId === where.userGroupId) ?? null,
      ),
    },
    documentPermission: { count: count(f.docPermissions), findMany: findMany(f.docPermissions) },
    documentTypePermission: { count: count(f.typePermissions), findMany: findMany(f.typePermissions) },
    confidentialite: {
      findUnique: jest.fn(async ({ where }: { where: { confidentialiteId: number } }) =>
        where.confidentialiteId in f.confidentialites ? { rank: f.confidentialites[where.confidentialiteId] } : null,
      ),
    },
    appUser: {
      findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => {
        const u = f.users[where.userId];
        if (!u) return null;
        return { roleId: u.roleId, confidentialite: u.rank == null ? null : { rank: u.rank } };
      }),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { dataChange: jest.fn(async () => undefined) };
  const service = new DocumentsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    {} as ConfigService,
  );
  return { service, prisma, tx, audit };
}

const SECRET_CONF = 9; // confidentialité « Secret », rang 3
const TYPE = 4;
const ROLE_ARCHIVISTE = 50;

/** L'opérateur d'acquisition (créateur du lot) et un archiviste qui tient son droit du TYPE. */
const OPERATOR: AuthUser = { userId: 1, username: 'operateur', isAdmin: false, userGroupId: 11 };
const ARCHIVIST: AuthUser = { userId: 2, username: 'archiviste', isAdmin: false, userGroupId: 22 };

/**
 * Pièce telle que la crée l'acquisition (`apps/worker/src/processors/ingestion.ts`) : non archivée,
 * `created_by` = compte-groupe du lot, droit Consultation (2) posé pour ce créateur
 * (`grantConsultation`), confidentialité du lot ou du type.
 */
function acquisitionFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    documents: [
      { documentId: 100, confidentialiteId: SECRET_CONF, createdBy: 11, documentTypeId: TYPE, isArchived: false },
    ],
    userGroups: [
      { userGroupId: 11, userId: 1, groupId: 101 },
      { userGroupId: 22, userId: 2, groupId: 102 },
    ],
    docPermissions: [{ documentId: 100, userGroupId: 11, groupId: null, permissionLevelId: 2 }],
    // L'archiviste tient « Modification » (3) sur le TYPE par son rôle.
    typePermissions: [{ documentTypeId: TYPE, userGroupId: null, roleId: ROLE_ARCHIVISTE, permissionLevelId: 3 }],
    confidentialites: { [SECRET_CONF]: 3 },
    users: {
      1: { roleId: null, rank: 1 }, // opérateur sous-habilité : seul le passe-droit du créateur joue
      2: { roleId: ROLE_ARCHIVISTE, rank: 1 }, // archiviste habilité « 1 » seulement
    },
    ...overrides,
  };
}

describe('DocumentsService.indexDocument : canAccess avant le niveau effectif', () => {
  it('droit par type >= 3 mais sous-habilité en confidentialité => 404, rien n’est écrit', async () => {
    const { service, tx, audit } = build(acquisitionFixture());
    // Témoin : sans `canAccess`, le niveau effectif seul l'aurait laissé passer.
    await expect(service.getEffectivePermissionLevel(100, ARCHIVIST)).resolves.toBe(3);
    await expect(service.canAccess(100, ARCHIVIST)).resolves.toBe(false);

    const err = await service.indexDocument(100, { validate: true }, ARCHIVIST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe('Document introuvable');
    expect(tx.document.update).not.toHaveBeenCalled();
    expect(audit.dataChange).not.toHaveBeenCalled();
  });

  it('refus explicite (Denied) en vigueur malgré un droit par type >= 3 => 404', async () => {
    const f = acquisitionFixture({
      documents: [{ documentId: 100, confidentialiteId: null, createdBy: 11, documentTypeId: TYPE }],
      docPermissions: [
        { documentId: 100, userGroupId: 11, groupId: null, permissionLevelId: 2 },
        { documentId: 100, userGroupId: 22, groupId: null, permissionLevelId: 1 },
      ],
    });
    const { service, tx } = build(f);
    await expect(service.indexDocument(100, { label: 'Pirate' }, ARCHIVIST)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.document.update).not.toHaveBeenCalled();
  });

  it('contrôle qualité de l’acquisition : l’opérateur créateur, même sous-habilité, indexe et valide', async () => {
    const { service, tx, audit } = build(acquisitionFixture());
    await expect(service.canAccess(100, OPERATOR)).resolves.toBe(true);
    await expect(service.indexDocument(100, { validate: true }, OPERATOR)).resolves.toEqual({
      documentId: 100,
      isArchived: true,
    });
    expect(tx.document.update).toHaveBeenCalledTimes(1);
    expect(tx.documentVersion.updateMany).toHaveBeenCalledTimes(1);
    expect(audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectRef: 'document:100', newValue: 'indexed+validated' }),
    );
  });

  it('archiviste habilité (rang suffisant) avec droit par type >= 3 : indexation acceptée', async () => {
    const f = acquisitionFixture();
    f.users[2] = { roleId: ROLE_ARCHIVISTE, rank: 3 };
    const { service, tx } = build(f);
    await expect(service.indexDocument(100, { label: 'Facture' }, ARCHIVIST)).resolves.toBeDefined();
    expect(tx.document.update).toHaveBeenCalledTimes(1);
  });

  it('visible mais Consultation seule => 403 inchangé (après canAccess)', async () => {
    const f = acquisitionFixture({
      documents: [{ documentId: 100, confidentialiteId: null, createdBy: 11, documentTypeId: TYPE }],
      docPermissions: [
        { documentId: 100, userGroupId: 11, groupId: null, permissionLevelId: 2 },
        { documentId: 100, userGroupId: 22, groupId: null, permissionLevelId: 2 },
      ],
      typePermissions: [],
    });
    const { service, tx } = build(f);
    const err = await service.indexDocument(100, { label: 'Pirate' }, ARCHIVIST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe('Modification non autorisée sur ce document');
    expect(tx.document.update).not.toHaveBeenCalled();
  });

  it('document inconnu => 404', async () => {
    const { service } = build(acquisitionFixture());
    await expect(service.indexDocument(999, { validate: true }, OPERATOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ordre : canAccess est consulté AVANT le niveau effectif', async () => {
    const { service } = build(acquisitionFixture());
    const access = jest.spyOn(service, 'canAccess').mockResolvedValue(false);
    const level = jest.spyOn(service, 'getEffectivePermissionLevel');
    await expect(service.indexDocument(100, { validate: true }, ARCHIVIST)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(access).toHaveBeenCalledWith(100, ARCHIVIST);
    expect(level).not.toHaveBeenCalled();
  });

  it('administrateur : passe-droit inchangé', async () => {
    const { service, tx } = build(acquisitionFixture());
    const admin: AuthUser = { userId: 3, username: 'admin', isAdmin: true, userGroupId: 33 };
    await expect(service.indexDocument(100, { validate: true }, admin)).resolves.toBeDefined();
    expect(tx.document.update).toHaveBeenCalledTimes(1);
  });
});
