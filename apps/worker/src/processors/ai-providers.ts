// Socle IA — fournisseurs HTTP (fetch natif, sans SDK). Local et cloud parlent tous deux Chat
// Completions compatible OpenAI avec `response_format: json_schema` (sortie structurée stricte).
// Les messages d'erreur sont SÛRS : ni clé, ni corps de réponse, ni contenu de document.
import { GedAiMode } from '@archivage/types';
import type { EffectiveAiConfig } from './ai-config';

export class AiProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export interface AiCompletionRequest {
  system: string;
  user: string;
  /** Nom du schéma de sortie (alphanumérique/underscore). */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
}

export interface AiCompletionResult {
  /** Contenu texte brut renvoyé par le modèle (JSON attendu). */
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface AiProvider {
  kind: 'local' | 'cloud';
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Cloud : https exigé, sauf boucle locale (passerelle de développement). */
function assertCloudEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiProviderError('Endpoint cloud invalide.');
  }
  if (url.username || url.password) {
    throw new AiProviderError('Endpoint refusé : identifiants dans l’URL interdits.');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new AiProviderError('Endpoint cloud refusé : https obligatoire.');
  }
}

/** Refuse `https://user:pass@hôte` (cloud ET local) : des identifiants dans l'URL fuiraient dans les journaux. */
function assertNoUserinfo(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiProviderError('Endpoint IA invalide.');
  }
  if (url.username || url.password) {
    throw new AiProviderError('Endpoint refusé : identifiants dans l’URL interdits.');
  }
}

function asTokenCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** Fournisseur du mode demandé ; lève `AiProviderError` si la configuration est inutilisable. */
export function createAiProvider(
  config: EffectiveAiConfig,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): AiProvider {
  if (config.mode !== GedAiMode.Locale && config.mode !== GedAiMode.Cloud) {
    throw new AiProviderError('IA désactivée : aucun fournisseur.');
  }
  const kind = config.mode === GedAiMode.Cloud ? 'cloud' : 'local';
  if (!config.model) throw new AiProviderError('Modèle IA non configuré.');
  if (kind === 'cloud') {
    assertCloudEndpoint(config.endpoint);
    if (!config.apiKey) throw new AiProviderError("Clé d'API absente pour le fournisseur cloud.");
  }
  assertNoUserinfo(config.endpoint);
  const url = `${config.endpoint.replace(/\/+$/, '')}/chat/completions`;

  return {
    kind,
    async complete(req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
        const res = await fetchImpl(url, {
          method: 'POST',
          headers,
          signal: controller.signal,
          // Jamais de suivi de redirection : l'en-tête Authorization ne doit pas suivre vers un autre hôte.
          redirect: 'error',
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: req.schemaName, strict: true, schema: req.jsonSchema },
            },
          }),
        });
        if (!res.ok) throw new AiProviderError(`Fournisseur IA : réponse HTTP ${res.status}.`);
        const body = (await res.json()) as ChatCompletionBody;
        const message = body.choices?.[0]?.message;
        if (typeof message?.refusal === 'string' && message.refusal) {
          throw new AiProviderError('Fournisseur IA : requête refusée par le modèle.');
        }
        if (typeof message?.content !== 'string' || !message.content.trim()) {
          throw new AiProviderError('Fournisseur IA : réponse vide.');
        }
        return {
          content: message.content,
          promptTokens: asTokenCount(body.usage?.prompt_tokens),
          completionTokens: asTokenCount(body.usage?.completion_tokens),
        };
      } catch (err) {
        if (err instanceof AiProviderError) throw err;
        if (controller.signal.aborted) {
          throw new AiProviderError(
            `Fournisseur IA : délai de ${config.timeoutSeconds} s dépassé.`,
          );
        }
        throw new AiProviderError(
          'Fournisseur IA : échec de la requête (réseau ou réponse illisible).',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
