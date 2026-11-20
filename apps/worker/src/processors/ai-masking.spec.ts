import { GedAiMaskingKind, GedAiMode } from '@archivage/types';
import { AiMaskingError, loadMaskingRules, maskForProvider } from './ai-masking';

const TEXT = 'Contact : jean.dupont@example.com pour le dossier Alpha.';

describe('loadMaskingRules', () => {
  it('lit les règles actives triées et les convertit', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { kind: 1, pattern: 'Alpha', replacement: '[X]' },
      { kind: 2, pattern: 'email', replacement: null },
    ]);
    const rules = await loadMaskingRules({ gedAiMaskingRule: { findMany } } as never);
    expect(findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { gedAiMaskingRuleId: 'asc' }],
      select: { kind: true, pattern: true, replacement: true },
    });
    expect(rules).toEqual([
      { kind: GedAiMaskingKind.Exact, pattern: 'Alpha', replacement: '[X]' },
      { kind: GedAiMaskingKind.Entite, pattern: 'email', replacement: null },
    ]);
  });
});

describe('maskForProvider', () => {
  const rules = [{ kind: GedAiMaskingKind.Exact, pattern: 'Alpha', replacement: '[DOSSIER]' }];

  it('cloud : entités par défaut + règles configurées', () => {
    const out = maskForProvider({ text: TEXT, mode: GedAiMode.Cloud, maskingEnabled: true, rules });
    expect(out.masked).toBe(true);
    expect(out.count).toBeGreaterThanOrEqual(2);
    expect(out.text).not.toContain('jean.dupont@example.com');
    expect(out.text).toContain('[DOSSIER]');
  });

  it('cloud avec masking_enabled=false : refus', () => {
    expect(() =>
      maskForProvider({ text: TEXT, mode: GedAiMode.Cloud, maskingEnabled: false, rules }),
    ).toThrow(AiMaskingError);
  });

  it('local masquage actif : règles seulement, pas d’entités par défaut', () => {
    const out = maskForProvider({ text: TEXT, mode: GedAiMode.Locale, maskingEnabled: true, rules });
    expect(out.masked).toBe(true);
    expect(out.text).toContain('[DOSSIER]');
    expect(out.text).toContain('jean.dupont@example.com');
  });

  it('local masquage inactif : texte inchangé, masked=false', () => {
    expect(
      maskForProvider({ text: TEXT, mode: GedAiMode.Locale, maskingEnabled: false, rules }),
    ).toEqual({ text: TEXT, masked: false, count: 0 });
  });

  it('règle invalide : échec fermé (AiMaskingError, texte jamais renvoyé)', () => {
    expect(() =>
      maskForProvider({
        text: TEXT,
        mode: GedAiMode.Locale,
        maskingEnabled: true,
        rules: [{ kind: GedAiMaskingKind.Regex, pattern: '(', replacement: null }],
      }),
    ).toThrow(AiMaskingError);
  });
});
