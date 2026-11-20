// Lot 3 — appel d'embeddings du worker (fetch natif, aucun SDK). Le worker a sa PROPRE lecture de la
// configuration IA (`loadAiConfig`) : il n'utilise pas les services NestJS de l'API.
// Les messages d'erreur sont SÛRS : ni clé d'API, ni corps de réponse, ni texte de document.
import type { PrismaClient } from '@prisma/client';
import {
  GED_EMBEDDING_DIMENSION,
  normalizeEmbeddingModel,
  GedAiMode,
} from '@archivage/types';
import { type AiEnvSource, type EffectiveAiConfig, loadAiConfig } from './ai-config';
import { loadMaskingRules, maskForProvider } from './ai-masking';
import { AiProviderError, type FetchLike } from './ai-providers';

/** Nombre maximal de textes par requête `/embeddings`. */
export const EMBEDDING_BATCH_SIZE = 16;

/** Configuration d'embedding résolue : configuration IA + modèle et dimension d'embedding. */
export interface EmbeddingSetup {
  config: EffectiveAiConfig;
  /** Modèle d'embedding effectif ('' si l'IA est désactivée). */
  model: string;
  /** Dimension déclarée dans `ged_ai_setting.embedding_dimension`. */
  dimension: number;
}

export type EmbedResult =
  | { disabled: true }
  | { disabled: false; model: string; dimension: number; vectors: number[][] };

export interface Embedder {
  loadSetup(): Promise<EmbeddingSetup>;
  /** Vectorise `texts` (ordre conservé). `{ disabled: true }` sans aucun appel si l'IA est coupée. */
  embed(setup: EmbeddingSetup, texts: readonly string[]): Promise<EmbedResult>;
}

type EmbeddingPrisma = Pick<PrismaClient, 'gedAiSetting' | 'gedAiMaskingRule'>;

// --- Garde-fous réseau ------------------------------------------------------------------------
// Reproduits de `ai-providers.ts`, qui ne les exporte pas (fichier du socle, non modifié ici).

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Cloud : https exigé, sauf boucle locale (passerelle de développement) ; pas d'identifiants dans l'URL. */
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

/** Cloud ET local : des identifiants dans l'URL fuiraient dans les journaux. */
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

/** Lit la configuration IA du worker puis le modèle/dimension d'embedding. */
export async function loadEmbeddingSetup(
  prisma: EmbeddingPrisma,
  env: AiEnvSource,
): Promise<EmbeddingSetup> {
  const config = await loadAiConfig(prisma, env);
  if (config.mode !== GedAiMode.Locale && config.mode !== GedAiMode.Cloud) {
    return { config, model: '', dimension: GED_EMBEDDING_DIMENSION };
  }
  const row = await prisma.gedAiSetting.findFirst({
    select: { embeddingModel: true, embeddingDimension: true },
  });
  return {
    config,
    model: normalizeEmbeddingModel(row?.embeddingModel, config.mode === GedAiMode.Cloud),
    dimension: row?.embeddingDimension ?? GED_EMBEDDING_DIMENSION,
  };
}

interface EmbeddingsBody {
  data?: Array<{ index?: unknown; embedding?: unknown }>;
}

/** Contrôle strict d'une réponse : nombre de vecteurs, dimension exacte, valeurs finies. */
function parseVectors(body: EmbeddingsBody, expected: number): number[][] {
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new AiProviderError('Fournisseur d’embeddings : nombre de vecteurs inattendu.');
  }
  const vectors: Array<number[] | undefined> = new Array(expected).fill(undefined);
  data.forEach((item, position) => {
    const idx =
      typeof item?.index === 'number' && Number.isInteger(item.index) ? item.index : position;
    const vec = item?.embedding;
    if (idx < 0 || idx >= expected || vectors[idx] !== undefined) {
      throw new AiProviderError('Fournisseur d’embeddings : réponse incohérente.');
    }
    if (!Array.isArray(vec) || vec.length !== GED_EMBEDDING_DIMENSION) {
      throw new AiProviderError(
        `Fournisseur d’embeddings : dimension inattendue (attendu ${GED_EMBEDDING_DIMENSION}).`,
      );
    }
    for (const x of vec) {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new AiProviderError('Fournisseur d’embeddings : valeur non numérique.');
      }
    }
    vectors[idx] = vec as number[];
  });
  return vectors as number[][];
}

async function postBatch(
  url: string,
  config: EffectiveAiConfig,
  model: string,
  input: string[],
  fetchImpl: FetchLike,
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const payload: Record<string, unknown> = { model, input };
    if (config.mode === GedAiMode.Cloud) payload.dimensions = GED_EMBEDDING_DIMENSION;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      // Jamais de suivi de redirection : l'en-tête Authorization ne doit pas suivre vers un autre hôte.
      redirect: 'error',
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new AiProviderError(`Fournisseur d’embeddings : réponse HTTP ${res.status}.`);
    return parseVectors((await res.json()) as EmbeddingsBody, input.length);
  } catch (err) {
    if (err instanceof AiProviderError) throw err;
    if (controller.signal.aborted) {
      throw new AiProviderError(
        `Fournisseur d’embeddings : délai de ${config.timeoutSeconds} s dépassé.`,
      );
    }
    throw new AiProviderError(
      'Fournisseur d’embeddings : échec de la requête (réseau ou réponse illisible).',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vectorise des textes : masquage AVANT envoi (cloud : obligatoire, masquage coupé => refus), puis
 * lots de `EMBEDDING_BATCH_SIZE`. Mode désactivé => `{ disabled: true }` sans lecture ni appel.
 */
export async function embedTexts(
  prisma: Pick<PrismaClient, 'gedAiMaskingRule'>,
  setup: EmbeddingSetup,
  texts: readonly string[],
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<EmbedResult> {
  const { config } = setup;
  if (config.mode !== GedAiMode.Locale && config.mode !== GedAiMode.Cloud) {
    return { disabled: true };
  }
  if (!setup.model) throw new AiProviderError('Modèle d’embedding non configuré.');
  if (setup.dimension !== GED_EMBEDDING_DIMENSION) {
    throw new AiProviderError(
      `Dimension d’embedding configurée invalide (attendu ${GED_EMBEDDING_DIMENSION}).`,
    );
  }
  if (config.mode === GedAiMode.Cloud) {
    assertCloudEndpoint(config.endpoint);
    if (!config.apiKey) throw new AiProviderError('Clé d’API absente pour le fournisseur cloud.');
  }
  assertNoUserinfo(config.endpoint);
  if (texts.length === 0) {
    return { disabled: false, model: setup.model, dimension: GED_EMBEDDING_DIMENSION, vectors: [] };
  }

  // Masquage de TOUS les textes avant le premier appel : un refus n'envoie rien.
  const rules = await loadMaskingRules(prisma);
  const masked = texts.map(
    (text) =>
      maskForProvider({ text, mode: config.mode, maskingEnabled: config.maskingEnabled, rules })
        .text,
  );

  const url = `${config.endpoint.replace(/\/+$/, '')}/embeddings`;
  const vectors: number[][] = [];
  for (let i = 0; i < masked.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = masked.slice(i, i + EMBEDDING_BATCH_SIZE);
    vectors.push(...(await postBatch(url, config, setup.model, batch, fetchImpl)));
  }
  return { disabled: false, model: setup.model, dimension: GED_EMBEDDING_DIMENSION, vectors };
}

/** Embedder réel : Prisma du worker, fetch natif, environnement du processus. */
export function createEmbedder(
  prisma: EmbeddingPrisma,
  env: AiEnvSource = process.env,
  fetchImpl?: FetchLike,
): Embedder {
  return {
    loadSetup: () => loadEmbeddingSetup(prisma, env),
    embed: (setup, texts) => embedTexts(prisma, setup, texts, fetchImpl),
  };
}
