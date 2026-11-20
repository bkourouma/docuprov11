// Lot 2c — noyau de sécurité PUR du webhook WhatsApp Cloud (Meta).
//
// Ce fichier ne dépend ni de Nest, ni de Prisma, ni du réseau : le contrôleur public de l'API
// l'appelle dans cet ordre.
//   1. `resolveClientIp` + `SlidingWindowRateLimiter` (par IP) : limiter avant tout calcul.
//   2. GET  : `verifyWhatsappChallenge` (abonnement du webhook côté Meta).
//      POST : `verifyWhatsappSignature` sur le CORPS BRUT (jamais sur un JSON re-sérialisé).
//   3. `parseWhatsappWebhook` (seulement après signature valide), puis limiteur par expéditeur et
//      idempotence par `(connector_id, external_id = messageId)` côté appelant.
//
// Règles transverses :
//  - aucune fonction exportée ne lève sur une entrée venue du réseau (seul le constructeur du
//    limiteur lève, sur une erreur de programmation, avec un message sans donnée) ;
//  - aucun secret, numéro, jeton ni fragment de corps n'apparaît dans une valeur de retour ou un
//    message d'erreur ;
//  - les expressions régulières sont toutes linéaires (une seule classe de caractères répétée,
//    ancrée, sans alternative imbriquée) et ne voient que des chaînes déjà bornées en longueur ;
//  - aucun `JSON.parse` avant d'avoir borné la taille ET la profondeur du corps.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { normalizePhone } from './whatsapp-phone';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** En-tête de signature envoyé par Meta (nom en minuscules, tel que Node l'expose dans `req.headers`). */
export const WHATSAPP_SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Taille maximale d'un corps de webhook. Les notifications Meta font quelques Ko (les médias ne
 * voyagent jamais dans le corps : seulement leur identifiant). Au-delà, le corps est refusé avant
 * toute analyse.
 */
export const WHATSAPP_MAX_BODY_BYTES = 256 * 1024;

/**
 * Fenêtre anti-rejeu par défaut (secondes) appliquée à l'horodatage de chaque message.
 *
 * Compromis : Meta ré-essaie la livraison d'une notification pendant 7 jours tant qu'on ne lui
 * répond pas 200. L'API répond TOUJOURS 200 rapidement (après enregistrement), si bien qu'une
 * livraison légitime arrive en pratique dans la minute ; une fenêtre d'une heure laisse de la marge
 * pour une indisponibilité courte de l'API. Elle protège contre le rejeu, plus tard, d'un corps
 * signé capturé (journal, proxy, sauvegarde) : la signature reste valide indéfiniment, l'horodatage
 * non. Elle COMPLÈTE l'idempotence par identifiant de message (unicité
 * `(connector_id, external_id)` faite par l'appelant), qui couvre le rejeu à l'intérieur de la
 * fenêtre. Revers : après une panne de l'API de plus d'une heure, les messages ré-émis par Meta
 * sont comptés `stale` et perdus (l'expéditeur doit renvoyer) — on préfère cette perte visible à
 * l'acceptation d'anciens corps rejoués.
 */
export const WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS = 3600;

/** Avance maximale tolérée par défaut (secondes) d'un horodatage sur l'horloge locale. */
const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 300;

/** Bornes dures d'un corps : au-delà, le corps entier est refusé (`malformed`), rien n'est traité. */
const MAX_ENTRIES = 50;
const MAX_CHANGES = 50;
const MAX_MESSAGES = 100;
const MAX_STATUSES = 1000;
/** Profondeur d'imbrication JSON maximale (un corps Meta réel en a moins de 10). */
const MAX_JSON_DEPTH = 32;

/** Bornes de longueur des chaînes lues. */
const MAX_MESSAGE_ID_CHARS = 306; // `wamid.` + 300
const MAX_FILENAME_CHARS = 1024;
const MAX_MIME_CHARS = 255;
const MAX_SHORT_CHARS = 100;

/** `sha256=` + exactement 64 hexadécimaux (casse tolérée). */
const SIGNATURE_REGEX = /^sha256=([0-9a-fA-F]{64})$/;
const MAX_SIGNATURE_HEADER_CHARS = 7 + 64;
/** Challenge renvoyé en text/plain : jamais autre chose que ces caractères. */
const CHALLENGE_REGEX = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_VERIFY_TOKEN_CHARS = 1024;
const MESSAGE_ID_REGEX = /^wamid\.[A-Za-z0-9+/=_.-]{1,300}$/;
const MEDIA_ID_REGEX = /^[0-9]{1,30}$/;
const PHONE_NUMBER_ID_REGEX = /^[0-9]{1,30}$/;
const TIMESTAMP_REGEX = /^[0-9]{1,12}$/;
const SHA256_HEX_REGEX = /^[0-9a-fA-F]{64}$/;
/** Base64 standard de 32 octets (44 caractères, un `=` final). */
const SHA256_B64_REGEX = /^[A-Za-z0-9+/]{43}=$/;
const MIME_PART_REGEX = /^[a-z0-9!#$&^_.+-]{1,127}$/;

// ---------------------------------------------------------------------------
// Signature X-Hub-Signature-256
// ---------------------------------------------------------------------------

/**
 * Vérifie la signature Meta d'un corps de webhook : `sha256=<HMAC-SHA256(corps brut, appSecret) en hex>`.
 *
 * Ne lève jamais. Faux si : `rawBody` n'est pas un Buffer (corps déjà analysé = signature
 * invérifiable), secret vide, en-tête absent, dupliqué (tableau) ou mal formé. Comparaison à temps
 * constant sur deux buffers de 32 octets.
 */
export function verifyWhatsappSignature(
  rawBody: unknown,
  header: unknown,
  appSecret: string,
): boolean {
  try {
    if (!Buffer.isBuffer(rawBody)) return false;
    if (typeof appSecret !== 'string' || appSecret.length === 0) return false;
    if (typeof header !== 'string' || header.length !== MAX_SIGNATURE_HEADER_CHARS) return false;
    const match = SIGNATURE_REGEX.exec(header);
    if (!match) return false;
    const provided = Buffer.from(match[1] as string, 'hex');
    const expected = createHmac('sha256', appSecret).update(rawBody).digest();
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  } catch {
    // Défensif : rien ne doit remonter (et surtout pas un message citant une entrée).
    return false;
  }
}

// ---------------------------------------------------------------------------
// Challenge de vérification (GET hub.mode / hub.verify_token / hub.challenge)
// ---------------------------------------------------------------------------

/** Clé aléatoire propre au processus : les jetons sont comparés via leur HMAC (longueur fixe). */
const TOKEN_COMPARE_KEY = randomBytes(32);

function tokenDigest(value: string): Buffer {
  return createHmac('sha256', TOKEN_COMPARE_KEY).update(value, 'utf8').digest();
}

/**
 * Vérifie la requête d'abonnement de Meta. `ok: true` seulement si le mode vaut exactement
 * `subscribe`, que le jeton correspond (comparaison à temps constant de leurs HMAC : ni le contenu
 * ni la longueur du jeton attendu ne fuient par le temps de réponse) et que le challenge est sûr à
 * renvoyer tel quel en text/plain. Toute valeur non chaîne (paramètre répété → tableau) est refusée.
 */
export function verifyWhatsappChallenge(
  query: { mode?: unknown; token?: unknown; challenge?: unknown },
  expectedVerifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  try {
    if (query === null || typeof query !== 'object') return { ok: false };
    const { mode, token, challenge } = query;
    if (typeof expectedVerifyToken !== 'string' || expectedVerifyToken.length === 0) {
      return { ok: false };
    }
    if (typeof mode !== 'string' || mode !== 'subscribe') return { ok: false };
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_VERIFY_TOKEN_CHARS) {
      return { ok: false };
    }
    if (typeof challenge !== 'string' || challenge.length > 200 || !CHALLENGE_REGEX.test(challenge)) {
      return { ok: false };
    }
    if (!timingSafeEqual(tokenDigest(token), tokenDigest(expectedVerifyToken))) {
      return { ok: false };
    }
    return { ok: true, challenge };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Anti-rejeu
// ---------------------------------------------------------------------------

/**
 * Vrai si l'horodatage d'un message (secondes Unix) est dans `[now − windowSeconds,
 * now + maxFutureSkewSeconds]`, bornes incluses. Faux (refus) pour toute entrée non exploitable :
 * horodatage non entier, négatif ou NaN, date invalide, fenêtre ou avance négative/non finie.
 * Voir `WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS` pour le compromis.
 */
export function isWithinReplayWindow(
  messageTimestampSeconds: number,
  now: Date,
  windowSeconds: number,
  maxFutureSkewSeconds = DEFAULT_MAX_FUTURE_SKEW_SECONDS,
): boolean {
  if (!Number.isSafeInteger(messageTimestampSeconds) || messageTimestampSeconds < 0) return false;
  if (!(now instanceof Date)) return false;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(windowSeconds) || windowSeconds < 0) return false;
  if (!Number.isFinite(maxFutureSkewSeconds) || maxFutureSkewSeconds < 0) return false;
  const ageMs = nowMs - messageTimestampSeconds * 1000;
  return ageMs <= windowSeconds * 1000 && -ageMs <= maxFutureSkewSeconds * 1000;
}

// ---------------------------------------------------------------------------
// Analyse du corps
// ---------------------------------------------------------------------------

/** Un message entrant retenu (numéro du connecteur, signé, dans la fenêtre, forme valide). */
export interface WhatsappInboundMessage {
  /** Identifiant Meta `wamid.…` : `external_id` de l'élément (idempotence). */
  messageId: string;
  /** Numéro de l'expéditeur, chiffres seulement (E.164 sans `+`), via `normalizePhone`. */
  from: string;
  /** Horodatage annoncé par Meta (secondes Unix). */
  timestamp: number;
  kind: 'document' | 'image' | 'unsupported';
  /** Identifiant du média (`^[0-9]{1,30}$`), présent pour `document` et `image`. */
  mediaId?: string;
  /** Type MIME annoncé, en minuscules, sans paramètres ; omis s'il est mal formé. */
  mimeType?: string;
  /** Nom de fichier annoncé (document), BRUT et NON assaini : l'assainir avant tout usage. */
  filename?: string;
  /** SHA-256 annoncé du média, 64 hex minuscules ; omis s'il est absent ou illisible. */
  sha256?: string;
}

export interface ParsedWhatsappWebhook {
  /** Corps refusé en bloc (taille, encodage, JSON, profondeur, forme, bornes) : rien n'est renvoyé. */
  malformed: boolean;
  messages: WhatsappInboundMessage[];
  ignored: {
    /** Messages adressés à un autre numéro WhatsApp que celui du connecteur. */
    wrongNumber: number;
    /** Messages hors fenêtre anti-rejeu. */
    stale: number;
    /** Messages de forme invalide (identifiant, expéditeur, horodatage, média). */
    invalid: number;
    /** Accusés d'état de Meta (`statuses`) pour le numéro du connecteur. */
    statuses: number;
  };
}

export interface ParseWhatsappWebhookContext {
  /** Phone Number ID du connecteur : seuls les changements de CE numéro sont traités. */
  phoneNumberId: string;
  now: Date;
  /** Défaut : `WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS`. */
  replayWindowSeconds?: number;
}

// Schémas zod : les objets ne déclarent que les champs lus. Zod retire les champs inconnus SANS les
// parcourir (tolérance aux évolutions de Meta, pas de coût sur des sous-arbres ignorés), et les
// légendes (`caption`), textes et contacts ne sont jamais lus.
const rootSchema = z.object({
  object: z.string().max(MAX_SHORT_CHARS),
  entry: z.array(z.unknown()).max(MAX_ENTRIES),
});

const entrySchema = z.object({
  changes: z.array(z.unknown()).max(MAX_CHANGES),
});

const changeSchema = z.object({
  field: z.string().max(MAX_SHORT_CHARS),
  value: z.unknown(),
});

const messagesValueSchema = z.object({
  metadata: z.object({
    phone_number_id: z.string().min(1).max(MAX_SHORT_CHARS),
  }),
  messages: z.array(z.unknown()).max(MAX_MESSAGES).optional(),
  statuses: z.array(z.unknown()).max(MAX_STATUSES).optional(),
});

const mediaSchema = z.object({
  id: z.string().max(30).regex(MEDIA_ID_REGEX),
  // Indices non critiques : validés à part, un indice illisible est omis sans invalider le message.
  mime_type: z.unknown().optional(),
  sha256: z.unknown().optional(),
  filename: z.unknown().optional(),
});

const messageSchema = z.object({
  id: z.string().max(MAX_MESSAGE_ID_CHARS).regex(MESSAGE_ID_REGEX),
  from: z.string().max(40),
  timestamp: z.union([
    z.string().max(12).regex(TIMESTAMP_REGEX),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ]),
  type: z.string().min(1).max(40),
  document: z.unknown().optional(),
  image: z.unknown().optional(),
});

function emptyResult(malformed: boolean): ParsedWhatsappWebhook {
  return {
    malformed,
    messages: [],
    ignored: { wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 },
  };
}

/**
 * Profondeur maximale d'imbrication `{`/`[` du JSON, calculée en une passe linéaire sur les octets
 * (les chaînes et leurs échappements sont sautés). Appelée AVANT `JSON.parse` : un corps de 256 Ko
 * de `[[[[…` ne doit ni épuiser la pile ni coûter un arbre de 100 000 niveaux.
 */
function exceedsJsonDepth(buf: Buffer, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i] as number;
    if (inString) {
      if (c === 0x5c) i++; // `\` : l'octet suivant est échappé
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth++;
      if (depth > maxDepth) return true;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return false;
}

function normalizeMime(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MIME_CHARS) return undefined;
  const base = (raw.split(';', 1)[0] ?? '').trim().toLowerCase();
  const slash = base.indexOf('/');
  if (slash <= 0 || base.indexOf('/', slash + 1) !== -1) return undefined;
  const type = base.slice(0, slash);
  const subtype = base.slice(slash + 1);
  return MIME_PART_REGEX.test(type) && MIME_PART_REGEX.test(subtype) ? base : undefined;
}

/** Accepte le SHA-256 en hex (64) ou en base64 standard de 32 octets ; rend 64 hex minuscules. */
function normalizeSha256(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.length === 64 && SHA256_HEX_REGEX.test(raw)) return raw.toLowerCase();
  if (raw.length === 44 && SHA256_B64_REGEX.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32 && buf.toString('base64') === raw) return buf.toString('hex');
  }
  return undefined;
}

function normalizeFilename(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_FILENAME_CHARS
    ? raw
    : undefined;
}

type MessageOutcome =
  | { status: 'ok'; message: WhatsappInboundMessage }
  | { status: 'invalid' }
  | { status: 'stale' };

function readMessage(raw: unknown, now: Date, windowSeconds: number): MessageOutcome {
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) return { status: 'invalid' };
  const m = parsed.data;
  const from = normalizePhone(m.from);
  if (from === null) return { status: 'invalid' };
  const timestamp = typeof m.timestamp === 'string' ? Number(m.timestamp) : m.timestamp;
  if (!Number.isSafeInteger(timestamp)) return { status: 'invalid' };

  let message: WhatsappInboundMessage;
  if (m.type === 'document' || m.type === 'image') {
    const media = mediaSchema.safeParse(m.type === 'document' ? m.document : m.image);
    if (!media.success) return { status: 'invalid' };
    message = { messageId: m.id, from, timestamp, kind: m.type, mediaId: media.data.id };
    const mimeType = normalizeMime(media.data.mime_type);
    if (mimeType !== undefined) message.mimeType = mimeType;
    const sha256 = normalizeSha256(media.data.sha256);
    if (sha256 !== undefined) message.sha256 = sha256;
    if (m.type === 'document') {
      const filename = normalizeFilename(media.data.filename);
      if (filename !== undefined) message.filename = filename;
    }
  } else {
    // text, audio, video, sticker, location, contacts, interactive, reaction… : pas de média lu.
    message = { messageId: m.id, from, timestamp, kind: 'unsupported' };
  }

  if (!isWithinReplayWindow(timestamp, now, windowSeconds)) return { status: 'stale' };
  return { status: 'ok', message };
}

/**
 * Analyse un corps de webhook WhatsApp DÉJÀ AUTHENTIFIÉ (`verifyWhatsappSignature` vrai).
 *
 * Ne lève jamais. Refuse en bloc (`malformed: true`, aucun message) : corps non Buffer, vide ou
 * > `WHATSAPP_MAX_BODY_BYTES`, UTF-8 invalide, JSON invalide ou trop profond, forme inattendue,
 * plus de 50 entrées, 50 changements ou 100 messages au total. Ne traite que
 * `object = whatsapp_business_account`, les changements `field = messages` et le seul numéro
 * `ctx.phoneNumberId` (isolation entre connecteurs). Les messages invalides, hors fenêtre ou
 * dupliqués dans le corps ne sont pas renvoyés ; les `statuses` sont comptés et ignorés.
 */
export function parseWhatsappWebhook(
  rawBody: Buffer,
  ctx: ParseWhatsappWebhookContext,
): ParsedWhatsappWebhook {
  try {
    return parseUnsafe(rawBody, ctx);
  } catch {
    // Filet de sécurité : aucune exception (ni son message) ne doit sortir d'ici.
    return emptyResult(true);
  }
}

function parseUnsafe(rawBody: unknown, ctx: ParseWhatsappWebhookContext): ParsedWhatsappWebhook {
  if (!Buffer.isBuffer(rawBody)) return emptyResult(true);
  if (rawBody.length === 0 || rawBody.length > WHATSAPP_MAX_BODY_BYTES) return emptyResult(true);
  if (exceedsJsonDepth(rawBody, MAX_JSON_DEPTH)) return emptyResult(true);

  let json: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    json = JSON.parse(text);
  } catch {
    return emptyResult(true);
  }

  const root = rootSchema.safeParse(json);
  if (!root.success) return emptyResult(true);
  if (root.data.object !== 'whatsapp_business_account') return emptyResult(false);

  // Passe 1 : forme et bornes de TOUT le corps, avant de traiter quoi que ce soit (pas de
  // résultat partiel sur un corps qu'on finit par refuser).
  type MessagesValue = z.infer<typeof messagesValueSchema>;
  const values: MessagesValue[] = [];
  let changeCount = 0;
  let messageCount = 0;
  for (const rawEntry of root.data.entry) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) return emptyResult(true);
    changeCount += entry.data.changes.length;
    if (changeCount > MAX_CHANGES) return emptyResult(true);
    for (const rawChange of entry.data.changes) {
      const change = changeSchema.safeParse(rawChange);
      if (!change.success) return emptyResult(true);
      if (change.data.field !== 'messages') continue;
      const value = messagesValueSchema.safeParse(change.data.value);
      if (!value.success) return emptyResult(true);
      messageCount += value.data.messages?.length ?? 0;
      if (messageCount > MAX_MESSAGES) return emptyResult(true);
      values.push(value.data);
    }
  }

  // Passe 2 : filtrage par numéro, validation message par message, anti-rejeu, déduplication.
  const result = emptyResult(false);
  const ownNumber =
    typeof ctx?.phoneNumberId === 'string' && PHONE_NUMBER_ID_REGEX.test(ctx.phoneNumberId)
      ? ctx.phoneNumberId
      : null;
  const windowSeconds = ctx?.replayWindowSeconds ?? WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS;
  const now = ctx?.now;
  const seen = new Set<string>();

  for (const value of values) {
    const messages = value.messages ?? [];
    // Un Phone Number ID de connecteur invalide ne correspond à rien : refus par défaut.
    if (ownNumber === null || value.metadata.phone_number_id !== ownNumber) {
      result.ignored.wrongNumber += messages.length;
      continue;
    }
    result.ignored.statuses += value.statuses?.length ?? 0;
    for (const raw of messages) {
      const outcome = readMessage(raw, now as Date, windowSeconds);
      if (outcome.status === 'invalid') result.ignored.invalid++;
      else if (outcome.status === 'stale') result.ignored.stale++;
      else if (!seen.has(outcome.message.messageId)) {
        seen.add(outcome.message.messageId);
        result.messages.push(outcome.message);
      }
      // Doublon dans le même corps : silencieusement écarté (Meta peut regrouper).
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Limiteur de débit à fenêtre glissante
// ---------------------------------------------------------------------------

export interface SlidingWindowRateLimiterOptions {
  /** Nombre maximal d'appels autorisés par clé et par fenêtre (entier, 1 à 10 000). */
  limit: number;
  /** Durée de la fenêtre glissante en millisecondes (entier > 0). */
  windowMs: number;
  /** Nombre maximal de clés suivies (défaut 10 000). */
  maxKeys?: number;
  /** Horloge en millisecondes (défaut `Date.now`), injectable pour les tests. */
  now?: () => number;
}

interface RateEntry {
  /** Instants (ms) des appels autorisés encore dans la fenêtre, croissants. */
  hits: number[];
  /** Dernier appel (autorisé ou non) : ordre d'éviction. */
  last: number;
}

const MAX_RATE_KEY_CHARS = 256;
const INVALID_RATE_KEY = '\u0000invalid';

/**
 * Limiteur exact à fenêtre glissante (journal des instants), en mémoire du processus.
 *
 * Mémoire BORNÉE : au plus `maxKeys` clés de `limit` instants chacune. Quand la table est pleine,
 * les clés expirées sont purgées puis, si besoin, les clés les moins récemment vues sont évincées.
 * Une avalanche de clés distinctes ne fait donc pas croître la mémoire ; elle peut seulement rendre
 * un quota neuf à une clé évincée (dégradation connue, préférée au refus de clés légitimes).
 * Instance par critère (IP, expéditeur) ; non partagé entre processus.
 */
export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  /** Ordre d'insertion = ordre du dernier appel (clé réinsérée à chaque appel). */
  private readonly entries = new Map<string, RateEntry>();

  constructor(opts: SlidingWindowRateLimiterOptions) {
    const { limit, windowMs, maxKeys = 10_000, now = Date.now } = opts ?? ({} as never);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError('SlidingWindowRateLimiter : limit doit être un entier entre 1 et 10000');
    }
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
      throw new RangeError('SlidingWindowRateLimiter : windowMs doit être un entier positif');
    }
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 1_000_000) {
      throw new RangeError('SlidingWindowRateLimiter : maxKeys doit être un entier entre 1 et 1000000');
    }
    if (typeof now !== 'function') {
      throw new TypeError('SlidingWindowRateLimiter : now doit être une fonction');
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** Vrai = autorisé (un jeton est consommé) ; faux = limite atteinte pour cette clé. */
  take(key: string): boolean {
    const k =
      typeof key === 'string' && key.length > 0
        ? key.length > MAX_RATE_KEY_CHARS
          ? key.slice(0, MAX_RATE_KEY_CHARS)
          : key
        : INVALID_RATE_KEY;
    const t = this.currentTime();
    const cutoff = t - this.windowMs;

    let entry = this.entries.get(k);
    if (entry) {
      this.entries.delete(k);
    } else {
      this.makeRoom(cutoff);
      entry = { hits: [], last: t };
    }
    while (entry.hits.length > 0 && (entry.hits[0] as number) <= cutoff) entry.hits.shift();
    entry.last = t;
    this.entries.set(k, entry);

    if (entry.hits.length >= this.limit) return false;
    entry.hits.push(t);
    return true;
  }

  /** Oublie toutes les clés. */
  reset(): void {
    this.entries.clear();
  }

  /** Nombre de clés suivies (observabilité et tests de la borne mémoire). */
  get size(): number {
    return this.entries.size;
  }

  private currentTime(): number {
    const t = this.now();
    return Number.isFinite(t) ? t : Date.now();
  }

  private makeRoom(cutoff: number): void {
    if (this.entries.size < this.maxKeys) return;
    // Les clés sont rangées par dernier appel croissant : les expirées forment un préfixe.
    // Un appel refusé implique `limit` instants dans la fenêtre, donc `last` ≤ cutoff ⇒ tout expiré.
    for (const [k, e] of this.entries) {
      if (e.last > cutoff) break;
      this.entries.delete(k);
    }
    while (this.entries.size >= this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Adresse IP du client
// ---------------------------------------------------------------------------

function normalizeIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.length === 0 || s.length > 64) return null;
  // `[::1]:443` ou `[::1]`
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    const rest = s.slice(close + 1);
    if (rest !== '' && !/^:[0-9]{1,5}$/.test(rest)) return null;
    s = s.slice(1, close);
  } else if (/^[0-9.]{7,15}:[0-9]{1,5}$/.test(s)) {
    // `1.2.3.4:5678` (certains proxys ajoutent le port)
    s = s.slice(0, s.indexOf(':'));
  }
  const family = isIP(s);
  if (family === 0) return null;
  if (family === 6) {
    const lower = s.toLowerCase();
    // IPv4 mappée (`::ffff:1.2.3.4`) : même clé de limitation que l'IPv4 nue.
    if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return lower.slice(7);
    return lower;
  }
  return s;
}

/**
 * Adresse IP du client pour la limitation de débit et les journaux.
 *
 * Par défaut, `X-Forwarded-For` est IGNORÉ (n'importe quel client peut l'écrire) : l'adresse est
 * celle de la socket, puis `req.ip` en secours. Avec `trustForwardedFor` (API derrière UN proxy
 * inverse de confiance qui AJOUTE l'adresse vue), on prend la DERNIÈRE entrée non vide de la liste
 * — celle écrite par notre proxy ; les entrées précédentes sont fournies par le client. Si cette
 * dernière entrée n'est pas une adresse valide, on ne remonte pas plus haut dans la liste (ce serait
 * une valeur du client) : on retombe sur la socket. `'unknown'` si rien n'est exploitable.
 */
export function resolveClientIp(
  req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> },
  opts?: { trustForwardedFor?: boolean },
): string {
  try {
    if (opts?.trustForwardedFor === true) {
      const header = req?.headers?.['x-forwarded-for'];
      const joined =
        typeof header === 'string'
          ? header
          : Array.isArray(header) && header.every((h) => typeof h === 'string')
            ? header.join(',')
            : '';
      if (joined.length > 0 && joined.length <= 8192) {
        const parts = joined.split(',');
        for (let i = parts.length - 1; i >= 0; i--) {
          const part = (parts[i] as string).trim();
          if (part === '') continue;
          const ip = normalizeIp(part);
          if (ip !== null) return ip;
          break;
        }
      }
    }
    return normalizeIp(req?.socket?.remoteAddress) ?? normalizeIp(req?.ip) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
