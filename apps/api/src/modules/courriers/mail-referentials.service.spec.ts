import { ConflictException } from '@nestjs/common';
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
    });

    const eav = () =>
      prisma as unknown as {
        externalEntity: { findUnique: jest.Mock };
        externalEntityCustomValue: { upsert: jest.Mock };
      };

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
});
