/**
 * Aides GED (T4) : socle IA, recherche IA, gouvernance — sans aucun fournisseur IA réel.
 *
 * Toute la suite T4 suppose l'IA DÉSACTIVÉE (`ged_ai_setting.mode = 0` ou ligne absente) : c'est le
 * seul état hermétique. `expectAiDisabled` le vérifie en tête des tests qui en dépendent, pour
 * qu'un écart de configuration de la pile échoue avec un message clair plutôt qu'en cascade.
 *
 * Écrites contre le contrat des fixtures (lot 0) : `api.raw.<verbe>` renvoie la réponse Playwright
 * (`status()`, `json()`, `text()`, `headers()`) sans lever.
 */
import type { APIResponse, Browser, Locator, Page } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';
import type { GedApi, GedUser } from './users';
import { antSelectTrigger } from './espaces';

/** Réponse brute (`api.raw.<verbe>`) : `APIResponse` de Playwright. */
export type RawResponse = APIResponse;

/** Client REST des fixtures, avec la variante brute `raw` (aucune levée sur >= 400). */
export type T4Api = ApiClient;

export type T4ApiAs = (username: string, password: string) => Promise<ApiClient>;

/** Identités conservées pour les specs existantes : `api` et `apiAs` sont déjà du bon type. */
export const asT4 = (api: ApiClient): T4Api => api;
export const asT4As = (apiAs: T4ApiAs): T4ApiAs => apiAs;

// --- Libellés exacts (copiés de @archivage/types et des composants ; apostrophes typographiques) ---

export const AI_DISABLED_MESSAGE = 'IA désactivée';

export const SEMANTIC_FALLBACK_MESSAGE =
  'L’IA est désactivée : voici les résultats de la recherche plein texte. La recherche sémantique et les réponses aux questions sont indisponibles.';

export const GOVERNANCE_AI_OFF_MESSAGE =
  'IA désactivée : seules les détections déterministes (empreintes, motifs de données personnelles) sont actives. ' +
  'Les quasi-doublons par similarité sémantique et l’avis du modèle sont indisponibles.';

/** Champs EXACTS de la vue `GET /ged/ai/settings` (`AiSettingsView`) : aucune valeur de clé. */
export const AI_SETTINGS_VIEW_KEYS = [
  'apiKeyConfigured',
  'apiKeyRef',
  'autoApplyThreshold',
  'embeddingDimension',
  'embeddingModel',
  'endpoint',
  'maskingEnabled',
  'mode',
  'model',
  'provider',
  'timeoutSeconds',
  'updatedAt',
  'updatedBy',
] as const;

export interface AiSettingsView {
  mode: 0 | 1 | 2;
  provider: string | null;
  model: string | null;
  embeddingModel: string | null;
  embeddingDimension: number;
  endpoint: string | null;
  apiKeyRef: string | null;
  maskingEnabled: boolean;
  autoApplyThreshold: number | null;
  timeoutSeconds: number;
  updatedAt: string | null;
  updatedBy: number | null;
  apiKeyConfigured: boolean;
}

/** Texte d'erreur d'une réponse `{ code, message }` (message chaîne ou tableau de chaînes). */
export async function errorText(res: RawResponse): Promise<string> {
  const raw = await res.text();
  try {
    const body = JSON.parse(raw) as { message?: unknown };
    if (typeof body.message === 'string') return body.message;
    if (Array.isArray(body.message)) return body.message.map(String).join(' | ');
  } catch {
    /* corps non JSON : on rend le texte brut */
  }
  return raw;
}

/** Échoue clairement si l'IA n'est pas désactivée sur la pile (prérequis de la suite T4). */
export async function expectAiDisabled(api: GedApi): Promise<void> {
  const status = await api.get<{ enabled: boolean; mode: number; message?: string }>('/ged/ai/status');
  if (status.enabled !== false || status.mode !== 0) {
    throw new Error(
      `Prérequis T4 non tenu : l'IA doit être désactivée sur la pile E2E (reçu ${JSON.stringify(status)}).`,
    );
  }
}

export function getAiSettings(api: GedApi): Promise<AiSettingsView> {
  return api.get<AiSettingsView>('/ged/ai/settings');
}

/** Champs inscriptibles de la vue (corps accepté par `PUT /ged/ai/settings`). */
function writableOf(v: AiSettingsView) {
  return {
    mode: v.mode,
    provider: v.provider,
    model: v.model,
    embeddingModel: v.embeddingModel,
    endpoint: v.endpoint,
    apiKeyRef: v.apiKeyRef,
    maskingEnabled: v.maskingEnabled,
    autoApplyThreshold: v.autoApplyThreshold,
    timeoutSeconds: v.timeoutSeconds,
  };
}

/**
 * Exécute `fn` puis RESTAURE le paramétrage IA global tel qu'il était (réglage partagé par tous les
 * tests de la pile). `fn` ne doit jamais activer l'IA : seuls des champs sans effet en mode 0 sont
 * modifiés par la suite T4.
 */
export async function withAiSettingsRestored<T>(
  api: GedApi,
  fn: (initial: AiSettingsView) => Promise<T>,
): Promise<T> {
  const initial = await getAiSettings(api);
  try {
    return await fn(initial);
  } finally {
    await api.put('/ged/ai/settings', writableOf(initial));
  }
}

// --- Aides d'interface communes à T4 ---------------------------------------------------------------

export type LoginAs = (page: Page, username: string, password: string) => Promise<unknown>;

/**
 * Ouvre un NOUVEAU contexte navigateur, vierge (aucun jeton administrateur hérité du storageState),
 * et y connecte `user` par l'écran de connexion. À fermer par `close()` (try/finally).
 */
export async function openPageAs(
  browser: Browser,
  loginAs: LoginAs,
  user: Pick<GedUser, 'username' | 'password'>,
  baseURL: string | undefined,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await loginAs(page, user.username, user.password);
  } catch (e) {
    await context.close();
    throw e;
  }
  return { page, close: () => context.close() };
}

/**
 * Choisit une option d'un `Select` Ant Design : ouvre la liste depuis `trigger` (le combobox, trouvé
 * par son libellé), puis clique l'option visible dont l'attribut `title` vaut `title` (AntD le pose
 * pour tout libellé texte).
 */
export async function pickAntOption(page: Page, trigger: Locator, title: string): Promise<void> {
  // Le libellé de la valeur choisie recouvre l'<input> du combobox : clic sur le sélecteur parent.
  await antSelectTrigger(trigger).click();
  const option = page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${title}"]`);
  await option.click();
}

/** Prédicat de réponse réseau : méthode + fin de chemin (API_BASE peut être relatif ou absolu). */
export function isApiCall(method: string, pathEnd: string) {
  return (r: { url(): string; request(): { method(): string } }) =>
    r.request().method() === method && new URL(r.url()).pathname.endsWith(pathEnd);
}

/** Identifiants très grands, valides pour la validation (int4) mais qui n'existent pas en base E2E. */
export const MISSING_ID = 2147483000;
export const MISSING_ID_2 = 2147483001;
