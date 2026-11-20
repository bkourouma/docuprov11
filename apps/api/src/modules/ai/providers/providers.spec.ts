import { AiDisabledError, AiProviderError, AiUnsupportedInputError } from '../ai.types';
import { DisabledProvider } from './disabled.provider';
import { OpenAiCloudProvider } from './openai-cloud.provider';
import { OpenAiCompatibleProvider } from './openai-compatible.provider';
import type { HttpProviderOptions } from './openai-compatible.provider';

const SECRET = 'sk-test-SECRET-0123456789';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function options(fetchImpl: typeof fetch, over: Partial<HttpProviderOptions> = {}): HttpProviderOptions {
  return {
    name: 'test',
    endpoint: 'http://localhost:11434/v1/',
    apiKey: null,
    model: 'llama',
    embeddingModel: 'bge-m3',
    timeoutMs: 5000,
    fetchImpl,
    ...over,
  };
}

/** Corps JSON de l'appel `n` du mock fetch. */
function sentBody(fetchMock: jest.Mock, n = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[n][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('DisabledProvider', () => {
  it('rejette toute opération avec AiDisabledError', async () => {
    const p = new DisabledProvider();
    expect(p.kind).toBe('disabled');
    await expect(p.complete({ system: 's', text: 't' })).rejects.toBeInstanceOf(AiDisabledError);
    await expect(p.embed(['a'])).rejects.toBeInstanceOf(AiDisabledError);
  });
});

describe('OpenAiCompatibleProvider (local)', () => {
  it('appelle /chat/completions avec json_schema strict et lit usage', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        model: 'llama-3',
        choices: [{ message: { content: '{"a":1}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
    );
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    const result = await p.complete({
      system: 'consigne',
      text: 'bonjour',
      jsonSchema: { name: 'out', schema: { type: 'object' } },
      maxOutputTokens: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    const body = sentBody(fetchMock);
    expect(body).toMatchObject({
      model: 'llama',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'consigne' },
        { role: 'user', content: 'bonjour' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'out', schema: { type: 'object' }, strict: true },
      },
    });
    expect(result).toEqual({ text: '{"a":1}', model: 'llama-3', promptTokens: 12, completionTokens: 3 });
  });

  it('envoie les images en image_url data-URI et sans en-tête Authorization si pas de clé', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    await p.complete({
      system: 's',
      text: 't',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: Buffer.from('abc') }],
    });
    const body = sentBody(fetchMock) as { messages: Array<{ content: unknown }> };
    expect(body.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from('abc').toString('base64')}` } },
      { type: 'text', text: 't' },
    ]);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('refuse un PDF sans aucun appel réseau', async () => {
    const fetchMock = jest.fn();
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    await expect(
      p.complete({
        system: 's',
        text: 't',
        attachments: [{ kind: 'pdf', mediaType: 'application/pdf', data: Buffer.from('x') }],
      }),
    ).rejects.toBeInstanceOf(AiUnsupportedInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('appelle /embeddings et remet les vecteurs dans l’ordre', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    );
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    const vectors = await p.embed(['a', 'b']);
    expect(vectors).toEqual([[1], [2]]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings');
    expect(sentBody(fetchMock)).toEqual({ model: 'bge-m3', input: ['a', 'b'] });
  });

  it('convertit une erreur HTTP en AiProviderError sans clé ni Authorization', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { message: `Incorrect API key provided: ${SECRET}. Bearer ${SECRET}` } }, 401),
      );
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch, { apiKey: SECRET }));
    const err = await p.complete({ system: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    const message = (err as Error).message;
    expect(message).toContain('HTTP 401');
    // seul le code HTTP est repris : jamais le corps de la réponse du serveur
    expect(message).not.toContain('Incorrect API key');
    expect(message).not.toContain(SECRET);
    expect(message.toLowerCase()).not.toContain('authorization');
    // la clé est bien envoyée en en-tête (et seulement là)
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('ne laisse pas fuiter la clé via une erreur réseau', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error(`connect ECONNREFUSED key=${SECRET}`));
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch, { apiKey: SECRET }));
    const err = await p.complete({ system: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as Error).message).not.toContain(SECRET);
  });

  it('ne suit jamais les redirections (redirect: error), embeddings compris', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    await p.complete({ system: 's', text: 't' });
    await p.embed(['a']);
    for (const n of [0, 1]) {
      expect((fetchMock.mock.calls[n][1] as RequestInit).redirect).toBe('error');
    }
  });

  it('ne recopie pas le texte d’une erreur réseau', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('boom https://u:p@x Authorization sk-abc'));
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    const err = await p.complete({ system: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    const message = (err as Error).message;
    expect(message).toContain('injoignable (erreur réseau)');
    for (const leak of ['boom', 'u:p', 'Authorization', 'sk-abc']) {
      expect(message).not.toContain(leak);
    }
  });

  it('lève AiProviderError sur délai dépassé', async () => {
    const fetchMock = jest.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch, { timeoutMs: 20 }));
    await expect(p.complete({ system: 's', text: 't' })).rejects.toThrow(/Délai dépassé/);
  });

  it('rejette une réponse vide', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    const p = new OpenAiCompatibleProvider(options(fetchMock as unknown as typeof fetch));
    await expect(p.complete({ system: 's', text: 't' })).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('OpenAiCloudProvider (cloud)', () => {
  const cloudOpts = (fetchImpl: typeof fetch): HttpProviderOptions =>
    options(fetchImpl, {
      name: 'openai',
      endpoint: 'https://api.openai.com/v1',
      apiKey: SECRET,
      model: 'gpt-x',
      embeddingModel: 'text-embedding-3-large',
    });

  it('appelle /responses avec instructions, input_file PDF, input_image et text.format strict', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        model: 'gpt-x-2',
        output_text: '{"ok":true}',
        usage: { input_tokens: 50, output_tokens: 7 },
      }),
    );
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    const result = await p.complete({
      system: 'consigne',
      text: 'texte masqué',
      attachments: [
        { kind: 'pdf', filename: 'c.pdf', mediaType: 'application/pdf', data: Buffer.from('pdf') },
        { kind: 'image', mediaType: 'image/jpeg', data: Buffer.from('img') },
      ],
      jsonSchema: { name: 'mail_extraction', schema: { type: 'object' } },
      maxOutputTokens: 500,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(sentBody(fetchMock)).toEqual({
      model: 'gpt-x',
      instructions: 'consigne',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_file',
              filename: 'c.pdf',
              file_data: `data:application/pdf;base64,${Buffer.from('pdf').toString('base64')}`,
            },
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${Buffer.from('img').toString('base64')}`,
              detail: 'auto',
            },
            { type: 'input_text', text: 'texte masqué' },
          ],
        },
      ],
      text: {
        format: { type: 'json_schema', name: 'mail_extraction', schema: { type: 'object' }, strict: true },
      },
      max_output_tokens: 500,
    });
    expect(result).toEqual({ text: '{"ok":true}', model: 'gpt-x-2', promptTokens: 50, completionTokens: 7 });
  });

  it('extrait le texte des blocs output_text quand output_text est absent', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: 'Bon' }, { type: 'output_text', text: 'jour' }] },
        ],
      }),
    );
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    const result = await p.complete({ system: 's', text: 't' });
    expect(result.text).toBe('Bonjour');
    expect(result.promptTokens).toBeNull();
  });

  it('refuse une réponse sans texte (refus du modèle) avec un message sans contenu', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ status: 'incomplete', output: [] }));
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    await expect(p.complete({ system: 's', text: 't' })).rejects.toThrow(/incomplete/);
  });

  it('demande des embeddings avec dimensions=1024', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    await p.embed(['x']);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
    expect(sentBody(fetchMock)).toMatchObject({
      model: 'text-embedding-3-large',
      input: ['x'],
      dimensions: 1024,
    });
  });

  it('ne suit jamais les redirections (redirect: error), embeddings compris', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ output_text: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ index: 0, embedding: [0.1] }] }));
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    await p.complete({ system: 's', text: 't' });
    await p.embed(['x']);
    for (const n of [0, 1]) {
      expect((fetchMock.mock.calls[n][1] as RequestInit).redirect).toBe('error');
    }
  });

  it('cloud : ne recopie pas le texte d’une erreur réseau', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('boom https://u:p@x Authorization sk-abc'));
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    const err = await p.complete({ system: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    const message = (err as Error).message;
    expect(message).toContain('injoignable (erreur réseau)');
    for (const leak of ['boom', 'u:p', 'Authorization', 'sk-abc']) {
      expect(message).not.toContain(leak);
    }
  });

  it('erreur HTTP : code seul, jamais le corps ni la clé', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response(`rate limited for ${SECRET}`, { status: 429 }));
    const p = new OpenAiCloudProvider(cloudOpts(fetchMock as unknown as typeof fetch));
    const err = await p.complete({ system: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as Error).message).toContain('HTTP 429');
    expect((err as Error).message).not.toContain('rate limited');
    expect((err as Error).message).not.toContain(SECRET);
  });
});
