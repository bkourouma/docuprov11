// Socle IA — configuration effective du pipeline `ged-ai` (lecture de `ged_ai_setting`, sans repli hérité).
// La clé d'API n'est JAMAIS lue en base ni journalisée : `api_key_ref` n'est qu'un NOM de variable
// d'environnement, accepté seulement s'il figure sur la liste blanche `GED_AI_API_KEY_REF_REGEX` (sinon erreur).
import type { PrismaClient } from '@prisma/client';
import {
  GED_AI_API_KEY_REF_REGEX,
  GED_AI_DEFAULT_CLOUD_ENDPOINT,
  GED_AI_DEFAULT_CLOUD_MODEL,
  GED_AI_DEFAULT_CLOUD_PROVIDER,
  GedAiMode,
} from '@archivage/types';

/** Variables d'environnement lisibles par la résolution de clé (typiquement `process.env`). */
export type AiEnvSource = Readonly<Record<string, string | undefined>>;

/** Point d'entrée Ollama compatible OpenAI — repli du mode local sans endpoint configuré. */
export const GED_AI_FALLBACK_LOCAL_ENDPOINT = 'http://localhost:11434/v1';

const DEFAULT_TIMEOUT_SECONDS = 60;

/** Ligne `ged_ai_setting` telle que lue (seuil Decimal accepté sous toute forme convertible). */
export interface AiSettingRow {
  mode: number;
  provider: string | null;
  model: string | null;
  endpoint: string | null;
  apiKeyRef: string | null;
  maskingEnabled: boolean;
  autoApplyThreshold: number | { toString(): string } | null;
  timeoutSeconds: number;
}

/** Configuration résolue, prête à l'emploi par le pipeline. */
export interface EffectiveAiConfig {
  mode: GedAiMode;
  provider: string | null;
  model: string;
  endpoint: string;
  /** Clé résolue depuis l'environnement ; `null` si aucune. Ne jamais la journaliser. */
  apiKey: string | null;
  maskingEnabled: boolean;
  /** `null` = aucune application automatique. */
  threshold: number | null;
  timeoutSeconds: number;
}

function nonEmpty(value: string | undefined | null): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Erreur de configuration IA (référence de clé interdite pour ce fournisseur). Classe locale au
 * worker ; le message est SÛR : il ne contient jamais de valeur de clé.
 */
export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigurationError';
  }
}

/** Hôte exact du cloud OpenAI : seul destinataire autorisé de `OPENAI_API_KEY`. */
const OPENAI_HOST = 'api.openai.com';

/** `OPENAI_API_KEY` n'est honorée que pour cloud + provider `openai` + hôte exactement `api.openai.com`. */
function isOpenAiCloud(mode: GedAiMode, provider: string | null, endpoint: string): boolean {
  if (mode !== GedAiMode.Cloud || provider !== GED_AI_DEFAULT_CLOUD_PROVIDER) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && url.hostname === OPENAI_HOST && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Résout la clé d'API.
 * - `api_key_ref` renseigné : doit vérifier la liste blanche (sinon `AiConfigurationError` : un nom
 *   libre permettrait d'exfiltrer `JWT_SECRET`) ; `OPENAI_API_KEY` exige `openAiAllowed`
 *   (sinon erreur : cette clé ne part jamais vers un endpoint local ou tiers) ; une référence
 *   `GED_AI_*` vaut partout, avec repli sur `GED_AI_API_KEY` si la variable est vide.
 * - `api_key_ref` vide : `GED_AI_API_KEY`, puis `OPENAI_API_KEY` seulement si `openAiAllowed`
 *   (sinon la clé est simplement ignorée, sans erreur : elle peut exister dans l'environnement
 *   pour d'autres usages).
 */
export function resolveAiApiKey(
  apiKeyRef: string | null | undefined,
  env: AiEnvSource,
  openAiAllowed = false,
): string | null {
  const ref = nonEmpty(apiKeyRef);
  if (ref) {
    if (!GED_AI_API_KEY_REF_REGEX.test(ref)) {
      throw new AiConfigurationError(
        'Référence de clé API non autorisée (attendu : OPENAI_API_KEY ou GED_AI_*).',
      );
    }
    if (ref === 'OPENAI_API_KEY' && !openAiAllowed) {
      throw new AiConfigurationError(
        'OPENAI_API_KEY n’est utilisable qu’avec le cloud OpenAI (fournisseur openai, hôte api.openai.com).',
      );
    }
    return nonEmpty(env[ref]) ?? nonEmpty(env.GED_AI_API_KEY);
  }
  return (
    nonEmpty(env.GED_AI_API_KEY) ?? (openAiAllowed ? nonEmpty(env.OPENAI_API_KEY) : null)
  );
}

/** Seuil de confiance : `null` si absent ou hors [0, 1] (valeur invalide = jamais d'application auto). */
function parseThreshold(raw: AiSettingRow['autoApplyThreshold'] | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw.toString());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * Configuration effective. Ligne absente, mode 0 ou mode inconnu => IA DÉSACTIVÉE (seuil `null`),
 * même si `OPENAI_API_KEY` est définie : plus aucun repli hérité. Peut lever `AiConfigurationError`.
 */
export function resolveEffectiveConfig(
  row: AiSettingRow | null,
  env: AiEnvSource,
): EffectiveAiConfig {
  const timeoutSeconds =
    row && row.timeoutSeconds > 0 ? row.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;

  if (row && row.mode === GedAiMode.Cloud) {
    const provider = row.provider ?? GED_AI_DEFAULT_CLOUD_PROVIDER;
    const endpoint = nonEmpty(row.endpoint) ?? GED_AI_DEFAULT_CLOUD_ENDPOINT;
    return {
      mode: GedAiMode.Cloud,
      provider,
      model: nonEmpty(row.model) ?? GED_AI_DEFAULT_CLOUD_MODEL,
      endpoint,
      apiKey: resolveAiApiKey(
        row.apiKeyRef,
        env,
        isOpenAiCloud(GedAiMode.Cloud, provider, endpoint),
      ),
      maskingEnabled: row.maskingEnabled,
      threshold: parseThreshold(row.autoApplyThreshold),
      timeoutSeconds,
    };
  }

  if (row && row.mode === GedAiMode.Locale) {
    return {
      mode: GedAiMode.Locale,
      provider: row.provider,
      model: nonEmpty(row.model) ?? '',
      endpoint:
        nonEmpty(row.endpoint) ??
        nonEmpty(env.GED_AI_LOCAL_ENDPOINT) ??
        GED_AI_FALLBACK_LOCAL_ENDPOINT,
      apiKey: resolveAiApiKey(row.apiKeyRef, env, false),
      maskingEnabled: row.maskingEnabled,
      threshold: parseThreshold(row.autoApplyThreshold),
      timeoutSeconds,
    };
  }

  return {
    mode: GedAiMode.Desactivee,
    provider: null,
    model: '',
    endpoint: '',
    apiKey: null,
    maskingEnabled: true,
    threshold: null,
    timeoutSeconds,
  };
}

/** Lit la ligne unique de `ged_ai_setting` puis résout la configuration effective. */
export async function loadAiConfig(
  prisma: Pick<PrismaClient, 'gedAiSetting'>,
  env: AiEnvSource,
): Promise<EffectiveAiConfig> {
  const row = await prisma.gedAiSetting.findFirst({
    select: {
      mode: true,
      provider: true,
      model: true,
      endpoint: true,
      apiKeyRef: true,
      maskingEnabled: true,
      autoApplyThreshold: true,
      timeoutSeconds: true,
    },
  });
  return resolveEffectiveConfig(row, env);
}
