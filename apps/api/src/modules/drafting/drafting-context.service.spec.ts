import { Logger, NotFoundException } from '@nestjs/common';
import { DocumentState, GED_DRAFT_CONTEXT_DOC_MAX_CHARS, GED_DRAFT_MAX_CONTEXT_DOCUMENTS } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import type { DocumentsService } from '../documents/documents.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DraftingContextService } from './drafting-context.service';

const user: AuthUser = { userId: 7, username: 'redacteur', isAdmin: false, userGroupId: 70 };
const FORBIDDEN_TEXT = 'TEXTE-DOCUMENT-INTERDIT-ZZZ';

interface FakeDoc {
  documentId: number;
  label: string;
  documentDate: Date | null;
  cote: string | null;
  overview: string | null;
  documentType: { label: string } | null;
  dossier: { label: string } | null;
  dossierId: number | null;
  documentState: number;
}

const fakeDoc = (documentId: number, over: Partial<FakeDoc> = {}): FakeDoc => ({
  documentId,
  label: `Document ${documentId}`,
  documentDate: new Date(Date.UTC(2024, 0, documentId % 28 || 1)),
  cote: `C-${documentId}`,
  overview: `Résumé ${documentId}`,
  documentType: { label: 'Courrier' },
  dossier: null,
  dossierId: null,
  documentState: DocumentState.Archive,
  ...over,
});

interface Where {
  documentId?: number | { in: number[] };
  dossierId?: number;
  documentState?: { not: number };
}

/**
 * « Base » simulée. Le dossier est trié comme l'exige `orderBy` (date croissante, nulls en dernier,
 * puis identifiant) et limité par `take`.
 */
function setup(opts: { docs: FakeDoc[]; allowed: number[]; chunks?: Record<number, Array<{ chunkIndex: number; content: string }>> }) {
  const docs = new Map(opts.docs.map((d) => [d.documentId, d]));
  const allowed = new Set(opts.allowed);
  const chunks = opts.chunks ?? {};

  const documentFindMany = jest.fn(async (args: { where: Where; take?: number }): Promise<unknown[]> => {
    const { where } = args;
    let list = [...docs.values()];
    if (where.documentState) list = list.filter((d) => d.documentState !== where.documentState?.not);
    if (typeof where.documentId === 'object') {
      const ids = new Set(where.documentId.in);
      list = list.filter((d) => ids.has(d.documentId));
    }
    if (where.dossierId !== undefined) {
      list = list
        .filter((d) => d.dossierId === where.dossierId)
        .sort((a, b) => {
          const ta = a.documentDate?.getTime() ?? Infinity;
          const tb = b.documentDate?.getTime() ?? Infinity;
          return ta !== tb ? ta - tb : a.documentId - b.documentId;
        })
        .slice(0, args.take ?? Infinity);
      return list.map((d) => ({ documentId: d.documentId }));
    }
    return list.map(({ dossierId: _dossierId, documentState: _state, ...rest }) => rest);
  });

  const chunkFindMany = jest.fn(async (args: { where: { documentId: number }; take?: number }) => {
    const list = [...(chunks[args.where.documentId] ?? [])].sort((a, b) => a.chunkIndex - b.chunkIndex);
    return list.slice(0, args.take ?? Infinity).map((c) => ({ content: c.content }));
  });

  const canAccess = jest.fn(async (id: number) => docs.has(id) && allowed.has(id));
  const prisma = {
    document: { findMany: documentFindMany },
    gedDocumentChunk: { findMany: chunkFindMany },
  } as unknown as PrismaService;
  const service = new DraftingContextService(prisma, { canAccess } as unknown as DocumentsService);
  return { service, documentFindMany, chunkFindMany, canAccess };
}

/** Identifiants des documents dont des segments ont été lus. */
const chunkReads = (m: jest.Mock): number[] => m.mock.calls.map((c) => (c[0] as { where: { documentId: number } }).where.documentId);

async function expectUniform404(p: Promise<unknown>): Promise<NotFoundException> {
  const error = await p.then(
    () => {
      throw new Error('aurait dû lever');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(NotFoundException);
  expect((error as NotFoundException).message).toBe('Document introuvable');
  expect((error as NotFoundException).getStatus()).toBe(404);
  return error as NotFoundException;
}

describe('DraftingContextService.load — documents explicites', () => {
  it('charge métadonnées et segments des documents autorisés, numérotés dans l’ordre demandé', async () => {
    const { service, chunkFindMany } = setup({
      docs: [
        fakeDoc(10, { label: 'Contrat', documentDate: new Date('2024-03-12T00:00:00Z'), dossier: { label: 'Fournisseurs' } }),
        fakeDoc(20, { documentType: null, documentDate: null, cote: null, overview: null }),
      ],
      allowed: [10, 20],
      chunks: {
        10: [
          { chunkIndex: 1, content: 'Deuxième segment.' },
          { chunkIndex: 0, content: 'Premier segment.' },
        ],
      },
    });
    const ctx = await service.load({ contextDocumentIds: [20, 10] }, user);
    expect(ctx).toEqual([
      {
        marker: 1,
        label: 'Document 20',
        documentTypeLabel: null,
        documentDate: null,
        cote: null,
        overview: null,
        dossierLabel: null,
        excerpts: [],
      },
      {
        marker: 2,
        label: 'Contrat',
        documentTypeLabel: 'Courrier',
        documentDate: '2024-03-12',
        cote: 'C-10',
        overview: 'Résumé 10',
        dossierLabel: 'Fournisseurs',
        excerpts: ['Premier segment.', 'Deuxième segment.'],
      },
    ]);
    // Segments de la version courante seulement, dans l'ordre, en nombre borné.
    expect(chunkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: 10, documentVersion: { is: { isCurrent: true } } },
        orderBy: { chunkIndex: 'asc' },
        take: expect.any(Number),
      }),
    );
    // Aucun identifiant interne dans le contexte renvoyé.
    expect(JSON.stringify(ctx)).not.toMatch(/documentId|dossierId/);
  });

  it('accepte un contexte vide sans rien lire', async () => {
    const { service, documentFindMany, chunkFindMany, canAccess } = setup({ docs: [], allowed: [] });
    await expect(service.load({}, user)).resolves.toEqual([]);
    await expect(service.load({ contextDocumentIds: [] }, user)).resolves.toEqual([]);
    expect(documentFindMany).not.toHaveBeenCalled();
    expect(chunkFindMany).not.toHaveBeenCalled();
    expect(canAccess).not.toHaveBeenCalled();
  });

  it('document refusé : 404 uniforme, ni métadonnées ni segments lus', async () => {
    const { service, documentFindMany, chunkFindMany } = setup({
      docs: [fakeDoc(66)],
      allowed: [],
      chunks: { 66: [{ chunkIndex: 0, content: FORBIDDEN_TEXT }] },
    });
    await expectUniform404(service.load({ contextDocumentIds: [66] }, user));
    expect(documentFindMany).not.toHaveBeenCalled();
    expect(chunkFindMany).not.toHaveBeenCalled();
  });

  it('un seul refus parmi plusieurs : rien n’est autorisé, tous les droits sont contrôlés AVANT toute lecture', async () => {
    const { service, documentFindMany, chunkFindMany, canAccess } = setup({
      docs: [fakeDoc(1), fakeDoc(2), fakeDoc(66), fakeDoc(4)],
      allowed: [1, 2, 4],
      chunks: { 1: [{ chunkIndex: 0, content: 'ok' }], 66: [{ chunkIndex: 0, content: FORBIDDEN_TEXT }] },
    });
    await expectUniform404(service.load({ contextDocumentIds: [1, 2, 66, 4] }, user));
    expect(canAccess.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([1, 2, 4, 66]);
    expect(documentFindMany).not.toHaveBeenCalled();
    expect(chunkFindMany).not.toHaveBeenCalled();
  });

  it('inexistant et interdit : exactement la même erreur', async () => {
    const { service } = setup({ docs: [fakeDoc(66)], allowed: [] });
    const missing = await expectUniform404(service.load({ contextDocumentIds: [999] }, user));
    const forbidden = await expectUniform404(service.load({ contextDocumentIds: [66] }, user));
    expect(missing.getResponse()).toEqual(forbidden.getResponse());
  });

  it.each([
    ['agent de numérisation', { ...user, isScanAgent: true }],
    ['sans compte-groupe actif', { ...user, userGroupId: null }],
    ['administrateur agent de numérisation', { ...user, isAdmin: true, isScanAgent: true }],
  ])('refuse un %s (404) sans contrôle ni lecture', async (_l, who) => {
    const { service, documentFindMany, chunkFindMany, canAccess } = setup({ docs: [fakeDoc(1)], allowed: [1] });
    await expectUniform404(service.load({ contextDocumentIds: [1] }, who as AuthUser));
    await expectUniform404(service.load({}, who as AuthUser));
    expect(canAccess).not.toHaveBeenCalled();
    expect(documentFindMany).not.toHaveBeenCalled();
    expect(chunkFindMany).not.toHaveBeenCalled();
  });

  it.each([[0], [-1], [1.5], [2_147_483_648], [Number.NaN], [Number.POSITIVE_INFINITY], ['3']])(
    'identifiant invalide (%p) : 404 sans contrôle ni lecture',
    async (bad) => {
      const { service, documentFindMany, canAccess } = setup({ docs: [fakeDoc(1), fakeDoc(3)], allowed: [1, 3] });
      await expectUniform404(service.load({ contextDocumentIds: [1, bad as number] }, user));
      await expectUniform404(service.load({ dossierId: bad as number }, user));
      expect(canAccess).not.toHaveBeenCalled();
      expect(documentFindMany).not.toHaveBeenCalled();
    },
  );

  it('déduplique les identifiants (un seul contrôle, une seule entrée)', async () => {
    const { service, canAccess, chunkFindMany } = setup({ docs: [fakeDoc(1), fakeDoc(2)], allowed: [1, 2] });
    const ctx = await service.load({ contextDocumentIds: [1, 2, 1, 1, 2] }, user);
    expect(ctx.map((d) => [d.marker, d.label])).toEqual([
      [1, 'Document 1'],
      [2, 'Document 2'],
    ]);
    expect(canAccess).toHaveBeenCalledTimes(2);
    expect(chunkFindMany).toHaveBeenCalledTimes(2);
  });

  it('refuse plus de 5 documents distincts', async () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const { service, documentFindMany } = setup({ docs: ids.map((i) => fakeDoc(i)), allowed: ids });
    await expectUniform404(service.load({ contextDocumentIds: ids }, user));
    expect(documentFindMany).not.toHaveBeenCalled();
  });

  it('document épuré demandé explicitement : 404 uniforme, aucun segment lu', async () => {
    const { service, chunkFindMany } = setup({
      docs: [fakeDoc(1), fakeDoc(8, { documentState: DocumentState.Epure })],
      allowed: [1, 8],
      chunks: { 8: [{ chunkIndex: 0, content: FORBIDDEN_TEXT }] },
    });
    await expectUniform404(service.load({ contextDocumentIds: [1, 8] }, user));
    expect(chunkFindMany).not.toHaveBeenCalled();
  });

  it('document supprimé entre le contrôle et la lecture : 404 uniforme', async () => {
    const { service, documentFindMany, chunkFindMany } = setup({ docs: [fakeDoc(1), fakeDoc(2)], allowed: [1, 2] });
    const { dossierId: _d, documentState: _s, ...onlyFirst } = fakeDoc(1);
    documentFindMany.mockResolvedValueOnce([onlyFirst]);
    await expectUniform404(service.load({ contextDocumentIds: [1, 2] }, user));
    expect(chunkFindMany).not.toHaveBeenCalled();
  });

  it('borne le texte par document (premiers segments, dernier tronqué)', async () => {
    const piece = 'a'.repeat(1500);
    const { service } = setup({
      docs: [fakeDoc(1)],
      allowed: [1],
      chunks: { 1: [0, 1, 2, 3, 4].map((chunkIndex) => ({ chunkIndex, content: `${chunkIndex}${piece}` })) },
    });
    const [d] = await service.load({ contextDocumentIds: [1] }, user);
    const total = (d?.excerpts ?? []).reduce((n, e) => n + e.length, 0);
    expect(total).toBe(GED_DRAFT_CONTEXT_DOC_MAX_CHARS);
    expect(d?.excerpts.map((e) => e[0])).toEqual(['0', '1', '2']);
  });
});

describe('DraftingContextService.load — dossier', () => {
  const dossier = (over: Partial<FakeDoc> = {}) => ({ dossierId: 500, dossier: { label: 'Dossier Alpha' }, ...over });

  it('ne garde que les documents autorisés, triés par date puis identifiant ; les interdits ne sont jamais lus', async () => {
    const { service, documentFindMany, chunkFindMany } = setup({
      docs: [
        fakeDoc(30, dossier({ documentDate: new Date('2024-02-01T00:00:00Z') })),
        fakeDoc(66, dossier({ documentDate: new Date('2024-01-01T00:00:00Z'), label: 'Interdit' })),
        fakeDoc(11, dossier({ documentDate: new Date('2024-02-01T00:00:00Z') })),
        fakeDoc(5, dossier({ documentDate: null })),
        fakeDoc(7), // hors dossier
      ],
      allowed: [30, 11, 5, 7],
      chunks: { 66: [{ chunkIndex: 0, content: FORBIDDEN_TEXT }], 11: [{ chunkIndex: 0, content: 'ok' }] },
    });
    const ctx = await service.load({ dossierId: 500 }, user);
    expect(ctx.map((d) => [d.marker, d.label])).toEqual([
      [1, 'Document 11'],
      [2, 'Document 30'],
      [3, 'Document 5'],
    ]);
    expect(ctx.every((d) => d.dossierLabel === 'Dossier Alpha')).toBe(true);
    expect(JSON.stringify(ctx)).not.toContain('Interdit');
    expect(JSON.stringify(ctx)).not.toContain(FORBIDDEN_TEXT);
    expect(chunkReads(chunkFindMany)).not.toContain(66);
    // La lecture des métadonnées ne porte que sur les documents autorisés.
    const metaCall = documentFindMany.mock.calls.find((c) => typeof (c[0] as { where: Where }).where.documentId === 'object');
    expect((metaCall?.[0] as { where: { documentId: { in: number[] } } }).where.documentId.in).not.toContain(66);
    // Lecture du dossier : épurés exclus, tri stable, borne de lecture raisonnable.
    expect(documentFindMany).toHaveBeenCalledWith({
      where: { dossierId: 500, documentState: { not: DocumentState.Epure } },
      select: { documentId: true },
      orderBy: [{ documentDate: { sort: 'asc', nulls: 'last' } }, { documentId: 'asc' }],
      take: 60,
    });
  });

  it('dossier sans document autorisé : 404 uniforme, libellé jamais lu ni exposé', async () => {
    const { service, documentFindMany, chunkFindMany } = setup({
      docs: [fakeDoc(66, dossier()), fakeDoc(67, dossier())],
      allowed: [],
      chunks: { 66: [{ chunkIndex: 0, content: FORBIDDEN_TEXT }] },
    });
    const forbidden = await expectUniform404(service.load({ dossierId: 500 }, user));
    expect(chunkFindMany).not.toHaveBeenCalled();
    expect(documentFindMany).toHaveBeenCalledTimes(1); // la seule liste d'identifiants du dossier
    const missing = await expectUniform404(service.load({ dossierId: 404404 }, user));
    expect(missing.getResponse()).toEqual(forbidden.getResponse());
  });

  it('dossier dont seuls des documents épurés seraient accessibles : 404', async () => {
    const { service } = setup({ docs: [fakeDoc(8, dossier({ documentState: DocumentState.Epure }))], allowed: [8] });
    await expectUniform404(service.load({ dossierId: 500 }, user));
  });

  it('combine explicites puis dossier, sans doublon, au plus 5 au total', async () => {
    const inDossier = [21, 22, 23, 24, 25, 26].map((id) => fakeDoc(id, dossier()));
    const { service } = setup({ docs: [fakeDoc(1), fakeDoc(2), ...inDossier], allowed: [1, 2, 21, 22, 23, 24, 25, 26] });
    const ctx = await service.load({ contextDocumentIds: [2, 21], dossierId: 500 }, user);
    expect(ctx).toHaveLength(GED_DRAFT_MAX_CONTEXT_DOCUMENTS);
    expect(ctx.map((d) => d.label)).toEqual(['Document 2', 'Document 21', 'Document 22', 'Document 23', 'Document 24']);
    expect(ctx.map((d) => d.marker)).toEqual([1, 2, 3, 4, 5]);
  });

  it('les explicites remplissent déjà le contexte : le dossier doit tout de même contenir un document accessible', async () => {
    const ids = [1, 2, 3, 4, 5];
    const forbiddenDossier = setup({ docs: [...ids.map((i) => fakeDoc(i)), fakeDoc(66, dossier())], allowed: ids });
    await expectUniform404(forbiddenDossier.service.load({ contextDocumentIds: ids, dossierId: 500 }, user));

    const okDossier = setup({ docs: [...ids.map((i) => fakeDoc(i)), fakeDoc(60, dossier())], allowed: [...ids, 60] });
    const ctx = await okDossier.service.load({ contextDocumentIds: ids, dossierId: 500 }, user);
    expect(ctx.map((d) => d.label)).toEqual(ids.map((i) => `Document ${i}`));
    expect(chunkReads(okDossier.chunkFindMany)).not.toContain(60);
  });

  it('borne le nombre de documents et arrête les contrôles de droits dès que le contexte est plein', async () => {
    const many = Array.from({ length: 40 }, (_, i) => fakeDoc(100 + i, dossier()));
    const { service, canAccess, chunkFindMany } = setup({ docs: many, allowed: many.map((d) => d.documentId) });
    const ctx = await service.load({ dossierId: 500 }, user);
    expect(ctx).toHaveLength(GED_DRAFT_MAX_CONTEXT_DOCUMENTS);
    expect(canAccess.mock.calls.length).toBeLessThan(many.length);
    expect(chunkFindMany).toHaveBeenCalledTimes(GED_DRAFT_MAX_CONTEXT_DOCUMENTS);
  });

  it('trouve les documents autorisés au-delà des premiers refusés (dans la borne de lecture)', async () => {
    const many = Array.from({ length: 30 }, (_, i) => fakeDoc(100 + i, dossier()));
    const { service, chunkFindMany } = setup({ docs: many, allowed: [127, 128] });
    const ctx = await service.load({ dossierId: 500 }, user);
    expect(ctx.map((d) => d.label)).toEqual(['Document 127', 'Document 128']);
    expect(chunkReads(chunkFindMany).sort()).toEqual([127, 128]);
  });
});

describe('DraftingContextService — journalisation', () => {
  it('ne journalise rien (aucun texte de document)', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    const consoleSpies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { service } = setup({
      docs: [fakeDoc(1), fakeDoc(66)],
      allowed: [1],
      chunks: { 1: [{ chunkIndex: 0, content: 'Texte autorisé' }] },
    });
    await service.load({ contextDocumentIds: [1] }, user);
    await service.load({ contextDocumentIds: [66] }, user).catch(() => undefined);
    for (const s of [...spies, ...consoleSpies]) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
