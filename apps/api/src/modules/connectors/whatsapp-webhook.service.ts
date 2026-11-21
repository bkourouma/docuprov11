// Lot 2c — webhook PUBLIC du connecteur WhatsApp Business (API WhatsApp Cloud de Meta).
//
// Seule route publique du lot : surface d'attaque principale. Le service s'arrête à « élément
// enregistré + job enfilé » ; le worker télécharge le média, l'ingère et répond à l'expéditeur.
//
// Ordre STRICT d'une réception (POST) :
//   a. limitation de débit par IP (429) ;
//   b. identifiant de connecteur (404 générique), corps Buffer non vide ≤ 256 Kio (400 / 413) ;
//   c. chargement MINIMAL du connecteur + déchiffrement de ses identifiants ;
//   d. signature HMAC sur les octets bruts — 401 générique sinon, AVANT tout parse, toute écriture
//      en base, toute mise en file ;
//   e. analyse du corps (`parseWhatsappWebhook` : numéro du connecteur, fenêtre anti-rejeu) ;
//   f. par message : débit par expéditeur, liste blanche, puis élément + job (idempotent) ;
//   g. 200 `{ received: true }`.
//
// Non-énumération : connecteur inconnu, inactif, d'un autre type, identifiants illisibles ou
// signature fausse donnent EXACTEMENT la même réponse (401, corps générique), et le HMAC est calculé
// dans tous les cas (secret leurre) pour ne pas distinguer ces cas au temps de réponse.
//
// Journaux : seulement l'identifiant du connecteur, le pseudonyme de l'expéditeur (HMAC tronqué),
// l'identifiant de message, des compteurs et des décisions. JAMAIS le numéro, le corps, la
// signature, un secret, une URL ou un nom de fichier. Les erreurs renvoyées sont génériques.
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  PayloadTooLargeException,
  UnauthorizedException,
  type Provider,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import {
  decryptCredentials,
  hashPhone,
  loadKeyRing,
  parseWhatsappStoredConfig,
  parseWhatsappWebhook,
  resolveClientIp,
  resolveCredentialsRef,
  resolveWhatsappSender,
  sanitizeWhatsappFileName,
  SlidingWindowRateLimiter,
  verifyWhatsappChallenge,
  verifyWhatsappSignature,
  WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS,
  WHATSAPP_MAX_BODY_BYTES,
  type WhatsappConfigParsed,
  type WhatsappInboundMessage,
} from '@archivage/connectors';
import {
  GED_WHATSAPP_CONNECTOR_TYPE,
  GED_WHATSAPP_JOB,
  GedSourceConnectorStatus,
  GedSourceItemState,
  type GedWhatsappInboundJobData,
  type GedWhatsappItemMetadata,
  type GedWhatsappRefuseJobData,
} from '@archivage/types';
import { PrismaService } from '../prisma/prisma.service';
import { GED_WHATSAPP_QUEUE_TOKEN } from './whatsapp-queue.provider';

// ---------------------------------------------------------------------------
// Jetons d'injection et réglages
// ---------------------------------------------------------------------------

/** Limiteur par adresse IP du client (GET et POST). */
export const GED_WHATSAPP_IP_LIMITER = 'GED_WHATSAPP_IP_LIMITER';
/** Limiteur par expéditeur (clé : connecteur + pseudonyme du numéro). */
export const GED_WHATSAPP_SENDER_LIMITER = 'GED_WHATSAPP_SENDER_LIMITER';
/** Jeton optionnel : environnement et horloge injectés (tests uniquement). */
export const GED_WHATSAPP_RUNTIME = 'GED_WHATSAPP_RUNTIME';

export interface WhatsappWebhookRuntime {
  env?: NodeJS.ProcessEnv;
  /** Horloge (défaut : `new Date()`). */
  now?: () => Date;
}

/** Contrat minimal d'un limiteur (`SlidingWindowRateLimiter`), pour l'injection et les tests. */
export interface WhatsappRateLimiter {
  take(key: string): boolean;
}

/** Défaut : 300 requêtes par minute et par IP (Meta regroupe les notifications ; marge large). */
export const WHATSAPP_IP_RATE_LIMIT_DEFAULT = 300;
export const WHATSAPP_IP_RATE_WINDOW_MS = 60_000;
/** Défaut : 60 messages par 10 minutes et par expéditeur (un dossier photographié page à page). */
export const WHATSAPP_SENDER_RATE_LIMIT_DEFAULT = 60;
export const WHATSAPP_SENDER_RATE_WINDOW_MS = 10 * 60_000;
/** Bornes acceptées pour `GED_WHATSAPP_REPLAY_WINDOW_SECONDS` (hors bornes : défaut). */
export const WHATSAPP_REPLAY_WINDOW_MIN_SECONDS = 60;
export const WHATSAPP_REPLAY_WINDOW_MAX_SECONDS = 7 * 24 * 3600;

/** Politique du job `inbound` (cf. brief) : 3 essais, recul exponentiel, échecs gardés 7 jours. */
export const WHATSAPP_INBOUND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** Entier positif borné lu dans l'environnement ; toute autre valeur est ignorée (défaut). */
function envInt(raw: unknown, def: number, min: number, max: number): number {
  if (typeof raw !== 'string' || !/^[0-9]{1,9}$/.test(raw.trim())) return def;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : def;
}

/**
 * Limiteurs en mémoire du processus (non partagés entre instances de l'API). Plafonds réglables
 * par `GED_WHATSAPP_IP_RATE_LIMIT` (requêtes par minute et par IP) et
 * `GED_WHATSAPP_SENDER_RATE_LIMIT` (messages par 10 minutes et par expéditeur), 1 à 10 000.
 */
export const whatsappRateLimiterProviders: Provider[] = [
  {
    provide: GED_WHATSAPP_IP_LIMITER,
    useFactory: (): WhatsappRateLimiter =>
      new SlidingWindowRateLimiter({
        limit: envInt(process.env.GED_WHATSAPP_IP_RATE_LIMIT, WHATSAPP_IP_RATE_LIMIT_DEFAULT, 1, 10_000),
        windowMs: WHATSAPP_IP_RATE_WINDOW_MS,
      }),
  },
  {
    provide: GED_WHATSAPP_SENDER_LIMITER,
    useFactory: (): WhatsappRateLimiter =>
      new SlidingWindowRateLimiter({
        limit: envInt(
          process.env.GED_WHATSAPP_SENDER_RATE_LIMIT,
          WHATSAPP_SENDER_RATE_LIMIT_DEFAULT,
          1,
          10_000,
        ),
        windowMs: WHATSAPP_SENDER_RATE_WINDOW_MS,
      }),
  },
];

/**
 * Fenêtre anti-rejeu : `GED_WHATSAPP_REPLAY_WINDOW_SECONDS` si c'est un entier de 60 s à 7 jours,
 * sinon `WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS` (1 h).
 */
export function replayWindowFromEnv(env: NodeJS.ProcessEnv): number {
  return envInt(
    env.GED_WHATSAPP_REPLAY_WINDOW_SECONDS,
    WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS,
    WHATSAPP_REPLAY_WINDOW_MIN_SECONDS,
    WHATSAPP_REPLAY_WINDOW_MAX_SECONDS,
  );
}

// ---------------------------------------------------------------------------
// Utilitaires purs
// ---------------------------------------------------------------------------

const INT4_MAX = 2_147_483_647;
/** Longueur de `ged_source_item.mime_type` (VarChar(200)). */
const MIME_COLUMN_MAX = 200;
/** Longueur conservée du nom annoncé dans `origin_metadata` (le worker le ré-assainit). */
const DECLARED_FILENAME_MAX = 255;

/** Identifiant de connecteur de l'URL : entier décimal canonique de 1 à 2^31−1, sinon 404 générique. */
export function parseWebhookConnectorId(raw: unknown): number {
  if (typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw)) {
    const id = Number(raw);
    if (id <= INT4_MAX) return id;
  }
  throw new NotFoundException();
}

/** Tranche horaire UTC `AAAAMMJJHH` : clé du dédoublonnage des refus. */
export function utcHourBucket(now: Date): string {
  return now.toISOString().slice(0, 13).replace(/[-T]/g, '');
}

/** Millisecondes jusqu'à la prochaine heure UTC pleine (au moins 1 s). */
function msUntilNextUtcHour(now: Date): number {
  const t = now.getTime();
  const next = Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000;
  return Math.max(1000, next - t);
}

/** Identifiant stable du job de refus : une réponse au plus par (connecteur, expéditeur, heure UTC). */
export function refusalJobId(connectorId: number, senderHash: string, now: Date): string {
  return `wa-refuse-${connectorId}-${senderHash}-${utcHourBucket(now)}`;
}

/** Identifiant stable du job d'ingestion d'un élément. */
export function inboundJobId(itemId: bigint | string): string {
  return `wa-in-${itemId.toString()}`;
}

/**
 * Nom annoncé conservé pour le worker : sans caractères de contrôle ni demi-substituts isolés
 * (PostgreSQL refuse `\u0000` et les substituts isolés dans un `jsonb`, ce qui ferait échouer
 * l'enregistrement à chaque nouvelle livraison de Meta), borné. Jamais journalisé.
 */
function cleanDeclaredFilename(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = Array.from(raw.replace(/[\p{Cc}\p{Cs}]/gu, ''))
    .slice(0, DECLARED_FILENAME_MAX)
    .join('')
    .trim();
  return cleaned === '' ? undefined : cleaned;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002';
}

/** Nature d'une erreur, sans son message (qui peut citer des arguments de requête). */
function describeError(e: unknown): string {
  const name = e instanceof Error && /^[A-Za-z]{1,60}$/.test(e.name) ? e.name : 'unknown';
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? `${name}/${code}` : name;
}

function credentialString(creds: Record<string, unknown>, key: string): string | null {
  const v = creds[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Sous-ensemble de la requête HTTP utile à la résolution de l'IP du client. */
export interface WhatsappClientRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, unknown>;
}

export interface WhatsappChallengeQuery {
  'hub.mode'?: unknown;
  'hub.verify_token'?: unknown;
  'hub.challenge'?: unknown;
  [key: string]: unknown;
}

export interface WhatsappNotificationInput {
  connectorId: unknown;
  /** `req.body` tel que posé par `whatsapp-raw-body` : un Buffer, jamais un objet analysé. */
  body: unknown;
  /** En-tête `X-Hub-Signature-256` brut. */
  signature: unknown;
  req: WhatsappClientRequest;
}

type AuthFailure =
  | 'unknown_connector'
  | 'wrong_type'
  | 'inactive'
  | 'credentials_unreadable'
  | 'secret_missing'
  | 'bad_signature';

type TargetLookup =
  | { ok: true; config: unknown; credentials: Record<string, unknown> }
  | { ok: false; reason: AuthFailure };

interface Counters {
  accepted: number;
  requeued: number;
  replay: number;
  unknownSender: number;
  refusalsQueued: number;
  unsupported: number;
  rateLimited: number;
  invalid: number;
}

interface MessageContext {
  connectorId: number;
  settings: WhatsappConfigParsed;
  appSecret: string;
  now: Date;
  counters: Counters;
  /** Refus déjà enfilés pendant cette requête (évite des appels Redis redondants). */
  refusals: Set<string>;
}

/** Au plus un journal « rate_limited » par IP et par minute par processus (pas d'inondation). */
const RATE_LOG_INTERVAL_MS = 60_000;

@Injectable()
export class WhatsappWebhookService {
  private readonly logger = new Logger('WhatsappWebhook');
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: () => Date;
  private readonly trustProxy: boolean;
  private readonly replayWindowSeconds: number;
  /** Secret et jeton LEURRES (aléatoires, propres au processus) : HMAC calculé même en échec. */
  private readonly decoySecret = randomBytes(32).toString('hex');
  private readonly decoyVerifyToken = randomBytes(32).toString('hex');
  private lastRateLog = 0;
  private suppressedRateLogs = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(GED_WHATSAPP_QUEUE_TOKEN) private readonly queue: Queue,
    @Inject(GED_WHATSAPP_IP_LIMITER) private readonly ipLimiter: WhatsappRateLimiter,
    @Inject(GED_WHATSAPP_SENDER_LIMITER) private readonly senderLimiter: WhatsappRateLimiter,
    @Optional() @Inject(GED_WHATSAPP_RUNTIME) runtime?: WhatsappWebhookRuntime,
  ) {
    this.env = runtime?.env ?? process.env;
    this.clock = runtime?.now ?? (() => new Date());
    this.trustProxy = this.env.GED_WHATSAPP_TRUST_PROXY === '1';
    this.replayWindowSeconds = replayWindowFromEnv(this.env);
    const rawWindow = this.env.GED_WHATSAPP_REPLAY_WINDOW_SECONDS;
    if (
      rawWindow !== undefined &&
      rawWindow.trim() !== '' &&
      envInt(rawWindow, -1, WHATSAPP_REPLAY_WINDOW_MIN_SECONDS, WHATSAPP_REPLAY_WINDOW_MAX_SECONDS) === -1
    ) {
      // La valeur saisie n'est pas recopiée : seule la règle l'est.
      this.logger.warn(
        `GED_WHATSAPP_REPLAY_WINDOW_SECONDS ignorée (entier de ${WHATSAPP_REPLAY_WINDOW_MIN_SECONDS} à ` +
          `${WHATSAPP_REPLAY_WINDOW_MAX_SECONDS} attendu) : fenêtre par défaut de ${WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS} s`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // GET : vérification de l'abonnement par Meta
  // -------------------------------------------------------------------------

  /** Renvoie le challenge à répondre en text/plain ; 403 générique dans tous les cas d'échec. */
  async verifySubscription(
    rawConnectorId: unknown,
    query: WhatsappChallengeQuery,
    req: WhatsappClientRequest,
  ): Promise<string> {
    this.takeIpQuota(req);
    const connectorId = parseWebhookConnectorId(rawConnectorId);
    const target = await this.loadTarget(connectorId);
    const verifyToken = target.ok ? credentialString(target.credentials, 'verifyToken') : null;
    // Comparaison faite dans tous les cas (jeton leurre) : même coût quel que soit le connecteur.
    const result = verifyWhatsappChallenge(
      {
        mode: query?.['hub.mode'],
        token: query?.['hub.verify_token'],
        challenge: query?.['hub.challenge'],
      },
      verifyToken ?? this.decoyVerifyToken,
    );
    if (!target.ok || verifyToken === null || !result.ok) {
      const reason = !target.ok ? target.reason : verifyToken === null ? 'secret_missing' : 'bad_token';
      this.logger.warn(`whatsapp_webhook decision=challenge_refused connector=${connectorId} reason=${reason}`);
      throw new ForbiddenException();
    }
    this.logger.log(`whatsapp_webhook decision=challenge_ok connector=${connectorId}`);
    return result.challenge;
  }

  // -------------------------------------------------------------------------
  // POST : réception d'une notification
  // -------------------------------------------------------------------------

  async receiveNotification(input: WhatsappNotificationInput): Promise<{ received: true }> {
    // (a) Débit par IP, avant tout calcul.
    this.takeIpQuota(input.req);

    // (b) Forme de l'URL et du corps (aucune lecture de son contenu).
    const connectorId = parseWebhookConnectorId(input.connectorId);
    const body = input.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException();
    if (body.length > WHATSAPP_MAX_BODY_BYTES) throw new PayloadTooLargeException();

    // (c) Connecteur (colonnes minimales) et identifiants déchiffrés.
    const target = await this.loadTarget(connectorId);
    const appSecret = target.ok ? credentialString(target.credentials, 'appSecret') : null;

    // (d) Signature sur les octets bruts. Calculée même en échec (secret leurre) : temps homogène.
    const signed = verifyWhatsappSignature(body, input.signature, appSecret ?? this.decoySecret);
    if (!target.ok || appSecret === null || !signed) {
      const reason: AuthFailure = !target.ok
        ? target.reason
        : appSecret === null
          ? 'secret_missing'
          : 'bad_signature';
      this.logger.warn(`whatsapp_webhook decision=auth_failed connector=${connectorId} reason=${reason}`);
      throw new UnauthorizedException();
    }

    // --- Authentifié à partir d'ici. ---
    let settings: WhatsappConfigParsed;
    try {
      settings = parseWhatsappStoredConfig(target.config).settings;
    } catch {
      // Configuration enregistrée invalide : 500 pour que Meta ré-essaie une fois corrigée.
      this.logger.error(`whatsapp_webhook decision=config_invalid connector=${connectorId}`);
      throw new InternalServerErrorException();
    }

    // (e) Analyse, seulement maintenant.
    const now = this.clock();
    const parsed = parseWhatsappWebhook(body, {
      phoneNumberId: settings.phoneNumberId,
      now,
      replayWindowSeconds: this.replayWindowSeconds,
    });
    if (parsed.malformed) {
      this.logger.warn(`whatsapp_webhook decision=malformed connector=${connectorId}`);
      throw new BadRequestException();
    }

    // (f) Messages, un par un, dans l'ordre.
    const ctx: MessageContext = {
      connectorId,
      settings,
      appSecret,
      now,
      counters: {
        accepted: 0,
        requeued: 0,
        replay: 0,
        unknownSender: 0,
        refusalsQueued: 0,
        unsupported: 0,
        rateLimited: 0,
        invalid: 0,
      },
      refusals: new Set<string>(),
    };
    try {
      for (const message of parsed.messages) await this.handleMessage(ctx, message);
    } catch (e) {
      if (e instanceof HttpException) throw e;
      // Base ou Redis indisponible APRÈS signature valide : 500, Meta ré-essaiera (idempotent).
      this.logger.error(
        `whatsapp_webhook decision=store_failed connector=${connectorId} error=${describeError(e)}`,
      );
      throw new InternalServerErrorException();
    }

    const c = ctx.counters;
    const ig = parsed.ignored;
    this.logger.log(
      `whatsapp_webhook decision=received connector=${connectorId} messages=${parsed.messages.length} ` +
        `accepted=${c.accepted} requeued=${c.requeued} replay=${c.replay} ` +
        `unknown_sender=${c.unknownSender} refusals_queued=${c.refusalsQueued} ` +
        `unsupported=${c.unsupported} rate_limited=${c.rateLimited} invalid=${c.invalid + ig.invalid} ` +
        `stale=${ig.stale} wrong_number=${ig.wrongNumber} statuses=${ig.statuses}`,
    );
    // (g)
    return { received: true };
  }

  // -------------------------------------------------------------------------
  // Étapes internes
  // -------------------------------------------------------------------------

  private takeIpQuota(req: WhatsappClientRequest): void {
    const ip = resolveClientIp(req, { trustForwardedFor: this.trustProxy });
    if (this.ipLimiter.take(`ip:${ip}`)) return;
    const t = Date.now();
    if (t - this.lastRateLog >= RATE_LOG_INTERVAL_MS) {
      // Ni l'IP ni l'URL : seulement la décision et le nombre de refus non journalisés.
      this.logger.warn(
        `whatsapp_webhook decision=rate_limited scope=ip suppressed=${this.suppressedRateLogs}`,
      );
      this.lastRateLog = t;
      this.suppressedRateLogs = 0;
    } else {
      this.suppressedRateLogs++;
    }
    throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }

  /**
   * Chargement minimal : seules les colonnes utiles sont lues. Aucune différence de réponse entre
   * les cas d'échec (l'appelant répond la même erreur) ; le motif n'existe que dans le journal.
   */
  private async loadTarget(connectorId: number): Promise<TargetLookup> {
    let row: {
      connectorType: string;
      status: number;
      isActive: boolean;
      credentialsEnc: string | null;
      credentialsKeyId: string | null;
      credentialsRef: string | null;
      config: unknown;
    } | null;
    try {
      row = await this.prisma.gedSourceConnector.findUnique({
        where: { gedSourceConnectorId: connectorId },
        select: {
          connectorType: true,
          status: true,
          isActive: true,
          credentialsEnc: true,
          credentialsKeyId: true,
          credentialsRef: true,
          config: true,
        },
      });
    } catch (e) {
      this.logger.error(
        `whatsapp_webhook decision=connector_load_failed connector=${connectorId} error=${describeError(e)}`,
      );
      throw new InternalServerErrorException();
    }
    if (!row) return { ok: false, reason: 'unknown_connector' };
    if (row.connectorType !== GED_WHATSAPP_CONNECTOR_TYPE) return { ok: false, reason: 'wrong_type' };
    if (!row.isActive || row.status === GedSourceConnectorStatus.Inactif) {
      return { ok: false, reason: 'inactive' };
    }
    let credentials: Record<string, unknown>;
    try {
      if (row.credentialsRef) {
        credentials = resolveCredentialsRef(row.credentialsRef, this.env);
      } else if (row.credentialsEnc) {
        credentials = decryptCredentials(row.credentialsEnc, row.credentialsKeyId, loadKeyRing(this.env));
      } else {
        return { ok: false, reason: 'secret_missing' };
      }
    } catch {
      // Le message de la bibliothèque est sûr, mais il n'apporte rien ici : le motif suffit.
      return { ok: false, reason: 'credentials_unreadable' };
    }
    return { ok: true, config: row.config, credentials };
  }

  private async handleMessage(ctx: MessageContext, message: WhatsappInboundMessage): Promise<void> {
    const { connectorId, counters } = ctx;
    const senderHash = hashPhone(message.from, ctx.appSecret);
    const tag = `connector=${connectorId} sender=${senderHash} message=${message.messageId}`;

    // 1. Débit par expéditeur (avant même la liste blanche) : message ignoré et compté.
    if (!this.senderLimiter.take(`${connectorId}:${senderHash}`)) {
      counters.rateLimited++;
      this.logger.warn(`whatsapp_webhook decision=rate_limited scope=sender ${tag}`);
      return;
    }

    // 2. Liste blanche, refus par défaut. Expéditeur inconnu : rien n'est créé ni traité.
    const sender = resolveWhatsappSender(ctx.settings, message.from);
    if (!sender.allowed) {
      counters.unknownSender++;
      if (ctx.settings.refuseUnknownSenders === true) {
        await this.enqueueRefusal(ctx, message.from, senderHash, 'unknown_sender');
        this.logger.warn(`whatsapp_webhook decision=refused_unknown_sender reply=queued ${tag}`);
      } else {
        this.logger.warn(`whatsapp_webhook decision=refused_unknown_sender reply=none ${tag}`);
      }
      return;
    }

    // 3. Type non pris en charge (texte, audio, vidéo…) : contenu jamais lu, refus poli.
    if (message.kind === 'unsupported') {
      counters.unsupported++;
      await this.enqueueRefusal(ctx, message.from, senderHash, 'unsupported_type');
      this.logger.log(`whatsapp_webhook decision=unsupported_type reply=queued ${tag}`);
      return;
    }

    if (typeof message.mediaId !== 'string' || message.mediaId === '') {
      counters.invalid++;
      this.logger.warn(`whatsapp_webhook decision=invalid_media ${tag}`);
      return;
    }

    // 4. Document ou image d'un expéditeur autorisé : élément puis job (idempotent).
    await this.recordMedia(ctx, message, message.kind, message.mediaId, senderHash, tag);
  }

  private async recordMedia(
    ctx: MessageContext,
    message: WhatsappInboundMessage,
    kind: 'document' | 'image',
    mediaId: string,
    senderHash: string,
    tag: string,
  ): Promise<void> {
    const { connectorId, counters, now } = ctx;
    const messageDate = new Date(message.timestamp * 1000);
    const mimeType =
      message.mimeType !== undefined && message.mimeType.length <= MIME_COLUMN_MAX
        ? message.mimeType
        : undefined;
    const declaredFilename = kind === 'document' ? cleanDeclaredFilename(message.filename) : undefined;
    const metadata: GedWhatsappItemMetadata = {
      messageType: kind,
      mediaId,
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(declaredFilename !== undefined ? { declaredFilename } : {}),
      ...(message.sha256 !== undefined ? { declaredSha256: message.sha256 } : {}),
      senderPhone: message.from,
      senderHash,
      messageTimestamp: message.timestamp,
      receivedAt: now.toISOString(),
    };

    let itemId: bigint;
    try {
      const created = await this.prisma.gedSourceItem.create({
        data: {
          connectorId,
          externalId: message.messageId,
          name: sanitizeWhatsappFileName(message.filename, {
            mimeType,
            messageType: kind,
            now: messageDate,
          }),
          mimeType: mimeType ?? null,
          // Pseudonyme, JAMAIS le numéro (exposé par l'API d'administration).
          originAuthor: senderHash,
          originCreatedAt: messageDate,
          // Non exposé par l'API : contient le numéro, nécessaire au worker pour répondre.
          originMetadata: metadata as unknown as Prisma.InputJsonValue,
          // `origin_acl` laissé NULL (colonne sans défaut) : les droits viennent de `rights`.
          state: GedSourceItemState.Decouvert,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        select: { gedSourceItemId: true },
      });
      itemId = created.gedSourceItemId;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Déjà vu : livraison rejouée par Meta (ou course entre deux livraisons).
      await this.handleReplay(ctx, message, tag);
      return;
    }

    await this.enqueueInbound(connectorId, itemId);
    counters.accepted++;
    this.logger.log(`whatsapp_webhook decision=accepted ${tag} item=${itemId.toString()}`);
  }

  /**
   * Message déjà enregistré. Encore « Découvert » : son job a pu être perdu (Redis indisponible
   * après l'écriture) → on ré-enfile, l'identifiant de job stable évite le doublon. Sinon : ignoré.
   */
  private async handleReplay(ctx: MessageContext, message: WhatsappInboundMessage, tag: string): Promise<void> {
    const existing = await this.prisma.gedSourceItem.findUnique({
      where: { connectorId_externalId: { connectorId: ctx.connectorId, externalId: message.messageId } },
      select: { gedSourceItemId: true, state: true },
    });
    if (existing && existing.state === GedSourceItemState.Decouvert) {
      await this.enqueueInbound(ctx.connectorId, existing.gedSourceItemId);
      ctx.counters.requeued++;
      this.logger.log(
        `whatsapp_webhook decision=replay action=requeued ${tag} item=${existing.gedSourceItemId.toString()}`,
      );
      return;
    }
    ctx.counters.replay++;
    this.logger.log(`whatsapp_webhook decision=replay action=ignored ${tag}`);
  }

  private async enqueueInbound(connectorId: number, itemId: bigint): Promise<void> {
    const data: GedWhatsappInboundJobData = { connectorId, itemId: itemId.toString() };
    await this.queue.add(GED_WHATSAPP_JOB.inbound, data, {
      jobId: inboundJobId(itemId),
      ...WHATSAPP_INBOUND_JOB_OPTIONS,
      backoff: { ...WHATSAPP_INBOUND_JOB_OPTIONS.backoff },
      removeOnFail: { ...WHATSAPP_INBOUND_JOB_OPTIONS.removeOnFail },
    });
  }

  /**
   * Un refus au plus par (connecteur, expéditeur, heure UTC) : `jobId` stable ET clé de
   * dédoublonnage BullMQ valable jusqu'à la fin de l'heure. Le `jobId` seul ne suffirait pas : le job
   * est supprimé dès son exécution (il porte le numéro), et un même `jobId` serait alors réaccepté.
   */
  private async enqueueRefusal(
    ctx: MessageContext,
    to: string,
    senderHash: string,
    reason: GedWhatsappRefuseJobData['reason'],
  ): Promise<void> {
    const jobId = refusalJobId(ctx.connectorId, senderHash, ctx.now);
    if (ctx.refusals.has(jobId)) return;
    ctx.refusals.add(jobId);
    const data: GedWhatsappRefuseJobData = { connectorId: ctx.connectorId, to, reason };
    await this.queue.add(GED_WHATSAPP_JOB.refuse, data, {
      jobId,
      deduplication: { id: jobId, ttl: msUntilNextUtcHour(ctx.now) },
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      // Le numéro ne doit pas rester dans Redis : supprimé après exécution, réussie ou non.
      removeOnComplete: true,
      removeOnFail: true,
    });
    ctx.counters.refusalsQueued++;
  }
}
