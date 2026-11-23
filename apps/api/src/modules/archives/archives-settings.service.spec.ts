import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MetaDataType } from '@archivage/types';
import type { PrismaService } from '../prisma/prisma.service';
import { ArchivesSettingsService, MAX_LIFESPAN_MONTHS } from './archives-settings.service';

/**
 * Prisma minimal pour le paramétrage Docu-Archives : quelques lignes connues par table, et des
 * écritures qui ne font qu'enregistrer leur appel. Une écriture atteinte avec une référence
 * inexistante est exactement le défaut corrigé (la base lèverait P2003 → 500) : les tests
 * vérifient donc qu'aucune n'est atteinte dans ce cas.
 */
function setup() {
  const byId = <K extends string>(key: K, ids: number[]) =>
    jest.fn(async ({ where }: { where: Record<K, number> }) =>
      ids.includes(where[key]) ? { [key]: where[key] } : null,
    );
  const metaDatas = new Map<number, { metaDataId: number; isActive: boolean; dataType: number }>([
    [10, { metaDataId: 10, isActive: true, dataType: MetaDataType.Liste }],
    [11, { metaDataId: 11, isActive: true, dataType: MetaDataType.Texte }],
    [12, { metaDataId: 12, isActive: false, dataType: MetaDataType.Liste }],
  ]);
  const writes: string[] = [];
  const write = (name: string) =>
    jest.fn(async () => {
      writes.push(name);
      return { count: 1 };
    });

  const prisma: Record<string, unknown> = {
    documentType: {
      findUnique: byId('documentTypeId', [1, 2]),
      findMany: jest.fn(async ({ where }: { where: { documentTypeId: { in: number[] } } }) =>
        where.documentTypeId.in
          .filter((id) => [1, 2].includes(id))
          .map((documentTypeId) => ({
            documentTypeId,
          })),
      ),
    },
    dossier: { findUnique: byId('dossierId', [5]) },
    classificationPlan: { findUnique: byId('planId', [6]) },
    confidentialite: { findUnique: byId('confidentialiteId', [7]) },
    finalFate: { findUnique: byId('finalFateId', [8]) },
    destructionMode: { findUnique: byId('destructionModeId', [9]) },
    document: { findUnique: byId('documentId', [100]) },
    metaData: {
      findUnique: jest.fn(
        async ({ where }: { where: { metaDataId: number } }) =>
          metaDatas.get(where.metaDataId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: { metaDataId: { in: number[] } } }) =>
        where.metaDataId.in.filter((id) => metaDatas.has(id)).map((metaDataId) => ({ metaDataId })),
      ),
    },
    metaDataListItem: {
      findUnique: jest.fn(async ({ where }: { where: { metaDataListItemId: number } }) =>
        where.metaDataListItemId === 50
          ? { metaDataListItemId: 50, metaDataId: 10, label: 'Haute', isActive: true }
          : null,
      ),
      findMany: jest.fn(async () => []),
      create: write('metaDataListItem.create'),
      update: write('metaDataListItem.update'),
    },
    documentTypeSetting: { upsert: write('documentTypeSetting.upsert') },
    documentTypeLifeCycle: { upsert: write('documentTypeLifeCycle.upsert') },
    documentLifeCycle: { upsert: write('documentLifeCycle.upsert') },
    metaDataDocumentType: {
      createMany: write('metaDataDocumentType.createMany'),
      deleteMany: write('metaDataDocumentType.deleteMany'),
    },
    // La transaction rejoue le callback sur le même faux client.
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(prisma),
    ),
  };
  const service = new ArchivesSettingsService(prisma as unknown as PrismaService);
  return { service, writes };
}

describe('ArchivesSettingsService — références du corps (ANO-ARC-T4-01)', () => {
  it('paramétrage d’un type : dossier, plan ou confidentialité inexistant → 400 sans écriture', async () => {
    const { service, writes } = setup();
    for (const extra of [{ dossierId: 999 }, { planId: 999 }, { confidentialiteId: 999 }]) {
      await expect(
        service.saveDocumentTypeSetting({ documentTypeId: 1, ...extra }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(writes).toEqual([]);
  });

  it('paramétrage d’un type : références connues ou vides → enregistré', async () => {
    const { service, writes } = setup();
    await service.saveDocumentTypeSetting({
      documentTypeId: 1,
      dossierId: 5,
      planId: 6,
      confidentialiteId: 7,
    });
    await service.saveDocumentTypeSetting({ documentTypeId: 1, dossierId: null });
    expect(writes).toEqual(['documentTypeSetting.upsert', 'documentTypeSetting.upsert']);
  });

  it('type de document inexistant : reste un 404 (clé métier)', async () => {
    const { service } = setup();
    await expect(service.saveDocumentTypeSetting({ documentTypeId: 999 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cycle de vie d’un type : sort final ou mode inexistant → 400 sans écriture', async () => {
    const { service, writes } = setup();
    const base = { documentTypeId: 1, usefulnessLifespan: 12, complianceLifespan: 24 };
    await expect(
      service.saveDocumentTypeLifeCycle({ ...base, finalFateId: 999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.saveDocumentTypeLifeCycle({ ...base, destructionModeId: 999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toEqual([]);
    await service.saveDocumentTypeLifeCycle({ ...base, finalFateId: 8, destructionModeId: 9 });
    expect(writes).toEqual(['documentTypeLifeCycle.upsert']);
  });

  it('cycle de vie d’un document : mêmes contrôles', async () => {
    const { service, writes } = setup();
    await expect(
      service.saveDocumentLifeCycle(
        {
          documentId: 100,
          usefulnessLifespan: '2030-01-01',
          complianceLifespan: '2040-01-01',
          finalFateId: 999,
        },
        null,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toEqual([]);
  });

  it('association types × métadonnées : identifiant inconnu → 400 qui le nomme', async () => {
    const { service, writes } = setup();
    await expect(
      service.linkMetaDataDocumentTypes({ documentTypeIds: [1, 999], metaDataIds: [10] }),
    ).rejects.toThrow('Type(s) de document introuvable(s) : 999');
    await expect(
      service.linkMetaDataDocumentTypes({ documentTypeIds: [1], metaDataIds: [10, 998] }),
    ).rejects.toThrow('Métadonnée(s) introuvable(s) : 998');
    await expect(
      service.setMetaDatasForType({ documentTypeId: 1, metaDataIds: [998] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toEqual([]);

    await service.linkMetaDataDocumentTypes({ documentTypeIds: [1, 2], metaDataIds: [10, 11] });
    // Liste vide = « plus aucune métadonnée » : toujours permis.
    await service.setMetaDatasForType({ documentTypeId: 1, metaDataIds: [] });
    expect(writes).toEqual([
      'metaDataDocumentType.createMany',
      'metaDataDocumentType.deleteMany',
      'metaDataDocumentType.createMany',
    ]);
  });
});

describe('ArchivesSettingsService — durées de conservation (ANO-ARC-T4-03)', () => {
  it('refuse une durée au-delà de la borne, en mois, avant toute écriture', async () => {
    const { service, writes } = setup();
    for (const extra of [
      { usefulnessLifespan: MAX_LIFESPAN_MONTHS + 1 },
      { complianceLifespan: MAX_LIFESPAN_MONTHS + 1 },
      { usefulnessLifespan: 2 ** 31 },
    ]) {
      await expect(
        service.saveDocumentTypeLifeCycle({
          documentTypeId: 1,
          usefulnessLifespan: 12,
          complianceLifespan: 24,
          ...extra,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(writes).toEqual([]);
  });

  it('admet 0 (échu d’office) et la borne elle-même', async () => {
    const { service, writes } = setup();
    await service.saveDocumentTypeLifeCycle({
      documentTypeId: 1,
      usefulnessLifespan: 0,
      complianceLifespan: MAX_LIFESPAN_MONTHS,
    });
    expect(writes).toEqual(['documentTypeLifeCycle.upsert']);
  });
});

describe('ArchivesSettingsService — valeurs de liste (ANO-ARC-T4-02)', () => {
  it('refuse une valeur sur une métadonnée qui n’est pas une liste, ou désactivée', async () => {
    const { service, writes } = setup();
    await expect(
      service.createMetaDataListItems({ metaDataId: 11, labels: ['Haute'] }),
    ).rejects.toThrow('Seule une métadonnée de type « Liste de valeurs » peut porter des valeurs');
    await expect(
      service.createMetaDataListItems({ metaDataId: 12, labels: ['Haute'] }),
    ).rejects.toThrow('Cette métadonnée est désactivée');
    await expect(
      service.createMetaDataListItems({ metaDataId: 999, labels: ['Haute'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(writes).toEqual([]);
  });

  it('crée les valeurs d’une liste active', async () => {
    const { service, writes } = setup();
    await expect(
      service.createMetaDataListItems({ metaDataId: 10, labels: ['Haute', 'Basse'] }),
    ).resolves.toEqual({ created: 2, skipped: [] });
    expect(writes).toEqual(['metaDataListItem.create', 'metaDataListItem.create']);
  });

  it('refuse de rattacher une valeur à une métadonnée inexistante ou non-liste', async () => {
    const { service, writes } = setup();
    await expect(service.updateMetaDataListItem(50, { metaDataId: 999 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.updateMetaDataListItem(50, { metaDataId: 11 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(writes).toEqual([]);
    await service.updateMetaDataListItem(50, { label: 'Très haute' });
    expect(writes).toEqual(['metaDataListItem.update']);
  });
});
