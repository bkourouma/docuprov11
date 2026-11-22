import { GED_EMBEDDING_DIMENSION } from '@archivage/types';
import { AiProviderError } from '../ai.types';
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from '../ai.types';
import { parseEmbeddings, postJson } from './openai-compatible.provider';
import type { EmbeddingsResponse, HttpProviderOptions } from './openai-compatible.provider';

interface ResponsesApiResponse {
  model?: string;
  status?: string;
  output_text?: unknown;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: unknown }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type ResponsesInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; filename: string; file_data: string };

/** Texte de sortie : `output_text` s'il est fourni, sinon concaténation des blocs `output_text` des messages. */
function extractOutputText(json: ResponsesApiResponse): string {
  if (typeof json.output_text === 'string' && json.output_text.length > 0) return json.output_text;
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const block of item.content ?? []) {
      if (block.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('');
}

/**
 * Fournisseur « cloud » (mode 2) : OpenAI par défaut, interchangeable par endpoint/modèle. Reproduit
 * l'appel historique de l'extraction courrier : Responses API, pièces jointes `input_file` (PDF) et
 * `input_image`, sortie structurée stricte `text.format` / `json_schema`. Le masquage est garanti en
 * amont par `AiService` : ce fournisseur n'envoie que ce qu'on lui donne.
 */
export class OpenAiCloudProvider implements AiModelProvider {
  readonly kind = 'cloud' as const;

  constructor(private readonly opts: HttpProviderOptions) {}

  get name(): string {
    return this.opts.name;
  }

  get model(): string {
    return this.opts.model;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const content: ResponsesInputContent[] = (request.attachments ?? []).map(
      (a): ResponsesInputContent => {
        const data = a.data.toString('base64');
        return a.kind === 'pdf'
          ? {
              type: 'input_file',
              filename: a.filename ?? 'document.pdf',
              file_data: `data:application/pdf;base64,${data}`,
            }
          : { type: 'input_image', image_url: `data:${a.mediaType};base64,${data}`, detail: 'auto' };
      },
    );
    content.push({ type: 'input_text', text: request.text });

    const body: Record<string, unknown> = {
      model: this.opts.model,
      instructions: request.system,
      input: [{ role: 'user', content }],
    };
    if (request.jsonSchema) {
      body.text = {
        format: {
          type: 'json_schema',
          name: request.jsonSchema.name,
          schema: request.jsonSchema.schema,
          strict: request.strictSchema !== false,
        },
      };
    }
    if (request.maxOutputTokens) body.max_output_tokens = request.maxOutputTokens;

    const json = await postJson<ResponsesApiResponse>(this.opts, '/responses', body);
    const text = extractOutputText(json);
    if (!text) {
      // Refus du modèle ou coupure sur la longueur : on ne remonte que le statut, jamais le contenu.
      throw new AiProviderError(
        `Fournisseur IA ${this.opts.name} : réponse vide (statut ${json.status ?? 'inconnu'}).`,
      );
    }
    return {
      text,
      model: json.model ?? this.opts.model,
      promptTokens: json.usage?.input_tokens ?? null,
      completionTokens: json.usage?.output_tokens ?? null,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const json = await postJson<EmbeddingsResponse>(this.opts, '/embeddings', {
      model: this.opts.embeddingModel,
      input: texts,
      dimensions: GED_EMBEDDING_DIMENSION,
      encoding_format: 'float',
    });
    return parseEmbeddings(json, texts.length, this.opts.name);
  }
}
