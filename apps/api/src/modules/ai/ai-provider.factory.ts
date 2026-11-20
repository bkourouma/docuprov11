import {
  GED_AI_API_KEY_REF_REGEX,
  GED_AI_DEFAULT_CLOUD_ENDPOINT,
  GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL,
  GED_AI_DEFAULT_CLOUD_MODEL,
  GED_AI_DEFAULT_CLOUD_PROVIDER,
  GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL,
  GedAiMode,
} from '@archivage/types';
import { AiProviderError } from './ai.types';
import type { AiEffectiveConfig, AiModelProvider } from './ai.types';
import { DisabledProvider } from './providers/disabled.provider';
import { OpenAiCloudProvider } from './providers/openai-cloud.provider';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider';
import type { HttpProviderOptions } from './providers/openai-compatible.provider';

/** Dépendances injectées : aucune lecture de `process.env` ni de `fetch` global dans la fabrique. */
export interface AiProviderDeps {
  env: Record<string, string | undefined>;
  /** Par défaut : `fetch` natif, résolu à l'appel (permet de l'espionner en test). */
  fetchImpl?: typeof fetch;
}

/** Configuration IA inexploitable (endpoint absent ou non sécurisé, référence de clé refusée…). */
export class AiConfigurationError extends AiProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigurationError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const DEFAULT_CLOUD_HOST = new URL(GED_AI_DEFAULT_CLOUD_ENDPOINT).hostname;
const OPENAI_KEY_REFUSED =
  'Configuration IA : la clé OPENAI_API_KEY n’est utilisable qu’avec le cloud OpenAI (api.openai.com) ; utilisez une référence GED_AI_*.';

function parseEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiConfigurationError("Configuration IA : l'endpoint n'est pas une URL valide.");
  }
  if (url.username || url.password) {
    throw new AiConfigurationError("Configuration IA : identifiants dans l'URL de l'endpoint interdits.");
  }
  return url;
}

/** Nom de la variable d'environnement de la clé OpenAI, réservée au cloud OpenAI officiel. */
const OPENAI_KEY_NAME = 'OPENAI_API_KEY';

/**
 * Résout la clé d'API : `apiKeyRef` (liste blanche), à défaut `GED_AI_API_KEY`, puis `OPENAI_API_KEY`.
 * `OPENAI_API_KEY` (en référence explicite OU en repli implicite) n'est honorée que si
 * `openAiKeyAllowed` (cloud + fournisseur `openai` + hôte `api.openai.com` en https) ; sinon
 * `AiConfigurationError`, pour qu'un endpoint configuré à la main ne puisse pas l'exfiltrer.
 * Les références `GED_AI_*` restent valables partout.
 */
function resolveApiKey(
  config: AiEffectiveConfig,
  env: Record<string, string | undefined>,
  openAiKeyAllowed: boolean,
): string | null {
  if (config.apiKeyRef) {
    if (!GED_AI_API_KEY_REF_REGEX.test(config.apiKeyRef)) {
      throw new AiConfigurationError(
        'Configuration IA : référence de clé API refusée (OPENAI_API_KEY ou GED_AI_* attendu).',
      );
    }
    if (config.apiKeyRef === OPENAI_KEY_NAME && !openAiKeyAllowed) {
      throw new AiConfigurationError(OPENAI_KEY_REFUSED);
    }
    const referenced = env[config.apiKeyRef];
    if (referenced) return referenced;
  }
  if (env.GED_AI_API_KEY) return env.GED_AI_API_KEY;
  if (env[OPENAI_KEY_NAME]) {
    // Repli implicite (référence vide ou absente) : même règle que la référence explicite.
    if (!openAiKeyAllowed) {
      // Une référence GED_AI_* vide n'a pas de raison de buter sur la clé OpenAI : pas de clé.
      return null;
    }
    return env[OPENAI_KEY_NAME] ?? null;
  }
  return null;
}

/** Choisit le fournisseur selon `config.mode` : 0 désactivé, 1 local, 2 cloud. Fonction pure. */
export function createProvider(config: AiEffectiveConfig, deps: AiProviderDeps): AiModelProvider {
  if (config.mode === GedAiMode.Desactivee) return new DisabledProvider();

  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = Math.max(1, config.timeoutSeconds) * 1000;

  if (config.mode === GedAiMode.Locale) {
    if (!config.endpoint) {
      throw new AiConfigurationError("Configuration IA locale : l'endpoint est obligatoire.");
    }
    if (!config.model) {
      throw new AiConfigurationError('Configuration IA locale : le modèle est obligatoire.');
    }
    const url = parseEndpoint(config.endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AiConfigurationError("Configuration IA locale : l'endpoint doit être en http ou https.");
    }
    const opts: HttpProviderOptions = {
      name: config.provider ?? 'openai-compatible',
      endpoint: config.endpoint,
      apiKey: resolveApiKey(config, deps.env, false),
      model: config.model,
      embeddingModel: config.embeddingModel ?? GED_AI_DEFAULT_LOCAL_EMBEDDING_MODEL,
      timeoutMs,
      fetchImpl,
    };
    return new OpenAiCompatibleProvider(opts);
  }

  // Cloud (mode 2) : OpenAI par défaut, interchangeable par endpoint/modèle.
  const endpoint = config.endpoint ?? GED_AI_DEFAULT_CLOUD_ENDPOINT;
  const url = parseEndpoint(endpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new AiConfigurationError(
      "Configuration IA cloud : l'endpoint doit être en https (http toléré uniquement sur localhost).",
    );
  }
  const provider = config.provider ?? GED_AI_DEFAULT_CLOUD_PROVIDER;
  const openAiKeyAllowed =
    provider === GED_AI_DEFAULT_CLOUD_PROVIDER &&
    url.protocol === 'https:' &&
    url.hostname === DEFAULT_CLOUD_HOST;
  const apiKey = resolveApiKey(config, deps.env, openAiKeyAllowed);
  if (!apiKey) {
    throw new AiConfigurationError('Configuration IA cloud : aucune clé API disponible.');
  }
  return new OpenAiCloudProvider({
    name: provider,
    endpoint,
    apiKey,
    model: config.model ?? GED_AI_DEFAULT_CLOUD_MODEL,
    embeddingModel: config.embeddingModel ?? GED_AI_DEFAULT_CLOUD_EMBEDDING_MODEL,
    timeoutMs,
    fetchImpl,
  });
}
