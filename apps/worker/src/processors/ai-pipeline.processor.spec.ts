import { GedAiMode } from '@archivage/types';
import { AiConfigurationError } from './ai-config';
import { applyEmptyFieldsPatch, createAiPipelineDeps } from './ai-pipeline.processor';

describe('applyEmptyFieldsPatch', () => {
  it('un updateMany par champ fourni, filtré sur champ nul', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    await applyEmptyFieldsPatch({ document: { updateMany } } as never, 7, {
      documentTypeId: 10,
      documentDate: '2026-03-15',
      overview: 'Résumé',
    });
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { documentId: 7, documentTypeId: null },
      data: { documentTypeId: 10 },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { documentId: 7, documentDate: null },
      data: { documentDate: new Date('2026-03-15T00:00:00Z') },
    });
    expect(updateMany).toHaveBeenNthCalledWith(3, {
      where: { documentId: 7, overview: null },
      data: { overview: 'Résumé' },
    });
  });

  it('patch vide : aucune écriture ; champ partiel : une seule', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { document: { updateMany } } as never;
    await applyEmptyFieldsPatch(prisma, 1, {});
    expect(updateMany).not.toHaveBeenCalled();
    await applyEmptyFieldsPatch(prisma, 1, { overview: 'x' });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('createAiPipelineDeps', () => {
  const build = () => {
    const prisma = {
      gedAiSetting: { findFirst: jest.fn().mockResolvedValue(null) },
      gedAiMaskingRule: { findMany: jest.fn().mockResolvedValue([]) },
      gedAiDecision: { create: jest.fn().mockResolvedValue({ gedAiDecisionId: 5n }) },
      document: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      documentType: { findMany: jest.fn() },
    };
    return { prisma, deps: createAiPipelineDeps(prisma as never, {}) };
  };

  it('loadDocument : textes OCR de la version courante, dans l’ordre', async () => {
    const { prisma, deps } = build();
    prisma.document.findUnique.mockResolvedValue({
      versions: [{ files: [{ ocrText: 'p1' }, { ocrText: null }] }],
    });
    expect(await deps.loadDocument(3)).toEqual({ ocrTexts: ['p1', null] });
    expect(prisma.document.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: 3 } }),
    );
  });

  it('loadDocument : document absent => null ; sans version => liste vide', async () => {
    const { prisma, deps } = build();
    prisma.document.findUnique.mockResolvedValueOnce(null);
    expect(await deps.loadDocument(3)).toBeNull();
    prisma.document.findUnique.mockResolvedValueOnce({ versions: [] });
    expect(await deps.loadDocument(3)).toEqual({ ocrTexts: [] });
  });

  it('listDocumentTypes : types actifs convertis en {id, label}', async () => {
    const { prisma, deps } = build();
    prisma.documentType.findMany.mockResolvedValue([{ documentTypeId: 10, label: 'Facture' }]);
    expect(await deps.listDocumentTypes()).toEqual([{ id: 10, label: 'Facture' }]);
  });

  it('loadConfig : IA désactivée sans ligne, même avec OPENAI_API_KEY', async () => {
    const { prisma } = build();
    const deps = createAiPipelineDeps(prisma as never, { OPENAI_API_KEY: 'sk' });
    expect((await deps.loadConfig()).mode).toBe(GedAiMode.Desactivee);
  });

  it('loadConfig : configuration interdite => AiConfigurationError', async () => {
    const { prisma } = build();
    prisma.gedAiSetting.findFirst.mockResolvedValue({
      mode: 1,
      provider: 'ollama',
      model: 'm',
      endpoint: 'http://ia.local/v1',
      apiKeyRef: 'OPENAI_API_KEY',
      maskingEnabled: true,
      autoApplyThreshold: null,
      timeoutSeconds: 30,
    });
    const deps = createAiPipelineDeps(prisma as never, { OPENAI_API_KEY: 'sk' });
    await expect(deps.loadConfig()).rejects.toBeInstanceOf(AiConfigurationError);
  });

  it('writeDecision et applyDocumentPatch délèguent à Prisma', async () => {
    const { prisma, deps } = build();
    expect(await deps.loadMaskingRules()).toEqual([]);
    await deps.applyDocumentPatch(2, { overview: 'o' });
    expect(prisma.document.updateMany).toHaveBeenCalledTimes(1);
  });
});
