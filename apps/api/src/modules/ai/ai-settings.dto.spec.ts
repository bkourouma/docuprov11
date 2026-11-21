import { updateAiSettingsSchema } from './ai-settings.dto';

describe('updateAiSettingsSchema', () => {
  it('accepte un corps partiel valide et un corps vide', () => {
    expect(updateAiSettingsSchema.safeParse({}).success).toBe(true);
    expect(
      updateAiSettingsSchema.safeParse({
        mode: 2,
        provider: 'openai',
        apiKeyRef: 'GED_AI_API_KEY',
        autoApplyThreshold: 0.8,
        timeoutSeconds: 30,
        embeddingDimension: 1024,
      }).success,
    ).toBe(true);
  });

  it('refuse un champ inconnu (strict)', () => {
    expect(updateAiSettingsSchema.safeParse({ mode: 1, extra: 1 }).success).toBe(false);
  });

  it.each([-0.01, 1.01])('autoApplyThreshold %p hors 0..1 refusé', (v) => {
    expect(updateAiSettingsSchema.safeParse({ autoApplyThreshold: v }).success).toBe(false);
  });

  it('autoApplyThreshold : bornes 0 et 1 et null acceptés', () => {
    for (const v of [0, 1, null]) {
      expect(updateAiSettingsSchema.safeParse({ autoApplyThreshold: v }).success).toBe(true);
    }
  });

  it.each([0, 601, 1.5, -1])('timeoutSeconds %p refusé', (v) => {
    expect(updateAiSettingsSchema.safeParse({ timeoutSeconds: v }).success).toBe(false);
  });

  it('timeoutSeconds : 1 et 600 acceptés', () => {
    expect(updateAiSettingsSchema.safeParse({ timeoutSeconds: 1 }).success).toBe(true);
    expect(updateAiSettingsSchema.safeParse({ timeoutSeconds: 600 }).success).toBe(true);
  });

  it.each([3, -1, '1'])('mode %p refusé', (v) => {
    expect(updateAiSettingsSchema.safeParse({ mode: v }).success).toBe(false);
  });

  it('embeddingDimension doit être un entier', () => {
    expect(updateAiSettingsSchema.safeParse({ embeddingDimension: 10.5 }).success).toBe(false);
    expect(updateAiSettingsSchema.safeParse({ embeddingDimension: 768 }).success).toBe(true);
  });

  it('chaînes bornées par la longueur des colonnes', () => {
    expect(updateAiSettingsSchema.safeParse({ provider: 'p'.repeat(51) }).success).toBe(false);
    expect(updateAiSettingsSchema.safeParse({ provider: 'p'.repeat(50) }).success).toBe(true);
    expect(updateAiSettingsSchema.safeParse({ model: 'm'.repeat(201) }).success).toBe(false);
    expect(updateAiSettingsSchema.safeParse({ embeddingModel: 'm'.repeat(201) }).success).toBe(false);
    expect(updateAiSettingsSchema.safeParse({ endpoint: 'e'.repeat(501) }).success).toBe(false);
    expect(updateAiSettingsSchema.safeParse({ apiKeyRef: `GED_AI_${'A'.repeat(200)}` }).success).toBe(false);
  });

  it('une chaîne vide devient null', () => {
    const r = updateAiSettingsSchema.parse({ provider: '  ', apiKeyRef: '' });
    expect(r.provider).toBeNull();
    expect(r.apiKeyRef).toBeNull();
  });

  it('apiKeyRef : refuse une valeur qui ressemble à une clé ou hors forme', () => {
    for (const v of ['sk-abc123', 'ged_ai_x', 'PATH', 'GED_AI_', 'GED_AI_A B']) {
      expect(updateAiSettingsSchema.safeParse({ apiKeyRef: v }).success).toBe(false);
    }
    for (const v of ['OPENAI_API_KEY', 'GED_AI_API_KEY', 'GED_AI_MA_CLE_2']) {
      expect(updateAiSettingsSchema.safeParse({ apiKeyRef: v }).success).toBe(true);
    }
  });
});
