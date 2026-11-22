import { WF_AUTHORING_DESCRIPTION_MAX, WF_AUTHORING_DESCRIPTION_MIN } from '@archivage/types';
import { generateAuthoringSchema, wfAuthoringDefinitionIdSchema } from './authoring.dto';

describe('generateAuthoringSchema', () => {
  const ok = 'Valider les factures de plus de 5000 euros.';

  it('accepte une description et un type d’événement connu, et nettoie les bords', () => {
    const r = generateAuthoringSchema.parse({ description: `  ${ok}\u0000  `, triggerHint: 'mail.arrived' });
    expect(r).toEqual({ description: ok, triggerHint: 'mail.arrived' });
    expect(generateAuthoringSchema.parse({ description: ok })).toEqual({ description: ok });
  });

  it('refuse une description vide, blanche ou trop courte (message français)', () => {
    for (const d of ['', '   \n\t ', '\u0000​', 'x'.repeat(WF_AUTHORING_DESCRIPTION_MIN - 1)]) {
      expect(generateAuthoringSchema.safeParse({ description: d }).success).toBe(false);
    }
    const r = generateAuthoringSchema.safeParse({ description: 'court' });
    expect(r.success ? '' : r.error.issues[0].message).toMatch(/trop courte/);
  });

  it('refuse plus de 4000 caractères, accepte exactement 4000', () => {
    expect(generateAuthoringSchema.safeParse({ description: 'a'.repeat(WF_AUTHORING_DESCRIPTION_MAX) }).success).toBe(
      true,
    );
    const r = generateAuthoringSchema.safeParse({ description: 'a'.repeat(WF_AUTHORING_DESCRIPTION_MAX + 1) });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0].message).toMatch(/4000/);
    expect(generateAuthoringSchema.safeParse({ description: 'a'.repeat(100_000) }).success).toBe(false);
  });

  it('refuse un type d’événement inconnu, un champ inconnu et un type non texte', () => {
    expect(generateAuthoringSchema.safeParse({ description: ok, triggerHint: 'x.y' }).success).toBe(false);
    expect(generateAuthoringSchema.safeParse({ description: ok, extra: 1 }).success).toBe(false);
    expect(generateAuthoringSchema.safeParse({ description: ok, isLowRisk: true }).success).toBe(false);
    expect(generateAuthoringSchema.safeParse({ description: 42 }).success).toBe(false);
    expect(generateAuthoringSchema.safeParse({}).success).toBe(false);
  });
});

describe('wfAuthoringDefinitionIdSchema', () => {
  it('coerce un entier positif borné', () => {
    expect(wfAuthoringDefinitionIdSchema.parse('12')).toBe(12);
    expect(wfAuthoringDefinitionIdSchema.parse('2147483647')).toBe(2_147_483_647);
  });
  it('refuse 0, négatif, décimal, trop grand, texte', () => {
    for (const v of ['0', '-1', '1.5', '2147483648', 'abc']) {
      expect(wfAuthoringDefinitionIdSchema.safeParse(v).success).toBe(false);
    }
  });
});
