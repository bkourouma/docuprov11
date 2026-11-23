import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentState } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { ArchivesLendingService } from './archives-lending.service';
import { createLendingSchema, type CreateLendingDto } from './archives.dto';
import { ARCHIVES_MENUS } from './archives.menus';
import { latestCivilDate } from './domain';

interface FakeDoc {
  documentId: number;
  label: string;
  documentState: number;
  isFrozen: boolean;
}

/**
 * Prisma minimal : un bénéficiaire (70), des motifs (1 actif, 2 désactivé), des documents, et des
 * sorties en cours. `create` enregistre ce qui aurait été inséré.
 */
function setup(opts: { docs: FakeDoc[]; out?: number[] }) {
  const motives = new Map([
    [1, { isActive: true }],
    [2, { isActive: false }],
  ]);
  const created: unknown[] = [];
  const prisma = {
    appUserGroup: {
      findUnique: jest.fn(async ({ where }: { where: { userGroupId: number } }) =>
        where.userGroupId === 70 ? { userGroupId: 70 } : null,
      ),
    },
    lendingMotive: {
      findUnique: jest.fn(
        async ({ where }: { where: { lendingMotiveId: number } }) =>
          motives.get(where.lendingMotiveId) ?? null,
      ),
    },
    document: {
      findMany: jest.fn(async ({ where }: { where: { documentId: { in: number[] } } }) =>
        opts.docs.filter((d) => where.documentId.in.includes(d.documentId)),
      ),
    },
    lendingDocumentDetail: {
      findMany: jest.fn(async ({ where }: { where: { documentId: { in: number[] } } }) =>
        (opts.out ?? [])
          .filter((id) => where.documentId.in.includes(id))
          .map((id) => ({ document: { label: `doc ${id}` } })),
      ),
    },
    lendingDocument: {
      create: jest.fn(
        async (args: { data: { details: { create: Array<{ documentId: number }> } } }) => {
          created.push(args);
          return { lendingDocumentId: 1, details: args.data.details.create };
        },
      ),
    },
  };
  return {
    service: new ArchivesLendingService(prisma as unknown as PrismaService),
    prisma,
    created,
  };
}

const doc = (documentId: number, extra: Partial<FakeDoc> = {}): FakeDoc => ({
  documentId,
  label: `doc ${documentId}`,
  documentState: DocumentState.Archive,
  isFrozen: false,
  ...extra,
});

const input = (extra: Partial<CreateLendingDto> = {}): CreateLendingDto => ({
  documentIds: [10],
  userGroupId: 70,
  lendingMotiveId: 1,
  startDate: '2026-11-20',
  projectedReturnDate: '2026-11-30',
  ...extra,
});

describe('ArchivesLendingService.createLending', () => {
  it('crée une entête et un détail par document', async () => {
    const { service, created } = setup({ docs: [doc(10), doc(11)] });
    const r = await service.createLending(input({ documentIds: [10, 11] }), 70);
    expect(r.details).toEqual([{ documentId: 10 }, { documentId: 11 }]);
    expect(created).toHaveLength(1);
  });

  it('ANO-ARC-T3-01 : motif inconnu → 404 lisible, sans tenter l’insertion (plus de 500 de clé étrangère)', async () => {
    const { service, prisma } = setup({ docs: [doc(10)] });
    await expect(service.createLending(input({ lendingMotiveId: 99 }), 70)).rejects.toThrow(
      new NotFoundException('Motif de prêt introuvable'),
    );
    expect(prisma.lendingDocument.create).not.toHaveBeenCalled();
  });

  it('refuse un motif désactivé', async () => {
    const { service, prisma } = setup({ docs: [doc(10)] });
    await expect(service.createLending(input({ lendingMotiveId: 2 }), 70)).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.lendingDocument.create).not.toHaveBeenCalled();
  });

  it('refuse un bénéficiaire inconnu', async () => {
    const { service } = setup({ docs: [doc(10)] });
    await expect(service.createLending(input({ userGroupId: 5 }), 70)).rejects.toThrow(
      new NotFoundException('Bénéficiaire introuvable'),
    );
  });

  it('ANO-ARC-T3-03 : refuse en bloc un document gelé, comme la liste des communicables l’écarte', async () => {
    const { service, prisma } = setup({ docs: [doc(10), doc(11, { isFrozen: true })] });
    await expect(service.createLending(input({ documentIds: [10, 11] }), 70)).rejects.toThrow(
      new ConflictException('Document(s) gelé(s), non communicable(s) : doc 11'),
    );
    expect(prisma.lendingDocument.create).not.toHaveBeenCalled();
  });

  it('refuse en bloc un document épuré ou déjà sorti', async () => {
    const epure = setup({ docs: [doc(10), doc(11, { documentState: DocumentState.Epure })] });
    await expect(epure.service.createLending(input({ documentIds: [10, 11] }), 70)).rejects.toThrow(
      ConflictException,
    );
    const sorti = setup({ docs: [doc(10), doc(11)], out: [11] });
    await expect(sorti.service.createLending(input({ documentIds: [10, 11] }), 70)).rejects.toThrow(
      new ConflictException('Document(s) déjà communiqué(s) et non rendu(s) : doc 11'),
    );
    expect(sorti.prisma.lendingDocument.create).not.toHaveBeenCalled();
  });

  it('ANO-ARC-T3-04 : un document cité deux fois ne sort qu’une fois', async () => {
    const { service } = setup({ docs: [doc(10)] });
    const r = await service.createLending(input({ documentIds: [10, 10] }), 70);
    expect(r.details).toEqual([{ documentId: 10 }]);
  });
});

describe('createLendingSchema', () => {
  const valide = { ...input(), startDate: latestCivilDate(new Date()) };
  const today = new Date().toISOString().slice(0, 10);

  it('accepte un prêt débutant aujourd’hui et rendu le jour même', () => {
    expect(
      createLendingSchema.safeParse({ ...valide, startDate: today, projectedReturnDate: today })
        .success,
    ).toBe(true);
  });

  it('ANO-ARC-T3-02 : refuse une date de début future', () => {
    const futur = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const r = createLendingSchema.safeParse({
      ...valide,
      startDate: futur,
      projectedReturnDate: futur,
    });
    expect(r.success).toBe(false);
    expect(
      r.success ? [] : r.error.issues.map((i) => [i.path.join('.'), i.message]),
    ).toContainEqual(['startDate', 'La date de début ne peut pas être future']);
  });

  it('refuse un retour prévu antérieur au début', () => {
    const r = createLendingSchema.safeParse({
      ...valide,
      startDate: '2026-11-10',
      projectedReturnDate: '2026-11-09',
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ANO-ARC-T3-05 : périmètre des gestes sur un prêt identifié
// ---------------------------------------------------------------------------

/**
 * Prisma minimal pour les gestes : le prêt 1 (détail 11, non rendu) appartient à la PERSONNE 5.
 * Les menus de chaque compte sont relus par `appUser.findUnique`, comme le fait le garde.
 */
function scopeSetup(menusByUser: Record<number, string[]>) {
  const lendings = [{ lendingDocumentId: 1, ownerUserId: 5 }];
  const details = [{ lendingDocumentDetailId: 11, lendingDocumentId: 1 }];
  const owns = (lendingDocumentId: number, filter?: { userGroup?: { userId: number } }) => {
    const l = lendings.find((x) => x.lendingDocumentId === lendingDocumentId);
    if (!l) return null;
    if (filter?.userGroup && filter.userGroup.userId !== l.ownerUserId) return null;
    return l;
  };
  const tx = {
    lendingDocumentDetail: {
      update: jest.fn(async () => ({ lendingDocumentDetailId: 11, returnedDate: new Date() })),
      count: jest.fn(async () => 0),
    },
    lendingDocument: { update: jest.fn(async () => ({})) },
  };
  const prisma = {
    appUser: {
      findUnique: jest.fn(async ({ where }: { where: { userId: number } }) => ({
        isAdmin: false,
        role: {
          isActive: true,
          isSystem: false,
          menus: (menusByUser[where.userId] ?? []).map((menuKey) => ({ menuKey })),
        },
      })),
    },
    lendingDocument: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { lendingDocumentId: number; userGroup?: { userId: number } };
        }) => {
          const l = owns(where.lendingDocumentId, where);
          return l ? { lendingDocumentId: l.lendingDocumentId, details: [], comments: [] } : null;
        },
      ),
    },
    lendingDocumentDetail: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { lendingDocumentDetailId: number; lending?: { userGroup?: { userId: number } } };
        }) => {
          const d = details.find(
            (x) => x.lendingDocumentDetailId === where.lendingDocumentDetailId,
          );
          if (!d || !owns(d.lendingDocumentId, where.lending)) return null;
          return { lendingDocumentId: d.lendingDocumentId, returnedDate: null };
        },
      ),
    },
    lendingDocumentComment: {
      create: jest.fn(async ({ data }: { data: unknown }) => data),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return {
    service: new ArchivesLendingService(prisma as unknown as PrismaService),
    prisma,
    tx,
  };
}

const user = (userId: number, extra: Partial<AuthUser> = {}): AuthUser => ({
  userId,
  username: `u${userId}`,
  isAdmin: false,
  userGroupId: userId * 10,
  ...extra,
});

const M = ARCHIVES_MENUS;
const TITULAIRE = 5;
const INTRUS = 6;
const ARCHIVISTE = 7;
const LECTEUR = 8;
const menus = {
  [TITULAIRE]: [M.myLentDocuments],
  [INTRUS]: [M.myLentDocuments],
  [ARCHIVISTE]: [M.lentDocuments],
  [LECTEUR]: [M.lendingHistory, M.myLentDocuments],
};

describe('ArchivesLendingService — périmètre « Mes documents communiqués » (ANO-ARC-T3-05)', () => {
  it('le prêt d’autrui est INTROUVABLE (404) pour le seul menu « Mes documents » : ni lu, ni commenté, ni rendu', async () => {
    const { service, prisma, tx } = scopeSetup(menus);
    const intrus = user(INTRUS);
    const introuvable = new NotFoundException('Prêt introuvable');

    await expect(service.getLending(1, intrus)).rejects.toThrow(introuvable);
    await expect(service.addComment(1, 'intrusion', intrus)).rejects.toThrow(introuvable);
    await expect(service.returnDetail(11, intrus)).rejects.toThrow(introuvable);

    // Même filtre que `listMine` : la personne bénéficiaire.
    expect(prisma.lendingDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lendingDocumentId: 1, userGroup: { userId: INTRUS } },
      }),
    );
    expect(prisma.lendingDocumentComment.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.lendingDocumentDetail.update).not.toHaveBeenCalled();
  });

  it('le bénéficiaire lit, commente et rend SON prêt avec le seul menu « Mes documents »', async () => {
    const { service, prisma, tx } = scopeSetup(menus);
    const titulaire = user(TITULAIRE);

    await expect(service.getLending(1, titulaire)).resolves.toMatchObject({ lendingDocumentId: 1 });
    await expect(service.addComment(1, 'retour vendredi', titulaire)).resolves.toEqual({
      lendingDocumentId: 1,
      comments: 'retour vendredi',
      userGroupId: TITULAIRE * 10,
    });
    await expect(service.returnDetail(11, titulaire)).resolves.toMatchObject({
      lendingClosed: true,
    });
    expect(prisma.lendingDocumentComment.create).toHaveBeenCalledTimes(1);
    expect(tx.lendingDocumentDetail.update).toHaveBeenCalledTimes(1);
  });

  it('« Documents communiqués » garde tout le périmètre : aucun filtre de bénéficiaire', async () => {
    const { service, prisma, tx } = scopeSetup(menus);
    const archiviste = user(ARCHIVISTE);

    await expect(service.getLending(1, archiviste)).resolves.toMatchObject({
      lendingDocumentId: 1,
    });
    await expect(service.addComment(1, 'relance', archiviste)).resolves.toBeDefined();
    await expect(service.returnDetail(11, archiviste)).resolves.toBeDefined();
    expect(prisma.lendingDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lendingDocumentId: 1 } }),
    );
    expect(prisma.lendingDocumentDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { lendingDocumentDetailId: 11, lending: {} } }),
    );
    expect(tx.lendingDocumentDetail.update).toHaveBeenCalledTimes(1);
  });

  it('l’administrateur (jeton) garde tout le périmètre, sans relecture des menus', async () => {
    const { service, prisma } = scopeSetup({});
    await expect(service.getLending(1, user(1, { isAdmin: true }))).resolves.toMatchObject({
      lendingDocumentId: 1,
    });
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
  });

  it('« Historique » lit tout prêt, mais cumulé avec « Mes documents » ne rend ni ne commente que les siens', async () => {
    const { service, prisma } = scopeSetup(menus);
    const lecteur = user(LECTEUR);
    await expect(service.getLending(1, lecteur)).resolves.toMatchObject({ lendingDocumentId: 1 });
    await expect(service.addComment(1, 'x', lecteur)).rejects.toThrow(NotFoundException);
    await expect(service.returnDetail(11, lecteur)).rejects.toThrow(NotFoundException);
    expect(prisma.lendingDocumentComment.create).not.toHaveBeenCalled();
  });

  it('sans aucun menu de communication (menu retiré depuis le garde) : 403, sans lecture du prêt', async () => {
    const { service, prisma } = scopeSetup({ 9: ['/search'] });
    await expect(service.getLending(1, user(9))).rejects.toThrow(ForbiddenException);
    expect(prisma.lendingDocument.findFirst).not.toHaveBeenCalled();
  });

  it('commentaire sans acteur : 400 avant tout contrôle de périmètre (inchangé)', async () => {
    const { service, prisma } = scopeSetup(menus);
    await expect(
      service.addComment(1, 'x', user(TITULAIRE, { userGroupId: null })),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
  });
});
