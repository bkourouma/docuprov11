import { GED_EMBEDDING_DIMENSION, GedAiMode } from '@archivage/types';
import type { EffectiveAiConfig } from './ai-config';
import { AiMaskingError } from './ai-masking';
import { AiProviderError, type FetchLike } from './ai-providers';
import {
  EMBEDDING_BATCH_SIZE,
  embedTexts,
  loadEmbeddingSetup,
  type EmbeddingSetup,
} from './embedding-provider';

const IBAN = 'FR7630006000011234567890189';
const EMAIL = 'jean.dupont@example.com';
const KEY = 'sk-secret-123';

const cfg = (over: Partial<EffectiveAiConfig> = {}): EffectiveAiConfig => ({
  mode: GedAiMode.Cloud,
  provider: 'openai',
  model: 'gpt-test',
  endpoint: 'https://api.example.com/v1',
  apiKey: KEY,
  maskingEnabled: true,
  threshold: null,
  timeoutSeconds: 30,
  ...over,
});
const setup = (over: Partial<EffectiveAiConfig> = {}, extra: Partial<EmbeddingSetup> = {}): EmbeddingSetup => ({
  config: cfg(over),
  model: 'text-embedding-3-large',
  dimension: GED_EMBEDDING_DIMENSION,
  ...extra,
});

const prisma = { gedAiMaskingRule: { findMany: jest.fn().mockResolvedValue([]) } } as never;
const vector = (n = GED_EMBEDDING_DIMENSION) => Array.from({ length: n }, (_, i) => i / 1000);

/** fetch simulé : répond avec un vecteur valide par entrée, ou la réponse imposée. */
function fakeFetch(respond?: (body: { input: string[] }) => unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: { model: string; input: string[]; dimensions?: number } }> = [];
  const fn: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    const payload = respond
      ? respond(body)
      : { data: body.input.map((_: string, index: number) => ({ index, embedding: vector() })) };
    return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
  };
  return { fn, calls };
}

describe('embedTexts', () => {
  it('mode désactivé : { disabled: true } sans aucun fetch ni lecture', async () => {
    const f = fakeFetch();
    const res = await embedTexts(prisma, setup({ mode: GedAiMode.Desactivee }, { model: '' }), ['x'], f.fn);
    expect(res).toEqual({ disabled: true });
    expect(f.calls).toHaveLength(0);
  });

  it('cloud sans masquage : refus avant tout appel', async () => {
    const f = fakeFetch();
    await expect(
      embedTexts(prisma, setup({ maskingEnabled: false }), ['texte'], f.fn),
    ).rejects.toBeInstanceOf(AiMaskingError);
    expect(f.calls).toHaveLength(0);
  });

  it('masque IBAN et e-mail AVANT l’envoi ; requête OpenAI avec dimensions en cloud', async () => {
    const f = fakeFetch();
    const res = await embedTexts(prisma, setup(), [`Contact ${EMAIL}, IBAN ${IBAN}`], f.fn);
    expect(res).toMatchObject({ disabled: false, model: 'text-embedding-3-large', dimension: 1024 });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.example.com/v1/embeddings');
    const raw = String(c.init.body);
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain(IBAN);
    expect(c.body.dimensions).toBe(1024);
    expect(c.body.model).toBe('text-embedding-3-large');
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(c.init.redirect).toBe('error');
  });

  it('local : pas de dimensions, pas d’Authorization sans clé, masquage coupé accepté', async () => {
    const f = fakeFetch();
    await embedTexts(
      prisma,
      setup({ mode: GedAiMode.Locale, endpoint: 'http://ollama.local:11434/v1/', apiKey: null, maskingEnabled: false }, { model: 'bge-m3' }),
      [`mail ${EMAIL}`],
      f.fn,
    );
    const c = f.calls[0]!;
    expect(c.url).toBe('http://ollama.local:11434/v1/embeddings');
    expect(c.body.dimensions).toBeUndefined();
    expect((c.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(String(c.init.body)).toContain(EMAIL);
  });

  it('lots de 16 textes, ordre des vecteurs conservé', async () => {
    const f = fakeFetch((b) => ({
      // réponse réordonnée par `index` : chaque vecteur doit être replacé selon son index
      data: b.input.map((t, i) => ({ index: b.input.length - 1 - i, embedding: [Number(t)].concat(vector().slice(1)) })).reverse(),
    }));
    const texts = Array.from({ length: 35 }, (_, i) => String(i));
    const res = await embedTexts(prisma, setup(), texts, f.fn);
    expect(f.calls.map((c) => c.body.input.length)).toEqual([EMBEDDING_BATCH_SIZE, 16, 3]);
    if (res.disabled) throw new Error('inattendu');
    expect(res.vectors).toHaveLength(35);
    // premier lot (textes 0..15) : le vecteur d'index 0 est celui du texte « 15 » (réponse réordonnée)
    expect(res.vectors[0]![0]).toBe(15);
  });

  it('dimension != 1024 rejetée', async () => {
    const f = fakeFetch((b) => ({ data: b.input.map(() => ({ embedding: vector(768) })) }));
    await expect(embedTexts(prisma, setup(), ['a'], f.fn)).rejects.toThrow(/dimension/);
  });

  it('nombre de vecteurs incorrect, valeur non finie, index dupliqué : rejetés', async () => {
    await expect(
      embedTexts(prisma, setup(), ['a', 'b'], fakeFetch(() => ({ data: [{ embedding: vector() }] })).fn),
    ).rejects.toThrow(/nombre/);
    const nan = vector();
    nan[5] = Number.NaN;
    await expect(
      embedTexts(prisma, setup(), ['a'], fakeFetch(() => ({ data: [{ embedding: nan }] })).fn),
    ).rejects.toThrow();
    await expect(
      embedTexts(prisma, setup(), ['a', 'b'], fakeFetch(() => ({ data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] })).fn),
    ).rejects.toThrow(/incohérente/);
  });

  it('dimension configurée != 1024 : refus avant appel', async () => {
    const f = fakeFetch();
    await expect(embedTexts(prisma, setup({}, { dimension: 768 }), ['a'], f.fn)).rejects.toThrow(/Dimension/);
    expect(f.calls).toHaveLength(0);
  });

  it('erreur HTTP : message sûr, sans clé ni texte', async () => {
    const f = fakeFetch(() => ({ error: `boom ${KEY} secret-document-text` }), 500);
    const err = await embedTexts(prisma, setup(), ['secret-document-text'], f.fn).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).toContain('500');
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('secret-document-text');
  });

  it('échec réseau : message sûr', async () => {
    const fn: FetchLike = async () => {
      throw new Error(`ECONNRESET ${KEY} secret-document-text`);
    };
    const err = await embedTexts(prisma, setup(), ['secret-document-text'], fn).catch((e) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('secret-document-text');
  });

  it('délai dépassé : abandon par AbortController', async () => {
    jest.useFakeTimers();
    try {
      const fn: FetchLike = (_u, init) =>
        new Promise((_res, rej) => {
          init.signal!.addEventListener('abort', () => rej(new Error('aborted')));
        });
      const p = embedTexts(prisma, setup({ timeoutSeconds: 5 }), ['a'], fn).catch((e) => e);
      await jest.advanceTimersByTimeAsync(5_001);
      const err = await p;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.message).toContain('5 s');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['http://api.example.com/v1', /https/],
    ['https://user:pw@api.example.com/v1', /identifiants/],
    ['pas une url', /invalide/],
  ])('cloud : endpoint %s refusé sans appel', async (endpoint, re) => {
    const f = fakeFetch();
    await expect(embedTexts(prisma, setup({ endpoint }), ['a'], f.fn)).rejects.toThrow(re);
    expect(f.calls).toHaveLength(0);
  });

  it('cloud : http en boucle locale toléré ; clé absente refusée ; local avec identifiants refusé', async () => {
    const f = fakeFetch();
    await embedTexts(prisma, setup({ endpoint: 'http://localhost:8080/v1' }), ['a'], f.fn);
    expect(f.calls).toHaveLength(1);
    await expect(embedTexts(prisma, setup({ apiKey: null }), ['a'], f.fn)).rejects.toThrow(/Clé/);
    await expect(
      embedTexts(prisma, setup({ mode: GedAiMode.Locale, endpoint: 'http://u:p@h/v1' }), ['a'], f.fn),
    ).rejects.toThrow(/identifiants/);
  });

  it('aucun texte : aucun appel', async () => {
    const f = fakeFetch();
    expect(await embedTexts(prisma, setup(), [], f.fn)).toMatchObject({ disabled: false, vectors: [] });
    expect(f.calls).toHaveLength(0);
  });
});

describe('loadEmbeddingSetup', () => {
  const mk = (row: Record<string, unknown> | null) => ({
    gedAiSetting: { findFirst: jest.fn().mockResolvedValue(row) },
    gedAiMaskingRule: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it('désactivée : modèle vide, une seule lecture suffisante', async () => {
    const s = await loadEmbeddingSetup(mk(null) as never, {});
    expect(s.config.mode).toBe(GedAiMode.Desactivee);
    expect(s.model).toBe('');
  });

  it('cloud : modèle configuré, sinon défaut cloud ; local : défaut bge-m3', async () => {
    const base = { provider: 'openai', model: null, endpoint: null, apiKeyRef: null, maskingEnabled: true, autoApplyThreshold: null, timeoutSeconds: 30 };
    const cloud = await loadEmbeddingSetup(mk({ ...base, mode: 2, embeddingModel: null, embeddingDimension: 1024 }) as never, { GED_AI_API_KEY: 'k' });
    expect(cloud.model).toBe('text-embedding-3-large');
    const custom = await loadEmbeddingSetup(mk({ ...base, mode: 2, embeddingModel: ' text-embedding-3-small ', embeddingDimension: 1024 }) as never, { GED_AI_API_KEY: 'k' });
    expect(custom.model).toBe('text-embedding-3-small');
    const local = await loadEmbeddingSetup(mk({ ...base, provider: 'ollama', mode: 1, embeddingModel: null, embeddingDimension: 1024 }) as never, {});
    expect(local.model).toBe('bge-m3');
    expect(local.dimension).toBe(1024);
  });
});
