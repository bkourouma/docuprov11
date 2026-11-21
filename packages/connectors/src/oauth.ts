// Lot 2b — flux d'autorisation OAuth 2.0 (code + PKCE S256) pour Google et Microsoft.
//
// Fonctions pures (aucun état, aucune écriture) utilisées par le module API : configuration du
// fournisseur, PKCE, URL d'autorisation, liste blanche des URI de redirection, `state` signé, échange
// du code contre un jeton de rafraîchissement.
//
// Règle transverse : AUCUN message d'erreur de ce fichier ne contient le code d'autorisation, le
// vérificateur PKCE, le secret client, un jeton, ni le corps d'une réponse du fournisseur. Seul le
// champ `error` (RFC 6749 §5.2) est recopié, filtré par une liste blanche de caractères : la
// `error_description` de Microsoft cite parfois des identifiants de corrélation ou l'URI demandée.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadKeyRing, redactSecrets } from './crypto';
import {
  OAuthApiError,
  OAuthConfigError,
  OAuthFlowError,
  OAuthHostError,
  type OAuthHttpClient,
  type OAuthProviderConfig,
  type OAuthProviderId,
  type OAuthStatePayload,
  type OAuthTokenResult,
  type PkcePair,
} from './oauth-contract';
import { OAuthNetworkError, createOfficialHttpClient } from './oauth-http';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MS_LOGIN_BASE = 'https://login.microsoftonline.com';

/** Plafond de lecture d'une réponse du point de jeton (quelques Ko en pratique). */
export const OAUTH_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_REFRESH_TOKEN_LENGTH = 16 * 1024;
const MAX_CODE_LENGTH = 4096;
const MAX_STATE_LENGTH = 2048;
const MAX_REDIRECT_URI_LENGTH = 2048;
const STATE_KEY_INFO = 'ged-oauth-state-v1';
const STATE_KEY_BYTES = 32;

const PROVIDERS: readonly OAuthProviderId[] = ['google', 'microsoft'];

// ---------------------------------------------------------------------------
// Configuration du fournisseur
// ---------------------------------------------------------------------------

const MS_TENANT_ALIASES = new Set(['common', 'organizations', 'consumers']);
const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Locataire Microsoft : GUID, nom de domaine (`contoso.onmicrosoft.com`) ou alias. Il est inséré dans
 * le CHEMIN des URL d'autorisation et de jeton : rien d'autre ne passe (pas de `/`, `?`, `#`, `%`,
 * `..`, `@`), sans quoi on pourrait détourner l'appel vers un autre point de terminaison.
 */
function normalizeTenant(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t.length === 0 || t.length > 253) return null;
  if (MS_TENANT_ALIASES.has(t) || GUID_REGEX.test(t)) return t;
  const labels = t.split('.');
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL_REGEX.test(l))) return null;
  // Dernier label alphabétique : exclut toute forme d'adresse IP.
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1] as string)) return null;
  return t;
}

function readVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env?.[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Lit GED_GOOGLE_CLIENT_ID/SECRET ou GED_MS_CLIENT_ID/SECRET/TENANT. `OAuthConfigError` (noms des variables manquantes) sinon. */
export function getProviderConfig(provider: OAuthProviderId, env: NodeJS.ProcessEnv): OAuthProviderConfig {
  if (provider === 'google') {
    const names = ['GED_GOOGLE_CLIENT_ID', 'GED_GOOGLE_CLIENT_SECRET'] as const;
    const [clientId, clientSecret] = names.map((n) => readVar(env, n));
    const missing = names.filter((n) => readVar(env, n) === undefined);
    if (missing.length > 0 || !clientId || !clientSecret) {
      throw new OAuthConfigError(
        `Fournisseur Google non configuré : variable(s) d’environnement manquante(s) ${missing.join(', ')}.`,
      );
    }
    return {
      provider,
      clientId,
      clientSecret,
      authorizeUrl: GOOGLE_AUTHORIZE_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
    };
  }
  if (provider === 'microsoft') {
    const names = ['GED_MS_CLIENT_ID', 'GED_MS_CLIENT_SECRET', 'GED_MS_TENANT'] as const;
    const [clientId, clientSecret, rawTenant] = names.map((n) => readVar(env, n));
    const missing = names.filter((n) => readVar(env, n) === undefined);
    if (missing.length > 0 || !clientId || !clientSecret || !rawTenant) {
      throw new OAuthConfigError(
        `Fournisseur Microsoft non configuré : variable(s) d’environnement manquante(s) ${missing.join(', ')}.`,
      );
    }
    const tenant = normalizeTenant(rawTenant);
    if (!tenant) {
      // La valeur n'est pas recopiée : seul le format attendu est rappelé.
      throw new OAuthConfigError(
        'GED_MS_TENANT invalide : identifiant de locataire (GUID), nom de domaine, ou common / organizations / consumers attendu.',
      );
    }
    return {
      provider,
      clientId,
      clientSecret,
      authorizeUrl: `${MS_LOGIN_BASE}/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `${MS_LOGIN_BASE}/${tenant}/oauth2/v2.0/token`,
      tenant,
    };
  }
  throw new OAuthConfigError('Fournisseur OAuth inconnu.');
}

// ---------------------------------------------------------------------------
// Périmètres
// ---------------------------------------------------------------------------

/** scope-token de la RFC 6749 §3.3. */
const SCOPE_TOKEN_REGEX = /^[\x21\x23-\x5b\x5d-\x7e]{1,512}$/;
const MS_GRAPH_PREFIX = 'https://graph.microsoft.com/';
/** Périmètres OpenID : ne donnent accès à aucune donnée, ignorés dans le contrôle d'octroi. */
const OIDC_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);
const GOOGLE_SCOPE_ALIASES: Record<string, string> = {
  email: 'https://www.googleapis.com/auth/userinfo.email',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
};

/**
 * Périmètres à DEMANDER : validés, dédoublonnés. Microsoft ne délivre de jeton de rafraîchissement
 * qu'avec `offline_access` : on l'ajoute s'il manque (il n'ouvre l'accès à aucune donnée).
 */
export function requestedScopes(provider: OAuthProviderId, scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new OAuthFlowError('Aucun périmètre d’accès demandé.', 'exchange_failed');
  }
  const out: string[] = [];
  for (const s of scopes) {
    if (typeof s !== 'string' || !SCOPE_TOKEN_REGEX.test(s)) {
      throw new OAuthFlowError('Périmètre d’accès invalide.', 'exchange_failed');
    }
    if (!out.includes(s)) out.push(s);
  }
  if (provider === 'microsoft' && !out.some((s) => s.toLowerCase() === 'offline_access')) {
    out.push('offline_access');
  }
  return out;
}

/** Forme comparable d'un périmètre (Microsoft : insensible à la casse, préfixe Graph implicite). */
function canonicalScope(provider: OAuthProviderId, scope: string): string {
  if (provider === 'microsoft') {
    const lower = scope.toLowerCase();
    return lower.startsWith(MS_GRAPH_PREFIX) ? lower.slice(MS_GRAPH_PREFIX.length) : lower;
  }
  return GOOGLE_SCOPE_ALIASES[scope] ?? scope;
}

/**
 * Périmètres demandés absents de l'octroi. Google pratique le consentement GRANULAIRE : l'utilisateur
 * peut décocher une case et l'échange réussit quand même, avec un jeton qui ne sert à rien. Champ
 * `scope` absent : identique à la demande (RFC 6749 §5.1).
 */
function missingScopes(
  provider: OAuthProviderId,
  requested: readonly string[],
  granted: string | undefined,
): string[] {
  if (granted === undefined) return [];
  const have = new Set(
    granted
      .split(/\s+/)
      .filter((s) => s !== '')
      .map((s) => canonicalScope(provider, s)),
  );
  return requested.filter((s) => {
    const c = canonicalScope(provider, s);
    return !OIDC_SCOPES.has(c) && !have.has(c);
  });
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

const PKCE_VERIFIER_REGEX = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_REGEX = /^[A-Za-z0-9_-]{43}$/;

/**
 * @internal Exportée pour le test du vecteur de la RFC 7636 (annexe B) :
 * `BASE64URL(SHA256(ASCII(code_verifier)))`.
 */
export function pkceS256Challenge(verifier: string): string {
  if (typeof verifier !== 'string' || !PKCE_VERIFIER_REGEX.test(verifier)) {
    throw new OAuthFlowError('Vérificateur PKCE invalide.', 'exchange_failed');
  }
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Vérifie/crée un couple PKCE S256 (verifier 43-128 car. URL-safe, aléatoire cryptographique). */
export function generatePkce(): PkcePair {
  // 32 octets aléatoires → 43 caractères base64url (256 bits d'entropie, recommandation RFC 7636 §4.1).
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceS256Challenge(verifier) };
}

// ---------------------------------------------------------------------------
// URI de redirection
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Forme normalisée (WHATWG) d'une URI de redirection admissible, ou `null`. https obligatoire, sauf
 * http vers localhost / 127.0.0.1 (développement) ; ni identifiant, ni fragment, ni caractère que le
 * parseur effacerait en silence.
 */
function normalizeRedirectUri(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Pas de trim : l'URI reçue doit être exactement celle de la liste (seules les entrées de la
  // liste, séparées par des virgules, sont débarrassées de leurs espaces).
  const s = raw;
  if (s.length === 0 || s.length > MAX_REDIRECT_URI_LENGTH) return null;
  if (/[^\x21-\x7e]/.test(s) || s.includes('\\') || s.includes('#')) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const authority = s.slice(s.indexOf('//') + 2).split(/[/?#]/)[0] ?? '';
  if (!s.includes('//') || u.username !== '' || u.password !== '' || authority.includes('@')) {
    return null;
  }
  if (u.hostname === '') return null;
  if (u.protocol === 'https:') return u.href;
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) return u.href;
  return null;
}

/** Liste blanche d'URI de redirection (variable GED_OAUTH_REDIRECT_URIS, séparée par des virgules). Entrées invalides ignorées. */
export function parseRedirectAllowList(raw: string | undefined | null): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const entry of raw.split(',')) {
    const n = normalizeRedirectUri(entry.trim());
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Correspondance EXACTE (après normalisation) ; https obligatoire sauf http://localhost / 127.0.0.1 ; pas de fragment ni d'identifiant dans l'URI. Lève `OAuthFlowError('redirect_not_allowed')`. */
export function assertRedirectUriAllowed(redirectUri: string, allowList: readonly string[]): void {
  const n = normalizeRedirectUri(redirectUri);
  const allowed =
    n !== null &&
    Array.isArray(allowList) &&
    allowList.some((entry) => typeof entry === 'string' && normalizeRedirectUri(entry.trim()) === n);
  if (!allowed) {
    // L'URI reçue n'est pas recopiée : elle vient de la requête.
    throw new OAuthFlowError(
      'URI de redirection non autorisée : elle doit figurer exactement dans GED_OAUTH_REDIRECT_URIS.',
      'redirect_not_allowed',
    );
  }
}

// ---------------------------------------------------------------------------
// URL d'autorisation
// ---------------------------------------------------------------------------

const STATE_CHARS_REGEX = /^[A-Za-z0-9._~-]+$/;

export interface BuildAuthorizationUrlInput {
  provider: OAuthProviderId;
  env: NodeJS.ProcessEnv;
  scopes: readonly string[];
  redirectUri: string;
  state: string;
  codeChallenge: string;
}
/** URL d'autorisation (accounts.google.com / login.microsoftonline.com/<tenant>) : code + PKCE S256, accès hors ligne, consentement forcé pour obtenir un jeton de rafraîchissement. */
export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const config = getProviderConfig(input.provider, input.env);
  const redirectUri = normalizeRedirectUri(input.redirectUri);
  if (redirectUri === null) {
    throw new OAuthFlowError('URI de redirection invalide.', 'redirect_not_allowed');
  }
  if (
    typeof input.state !== 'string' ||
    input.state.length === 0 ||
    input.state.length > MAX_STATE_LENGTH ||
    !STATE_CHARS_REGEX.test(input.state)
  ) {
    throw new OAuthFlowError('Paramètre state invalide.', 'state_invalid');
  }
  if (typeof input.codeChallenge !== 'string' || !PKCE_CHALLENGE_REGEX.test(input.codeChallenge)) {
    throw new OAuthFlowError('Défi PKCE invalide (S256 attendu).', 'exchange_failed');
  }
  const scopes = requestedScopes(config.provider, input.scopes);

  // Le secret client n'apparaît JAMAIS ici : l'URL part dans le navigateur.
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (config.provider === 'google') {
    // `offline` + `consent` : sans eux, Google ne renvoie un jeton de rafraîchissement qu'au premier
    // consentement de l'utilisateur. `include_granted_scopes=false` : pas d'élargissement implicite
    // aux périmètres accordés autrefois à l'application.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'false');
  } else {
    params.set('response_mode', 'query');
    params.set('prompt', 'select_account');
  }
  return `${config.authorizeUrl}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// state signé
// ---------------------------------------------------------------------------

/** Clé HMAC dérivée (HKDF-SHA256, étiquette de domaine « ged-oauth-state-v1 ») de la clé ACTIVE GED_CONNECTOR_KEY. Jamais la clé brute. */
export function deriveStateKey(env: NodeJS.ProcessEnv): Buffer {
  if (readVar(env, 'GED_CONNECTOR_KEY') === undefined) {
    throw new OAuthConfigError(
      'GED_CONNECTOR_KEY absente : impossible de signer l’état d’une autorisation OAuth.',
    );
  }
  // Les messages de `loadKeyRing` ne citent aucune clé.
  const ring = loadKeyRing(env);
  const master = ring.keys[ring.activeKeyId] as Buffer;
  // Séparation de domaine : la même clé chiffre les identifiants (AES-GCM) ; ici on n'en utilise
  // qu'une dérivée, propre à la signature du state.
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), STATE_KEY_INFO, STATE_KEY_BYTES));
}

const NONCE_REGEX = /^[A-Za-z0-9_-]{22,128}$/;
const STATE_REGEX = /^([A-Za-z0-9_-]{1,1024})\.([A-Za-z0-9_-]{43})$/;
const STATE_FIELDS = ['n', 'exp', 'uid', 'cid', 'provider'] as const;

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** Charge utile STRICTE : exactement les cinq champs attendus, bien typés. */
function asStatePayload(v: unknown): OAuthStatePayload | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== STATE_FIELDS.length || !STATE_FIELDS.every((k) => keys.includes(k))) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.n !== 'string' || !NONCE_REGEX.test(o.n)) return null;
  if (!isPositiveInt(o.exp) || !isPositiveInt(o.uid) || !isPositiveInt(o.cid)) return null;
  if (typeof o.provider !== 'string' || !PROVIDERS.includes(o.provider as OAuthProviderId)) return null;
  return { n: o.n, exp: o.exp, uid: o.uid, cid: o.cid, provider: o.provider as OAuthProviderId };
}

function assertStateKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length < STATE_KEY_BYTES) {
    throw new OAuthFlowError('Clé de signature du state invalide.', 'state_invalid');
  }
}

function stateMac(encodedPayload: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(encodedPayload, 'ascii').digest();
}

/** `base64url(payload).base64url(hmac)` — HMAC-SHA256 du payload. */
export function signOAuthState(payload: OAuthStatePayload, key: Buffer): string {
  assertStateKey(key);
  const valid = asStatePayload(payload);
  if (!valid) throw new OAuthFlowError('Charge utile du state invalide.', 'state_invalid');
  // Ordre des champs fixe : la sérialisation ne dépend pas de l'objet fourni.
  const encoded = Buffer.from(
    JSON.stringify({ n: valid.n, exp: valid.exp, uid: valid.uid, cid: valid.cid, provider: valid.provider }),
    'utf8',
  ).toString('base64url');
  return `${encoded}.${stateMac(encoded, key).toString('base64url')}`;
}

/** Vérifie signature (temps constant), forme et expiration. `OAuthFlowError` `state_invalid` / `state_expired`. */
export function verifyOAuthState(state: string, key: Buffer, now: Date): OAuthStatePayload {
  assertStateKey(key);
  const invalid = (): OAuthFlowError =>
    new OAuthFlowError('Autorisation refusée : paramètre state invalide.', 'state_invalid');
  if (typeof state !== 'string' || state.length > MAX_STATE_LENGTH) throw invalid();
  const m = STATE_REGEX.exec(state);
  if (!m) throw invalid();
  const encoded = m[1] as string;
  const given = Buffer.from(m[2] as string, 'base64url');
  const expected = stateMac(encoded, key);
  // Signature AVANT toute analyse du contenu : rien de ce qu'envoie un tiers n'est lu sans elle.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const payload = asStatePayload(parsed);
  if (!payload) throw invalid();
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMs) || payload.exp * 1000 <= nowMs) {
    throw new OAuthFlowError(
      'Autorisation expirée : recommencez depuis l’écran du connecteur.',
      'state_expired',
    );
  }
  return payload;
}

/** Nonce aléatoire (≥ 128 bits, base64url). */
export function newOAuthNonce(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Échange du code
// ---------------------------------------------------------------------------

/** Code d'erreur OAuth (`invalid_grant`…) recopiable sans risque, sinon `undefined`. */
export function safeOAuthErrorCode(body: unknown): string | undefined {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(e) ? e : undefined;
}

function parseJsonObject(buf: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface ExchangeCodeInput {
  provider: OAuthProviderId;
  env: NodeJS.ProcessEnv;
  scopes: readonly string[];
  redirectUri: string;
  code: string;
  codeVerifier: string;
  http?: OAuthHttpClient;
  now?: () => Date;
}
/** Échange le code (PKCE) contre un jeton de rafraîchissement. `OAuthFlowError('exchange_failed' | 'no_refresh_token')` sans jamais citer code, verifier, secret ni jeton. */
export async function exchangeAuthorizationCode(input: ExchangeCodeInput): Promise<OAuthTokenResult> {
  const config = getProviderConfig(input.provider, input.env);
  const fail = (msg: string): OAuthFlowError => new OAuthFlowError(msg, 'exchange_failed');
  const redirectUri = normalizeRedirectUri(input.redirectUri);
  if (redirectUri === null) {
    throw new OAuthFlowError('URI de redirection invalide.', 'redirect_not_allowed');
  }
  if (
    typeof input.code !== 'string' ||
    input.code.length === 0 ||
    input.code.length > MAX_CODE_LENGTH ||
    /[^\x21-\x7e]/.test(input.code)
  ) {
    throw fail('Code d’autorisation absent ou mal formé.');
  }
  if (typeof input.codeVerifier !== 'string' || !PKCE_VERIFIER_REGEX.test(input.codeVerifier)) {
    throw fail('Vérificateur PKCE invalide.');
  }
  const scopes = requestedScopes(config.provider, input.scopes);
  const sensitive: Record<string, string> = {
    code: input.code,
    verifier: input.codeVerifier,
    secret: config.clientSecret,
  };

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: input.codeVerifier,
  });
  if (config.provider === 'microsoft') form.set('scope', scopes.join(' '));

  const http = input.http ?? createOfficialHttpClient();
  let res;
  try {
    res = await http.request({
      method: 'POST',
      url: config.tokenUrl,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      maxBytes: OAUTH_TOKEN_RESPONSE_MAX_BYTES,
      redirects: 'none',
    });
  } catch (err) {
    // Seules les erreurs du client gardé (messages sûrs : nom d'hôte, code système) sont détaillées,
    // filtrées quand même ; toute autre erreur pourrait citer la requête ou la réponse.
    const safe =
      err instanceof OAuthHostError || err instanceof OAuthNetworkError || err instanceof OAuthApiError;
    const detail = safe ? redactSecrets(err.message, sensitive) : '';
    throw fail(
      `Échange du code d’autorisation impossible : fournisseur injoignable${detail ? ` (${detail})` : ''}.`,
    );
  }

  const body = parseJsonObject(res.body);
  if (res.status !== 200 || body === null) {
    const code = safeOAuthErrorCode(body);
    if (code === 'invalid_grant') {
      throw fail(
        'Échange du code refusé (invalid_grant) : code expiré ou déjà utilisé, recommencez l’autorisation.',
      );
    }
    throw fail(
      code
        ? `Échange du code refusé par le fournisseur (${code}).`
        : `Échange du code refusé par le fournisseur (réponse ${Number(res.status) || 0}).`,
    );
  }

  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new OAuthFlowError(
      'Le fournisseur n’a pas délivré de jeton de rafraîchissement : retirez l’accès de DocuPro dans le compte concerné, puis autorisez de nouveau.',
      'no_refresh_token',
    );
  }
  if (refreshToken.length > MAX_REFRESH_TOKEN_LENGTH || /[^\x21-\x7e]/.test(refreshToken)) {
    throw fail('Réponse du fournisseur invalide (jeton de rafraîchissement mal formé).');
  }

  const scope = typeof body.scope === 'string' ? body.scope : undefined;
  if (missingScopes(config.provider, scopes, scope).length > 0) {
    // Les noms des périmètres manquants ne sont pas secrets, mais le message reste générique : il
    // est affiché tel quel à l'administrateur, qui doit simplement tout cocher.
    throw fail(
      'Autorisation incomplète : tous les accès demandés doivent être acceptés. Recommencez en cochant toutes les cases.',
    );
  }

  const result: OAuthTokenResult = { refreshToken };
  if (scope !== undefined) result.scope = scope.slice(0, 4096);
  const ttl = body.refresh_token_expires_in;
  const ttlSeconds = typeof ttl === 'string' && /^\d+$/.test(ttl) ? Number(ttl) : ttl;
  if (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    const now = (input.now ?? (() => new Date()))();
    result.refreshTokenExpiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  }
  return result;
}
