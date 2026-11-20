// Lot 2c — WhatsApp Business : client de l'API Graph de Meta et transport HTTPS durci.
//
// Le worker (1) demande l'URL d'un média à l'API Graph, (2) télécharge cette URL avec le jeton,
// (3) envoie des messages texte. Trois risques guident ce fichier :
//  - fuite du jeton : il ne voyage QUE dans l'en-tête Authorization, QUE vers un hôte officiel
//    (`assertOfficialMediaUrl`, revalidé à chaque redirection et par le transport lui-même ; et seulement
//    vers `WHATSAPP_TOKEN_HOSTS` : supprimé sur les sauts vers les autres hôtes officiels), et
//    n'apparaît dans aucun message d'erreur (messages fixes + `redactSecrets`) ;
//  - SSRF / DNS piégé : le transport résout le nom, refuse toute adresse interne (garde SSRF SANS
//    la liste blanche de l'exploitant) et se connecte à l'adresse vérifiée, avec le nom d'origine
//    pour le SNI et le contrôle du certificat ; il ne suit jamais une redirection de lui-même ;
//  - épuisement mémoire : chaque corps de réponse est borné en flux (abandon dès dépassement).
//
// Tout est injectable (`WhatsappHttp`) : les tests n'ouvrent aucune connexion réseau.
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import { z } from 'zod';
import { GED_CONNECTOR_LIMITS } from '@archivage/types';
import { redactSecrets } from './crypto';
import { SsrfError, assertPublicHost } from './ssrf';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ConnectorCredentials,
} from './types';
import { assertOfficialMediaUrl } from './whatsapp-media';
import { normalizePhone } from './whatsapp-phone';

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface WhatsappHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Corps de réponse maximal (octets) : la lecture s'interrompt dès dépassement. */
  maxBytes: number;
}

export interface WhatsappHttpResponse {
  status: number;
  /** En-têtes en minuscules ; valeurs multiples jointes par `, `. */
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Transport HTTP. Contrat : ne suit JAMAIS une redirection (une réponse 3xx est renvoyée telle
 * quelle) et borne la lecture du corps à `maxBytes` en flux (lève `WhatsappBodyTooLargeError` dès
 * dépassement, sans accumuler la suite).
 */
export interface WhatsappHttp {
  request(req: WhatsappHttpRequest): Promise<WhatsappHttpResponse>;
}

/** Corps de réponse au-delà de `maxBytes` (annoncé par Content-Length ou constaté en flux). */
export class WhatsappBodyTooLargeError extends ConnectorItemRejectedError {
  constructor() {
    super('Réponse trop volumineuse : téléchargement interrompu.');
    this.name = 'WhatsappBodyTooLargeError';
  }
}

type HttpsRequestFn = (options: https.RequestOptions) => ClientRequest;

export interface DefaultWhatsappHttpOptions {
  /** Résolveur DNS (tests). Défaut : `dns.promises.lookup` (via la garde SSRF). */
  resolveHost?: (host: string) => Promise<string[]>;
  /**
   * Environnement. Volontairement IGNORÉ par ce transport : ni la liste blanche
   * GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS ni les variables de proxy (HTTPS_PROXY, NODE_USE_ENV_PROXY)
   * ne s'appliquent aux appels vers Meta. Accepté pour la symétrie avec `ConnectorDeps`.
   */
  env?: NodeJS.ProcessEnv;
  /** Fonction `https.request` (tests uniquement : simule la connexion sans ouvrir de socket). */
  requestFn?: HttpsRequestFn;
}

/** Adresses essayées au plus pour un même nom (erreur de connexion seulement, jamais après envoi). */
const MAX_ADDRESSES = 3;
/** Erreurs qui ne surviennent qu'à l'établissement de la connexion : rien n'a été envoyé. */
const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
/** En-têtes fixés par le transport : un appelant ne peut pas les imposer. */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

/**
 * Erreur produite par CE fichier (transport ou client), au message fixe donc recopiable après
 * masquage. Toute autre erreur non typée est remplacée par un message générique.
 */
class WhatsappOwnError extends Error {
  constructor(
    message: string,
    /** Échec à l'établissement de la connexion : rien n'a été envoyé, une autre adresse peut être essayée. */
    readonly beforeSend = false,
  ) {
    super(message);
    this.name = 'Error';
  }
}

function flattenHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : '';
}

function attempt(
  requestFn: HttpsRequestFn,
  req: WhatsappHttpRequest,
  url: URL,
  address: string,
  deadline: number,
): Promise<WhatsappHttpResponse> {
  return new Promise<WhatsappHttpResponse>((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new WhatsappOwnError('Délai dépassé lors de l’appel à l’API WhatsApp.'));
      return;
    }
    const host = url.hostname;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!RESERVED_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers.Host = host;
    if (req.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(req.body, 'utf8'));

    // Agent dédié, sans keep-alive ni proxy : la connexion part vers l'adresse vérifiée, point.
    const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
    let settled = false;
    let request: ClientRequest | undefined;
    // Délai GLOBAL (connexion + réponse complète), en plus du délai d'inactivité du socket.
    const timer = setTimeout(() => {
      finish(new WhatsappOwnError('Délai dépassé lors de l’appel à l’API WhatsApp.'));
      request?.destroy();
    }, remaining);
    const finish = (err: Error | null, value?: WhatsappHttpResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      if (err) reject(err);
      else resolve(value as WhatsappHttpResponse);
    };

    try {
      request = requestFn({
        protocol: 'https:',
        host: address,
        port: 443,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent,
        servername: host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        // Le certificat est contrôlé contre le NOM d'origine, jamais contre l'adresse IP.
        checkServerIdentity: (_h: string, cert: tls.PeerCertificate) =>
          tls.checkServerIdentity(host, cert),
        timeout: remaining,
      });
    } catch {
      // En-tête invalide (CR/LF…) : Node lève avant tout envoi. Le détail n'est pas recopié.
      finish(new WhatsappOwnError('Requête vers l’API WhatsApp invalide.'));
      return;
    }

    const live: ClientRequest = request;
    live.once('timeout', () => {
      finish(new WhatsappOwnError('Délai dépassé lors de l’appel à l’API WhatsApp.'));
      live.destroy();
    });
    live.on('error', (e: unknown) => {
      const code = errorCode(e);
      finish(
        new WhatsappOwnError(
          `Erreur réseau lors de l’appel à l’API WhatsApp${code ? ` (${code})` : ''}.`,
          CONNECT_ERROR_CODES.has(code),
        ),
      );
    });
    live.once('response', (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const resHeaders = flattenHeaders(res.headers);
      const announced = resHeaders['content-length'];
      if (announced !== undefined && /^\d+$/.test(announced) && Number(announced) > req.maxBytes) {
        finish(new WhatsappBodyTooLargeError());
        res.destroy();
        live.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > req.maxBytes) {
          finish(new WhatsappBodyTooLargeError());
          res.destroy();
          live.destroy();
          return;
        }
        chunks.push(buf);
      });
      res.once('end', () => finish(null, { status, headers: resHeaders, body: Buffer.concat(chunks, total) }));
      res.on('error', () => finish(new WhatsappOwnError('Réponse de l’API WhatsApp interrompue.')));
      res.once('aborted', () => finish(new WhatsappOwnError('Réponse de l’API WhatsApp interrompue.')));
    });

    live.end(req.body);
  });
}

/**
 * Transport réel (`node:https`). Avant CHAQUE requête : URL validée par `assertOfficialMediaUrl`
 * (hôte officiel Meta, https, port 443), puis nom résolu et contrôlé par la garde SSRF SANS liste
 * blanche (un hôte Meta qui résoudrait vers une adresse interne est refusé, quelle que soit la
 * configuration de l'exploitant). La connexion se fait sur l'adresse vérifiée (pas de seconde
 * résolution : pas de DNS rebinding), avec le nom d'origine en SNI et pour le certificat ; TLS
 * toujours vérifié (1.2 minimum), délai global, aucun proxy, aucune redirection suivie.
 */
export function createDefaultWhatsappHttp(opts: DefaultWhatsappHttpOptions = {}): WhatsappHttp {
  const requestFn: HttpsRequestFn = opts.requestFn ?? https.request;
  return {
    async request(req: WhatsappHttpRequest): Promise<WhatsappHttpResponse> {
      if (req.method !== 'GET' && req.method !== 'POST') {
        throw new WhatsappOwnError('Méthode HTTP non prise en charge.');
      }
      if (!(Number.isFinite(req.timeoutMs) && req.timeoutMs > 0)) {
        throw new WhatsappOwnError('Délai de requête invalide.');
      }
      if (!(Number.isFinite(req.maxBytes) && req.maxBytes > 0)) {
        throw new WhatsappOwnError('Taille maximale de réponse invalide.');
      }
      const deadline = Date.now() + req.timeoutMs;
      const url = assertOfficialMediaUrl(req.url);

      let addresses: string[];
      try {
        addresses = await assertPublicHost(url.hostname, {
          resolve: opts.resolveHost,
          allowInternal: [],
        });
      } catch (e) {
        if (e instanceof SsrfError && e.code === 'unresolved') {
          throw new WhatsappOwnError('API WhatsApp injoignable : résolution DNS impossible.');
        }
        throw new WhatsappOwnError(
          'Connexion à l’API WhatsApp refusée : le nom ne résout pas vers une adresse publique.',
        );
      }
      // IPv4 d'abord (pile IPv6 souvent absente des conteneurs), ordre du résolveur sinon.
      const ordered = [...addresses]
        .sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
        .slice(0, MAX_ADDRESSES);

      let last: unknown;
      for (const address of ordered) {
        try {
          return await attempt(requestFn, req, url, address, deadline);
        } catch (e) {
          last = e;
          if (!(e instanceof WhatsappOwnError && e.beforeSend)) throw e;
        }
      }
      throw last instanceof Error ? last : new WhatsappOwnError('API WhatsApp injoignable.');
    },
  };
}

// ---------------------------------------------------------------------------
// Client Graph
// ---------------------------------------------------------------------------

export interface WhatsappGraphClientOptions {
  http: WhatsappHttp;
  accessToken: string;
  phoneNumberId: string;
  /** Version de l'API Graph, `vNN.N` (défaut `v21.0`). */
  apiVersion?: string;
  /** Taille maximale d'un média (octets), bornée par `GED_CONNECTOR_LIMITS.maxFileBytes`. */
  maxMediaBytes: number;
  now?: () => Date;
}

export interface WhatsappMediaInfo {
  /** URL de téléchargement, déjà validée par `assertOfficialMediaUrl`. Signée : ne jamais la journaliser. */
  url: string;
  mimeType: string;
  sha256?: string;
  fileSize?: number;
}

export const WHATSAPP_GRAPH_HOST = 'graph.facebook.com';
/**
 * Seuls hôtes à qui le jeton d'accès est envoyé (Authorization: Bearer). Les autres hôtes officiels
 * (CDN `*.fbcdn.net`, `*.whatsapp.net`…) restent atteignables après redirection, SANS jeton.
 */
export const WHATSAPP_TOKEN_HOSTS: readonly string[] = Object.freeze([
  WHATSAPP_GRAPH_HOST,
  'lookaside.fbsbx.com',
]);
export const WHATSAPP_DEFAULT_API_VERSION = 'v21.0';
const API_VERSION_REGEX = /^v[0-9]{1,2}\.[0-9]$/;
const PHONE_NUMBER_ID_REGEX = /^[0-9]{1,30}$/;
const MEDIA_ID_REGEX = /^[0-9]{1,30}$/;
/** Corps JSON maximal accepté de l'API Graph. */
const JSON_MAX_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Redirections suivies au plus lors d'un téléchargement (au-delà : refus). */
const MAX_REDIRECTS = 2;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Longueur maximale d'un message texte envoyé. */
export const WHATSAPP_MAX_TEXT_CHARS = 1000;
/** Codes d'erreur Graph de limitation de débit. */
const QUOTA_CODES = new Set([4, 17, 32, 613, 80007, 130429]);
/** Borne d'un Retry-After honoré (24 h). */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const USER_AGENT = 'DocuPro-GED-WhatsApp/1.0';

const graphErrorSchema = z.object({
  error: z
    .object({
      code: z.number().int().optional(),
      error_subcode: z.number().int().optional(),
    })
    .passthrough(),
});
const probeSchema = z.object({ id: z.string().max(64) }).passthrough();
const mediaInfoSchema = z
  .object({
    url: z.string().min(1).max(4096),
    mime_type: z.string().min(1).max(255),
    sha256: z.string().max(128).optional(),
    file_size: z.union([z.number().int().nonnegative(), z.string().regex(/^[0-9]{1,15}$/)]).optional(),
    id: z.string().max(64).optional(),
  })
  .passthrough();
const sendSchema = z
  .object({ messages: z.array(z.object({ id: z.string().max(256) }).passthrough()).optional() })
  .passthrough();

type ErrorContext = 'probe' | 'media' | 'send';

/**
 * Client de l'API WhatsApp Cloud (Graph). Aucun message d'erreur ne contient le jeton, une URL
 * signée, le corps brut d'une réponse ni un numéro de téléphone : les messages sont fixes et
 * passent par `redactSecrets` en dernière barrière.
 */
export class WhatsappGraphClient {
  private readonly http: WhatsappHttp;
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly apiVersion: string;
  private readonly maxMediaBytes: number;
  private readonly now: () => Date;

  constructor(opts: WhatsappGraphClientOptions) {
    if (!opts || typeof opts.http?.request !== 'function') {
      throw new Error('Client WhatsApp : transport HTTP manquant.');
    }
    // Jeton : ASCII imprimable sans espace (refuse CR/LF : pas d'injection d'en-tête). Message
    // fixe, la valeur n'est jamais recopiée.
    if (
      typeof opts.accessToken !== 'string' ||
      opts.accessToken.length === 0 ||
      opts.accessToken.length > 4096 ||
      /[^\x21-\x7e]/.test(opts.accessToken)
    ) {
      throw new ConnectorAuthError('Jeton d’accès WhatsApp manquant ou invalide.');
    }
    if (typeof opts.phoneNumberId !== 'string' || !PHONE_NUMBER_ID_REGEX.test(opts.phoneNumberId)) {
      throw new Error('Identifiant du numéro WhatsApp Business invalide (chiffres attendus).');
    }
    const version = opts.apiVersion ?? WHATSAPP_DEFAULT_API_VERSION;
    if (typeof version !== 'string' || !API_VERSION_REGEX.test(version)) {
      throw new Error('Version de l’API Graph invalide (format attendu : v21.0).');
    }
    if (!Number.isFinite(opts.maxMediaBytes) || opts.maxMediaBytes <= 0) {
      throw new Error('Taille maximale de média invalide.');
    }
    this.http = opts.http;
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
    this.apiVersion = version;
    this.maxMediaBytes = Math.min(Math.floor(opts.maxMediaBytes), GED_CONNECTOR_LIMITS.maxFileBytes);
    this.now = opts.now ?? (() => new Date());
  }

  /** Vérifie que le jeton donne accès au numéro configuré (sert à `authenticate`). */
  async probe(): Promise<void> {
    const res = await this.call(
      'GET',
      `${this.base()}/${this.phoneNumberId}?fields=id`,
      undefined,
      'probe',
    );
    const parsed = probeSchema.safeParse(this.parseJson(res));
    if (!parsed.success) throw this.fail(new WhatsappOwnError('Réponse inattendue de l’API WhatsApp.'));
    if (parsed.data.id !== this.phoneNumberId) {
      throw this.fail(
        new ConnectorAuthError('Le jeton ne donne pas accès à ce numéro WhatsApp Business.'),
      );
    }
  }

  /**
   * Métadonnées d'un média. `phone_number_id` est transmis : Meta ne répond que si le média a été
   * reçu sur CE numéro. L'URL renvoyée est validée (hôte officiel) avant d'être rendue ; une taille
   * annoncée supérieure au maximum est refusée sans rien télécharger.
   */
  async getMediaInfo(mediaId: string): Promise<WhatsappMediaInfo> {
    if (typeof mediaId !== 'string' || !MEDIA_ID_REGEX.test(mediaId)) {
      throw new ConnectorItemRejectedError('Identifiant de média invalide.');
    }
    const res = await this.call(
      'GET',
      `${this.base()}/${mediaId}?phone_number_id=${this.phoneNumberId}`,
      undefined,
      'media',
    );
    const parsed = mediaInfoSchema.safeParse(this.parseJson(res));
    if (!parsed.success) throw this.fail(new WhatsappOwnError('Réponse inattendue de l’API WhatsApp (média).'));
    const data = parsed.data;
    if (data.id !== undefined && data.id !== mediaId) {
      throw this.fail(new WhatsappOwnError('Réponse inattendue de l’API WhatsApp (média).'));
    }
    let url: URL;
    try {
      url = assertOfficialMediaUrl(data.url);
    } catch {
      throw this.fail(
        new ConnectorItemRejectedError('Adresse du média refusée : hôte non officiel.'),
        data.url,
      );
    }
    const fileSize = data.file_size === undefined ? undefined : Number(data.file_size);
    if (fileSize !== undefined && fileSize > this.maxMediaBytes) {
      throw this.fail(new ConnectorItemRejectedError('Média trop volumineux : non téléchargé.'), data.url);
    }
    return {
      url: url.toString(),
      mimeType: data.mime_type.trim().toLowerCase(),
      ...(data.sha256 !== undefined ? { sha256: data.sha256.trim() } : {}),
      ...(fileSize !== undefined ? { fileSize } : {}),
    };
  }

  /**
   * Télécharge un média. Redirections 301/302/303/307/308 suivies À LA MAIN, 2 au plus, chaque
   * `Location` revalidée (hôte officiel, https) ; le jeton n'est envoyé qu'à graph/lookaside.
   * Taille bornée (Content-Length et flux). Statut autre que 200 : erreur typée.
   */
  async downloadMedia(info: WhatsappMediaInfo): Promise<Buffer> {
    const secretUrl = typeof info?.url === 'string' ? info.url : '';
    let url: URL;
    try {
      url = assertOfficialMediaUrl(secretUrl);
    } catch {
      throw this.fail(new ConnectorItemRejectedError('Adresse du média refusée : hôte non officiel.'), secretUrl);
    }
    if (info.fileSize !== undefined && info.fileSize > this.maxMediaBytes) {
      throw this.fail(new ConnectorItemRejectedError('Média trop volumineux : non téléchargé.'), secretUrl);
    }
    const seen = [secretUrl];
    for (let hop = 0; ; hop++) {
      let res: WhatsappHttpResponse;
      try {
        res = await this.http.request({
          method: 'GET',
          url: url.toString(),
          // `url` sort toujours d'`assertOfficialMediaUrl` ; le jeton ne part que vers graph/lookaside,
          // l'en-tête Authorization est supprimé sur tout autre saut (CDN officiel).
          headers: this.downloadHeaders(url),
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes: this.maxMediaBytes,
        });
      } catch (e) {
        throw this.fail(
          e instanceof WhatsappBodyTooLargeError
            ? new ConnectorItemRejectedError('Média trop volumineux : téléchargement interrompu.')
            : e,
          ...seen,
        );
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        if (hop >= MAX_REDIRECTS) {
          throw this.fail(new ConnectorItemRejectedError('Redirection refusée : trop de redirections.'), ...seen);
        }
        const location = (res.headers.location ?? '').trim();
        seen.push(location);
        let next: URL;
        try {
          // Location absente ou vide : se résoudrait vers l'URL courante (boucle) → refus.
          if (location === '') throw new Error('location vide');
          next = assertOfficialMediaUrl(new URL(location, url).toString());
        } catch {
          throw this.fail(
            new ConnectorItemRejectedError('Redirection refusée : destination non autorisée.'),
            ...seen,
          );
        }
        url = next;
        seen.push(url.toString());
        continue;
      }
      if (res.status !== 200) throw this.fail(this.mapError(res, 'media'), ...seen);

      const announced = res.headers['content-length'];
      if (
        (announced !== undefined && /^\d+$/.test(announced) && Number(announced) > this.maxMediaBytes) ||
        res.body.length > this.maxMediaBytes
      ) {
        throw this.fail(new ConnectorItemRejectedError('Média trop volumineux : téléchargement interrompu.'), ...seen);
      }
      return res.body;
    }
  }

  /** Envoie un message texte simple (sans aperçu de lien). `to` : numéro international. */
  async sendText(to: string, body: string): Promise<{ messageId?: string }> {
    const digits = normalizePhone(to);
    if (!digits) throw new Error('Numéro de destinataire WhatsApp invalide.');
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new Error('Message WhatsApp vide.');
    }
    if (body.length > WHATSAPP_MAX_TEXT_CHARS) {
      throw new Error(`Message WhatsApp trop long (${WHATSAPP_MAX_TEXT_CHARS} caractères au plus).`);
    }
    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to: digits,
      type: 'text',
      text: { body, preview_url: false },
    });
    const res = await this.call(
      'POST',
      `${this.base()}/${this.phoneNumberId}/messages`,
      payload,
      'send',
      digits,
    );
    const parsed = sendSchema.safeParse(this.parseJson(res));
    const messageId = parsed.success ? parsed.data.messages?.[0]?.id : undefined;
    return messageId !== undefined ? { messageId } : {};
  }

  // -------------------------------------------------------------------------

  private base(): string {
    return `https://${WHATSAPP_GRAPH_HOST}/${this.apiVersion}`;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'User-Agent': USER_AGENT,
      ...(json ? { Accept: 'application/json', 'Content-Type': 'application/json' } : {}),
    };
  }

  private downloadHeaders(url: URL): Record<string, string> {
    const h = this.headers(false);
    if (!WHATSAPP_TOKEN_HOSTS.includes(url.hostname.toLowerCase())) delete h.Authorization;
    return h;
  }

  /** Appel JSON à l'API Graph : réponse bornée, pas de redirection acceptée, erreurs typées. */
  private async call(
    method: 'GET' | 'POST',
    url: string,
    body: string | undefined,
    context: ErrorContext,
    ...extraSecrets: string[]
  ): Promise<WhatsappHttpResponse> {
    let res: WhatsappHttpResponse;
    try {
      res = await this.http.request({
        method,
        url,
        headers: this.headers(true),
        ...(body !== undefined ? { body } : {}),
        timeoutMs: API_TIMEOUT_MS,
        maxBytes: JSON_MAX_BYTES,
      });
    } catch (e) {
      if (e instanceof WhatsappBodyTooLargeError) {
        throw this.fail(new WhatsappOwnError('Réponse de l’API WhatsApp trop volumineuse.'), ...extraSecrets);
      }
      throw this.fail(e, ...extraSecrets);
    }
    if (res.status < 200 || res.status >= 300) {
      throw this.fail(this.mapError(res, context), ...extraSecrets);
    }
    return res;
  }

  private parseJson(res: WhatsappHttpResponse): unknown {
    if (!Buffer.isBuffer(res.body) || res.body.length === 0 || res.body.length > JSON_MAX_BYTES) {
      return undefined;
    }
    try {
      return JSON.parse(res.body.toString('utf8')) as unknown;
    } catch {
      return undefined;
    }
  }

  private retryAfterMs(headers: Record<string, string>): number | undefined {
    const raw = headers['retry-after']?.trim();
    if (!raw) return undefined;
    let ms: number;
    if (/^[0-9]{1,9}$/.test(raw)) {
      ms = Number(raw) * 1000;
    } else {
      const at = Date.parse(raw);
      if (Number.isNaN(at)) return undefined;
      ms = at - this.now().getTime();
    }
    if (!Number.isFinite(ms)) return undefined;
    return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
  }

  /** Statut/code Graph → erreur typée. Seuls des nombres de la réponse sont recopiés, jamais son texte. */
  private mapError(res: WhatsappHttpResponse, context: ErrorContext): Error {
    const status = res.status;
    const parsed = graphErrorSchema.safeParse(this.parseJson(res));
    const code = parsed.success ? parsed.data.error.code : undefined;

    if (code === 190) {
      return new ConnectorAuthError('Jeton d’accès WhatsApp expiré ou révoqué.', true);
    }
    if (status === 429 || (code !== undefined && QUOTA_CODES.has(code))) {
      return new ConnectorQuotaError(
        'Limite de débit de l’API WhatsApp atteinte.',
        this.retryAfterMs(res.headers),
      );
    }
    if (status === 401 || status === 403) {
      return new ConnectorAuthError('Accès refusé par l’API WhatsApp (jeton ou permissions).', false);
    }
    if (context === 'media' && (status === 404 || status === 410 || code === 100)) {
      return new ConnectorItemRejectedError('Média introuvable ou expiré');
    }
    if (context === 'probe' && (status === 404 || code === 100)) {
      return new ConnectorAuthError('Numéro WhatsApp Business introuvable pour ce jeton.', false);
    }
    if (status >= 500) {
      return new WhatsappOwnError(`L’API WhatsApp est momentanément indisponible (statut ${status}).`);
    }
    if (status >= 300 && status < 400) {
      return new WhatsappOwnError(`Redirection inattendue de l’API WhatsApp (statut ${status}).`);
    }
    return new WhatsappOwnError(
      `Requête refusée par l’API WhatsApp (statut ${status}${code !== undefined ? `, code ${code}` : ''}).`,
    );
  }

  /**
   * Dernière barrière avant que l'erreur ne quitte le client : même classe, message masqué (jeton,
   * URL signée et sa partie requête, numéro de téléphone). Une erreur non typée (réseau, transport
   * injecté) est remplacée par une erreur générique : son texte d'origine n'est jamais recopié.
   */
  private fail(e: unknown, ...extraSecrets: string[]): Error {
    const creds: ConnectorCredentials = { accessToken: this.accessToken };
    let i = 0;
    for (const s of extraSecrets) {
      if (typeof s !== 'string' || s === '') continue;
      creds[`s${i++}`] = s;
      try {
        const u = new URL(s);
        if (u.search.length > 1) creds[`s${i++}`] = u.search.slice(1);
        if (u.pathname.length > 1) creds[`s${i++}`] = u.pathname;
      } catch {
        // Pas une URL : seule la valeur brute est masquée.
      }
    }
    const safe = (m: string): string => redactSecrets(m, creds);
    if (e instanceof ConnectorAuthError) return new ConnectorAuthError(safe(e.message), e.expired);
    if (e instanceof ConnectorQuotaError) return new ConnectorQuotaError(safe(e.message), e.retryAfterMs);
    if (e instanceof ConnectorItemRejectedError) return new ConnectorItemRejectedError(safe(e.message));
    if (e instanceof WhatsappOwnError) return new Error(safe(e.message));
    return new Error('Erreur lors de l’appel à l’API WhatsApp.');
  }
}
