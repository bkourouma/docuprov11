import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileStore } from '@archivage/storage';
import { DocumentState, GedVersionChangeKind } from '@archivage/types';
import {
  EDITOR_LIMITS,
  META_KEY,
  addComment,
  decodeState,
  encodeState,
  extractMentionIds,
  htmlToYDoc,
  yDocToHtml,
} from '@archivage/editor/server';
import type { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { computeVersionHash, sha256Hex } from '../../doc-versions/domain/version-hash';
import type { DocumentsService } from '../../documents/documents.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { MAX_REGISTRY_IDS, MentionRegistryStore } from './collab-mentions-registry';
import { WorkingStateStore } from './collab-working-state';
import { CollabPersistenceService, InvalidCollabStateException } from './collab-persistence.service';

jest.mock('@archivage/editor/server', () => jest.requireActual('./editor-server.fake'));

// --- Faux Prisma en mémoire ----------------------------------------------------------------------

interface FFile {
  fileId: number;
  documentVersionId: number;
  fileTypeId: number;
  originalName: string | null;
  fileExtension: string;
  sortOrder: number;
  hash: string | null;
  byteLength: bigint;
}
interface FInfo {
  spaceId: number | null;
  contentHash: string | null;
  changeKind: number;
  changeSummary: string | null;
}
interface FVersion {
  documentVersionId: number;
  documentId: number;
  versionNumber: number;
  isCurrent: boolean;
  createdBy: number | null;
  files: FFile[];
  info: FInfo | null;
}
interface FDoc {
  documentId: number;
  label: string;
  isFrozen: boolean;
  documentState: number;
  createdBy: number | null;
  modifiedBy: number | null;
  modifiedAt: Date | null;
}
interface FGroup {
  userGroupId: number;
  userId: number;
  user: { username: string; fullName: string | null; isAdmin: boolean; isDisabled: boolean } | null;
}

class FakeDb {
  docs = new Map<number, FDoc>();
  versions: FVersion[] = [];
  spaceDocs: { spaceId: number; documentId: number; addedBy: number | null }[] = [];
  fileTypes = new Map<string, number>();
  disk = new Map<string, Buffer>();
  groups: FGroup[] = [];
  nextDocId = 1;
  nextVersionId = 100;
  nextFileId = 500;
  nextFileTypeId = 40;
  /** Nombre de violations d'unicité (P2002) à simuler à la création d'une ligne de version. */
  uniqueFailures = 0;
  /** Les écritures disque échouent à partir de la (N+1)-ième ; `null` = jamais. */
  failWritesAfter: number | null = null;
  writes = 0;

  key(fileId: number, ext: string) {
    return `${fileId}${ext}`;
  }

  /** Document non texte (une seule pièce PDF). */
  addPlainDocument(label = 'Scan') {
    const documentId = this.nextDocId++;
    this.docs.set(documentId, {
      documentId,
      label,
      isFrozen: false,
      documentState: DocumentState.Archive,
      createdBy: 11,
      modifiedBy: null,
      modifiedAt: null,
    });
    const id = this.nextVersionId++;
    this.versions.push({
      documentVersionId: id,
      documentId,
      versionNumber: 1,
      isCurrent: true,
      createdBy: 11,
      info: null,
      files: [
        {
          fileId: this.nextFileId++,
          documentVersionId: id,
          fileTypeId: 3,
          originalName: 'scan.pdf',
          fileExtension: '.pdf',
          sortOrder: 0,
          hash: null,
          byteLength: 4n,
        },
      ],
    });
    return documentId;
  }

  current(documentId: number) {
    return this.versions.find((v) => v.documentId === documentId && v.isCurrent);
  }

  fileOf(version: FVersion, ext: string) {
    return version.files.find((f) => f.fileExtension === ext)!;
  }

  prisma() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const sorted = (v: FVersion) => ({
      documentVersionId: v.documentVersionId,
      files: [...v.files].sort((a, b) => a.sortOrder - b.sortOrder || a.fileId - b.fileId),
    });
    const client: Record<string, unknown> = {
      document: {
        findUnique: jest.fn(async (args: { where: { documentId: number } }) => {
          const d = self.docs.get(args.where.documentId);
          return d ? { ...d } : null;
        }),
        create: jest.fn(async (args: { data: { label: string; createdBy: number | null } }) => {
          const documentId = self.nextDocId++;
          self.docs.set(documentId, {
            documentId,
            label: args.data.label,
            isFrozen: false,
            documentState: DocumentState.NonArchive,
            createdBy: args.data.createdBy,
            modifiedBy: null,
            modifiedAt: null,
          });
          return { documentId };
        }),
        update: jest.fn(
          async (args: {
            where: { documentId: number };
            data: { modifiedBy?: number; modifiedAt: Date };
          }) => {
            const d = self.docs.get(args.where.documentId)!;
            if (args.data.modifiedBy !== undefined) d.modifiedBy = args.data.modifiedBy;
            d.modifiedAt = args.data.modifiedAt;
            return {};
          },
        ),
        delete: jest.fn(async (args: { where: { documentId: number } }) => {
          self.docs.delete(args.where.documentId);
          self.versions = self.versions.filter((v) => v.documentId !== args.where.documentId);
          return {};
        }),
      },
      documentVersion: {
        findFirst: jest.fn(async (args: { where: { documentId: number; isCurrent: boolean } }) => {
          const v = self.versions.find(
            (x) => x.documentId === args.where.documentId && x.isCurrent === args.where.isCurrent,
          );
          return v ? sorted(v) : null;
        }),
        aggregate: jest.fn(async (args: { where: { documentId: number } }) => ({
          _max: {
            versionNumber:
              Math.max(
                0,
                ...self.versions
                  .filter((v) => v.documentId === args.where.documentId)
                  .map((v) => v.versionNumber),
              ) || null,
          },
        })),
        create: jest.fn(
          async (args: {
            data: { documentId: number; versionNumber: number; createdBy: number | null };
          }) => {
            if (self.uniqueFailures > 0) {
              self.uniqueFailures--;
              throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
            }
            const v: FVersion = {
              documentVersionId: self.nextVersionId++,
              documentId: args.data.documentId,
              versionNumber: args.data.versionNumber,
              isCurrent: false,
              createdBy: args.data.createdBy,
              files: [],
              info: null,
            };
            self.versions.push(v);
            return { documentVersionId: v.documentVersionId };
          },
        ),
        updateMany: jest.fn(
          async (args: { where: { documentId: number; isCurrent: boolean }; data: { isCurrent: boolean } }) => {
            self.versions
              .filter((v) => v.documentId === args.where.documentId && v.isCurrent === args.where.isCurrent)
              .forEach((v) => (v.isCurrent = args.data.isCurrent));
            return {};
          },
        ),
        update: jest.fn(
          async (args: { where: { documentVersionId: number }; data: { isCurrent: boolean } }) => {
            self.versions.find((v) => v.documentVersionId === args.where.documentVersionId)!.isCurrent =
              args.data.isCurrent;
            return {};
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
        create: jest.fn(async (args: { data: Omit<FFile, 'fileId'> }) => {
          const f: FFile = { ...args.data, fileId: self.nextFileId++ };
          self.versions.find((v) => v.documentVersionId === f.documentVersionId)!.files.push(f);
          return { fileId: f.fileId };
        }),
        findFirst: jest.fn(async (args: { where: { version: { documentId: number } } }) => {
          const v = self.current(args.where.version.documentId);
          const f = v?.files.find((x) => x.fileExtension === '.ydoc');
          return f ? { fileId: f.fileId } : null;
        }),
      },
      gedVersionInfo: {
        create: jest.fn(async (args: { data: FInfo & { documentVersionId: number } }) => {
          self.versions.find((v) => v.documentVersionId === args.data.documentVersionId)!.info = {
            spaceId: args.data.spaceId,
            contentHash: args.data.contentHash,
            changeKind: args.data.changeKind,
            changeSummary: args.data.changeSummary,
          };
          return {};
        }),
      },
      gedSpaceDocument: {
        create: jest.fn(
          async (args: { data: { spaceId: number; documentId: number; addedBy: number | null } }) => {
            self.spaceDocs.push(args.data);
            return {};
          },
        ),
      },
      fileType: {
        upsert: jest.fn(async (args: { where: { extension: string } }) => {
          let id = self.fileTypes.get(args.where.extension);
          if (id == null) {
            id = self.nextFileTypeId++;
            self.fileTypes.set(args.where.extension, id);
          }
          return { fileTypeId: id };
        }),
        findUniqueOrThrow: jest.fn(async (args: { where: { extension: string } }) => ({
          fileTypeId: self.fileTypes.get(args.where.extension)!,
        })),
      },
      appUserGroup: {
        findMany: jest.fn(async (args: { where: { userId: number } }) =>
          self.groups.filter((g) => g.userId === args.where.userId).map((g) => ({ userGroupId: g.userGroupId })),
        ),
        findUnique: jest.fn(async (args: { where: { userGroupId: number } }) => {
          const g = self.groups.find((x) => x.userGroupId === args.where.userGroupId);
          return g ? { userId: g.userId, user: g.user } : null;
        }),
      },
      $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(client)),
    };
    return client;
  }

  store(): FileStore {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      path: (id: number, ext: string) => self.key(id, ext),
      write: async (id: number, ext: string, data: Buffer) => {
        if (self.failWritesAfter != null && self.writes >= self.failWritesAfter) {
          throw new Error('disque plein');
        }
        self.writes++;
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

const author: AuthUser = {
  userId: 1,
  username: 'agent',
  isAdmin: false,
  userGroupId: 11,
  fullName: 'Agent Test',
};

class TestableService extends CollabPersistenceService {
  constructor(
    prisma: PrismaService,
    audit: AuditService,
    documents: DocumentsService,
    notifications: NotificationsService,
    private readonly fakeStore: FileStore,
    private readonly fakeWorking: WorkingStateStore,
    private readonly fakeMentions: MentionRegistryStore,
    wfEvents?: { emit: (event: unknown) => unknown },
  ) {
    super(prisma, audit, {} as ConfigService, documents, notifications, wfEvents as never);
  }
  protected override getStore(): FileStore {
    return this.fakeStore;
  }
  protected override getWorkingStore(): WorkingStateStore {
    return this.fakeWorking;
  }
  protected override getMentionStore(): MentionRegistryStore {
    return this.fakeMentions;
  }
}

const stateOf = (html: string): Uint8Array => {
  const doc = htmlToYDoc(html);
  const state = encodeState(doc);
  doc.destroy();
  return state;
};

/** État bien formé pour Yjs mais jugé invalide par la doublure de `validateYDocStructure`. */
const poisonedState = (html = '<p>Poison</p>'): Uint8Array => {
  const doc = htmlToYDoc(html);
  doc.getMap<boolean>('fakeInvalid').set('invalid', true);
  const state = encodeState(doc);
  doc.destroy();
  return state;
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'collab-persist-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function setup(
  opts: {
    canAccess?: (documentId: number, user: AuthUser) => boolean;
    level?: number | null;
    wfEvents?: { emit: (event: unknown) => unknown };
  } = {},
) {
  const db = new FakeDb();
  const prisma = db.prisma();
  const audit = { dataChange: jest.fn(async () => undefined) };
  const documents = {
    canAccess: jest.fn(async (documentId: number, user: AuthUser) =>
      opts.canAccess ? opts.canAccess(documentId, user) : true,
    ),
    getEffectivePermissionLevel: jest.fn(async () => (opts.level === undefined ? 3 : opts.level)),
  };
  const notifications = { createMany: jest.fn(async () => ({ count: 1 })) };
  const service = new TestableService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    documents as unknown as DocumentsService,
    notifications as unknown as NotificationsService,
    db.store(),
    new WorkingStateStore(workDir),
    new MentionRegistryStore(workDir),
    opts.wfEvents,
  );
  return { db, prisma, audit, documents, notifications, service };
}

/** Crée un document texte (v1) par le chemin de production. */
async function seedDocument(service: TestableService, html = '<p>Bonjour</p>') {
  const state = stateOf(html);
  const created = await service.createDocument({ label: 'Note', spaceId: 3, state, user: author });
  return { ...created, state };
}

// --- Tests ---------------------------------------------------------------------------------------

describe('CollabPersistenceService.createDocument', () => {
  it('crée document, rattachement à l’espace et version 1 courante avec 2 pièces', async () => {
    const { service, db, audit } = setup();
    const { documentId, state } = await seedDocument(service);

    expect(db.docs.get(documentId)).toMatchObject({ label: 'Note', createdBy: 11 });
    expect(db.spaceDocs).toEqual([{ spaceId: 3, documentId, addedBy: 11 }]);
    const v1 = db.current(documentId)!;
    expect(v1.versionNumber).toBe(1);
    expect(v1.files.map((f) => [f.fileExtension, f.sortOrder])).toEqual([
      ['.ydoc', 0],
      ['.html', 1],
    ]);
    const html = Buffer.from(yDocToHtml(decodeState(state)), 'utf8');
    expect(v1.files[0].hash).toBe(sha256Hex(Buffer.from(state)));
    expect(v1.files[1].hash).toBe(sha256Hex(html));
    expect(v1.info).toMatchObject({
      spaceId: 3,
      changeKind: GedVersionChangeKind.Creation,
      contentHash: computeVersionHash([v1.files[0].hash!, v1.files[1].hash!]),
    });
    // Binaires effectivement écrits sur le coffre.
    expect(db.disk.get(db.key(v1.files[0].fileId, '.ydoc'))).toEqual(Buffer.from(state));
    expect(db.disk.get(db.key(v1.files[1].fileId, '.html'))).toEqual(html);
    expect(audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectRef: `document:${documentId}`, newValue: 'version-created:v1' }),
    );
  });

  it('émet document.deposited (origine editeur) après la création, sans texte libre', async () => {
    const events: Record<string, unknown>[] = [];
    const { service } = setup({ wfEvents: { emit: (e) => events.push(e as Record<string, unknown>) } });
    const { documentId } = await seedDocument(service);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'document.deposited', subjectType: 'document', subjectId: String(documentId) });
    expect((events[0].fields as Record<string, unknown>).source).toBe('editeur');
    expect(JSON.stringify(events[0])).not.toContain('Note');
  });

  it('un bus dont emit lève ne casse pas la création', async () => {
    const { service } = setup({
      wfEvents: {
        emit: () => {
          throw new Error('bus en panne');
        },
      },
    });
    const created = await seedDocument(service);
    expect(created.documentId).toBeGreaterThan(0);
  });

  it('supprime le document et les binaires si l’écriture disque échoue', async () => {
    const { service, db } = setup();
    db.failWritesAfter = 1; // la 1re pièce passe, la 2e échoue
    await expect(
      service.createDocument({ label: 'Note', spaceId: 3, state: stateOf('<p>x</p>'), user: author }),
    ).rejects.toThrow('disque plein');
    expect(db.docs.size).toBe(0);
    expect(db.versions).toHaveLength(0);
    expect(db.disk.size).toBe(0);
  });

  it('pose les types de fichier .ydoc et .html une seule fois (cache)', async () => {
    const { service, db, prisma } = setup();
    await seedDocument(service);
    await service.createVersion(1, stateOf('<p>Autre</p>'), author, { reason: 'manual' });
    expect([...db.fileTypes.keys()].sort()).toEqual(['.html', '.ydoc']);
    const upsert = (prisma.fileType as { upsert: jest.Mock }).upsert;
    expect(upsert).toHaveBeenCalledTimes(2);
  });
});

describe('CollabPersistenceService.createVersion', () => {
  it('crée la version suivante : 2 pièces, empreinte SHA-256, bascule is_current, audit', async () => {
    const { service, db, audit } = setup();
    const { documentId } = await seedDocument(service);
    const next = stateOf('<p>Bonjour le monde</p>');

    const res = await service.createVersion(documentId, next, author, { reason: 'idle' });

    expect(res).toMatchObject({ versionNumber: 2 });
    const v2 = db.current(documentId)!;
    expect(v2.documentVersionId).toBe(res!.documentVersionId);
    expect(db.versions.filter((v) => v.isCurrent)).toHaveLength(1);
    const html = Buffer.from(yDocToHtml(decodeState(next)), 'utf8');
    expect(v2.files.map((f) => f.fileExtension)).toEqual(['.ydoc', '.html']);
    expect(v2.files[0].hash).toBe(sha256Hex(Buffer.from(next)));
    expect(v2.files[1].hash).toBe(sha256Hex(html));
    expect(v2.info).toMatchObject({
      changeKind: GedVersionChangeKind.Modification,
      changeSummary: 'Sauvegarde automatique',
      contentHash: computeVersionHash([sha256Hex(Buffer.from(next)), sha256Hex(html)]),
    });
    expect(v2.createdBy).toBe(11);
    expect(db.docs.get(documentId)?.modifiedBy).toBe(11);
    expect(audit.dataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ objectRef: `document:${documentId}`, newValue: 'version-created:v2' }),
    );
  });

  it.each([
    ['manual', 'Enregistrement manuel'],
    ['close', "Fermeture de l'éditeur"],
    ['idle', 'Sauvegarde automatique'],
    ['import', 'Import DOCX'],
    ['before-import', 'Avant import DOCX'],
  ] as const)('résumé français pour la raison %s', async (reason, summary) => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    await service.createVersion(documentId, stateOf(`<p>${reason}</p>`), author, { reason });
    expect(db.current(documentId)!.info?.changeSummary).toBe(summary);
  });

  it('préfère le résumé fourni', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    await service.createVersion(documentId, stateOf('<p>Autre</p>'), author, {
      reason: 'manual',
      changeSummary: '  Relecture juridique ',
    });
    expect(db.current(documentId)!.info?.changeSummary).toBe('Relecture juridique');
  });

  it('renvoie null si le contenu est identique, même avec un état binaire différent', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service, '<p>Bonjour</p>');
    // Autre session Yjs : mêmes mots, octets différents (identifiants de client aléatoires).
    const otherSession = stateOf('<p>Bonjour</p>');
    expect(Buffer.compare(Buffer.from(state), Buffer.from(otherSession))).not.toBe(0);

    const res = await service.createVersion(documentId, otherSession, author, { reason: 'close' });

    expect(res).toBeNull();
    expect(db.versions).toHaveLength(1);
  });

  it('crée une version si seuls les commentaires changent', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    const doc = decodeState(state);
    addComment(doc, {
      id: '11111111-1111-4111-8111-111111111111',
      authorUserGroupId: 11,
      authorName: 'Agent Test',
      body: 'À revoir',
      anchorText: 'Bonjour',
      mentions: [],
    });
    const withComment = encodeState(doc);

    const res = await service.createVersion(documentId, withComment, author, { reason: 'manual' });

    expect(res?.versionNumber).toBe(2);
    expect(db.versions).toHaveLength(2);
  });

  it('accepte un appel système (utilisateur null) : pas d’auteur, audit « Système »', async () => {
    const { service, db, audit } = setup();
    const { documentId } = await seedDocument(service);
    await service.createVersion(documentId, stateOf('<p>Fin</p>'), null, { reason: 'close' });
    expect(db.current(documentId)!.createdBy).toBeNull();
    expect(db.docs.get(documentId)?.modifiedBy).toBeNull();
    expect(audit.dataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ userGroupId: null, actorFullName: 'Système' }),
    );
  });

  it('réessaie une fois sur conflit de numéro, puis lève un conflit', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);

    db.uniqueFailures = 1;
    const ok = await service.createVersion(documentId, stateOf('<p>A</p>'), author, { reason: 'manual' });
    expect(ok?.versionNumber).toBe(2);

    db.uniqueFailures = 2;
    await expect(
      service.createVersion(documentId, stateOf('<p>B</p>'), author, { reason: 'manual' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(db.versions).toHaveLength(2);
    expect(db.current(documentId)!.versionNumber).toBe(2);
  });

  it('annule tout (lignes et binaires) si l’écriture disque échoue ; l’ancienne version reste courante', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    const v1 = db.current(documentId)!;
    const filesBefore = db.disk.size;
    db.failWritesAfter = db.writes + 1; // 1re pièce écrite, 2e en échec

    await expect(
      service.createVersion(documentId, stateOf('<p>Perdu</p>'), author, { reason: 'manual' }),
    ).rejects.toThrow('disque plein');

    expect(db.versions).toHaveLength(1);
    expect(db.current(documentId)).toBe(v1);
    expect(db.disk.size).toBe(filesBefore);
  });

  it('ignore un document gelé ou épuré', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    db.docs.get(documentId)!.isFrozen = true;
    expect(
      await service.createVersion(documentId, stateOf('<p>Z</p>'), author, { reason: 'idle' }),
    ).toBeNull();
    db.docs.get(documentId)!.isFrozen = false;
    db.docs.get(documentId)!.documentState = DocumentState.Epure;
    expect(
      await service.createVersion(documentId, stateOf('<p>Z</p>'), author, { reason: 'idle' }),
    ).toBeNull();
    expect(db.versions).toHaveLength(1);
  });

  it('refuse un document qui n’est pas un document texte', async () => {
    const { service, db } = setup();
    const id = db.addPlainDocument();
    await expect(
      service.createVersion(id, stateOf('<p>x</p>'), author, { reason: 'manual' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejette un état corrompu sans rien créer', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    await expect(
      service.createVersion(documentId, Uint8Array.from([255, 255, 255, 1, 2]), author, { reason: 'manual' }),
    ).rejects.toThrow();
    expect(db.versions).toHaveLength(1);
  });
});

describe('CollabPersistenceService - états invalides pour l’éditeur', () => {
  it('ne crée aucune version depuis un état invalide', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    await expect(
      service.createVersion(documentId, poisonedState(), author, { reason: 'idle' }),
    ).resolves.toBeNull();
    expect(db.versions).toHaveLength(1);
  });

  it('ne persiste pas un état de travail invalide', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    const baseId = db.current(documentId)!.documentVersionId;
    await service.saveWorkingState(documentId, poisonedState(), baseId);
    expect(await new WorkingStateStore(workDir).read(documentId)).toBeNull();
    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(state));
  });

  it('au chargement, ignore un état de travail invalide déjà présent (repli sur la version courante)', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    const baseId = db.current(documentId)!.documentVersionId;
    await new WorkingStateStore(workDir).write(documentId, poisonedState(), baseId);
    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(state));
  });

  it('signale proprement un état de version invalide (422 générique, pas d’erreur interne)', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    const file = db.fileOf(db.current(documentId)!, '.ydoc');
    const bad = Buffer.from(poisonedState());
    file.hash = sha256Hex(bad);
    db.disk.set(db.key(file.fileId, '.ydoc'), bad);
    const err = await service.loadDocument(documentId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidCollabStateException);
    expect((err as Error).message).toBe('Le contenu du document est invalide et ne peut pas être chargé');
  });
});

describe('CollabPersistenceService.assertCanModify', () => {
  it('404 sans accès, quel que soit le niveau', async () => {
    const { service } = setup({ canAccess: () => false, level: 5 });
    await expect(service.assertCanModify(1, author)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('403 sous le niveau 3', async () => {
    const { service } = setup({ level: 2 });
    await expect(service.assertCanModify(1, author)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('409 si le document est gelé ou épuré', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    db.docs.get(documentId)!.isFrozen = true;
    await expect(service.assertCanModify(documentId, author)).rejects.toBeInstanceOf(ConflictException);
    db.docs.get(documentId)!.isFrozen = false;
    db.docs.get(documentId)!.documentState = DocumentState.Epure;
    await expect(service.assertCanModify(documentId, author)).rejects.toBeInstanceOf(ConflictException);
  });

  it('passe pour un auteur de niveau 3 sur un document libre', async () => {
    const { service } = setup();
    const { documentId } = await seedDocument(service);
    await expect(service.assertCanModify(documentId, author)).resolves.toBeUndefined();
  });
});

describe('CollabPersistenceService.loadDocument et état de travail', () => {
  it('renvoie null pour un document inexistant ou non texte', async () => {
    const { service, db } = setup();
    expect(await service.loadDocument(999)).toBeNull();
    expect(await service.loadDocument(db.addPlainDocument())).toBeNull();
  });

  it('charge l’état de la pièce .ydoc de la version courante', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    const loaded = await service.loadDocument(documentId);
    expect(loaded).toMatchObject({
      documentId,
      label: 'Note',
      baseVersionId: db.current(documentId)!.documentVersionId,
    });
    expect(Buffer.from(loaded!.state!)).toEqual(Buffer.from(state));
  });

  it('utilise l’état de travail seulement si sa base est la version courante', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    const baseId = db.current(documentId)!.documentVersionId;
    const working = stateOf('<p>En cours de frappe</p>');

    await service.saveWorkingState(documentId, working, baseId);
    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(working));

    // Base périmée (une autre version est devenue courante) : l'état de travail est ignoré.
    await service.saveWorkingState(documentId, working, baseId + 1000);
    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(state));
  });

  it('suit la base de la salle après une version créée depuis son état vivant', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    const roomBase = db.current(documentId)!.documentVersionId;
    await service.createVersion(documentId, stateOf('<p>Idle</p>'), author, { reason: 'idle' });
    const later = stateOf('<p>Idle puis suite</p>');

    // La salle ignore encore la nouvelle version et sauvegarde avec son ancienne base.
    await service.saveWorkingState(documentId, later, roomBase);

    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(later));
  });

  it('discardWorkingState supprime l’état de travail', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    await service.saveWorkingState(documentId, stateOf('<p>Brouillon</p>'), db.current(documentId)!.documentVersionId);
    await service.discardWorkingState(documentId);
    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(state));
  });

  it('retombe sur la version si l’état de travail est corrompu', async () => {
    const { service, db } = setup();
    const { documentId, state } = await seedDocument(service);
    await service.saveWorkingState(
      documentId,
      Uint8Array.from([255, 255, 255, 1, 2, 3]),
      db.current(documentId)!.documentVersionId,
    );
    expect(Buffer.from((await service.loadDocument(documentId))!.state!)).toEqual(Buffer.from(state));
  });

  it('refuse un état de version corrompu', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    const file = db.fileOf(db.current(documentId)!, '.ydoc');
    file.hash = null; // sans empreinte, seul le décodage protège
    db.disk.set(db.key(file.fileId, '.ydoc'), Buffer.from([255, 255, 255, 1, 2, 3]));
    await expect(service.loadDocument(documentId)).rejects.toThrow(/corrompu/);
  });

  it('refuse un état de version altéré (empreinte différente)', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    const file = db.fileOf(db.current(documentId)!, '.ydoc');
    db.disk.set(db.key(file.fileId, '.ydoc'), Buffer.from([1, 2, 3]));
    await expect(service.loadDocument(documentId)).rejects.toThrow(/altéré/);
  });

  it('refuse un état de version trop volumineux', async () => {
    const { service, db } = setup();
    const { documentId } = await seedDocument(service);
    const file = db.fileOf(db.current(documentId)!, '.ydoc');
    file.hash = null;
    db.disk.set(db.key(file.fileId, '.ydoc'), Buffer.alloc(EDITOR_LIMITS.MAX_STATE_BYTES + 1));
    await expect(service.loadDocument(documentId)).rejects.toThrow(/trop volumineux/);
  });

  it('refuse d’autosauvegarder un état trop gros et tout identifiant hors norme (aucune traversée)', async () => {
    const { service } = setup();
    await expect(
      service.saveWorkingState(1, new Uint8Array(EDITOR_LIMITS.MAX_STATE_BYTES + 1), 1),
    ).rejects.toThrow('trop volumineux');
    await expect(
      service.saveWorkingState('../../secret' as unknown as number, Uint8Array.from([1]), 1),
    ).rejects.toThrow('Identifiant de document invalide');
    await expect(service.discardWorkingState(-5)).rejects.toThrow('Identifiant de document invalide');
  });
});

describe('CollabPersistenceService.notifyMentions', () => {
  const authorGroup: FGroup = {
    userGroupId: 11,
    userId: 1,
    user: { username: 'agent', fullName: 'Agent Test', isAdmin: false, isDisabled: false },
  };
  const withAccess: FGroup = {
    userGroupId: 20,
    userId: 200,
    user: { username: 'alice', fullName: 'Alice', isAdmin: false, isDisabled: false },
  };
  const withoutAccess: FGroup = {
    userGroupId: 30,
    userId: 300,
    user: { username: 'bob', fullName: 'Bob', isAdmin: false, isDisabled: false },
  };

  function mentionHarness(mentions: number[]) {
    const h = setup({ canAccess: (_id, user) => user.userId !== 300 });
    // Copies : un test modifie ces comptes (désactivation), ils ne doivent pas fuir d'un test à l'autre.
    h.db.groups = [authorGroup, withAccess, withoutAccess].map((g) => ({ ...g, user: g.user && { ...g.user } }));
    h.db.docs.set(1, {
      documentId: 1,
      label: 'Contrat',
      isFrozen: false,
      documentState: DocumentState.Archive,
      createdBy: 11,
      modifiedBy: null,
      modifiedAt: null,
    });
    const ydoc = htmlToYDoc('<p>Texte</p>');
    addComment(ydoc, {
      id: '22222222-2222-4222-8222-222222222222',
      authorUserGroupId: 11,
      authorName: 'Agent Test',
      body: 'Avis demandé',
      anchorText: 'Texte',
      mentions,
    });
    return { ...h, ydoc };
  }

  const notifiedIds = async (): Promise<number[]> =>
    [...(await new MentionRegistryStore(workDir).read(1)).ids].sort((a, b) => a - b);

  it('notifie uniquement les mentionnés qui ont déjà accès, ignore l’auto-mention', async () => {
    const { service, notifications, ydoc } = mentionHarness([11, 20, 30]);
    expect(extractMentionIds(ydoc)).toEqual([11, 20, 30]);

    await service.notifyMentions(1, ydoc, author);

    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    expect(notifications.createMany).toHaveBeenCalledWith(
      [20],
      'Agent Test vous a mentionné dans le document « Contrat »',
      { type: 'document', id: 1 },
    );
    // 30 (sans accès) n'est pas marqué : il pourra être notifié s'il obtient l'accès plus tard.
    expect(await notifiedIds()).toEqual([11, 20]);
  });

  it('est idempotent : une 2e passe ne renvoie rien', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    await service.notifyMentions(1, ydoc, author);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
  });

  it('ne notifie pas un mentionné sans accès (et ne lui donne aucun droit)', async () => {
    const { service, notifications, ydoc, documents } = mentionHarness([30]);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).not.toHaveBeenCalled();
    expect(documents.canAccess).toHaveBeenCalledWith(1, expect.objectContaining({ userId: 300, userGroupId: 30 }));
  });

  it('ne notifie pas un compte désactivé ou inconnu', async () => {
    const { service, notifications, ydoc, db } = mentionHarness([20, 77]);
    db.groups[1].user!.isDisabled = true;
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).not.toHaveBeenCalled();
  });

  it('capture et journalise une erreur d’envoi, puis réessaie à la passe suivante', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    notifications.createMany.mockRejectedValueOnce(new Error('base indisponible'));

    await expect(service.notifyMentions(1, ydoc, author)).resolves.toBeUndefined();
    expect(await notifiedIds()).toEqual([]);

    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(2);
    expect(await notifiedIds()).toEqual([20]);
  });

  it('n’envoie rien sans mention', async () => {
    const { service, notifications, ydoc } = mentionHarness([]);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).not.toHaveBeenCalled();
  });

  it('ignore un META_KEY forcé dans le ydoc (ni re-notification, ni silence)', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);

    // Un écrivain vide « son » registre : sans effet, le registre serveur reste la référence.
    ydoc.getMap(META_KEY).set('notifiedMentions', []);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);

    // Et le service n'écrit plus rien dans le ydoc.
    expect(ydoc.getMap(META_KEY).get('notifiedMentions')).toEqual([]);
  });

  it('ignore un registre pré-rempli dans le ydoc pour faire taire une mention', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    ydoc.getMap(META_KEY).set('notifiedMentions', [20]);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
  });

  it('ne spamme pas sur appels concurrents ou répétés', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    await Promise.all(Array.from({ length: 10 }, () => service.notifyMentions(1, ydoc, author)));
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
  });

  it('respecte opts.mentionIds (intersection avec le ydoc)', async () => {
    const { service, notifications, ydoc } = mentionHarness([20, 30]);
    // 20 est dans le ydoc mais pas demandé ; 99 est demandé mais absent du ydoc.
    await service.notifyMentions(1, ydoc, author, { mentionIds: [99] });
    expect(notifications.createMany).not.toHaveBeenCalled();
    await service.notifyMentions(1, ydoc, author, { mentionIds: [] });
    expect(notifications.createMany).not.toHaveBeenCalled();

    await service.notifyMentions(1, ydoc, author, { mentionIds: [20, 99] });
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    expect((notifications.createMany.mock.calls as unknown[][])[0][0]).toEqual([20]);
  });

  it('conserve le registre entre redémarrages (relecture du fichier)', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    await service.notifyMentions(1, ydoc, author);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);

    // « Redémarrage » : nouveau service, même répertoire d'état.
    const second = mentionHarness([20]);
    second.notifications.createMany.mockClear();
    await second.service.notifyMentions(1, second.ydoc, author);
    expect(second.notifications.createMany).not.toHaveBeenCalled();
  });

  it('tolère un fichier de registre corrompu : registre vide, sans exception', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    await writeFile(join(workDir, 'collab', '1.mentions.json'), '{pas du json').catch(async () => {
      await new MentionRegistryStore(workDir).write(1, new Set());
      await writeFile(join(workDir, 'collab', '1.mentions.json'), '{pas du json');
    });
    await expect(service.notifyMentions(1, ydoc, author)).resolves.toBeUndefined();
    // Comportement documenté : repart d'un registre vide (une re-notification est possible) puis réécrit un fichier sain.
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(workDir, 'collab', '1.mentions.json'), 'utf8')).ids).toEqual([20]);
  });

  it('traite un registre de plus de 128 Ko comme vide, sans exception', async () => {
    const { service, notifications, ydoc } = mentionHarness([20]);
    await new MentionRegistryStore(workDir).write(1, new Set());
    await writeFile(join(workDir, 'collab', '1.mentions.json'), Buffer.alloc(128 * 1024 + 1, 0x20));
    await expect(service.notifyMentions(1, ydoc, author)).resolves.toBeUndefined();
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(workDir, 'collab', '1.mentions.json'), 'utf8')).ids).toEqual([20]);
  });

  it('plafonne le nombre d’ids examinés par appel et la taille du registre', async () => {
    const full = mentionHarness([20]);
    await new MentionRegistryStore(workDir).write(
      1,
      new Set(Array.from({ length: MAX_REGISTRY_IDS }, (_, i) => 1000 + i)),
    );
    await full.service.notifyMentions(1, full.ydoc, author);
    expect(full.notifications.createMany).not.toHaveBeenCalled();
  });
});
