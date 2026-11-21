// Lot 2c — connecteur WhatsApp Business : consommateur de la file `ged-whatsapp-inbound`.
//
// Le webhook public de l'API (autre lot) vérifie la signature de Meta, enregistre un élément
// (`ged_source_item`, état Découvert, `origin_metadata` = GedWhatsappItemMetadata) et enfile :
//   job `inbound` { connectorId, itemId } : télécharger le média, l'ingérer (mode copie), accuser ;
//   job `refuse`  { connectorId, to, reason } : envoyer un refus poli.
//
// Décisions :
//  - RELANCE : seules les erreurs transitoires (réseau, quota Graph, base) remontent à BullMQ
//    (`attempts` = 3 côté API, le délai est celui du `backoff` du producteur ; `retryAfterMs` d'un
//    quota est seulement journalisé : un `RateLimitError` exigerait une référence au Worker).
//    À la dernière tentative l'élément passe « En erreur » (sinon il resterait Découvert à jamais).
//    Un refus de contenu, un expéditeur non autorisé, un défaut de droits ou une erreur
//    d'authentification sont DÉFINITIFS : élément « En erreur », le job se termine normalement.
//  - IDEMPOTENCE : seul un élément « Découvert » est traité. Un élément déjà réglé est ignoré ; un
//    élément Découvert déjà rattaché à un document (arrêt entre la création et la mise à jour) est
//    marqué Copié sans recréer de document.
//  - DROITS : jamais plus ouverts que `resolveWhatsappGrants` ; aucun groupe = aucun document. Ils
//    sont évalués AVANT tout appel Graph : sans groupe applicable, rien n'est demandé ni téléchargé.
//  - CONFIDENTIALITÉ : le numéro n'est écrit que dans `origin_metadata` (jamais exposé). L'ACL
//    d'origine stockée (`origin_acl`, visible par l'API d'administration) reste nulle : les droits
//    viennent de `rights.principalMap` / du repli, pas d'une ACL contenant le numéro.
//  - EXTENSIONS : `.html` / `.htm` refusés pour ce dépôt (contenu actif potentiel).
//  - SECRETS : ni numéro, ni jeton, ni secret d'application, ni URL de média, ni nom de fichier
//    dans les journaux ; messages stockés passés par `redactSecrets`.
import type { Job } from 'bullmq';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  RightsWideningError,
  WhatsappGraphClient,
  buildAckMessage,
  buildRefusalMessage,
  buildRejectedMessage,
  createDefaultWhatsappHttp,
  decryptCredentials,
  hashPhone,
  loadKeyRing,
  normalizePhone,
  parseWhatsappStoredConfig,
  redactSecrets,
  resolveCredentialsRef,
  resolveLimits,
  resolveWhatsappGrants,
  resolveWhatsappSender,
  sanitizeWhatsappFileName,
  validateWhatsappMedia,
  whatsappReference,
  type ConnectorCredentials,
  type WhatsappHttp,
} from '@archivage/connectors';
import type { DiskFileStore } from '@archivage/storage';
import {
  GED_CONNECTOR_LIMITS,
  GED_WHATSAPP_CONNECTOR_TYPE,
  GED_WHATSAPP_JOB,
  GedSourceConnectorStatus,
  GedSourceItemState,
  type GedWhatsappInboundJobData,
  type GedWhatsappItemMetadata,
  type GedWhatsappRefuseJobData,
} from '@archivage/types';
import { logger } from '../../logger';
import { ingestExternalFile } from '../ingestion';
import { createAiEnqueuer, type AiQueueLike } from './ai-trigger';
import { createPrismaSyncStore } from './prisma-store';
import type { SyncLogger } from './sync-engine';
import {
  WHATSAPP_OUTBOUND_LIMITS,
  createMemoryRateLimiter,
  type RateLimiter,
  type WhatsappOutboundLimits,
} from './whatsapp-rate-limit';

type WhatsappPrisma = Pick<
  PrismaClient,
  | 'gedSourceConnector'
  | 'gedSourceItem'
  | 'gedSourceSyncRun'
  | 'gedAiSetting'
  | 'fileType'
  | 'document'
  | 'documentVersion'
  | '$transaction'
>;

export interface WhatsappProcessorDeps {
  prisma: WhatsappPrisma;
  fileStore: Pick<DiskFileStore, 'write'>;
  archivesPath: string;
  /** File du pipeline IA ; `null` = pas de file (tests, ou IA non câblée). */
  aiQueue: AiQueueLike | null;
  /** Défaut : `process.env`. Lu pour GED_CONNECTOR_KEY* et les références d'identifiants. */
  env?: NodeJS.ProcessEnv;
  /** Transport HTTPS vers Graph. Défaut : `createDefaultWhatsappHttp()` (jamais de réseau en test). */
  http?: WhatsappHttp;
  /** Défaut : limiteur en mémoire. En production : Redis (voir `index.ts`). */
  rateLimiter?: RateLimiter;
  limits?: Partial<WhatsappOutboundLimits>;
  now?: () => Date;
  log?: SyncLogger;
}

/** Contexte de tentative BullMQ (dernière tentative = l'échec devient définitif). */
export interface WhatsappAttemptContext {
  finalAttempt?: boolean;
}

export type WhatsappInboundOutcome =
  | 'copied'
  | 'duplicate'
  | 'rejected'
  | 'unauthorized'
  | 'no_grant'
  | 'auth_error'
  | 'setup_error'
  | 'failed';

export type WhatsappInboundResult =
  | { outcome: WhatsappInboundOutcome; documentId?: number; ackSent?: boolean }
  | {
      skipped:
        | 'unknown_connector'
        | 'wrong_type'
        | 'inactive'
        | 'unknown_item'
        | 'already_processed';
    };

export type WhatsappRefuseResult =
  | { sent: boolean; reason?: 'rate_limited' | 'send_failed' | 'disabled' }
  | { skipped: 'unknown_connector' | 'wrong_type' | 'inactive' | 'setup_error' | 'invalid_data' };

const S = GedSourceItemState;

/**
 * Extensions refusées pour les documents reçus par WhatsApp, en plus des bornes communes des
 * connecteurs : une page HTML reçue d'un tiers peut contenir du code actif (script, formulaire)
 * qui s'exécuterait à l'ouverture dans le navigateur d'un lecteur.
 */
export const WHATSAPP_EXCLUDED_EXTENSIONS: readonly string[] = Object.freeze(['.html', '.htm']);
const MAX_MESSAGE_CHARS = 2000;

const GENERIC = {
  config: 'configuration du connecteur illisible : document non créé',
  credentials: 'identifiants du connecteur illisibles : document non créé',
  metadata: 'données du message illisibles : document non créé',
  unauthorized: 'expéditeur non autorisé : document non créé',
  retriesExhausted: 'traitement impossible après plusieurs tentatives : document non créé',
  unexpected: 'erreur de traitement : document non créé',
} as const;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/** Variables lues pour les identifiants : le strict nécessaire (clés, `GED_CONNECTOR_SECRET_*`), jamais JWT_SECRET… */
function connectorEnv(env: NodeJS.ProcessEnv, archivesPath: string): NodeJS.ProcessEnv {
  return {
    GED_CONNECTOR_KEY: env.GED_CONNECTOR_KEY,
    GED_CONNECTOR_KEY_ID: env.GED_CONNECTOR_KEY_ID,
    GED_CONNECTOR_KEY_PREVIOUS: env.GED_CONNECTOR_KEY_PREVIOUS,
    ARCHIVES_PATH: archivesPath,
    // Références d'identifiants : uniquement les variables `GED_CONNECTOR_SECRET_*`.
    ...Object.fromEntries(
      Object.entries(env).filter(([k]) => k.startsWith('GED_CONNECTOR_SECRET_')),
    ),
  };
}

interface ConnectorRecord {
  gedSourceConnectorId: number;
  connectorType: string;
  status: number;
  config: unknown;
  credentialsEnc: string | null;
  credentialsKeyId: string | null;
  credentialsRef: string | null;
  targetDossierId: number | null;
  isActive: boolean;
}

interface ItemRecord {
  gedSourceItemId: bigint;
  connectorId: number;
  state: number;
  documentId: number | null;
  originMetadata: unknown;
}

function resolveCredentials(record: ConnectorRecord, env: NodeJS.ProcessEnv): ConnectorCredentials {
  if (record.credentialsEnc) {
    if (env.GED_CONNECTOR_KEY == null || env.GED_CONNECTOR_KEY.trim() === '') {
      throw new Error('GED_CONNECTOR_KEY absente : identifiants chiffrés illisibles');
    }
    return decryptCredentials(record.credentialsEnc, record.credentialsKeyId, loadKeyRing(env));
  }
  if (record.credentialsRef) return resolveCredentialsRef(record.credentialsRef, env);
  return {};
}

function wellFormedCredentials(c: ConnectorCredentials): boolean {
  return (
    typeof c.accessToken === 'string' &&
    c.accessToken !== '' &&
    typeof c.appSecret === 'string' &&
    c.appSecret !== ''
  );
}

function safeText(err: unknown, secrets: ConnectorCredentials): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, secrets).slice(0, MAX_MESSAGE_CHARS);
}

const metadataSchema = z.object({
  messageType: z.enum(['document', 'image']),
  mediaId: z.string().regex(/^[0-9]{1,30}$/),
  mimeType: z.string().max(200).optional(),
  declaredFilename: z.string().max(2000).optional(),
  declaredSha256: z.string().max(200).optional(),
  senderPhone: z.string().max(40),
  senderHash: z.string().regex(/^[0-9a-f]{16}$/),
  messageTimestamp: z.number(),
  receivedAt: z.string(),
});

const inboundDataSchema = z.object({
  connectorId: z.number().int().positive(),
  itemId: z.string().regex(/^[0-9]{1,18}$/),
});

const refuseDataSchema = z.object({
  connectorId: z.number().int().positive(),
  to: z.string(),
  reason: z.enum(['unknown_sender', 'unsupported_type']),
});

function resolveLimitsConfig(deps: WhatsappProcessorDeps): WhatsappOutboundLimits {
  return { ...WHATSAPP_OUTBOUND_LIMITS, ...deps.limits };
}

/**
 * Envoi « au mieux » : un message sortant ne fait JAMAIS échouer le traitement. Limite par
 * expéditeur puis par connecteur ; toute erreur (Redis, Graph) est journalisée sans numéro.
 */
async function sendBestEffort(args: {
  client: WhatsappGraphClient;
  limiter: RateLimiter;
  log: SyncLogger;
  connectorId: number;
  senderHash: string;
  phone: string;
  text: string;
  kind: 'ack' | 'rejected' | 'refuse';
  senderLimit: { limit: number; windowSeconds: number };
  connectorLimit: number;
  secrets: ConnectorCredentials;
  itemId?: bigint;
}): Promise<{ sent: boolean; reason?: 'rate_limited' | 'send_failed' }> {
  const { log, connectorId, senderHash, kind } = args;
  const base = { connectorId, senderHash, kind, ...(args.itemId ? { itemId: String(args.itemId) } : {}) };
  try {
    const senderKey = `${kind === 'refuse' ? 'refuse' : 'ack'}:s:${connectorId}:${senderHash}`;
    const okSender = await args.limiter.take(
      senderKey,
      args.senderLimit.limit,
      args.senderLimit.windowSeconds,
    );
    const okConnector =
      okSender && (await args.limiter.take(`out:c:${connectorId}`, args.connectorLimit, 60));
    if (!okSender || !okConnector) {
      log.warn({ ...base, scope: okSender ? 'connector' : 'sender' }, 'message WhatsApp non envoyé : limite atteinte');
      return { sent: false, reason: 'rate_limited' };
    }
    await args.client.sendText(args.phone, args.text);
    return { sent: true };
  } catch (err) {
    log.warn(
      { ...base, err: safeText(err, { ...args.secrets, phone: args.phone }) },
      'message WhatsApp non envoyé : échec d’envoi',
    );
    return { sent: false, reason: 'send_failed' };
  }
}

function makeClient(
  settings: { phoneNumberId: string; graphApiVersion?: string | undefined },
  credentials: ConnectorCredentials,
  maxMediaBytes: number,
  deps: WhatsappProcessorDeps,
): WhatsappGraphClient {
  return new WhatsappGraphClient({
    http: deps.http ?? createDefaultWhatsappHttp(),
    accessToken: credentials.accessToken as string,
    phoneNumberId: settings.phoneNumberId,
    ...(settings.graphApiVersion ? { apiVersion: settings.graphApiVersion } : {}),
    maxMediaBytes,
    ...(deps.now ? { now: deps.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// Job `inbound`
// ---------------------------------------------------------------------------

export async function runWhatsappInbound(
  data: GedWhatsappInboundJobData,
  deps: WhatsappProcessorDeps,
  attempt: WhatsappAttemptContext = {},
): Promise<WhatsappInboundResult> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const limiter = deps.rateLimiter ?? (deps.rateLimiter = createMemoryRateLimiter());
  const outLimits = resolveLimitsConfig(deps);

  const parsedData = inboundDataSchema.safeParse(data);
  if (!parsedData.success) throw new Error('données du job WhatsApp invalides');
  const { connectorId } = parsedData.data;
  const itemId = BigInt(parsedData.data.itemId);

  // 1. Connecteur puis élément.
  const record = (await deps.prisma.gedSourceConnector.findUnique({
    where: { gedSourceConnectorId: connectorId },
  })) as ConnectorRecord | null;
  if (!record) {
    log.warn({ connectorId }, 'WhatsApp : connecteur introuvable, job ignoré');
    return { skipped: 'unknown_connector' };
  }
  if (record.connectorType !== GED_WHATSAPP_CONNECTOR_TYPE) {
    log.warn({ connectorId }, 'WhatsApp : le connecteur n’est pas de type whatsapp, job ignoré');
    return { skipped: 'wrong_type' };
  }
  if (!record.isActive || record.status === GedSourceConnectorStatus.Inactif) {
    log.info({ connectorId, itemId: String(itemId) }, 'WhatsApp : connecteur inactif, message non traité');
    return { skipped: 'inactive' };
  }

  const item = (await deps.prisma.gedSourceItem.findUnique({
    where: { gedSourceItemId: itemId },
  })) as ItemRecord | null;
  if (!item || item.connectorId !== connectorId) {
    log.warn({ connectorId, itemId: String(itemId) }, 'WhatsApp : élément introuvable pour ce connecteur');
    return { skipped: 'unknown_item' };
  }
  // Seul un élément « Découvert » est traité : un rejeu ne re-télécharge ni ne recrée rien.
  if (item.state !== S.Decouvert) {
    log.info({ connectorId, itemId: String(itemId), state: item.state }, 'WhatsApp : élément déjà traité');
    return { skipped: 'already_processed' };
  }

  let credentials: ConnectorCredentials = {};
  const markError = async (message: string): Promise<void> => {
    await deps.prisma.gedSourceItem.update({
      where: { gedSourceItemId: itemId },
      data: {
        state: S.Erreur,
        errorMessage: redactSecrets(message, credentials).slice(0, MAX_MESSAGE_CHARS),
        lastSeenAt: now(),
      },
    });
  };
  const known: { senderHash?: string } = {};
  const logBase = () => ({ connectorId, itemId: String(itemId), ...known });

  // 2. Identifiants, configuration, métadonnées.
  try {
    credentials = resolveCredentials(record, connectorEnv(env, deps.archivesPath));
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), credentials);
    await markError(GENERIC.credentials);
    await deps.prisma.gedSourceConnector.update({
      where: { gedSourceConnectorId: connectorId },
      data: { status: GedSourceConnectorStatus.Erreur, lastError: message.slice(0, MAX_MESSAGE_CHARS), lastSyncAt: now() },
    });
    log.error(logBase(), 'WhatsApp : identifiants du connecteur illisibles');
    return { outcome: 'setup_error' };
  }
  if (!wellFormedCredentials(credentials)) {
    await markError(GENERIC.credentials);
    log.error(logBase(), 'WhatsApp : identifiants du connecteur incomplets');
    return { outcome: 'setup_error' };
  }

  let parsedConfig: ReturnType<typeof parseWhatsappStoredConfig>;
  try {
    parsedConfig = parseWhatsappStoredConfig(record.config);
  } catch {
    await markError(GENERIC.config);
    log.error(logBase(), 'WhatsApp : configuration du connecteur illisible');
    return { outcome: 'setup_error' };
  }
  const { settings, rights } = parsedConfig;

  const metaParsed = metadataSchema.safeParse(item.originMetadata);
  if (!metaParsed.success) {
    await markError(GENERIC.metadata);
    log.warn(logBase(), 'WhatsApp : métadonnées du message illisibles');
    return { outcome: 'failed' };
  }
  const meta: GedWhatsappItemMetadata = metaParsed.data;
  known.senderHash = meta.senderHash;
  const phone = normalizePhone(meta.senderPhone);
  if (phone === null) {
    await markError(GENERIC.metadata);
    log.warn(logBase(), 'WhatsApp : numéro de l’expéditeur illisible');
    return { outcome: 'failed' };
  }
  // Numéro et nom de fichier ne sont jamais journalisés ; le numéro est aussi masqué dans les erreurs.
  const secrets: ConnectorCredentials = { ...credentials, senderPhone: phone };

  // 3. Liste blanche RELUE au moment du traitement.
  const sender = resolveWhatsappSender(settings, phone);
  if (!sender.allowed) {
    await markError(GENERIC.unauthorized);
    log.warn(logBase(), 'WhatsApp : expéditeur retiré de la liste blanche, message non ingéré');
    return { outcome: 'unauthorized' };
  }

  const limits = resolveLimits({ maxFileBytes: settings.maxFileBytes });
  const maxBytes = Math.min(limits.maxFileBytes, GED_CONNECTOR_LIMITS.maxFileBytes);

  let client: WhatsappGraphClient | undefined;
  const sendAfter = async (kind: 'ack' | 'rejected', text: string): Promise<boolean> => {
    if (!settings.ackEnabled || !client) return false;
    const res = await sendBestEffort({
      client,
      limiter,
      log,
      connectorId,
      senderHash: meta.senderHash,
      phone,
      text,
      kind,
      senderLimit: { limit: outLimits.ackPerSenderPerHour, windowSeconds: 3600 },
      connectorLimit: outLimits.perConnectorPerMinute,
      secrets,
      itemId,
    });
    return res.sent;
  };

  try {
    client = makeClient(settings, credentials, maxBytes, deps);

    // Élément déjà rattaché à un document (arrêt avant la mise à jour finale) : pas de 2e document.
    if (item.documentId != null) {
      await deps.prisma.gedSourceItem.update({
        where: { gedSourceItemId: itemId },
        data: { state: S.Copie, errorMessage: null, lastSeenAt: now() },
      });
      const ackSent = await sendAfter('ack', buildAckMessage(whatsappReference(itemId)));
      log.info({ ...logBase(), state: S.Copie }, 'WhatsApp : document déjà créé, élément finalisé');
      return { outcome: 'copied', documentId: item.documentId, ackSent };
    }

    // 4. Droits d'abord : sans groupe applicable (RightsWideningError), aucun appel Graph ni
    // téléchargement, élément En erreur.
    const { grants } = resolveWhatsappGrants({ phone, rights });

    // 5. Téléchargement et contrôle du contenu.
    const info = await client.getMediaInfo(meta.mediaId);
    const bytes = await client.downloadMedia(info);
    const fileName = sanitizeWhatsappFileName(meta.declaredFilename, {
      mimeType: info.mimeType || meta.mimeType,
      messageType: meta.messageType,
      now: now(),
    });
    const validated = validateWhatsappMedia({
      bytes,
      fileName,
      mimeType: info.mimeType || meta.mimeType,
      maxBytes,
      allowedExtensions: limits.allowedExtensions.filter(
        (e) => !WHATSAPP_EXCLUDED_EXTENSIONS.includes(e.toLowerCase()),
      ),
      declaredSha256: info.sha256 ?? meta.declaredSha256,
    });
    const common = {
      name: validated.fileName,
      mimeType: validated.mimeType,
      byteLength: BigInt(bytes.length),
      contentHash: validated.sha256,
      remoteVersion: validated.sha256,
      errorMessage: null,
      lastSeenAt: now(),
    };

    // 6. Dédoublonnage par empreinte.
    const store = createPrismaSyncStore(deps.prisma);
    const original = await store.findDuplicateOriginal(validated.sha256, itemId);
    if (original) {
      await deps.prisma.gedSourceItem.update({
        where: { gedSourceItemId: itemId },
        data: { ...common, state: S.Doublon, duplicateOfId: original.id, documentId: null },
      });
      const ackSent = await sendAfter('ack', buildAckMessage(whatsappReference(itemId)));
      log.info({ ...logBase(), state: S.Doublon }, 'WhatsApp : doublon (aucun document créé)');
      return { outcome: 'duplicate', ackSent };
    }

    // 7. Ingestion avec les droits déjà résolus, exactement comme la copie du moteur 2a.
    const { documentId } = await ingestExternalFile(
      {
        bytes,
        name: validated.fileName,
        dossierId: record.targetDossierId,
        sourceItemId: itemId,
      },
      grants,
      {
        prisma: deps.prisma,
        fileStore: deps.fileStore,
        archivesPath: deps.archivesPath,
        now,
      },
    );
    await deps.prisma.gedSourceItem.update({
      where: { gedSourceItemId: itemId },
      data: {
        ...common,
        state: S.Copie,
        documentId,
        duplicateOfId: null,
        // Jamais le numéro (visible par l'API admin) : pas d'ACL d'origine pour WhatsApp.
        originAcl: Prisma.DbNull,
      },
    });
    log.info({ ...logBase(), state: S.Copie, documentId }, 'WhatsApp : document créé');

    // IA : accessoire, non bloquante.
    if (deps.aiQueue) {
      try {
        await createAiEnqueuer({ prisma: deps.prisma, queue: deps.aiQueue, env })(
          documentId,
          Number(itemId),
        );
      } catch (err) {
        log.warn({ ...logBase(), documentId, err: safeText(err, secrets) }, 'enfilage du pipeline IA impossible');
      }
    }

    // 8. Accusé de réception (référence seule : ni nom de fichier ni contenu).
    const ackSent = await sendAfter('ack', buildAckMessage(whatsappReference(itemId)));
    return { outcome: 'copied', documentId, ackSent };
  } catch (err) {
    if (err instanceof ConnectorItemRejectedError) {
      await markError(err.message);
      log.warn({ ...logBase(), state: S.Erreur }, 'WhatsApp : média refusé');
      const ackSent = await sendAfter('rejected', buildRejectedMessage());
      return { outcome: 'rejected', ackSent };
    }
    if (err instanceof RightsWideningError) {
      await markError(err.message);
      log.warn({ ...logBase(), state: S.Erreur }, 'WhatsApp : aucun droit applicable, document non créé');
      return { outcome: 'no_grant' };
    }
    if (err instanceof ConnectorAuthError) {
      const message = safeText(err, secrets);
      await deps.prisma.gedSourceConnector.update({
        where: { gedSourceConnectorId: connectorId },
        data: {
          status: err.expired
            ? GedSourceConnectorStatus.AutorisationExpiree
            : GedSourceConnectorStatus.Erreur,
          lastError: message,
          lastSyncAt: now(),
        },
      });
      await markError(message);
      log.error(logBase(), 'WhatsApp : autorisation refusée par Meta, connecteur mis en erreur');
      return { outcome: 'auth_error' };
    }
    // Transitoire (quota, réseau, base) : BullMQ relance ; à la dernière tentative, échec définitif.
    if (err instanceof ConnectorQuotaError) {
      log.warn({ ...logBase(), retryAfterMs: err.retryAfterMs }, 'WhatsApp : quota Graph atteint, nouvelle tentative');
    } else {
      log.warn({ ...logBase(), err: safeText(err, secrets) }, 'WhatsApp : erreur transitoire, nouvelle tentative');
    }
    if (attempt.finalAttempt) {
      await markError(GENERIC.retriesExhausted).catch(() => undefined);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Job `refuse`
// ---------------------------------------------------------------------------

export async function runWhatsappRefuse(
  data: GedWhatsappRefuseJobData,
  deps: WhatsappProcessorDeps,
): Promise<WhatsappRefuseResult> {
  const log = deps.log ?? logger;
  const env = deps.env ?? process.env;
  const limiter = deps.rateLimiter ?? (deps.rateLimiter = createMemoryRateLimiter());
  const outLimits = resolveLimitsConfig(deps);

  const parsed = refuseDataSchema.safeParse(data);
  const to = parsed.success ? normalizePhone(parsed.data.to) : null;
  if (!parsed.success || to === null) {
    log.warn({}, 'WhatsApp : job de refus invalide, ignoré');
    return { skipped: 'invalid_data' };
  }
  const { connectorId, reason } = parsed.data;

  const record = (await deps.prisma.gedSourceConnector.findUnique({
    where: { gedSourceConnectorId: connectorId },
  })) as ConnectorRecord | null;
  if (!record) return { skipped: 'unknown_connector' };
  if (record.connectorType !== GED_WHATSAPP_CONNECTOR_TYPE) return { skipped: 'wrong_type' };
  if (!record.isActive || record.status === GedSourceConnectorStatus.Inactif) {
    return { skipped: 'inactive' };
  }

  let credentials: ConnectorCredentials = {};
  let settings: ReturnType<typeof parseWhatsappStoredConfig>['settings'];
  try {
    credentials = resolveCredentials(record, connectorEnv(env, deps.archivesPath));
    if (!wellFormedCredentials(credentials)) throw new Error('identifiants incomplets');
    settings = parseWhatsappStoredConfig(record.config).settings;
  } catch {
    log.error({ connectorId }, 'WhatsApp : refus impossible (configuration ou identifiants illisibles)');
    return { skipped: 'setup_error' };
  }

  // Hash seulement : le numéro n'apparaît dans aucun journal.
  const senderHash = hashPhone(to, credentials.appSecret as string);
  // Silence par défaut : sans réglage explicite, un expéditeur inconnu ne reçoit aucune réponse.
  if (reason === 'unknown_sender' && !settings.refuseUnknownSenders) {
    log.info({ connectorId, senderHash }, 'WhatsApp : refus désactivé pour ce connecteur');
    return { sent: false, reason: 'disabled' };
  }

  let client: WhatsappGraphClient;
  try {
    client = makeClient(settings, credentials, GED_CONNECTOR_LIMITS.maxFileBytes, deps);
  } catch {
    log.error({ connectorId, senderHash }, 'WhatsApp : client Graph non constructible');
    return { skipped: 'setup_error' };
  }
  const res = await sendBestEffort({
    client,
    limiter,
    log,
    connectorId,
    senderHash,
    phone: to,
    text: buildRefusalMessage(reason),
    kind: 'refuse',
    senderLimit: { limit: outLimits.refusePerSenderPerHour, windowSeconds: 3600 },
    connectorLimit: outLimits.perConnectorPerMinute,
    secrets: { ...credentials, senderPhone: to },
  });
  if (res.sent) log.info({ connectorId, senderHash, reason }, 'WhatsApp : refus envoyé');
  return res.sent ? { sent: true } : { sent: false, reason: res.reason as 'rate_limited' | 'send_failed' };
}

// ---------------------------------------------------------------------------
// Processeur BullMQ
// ---------------------------------------------------------------------------

type WhatsappJob = Pick<Job<GedWhatsappInboundJobData | GedWhatsappRefuseJobData>, 'name' | 'data'> &
  Partial<Pick<Job, 'attemptsMade' | 'opts'>>;

/** Processeur BullMQ de la file `ged-whatsapp-inbound` : dispatch par nom de job. */
export function createWhatsappProcessor(
  deps: WhatsappProcessorDeps,
): (job: WhatsappJob) => Promise<unknown> {
  // Un seul limiteur pour toute la durée de vie du processeur (sinon chaque job repartirait de zéro).
  deps.rateLimiter ??= createMemoryRateLimiter();
  return async (job) => {
    if (job.name === GED_WHATSAPP_JOB.inbound) {
      const attempts = job.opts?.attempts ?? 1;
      const finalAttempt = (job.attemptsMade ?? 0) + 1 >= attempts;
      return runWhatsappInbound(job.data as GedWhatsappInboundJobData, deps, { finalAttempt });
    }
    if (job.name === GED_WHATSAPP_JOB.refuse) {
      return runWhatsappRefuse(job.data as GedWhatsappRefuseJobData, deps);
    }
    throw new Error(`job inconnu : ${job.name}`);
  };
}
