import { GedAiMode } from '@archivage/types';
import type { EffectiveAiConfig } from './ai-config';
import { AiProviderError, createAiProvider, type FetchLike } from './ai-providers';

const cfg = (over: Partial<EffectiveAiConfig> = {}): EffectiveAiConfig => ({
  mode: GedAiMode.Cloud,
  provider: 'openai',
  model: 'm',
  endpoint: 'https://api.example.com/v1/',
  apiKey: 'sk-secret-123',
  maskingEnabled: true,
  threshold: null,
  timeoutSeconds: 5,
  ...over,
});

const req = { system: 's', user: 'u', schemaName: 'x', jsonSchema: { type: 'object' } };

const okResponse = (content = '{"a":1}') =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }),
    { status: 200 },
  );

describe('createAiProvider', () => {
  it('mode désactivé : aucun fournisseur', () => {
    expect(() => createAiProvider(cfg({ mode: GedAiMode.Desactivee }))).toThrow(AiProviderError);
  });

  it('cloud : exige https (sauf localhost) et une clé', () => {
    expect(() => createAiProvider(cfg({ endpoint: 'http://api.example.com/v1' }))).toThrow(/https/);
    expect(() => createAiProvider(cfg({ apiKey: null }))).toThrow(/Clé/);
    expect(() => createAiProvider(cfg({ endpoint: 'http://localhost:8080/v1' }))).not.toThrow();
  });

  it('appelle chat/completions avec json_schema, Bearer, et renvoie contenu et jetons', async () => {
    const fetchMock = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValue(okResponse());
    const res = await createAiProvider(cfg(), fetchMock).complete(req);
    expect(res).toEqual({ content: '{"a":1}', promptTokens: 12, completionTokens: 3 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret-123');
    expect(JSON.parse(String(init.body)).response_format.type).toBe('json_schema');
  });

  it('ne suit jamais les redirections (redirect: error)', async () => {
    const fetchMock = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValue(okResponse());
    await createAiProvider(cfg(), fetchMock).complete(req);
    expect(fetchMock.mock.calls[0]![1].redirect).toBe('error');
  });

  it('endpoint avec identifiants (cloud et local) : refusé sans appel réseau', async () => {
    const fetchMock = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValue(okResponse());
    const configs = [
      cfg({ endpoint: 'https://user:pw@api.example.com/v1' }),
      cfg({ mode: GedAiMode.Locale, endpoint: 'http://user:pw@gpu:8000/v1', apiKey: null }),
    ];
    for (const c of configs) {
      const run = async () => createAiProvider(c, fetchMock).complete(req);
      await expect(run()).rejects.toBeInstanceOf(AiProviderError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('local : pas d’en-tête Authorization sans clé', async () => {
    const fetchMock = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValue(okResponse());
    await createAiProvider(
      cfg({ mode: GedAiMode.Locale, endpoint: 'http://gpu:8000/v1', apiKey: null }),
      fetchMock,
    ).complete(req);
    expect(
      (fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it('erreur HTTP : message sûr, sans clé ni corps', async () => {
    const fetchMock = jest
      .fn<ReturnType<FetchLike>, Parameters<FetchLike>>()
      .mockResolvedValue(new Response('Incorrect API key sk-secret-123', { status: 401 }));
    const err = await createAiProvider(cfg(), fetchMock)
      .complete(req)
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).not.toContain('sk-secret-123');
  });

  it('délai dépassé : abandonne via AbortController', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      const p = createAiProvider(cfg({ timeoutSeconds: 2 }), fetchMock).complete(req);
      const assertion = expect(p).rejects.toThrow(/délai/);
      await jest.advanceTimersByTimeAsync(2100);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});
