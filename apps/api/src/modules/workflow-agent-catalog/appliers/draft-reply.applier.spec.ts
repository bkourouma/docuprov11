import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../../auth/auth.types';
import type { CollabDocumentsService } from '../../collab/documents/collab-documents.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { EffectRefusedError, type ApplierContext } from '../catalog.contracts';
import { DraftReplyApplier, DraftReplyBaseApplier, plainTextToHtml } from './draft-reply.applier';

// Le vrai service tire l'éditeur (ESM) : inutile ici, on n'utilise qu'un faux.
jest.mock('../../collab/documents/collab-documents.service', () => ({ CollabDocumentsService: class {} }));

const removeMock = jest.fn(async () => undefined);
jest.mock('@archivage/storage', () => ({
  DiskFileStore: jest.fn().mockImplementation(() => ({ remove: removeMock })),
}));

const validator: AuthUser = { userId: 1, username: 'val', isAdmin: false, userGroupId: 10 };
const launcher: AuthUser = { userId: 2, username: 'lan', isAdmin: false, userGroupId: 20 };

/** Faux `tx` : accès en lecture aux espaces et aux comptes. Espace 5 : propriétaire = groupe 10 (valideur), membre contributeur = groupe 20 (lanceur). */
function makeTx(ownerGroupId = 10, members: Array<{ userGroupId: number | null; roleId: number | null; permission: number }> = [{ userGroupId: 20, roleId: null, permission: 1 }]) {
  const groups: Record<number, number[]> = { 1: [10], 2: [20] };
  return {
    appUserGroup: { findMany: jest.fn(async ({ where }: { where: { userId: number } }) => (groups[where.userId] ?? []).map((userGroupId) => ({ userGroupId }))) },
    appUser: { findUnique: jest.fn(async () => ({ isDisabled: false, roleId: null, role: null })) },
    gedSpace: {
      findUnique: jest.fn(async ({ where }: { where: { gedSpaceId: number } }) =>
        where.gedSpaceId === 5 ? { kind: 1, isActive: true, ownerUserGroupId: ownerGroupId, members } : null,
      ),
    },
  };
}

function makeCtx(over: Partial<{ input: Record<string, unknown>; rights: Partial<ApplierContext['rights']>; tx: ReturnType<typeof makeTx>; scratch: Map<string, unknown> }> = {}) {
  const tx = over.tx ?? makeTx();
  const rights = {
    validator,
    launcher,
    requireAnyMenu: jest.fn(async () => undefined),
    requireMailReadable: jest.fn(async () => undefined),
    ...over.rights,
  } as ApplierContext['rights'];
  const ctx = {
    tx,
    now: new Date('2026-11-21T10:00:00Z'),
    instanceId: '100',
    taskId: '7',
    stepKey: 'agent',
    definitionVersionId: 1,
    subject: { type: 'mail', id: '1' },
    input: over.input ?? {},
    stepConfig: {},
    validatorPrincipal: { userGroupId: 10, userId: 1, groupIds: [], roleId: null },
    rights,
    scratch: over.scratch ?? new Map<string, unknown>(),
  } as unknown as ApplierContext;
  return { ctx, tx, rights };
}

function makeServices() {
  const collab = {
    createDocumentFromHtml: jest.fn(async () => ({ documentId: 77, label: 'x', warnings: [] as string[] })),
  };
  const prisma = {
    document: {
      findUnique: jest.fn(async () => ({ versions: [{ files: [{ fileId: 1, fileExtension: 'ydoc' }] }] })),
      delete: jest.fn(async () => ({})),
    },
  };
  const config = { getOrThrow: jest.fn(() => '/tmp/archives') };
  return { collab, prisma, config };
}

function build() {
  const s = makeServices();
  const deps = [s.collab as unknown as CollabDocumentsService, s.prisma as unknown as PrismaService, s.config as unknown as ConfigService] as const;
  return { ...s, draft: new DraftReplyApplier(...deps), base: new DraftReplyBaseApplier(...deps) };
}

const validArgs = { templateId: 'attestation', label: 'Réponse', draftHtml: '<p>Bonjour</p>', spaceId: 5 };

describe('DraftReplyApplier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('cas nominal : crée le document au nom du valideur, effet sans contenu', async () => {
    const { draft, collab } = build();
    const { ctx, rights } = makeCtx();
    const res = await draft.apply(ctx, draft.parse({ ...validArgs, mailId: 3 }));
    expect(rights.requireMailReadable).toHaveBeenCalledWith(3);
    expect(collab.createDocumentFromHtml).toHaveBeenCalledWith(5, 'Réponse', '<p>Bonjour</p>', validator);
    expect(res.effects).toEqual([
      { tool: 'preparer_brouillon_reponse', summary: { documentId: 77, spaceId: 5, templateId: 'attestation' } },
    ]);
    expect(JSON.stringify(res.effects)).not.toContain('Bonjour');
    expect(typeof res.compensate).toBe('function');
  });

  it('espace de repli : ctx.input.draftSpaceId', async () => {
    const { draft, collab } = build();
    const { ctx } = makeCtx({ input: { draftSpaceId: 5 } });
    await draft.apply(ctx, draft.parse({ ...validArgs, spaceId: undefined }));
    expect(collab.createDocumentFromHtml).toHaveBeenCalledWith(5, 'Réponse', '<p>Bonjour</p>', validator);
  });

  it.each([[undefined], [-3], [0], ['5'], [1.5]])('aucun espace utilisable (draftSpaceId=%p) : refus explicite', async (v) => {
    const { draft, collab } = build();
    const { ctx } = makeCtx({ input: { draftSpaceId: v } });
    await expect(draft.apply(ctx, draft.parse({ ...validArgs, spaceId: undefined }))).rejects.toThrow(
      'Aucun espace de destination : renseigner draftSpaceId au lancement',
    );
    expect(collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });

  it('arguments invalides : clé en trop, id négatif, sans valeur dans le message', () => {
    const { draft } = build();
    expect(() => draft.parse({ ...validArgs, extra: 'secret-contenu' })).toThrow(EffectRefusedError);
    expect(() => draft.parse({ ...validArgs, spaceId: -1 })).toThrow(EffectRefusedError);
    try {
      draft.parse({ ...validArgs, extra: 'secret-contenu' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-contenu');
      expect((e as Error).message).toContain('arguments invalides');
    }
  });

  it('modèle inconnu : refus', async () => {
    const { draft, collab } = build();
    const { ctx } = makeCtx();
    await expect(draft.apply(ctx, draft.parse({ ...validArgs, templateId: 'inexistant' }))).rejects.toThrow('modèle de rédaction inconnu');
    expect(collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });

  it('courrier illisible : refus relayé, rien créé', async () => {
    const { draft, collab } = build();
    const { ctx } = makeCtx({
      rights: { requireMailReadable: jest.fn(async () => { throw new EffectRefusedError('Courrier illisible'); }) },
    });
    await expect(draft.apply(ctx, draft.parse({ ...validArgs, mailId: 3 }))).rejects.toThrow('Courrier illisible');
    expect(collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });

  it('le LANCEUR ne peut pas contribuer (le valideur le peut) : refus désignant le lanceur', async () => {
    const { draft, collab } = build();
    const { ctx } = makeCtx({ tx: makeTx(10, []) });
    await expect(draft.apply(ctx, draft.parse(validArgs))).rejects.toThrow('lanceur ne peut pas contribuer');
    expect(collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });

  it('membre en simple lecture : refus', async () => {
    const { draft } = build();
    const { ctx } = makeCtx({ tx: makeTx(10, [{ userGroupId: 20, roleId: null, permission: 0 }]) });
    await expect(draft.apply(ctx, draft.parse(validArgs))).rejects.toThrow('lanceur ne peut pas contribuer');
  });

  it('espace inexistant : refus', async () => {
    const { draft } = build();
    const { ctx } = makeCtx();
    await expect(draft.apply(ctx, draft.parse({ ...validArgs, spaceId: 6 }))).rejects.toThrow('valideur ne peut pas contribuer');
  });

  it('le VALIDEUR seul refusé : message désigne le valideur', async () => {
    const { draft, collab } = build();
    const { ctx } = makeCtx({ tx: makeTx(20, []) }); // propriétaire = lanceur, valideur sans droit
    await expect(draft.apply(ctx, draft.parse(validArgs))).rejects.toThrow('valideur ne peut pas contribuer');
    expect(collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });

  it('droit refusé par le service : EffectRefusedError sans contenu', async () => {
    const { draft, collab } = build();
    collab.createDocumentFromHtml.mockRejectedValueOnce(new ForbiddenException('Droit de contribution requis sur cet espace'));
    const { ctx } = makeCtx();
    await expect(draft.apply(ctx, draft.parse(validArgs))).rejects.toBeInstanceOf(EffectRefusedError);
  });

  it('doublon dans le lot : un seul document créé', async () => {
    const { draft, collab } = build();
    const { ctx } = makeCtx();
    const args = draft.parse(validArgs);
    await draft.apply(ctx, args);
    const second = await draft.apply(ctx, args);
    expect(collab.createDocumentFromHtml).toHaveBeenCalledTimes(1);
    expect(second.effects[0].summary).toMatchObject({ documentId: 77, status: 'already_present' });
    expect(second.compensate).toBeUndefined();
  });

  it('compensation : supprime le document, idempotente, ne lève jamais', async () => {
    const { draft, prisma } = build();
    const { ctx } = makeCtx();
    const res = await draft.apply(ctx, draft.parse(validArgs));
    await res.compensate!();
    await res.compensate!();
    expect(prisma.document.delete).toHaveBeenCalledTimes(1);
    expect(prisma.document.delete).toHaveBeenCalledWith({ where: { documentId: 77 } });
    expect(removeMock).toHaveBeenCalledWith(1, 'ydoc');
  });

  it('compensation : n échoue jamais même si la base est en erreur', async () => {
    const { draft, prisma } = build();
    prisma.document.findUnique.mockRejectedValueOnce(new Error('base indisponible'));
    const { ctx } = makeCtx();
    const res = await draft.apply(ctx, draft.parse(validArgs));
    await expect(res.compensate!()).resolves.toBeUndefined();
  });
});

describe('DraftReplyBaseApplier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('convertit le texte brut en HTML échappé, objet = titre', async () => {
    const { base, collab } = build();
    const { ctx } = makeCtx({ input: { draftSpaceId: 5 } });
    const res = await base.apply(ctx, base.parse({ subject: 'Objet', bodyText: 'Bonjour <b>Madame</b> & Monsieur\nligne 2\n\nSecond "bloc"' }));
    expect(collab.createDocumentFromHtml).toHaveBeenCalledWith(
      5,
      'Objet',
      '<p>Bonjour &lt;b&gt;Madame&lt;/b&gt; &amp; Monsieur<br>ligne 2</p><p>Second &quot;bloc&quot;</p>',
      validator,
    );
    expect(res.effects[0]).toEqual({ tool: 'proposer_reponse', summary: { documentId: 77, spaceId: 5, templateId: null } });
  });

  it('sans espace : refus ; arguments invalides refusés', async () => {
    const { base } = build();
    const { ctx } = makeCtx();
    await expect(base.apply(ctx, base.parse({ subject: 'S', bodyText: 'T' }))).rejects.toThrow('Aucun espace de destination');
    expect(() => base.parse({ subject: 'S', bodyText: 'T', spaceId: 5 })).toThrow(EffectRefusedError);
    expect(() => base.parse({ subject: 'S', bodyText: 'T', mailId: -1 })).toThrow(EffectRefusedError);
  });

  it('le lanceur doit pouvoir contribuer aussi', async () => {
    const { base, collab } = build();
    const { ctx } = makeCtx({ input: { draftSpaceId: 5 }, tx: makeTx(10, []) });
    await expect(base.apply(ctx, base.parse({ subject: 'S', bodyText: 'T' }))).rejects.toThrow('lanceur ne peut pas contribuer');
    expect(collab.createDocumentFromHtml).not.toHaveBeenCalled();
  });
});

describe('plainTextToHtml', () => {
  it('échappe et segmente', () => {
    expect(plainTextToHtml('a\r\n\r\n\r\nb')).toBe('<p>a</p><p>b</p>');
    expect(plainTextToHtml("<script>alert('x')</script>")).toBe('<p>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;</p>');
  });
});
