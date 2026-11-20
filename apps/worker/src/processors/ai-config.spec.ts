import { GedAiMode } from '@archivage/types';
import {
  AiConfigurationError,
  loadAiConfig,
  resolveAiApiKey,
  resolveEffectiveConfig,
  type AiSettingRow,
} from './ai-config';

const row = (over: Partial<AiSettingRow> = {}): AiSettingRow => ({
  mode: 1,
  provider: 'ollama',
  model: 'llama',
  endpoint: 'http://ia.local/v1',
  apiKeyRef: null,
  maskingEnabled: true,
  autoApplyThreshold: null,
  timeoutSeconds: 30,
  ...over,
});

describe('resolveAiApiKey', () => {
  it('refuse JWT_SECRET et toute référence hors liste blanche (erreur, plus ignorée)', () => {
    const env = { JWT_SECRET: 'secret-jwt', GED_AI_API_KEY: 'cle-ged' };
    expect(() => resolveAiApiKey('JWT_SECRET', env)).toThrow(AiConfigurationError);
    expect(() => resolveAiApiKey('DATABASE_URL', env, true)).toThrow(AiConfigurationError);
    try {
      resolveAiApiKey('JWT_SECRET', env);
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-jwt');
    }
  });

  it('accepte une référence GED_AI_* partout, avec repli sur GED_AI_API_KEY', () => {
    expect(resolveAiApiKey('GED_AI_PERSO', { GED_AI_PERSO: 'k1', GED_AI_API_KEY: 'k2' })).toBe(
      'k1',
    );
    expect(resolveAiApiKey('GED_AI_PERSO', { GED_AI_API_KEY: 'k2' })).toBe('k2');
  });

  it('OPENAI_API_KEY en référence : seulement si le cloud OpenAI est autorisé', () => {
    expect(resolveAiApiKey('OPENAI_API_KEY', { OPENAI_API_KEY: 'k3' }, true)).toBe('k3');
    expect(() => resolveAiApiKey('OPENAI_API_KEY', { OPENAI_API_KEY: 'k3' }, false)).toThrow(
      AiConfigurationError,
    );
  });

  it('référence vide : GED_AI_API_KEY puis OPENAI_API_KEY (si autorisé), sinon rien', () => {
    expect(resolveAiApiKey(null, { GED_AI_API_KEY: 'a', OPENAI_API_KEY: 'b' })).toBe('a');
    expect(resolveAiApiKey(null, { OPENAI_API_KEY: 'b' }, true)).toBe('b');
    expect(resolveAiApiKey('  ', { OPENAI_API_KEY: 'b' })).toBeNull();
    expect(resolveAiApiKey(null, {})).toBeNull();
  });
});

describe('resolveEffectiveConfig', () => {
  const cloudRow = (over: Partial<AiSettingRow> = {}) =>
    row({
      mode: 2,
      provider: 'openai',
      model: 'gpt-x',
      endpoint: 'https://api.openai.com/v1',
      apiKeyRef: 'OPENAI_API_KEY',
      ...over,
    });
  const ENV = { OPENAI_API_KEY: 'sk-test' };

  it('ligne absente ou mode 0 : désactivé, seuil null, même avec OPENAI_API_KEY', () => {
    for (const r of [null, row({ mode: 0 }), row({ mode: 0, provider: null }), row({ mode: 9 })]) {
      const cfg = resolveEffectiveConfig(r, ENV);
      expect(cfg.mode).toBe(GedAiMode.Desactivee);
      expect(cfg.threshold).toBeNull();
      expect(cfg.apiKey).toBeNull();
      expect(cfg.provider).toBeNull();
    }
    expect(
      resolveEffectiveConfig(row({ mode: 0, autoApplyThreshold: 0.9 }), ENV).threshold,
    ).toBeNull();
  });

  it('OPENAI_API_KEY + endpoint tiers => erreur de configuration', () => {
    expect(() =>
      resolveEffectiveConfig(cloudRow({ endpoint: 'https://api.openai.com.evil.test/v1' }), ENV),
    ).toThrow(AiConfigurationError);
    expect(() =>
      resolveEffectiveConfig(cloudRow({ endpoint: 'https://proxy.example.com/v1' }), ENV),
    ).toThrow(AiConfigurationError);
    expect(() => resolveEffectiveConfig(cloudRow({ provider: 'azure' }), ENV)).toThrow(
      AiConfigurationError,
    );
  });

  it('OPENAI_API_KEY explicite + endpoint http ou avec identifiants => erreur de configuration', () => {
    expect(() =>
      resolveEffectiveConfig(cloudRow({ endpoint: 'http://api.openai.com/v1' }), ENV),
    ).toThrow(AiConfigurationError);
    expect(() =>
      resolveEffectiveConfig(cloudRow({ endpoint: 'https://user:pw@api.openai.com/v1' }), ENV),
    ).toThrow(AiConfigurationError);
  });

  it('OPENAI_API_KEY implicite + endpoint http ou avec identifiants => aucune clé', () => {
    for (const endpoint of ['http://api.openai.com/v1', 'https://user:pw@api.openai.com/v1']) {
      expect(resolveEffectiveConfig(cloudRow({ endpoint, apiKeyRef: null }), ENV).apiKey).toBeNull();
    }
  });

  it('OPENAI_API_KEY + mode local => erreur de configuration', () => {
    expect(() => resolveEffectiveConfig(row({ apiKeyRef: 'OPENAI_API_KEY' }), ENV)).toThrow(
      AiConfigurationError,
    );
  });

  it('OPENAI_API_KEY + openai / api.openai.com => clé résolue', () => {
    expect(resolveEffectiveConfig(cloudRow(), ENV)).toMatchObject({
      mode: GedAiMode.Cloud,
      apiKey: 'sk-test',
      endpoint: 'https://api.openai.com/v1',
    });
    // Repli implicite (référence vide) autorisé dans ce seul cas.
    expect(resolveEffectiveConfig(cloudRow({ apiKeyRef: null }), ENV).apiKey).toBe('sk-test');
    // Endpoint vide => défaut OpenAI.
    expect(resolveEffectiveConfig(cloudRow({ endpoint: null }), ENV).apiKey).toBe('sk-test');
  });

  it('références GED_AI_* valables en local, cloud tiers et OpenAI', () => {
    const env = { GED_AI_PERSO: 'k' };
    expect(resolveEffectiveConfig(row({ apiKeyRef: 'GED_AI_PERSO' }), env).apiKey).toBe('k');
    expect(
      resolveEffectiveConfig(
        cloudRow({ endpoint: 'https://proxy.example.com/v1', apiKeyRef: 'GED_AI_PERSO' }),
        env,
      ).apiKey,
    ).toBe('k');
    expect(resolveEffectiveConfig(cloudRow({ apiKeyRef: 'GED_AI_PERSO' }), env).apiKey).toBe('k');
  });

  it('référence hors liste blanche => erreur', () => {
    expect(() =>
      resolveEffectiveConfig(row({ apiKeyRef: 'JWT_SECRET' }), { JWT_SECRET: 'x' }),
    ).toThrow(AiConfigurationError);
  });

  it('seuil Decimal converti en nombre, valeur hors [0,1] => null', () => {
    expect(
      resolveEffectiveConfig(row({ autoApplyThreshold: { toString: () => '0.800' } }), {})
        .threshold,
    ).toBe(0.8);
    expect(resolveEffectiveConfig(row({ autoApplyThreshold: 7 }), {}).threshold).toBeNull();
    expect(resolveEffectiveConfig(row(), {}).threshold).toBeNull();
  });

  it('local : endpoint de la ligne, sinon variable, sinon Ollama', () => {
    expect(
      resolveEffectiveConfig(row({ endpoint: null }), {
        GED_AI_LOCAL_ENDPOINT: 'http://gpu:8000/v1',
      }).endpoint,
    ).toBe('http://gpu:8000/v1');
    expect(resolveEffectiveConfig(row({ endpoint: null }), {}).endpoint).toBe(
      'http://localhost:11434/v1',
    );
  });
});

describe('loadAiConfig', () => {
  const prismaWith = (found: AiSettingRow | null) => {
    const findFirst = jest.fn().mockResolvedValue(found);
    return { prisma: { gedAiSetting: { findFirst } } as never, findFirst };
  };

  it('ligne absente : désactivé, seuil null (même avec OPENAI_API_KEY)', async () => {
    const { prisma, findFirst } = prismaWith(null);
    const cfg = await loadAiConfig(prisma, { OPENAI_API_KEY: 'sk' });
    expect(cfg).toMatchObject({ mode: GedAiMode.Desactivee, threshold: null, apiKey: null });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('mode 0 : désactivé, seuil null', async () => {
    const { prisma } = prismaWith(row({ mode: 0, autoApplyThreshold: 0.5 }));
    expect(await loadAiConfig(prisma, {})).toMatchObject({
      mode: GedAiMode.Desactivee,
      threshold: null,
    });
  });

  it('local : endpoint et seuil Decimal de la ligne', async () => {
    const { prisma } = prismaWith(row({ autoApplyThreshold: { toString: () => '0.850' } }));
    expect(await loadAiConfig(prisma, {})).toMatchObject({
      mode: GedAiMode.Locale,
      endpoint: 'http://ia.local/v1',
      threshold: 0.85,
      timeoutSeconds: 30,
    });
  });

  it('cloud : clé résolue depuis l’environnement fourni', async () => {
    const { prisma } = prismaWith(
      row({
        mode: 2,
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        apiKeyRef: 'OPENAI_API_KEY',
        autoApplyThreshold: { toString: () => '0.9' },
      }),
    );
    expect(await loadAiConfig(prisma, { OPENAI_API_KEY: 'sk-1' })).toMatchObject({
      mode: GedAiMode.Cloud,
      apiKey: 'sk-1',
      threshold: 0.9,
    });
  });

  it('cloud tiers + OPENAI_API_KEY : rejette avec AiConfigurationError', async () => {
    const { prisma } = prismaWith(
      row({
        mode: 2,
        provider: 'openai',
        endpoint: 'https://x.test/v1',
        apiKeyRef: 'OPENAI_API_KEY',
      }),
    );
    await expect(loadAiConfig(prisma, { OPENAI_API_KEY: 'sk-1' })).rejects.toBeInstanceOf(
      AiConfigurationError,
    );
  });
});
