// Lot 2b — client HTTP gardé (SSRF) pour les API OAuth officielles (Google, Microsoft).
//
// Menace : une URL d'API vient souvent d'ailleurs que du code — `nextLink` d'une page Graph, jeton de
// changement relu en base, en-tête `Location` d'une redirection. Si l'une d'elles pointait vers un
// hôte arbitraire, le jeton d'accès (envoyé en `Authorization`) partirait chez un tiers, ou le worker
// servirait de relais vers le réseau interne. D'où, AVANT tout octet envoyé :
//  - https seulement, port 443, aucun identifiant dans l'URL, jamais d'IP littérale ;
//  - nom d'hôte en correspondance EXACTE avec la liste officielle (`OAUTH_API_HOSTS`) : pas de
//    suffixe, pas de sous-domaine (`graph.microsoft.com.evil.com` est refusé) ;
//  - résolution DNS puis connexion sur l'adresse VÉRIFIÉE (anti DNS-rebinding), nom d'origine en SNI
//    et contrôle du certificat ; toute adresse interne/réservée est refusée, et la liste blanche de
//    l'exploitant (GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS) ne s'applique PAS ici : une API officielle
//    n'a aucune raison de résoudre vers le réseau interne ;
//  - aucune redirection suivie, sauf mode `download` (≤ 3 sauts vers les hôtes de téléchargement
//    officiels, sans `Authorization` ni `Cookie`) ;
//  - lecture en flux bornée (jamais de troncature silencieuse) et délai global.
//
// `fetch` n'est pas utilisé : il suit les redirections par défaut, ne laisse pas imposer l'adresse
// de connexion, et sa lecture bornée demande autant de code que `node:https`.
//
// Les messages d'erreur ne contiennent ni jeton ni URL complète : le nom d'hôte seulement.
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import {
  OAUTH_API_HOSTS,
  OAUTH_DOWNLOAD_HOST_SUFFIXES,
  OAuthApiError,
  OAuthHostError,
  type OAuthHttpClient,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type OAuthProviderId,
} from './oauth-contract';
import { assertPublicHost, isBlockedAddress } from './ssrf';

/** Délai global par défaut (connexion + redirections + lecture complète). */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
/** Plafond de lecture par défaut (réponses JSON d'API). Les téléchargements passent leur propre borne. */
export const OAUTH_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
/** Redirections suivies au plus en mode `download`. */
export const OAUTH_MAX_DOWNLOAD_REDIRECTS = 3;
const MAX_URL_LENGTH = 8192;
/** En-têtes jamais transmis après une redirection (identifiants). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
/** En-têtes que l'appelant ne peut pas imposer : le client les calcule lui-même. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-connection',
]);
const LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEADER_NAME_REGEX = /^[!#$%&'*+.^_`|~0-9a-z-]{1,128}$/;
const PROVIDER_LABEL: Record<OAuthProviderId, string> = { google: 'Google', microsoft: 'Microsoft' };

/**
 * Échec réseau (connexion, TLS, délai) vers un hôte officiel. Message sûr : nom d'hôte et code
 * système filtré (`ECONNRESET`, `CERT_HAS_EXPIRED`…), jamais l'URL ni un en-tête.
 */
export class OAuthNetworkError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OAuthNetworkError';
  }
}

// ---------------------------------------------------------------------------
// Validation des URL
// ---------------------------------------------------------------------------

function hostLabel(hostname: string): string {
  // Le nom d'hôte sort du parseur WHATWG (ASCII, punycode) ; on le borne pour le message.
  return hostname.length > 253 ? `${hostname.slice(0, 253)}…` : hostname;
}

/** Forme commune : https, port 443, pas d'identifiant, pas d'IP littérale. Renvoie l'URL analysée. */
function parseGuardedUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new OAuthHostError('URL d’API manquante ou trop longue.');
  }
  // Le parseur WHATWG retire en silence tabulations et retours ligne, et lit `\` comme `/` : une URL
  // qui en contient n'est pas celle qu'on croit lire. Refus franc.
  if (/[^\x21-\x7e]/.test(raw) || raw.includes('\\')) {
    throw new OAuthHostError('URL d’API invalide (caractères interdits).');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthHostError('URL d’API invalide.');
  }
  if (u.protocol !== 'https:') {
    throw new OAuthHostError(`URL refusée pour ${hostLabel(u.hostname)} : https obligatoire.`);
  }
  // `https://@hote/` donne un identifiant vide que le parseur efface : on regarde le texte brut.
  const authority = raw.slice(raw.indexOf('//') + 2).split(/[/?#]/)[0] ?? '';
  if (u.username !== '' || u.password !== '' || authority.includes('@')) {
    throw new OAuthHostError(
      `URL refusée pour ${hostLabel(u.hostname)} : identifiant interdit dans l’URL.`,
    );
  }
  // Le parseur normalise `:443` en port vide pour https : tout autre port reste visible.
  if (u.port !== '') {
    throw new OAuthHostError(
      `URL refusée pour ${hostLabel(u.hostname)} : seul le port 443 est admis.`,
    );
  }
  const host = u.hostname.toLowerCase();
  const lastLabel = host.split('.').pop() ?? '';
  if (host.startsWith('[') || isIP(host) !== 0 || /^(0x[0-9a-f]*|[0-9]+)$/.test(lastLabel)) {
    throw new OAuthHostError(
      'URL refusée : adresse IP littérale interdite, nom d’hôte officiel attendu.',
    );
  }
  return u;
}

/** Lève `OAuthHostError` si `url` n'est pas une URL https, port 443, sans identifiant, d'un hôte officiel du fournisseur. */
export function assertOfficialApiUrl(url: string, provider: OAuthProviderId): URL {
  if (typeof provider !== 'string' || !Object.hasOwn(OAUTH_API_HOSTS, provider)) {
    throw new OAuthHostError('Fournisseur OAuth inconnu.');
  }
  const u = parseGuardedUrl(url);
  if (!OAUTH_API_HOSTS[provider].includes(u.hostname.toLowerCase())) {
    throw new OAuthHostError(
      `Hôte non autorisé pour ${PROVIDER_LABEL[provider]} : ${hostLabel(u.hostname)}.`,
    );
  }
  return u;
}

/** URL de premier appel : hôte d'API officiel, tous fournisseurs confondus. */
function assertAnyOfficialApiUrl(url: string): URL {
  const u = parseGuardedUrl(url);
  const all = Object.values(OAUTH_API_HOSTS).flat();
  if (!all.includes(u.hostname.toLowerCase())) {
    throw new OAuthHostError(`Hôte d’API non officiel refusé : ${hostLabel(u.hostname)}.`);
  }
  return u;
}

/**
 * Cible de redirection en mode `download` : même forme que ci-dessus, et nom d'hôte terminé par un
 * suffixe de téléchargement officiel, précédé d'au moins un label valide (`tenant.sharepoint.com`
 * oui ; `sharepoint.com`, `evilsharepoint.com` ou `x.sharepoint.com.evil.com` non).
 */
function assertDownloadUrl(url: string): URL {
  const u = parseGuardedUrl(url);
  const host = u.hostname.toLowerCase();
  const ok = OAUTH_DOWNLOAD_HOST_SUFFIXES.some((suffix) => {
    if (!host.endsWith(suffix)) return false;
    const prefix = host.slice(0, host.length - suffix.length);
    return prefix !== '' && prefix.split('.').every((l) => LABEL_REGEX.test(l));
  });
  if (!ok) {
    throw new OAuthHostError(
      `Redirection refusée vers un hôte qui n’est pas un hôte de téléchargement officiel : ${hostLabel(u.hostname)}.`,
    );
  }
  return u;
}

// ---------------------------------------------------------------------------
// Transport (remplaçable en test)
// ---------------------------------------------------------------------------

export interface OAuthTransportRequest {
  method: 'GET' | 'POST';
  /** URL déjà validée. */
  url: URL;
  /** Adresses VÉRIFIÉES (non internes) : seules cibles de connexion admises. */
  addresses: readonly string[];
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
}

export interface OAuthTransportResponse {
  status: number;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string>;
  /** Abandonne la réponse (connexion fermée) : dépassement de taille, redirection, délai, annulation. */
  abort(): void;
}

export type OAuthTransport = (req: OAuthTransportRequest) => Promise<OAuthTransportResponse>;

export interface OfficialHttpClientOptions {
  /** Délai global par requête (redirections et lecture comprises). Défaut 60 s. */
  timeoutMs?: number;
  /** Résolveur DNS (tests). Défaut : `dns.promises.lookup({ all: true })`, via la garde SSRF. */
  resolve?: (host: string) => Promise<string[]>;
  /** Transport (tests : aucun appel réseau réel). Défaut : `node:https` sur l'adresse vérifiée. */
  transport?: OAuthTransport;
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;

/**
 * Transport réel : `node:https`, connexion sur l'adresse vérifiée par un `lookup` qui ne renvoie que
 * celle-ci (le nom reste celui de l'URL : SNI, en-tête Host et contrôle du certificat portent sur le
 * nom officiel). Agent dédié (`agent: false`) : aucune socket partagée hors de cette garde.
 */
const nodeHttpsTransport: OAuthTransport = (req) =>
  new Promise<OAuthTransportResponse>((resolve, reject) => {
    const expectedHost = req.url.hostname.toLowerCase();
    const verified = req.addresses.filter((a) => isIP(a) !== 0 && !isBlockedAddress(a));
    const lookup = (
      hostname: string,
      options: { family?: number | string; all?: boolean },
      callback: LookupCallback,
    ): void => {
      const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
      const usable = verified.filter((a) => family === 0 || isIP(a) === family);
      if (hostname.toLowerCase() !== expectedHost || usable.length === 0) {
        callback(Object.assign(new Error('Adresse non vérifiée.'), { code: 'EBLOCKED' }));
        return;
      }
      if (options?.all) {
        callback(
          null,
          usable.map((address) => ({ address, family: isIP(address) })),
        );
      } else {
        const first = usable[0] as string;
        callback(null, first, isIP(first));
      }
    };

    const r = httpsRequest(
      {
        protocol: 'https:',
        hostname: req.url.hostname,
        port: 443,
        method: req.method,
        path: `${req.url.pathname}${req.url.search}`,
        headers: req.headers,
        agent: false,
        lookup: lookup as unknown as LookupFunction,
        servername: req.url.hostname,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        signal: req.signal,
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          abort: () => {
            res.destroy();
            r.destroy();
          },
        });
      },
    );
    r.on('error', reject);
    r.end(req.body);
  });

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function normalizeHeaders(raw: OAuthTransportResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (value == null) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function sanitizeRequestHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME_REGEX.test(lower) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      // Jamais la valeur dans le message : un en-tête peut porter un jeton.
      throw new OAuthHostError('En-tête de requête invalide.');
    }
    if (RESERVED_HEADERS.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

function safeCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,48}$/.test(code) ? code : undefined;
}

function tooLarge(host: string, maxBytes: number): OAuthApiError {
  return new OAuthApiError(
    `Réponse de ${hostLabel(host)} trop volumineuse (plafond ${maxBytes} octets).`,
    413,
    'response_too_large',
  );
}

/** Annulation par le `signal` de l'appelant (nom conventionnel `AbortError`). */
class AbortedError extends Error {
  constructor() {
    super('Requête annulée.');
    this.name = 'AbortError';
  }
}

/** Client réel : https seulement, hôtes officiels, aucune redirection automatique, lecture bornée, délai. */
export function createOfficialHttpClient(opts?: OfficialHttpClientOptions): OAuthHttpClient {
  const timeoutMs =
    typeof opts?.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  const transport = opts?.transport ?? nodeHttpsTransport;
  const resolveOpt = opts?.resolve;

  async function verifiedAddresses(host: string): Promise<string[]> {
    let addresses: string[];
    try {
      // Liste blanche de l'exploitant VOLONTAIREMENT vide : elle sert aux serveurs IMAP internes
      // voulus, jamais à une API publique.
      addresses = await assertPublicHost(host, { resolve: resolveOpt, allowInternal: [] });
    } catch {
      throw new OAuthHostError(
        `Hôte ${hostLabel(host)} refusé : introuvable, ou résolu vers une adresse interne ou réservée.`,
      );
    }
    // Ceinture et bretelles : chaque adresse est rejugée ici, sans aucune liste blanche.
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a))) {
      throw new OAuthHostError(
        `Hôte ${hostLabel(host)} refusé : résolu vers une adresse interne ou réservée.`,
      );
    }
    return addresses;
  }

  async function request(req: OAuthHttpRequest): Promise<OAuthHttpResponse> {
    if (!req || (req.method !== 'GET' && req.method !== 'POST')) {
      throw new OAuthHostError('Méthode HTTP non admise.');
    }
    const mode = req.redirects ?? 'none';
    if (mode !== 'none' && mode !== 'download') {
      throw new OAuthHostError('Mode de redirection inconnu.');
    }
    if (mode === 'download' && req.method !== 'GET') {
      throw new OAuthHostError('Les redirections de téléchargement ne valent que pour GET.');
    }
    const maxBytes = req.maxBytes ?? OAUTH_DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new OAuthHostError('Plafond de lecture invalide.');
    }
    // Validation AVANT tout appel, DNS compris.
    let url = assertAnyOfficialApiUrl(req.url);
    let headers = sanitizeRequestHeaders(req.headers);
    // Pas de compression implicite : la borne porte sur les octets réellement reçus.
    if (!Object.hasOwn(headers, 'accept-encoding')) headers['accept-encoding'] = 'identity';
    const body = req.body != null ? Buffer.from(req.body, 'utf8') : undefined;
    if (body) headers['content-length'] = String(body.length);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const external = req.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    // Promesse rejetée à l'abandon, mise en course avec chaque attente (DNS, transport, lecture) :
    // un transport ou un flux qui ignorerait le signal ne bloque pas au-delà du délai.
    let onAbort: Array<() => void> = [];
    const aborted = new Promise<never>((_, reject) => {
      const fire = (): void => {
        onAbort.forEach((h) => h());
        onAbort = [];
        reject(new AbortedError());
      };
      if (controller.signal.aborted) fire();
      else controller.signal.addEventListener('abort', fire, { once: true });
    });
    aborted.catch(() => undefined);

    let currentHost = url.hostname;
    try {
      for (let hop = 0; ; hop++) {
        currentHost = url.hostname;
        const addresses = await Promise.race([
          verifiedAddresses(url.hostname.toLowerCase()),
          aborted,
        ]);
        const res = await Promise.race([
          transport({
            method: hop === 0 ? req.method : 'GET',
            url,
            addresses,
            headers: { ...headers },
            body: hop === 0 ? body : undefined,
            signal: controller.signal,
          }),
          aborted,
        ]);
        onAbort.push(() => res.abort());
        const status = res.status;
        const resHeaders = normalizeHeaders(res.headers);

        if (status >= 300 && status < 400) {
          res.abort();
          if (mode !== 'download') {
            throw new OAuthHostError(
              `Redirection refusée (réponse ${status} de ${hostLabel(url.hostname)}).`,
            );
          }
          if (hop >= OAUTH_MAX_DOWNLOAD_REDIRECTS) {
            throw new OAuthHostError(
              `Trop de redirections (plus de ${OAUTH_MAX_DOWNLOAD_REDIRECTS}) depuis ${hostLabel(url.hostname)}.`,
            );
          }
          const location = resHeaders.location;
          if (!location) {
            throw new OAuthHostError(
              `Redirection sans destination depuis ${hostLabel(url.hostname)}.`,
            );
          }
          let next: string;
          try {
            next = new URL(location, url).href;
          } catch {
            throw new OAuthHostError(`Redirection invalide depuis ${hostLabel(url.hostname)}.`);
          }
          url = assertDownloadUrl(next);
          // Les identifiants ne suivent JAMAIS une redirection : l'URL de téléchargement est
          // pré-authentifiée, et le jeton n'a rien à faire chez un autre hôte.
          headers = Object.fromEntries(
            Object.entries(headers).filter(
              ([name]) =>
                !CREDENTIAL_HEADERS.has(name) && name !== 'content-length' && name !== 'content-type',
            ),
          );
          continue;
        }

        const declared = resHeaders['content-length'];
        if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
          res.abort();
          throw tooLarge(url.hostname, maxBytes);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const it = res.body[Symbol.asyncIterator]();
        for (;;) {
          const step = await Promise.race([it.next(), aborted]);
          if (step.done) break;
          const chunk = Buffer.from(step.value as Uint8Array);
          total += chunk.length;
          if (total > maxBytes) {
            // Abandon de la requête : on ne lit pas un octet de plus, et rien n'est tronqué.
            res.abort();
            throw tooLarge(url.hostname, maxBytes);
          }
          chunks.push(chunk);
        }
        return { status, headers: resHeaders, body: Buffer.concat(chunks, total) };
      }
    } catch (err) {
      if (err instanceof OAuthHostError || err instanceof OAuthApiError) throw err;
      if (controller.signal.aborted) {
        if (timedOut) {
          throw new OAuthNetworkError(
            `Délai dépassé (${Math.ceil(timeoutMs / 1000)} s) pour ${hostLabel(currentHost)}.`,
            'ETIMEDOUT',
          );
        }
        throw new AbortedError();
      }
      if (err instanceof OAuthNetworkError) throw err;
      // Erreur de transport : seul le code système filtré est recopié (le message natif peut citer
      // l'URL, donc un paramètre de requête).
      const code = safeCode(err);
      throw new OAuthNetworkError(
        `Échec de la connexion à ${hostLabel(currentHost)}${code ? ` (${code})` : ''}.`,
        code,
      );
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
      onAbort = [];
    }
  }

  return { request };
}
