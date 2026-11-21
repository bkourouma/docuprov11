import { GedAiMaskingKind } from '@archivage/types';
import { AiMaskingService } from './ai-masking.service';
import type { PrismaService } from '../prisma/prisma.service';

function build(rules: Array<{ kind: number; pattern: string; replacement: string }>) {
  const findMany = jest.fn().mockResolvedValue(rules);
  const service = new AiMaskingService({ gedAiMaskingRule: { findMany } } as unknown as PrismaService);
  return { service, findMany };
}

describe('AiMaskingService', () => {
  it('charge les règles actives dans l’ordre et applique règles + entités par défaut en cloud', async () => {
    const { service, findMany } = build([
      { kind: GedAiMaskingKind.Exact, pattern: 'ACME', replacement: '[SOCIÉTÉ]' },
    ]);
    const r = await service.mask('ACME écrit à jean@exemple.com', { cloud: true });
    expect(findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { gedAiMaskingRuleId: 'asc' }],
    });
    expect(r.text).toBe('[SOCIÉTÉ] écrit à [EMAIL]');
    expect(r.masked).toBe(true);
    expect(r.count).toBe(2);
  });

  it('cloud : masque même si maskingEnabled=false (le refus relève d’AiService)', async () => {
    const { service } = build([]);
    const r = await service.mask('jean@exemple.com', { cloud: true, maskingEnabled: false });
    expect(r.text).toBe('[EMAIL]');
  });

  it('local avec masquage actif : règles de la table seulement, sans entités par défaut', async () => {
    const { service } = build([{ kind: GedAiMaskingKind.Exact, pattern: 'secret', replacement: '[X]' }]);
    const r = await service.mask('secret jean@exemple.com', { cloud: false, maskingEnabled: true });
    expect(r.text).toBe('[X] jean@exemple.com');
    expect(r.masked).toBe(true);
  });

  it('local avec masquage coupé : texte intact, aucune lecture de règles', async () => {
    const { service, findMany } = build([{ kind: GedAiMaskingKind.Exact, pattern: 'secret', replacement: '[X]' }]);
    const r = await service.mask('secret', { cloud: false, maskingEnabled: false });
    expect(r).toEqual({ text: 'secret', count: 0, masked: false });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('échoue fermé sur une règle invalide', async () => {
    const { service } = build([{ kind: GedAiMaskingKind.Regex, pattern: '(', replacement: '[X]' }]);
    await expect(service.mask('texte', { cloud: true })).rejects.toThrow(/Règle de masquage invalide/);
  });
});
