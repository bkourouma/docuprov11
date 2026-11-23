import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MailReferentialsService } from './mail-referentials.service';

describe('MailReferentialsService', () => {
  let prisma: {
    mailNature: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    mailConfidentialite: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: MailReferentialsService;

  beforeEach(() => {
    prisma = {
      mailNature: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ mailNatureId: 3 }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      mailConfidentialite: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ mailConfidentialiteId: 1 }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    service = new MailReferentialsService(prisma as never);
  });

  it('createNature compacte les espaces et crée quand le libellé est libre', async () => {
    await service.createNature('  Courrier   officiel  ');
    expect(prisma.mailNature.create).toHaveBeenCalledWith({ data: { label: 'Courrier officiel' } });
  });

  it('createNature rejette un doublon à la casse près (§16 — le bug corrigé)', async () => {
    prisma.mailNature.findMany.mockResolvedValue([{ mailNatureId: 3, label: 'Officiel' }]);
    await expect(service.createNature('officiel')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.createNature('  OFFICIEL ')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.mailNature.create).not.toHaveBeenCalled();
  });

  it('createNature rejette un doublon aux espaces près', async () => {
    prisma.mailNature.findMany.mockResolvedValue([{ mailNatureId: 3, label: 'Note de service' }]);
    await expect(service.createNature('notedeservice')).rejects.toBeInstanceOf(ConflictException);
  });

  it('createNature accepte un libellé réellement neuf', async () => {
    prisma.mailNature.findMany.mockResolvedValue([{ mailNatureId: 3, label: 'Officiel' }]);
    await service.createNature('Officieux');
    expect(prisma.mailNature.create).toHaveBeenCalledWith({ data: { label: 'Officieux' } });
  });

  it('updateNature laisse un élément changer sa propre casse', async () => {
    prisma.mailNature.findMany.mockResolvedValue([{ mailNatureId: 3, label: 'officiel' }]);
    await service.updateNature(3, 'Officiel');
    expect(prisma.mailNature.update).toHaveBeenCalledWith({
      where: { mailNatureId: 3 },
      data: { label: 'Officiel' },
    });
  });

  it('updateNature refuse de prendre le libellé d’un autre actif', async () => {
    prisma.mailNature.findMany.mockResolvedValue([
      { mailNatureId: 3, label: 'Officiel' },
      { mailNatureId: 4, label: 'Interne' },
    ]);
    await expect(service.updateNature(3, 'INTERNE')).rejects.toBeInstanceOf(ConflictException);
  });

  it('deactivateNature bascule is_active à false (pas de suppression physique)', async () => {
    await service.deactivateNature(3);
    expect(prisma.mailNature.update).toHaveBeenCalledWith({
      where: { mailNatureId: 3 },
      data: { isActive: false },
    });
  });

  describe('setCustomValue (EAV §17)', () => {
    beforeEach(() => {
      (prisma as Record<string, unknown>).externalEntity = { findUnique: jest.fn() };
      (prisma as Record<string, unknown>).externalEntityCustomValue = {
        upsert: jest.fn().mockResolvedValue({}),
      };
      (prisma as Record<string, unknown>).externalEntityCustomProperty = {
        findUnique: jest.fn().mockResolvedValue({ externalEntityCustomPropertyId: 5 }),
      };
    });

    const eav = () =>
      prisma as unknown as {
        externalEntity: { findUnique: jest.Mock };
        externalEntityCustomValue: { upsert: jest.Mock };
        externalEntityCustomProperty: { findUnique: jest.Mock };
      };

    it('lève NotFound (et non une violation de clé étrangère en 500) si la propriété est inconnue', async () => {
      eav().externalEntity.findUnique.mockResolvedValue({ externalEntityTypeId: 7, label: 'M' });
      eav().externalEntityCustomProperty.findUnique.mockResolvedValue(null);
      await expect(
        service.setCustomValue({
          externalEntityId: 3,
          externalEntityCustomPropertyId: 999,
          value: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(eav().externalEntityCustomValue.upsert).not.toHaveBeenCalled();
    });

    it('déduit le type depuis l’entité (jamais depuis le client)', async () => {
      eav().externalEntity.findUnique.mockResolvedValue({
        externalEntityTypeId: 7,
        label: 'Ministère',
      });

      await service.setCustomValue({
        externalEntityId: 3,
        externalEntityCustomPropertyId: 5,
        value: 'ABC',
      });

      expect(eav().externalEntityCustomValue.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            externalEntityId: 3,
            externalEntityCustomPropertyId: 5,
            value: 'ABC',
            externalEntityTypeId: 7,
          },
          update: { value: 'ABC', externalEntityTypeId: 7 },
        }),
      );
    });

    it('refuse une entité sans type (la colonne est NOT NULL) avec un message clair', async () => {
      eav().externalEntity.findUnique.mockResolvedValue({
        externalEntityTypeId: null,
        label: 'Sans type',
      });

      await expect(
        service.setCustomValue({
          externalEntityId: 3,
          externalEntityCustomPropertyId: 5,
          value: 'ABC',
        }),
      ).rejects.toThrow(/type d’entité externe|type d'entité externe/);
      expect(eav().externalEntityCustomValue.upsert).not.toHaveBeenCalled();
    });

    it('lève NotFound si l’entité n’existe pas', async () => {
      eav().externalEntity.findUnique.mockResolvedValue(null);
      await expect(
        service.setCustomValue({
          externalEntityId: 99,
          externalEntityCustomPropertyId: 5,
          value: 'x',
        }),
      ).rejects.toThrow(/introuvable/);
    });
  });

  describe('updateConfidentialite (endpoint qui manquait)', () => {
    it('renomme et normalise', async () => {
      await service.updateConfidentialite(1, '  Très   confidentiel ');
      expect(prisma.mailConfidentialite.update).toHaveBeenCalledWith({
        where: { mailConfidentialiteId: 1 },
        data: { label: 'Très confidentiel' },
      });
    });

    it('rejette un doublon à la casse près', async () => {
      prisma.mailConfidentialite.findMany.mockResolvedValue([
        { mailConfidentialiteId: 2, label: 'Secret' },
      ]);
      await expect(service.updateConfidentialite(1, 'secret')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('désactivation d’un identifiant inconnu (404, plus de P2025 en 500)', () => {
    it('deactivateNature lève NotFound sans écrire', async () => {
      prisma.mailNature.findUnique.mockResolvedValue(null);
      await expect(service.deactivateNature(999)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.mailNature.update).not.toHaveBeenCalled();
    });

    it('deactivateConfidentialite lève NotFound sans écrire', async () => {
      prisma.mailConfidentialite.findUnique.mockResolvedValue(null);
      await expect(service.deactivateConfidentialite(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.mailConfidentialite.update).not.toHaveBeenCalled();
    });

    it.each([
      ['mailObjet', 'deactivateObjet'],
      ['mailDepartType', 'deactivateDepartType'],
      ['externalEntityType', 'deactivateExternalEntityType'],
      ['externalEntity', 'deactivateExternalEntity'],
      ['externalEntityCustomProperty', 'deactivateCustomProperty'],
      ['mailInputationType', 'deactivateInputationType'],
    ] as const)('%s : %s lève NotFound sans écrire', async (model, method) => {
      const delegate = { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() };
      (prisma as Record<string, unknown>)[model] = delegate;
      await expect(
        (service[method] as (id: number) => Promise<unknown>).call(service, 999),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(delegate.update).not.toHaveBeenCalled();
    });
  });

  describe('types d’imputation système (5/10/14/17)', () => {
    let delegate: { findUnique: jest.Mock; update: jest.Mock };

    beforeEach(() => {
      delegate = {
        findUnique: jest.fn(async ({ where }: { where: { mailInputationTypeId: number } }) => ({
          mailInputationTypeId: where.mailInputationTypeId,
        })),
        update: jest.fn().mockResolvedValue({}),
      };
      (prisma as Record<string, unknown>).mailInputationType = delegate;
    });

    it.each([5, 10, 14, 17])('refuse de désactiver le type système %i (409)', async (id) => {
      await expect(service.deactivateInputationType(id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(delegate.update).not.toHaveBeenCalled();
    });

    it('désactive un type non système', async () => {
      await expect(service.deactivateInputationType(42)).resolves.toEqual({ deactivated: true });
      expect(delegate.update).toHaveBeenCalledWith({
        where: { mailInputationTypeId: 42 },
        data: { isActive: false },
      });
    });
  });

  describe('entité externe : type inconnu (400, plus de violation de clé étrangère)', () => {
    let entity: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    let type: { findUnique: jest.Mock };

    beforeEach(() => {
      entity = {
        findUnique: jest.fn().mockResolvedValue({ externalEntityId: 3 }),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      };
      type = { findUnique: jest.fn().mockResolvedValue(null) };
      Object.assign(prisma as Record<string, unknown>, {
        externalEntity: entity,
        externalEntityType: type,
      });
    });

    it('createExternalEntity refuse un type inexistant sans écrire', async () => {
      await expect(
        service.createExternalEntity({ label: 'Mairie', externalEntityTypeId: 999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(entity.create).not.toHaveBeenCalled();
    });

    it('updateExternalEntity refuse un type inexistant sans écrire', async () => {
      await expect(
        service.updateExternalEntity(3, { externalEntityTypeId: 999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(entity.update).not.toHaveBeenCalled();
    });

    it('createExternalEntity sans type ne consulte pas les types et normalise le nom', async () => {
      await service.createExternalEntity({ label: '  Mairie   de  Dakar ' });
      expect(type.findUnique).not.toHaveBeenCalled();
      expect(entity.create).toHaveBeenCalledWith({
        data: {
          label: 'Mairie de Dakar',
          email: null,
          telephone: null,
          externalEntityTypeId: null,
        },
      });
    });

    it('updateExternalEntity accepte de détacher le type (null)', async () => {
      await service.updateExternalEntity(3, { externalEntityTypeId: null });
      expect(type.findUnique).not.toHaveBeenCalled();
      expect(entity.update).toHaveBeenCalledWith({
        where: { externalEntityId: 3 },
        data: { externalEntityTypeId: null },
      });
    });

    it('createExternalEntity accepte un type existant', async () => {
      type.findUnique.mockResolvedValue({ externalEntityTypeId: 4 });
      await service.createExternalEntity({ label: 'Mairie', externalEntityTypeId: 4 });
      expect(entity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ externalEntityTypeId: 4 }) }),
      );
    });
  });
});
