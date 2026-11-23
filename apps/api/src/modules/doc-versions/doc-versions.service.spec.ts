import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FileStore } from '@archivage/storage';
import { DocumentState, GedVersionChangeKind } from '@archivage/types';
import type { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { DocumentsService } from '../documents/documents.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DocVersionsService } from './doc-versions.service';
import { computeVersionHash, sha256Hex } from './domain/version-hash';

// --- Faux Prisma en mémoire (suffisant pour le périmètre du service) ---------------------------

interface FakeFile {
  fileId: number;
  documentVersionId: number;
  fileTypeId: number;
  originalName: string | null;
  fileExtension: string;
  byteLength: bigint | null;
  pageCount: number | null;
  sortOrder: number;
  hash: string | null;
  [k: string]: unknown;
}
interface FakeInfo {
  contentHash: string | null;
  changeKind: number;
  changeSummary: string | null;
  restoredFromVersionId: number | null;
}
interface FakeVersion {
  documentVersionId: number;
  documentId: number;
  versionNumber: number;
  isCurrent: boolean;
  isValidated: boolean;
  comment: string | null;
  createdBy: number | null;
  createdAt: Date;
  files: FakeFile[];
  gedInfo: FakeInfo | null;
}

class FakeDb {
  versions: FakeVersion[] = [];
  document = { isFrozen: false, documentState: DocumentState.Archive as number, modifiedBy: null as number | null };
  disk = new Map<string, Buffer>();
  nextVersionId = 100;
  nextFileId = 500;
  failWrites = false;
  documentUpdates = 0;

  key(fileId: number, ext: string) {
    return `${fileId}${ext}`;
  }

  addVersion(
    n: number,
    opts: { current: boolean; content: string; info?: Partial<FakeInfo> | null; hash?: boolean },
  ) {
    const id = this.nextVersionId++;
    const fileId = this.nextFileId++;
    const buf = Buffer.from(`%PDF-${opts.content}`);
    this.disk.set(this.key(fileId, '.pdf'), buf);
    this.versions.push({
      documentVersionId: id,
      documentId: 7,
      versionNumber: n,
      isCurrent: opts.current,
      isValidated: false,
      comment: null,
      createdBy: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      files: [
        {
          fileId,
          documentVersionId: id,
          fileTypeId: 3,
          originalName: `v${n}.pdf`,
          fileExtension: '.pdf',
          byteLength: BigInt(buf.length),
          pageCount: 2,
          sortOrder: 0,
          hash: opts.hash === false ? null : sha256Hex(buf),
        },
      ],
      gedInfo:
        opts.info === null
          ? null
          : {
              contentHash: sha256Hex(buf),
              changeKind: 0,
              changeSummary: null,
              restoredFromVersionId: null,
              ...opts.info,
            },
    });
    return { id, fileId, buf };
  }

  private withRelations(v: FakeVersion) {
    const restored = v.gedInfo?.restoredFromVersionId
      ? this.versions.find((x) => x.documentVersionId === v.gedInfo!.restoredFromVersionId)
      : undefined;
    return {
      ...v,
      gedInfo: v.gedInfo
        ? {
            ...v.gedInfo,
            restoredFromVersion: restored ? { versionNumber: restored.versionNumber } : null,
          }
        : null,
      createdByUser: { user: { fullName: 'Agent Test', username: 'agent' } },
    };
  }

  private match(v: FakeVersion, where: Record<string, unknown>) {
    return Object.entries(where).every(([k, val]) => (v as never)[k] === val);
  }

  prisma() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const client: { $transaction: jest.Mock; documentFile: { findFirst: jest.Mock; create: jest.Mock } } & Record<string, unknown> = {
      document: {
        findUnique: jest.fn(async () => ({ ...self.document })),
        update: jest.fn(async (args: { data: { modifiedBy: number } }) => {
          self.documentUpdates++;
          self.document.modifiedBy = args.data.modifiedBy;
          return {};
        }),
      },
      documentVersion: {
        findMany: jest.fn(async (args: { where: { documentId: number } }) =>
          self.versions
            .filter((v) => v.documentId === args.where.documentId)
            .sort((a, b) => b.versionNumber - a.versionNumber)
            .map((v) => self.withRelations(v)),
        ),
        findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
          const v = self.versions.find((x) => self.match(x, args.where));
          return v ? self.withRelations(v) : null;
        }),
        findUnique: jest.fn(async (args: { where: { documentVersionId: number } }) => {
          const v = self.versions.find(
            (x) => x.documentVersionId === args.where.documentVersionId,
          );
          return v ? self.withRelations(v) : null;
        }),
        updateMany: jest.fn(
          async (args: { where: Record<string, unknown>; data: { isCurrent: boolean } }) => {
            self.versions
              .filter((v) => self.match(v, args.where))
              .forEach((v) => (v.isCurrent = args.data.isCurrent));
            return {};
          },
        ),
        update: jest.fn(
          async (args: { where: { documentVersionId: number }; data: { isCurrent: boolean } }) => {
            const v = self.versions.find(
              (x) => x.documentVersionId === args.where.documentVersionId,
            )!;
            v.isCurrent = args.data.isCurrent;
            return v;
          },
        ),
        aggregate: jest.fn(async () => ({
          _max: { versionNumber: Math.max(0, ...self.versions.map((v) => v.versionNumber)) },
        })),
        create: jest.fn(
          async (args: {
            data: {
              documentId: number;
              versionNumber: number;
              isCurrent: boolean;
              comment: string | null;
              createdBy: number;
            };
          }) => {
            const v: FakeVersion = {
              documentVersionId: self.nextVersionId++,
              documentId: args.data.documentId,
              versionNumber: args.data.versionNumber,
              isCurrent: args.data.isCurrent,
              isValidated: false,
              comment: args.data.comment,
              createdBy: args.data.createdBy,
              createdAt: new Date('2026-02-01T00:00:00Z'),
              files: [],
              gedInfo: null,
            };
            self.versions.push(v);
            return { documentVersionId: v.documentVersionId };
          },
        ),
        delete: jest.fn(async (args: { where: { documentVersionId: number } }) => {
          self.versions = self.versions.filter(
            (v) => v.documentVersionId !== args.where.documentVersionId,
          );
          return {};
        }),
      },
      documentFile: {
        create: jest.fn(async (args: { data: Omit<FakeFile, 'fileId'> }) => {
          const f = { ...args.data, fileId: self.nextFileId++ } as FakeFile;
          self.versions.find((v) => v.documentVersionId === f.documentVersionId)!.files.push(f);
          return { fileId: f.fileId };
        }),
        findFirst: jest.fn(),
      },
      gedVersionInfo: {
        create: jest.fn(
          async (args: { data: FakeInfo & { documentVersionId: number } }) => {
            const v = self.versions.find(
              (x) => x.documentVersionId === args.data.documentVersionId,
            )!;
            v.gedInfo = {
              contentHash: args.data.contentHash,
              changeKind: args.data.changeKind,
              changeSummary: args.data.changeSummary,
              restoredFromVersionId: args.data.restoredFromVersionId,
            };
            return {};
          },
        ),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => cb(client)),
    };
    return client;
  }

  store(): FileStore {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      path: (id: number, ext: string) => self.key(id, ext),
      write: async (id: number, ext: string, data: Buffer) => {
        if (self.failWrites) throw new Error('disque plein');
        self.disk.set(self.key(id, ext), data);
        return self.key(id, ext);
      },
      read: async (id: number, ext: string) => self.disk.get(self.key(id, ext))!,
      exists: async (id: number, ext: string) => self.disk.has(self.key(id, ext)),
      remove: async (id: number, ext: string) => void self.disk.delete(self.key(id, ext)),
      createReadStream: jest.fn(),
    } as unknown as FileStore;
  }
}

// --- Harnais -------------------------------------------------------------------------------------

const user: AuthUser = {
  userId: 1,
  username: 'agent',
  isAdmin: false,
  userGroupId: 11,
  fullName: 'Agent Test',
};

class TestableService extends DocVersionsService {
  constructor(
    prisma: PrismaService,
    audit: AuditService,
    documents: DocumentsService,
    private readonly fakeStore: FileStore,
  ) {
    super(prisma, audit, {} as ConfigService, documents);
  }
  protected override getStore(): FileStore {
    return this.fakeStore;
  }
}

function setup(opts: { canAccess?: boolean; level?: number | null } = {}) {
  const db = new FakeDb();
  const prisma = db.prisma();
  const audit = { dataChange: jest.fn(async () => undefined) };
  const documents = {
    canAccess: jest.fn(async () => opts.canAccess ?? true),
    getEffectivePermissionLevel: jest.fn(async () => (opts.level === undefined ? 3 : opts.level)),
  };
  const service = new TestableService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    documents as unknown as DocumentsService,
    db.store(),
  );
  return { db, prisma, audit, documents, service };
}

const pdf = (content: string) => {
  const buffer = Buffer.from(`%PDF-${content}`);
  return { originalname: 'nouvelle.pdf', mimetype: 'application/pdf', buffer, size: buffer.length };
};

// --- Tests ---------------------------------------------------------------------------------------

describe('DocVersionsService.list', () => {
  it('refuse (404) sans accès au document', async () => {
    const { service } = setup({ canAccess: false });
    await expect(service.list(7, user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuse (404) un document inconnu même quand canAccess passe (administrateur)', async () => {
    const { service, prisma } = setup({ canAccess: true });
    (prisma.document as { findUnique: jest.Mock }).findUnique.mockResolvedValueOnce(null);
    await expect(service.list(7, user)).rejects.toThrow('Document introuvable');
  });

  it('renvoie une liste vide pour un document existant sans version', async () => {
    const { service } = setup();
    await expect(service.list(7, user)).resolves.toEqual([]);
  });

  it('trie par version décroissante et complète les versions antérieures à la GED', async () => {
    const { service, db } = setup();
    const v1 = db.addVersion(1, { current: false, content: 'a', info: null });
    db.addVersion(2, { current: true, content: 'b', info: null, hash: false });
    const rows = await service.list(7, user);

    expect(rows.map((r) => r.versionNumber)).toEqual([2, 1]);
    expect(rows[1]).toMatchObject({
      changeKind: GedVersionChangeKind.Creation,
      contentHash: sha256Hex(v1.buf),
      restoredFromVersionNumber: null,
      createdByName: 'Agent Test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(rows[0]).toMatchObject({ changeKind: GedVersionChangeKind.Modification, contentHash: null });
    expect(rows[1].files[0]).toEqual({
      fileId: v1.fileId,
      originalName: 'v1.pdf',
      fileExtension: '.pdf',
      byteLength: v1.buf.length,
      pageCount: 2,
    });
  });
});

describe('DocVersionsService.create', () => {
  it('refuse (403) sous le niveau 3', async () => {
    const { service, db } = setup({ level: 2 });
    db.addVersion(1, { current: true, content: 'a' });
    await expect(service.create(7, pdf('b'), {}, user)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuse (404) si le document est inconnu', async () => {
    const { service } = setup({ level: null });
    await expect(service.create(7, pdf('b'), {}, user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuse (409) sur un document gelé', async () => {
    const { service, db } = setup();
    db.addVersion(1, { current: true, content: 'a' });
    db.document.isFrozen = true;
    await expect(service.create(7, pdf('b'), {}, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuse (409) sur un document épuré', async () => {
    const { service, db } = setup();
    db.addVersion(1, { current: true, content: 'a' });
    db.document.documentState = DocumentState.Epure;
    await expect(service.create(7, pdf('b'), {}, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuse un fichier vide ou non PDF (400)', async () => {
    const { service, db } = setup();
    db.addVersion(1, { current: true, content: 'a' });
    await expect(service.create(7, undefined, {}, user)).rejects.toBeInstanceOf(BadRequestException);
    const notPdf = { originalname: 'x.pdf', buffer: Buffer.from('MZ....'), size: 6 };
    await expect(service.create(7, notPdf, {}, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuse (409) un contenu identique à la version courante', async () => {
    const { service, db } = setup();
    db.addVersion(1, { current: true, content: 'a' });
    await expect(service.create(7, pdf('a'), {}, user)).rejects.toThrow(
      'Contenu identique à la version courante',
    );
    expect(db.versions).toHaveLength(1);
  });

  it("calcule l'empreinte depuis le disque quand la version courante n'en a pas", async () => {
    const { service, db } = setup();
    db.addVersion(1, { current: true, content: 'a', info: null, hash: false });
    await expect(service.create(7, pdf('a'), {}, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('crée la version n+1, désactive la courante, pose version_info et audite', async () => {
    const { service, db, audit } = setup();
    const v1 = db.addVersion(1, { current: true, content: 'a' });
    const upload = pdf('b');

    const row = await service.create(7, upload, { changeSummary: 'Correction', comment: 'ok' }, user);

    expect(db.versions.find((v) => v.documentVersionId === v1.id)!.isCurrent).toBe(false);
    expect(db.versions.filter((v) => v.isCurrent)).toHaveLength(1);
    expect(row).toMatchObject({
      versionNumber: 2,
      isCurrent: true,
      comment: 'ok',
      changeKind: GedVersionChangeKind.Modification,
      changeSummary: 'Correction',
      contentHash: sha256Hex(upload.buffer),
      restoredFromVersionNumber: null,
    });
    expect(row.files).toHaveLength(1);
    const created = db.versions.find((v) => v.versionNumber === 2)!;
    expect(created.createdBy).toBe(11);
    expect(created.files[0]).toMatchObject({ fileTypeId: 3, hash: sha256Hex(upload.buffer) });
    expect(db.disk.get(db.key(created.files[0].fileId, '.pdf'))).toEqual(upload.buffer);
    expect(db.document.modifiedBy).toBe(11);
    expect(audit.dataChange).toHaveBeenCalledWith({
      userGroupId: 11,
      actorFullName: 'Agent Test',
      objectRef: 'document:7',
      newValue: 'version-created:v2',
    });
  });

  it('restauration multi-pièces : échec en cours d écriture, tous les fichiers retirés', async () => {
    const { service, db } = setup();
    const v1 = db.addVersion(1, { current: false, content: 'a' });
    const src = db.versions.find((v) => v.documentVersionId === v1.id)!;
    db.disk.set(db.key(900, '.pdf'), Buffer.from('%PDF-second'));
    src.files.push({ ...src.files[0], fileId: 900, sortOrder: 1 });
    const v2 = db.addVersion(2, { current: true, content: 'b' });
    const diskBefore = new Set(db.disk.keys());
    const store = db.store();
    let writes = 0;
    const realWrite = store.write.bind(store);
    store.write = async (id, ext, data) => {
      if (++writes === 2) throw new Error('disque plein');
      return realWrite(id, ext, data);
    };
    (service as unknown as { fakeStore: FileStore }).fakeStore = store;

    await expect(service.restore(7, v1.id, {}, user)).rejects.toThrow('disque plein');

    expect(new Set(db.disk.keys())).toEqual(diskBefore);
    expect(db.versions).toHaveLength(2);
    expect(db.versions.find((v) => v.documentVersionId === v2.id)!.isCurrent).toBe(true);
  });

  it("annule les lignes et laisse l'ancienne version courante si l'écriture disque échoue", async () => {
    const { service, db, audit } = setup();
    const v1 = db.addVersion(1, { current: true, content: 'a' });
    db.failWrites = true;

    await expect(service.create(7, pdf('b'), {}, user)).rejects.toThrow('disque plein');

    expect(db.versions).toHaveLength(1);
    expect(db.versions[0]).toMatchObject({ documentVersionId: v1.id, isCurrent: true });
    expect(db.disk.size).toBe(1);
    expect(db.documentUpdates).toBe(0);
    expect(audit.dataChange).not.toHaveBeenCalled();
  });
});

describe('DocVersionsService - accès refusé', () => {
  it('create et restore : 404 si canAccess est faux, même avec niveau >= 3, sans écriture ni audit', async () => {
    const { service, db, audit, prisma } = setup({ canAccess: false, level: 5 });
    const v1 = db.addVersion(1, { current: false, content: 'a' });
    db.addVersion(2, { current: true, content: 'b' });
    const diskBefore = new Set(db.disk.keys());

    await expect(service.create(7, pdf('c'), {}, user)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restore(7, v1.id, {}, user)).rejects.toBeInstanceOf(NotFoundException);

    expect(db.versions).toHaveLength(2);
    expect(new Set(db.disk.keys())).toEqual(diskBefore);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.documentUpdates).toBe(0);
    expect(audit.dataChange).not.toHaveBeenCalled();
  });
});

describe('DocVersionsService.restore', () => {
  it('restaure une ancienne version en NOUVELLE version, binaire copié, source intacte', async () => {
    const { service, db, audit } = setup();
    const v1 = db.addVersion(1, { current: false, content: 'a' });
    const v2 = db.addVersion(2, { current: true, content: 'b' });
    const before = structuredClone(db.versions.find((v) => v.documentVersionId === v1.id));

    const row = await service.restore(7, v1.id, { changeSummary: 'Retour arrière' }, user);

    expect(row).toMatchObject({
      versionNumber: 3,
      isCurrent: true,
      changeKind: GedVersionChangeKind.Restauration,
      changeSummary: 'Retour arrière',
      restoredFromVersionNumber: 1,
      contentHash: sha256Hex(v1.buf),
    });
    // Nouvelle ligne de fichier avec un NOUVEAU fileId, binaire dupliqué sous ce fileId.
    const created = db.versions.find((v) => v.versionNumber === 3)!;
    const newFile = created.files[0];
    expect(newFile.fileId).not.toBe(v1.fileId);
    expect(db.disk.get(db.key(newFile.fileId, '.pdf'))).toEqual(v1.buf);
    expect(created.gedInfo!.restoredFromVersionId).toBe(v1.id);
    // Historique intact : source inchangée, binaire source toujours là, ancienne courante désactivée.
    expect(db.versions.find((v) => v.documentVersionId === v1.id)).toEqual(before);
    expect(db.disk.get(db.key(v1.fileId, '.pdf'))).toEqual(v1.buf);
    expect(db.versions.find((v) => v.documentVersionId === v2.id)!.isCurrent).toBe(false);
    expect(db.versions).toHaveLength(3);
    expect(audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({
        objectRef: 'document:7',
        newValue: 'version-restored:v3from:v1',
      }),
    );
  });

  it('recalcule la empreinte de version à partir des octets copiés (plusieurs pièces)', async () => {
    const { service, db } = setup();
    const v1 = db.addVersion(1, { current: false, content: 'a' });
    const second = Buffer.from('%PDF-second');
    db.disk.set(db.key(900, '.pdf'), second);
    const src = db.versions.find((v) => v.documentVersionId === v1.id)!;
    src.files.push({ ...src.files[0], fileId: 900, sortOrder: 1, hash: 'stale' });
    db.addVersion(2, { current: true, content: 'b' });

    const row = await service.restore(7, v1.id, {}, user);
    expect(row.contentHash).toBe(computeVersionHash([sha256Hex(v1.buf), sha256Hex(second)]));
    expect(row.files).toHaveLength(2);
  });

  it('refuse la restauration de la version courante (409)', async () => {
    const { service, db } = setup();
    const v1 = db.addVersion(1, { current: true, content: 'a' });
    await expect(service.restore(7, v1.id, {}, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it("refuse (404) une version d'un autre document", async () => {
    const { service, db } = setup();
    db.addVersion(1, { current: true, content: 'a' });
    const other = db.addVersion(1, { current: false, content: 'z' });
    db.versions.find((v) => v.documentVersionId === other.id)!.documentId = 8;
    await expect(service.restore(7, other.id, {}, user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuse (403) sous le niveau 3 et (409) sur document gelé', async () => {
    const low = setup({ level: 2 });
    const a = low.db.addVersion(1, { current: false, content: 'a' });
    low.db.addVersion(2, { current: true, content: 'b' });
    await expect(low.service.restore(7, a.id, {}, user)).rejects.toBeInstanceOf(ForbiddenException);

    const frozen = setup();
    const b = frozen.db.addVersion(1, { current: false, content: 'a' });
    frozen.db.addVersion(2, { current: true, content: 'b' });
    frozen.db.document.isFrozen = true;
    await expect(frozen.service.restore(7, b.id, {}, user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('échoue proprement (409) si le binaire source manque, sans rien écrire', async () => {
    const { service, db, audit } = setup();
    const v1 = db.addVersion(1, { current: false, content: 'a' });
    db.addVersion(2, { current: true, content: 'b' });
    db.disk.delete(db.key(v1.fileId, '.pdf'));

    await expect(service.restore(7, v1.id, {}, user)).rejects.toBeInstanceOf(ConflictException);
    expect(db.versions).toHaveLength(2);
    expect(db.versions.find((v) => v.versionNumber === 2)!.isCurrent).toBe(true);
    expect(audit.dataChange).not.toHaveBeenCalled();
  });
});

describe('DocVersionsService.openFileContent', () => {
  it('refuse (404) sans accès ou si le fichier est étranger à la version', async () => {
    const denied = setup({ canAccess: false });
    await expect(denied.service.openFileContent(7, 1, 2, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const { service, prisma } = setup();
    prisma.documentFile.findFirst.mockResolvedValue(null);
    await expect(service.openFileContent(7, 1, 2, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.documentFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fileId: 2, documentVersionId: 1, version: { documentId: 7 } },
      }),
    );
  });
});
