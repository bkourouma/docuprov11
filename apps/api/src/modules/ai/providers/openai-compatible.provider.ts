import { AiProviderError, AiUnsupportedInputError } from '../ai.types';
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from '../ai.types';

/** Paramètres communs aux fournisseurs HTTP, tous injectés par la fabrique (aucune lecture de base ni d'env ici). */
export interface HttpProviderOptions {
  /** Nom du fournisseur (`ollama`, `vllm`, `openai`…), pour le journal. */
  name: string;
  /** URL de base, ex. `https://api.openai.com/v1` ou `http://localhost:11434/v1`. */
  endpoint: string;
  /** Clé d'API ; `null` pour un serveur local sans authentification. */
  apiKey: string | null;
  model: string;
  embeddingModel: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/** Retire toute trace de clé d'un texte destiné à un message d'erreur ou à un log. */
export function redactSecrets(text: string, apiKey: string | null): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[clé masquée]');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [clé masquée]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[clé masquée]');
}

/**
 * POST JSON avec délai maximal (AbortController). Toute défaillance devient une `AiProviderError` au
 * message sûr : code HTTP seul, jamais le corps de la réponse, l'en-tête Authorization ni la clé.
 */
export async function postJson<T>(opts: HttpProviderOptions, path: string, body: unknown): Promise<T> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let response: Response;
    try {
      response = await opts.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // Jamais de suivi de redirection : l'en-tête Authorization ne doit pas suivre vers un autre hôte.
        redirect: 'error',
      });
    } catch {
      if (controller.signal.aborted) {
        throw new AiProviderError(
          `Délai dépassé (${Math.round(opts.timeoutMs / 1000)} s) pour le fournisseur IA ${opts.name}.`,
        );
      }
      // Le message brut de l'erreur réseau n'est pas repris (il peut citer l'URL ou un en-tête).
      throw new AiProviderError(`Fournisseur IA ${opts.name} injoignable (erreur réseau).`);
    }

    if (!response.ok) {
      // Le corps de la réponse n'est jamais repris : il peut citer le contenu envoyé ou une clé.
      throw new AiProviderError(`Fournisseur IA ${opts.name} : HTTP ${response.status}.`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new AiProviderError(`Fournisseur IA ${opts.name} : réponse non JSON.`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

/** Valide la réponse `/embeddings` : un vecteur numérique par texte, remis dans l'ordre de la requête. */
export function parseEmbeddings(json: EmbeddingsResponse, expected: number, providerName: string): number[][] {
  const data = json.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new AiProviderError(`Fournisseur IA ${providerName} : réponse d'embeddings incomplète.`);
  }
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((item) => {
    const vector = item.embedding;
    if (!Array.isArray(vector) || !vector.every((x) => typeof x === 'number')) {
      throw new AiProviderError(`Fournisseur IA ${providerName} : vecteur d'embedding invalide.`);
    }
    return vector as number[];
  });
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Fournisseur « local » (mode 1) : tout serveur compatible OpenAI (Ollama, vLLM, LM Studio…).
 * Chat Completions + `response_format: json_schema` ; images en `image_url` data-URI ; pas de PDF
 * (un serveur local n'a pas de lecteur de PDF : l'appelant doit fournir du texte ou une image).
 */
export class OpenAiCompatibleProvider implements AiModelProvider {
  readonly kind = 'local' as const;

  constructor(private readonly opts: HttpProviderOptions) {}

  get name(): string {
    return this.opts.name;
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const attachments = request.attachments ?? [];
    // Refus AVANT tout appel réseau : rien n'est envoyé si une pièce n'est pas lisible.
    if (attachments.some((a) => a.kind === 'pdf')) {
      throw new AiUnsupportedInputError(
        'Le fournisseur IA local ne lit pas les PDF : fournissez le texte extrait ou une image.',
      );
    }

    const userContent: string | ChatContentPart[] =
      attachments.length === 0
        ? request.text
        : [
            ...attachments.map(
              (a): ChatContentPart => ({
                type: 'image_url',
                image_url: { url: `data:${a.mediaType};base64,${a.data.toString('base64')}` },
              }),
            ),
            { type: 'text', text: request.text },
          ];

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: userContent },
      ],
    };
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: request.jsonSchema.name, schema: request.jsonSchema.schema, strict: true },
      };
    }
    if (request.maxOutputTokens) body.max_tokens = request.maxOutputTokens;

    const json = await postJson<ChatCompletionResponse>(this.opts, '/chat/completions', body);
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new AiProviderError(`Fournisseur IA ${this.opts.name} : réponse vide ou refusée.`);
    }
    return {
      text: content,
      model: json.model ?? this.opts.model,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const json = await postJson<EmbeddingsResponse>(this.opts, '/embeddings', {
      model: this.opts.embeddingModel,
      input: texts,
    });
    return parseEmbeddings(json, texts.length, this.opts.name);
  }
}
