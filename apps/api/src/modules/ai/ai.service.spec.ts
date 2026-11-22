import { createHash } from 'node:crypto';
import { GED_AI_DISABLED_MESSAGE, GedAiDecisionStatus, GedAiMode, GedAiTask } from '@archivage/types';
import { AiDecisionService } from './ai-decision.service';
import { AiMaskingService } from './ai-masking.service';
import { AiSettingsService } from './ai-settings.service';
import { AiService } from './ai.service';
import { AiMaskingRequiredError, AiProviderError, AiUnsupportedInputError } from './ai.types';
import type { AiAttachment, AiEffectiveConfig, AiRunOptions } from './ai.types';
import type { PrismaService } from '../prisma/prisma.service';

const SECRET = 'sk-test-SECRET-0123456789';

function config(over: Partial<AiEffectiveConfig> = {}): AiEffectiveConfig {
  return {
    mode: GedAiMode.Cloud,
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

const LOCAL = {
  mode: GedAiMode.Locale,
  endpoint: 'http://localhost:11434/v1',
  model: 'llama',
  provider: 'ollama',
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const cloudOk = (text = '{"label":"facture","score":0.9}') =>
  jsonResponse({ model: 'gpt-x', output_text: text, usage: { input_tokens: 10, output_tokens: 4 } });
const localOk = (text = '{"label":"facture","score":0.9}') =>
  jsonResponse({ model: 'llama', choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });

interface Parsed {
  label: string;
  score: number | null;
}

function setup(cfg: AiEffectiveConfig, fetchMock: jest.Mock = jest.fn()) {
  const settings = { getEffective: jest.fn().mockResolvedValue(cfg) };
  const record = jest.fn().mockResolvedValue(BigInt(42));
  const findMany = jest.fn().mockResolvedValue([]);
  const masking = new AiMaskingService({ gedAiMaskingRule: { findMany } } as unknown as PrismaService);
  const service = new AiService(
    settings as unknown as AiSettingsService,
    masking,
    { record } as unknown as AiDecisionService,
  );
  service.providerDeps = {
    env: { OPENAI_API_KEY: SECRET },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
  return { service, settings, record, fetchMock };
}

function runOpts(over: Partial<AiRunOptions<Parsed>> = {}): AiRunOptions<Parsed> {
  return {
    task: GedAiTask.Classement,
    request: { system: 'consigne', text: 'Contactez jean@exemple.com' },
    parse: (raw) => JSON.parse(raw) as Parsed,
    confidence: (p) => p.score,
    ...over,
  };
}

const image: AiAttachment = { kind: 'image', mediaType: 'image/png', data: Buffer.from('PNG-bin') };
const pdf: AiAttachment = { kind: 'pdf', mediaType: 'application/pdf', data: Buffer.from('%PDF-bin') };

describe('AiService.status / getEffectiveConfig', () => {
  it('désactivée : enabled=false + message', async () => {
    const { service } = setup(config({ mode: GedAiMode.Desactivee }));
    expect(await service.status()).toEqual({
      enabled: false,
      mode: 0,
      message: GED_AI_DISABLED_MESSAGE,
    });
  });

  it('activée (locale, cloud) : enabled=true', async () => {
    expect((await setup(config(LOCAL)).service.status()).enabled).toBe(true);
    expect((await setup(config()).service.status()).enabled).toBe(true);
  });

  it('getEffectiveConfig délègue à settings', async () => {
    const cfg = config(LOCAL);
    const { service, settings } = setup(cfg);
    expect(await service.getEffectiveConfig()).toBe(cfg);
    expect(settings.getEffective).toHaveBeenCalled();
  });
});

describe('AiService.run — mode désactivé', () => {
  it('renvoie { disabled, message } sans erreur, sans appel réseau, sans journal', async () => {
    const { service, record, fetchMock } = setup(config({ mode: GedAiMode.Desactivee }));
    const result = await service.run(runOpts());
    expect(result).toEqual({ disabled: true, message: 'IA désactivée' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('embed désactivé : { disabled, message }', async () => {
    const { service, fetchMock } = setup(config({ mode: GedAiMode.Desactivee }));
    expect(await service.embed(['a'])).toEqual({ disabled: true, message: 'IA désactivée' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AiService.run — sélection du fournisseur', () => {
  it('mode 1 => /chat/completions local, journal mode 1', async () => {
    const fetchMock = jest.fn().mockResolvedValue(localOk());
    const { service, record } = setup(config(LOCAL), fetchMock);
    const result = await service.run(runOpts());
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(result).toMatchObject({ disabled: false, provider: 'ollama', model: 'llama' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ mode: 1, provider: 'ollama' }));
  });

  it('mode 2 => /responses cloud, journal mode 2', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cloudOk());
    const { service, record } = setup(config(), fetchMock);
    const result = await service.run(runOpts());
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(result).toMatchObject({ disabled: false, provider: 'openai', model: 'gpt-x' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ mode: 2, provider: 'openai' }));
  });
});

describe('AiService.run — masquage cloud obligatoire', () => {
  it('cloud avec masquage désactivé => AiMaskingRequiredError, aucun appel, aucun journal', async () => {
    const { service, record, fetchMock } = setup(config({ maskingEnabled: false }));
    await expect(service.run(runOpts())).rejects.toBeInstanceOf(AiMaskingRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('cloud avec binaire => AiMaskingRequiredError, sans exception ni appel ni journal', async () => {
    const { service, record, fetchMock } = setup(config());
    const request = { system: 's', text: 't', attachments: [pdf] };
    await expect(service.run(runOpts({ request }))).rejects.toBeInstanceOf(AiMaskingRequiredError);
    // `allowLocalAttachments` est sans effet en cloud
    await expect(
      service.run(runOpts({ request, allowLocalAttachments: true })),
    ).rejects.toBeInstanceOf(AiMaskingRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('local + image, masquage actif, sans demande explicite => AiMaskingRequiredError', async () => {
    const { service, record, fetchMock } = setup(config({ ...LOCAL, maskingEnabled: true }));
    const request = { system: 's', text: 't', attachments: [image] };
    const err = await service.run(runOpts({ request })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiMaskingRequiredError);
    expect((err as Error).message).toContain('allowLocalAttachments');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('local + image + allowLocalAttachments : envoyée, hash journalisé, inputMasked=false', async () => {
    const fetchMock = jest.fn().mockResolvedValue(localOk());
    const { service, record } = setup(config({ ...LOCAL, maskingEnabled: true }), fetchMock);
    const request = { system: 's', text: 'mail jean@exemple.com', attachments: [image] };
    await service.run(runOpts({ request, allowLocalAttachments: true }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ content: unknown }>;
    };
    expect(JSON.stringify(body.messages[1].content)).toContain('image_url');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentHashes: [createHash('sha256').update(image.data).digest('hex')],
        inputMasked: false,
      }),
    );
  });

  it('local + image, masquage désactivé : pas de refus, inputMasked=false', async () => {
    const fetchMock = jest.fn().mockResolvedValue(localOk());
    const { service, record } = setup(config({ ...LOCAL, maskingEnabled: false }), fetchMock);
    await service.run(runOpts({ request: { system: 's', text: 't', attachments: [image] } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ inputMasked: false }));
  });

  it('inputMasked : vrai si texte masqué sans binaire, faux si masquage non appliqué', async () => {
    const on = setup(config({ ...LOCAL, maskingEnabled: true }), jest.fn().mockResolvedValue(localOk()));
    await on.service.run(runOpts());
    expect(on.record).toHaveBeenCalledWith(expect.objectContaining({ inputMasked: true }));
    const off = setup(config({ ...LOCAL, maskingEnabled: false }), jest.fn().mockResolvedValue(localOk()));
    await off.service.run(runOpts());
    expect(off.record).toHaveBeenCalledWith(expect.objectContaining({ inputMasked: false }));
  });

  it('cloud : texte masqué (règles + entités par défaut), consigne système intacte', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cloudOk());
    const { service } = setup(config(), fetchMock);
    await service.run(
      runOpts({ request: { system: 'Écris à contact@exemple.com', text: 'IBAN FR7630006000011234567890189 et jean@exemple.com' } }),
    );
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      instructions: string;
      input: Array<{ content: Array<{ text: string }> }>;
    };
    expect(sent.instructions).toBe('Écris à contact@exemple.com');
    const text = sent.input[0].content[0].text;
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('[IBAN]');
    expect(text).not.toContain('jean@exemple.com');
  });

  it('local : sans masquage si masking_enabled=false ; avec masquage, sans entités par défaut', async () => {
    const fetchOff = jest.fn().mockResolvedValue(localOk());
    await setup(config({ ...LOCAL, maskingEnabled: false }), fetchOff).service.run(runOpts());
    const off = JSON.parse((fetchOff.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(off.messages[1].content).toBe('Contactez jean@exemple.com');

    const fetchOn = jest.fn().mockResolvedValue(localOk());
    await setup(config({ ...LOCAL, maskingEnabled: true }), fetchOn).service.run(runOpts());
    const on = JSON.parse((fetchOn.mock.calls[0][1] as RequestInit).body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(on.messages[1].content).toBe('Contactez jean@exemple.com');
  });
});

describe('AiService.run — confiance et seuil', () => {
  const statusFor = async (
    cfg: Partial<AiEffectiveConfig>,
    text: string,
    over: Partial<AiRunOptions<Parsed>> = {},
  ) => {
    const { service } = setup(config(cfg), jest.fn().mockResolvedValue(cloudOk(text)));
    const r = await service.run(runOpts(over));
    if (r.disabled) throw new Error('inattendu');
    return r;
  };

  it('seuil null => proposée', async () => {
    const r = await statusFor({ autoApplyThreshold: null }, '{"label":"a","score":0.99}');
    expect(r.status).toBe(GedAiDecisionStatus.Proposee);
    expect(r.confidence).toBe(0.99);
  });

  it('confiance >= seuil => appliquée automatiquement', async () => {
    const r = await statusFor({ autoApplyThreshold: 0.8 }, '{"label":"a","score":0.8}');
    expect(r.status).toBe(GedAiDecisionStatus.AppliqueeAuto);
  });

  it('confiance < seuil => proposée', async () => {
    const r = await statusFor({ autoApplyThreshold: 0.8 }, '{"label":"a","score":0.79}');
    expect(r.status).toBe(GedAiDecisionStatus.Proposee);
  });

  it('autoApply=false => proposée même au-dessus du seuil', async () => {
    const r = await statusFor({ autoApplyThreshold: 0.5 }, '{"label":"a","score":0.99}', { autoApply: false });
    expect(r.status).toBe(GedAiDecisionStatus.Proposee);
  });

  it('confiance absente ou nulle => null et proposée', async () => {
    const none = await statusFor({ autoApplyThreshold: 0.1 }, '{"label":"a","score":null}');
    expect(none.confidence).toBeNull();
    expect(none.status).toBe(GedAiDecisionStatus.Proposee);
    const noFn = await statusFor({ autoApplyThreshold: 0.1 }, '{"label":"a","score":0.9}', { confidence: undefined });
    expect(noFn.confidence).toBeNull();
    expect(noFn.status).toBe(GedAiDecisionStatus.Proposee);
  });

  it('confiance hors échelle (7) => aucun score, jamais application automatique', async () => {
    const r = await statusFor({ autoApplyThreshold: 0.9 }, '{"label":"a","score":7}');
    expect(r.confidence).toBeNull();
    expect(r.status).toBe(GedAiDecisionStatus.Proposee);
  });
});

describe('AiService.run — journal', () => {
  it('record reçoit le texte MASQUÉ, le mode, les jetons, la durée et les identifiants', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cloudOk());
    const { service, record } = setup(config({ autoApplyThreshold: 0.5 }), fetchMock);
    const result = await service.run(
      runOpts({ documentId: 7, sourceItemId: 3, requestedBy: 9, promptVersion: 'v1' }),
    );
    expect(record).toHaveBeenCalledTimes(1);
    const input = record.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      task: GedAiTask.Classement,
      mode: 2,
      provider: 'openai',
      model: 'gpt-x',
      promptVersion: 'v1',
      inputText: 'Contactez [EMAIL]',
      attachmentHashes: [],
      inputMasked: true,
      output: { label: 'facture', score: 0.9 },
      confidence: 0.9,
      status: GedAiDecisionStatus.AppliqueeAuto,
      documentId: 7,
      sourceItemId: 3,
      requestedBy: 9,
      promptTokens: 10,
      completionTokens: 4,
    });
    expect(typeof input.durationMs).toBe('number');
    expect(JSON.stringify(input, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      'jean@exemple.com',
    );
    expect(result).toMatchObject({ decisionId: BigInt(42), promptTokens: 10, completionTokens: 4 });
  });

  it('un échec du journal n’échoue pas l’appel (decisionId null)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cloudOk());
    const { service, record } = setup(config(), fetchMock);
    record.mockRejectedValue(new Error('base indisponible'));
    const result = await service.run(runOpts());
    expect(result).toMatchObject({ disabled: false, decisionId: null, data: { label: 'facture' } });
  });

  it('échec fournisseur : décision Erreur (output null, message sans clé) puis AiProviderError', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: `bad key ${SECRET}` } }, 401));
    const { service, record } = setup(config(), fetchMock);
    const err = await service.run(runOpts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as Error).message).not.toContain(SECRET);
    expect(record).toHaveBeenCalledTimes(1);
    const input = record.mock.calls[0][0] as { status: number; output: unknown; errorMessage: string; inputText: string };
    expect(input.status).toBe(GedAiDecisionStatus.Erreur);
    expect(input.output).toBeNull();
    expect(input.errorMessage).toContain('HTTP 401');
    expect(input.errorMessage).not.toContain(SECRET);
    expect(input.inputText).toBe('Contactez [EMAIL]');
  });

  it('échec réseau : AiProviderError et décision Erreur ; le journal HS ne masque pas l’erreur', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const { service, record } = setup(config(), fetchMock);
    record.mockRejectedValue(new Error('journal HS'));
    await expect(service.run(runOpts())).rejects.toBeInstanceOf(AiProviderError);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('échec de parse : décision Erreur sans contenu du modèle, erreur relancée telle quelle', async () => {
    const fetchMock = jest.fn().mockResolvedValue(cloudOk('contenu-confidentiel-pas-du-json'));
    const { service, record } = setup(config(), fetchMock);
    const err = await service.run(runOpts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyntaxError);
    const input = record.mock.calls[0][0] as { status: number; output: unknown; errorMessage: string };
    expect(input.status).toBe(GedAiDecisionStatus.Erreur);
    expect(input.output).toBeNull();
    expect(input.errorMessage).not.toContain('contenu-confidentiel');
  });

  it('PDF vers un fournisseur local : AiUnsupportedInputError, sans appel ni journal', async () => {
    const { service, record, fetchMock } = setup(config({ ...LOCAL, maskingEnabled: false }));
    await expect(
      service.run(runOpts({ request: { system: 's', text: 't', attachments: [pdf] } })),
    ).rejects.toBeInstanceOf(AiUnsupportedInputError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('AiService.run — délai effectif', () => {
  /** Fetch qui ne répond jamais : seul l'AbortController (délai effectif) y met fin. */
  const hanging = () =>
    jest.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_r, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

  it('minTimeoutSeconds relève le délai configuré : max(timeoutSeconds, minTimeoutSeconds)', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    try {
      const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(localOk()));
      const { service } = setup(config({ ...LOCAL, timeoutSeconds: 30 }), fetchMock);
      await service.run(runOpts({ minTimeoutSeconds: 120 }));
      expect(spy.mock.calls.some((c) => c[1] === 120_000)).toBe(true);
      spy.mockClear();
      await service.run(runOpts({ minTimeoutSeconds: 10 }));
      expect(spy.mock.calls.some((c) => c[1] === 30_000)).toBe(true);
      expect(spy.mock.calls.some((c) => c[1] === 10_000)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('sans minTimeoutSeconds : délai configuré ; l’échec de délai est journalisé', async () => {
    const { service, record } = setup(config({ ...LOCAL, timeoutSeconds: 0.05 }), hanging());
    await expect(service.run(runOpts())).rejects.toThrow(/Délai dépassé/);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('un plancher inférieur au délai configuré est sans effet', async () => {
    const { service } = setup(config({ ...LOCAL, timeoutSeconds: 0.05 }), hanging());
    await expect(service.run(runOpts({ minTimeoutSeconds: 0.01 }))).rejects.toThrow(/Délai dépassé/);
  });
});

describe('AiService.embed', () => {
  const vector = (n = 1024) => Array.from({ length: n }, () => 0.1);
  const embedResponse = (n: number, dim = 1024) =>
    jsonResponse({ data: Array.from({ length: n }, (_v, index) => ({ index, embedding: vector(dim) })) });

  it('cloud : vérifie 1024 composantes, masque chaque texte, dimensions=1024, ne journalise pas', async () => {
    const fetchMock = jest.fn().mockResolvedValue(embedResponse(2));
    const { service, record } = setup(config(), fetchMock);
    const result = await service.embed(['écrire à jean@exemple.com', 'IBAN FR7630006000011234567890189']);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/embeddings');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      input: string[];
      dimensions: number;
    };
    expect(body.dimensions).toBe(1024);
    expect(body.input[0]).toBe('écrire à [EMAIL]');
    expect(body.input[1]).toContain('[IBAN]');
    expect(result).toMatchObject({ disabled: false, dimension: 1024, model: 'text-embedding-3-large' });
    if (!result.disabled) expect(result.vectors).toHaveLength(2);
    expect(record).not.toHaveBeenCalled();
  });

  it('dimension incorrecte => AiProviderError', async () => {
    const fetchMock = jest.fn().mockResolvedValue(embedResponse(1, 768));
    const { service } = setup(config(), fetchMock);
    await expect(service.embed(['a'])).rejects.toBeInstanceOf(AiProviderError);
  });

  it('cloud sans masquage => AiMaskingRequiredError, aucun appel', async () => {
    const { service, fetchMock } = setup(config({ maskingEnabled: false }));
    await expect(service.embed(['a'])).rejects.toBeInstanceOf(AiMaskingRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('local : /embeddings du serveur local, modèle par défaut bge-m3', async () => {
    const fetchMock = jest.fn().mockResolvedValue(embedResponse(1));
    const { service } = setup(config(LOCAL), fetchMock);
    const result = await service.embed(['a']);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings');
    expect(result).toMatchObject({ disabled: false, model: 'bge-m3' });
  });
});
