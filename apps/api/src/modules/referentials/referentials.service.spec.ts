import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { HierarchyService } from '../../common/hierarchy.service';
import { ReferentialsService } from './referentials.service';

/** Erreur Prisma connue, telle que le client la lève (seul `code` est lu par le service). */
function prismaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`prisma ${code}`), { code });
}

function setup() {
  const prisma = {
    documentType: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ documentTypeId: 4, isActive: true }),
      create: jest.fn().mockResolvedValue({ documentTypeId: 9 }),
      update: jest.fn().mockResolvedValue({}),
    },
    confidentialite: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ confidentialiteId: 2 }),
      aggregate: jest.fn().mockResolvedValue({ _max: { rank: 30 } }),
      create: jest.fn().mockResolvedValue({ confidentialiteId: 7 }),
      update: jest.fn().mockResolvedValue({}),
    },
    permissionLevel: { findUnique: jest.fn().mockResolvedValue({ permissionLevelId: 2 }) },
    role: { findUnique: jest.fn().mockResolvedValue({ roleId: 5 }) },
    appUserGroup: { findUnique: jest.fn().mockResolvedValue({ userGroupId: 11 }) },
    documentTypePermission: { create: jest.fn().mockResolvedValue({ documentTypePermissionId: 1 }) },
    documentPermission: { upsert: jest.fn().mockResolvedValue({}) },
    dossier: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ dossierId: 21 }),
      update: jest.fn().mockResolvedValue({}),
    },
    classificationPlan: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({ planId: 31 }),
      update: jest.fn().mockResolvedValue({}),
    },
    location: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({ locationId: 41 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const service = new ReferentialsService(prisma as never, new HierarchyService());
  return { service, prisma };
}

describe('ReferentialsService — types de document', () => {
  it('désactiver un type inconnu rend 404 (et non le P2025 brut, donc 500)', async () => {
    const { service, prisma } = setup();
    prisma.documentType.findUnique.mockResolvedValue(null);
    await expect(service.deactivateDocumentType(999)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.documentType.update).not.toHaveBeenCalled();
  });

  it('désactive un type existant', async () => {
    const { service, prisma } = setup();
    await expect(service.deactivateDocumentType(4)).resolves.toEqual({ deactivated: true });
    expect(prisma.documentType.update).toHaveBeenCalledWith({
      where: { documentTypeId: 4 },
      data: { isActive: false },
    });
  });

  it('création concurrente du même libellé (P2002) rend 409', async () => {
    const { service, prisma } = setup();
    prisma.documentType.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.createDocumentType({ label: 'Facture' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('une autre erreur Prisma reste propagée telle quelle', async () => {
    const { service, prisma } = setup();
    const boom = prismaError('P1001');
    prisma.documentType.create.mockRejectedValue(boom);
    await expect(service.createDocumentType({ label: 'Facture' })).rejects.toBe(boom);
  });
});

describe('ReferentialsService — confidentialités', () => {
  it('refuse un libellé qui ne diffère d’un niveau actif que par la casse (miroir de l’index)', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.findMany.mockResolvedValue([{ confidentialiteId: 4, label: 'Secret' }]);
    await expect(service.createConfidentialite({ label: 'secret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.createConfidentialite({ label: 'SECRET' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.confidentialite.create).not.toHaveBeenCalled();
  });

  it('refuse un libellé qui ne diffère que par les espaces', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.findMany.mockResolvedValue([
      { confidentialiteId: 4, label: 'Très secret' },
    ]);
    await expect(service.createConfidentialite({ label: 'Trèssecret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('ne compare qu’aux niveaux ACTIFS', async () => {
    const { service, prisma } = setup();
    await service.createConfidentialite({ label: 'Diffusion restreinte' });
    expect(prisma.confidentialite.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });

  it('crée un libellé neuf au rang max + 10', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.findMany.mockResolvedValue([{ confidentialiteId: 4, label: 'Secret' }]);
    await service.createConfidentialite({ label: 'Très secret' });
    expect(prisma.confidentialite.create).toHaveBeenCalledWith({
      data: { label: 'Très secret', rank: 40 },
    });
  });

  it('premier niveau d’un référentiel vide : rang 0', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.aggregate.mockResolvedValue({ _max: { rank: null } });
    await service.createConfidentialite({ label: 'Public' });
    expect(prisma.confidentialite.create).toHaveBeenCalledWith({ data: { label: 'Public', rank: 0 } });
  });

  it('course sur le rang (P2002 à l’écriture) rend 409', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.createConfidentialite({ label: 'Neuf' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('renommer en variante de casse d’un AUTRE niveau rend 409', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.findMany.mockResolvedValue([
      { confidentialiteId: 2, label: 'Interne' },
      { confidentialiteId: 4, label: 'Secret' },
    ]);
    await expect(service.updateConfidentialite(2, { label: 'secret' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.confidentialite.update).not.toHaveBeenCalled();
  });

  it('se renommer soi-même en changeant la casse reste permis', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.findMany.mockResolvedValue([{ confidentialiteId: 2, label: 'interne' }]);
    await service.updateConfidentialite(2, { label: 'Interne' });
    expect(prisma.confidentialite.update).toHaveBeenCalledWith({
      where: { confidentialiteId: 2 },
      data: { label: 'Interne' },
    });
  });

  it('désactiver un niveau inconnu rend 404 (P2025 brut auparavant)', async () => {
    const { service, prisma } = setup();
    prisma.confidentialite.findUnique.mockResolvedValue(null);
    await expect(service.deactivateConfidentialite(999)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.confidentialite.update).not.toHaveBeenCalled();
  });
});

describe('ReferentialsService — droits par type', () => {
  const base = { documentTypeId: 4, permissionLevelId: 2 };

  it('refuse le niveau « Denied » (1) sans rien écrire', async () => {
    const { service, prisma } = setup();
    await expect(
      service.grantTypePermission({ ...base, permissionLevelId: 1, roleId: 5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.documentTypePermission.create).not.toHaveBeenCalled();
  });

  it.each([
    ['type inconnu', (p: ReturnType<typeof setup>['prisma']) => p.documentType.findUnique.mockResolvedValue(null)],
    [
      'type désactivé',
      (p: ReturnType<typeof setup>['prisma']) =>
        p.documentType.findUnique.mockResolvedValue({ documentTypeId: 4, isActive: false }),
    ],
    ['niveau inconnu', (p: ReturnType<typeof setup>['prisma']) => p.permissionLevel.findUnique.mockResolvedValue(null)],
    ['rôle inconnu', (p: ReturnType<typeof setup>['prisma']) => p.role.findUnique.mockResolvedValue(null)],
  ])('%s → 400, pas de violation de clé étrangère (500)', async (_name, arrange) => {
    const { service, prisma } = setup();
    arrange(prisma);
    await expect(service.grantTypePermission({ ...base, roleId: 5 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.documentTypePermission.create).not.toHaveBeenCalled();
  });

  it('acteur (userGroupId) inconnu → 400', async () => {
    const { service, prisma } = setup();
    prisma.appUserGroup.findUnique.mockResolvedValue(null);
    await expect(service.grantTypePermission({ ...base, userGroupId: 99 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('octroi valide à un rôle, période convertie en dates', async () => {
    const { service, prisma } = setup();
    await service.grantTypePermission({
      ...base,
      roleId: 5,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(prisma.documentTypePermission.create).toHaveBeenCalledWith({
      data: {
        documentTypeId: 4,
        permissionLevelId: 2,
        roleId: 5,
        userGroupId: null,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
      },
    });
    expect(prisma.appUserGroup.findUnique).not.toHaveBeenCalled();
  });

  it('droit sur un document : clé étrangère violée (P2003) → 400', async () => {
    const { service, prisma } = setup();
    prisma.documentPermission.upsert.mockRejectedValue(prismaError('P2003'));
    await expect(
      service.grantDocumentPermission({ documentId: 999, userGroupId: 1, permissionLevelId: 2 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReferentialsService — parents des arborescences', () => {
  it.each([
    ['plan', 'classificationPlan', (s: ReferentialsService) => s.createPlan({ label: 'X', parentId: 3 })],
    ['géolocalisation', 'location', (s: ReferentialsService) => s.createLocation({ label: 'X', code: 'X', parentId: 3 })],
    ['dossier', 'dossier', (s: ReferentialsService) => s.createDossier({ label: 'X', parentId: 3 })],
  ] as const)('%s : un parent désactivé est refusé (400)', async (_n, model, act) => {
    const { service, prisma } = setup();
    prisma[model].findUnique.mockResolvedValue({ path: '/3/', depth: 0, isActive: false });
    await expect(act(service)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma[model].create).not.toHaveBeenCalled();
  });

  it('plan : un parent actif donne profondeur + 1 et le chemin enfant', async () => {
    const { service, prisma } = setup();
    prisma.classificationPlan.findUnique.mockResolvedValue({ path: '/3/', depth: 0, isActive: true });
    await service.createPlan({ label: 'Enfant', parentId: 3 });
    expect(prisma.classificationPlan.create).toHaveBeenCalledWith({
      data: { label: 'Enfant', code: null, parentId: 3, depth: 1, path: '/' },
    });
    expect(prisma.classificationPlan.update).toHaveBeenCalledWith({
      where: { planId: 31 },
      data: { path: '/3/31/' },
    });
  });

  it('dossier : déplacement sous un parent désactivé refusé (400)', async () => {
    const { service, prisma } = setup();
    prisma.dossier.findUnique
      .mockResolvedValueOnce({ dossierId: 8, path: '/8/', depth: 0, isActive: true })
      .mockResolvedValueOnce({ dossierId: 3, path: '/3/', depth: 0, isActive: false });
    await expect(service.reparentDossier(8, 3)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.dossier.update).not.toHaveBeenCalled();
  });

  it('dossier : création concurrente du même libellé (P2002) → 409', async () => {
    const { service, prisma } = setup();
    prisma.dossier.create.mockRejectedValue(prismaError('P2002'));
    await expect(service.createDossier({ label: 'Compta' })).rejects.toBeInstanceOf(ConflictException);
  });
});
