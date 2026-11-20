import { GED_AI_DEFAULT_CLOUD_MODEL, GedAiMode } from '@archivage/types';
import { AiConfigurationError, createProvider } from './ai-provider.factory';
import type { AiEffectiveConfig } from './ai.types';

function config(over: Partial<AiEffectiveConfig> = {}): AiEffectiveConfig {
  return {
    mode: GedAiMode.Desactivee,
    provider: null,
    model: null,
    embeddingModel: null,
    embeddingDimension: 1024,
    endpoint: null,
    apiKeyRef: null,
    maskingEnabled: true,
    autoApplyThreshold: null,
    timeoutSeconds: 30,
    ...over,
  };
}

/** Appelle `complete` avec un fetch simulé et rend l'appel (url + en-têtes). */
async function probe(over: Partial<AiEffectiveConfig>, env: Record<string, string | undefined>) {
  const fetchMock = jest.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: 'x' } }], output_text: 'x' }),
      { status: 200 },
    ),
  );
  const provider = createProvider(config(over), { env, fetchImpl: fetchMock as unknown as typeof fetch });
  await provider.complete({ system: 's', text: 't' });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { provider, url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}

describe('createProvider', () => {
  it('mode 0 => fournisseur désactivé', () => {
    const p = createProvider(config({ mode: GedAiMode.Desactivee }), { env: {} });
    expect(p.kind).toBe('disabled');
  });

  it('mode 1 => fournisseur local (endpoint obligatoire)', () => {
    const p = createProvider(
      config({ mode: GedAiMode.Locale, endpoint: 'http://localhost:11434/v1', model: 'llama', provider: 'ollama' }),
      { env: {} },
    );
    expect(p.kind).toBe('local');
    expect(p.name).toBe('ollama');
    expect(p.model).toBe('llama');
  });

  it('mode 1 sans endpoint ou sans modèle => erreur claire', () => {
    expect(() => createProvider(config({ mode: GedAiMode.Locale, model: 'm' }), { env: {} })).toThrow(
      /endpoint est obligatoire/,
    );
    expect(() =>
      createProvider(config({ mode: GedAiMode.Locale, endpoint: 'http://h/v1' }), { env: {} }),
    ).toThrow(AiConfigurationError);
  });

  it('mode 2 => cloud OpenAI par défaut (endpoint, modèle, clé OPENAI_API_KEY)', async () => {
    const { provider, url, headers } = await probe({ mode: GedAiMode.Cloud }, { OPENAI_API_KEY: 'k-openai' });
    expect(provider.kind).toBe('cloud');
    expect(provider.name).toBe('openai');
    expect(provider.model).toBe(GED_AI_DEFAULT_CLOUD_MODEL);
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.Authorization).toBe('Bearer k-openai');
  });

  it('résolution de clé : apiKeyRef > GED_AI_API_KEY > OPENAI_API_KEY', async () => {
    const env = { GED_AI_MY_KEY: 'k-ref', GED_AI_API_KEY: 'k-generic', OPENAI_API_KEY: 'k-openai' };
    expect((await probe({ mode: 2, apiKeyRef: 'GED_AI_MY_KEY' }, env)).headers.Authorization).toBe('Bearer k-ref');
    expect((await probe({ mode: 2 }, env)).headers.Authorization).toBe('Bearer k-generic');
    expect(
      (await probe({ mode: 2, apiKeyRef: 'GED_AI_ABSENT' }, { OPENAI_API_KEY: 'k-openai' })).headers.Authorization,
    ).toBe('Bearer k-openai');
  });

  it('refuse un apiKeyRef hors liste blanche (ex. JWT_SECRET)', () => {
    expect(() =>
      createProvider(config({ mode: 2, apiKeyRef: 'JWT_SECRET' }), { env: { JWT_SECRET: 'x', GED_AI_API_KEY: 'y' } }),
    ).toThrow(/référence de clé API refusée/);
  });

  it('cloud sans clé => erreur de configuration', () => {
    expect(() => createProvider(config({ mode: 2 }), { env: {} })).toThrow(/aucune clé API/);
  });

  it('cloud : endpoint https exigé, http toléré sur localhost', () => {
    const env = { GED_AI_API_KEY: 'k' };
    expect(() => createProvider(config({ mode: 2, endpoint: 'http://api.exemple.com/v1' }), { env })).toThrow(
      /https/,
    );
    expect(() => createProvider(config({ mode: 2, endpoint: 'pas une url' }), { env })).toThrow(AiConfigurationError);
    expect(createProvider(config({ mode: 2, endpoint: 'http://localhost:8000/v1' }), { env }).kind).toBe('cloud');
    expect(createProvider(config({ mode: 2, endpoint: 'http://127.0.0.1:8000/v1' }), { env }).kind).toBe('cloud');
  });

  it('OPENAI_API_KEY implicite n’est pas envoyée à un endpoint tiers', () => {
    expect(() =>
      createProvider(config({ mode: 2, provider: 'mistral', endpoint: 'https://api.mistral.ai/v1' }), {
        env: { OPENAI_API_KEY: 'k-openai' },
      }),
    ).toThrow(AiConfigurationError);
  });

  it('référence OPENAI_API_KEY + endpoint tiers (ou fournisseur tiers) => AiConfigurationError sans clé', () => {
    const env = { OPENAI_API_KEY: 'k-openai-secret' };
    for (const over of [
      { provider: 'openai', endpoint: 'https://api.mistral.ai/v1' },
      { provider: 'mistral', endpoint: 'https://api.openai.com/v1' },
      { provider: 'openai', endpoint: 'http://localhost:8000/v1' },
    ]) {
      const err = (() => {
        try {
          createProvider(config({ mode: 2, apiKeyRef: 'OPENAI_API_KEY', ...over }), { env });
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(AiConfigurationError);
      expect((err as Error).message).not.toContain('k-openai-secret');
    }
  });

  it('endpoint avec identifiants (local et cloud) => AiConfigurationError', () => {
    const env = { GED_AI_API_KEY: 'k' };
    expect(() =>
      createProvider(config({ mode: 1, model: 'm', endpoint: 'http://user:pw@localhost:11434/v1' }), { env }),
    ).toThrow(AiConfigurationError);
    expect(() =>
      createProvider(config({ mode: 2, endpoint: 'https://user:pw@api.exemple.com/v1' }), { env }),
    ).toThrow(AiConfigurationError);
  });

  it('référence OPENAI_API_KEY + mode local => AiConfigurationError', () => {
    expect(() =>
      createProvider(
        config({ mode: 1, endpoint: 'http://localhost:11434/v1', model: 'm', apiKeyRef: 'OPENAI_API_KEY' }),
        { env: { OPENAI_API_KEY: 'k' } },
      ),
    ).toThrow(AiConfigurationError);
  });

  it('mode local : OPENAI_API_KEY implicite jamais envoyée', async () => {
    const { headers } = await probe(
      { mode: 1, endpoint: 'http://localhost:11434/v1', model: 'm' },
      { OPENAI_API_KEY: 'k-openai' },
    );
    expect(headers.Authorization).toBeUndefined();
  });

  it('référence OPENAI_API_KEY + openai + api.openai.com => OK', async () => {
    const { headers, url } = await probe(
      { mode: 2, provider: 'openai', endpoint: 'https://api.openai.com/v1', apiKeyRef: 'OPENAI_API_KEY' },
      { OPENAI_API_KEY: 'k-openai' },
    );
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(headers.Authorization).toBe('Bearer k-openai');
  });

  it('références GED_AI_* valables partout (local, cloud tiers)', async () => {
    const env = { GED_AI_K: 'k-ged' };
    const local = await probe(
      { mode: 1, endpoint: 'http://localhost:11434/v1', model: 'm', apiKeyRef: 'GED_AI_K' },
      env,
    );
    expect(local.headers.Authorization).toBe('Bearer k-ged');
    const tiers = await probe(
      { mode: 2, provider: 'mistral', endpoint: 'https://api.mistral.ai/v1', apiKeyRef: 'GED_AI_K' },
      env,
    );
    expect(tiers.headers.Authorization).toBe('Bearer k-ged');
  });

  it('timeout = timeoutSeconds (AbortController)', async () => {
    const fetchMock = jest.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_r, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const p = createProvider(
      config({ mode: GedAiMode.Locale, endpoint: 'http://localhost:1/v1', model: 'm', timeoutSeconds: 0.05 }),
      { env: {}, fetchImpl: fetchMock as unknown as typeof fetch },
    );
    await expect(p.complete({ system: 's', text: 't' })).rejects.toThrow(/Délai dépassé/);
  });
});
