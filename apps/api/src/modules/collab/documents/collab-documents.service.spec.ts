import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentState, GedSpaceKind, GedSpacePermission } from '@archivage/types';
import * as editor from '@archivage/editor/server';
import type { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import type { DocVersionsService } from '../../doc-versions/doc-versions.service';
import type { DocumentsService } from '../../documents/documents.service';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  InvalidCollabStateException,
  type CollabPersistenceService,
} from '../persistence/collab-persistence.service';
import type { CollabServerService } from '../server/collab-server.service';
import { MAX_DOCUMENT_LABEL, MAX_DOCX_UPLOAD_BYTES } from './collab-documents.dto';
import {
  CollabDocumentsService,
  buildContentDisposition,
  escapeLikePattern,
  type UploadedDocxFile,
} from './collab-documents.service';

jest.mock('@archivage/editor/server', () => jest.requireActual('../persistence/editor-server.fake'));

// --- Harnais -------------------------------------------------------------------------------------

const user: AuthUser = {
  userId: 1,
  username: 'agent',
  isAdmin: false,
  userGroupId: 11,
  fullName: 'Agent Test',
};

const stateOf = (html: string): Uint8Array => {
  const doc = editor.htmlToYDoc(html);
  const state = editor.encodeState(doc);
  doc.destroy();
  return state;
};

const docx = (over: Partial<UploadedDocxFile> = {}): UploadedDocxFile => {
  const buffer = over.buffer ?? Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('reste')]);
  return { originalname: 'Contrat final.docx', buffer, size: buffer.length, ...over };
};

interface SpaceFacts {
  kind: number;
  isActive?: boolean;
  ownerUserGroupId?: number;
  members?: { userGroupId: number | null; roleId: number | null; permission: number }[];
}

function setup(
  opts: {
    canAccess?: boolean;
    isText?: boolean;
    level?: number | null;
    space?: SpaceFacts | null;
    doc?: { label: string; isFrozen: boolean; documentState: number };
  } = {},
) {
  const prisma = {
    gedSpace: {
      findUnique: jest.fn(async () =>
        opts.space === null
          ? null
          : {
              isActive: true,
              ownerUserGroupId: 999,
              members: [],
              ...(opts.space ?? { kind: GedSpaceKind.Collaboration }),
            },
      ),
    },
    appUserGroup: { findMany: jest.fn(async () => [{ userGroupId: 11 }]) },
    appUser: {
      findUnique: jest.fn(async () => ({ isDisabled: false, roleId: null, role: null })),
    },
    document: {
      findUnique: jest.fn(async () => opts.doc ?? { label: 'Contrat', isFrozen: false, documentState: DocumentState.Archive }),
    },
    documentVersion: {
      findFirst: jest.fn(async (args: { where: { documentVersionId?: number; isCurrent?: boolean } }) =>
        args.where.isCurrent
          ? { versionNumber: 4, documentVersionId: 40 }
          : { files: [{ fileExtension: '.ydoc' }, { fileExtension: '.html' }] },
      ),
    },
    $queryRaw: jest.fn(async (..._args: unknown[]) => [] as unknown[]),
  };
  const audit = { dataChange: jest.fn(async () => undefined) };
  const documents = {
    canAccess: jest.fn(async () => opts.canAccess ?? true),
    getEffectivePermissionLevel: jest.fn(async () => (opts.level === undefined ? 3 : opts.level)),
  };
  const versionRow = { documentVersionId: 41, versionNumber: 5, isCurrent: true };
  const versions = {
    restore: jest.fn(async () => versionRow),
    list: jest.fn(async () => [versionRow, { documentVersionId: 40, versionNumber: 4, isCurrent: false }]),
  };
  const persistence = {
    isCollabDocument: jest.fn(async () => opts.isText ?? true),
    assertCanModify: jest.fn(async () => undefined),
    createVersion: jest.fn(async (..._args: unknown[]) => ({ documentVersionId: 41, versionNumber: 5 }) as unknown),
    createDocument: jest.fn(async (..._args: unknown[]) => ({ documentId: 77, documentVersionId: 700 })),
    loadDocument: jest.fn(async () => ({
      documentId: 7,
      label: 'Contrat',
      state: stateOf('<p>Persistant</p>'),
      baseVersionId: 40,
    })),
    discardWorkingState: jest.fn(async () => undefined),
    saveWorkingState: jest.fn(async () => undefined),
  };
  const collab = {
    getLiveState: jest.fn((): Uint8Array | null => null),
    mutateDocument: jest.fn(async () => undefined),
    resetRoom: jest.fn(async () => undefined),
  };
  const service = new CollabDocumentsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    documents as unknown as DocumentsService,
    versions as unknown as DocVersionsService,
    persistence as unknown as CollabPersistenceService,
    collab as unknown as CollabServerService,
  );
  return { prisma, audit, documents, versions, persistence, collab, versionRow, service };
}

type Harness = ReturnType<typeof setup>;

/** Toutes les routes `:id` : la même réponse 404 avant tout autre contrôle. */
const idRoutes: [string, (h: Harness, id: number, u: AuthUser) => Promise<unknown>][] = [
  ['session', (h, id, u) => h.service.getSession(id, u)],
  ['versions', (h, id, u) => h.service.saveVersion(id, {}, u)],
  ['restore', (h, id, u) => h.service.restore(id, { versionId: 40 }, u)],
  ['export.docx', (h, id, u) => h.service.exportDocx(id, u)],
  ['import', (h, id, u) => h.service.importIntoDocument(id, docx(), u)],
  ['mention-candidates', (h, id, u) => h.service.mentionCandidates(id, 'ali', u)],
];

// --- 404 uniforme --------------------------------------------------------------------------------

describe.each(idRoutes)('route %s : 404 uniforme', (_name, call) => {
  it('document inaccessible : 404 avant tout autre contrôle', async () => {
    const h = setup({ canAccess: false, level: 1 });
    const err = await call(h, 7, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe('Document introuvable');
    expect(h.persistence.assertCanModify).not.toHaveBeenCalled();
    expect(h.documents.getEffectivePermissionLevel).not.toHaveBeenCalled();
    expect(h.persistence.isCollabDocument).not.toHaveBeenCalled();
    expect(h.versions.restore).not.toHaveBeenCalled();
  });

  it('document non texte : même 404', async () => {
    const h = setup({ isText: false });
    const err = await call(h, 7, user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe('Document introuvable');
    expect(h.persistence.assertCanModify).not.toHaveBeenCalled();
  });

  it('identité du scan-agent : même 404, sans même interroger les droits', async () => {
    const h = setup();
    const err = await call(h, 7, { ...user, userId: 0, userGroupId: null, isScanAgent: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(h.documents.canAccess).not.toHaveBeenCalled();
  });

  it.each([0, -3, 2_147_483_648, 1.5])('identifiant hors norme %p : même 404', async (id) => {
    const h = setup();
    await expect(call(h, id, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.documents.canAccess).not.toHaveBeenCalled();
  });
});

// --- Session -------------------------------------------------------------------------------------

describe('getSession', () => {
  it('niveau >= 3 : mode write, identité d’édition issue du jeton', async () => {
    const { service } = setup({ level: 3 });
    expect(await service.getSession(7, user)).toEqual({
      documentId: 7,
      label: 'Contrat',
      mode: 'write',
      wsPath: '/api/collab',
      currentVersionNumber: 4,
      me: { userGroupId: 11, name: 'Agent Test' },
    });
  });

  it('niveau < 3 : lecture seule', async () => {
    const { service } = setup({ level: 2 });
    expect((await service.getSession(7, user)).mode).toBe('read');
  });

  it.each([
    ['gelé', { label: 'C', isFrozen: true, documentState: DocumentState.Archive }],
    ['épuré', { label: 'C', isFrozen: false, documentState: DocumentState.Epure }],
  ])('document %s : lecture seule même avec le niveau 5', async (_n, doc) => {
    const { service } = setup({ level: 5, doc });
    expect((await service.getSession(7, user)).mode).toBe('read');
  });

  it('refuse un compte sans profil actif (pas d’identité d’édition)', async () => {
    const { service } = setup();
    await expect(service.getSession(7, { ...user, userGroupId: null })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// --- Versions / restauration ---------------------------------------------------------------------

describe('saveVersion', () => {
  it('403 propagé quand le niveau est insuffisant, rien n’est créé', async () => {
    const h = setup();
    h.persistence.assertCanModify.mockRejectedValueOnce(new ForbiddenException('Modification non autorisée sur ce document'));
    await expect(h.service.saveVersion(7, {}, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.persistence.createVersion).not.toHaveBeenCalled();
  });

  it('utilise l’état vivant de la salle quand elle est ouverte', async () => {
    const h = setup();
    const live = stateOf('<p>Vivant</p>');
    h.collab.getLiveState.mockReturnValue(live);
    const res = await h.service.saveVersion(7, { changeSummary: 'Relu' }, user);
    expect(h.persistence.createVersion).toHaveBeenCalledWith(7, live, user, {
      reason: 'manual',
      changeSummary: 'Relu',
    });
    expect(h.persistence.loadDocument).not.toHaveBeenCalled();
    expect(res).toEqual({ created: true, version: h.versionRow });
  });

  it('sinon l’état persistant ; created=false si le contenu est identique', async () => {
    const h = setup();
    h.persistence.createVersion.mockResolvedValueOnce(null);
    const res = await h.service.saveVersion(7, {}, user);
    expect(h.persistence.loadDocument).toHaveBeenCalledWith(7);
    expect(res).toEqual({ created: false, version: null });
  });
});

describe('restore', () => {
  it('restaure via DocVersionsService, puis supprime l’état de travail et réinitialise la salle', async () => {
    const h = setup();
    const row = await h.service.restore(7, { versionId: 40, changeSummary: 'Retour arrière' }, user);
    expect(h.versions.restore).toHaveBeenCalledWith(7, 40, { changeSummary: 'Retour arrière' }, user);
    expect(h.persistence.discardWorkingState).toHaveBeenCalledWith(7);
    expect(h.collab.resetRoom).toHaveBeenCalledWith(7);
    expect(row).toBe(h.versionRow);
    // Ordre : figer l'existant, réinitialiser la salle, restaurer, puis supprimer l'état de travail.
    const order = [
      h.persistence.createVersion.mock.invocationCallOrder[0],
      h.collab.resetRoom.mock.invocationCallOrder[0],
      h.versions.restore.mock.invocationCallOrder[0],
      h.persistence.discardWorkingState.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h.persistence.createVersion).toHaveBeenCalledWith(7, expect.anything(), user, {
      reason: 'manual',
      changeSummary: 'Avant restauration',
    });
  });

  it('restaure même si « Avant restauration » échoue (état persisté empoisonné)', async () => {
    const h = setup();
    h.persistence.loadDocument.mockRejectedValueOnce(new Error('contenu invalide'));
    const row = await h.service.restore(7, { versionId: 40 }, user);
    expect(row).toBe(h.versionRow);
    expect(h.collab.resetRoom).toHaveBeenCalledWith(7);
    expect(h.versions.restore).toHaveBeenCalled();
    expect(h.persistence.discardWorkingState).toHaveBeenCalledWith(7);
  });

  it('restaure même si la création de la version de sauvegarde jette', async () => {
    const h = setup();
    h.persistence.createVersion.mockRejectedValueOnce(new Error('Method unimplemented'));
    await expect(h.service.restore(7, { versionId: 40 }, user)).resolves.toBe(h.versionRow);
    expect(h.versions.restore).toHaveBeenCalled();
  });

  it('403 : rien n’est restauré', async () => {
    const h = setup();
    h.persistence.assertCanModify.mockRejectedValueOnce(new ForbiddenException('Modification non autorisée sur ce document'));
    await expect(h.service.restore(7, { versionId: 40 }, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.versions.restore).not.toHaveBeenCalled();
    expect(h.collab.resetRoom).not.toHaveBeenCalled();
  });

  it('404 sur une version inconnue du document ; 409 sur une version sans état texte', async () => {
    const h = setup();
    h.prisma.documentVersion.findFirst.mockResolvedValueOnce(null as never);
    await expect(h.service.restore(7, { versionId: 999 }, user)).rejects.toThrow('Version introuvable');

    h.prisma.documentVersion.findFirst.mockResolvedValueOnce({ files: [{ fileExtension: '.pdf' }] } as never);
    await expect(h.service.restore(7, { versionId: 5 }, user)).rejects.toBeInstanceOf(ConflictException);
    expect(h.versions.restore).not.toHaveBeenCalled();
  });

  it('un échec de suppression de l’état de travail n’annule pas la restauration acquise', async () => {
    const h = setup();
    h.persistence.discardWorkingState.mockRejectedValueOnce(new Error('disque'));
    await expect(h.service.restore(7, { versionId: 40 }, user)).resolves.toBe(h.versionRow);
  });

  it('salle impossible à réinitialiser : 409, rien n’est restauré', async () => {
    const h = setup();
    h.collab.resetRoom.mockRejectedValueOnce(new Error('salle indisponible'));
    await expect(h.service.restore(7, { versionId: 40 }, user)).rejects.toBeInstanceOf(ConflictException);
    expect(h.versions.restore).not.toHaveBeenCalled();
    expect(h.persistence.discardWorkingState).not.toHaveBeenCalled();
  });

  it('si la restauration jette, la salle a déjà été réinitialisée et l’état de travail est conservé', async () => {
    const h = setup();
    h.versions.restore.mockRejectedValueOnce(new Error('échec base'));
    await expect(h.service.restore(7, { versionId: 40 }, user)).rejects.toThrow('échec base');
    expect(h.collab.resetRoom).toHaveBeenCalledWith(7);
    expect(h.persistence.discardWorkingState).not.toHaveBeenCalled();
  });

  it('verrou par document : une sauvegarde manuelle attend la fin de la restauration', async () => {
    const h = setup();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.versions.restore.mockImplementationOnce(async () => {
      events.push('restore:début');
      await gate;
      events.push('restore:fin');
      return h.versionRow;
    });
    h.persistence.createVersion.mockImplementation(async (...args: unknown[]) => {
      const opts = args[3] as { changeSummary?: string | null };
      events.push(`createVersion:${opts.changeSummary ?? 'save'}`);
      return { documentVersionId: 41, versionNumber: 5 };
    });
    const restoring = h.service.restore(7, { versionId: 40 }, user);
    await new Promise((r) => setTimeout(r, 20));
    const saving = h.service.saveVersion(7, {}, user);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['createVersion:Avant restauration', 'restore:début']);
    release();
    await Promise.all([restoring, saving]);
    expect(events.indexOf('restore:fin')).toBeLessThan(events.lastIndexOf('createVersion:save'));
  });
});

// --- Export / import -----------------------------------------------------------------------------

describe('exportDocx', () => {
  it('lecture suffisante : aucun contrôle d’écriture ; renvoie le DOCX et le nom', async () => {
    const h = setup({ level: 2 });
    const res = await h.service.exportDocx(7, user);
    expect(res.fileName).toBe('Contrat.docx');
    expect(res.buffer.length).toBeGreaterThan(0);
    expect(h.persistence.assertCanModify).not.toHaveBeenCalled();
  });
});

describe('buildContentDisposition', () => {
  it('assainit le nom : pas de guillemet, séparateur de chemin ni saut de ligne', () => {
    const header = buildContentDisposition('../Bilan "2026"\r\nSet-Cookie: x.docx');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(header).not.toContain('..' + '/');
    expect(header.split('filename="')[1].split('"')[0]).not.toMatch(/[\\/"]/);
  });

  it('fournit une forme ASCII et la forme UTF-8 encodée', () => {
    const header = buildContentDisposition('Rapport été.docx');
    expect(header).toContain('filename="Rapport _t_.docx"');
    expect(header).toContain("filename*=UTF-8''Rapport%20%C3%A9t%C3%A9.docx");
  });

  it('repli sur un nom neutre si tout est supprimé', () => {
    expect(buildContentDisposition('///')).toContain('filename="___"');
    expect(buildContentDisposition('')).toContain('filename="document"');
  });
});

describe('importIntoDocument', () => {
  it('rejette un fichier qui n’est pas un zip, trop gros, sans extension .docx ou vide (400)', async () => {
    const h = setup();
    const notZip = docx({ buffer: Buffer.from('%PDF-1.7 pas un zip') });
    await expect(h.service.importIntoDocument(7, notZip, user)).rejects.toBeInstanceOf(BadRequestException);

    const big = Buffer.alloc(MAX_DOCX_UPLOAD_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    await expect(h.service.importIntoDocument(7, docx({ buffer: big }), user)).rejects.toThrow('trop volumineux');

    await expect(
      h.service.importIntoDocument(7, docx({ originalname: 'contrat.pdf' }), user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.importIntoDocument(7, undefined, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      h.service.importIntoDocument(7, docx({ buffer: Buffer.alloc(0) }), user),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(h.persistence.createVersion).not.toHaveBeenCalled();
    expect(h.collab.mutateDocument).not.toHaveBeenCalled();
  });

  it('403 : l’import ne démarre pas', async () => {
    const h = setup();
    h.persistence.assertCanModify.mockRejectedValueOnce(new ForbiddenException('Modification non autorisée sur ce document'));
    await expect(h.service.importIntoDocument(7, docx(), user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.persistence.createVersion).not.toHaveBeenCalled();
  });

  it('fichier illisible : 400 générique, aucune version créée', async () => {
    const h = setup();
    const spy = jest.spyOn(editor, 'importDocxToHtml').mockRejectedValueOnce(new Error('zip: entrée /etc/passwd'));
    const err = await h.service.importIntoDocument(7, docx(), user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).not.toContain('passwd');
    expect(h.persistence.createVersion).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('salle ouverte : version « avant import », mutation en salle, puis version « import »', async () => {
    const h = setup();
    const before = stateOf('<p>Avant</p>');
    const after = stateOf('<p>Après</p>');
    h.collab.getLiveState.mockReturnValueOnce(before).mockReturnValue(after);

    const res = await h.service.importIntoDocument(7, docx(), user);

    expect(res).toEqual({ warnings: [] });
    expect(h.persistence.createVersion.mock.calls.map((c) => (c[3] as { reason: string }).reason)).toEqual([
      'before-import',
      'import',
    ]);
    expect(h.persistence.createVersion.mock.calls[0][1]).toBe(before);
    expect(h.persistence.createVersion.mock.calls[1][1]).toBe(after);
    expect(h.collab.mutateDocument).toHaveBeenCalledWith(7, expect.any(Function), user);
    expect(h.persistence.saveWorkingState).not.toHaveBeenCalled();
  });

  it('salle fermée : applique sur l’état persistant, crée la version « import », purge l’état de travail', async () => {
    const h = setup();
    await h.service.importIntoDocument(7, docx(), user);
    expect(h.collab.mutateDocument).not.toHaveBeenCalled();
    const importCall = h.persistence.createVersion.mock.calls.find(
      (c) => (c[3] as { reason: string }).reason === 'import',
    )!;
    const doc = editor.decodeState(importCall[1] as Uint8Array);
    expect(editor.yDocToHtml(doc)).toBe('<p>Contenu importé</p>');
    expect(h.persistence.discardWorkingState).toHaveBeenCalledWith(7);
  });

  it('salle fermée, contenu identique : l’état importé devient l’état de travail de la version courante', async () => {
    const h = setup();
    h.persistence.createVersion.mockResolvedValueOnce({ documentVersionId: 40, versionNumber: 4 });
    h.persistence.createVersion.mockResolvedValueOnce(null);
    await h.service.importIntoDocument(7, docx(), user);
    expect(h.persistence.discardWorkingState).not.toHaveBeenCalled();
    expect(h.persistence.saveWorkingState).toHaveBeenCalledWith(7, expect.any(Uint8Array), 40);
  });

  it('salle fermée : l’import aboutit même si « before-import » échoue', async () => {
    const h = setup();
    h.persistence.createVersion.mockRejectedValueOnce(new Error('Maximum call stack size exceeded'));
    await expect(h.service.importIntoDocument(7, docx(), user)).resolves.toEqual({ warnings: [] });
    expect(h.persistence.createVersion.mock.calls.map((c) => (c[3] as { reason: string }).reason)).toEqual([
      'before-import',
      'import',
    ]);
    expect(h.persistence.discardWorkingState).toHaveBeenCalledWith(7);
  });

  it('salle ouverte : l’import aboutit même si « before-import » échoue', async () => {
    const h = setup();
    h.collab.getLiveState.mockReturnValue(stateOf('<p>Vivant</p>'));
    h.persistence.createVersion.mockRejectedValueOnce(new Error('boom'));
    await expect(h.service.importIntoDocument(7, docx(), user)).resolves.toEqual({ warnings: [] });
    expect(h.collab.mutateDocument).toHaveBeenCalled();
  });

  it('salle fermée, état persisté invalide : l’import repart d’un état vierge et aboutit', async () => {
    const h = setup();
    h.persistence.loadDocument.mockRejectedValue(new InvalidCollabStateException());
    await expect(h.service.importIntoDocument(7, docx(), user)).resolves.toEqual({ warnings: [] });
    // « before-import » n'a pas pu lire l'état (aucune sauvegarde) ; seule la version « import » est créée.
    expect(h.persistence.createVersion).toHaveBeenCalledTimes(1);
  });

  it('renvoie les avertissements de conversion', async () => {
    const h = setup();
    const spy = jest
      .spyOn(editor, 'importDocxToHtml')
      .mockResolvedValueOnce({ html: '<p>x</p>', warnings: ['Image ignorée'] });
    expect(await h.service.importIntoDocument(7, docx(), user)).toEqual({ warnings: ['Image ignorée'] });
    spy.mockRestore();
  });
});

// --- Création ------------------------------------------------------------------------------------

describe('createDocument', () => {
  it('propriétaire de l’espace : crée le document texte vide et journalise le rattachement', async () => {
    const h = setup({ space: { kind: GedSpaceKind.Prive, ownerUserGroupId: 11 } });
    const res = await h.service.createDocument({ spaceId: 3, label: 'Note de service' }, user);
    expect(res).toEqual({ documentId: 77, label: 'Note de service', warnings: [] });
    const input = h.persistence.createDocument.mock.calls[0][0] as { state: Uint8Array };
    expect(input).toMatchObject({ label: 'Note de service', spaceId: 3, user, changeSummary: null });
    expect(input.state.byteLength).toBeGreaterThan(0);
    expect(h.audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectRef: 'space:3', newValue: 'document-attached:77' }),
    );
    expect(h.audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectRef: 'document:77', newValue: 'space-attached:3' }),
    );
  });

  it('membre avec contribution : autorisé', async () => {
    const h = setup({
      space: {
        kind: GedSpaceKind.Collaboration,
        members: [{ userGroupId: 11, roleId: null, permission: GedSpacePermission.Contribution }],
      },
    });
    await expect(h.service.createDocument({ spaceId: 3, label: 'X' }, user)).resolves.toMatchObject({ documentId: 77 });
  });

  it('membre en lecture seule : 403, rien n’est créé', async () => {
    const h = setup({
      space: {
        kind: GedSpaceKind.Collaboration,
        members: [{ userGroupId: 11, roleId: null, permission: GedSpacePermission.Lecture }],
      },
    });
    await expect(h.service.createDocument({ spaceId: 3, label: 'X' }, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.persistence.createDocument).not.toHaveBeenCalled();
  });

  it('publication (lecture publique) et administrateur non membre : 403', async () => {
    const pub = setup({ space: { kind: GedSpaceKind.Publication } });
    await expect(pub.service.createDocument({ spaceId: 3, label: 'X' }, user)).rejects.toBeInstanceOf(ForbiddenException);
    const adminUser = { ...user, isAdmin: true };
    const adm = setup({ space: { kind: GedSpaceKind.Collaboration } });
    await expect(adm.service.createDocument({ spaceId: 3, label: 'X' }, adminUser)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(adm.persistence.createDocument).not.toHaveBeenCalled();
  });

  it('espace inexistant, privé d’autrui ou inactif : 404', async () => {
    const missing = setup({ space: null });
    await expect(missing.service.createDocument({ spaceId: 3, label: 'X' }, user)).rejects.toBeInstanceOf(NotFoundException);
    const priv = setup({ space: { kind: GedSpaceKind.Prive } });
    await expect(priv.service.createDocument({ spaceId: 3, label: 'X' }, user)).rejects.toBeInstanceOf(NotFoundException);
    const off = setup({ space: { kind: GedSpaceKind.Collaboration, isActive: false, ownerUserGroupId: 11 } });
    await expect(off.service.createDocument({ spaceId: 3, label: 'X' }, user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuse l’identité machine et un compte sans profil', async () => {
    const h = setup({ space: { kind: GedSpaceKind.Prive, ownerUserGroupId: 11 } });
    await expect(
      h.service.createDocument({ spaceId: 3, label: 'X' }, { ...user, userGroupId: null, isScanAgent: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.createDocument({ spaceId: 3, label: 'X' }, { ...user, userGroupId: null })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('un échec du journal ne fait pas échouer une création déjà effectuée', async () => {
    const h = setup({ space: { kind: GedSpaceKind.Prive, ownerUserGroupId: 11 } });
    h.audit.dataChange.mockRejectedValue(new Error('journal indisponible'));
    await expect(h.service.createDocument({ spaceId: 3, label: 'X' }, user)).resolves.toMatchObject({ documentId: 77 });
  });
});

describe('createDocumentFromHtml', () => {
  it('droit de contribution refusé : 403 (lecture seule) ou 404 (espace invisible), rien n’est créé', async () => {
    const ro = setup({
      space: {
        kind: GedSpaceKind.Collaboration,
        members: [{ userGroupId: 11, roleId: null, permission: GedSpacePermission.Lecture }],
      },
    });
    await expect(ro.service.createDocumentFromHtml(3, 'Modèle', '<p>x</p>', user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const hidden = setup({ space: { kind: GedSpaceKind.Prive } });
    await expect(hidden.service.createDocumentFromHtml(3, 'Modèle', '<p>x</p>', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const machine = setup({ space: { kind: GedSpaceKind.Prive, ownerUserGroupId: 11 } });
    await expect(
      machine.service.createDocumentFromHtml(3, 'Modèle', '<p>x</p>', { ...user, userGroupId: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ro.persistence.createDocument).not.toHaveBeenCalled();
    expect(hidden.persistence.createDocument).not.toHaveBeenCalled();
    expect(machine.persistence.createDocument).not.toHaveBeenCalled();
  });

  it('contenu initial = HTML passé par la conversion d’assainissement ; libellé borné ; audit', async () => {
    const h = setup({ space: { kind: GedSpaceKind.Prive, ownerUserGroupId: 11 } });
    const spy = jest.spyOn(editor, 'htmlToYDoc');
    const html = '<h1>Titre</h1><p>Corps</p>';
    const label = 'L'.repeat(MAX_DOCUMENT_LABEL + 20);
    const res = await h.service.createDocumentFromHtml(3, label, html, user);
    expect(spy).toHaveBeenCalledWith(html);
    expect(res).toEqual({ documentId: 77, label: 'L'.repeat(MAX_DOCUMENT_LABEL), warnings: [] });
    const input = h.persistence.createDocument.mock.calls[0][0] as { state: Uint8Array };
    expect(input).toMatchObject({
      label: 'L'.repeat(MAX_DOCUMENT_LABEL),
      spaceId: 3,
      user,
      changeSummary: 'Création depuis un modèle',
    });
    const decoded = editor.decodeState(input.state);
    expect(editor.yDocToHtml(decoded)).toBe(html);
    decoded.destroy();
    expect(h.audit.dataChange).toHaveBeenCalledWith(
      expect.objectContaining({ objectRef: 'document:77', newValue: 'space-attached:3' }),
    );
    spy.mockRestore();
  });
});

describe('importNewDocument', () => {
  const owner: SpaceFacts = { kind: GedSpaceKind.Prive, ownerUserGroupId: 11 };

  it('importe : libellé déduit du nom de fichier, avertissements et résumé « Import DOCX »', async () => {
    const h = setup({ space: owner });
    const spy = jest
      .spyOn(editor, 'importDocxToHtml')
      .mockResolvedValueOnce({ html: '<p>Corps</p>', warnings: ['Style inconnu'] });
    const res = await h.service.importNewDocument(docx(), { spaceId: 3, label: undefined }, user);
    expect(res).toEqual({ documentId: 77, label: 'Contrat final', warnings: ['Style inconnu'] });
    expect(h.persistence.createDocument.mock.calls[0][0]).toMatchObject({
      label: 'Contrat final',
      changeSummary: 'Import DOCX',
    });
    spy.mockRestore();
  });

  it('le libellé fourni prime', async () => {
    const h = setup({ space: owner });
    const res = await h.service.importNewDocument(docx(), { spaceId: 3, label: 'Mon titre' }, user);
    expect(res.label).toBe('Mon titre');
  });

  it('droit d’espace refusé : 403 sans analyser le fichier', async () => {
    const h = setup({ space: { kind: GedSpaceKind.Publication } });
    const spy = jest.spyOn(editor, 'importDocxToHtml');
    await expect(h.service.importNewDocument(docx(), { spaceId: 3, label: undefined }, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(h.persistence.createDocument).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('rejette ce qui n’est pas un zip, un fichier trop gros, une mauvaise extension ou l’absence de fichier', async () => {
    const h = setup({ space: owner });
    const dto = { spaceId: 3, label: undefined };
    await expect(
      h.service.importNewDocument(docx({ buffer: Buffer.from('<html>pas un zip</html>') }), dto, user),
    ).rejects.toThrow('pas un document Word');
    const big = Buffer.alloc(MAX_DOCX_UPLOAD_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    await expect(h.service.importNewDocument(docx({ buffer: big }), dto, user)).rejects.toThrow('trop volumineux');
    await expect(
      h.service.importNewDocument(docx({ originalname: 'note.txt' }), dto, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.importNewDocument(undefined, dto, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.persistence.createDocument).not.toHaveBeenCalled();
  });
});

// --- Candidats de mention ------------------------------------------------------------------------

describe('escapeLikePattern', () => {
  it('neutralise %, _ et \\', () => {
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(escapeLikePattern('alice')).toBe('alice');
  });
});

describe('mentionCandidates', () => {
  const row = (n: number, over: Record<string, unknown> = {}) => ({
    userGroupId: 100 + n,
    userId: 1000 + n,
    username: `user${n}`,
    fullName: `Utilisateur ${n}`,
    isAdmin: false,
    ...over,
  });

  it('moins de 2 caractères : liste vide, sans requête', async () => {
    const h = setup();
    expect(await h.service.mentionCandidates(7, ' a ', user)).toEqual([]);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('échappe la saisie (jokers LIKE) et paramètre la requête', async () => {
    const h = setup();
    await h.service.mentionCandidates(7, '50%_x', user);
    const sql = h.prisma.$queryRaw.mock.calls[0][0] as unknown as { values: unknown[]; sql: string };
    expect(sql.values).toContain('%50\\%\\_x%');
    expect(sql.values).toContain(user.userId); // exclut l'appelant
    expect(sql.sql).toContain('ILIKE');
    expect(sql.sql).not.toContain('50%'); // jamais concaténée dans le SQL
  });

  it('ne renvoie que des acteurs ayant déjà accès au document, au plus 10', async () => {
    const h = setup();
    h.prisma.$queryRaw.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_v, i) => row(i + 1)) as never,
    );
    h.documents.canAccess.mockImplementation((async (_id: number, u: AuthUser) => {
      // L'appelant passe le garde commun ; parmi les candidats, seuls les userId pairs ont accès.
      return u.userId === user.userId || u.userId % 2 === 0;
    }) as never);

    const out = await h.service.mentionCandidates(7, 'uti', user);

    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ userGroupId: 102, name: 'Utilisateur 2' });
    const asked = h.documents.canAccess.mock.calls.map((c) => (c as unknown as [number, AuthUser])[1]);
    // Chaque candidat est évalué avec SA propre identité (jamais celle de l'appelant).
    expect(asked.slice(1).every((u) => u.userId >= 1001)).toBe(true);
    expect(out.map((c) => c.userGroupId)).toEqual([102, 104, 106, 108, 110, 112, 114, 116, 118, 120]);
  });

  it('un candidat sans accès n’apparaît pas ; nom de repli sur l’identifiant', async () => {
    const h = setup();
    h.prisma.$queryRaw.mockResolvedValueOnce([row(1, { fullName: null }), row(2)] as never);
    h.documents.canAccess.mockImplementation((async (_id: number, u: AuthUser) => u.userId !== 1002) as never);
    // 1er appel : garde de l'appelant (accès accordé).
    const out = await h.service.mentionCandidates(7, 'user', user);
    expect(out).toEqual([{ userGroupId: 101, name: 'user1' }]);
  });
});
