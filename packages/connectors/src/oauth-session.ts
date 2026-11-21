// Lot 2b — client d'API authentifié (jeton d'accès géré) pour les connecteurs Google / Microsoft.
//
// Le connecteur ne voit jamais un jeton : il passe des URL, la session ajoute `Authorization`.
//  - Jeton d'accès en mémoire seulement, réutilisé jusqu'à 60 s avant son expiration ; un seul
//    rafraîchissement en vol à la fois (les appels concurrents l'attendent au lieu d'en lancer d'autres,
//    ce qui ferait tourner plusieurs fois le jeton de rafraîchissement Microsoft).
//  - TOUTE URL est validée (https, hôte officiel du fournisseur, port 443) — `nextLink` et URL de
//    jeton de changement relues en base comprises.
//  - Erreurs typées pour le moteur de synchro : autorisation (`ConnectorAuthError`), quota
//    (`ConnectorQuotaError`), fichier trop gros (`ConnectorItemRejectedError`), autres (`OAuthApiError`).
//  - Aucun jeton, secret client ni jeton de rafraîchissement dans un message : tout message dynamique
//    passe par `redactSecrets`. Ce module n'écrit rien dans les journaux.
import { redactSecrets } from './crypto';
import {
  OAuthApiError,
  type CreateOAuthApiClientOptions,
  type OAuthApiClient,
  type OAuthHttpClient,
  type OAuthHttpResponse,
  type OAuthProviderConfig,
  type OAuthProviderId,
  type OAuthRequestOptions,
} from './oauth-contract';
import { assertOfficialApiUrl, createOfficialHttpClient, OAUTH_DEFAULT_MAX_BYTES } from './oauth-http';
import {
  OAUTH_TOKEN_RESPONSE_MAX_BYTES,
  getProviderConfig,
  requestedScopes,
  safeOAuthErrorCode,
} from './oauth';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ConnectorCredentials,
} from './types';

/** Marge avant expiration : un jeton qui expire dans moins de 60 s est rafraîchi d'avance. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;
/** Durée retenue si le fournisseur n'indique pas `expires_in` (prudente : un 401 rafraîchit de toute façon). */
const DEFAULT_ACCESS_TOKEN_TTL_S = 300;
const MAX_ACCESS_TOKEN_LENGTH = 16 * 1024;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const RETRY_AFTER_MIN_MS = 1_000;
const RETRY_AFTER_MAX_MS = 6 * 60 * 60_000;
/** Raisons Google d'un 403 de LIMITATION (et non de refus d'accès). */
const GOOGLE_QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);
/** Codes d'erreur du point de jeton qui imposent une nouvelle autorisation par l'administrateur. */
const REAUTHORIZE_ERRORS = new Set([
  'invalid_grant',
  'interaction_required',
  'consent_required',
  'login_required',
  'invalid_scope',
]);
const CLIENT_ERRORS = new Set(['invalid_client', 'unauthorized_client']);
/** En-têtes que le connecteur ne peut pas imposer : l'authentification est l'affaire de la session. */
const FORBIDDEN_CALLER_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'host']);
const PROVIDER_LABEL: Record<OAuthProviderId, string> = { google: 'Google', microsoft: 'Microsoft' };

const MSG_NOT_AUTHORIZED =
  'Connecteur non autorisé : autorisez l’accès au compte depuis l’écran du connecteur.';
const MSG_EXPIRED = 'Autorisation expirée ou révoquée : autorisez de nouveau l’accès au compte.';

/**
 * Délai d'attente demandé par `Retry-After` : secondes OU date HTTP. Borné à [1 s, 6 h] ; absent ou
 * illisible : 60 s.
 */
export function parseRetryAfterMs(value: string | undefined, now: Date): number {
  let ms = RETRY_AFTER_DEFAULT_MS;
  const v = typeof value === 'string' ? value.trim() : '';
  if (/^\d{1,10}$/.test(v)) {
    ms = Number(v) * 1000;
  } else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v)) {
    // Date HTTP (IMF-fixdate, RFC 9110 §5.6.7) seulement : `Date.parse` accepte bien d'autres
    // formes (« -5 » devient l'an -5), qu'on ne veut pas interpréter.
    const at = Date.parse(v);
    if (Number.isFinite(at)) ms = at - now.getTime();
  }
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Raison d'erreur d'API, filtrée (Google : `error.errors[].reason` / `error.status` ; Graph : `error.code`). */
function apiErrorReasons(body: unknown): string[] {
  const out: string[] = [];
  const err = (body as { error?: unknown } | null | undefined)?.error;
  const push = (v: unknown): void => {
    if (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v)) out.push(v);
  };
  if (err && typeof err === 'object') {
    const e = err as { errors?: unknown; status?: unknown; code?: unknown };
    if (Array.isArray(e.errors)) {
      for (const item of e.errors.slice(0, 20)) push((item as { reason?: unknown } | null)?.reason);
    }
    push(e.code);
    push(e.status);
  } else {
    push(err);
  }
  return out;
}

export function createOAuthApiClient(opts: CreateOAuthApiClientOptions): OAuthApiClient {
  const provider = opts.provider;
  if (provider !== 'google' && provider !== 'microsoft') {
    throw new ConnectorAuthError('Fournisseur OAuth inconnu.', false);
  }
  const label = PROVIDER_LABEL[provider];
  const http: OAuthHttpClient = opts.http ?? createOfficialHttpClient();
  const now = opts.now ?? (() => new Date());
  let credentials: ConnectorCredentials = { ...(opts.credentials ?? {}) };
  let accessToken: string | null = null;
  let accessTokenExpiresAt = 0;
  let inflight: Promise<string> | null = null;
  let config: OAuthProviderConfig | null = null;
  /** Toutes les valeurs sensibles vues (jetons successifs compris), pour le masquage. */
  const secrets = new Set<string>();
  const remember = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') secrets.add(v);
  };
  Object.values(credentials).forEach(remember);

  const redact = (text: string): string => {
    const record: Record<string, string> = {};
    let i = 0;
    for (const s of secrets) record[`s${i++}`] = s;
    return redactSecrets(text, record);
  };
  /** Dernière barrière : masque message ET pile de toute erreur qui sort de la session. */
  const scrub = <E>(err: E): E => {
    if (err instanceof Error) {
      try {
        err.message = redact(err.message);
        if (typeof err.stack === 'string') err.stack = redact(err.stack);
      } catch {
        // Erreur gelée : on la laisse telle quelle plutôt que d'en masquer une autre.
      }
    }
    return err;
  };

  function getConfig(): OAuthProviderConfig {
    if (!config) {
      config = getProviderConfig(provider, opts.env);
      remember(config.clientSecret);
      // L'URL de jeton est construite ici, mais rien ne coûte de la revalider.
      assertOfficialApiUrl(config.tokenUrl, provider);
    }
    return config;
  }

  function quotaError(res: OAuthHttpResponse): ConnectorQuotaError {
    const ms = parseRetryAfterMs(res.headers['retry-after'], now());
    return new ConnectorQuotaError(
      `Limite de débit de l’API ${label} atteinte (réponse ${res.status}) : reprise dans ${Math.ceil(ms / 1000)} s.`,
      ms,
    );
  }

  function isQuota(res: OAuthHttpResponse, body: unknown): boolean {
    if (res.status === 429 || res.status === 503 || res.status === 504) return true;
    if (provider === 'google' && res.status === 403) {
      return apiErrorReasons(body).some((r) => GOOGLE_QUOTA_REASONS.has(r));
    }
    return false;
  }

  async function refresh(): Promise<string> {
    const refreshToken = credentials.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new ConnectorAuthError(MSG_NOT_AUTHORIZED, true);
    }
    const cfg = getConfig();
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    // Microsoft (v2) demande les périmètres à chaque rafraîchissement ; Google réutilise l'octroi.
    if (provider === 'microsoft') form.set('scope', requestedScopes(provider, opts.scopes).join(' '));

    const res = await http.request({
      method: 'POST',
      url: cfg.tokenUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      maxBytes: OAUTH_TOKEN_RESPONSE_MAX_BYTES,
      redirects: 'none',
    });
    const body = parseJson(res.body);
    if (res.status !== 200) {
      const code = safeOAuthErrorCode(body);
      if (code && REAUTHORIZE_ERRORS.has(code)) throw new ConnectorAuthError(MSG_EXPIRED, true);
      if (code && CLIENT_ERRORS.has(code)) {
        throw new ConnectorAuthError(
          `Identifiants de l’application ${label} refusés (${code}) : vérifiez ${provider === 'google' ? 'GED_GOOGLE_CLIENT_ID / GED_GOOGLE_CLIENT_SECRET' : 'GED_MS_CLIENT_ID / GED_MS_CLIENT_SECRET'}.`,
          false,
        );
      }
      if (isQuota(res, body)) throw quotaError(res);
      throw new OAuthApiError(
        `Rafraîchissement du jeton ${label} refusé (réponse ${res.status}${code ? `, ${code}` : ''}).`,
        res.status,
        code,
      );
    }
    const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const token = o.access_token;
    if (
      typeof token !== 'string' ||
      token === '' ||
      token.length > MAX_ACCESS_TOKEN_LENGTH ||
      /[^\x21-\x7e]/.test(token)
    ) {
      throw new OAuthApiError(`Réponse de jeton ${label} invalide.`, res.status, 'invalid_token_response');
    }
    remember(token);
    const rawTtl = o.expires_in;
    const ttl = typeof rawTtl === 'string' && /^\d+$/.test(rawTtl) ? Number(rawTtl) : rawTtl;
    const ttlS = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ACCESS_TOKEN_TTL_S;
    accessToken = token;
    accessTokenExpiresAt = now().getTime() + ttlS * 1000;

    // Rotation (Microsoft) : le nouveau jeton sert immédiatement ; sa persistance est l'affaire de
    // l'appelant. Si elle échoue, la passe continue avec le jeton en mémoire.
    const rotated = o.refresh_token;
    if (
      typeof rotated === 'string' &&
      rotated !== '' &&
      rotated !== refreshToken &&
      rotated.length <= MAX_ACCESS_TOKEN_LENGTH &&
      !/[^\x21-\x7e]/.test(rotated)
    ) {
      remember(rotated);
      credentials = { ...credentials, refreshToken: rotated };
      if (opts.onCredentialsChanged) {
        try {
          await opts.onCredentialsChanged({ ...credentials });
        } catch {
          // Avalée volontairement (aucun journal ici) : l'erreur pourrait d'ailleurs citer le jeton.
        }
      }
    }
    return token;
  }

  /** Jeton valide (cache, sinon rafraîchissement unique partagé). `stale` : jeton refusé par un 401. */
  async function getAccessToken(stale?: string): Promise<string> {
    const fresh =
      accessToken !== null && now().getTime() < accessTokenExpiresAt - ACCESS_TOKEN_MARGIN_MS;
    if (fresh && accessToken !== null && (stale === undefined || accessToken !== stale)) {
      return accessToken;
    }
    if (stale !== undefined && accessToken === stale) {
      accessToken = null;
      accessTokenExpiresAt = 0;
    }
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function callerHeaders(extra: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(extra ?? {})) {
      if (FORBIDDEN_CALLER_HEADERS.has(name.toLowerCase())) continue;
      out[name] = value;
    }
    return out;
  }

  async function call(
    rawUrl: string,
    opts2: OAuthRequestOptions & { maxBytes: number; redirects: 'none' | 'download'; accept?: string },
  ): Promise<OAuthHttpResponse> {
    // Validation AVANT d'obtenir un jeton : une URL piégée n'en déclenche même pas le rafraîchissement.
    const url = assertOfficialApiUrl(rawUrl, provider).href;
    let token = await getAccessToken();
    for (let attempt = 0; ; attempt++) {
      const headers = callerHeaders(opts2.headers);
      if (opts2.accept && !Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) {
        headers.accept = opts2.accept;
      }
      headers.authorization = `Bearer ${token}`;
      const res = await http.request({
        method: 'GET',
        url,
        headers,
        signal: opts2.signal,
        maxBytes: opts2.maxBytes,
        redirects: opts2.redirects,
      });
      if (res.status === 401 && attempt === 0) {
        // Jeton révoqué ou expiré plus tôt que prévu : UN rafraîchissement forcé, UN nouvel essai.
        token = await getAccessToken(token);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status === 401) {
        throw new ConnectorAuthError(
          `Accès refusé par l’API ${label} malgré un jeton neuf : vérifiez l’autorisation du connecteur.`,
          false,
        );
      }
      const body = parseJson(res.body);
      if (isQuota(res, body)) throw quotaError(res);
      const reason = apiErrorReasons(body)[0];
      throw new OAuthApiError(
        `Erreur ${res.status} de l’API ${label}${reason ? ` (${reason})` : ''}.`,
        res.status,
        reason,
      );
    }
  }

  return {
    async authenticate(): Promise<void> {
      try {
        await getAccessToken();
      } catch (err) {
        throw scrub(err);
      }
    },

    async getJson<T = unknown>(url: string, o?: OAuthRequestOptions): Promise<T> {
      try {
        const res = await call(url, {
          ...o,
          maxBytes: OAUTH_DEFAULT_MAX_BYTES,
          redirects: 'none',
          accept: 'application/json',
        });
        if (res.body.length === 0) return undefined as T;
        const parsed = parseJson(res.body);
        if (parsed === undefined) {
          throw new OAuthApiError(`Réponse JSON invalide de l’API ${label}.`, res.status, 'invalid_json');
        }
        return parsed as T;
      } catch (err) {
        throw scrub(err);
      }
    },

    async getBytes(
      url: string,
      o: OAuthRequestOptions & { maxBytes: number; followDownloadRedirect?: boolean },
    ): Promise<{ bytes: Buffer; contentType?: string }> {
      const maxBytes = o?.maxBytes;
      try {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
          throw new ConnectorItemRejectedError('Plafond de taille de fichier invalide.');
        }
        let res: OAuthHttpResponse;
        try {
          res = await call(url, {
            signal: o.signal,
            headers: o.headers,
            maxBytes,
            redirects: o.followDownloadRedirect ? 'download' : 'none',
          });
        } catch (err) {
          if (err instanceof OAuthApiError && err.status === 413) {
            throw new ConnectorItemRejectedError(
              `Fichier trop volumineux (plafond ${maxBytes} octets).`,
            );
          }
          throw err;
        }
        // Client injecté qui n'appliquerait pas la borne : on ne tronque pas, on refuse.
        if (res.body.length > maxBytes) {
          throw new ConnectorItemRejectedError(`Fichier trop volumineux (plafond ${maxBytes} octets).`);
        }
        const contentType = res.headers['content-type'];
        return contentType ? { bytes: res.body, contentType } : { bytes: res.body };
      } catch (err) {
        throw scrub(err);
      }
    },
  };
}
