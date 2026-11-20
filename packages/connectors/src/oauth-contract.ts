// Lot 2b — contrat du socle OAuth 2.0 (Google, Microsoft). Types SEULEMENT : les implémentations sont
// dans oauth.ts (fonctions pures), oauth-http.ts (client HTTP gardé) et oauth-session.ts (jeton d'accès
// + appels d'API). Les connecteurs google_drive / microsoft_* et le module API oauth codent contre ces
// types ; toute évolution se discute avec le chef de lot.
import type { ConnectorCredentials } from './types';

export type OAuthProviderId = 'google' | 'microsoft';

// ---------------------------------------------------------------------------
// Client HTTP gardé (SSRF) — injectable pour les tests (aucun appel réseau réel)
// ---------------------------------------------------------------------------

export interface OAuthHttpRequest {
  method: 'GET' | 'POST';
  /** URL absolue https. Hôte validé contre la liste officielle AVANT tout appel. */
  url: string;
  headers?: Record<string, string>;
  /** Corps déjà sérialisé (application/x-www-form-urlencoded pour les jetons). */
  body?: string;
  signal?: AbortSignal;
  /** Plafond de lecture de la réponse (octets) ; au-delà : erreur, jamais de troncature silencieuse. */
  maxBytes?: number;
  /**
   * `'none'` (défaut) : toute redirection est REFUSÉE. `'download'` : au plus 3 redirections, seulement
   * vers les hôtes de téléchargement officiels (voir `OAUTH_DOWNLOAD_HOST_SUFFIXES`), l'en-tête
   * Authorization n'est JAMAIS transmis après une redirection.
   */
  redirects?: 'none' | 'download';
}

export interface OAuthHttpResponse {
  status: number;
  /** Noms d'en-têtes en minuscules. */
  headers: Record<string, string>;
  body: Buffer;
}

export interface OAuthHttpClient {
  request(req: OAuthHttpRequest): Promise<OAuthHttpResponse>;
}

/** Hôtes d'API officiels, par fournisseur (correspondance EXACTE du nom d'hôte, https, port 443). */
export const OAUTH_API_HOSTS: Record<OAuthProviderId, readonly string[]> = {
  google: ['www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com'],
  microsoft: ['graph.microsoft.com', 'login.microsoftonline.com'],
};

/**
 * Suffixes d'hôtes de TÉLÉCHARGEMENT autorisés comme cible de redirection (Graph répond par un 302
 * vers une URL pré-authentifiée SharePoint / OneDrive). Jamais pour un appel direct d'API.
 */
export const OAUTH_DOWNLOAD_HOST_SUFFIXES = ['.sharepoint.com', '.files.1drv.com', '.1drv.com'] as const;

// ---------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------

/** Hôte / schéma / redirection refusé par la garde. Message sans jeton ni URL complète. */
export class OAuthHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthHostError';
  }
}

/** Fournisseur non configuré (variables d'environnement absentes) : message = NOMS des variables. */
export class OAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

/** Échec d'un protocole OAuth (state invalide, échange de code refusé…). Message sûr (sans secret). */
export class OAuthFlowError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'state_invalid'
      | 'state_expired'
      | 'state_replayed'
      | 'state_mismatch'
      | 'redirect_not_allowed'
      | 'exchange_failed'
      | 'no_refresh_token',
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

/** Réponse d'API non traitée par le client (404, 400, 403 hors quota…). Message sans jeton. */
export class OAuthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'OAuthApiError';
  }
}

// ---------------------------------------------------------------------------
// Fonctions pures du flux d'autorisation (code + PKCE)
// ---------------------------------------------------------------------------

export interface OAuthProviderConfig {
  provider: OAuthProviderId;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Locataire Microsoft (`GED_MS_TENANT`), absent pour Google. */
  tenant?: string;
}

export interface PkcePair {
  verifier: string;
  /** S256 uniquement. */
  challenge: string;
}

export interface OAuthStatePayload {
  /** Nonce aléatoire (usage unique, clé de la table d'état). */
  n: string;
  /** Expiration, secondes epoch. */
  exp: number;
  /** `userId` (compte) de l'administrateur auquel l'état est lié. */
  uid: number;
  /** Connecteur à autoriser. */
  cid: number;
  provider: OAuthProviderId;
}

export interface OAuthTokenResult {
  refreshToken: string;
  /** Périmètre accordé (texte du fournisseur), pour affichage/diagnostic. */
  scope?: string;
  /** Date d'expiration de l'autorisation si le fournisseur la donne (Google : `refresh_token_expires_in`). */
  refreshTokenExpiresAt?: Date;
}

// ---------------------------------------------------------------------------
// Client d'API authentifié (utilisé par les connecteurs)
// ---------------------------------------------------------------------------

export interface OAuthRequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Appels d'API authentifiés avec un jeton d'accès géré (rafraîchi si besoin). TOUTE URL passée est
 * validée : https, hôte officiel du fournisseur, port 443 — y compris les `nextLink` et URL de jeton
 * de changement relues en base. Gère : 401 (un rafraîchissement puis un seul nouvel essai),
 * `invalid_grant` → `ConnectorAuthError(expired=true)`, 429 / 503 avec Retry-After et 403 de quota
 * Google (`rateLimitExceeded`, `userRateLimitExceeded`, `sharingRateLimitExceeded`) →
 * `ConnectorQuotaError(retryAfterMs)`, autres statuts ≥ 400 → `OAuthApiError` (404 inclus : les
 * connecteurs l'interprètent). Aucun message d'erreur ne contient de jeton.
 */
export interface OAuthApiClient {
  /** Obtient (ou rafraîchit) un jeton d'accès. `ConnectorAuthError` si l'autorisation est absente/expirée/révoquée. */
  authenticate(): Promise<void>;
  getJson<T = unknown>(url: string, opts?: OAuthRequestOptions): Promise<T>;
  /** Contenu borné par `maxBytes`. `followDownloadRedirect` : redirection vers hôte de téléchargement officiel (Graph). */
  getBytes(
    url: string,
    opts: OAuthRequestOptions & { maxBytes: number; followDownloadRedirect?: boolean },
  ): Promise<{ bytes: Buffer; contentType?: string }>;
}

export interface CreateOAuthApiClientOptions {
  provider: OAuthProviderId;
  credentials: ConnectorCredentials;
  env: NodeJS.ProcessEnv;
  scopes: readonly string[];
  /** Client HTTP (défaut : client gardé réel). */
  http?: OAuthHttpClient;
  now?: () => Date;
  /** Appelé quand le fournisseur fait tourner le jeton de rafraîchissement (Microsoft) : à persister chiffré. */
  onCredentialsChanged?: (next: ConnectorCredentials) => Promise<void>;
}
