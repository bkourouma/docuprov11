// Lot 2a — moteur de synchronisation d'un connecteur de source GED.
//
// PUR et testable : aucune dépendance directe à Prisma, au disque, à Redis ni à l'horloge. Tout ce
// qui touche l'extérieur passe par `SyncDeps` ; le câblage réel est dans `sync.processor.ts` et
// `prisma-store.ts`.
//
// Trois invariants guident le code :
//  1. REPRISE EXACTE : le jeton de changement n'est persisté qu'APRÈS qu'une page a été entièrement
//     traitée. Un plantage au milieu d'une page rejoue cette page seule ; le rejeu est inoffensif
//     parce qu'un élément déjà traité (même `remoteVersion`, état réglé) n'est plus que « vu ».
//  2. AUCUNE PERTE : une suppression à la source ne supprime JAMAIS la copie DocuPro (état 4
//     seulement), et une modification à la source n'écrase pas une copie en mode copie (état 3).
//  3. DROITS : un document créé n'est jamais plus ouvert qu'à la source. Dans DocuPro un document
//     sans permission est visible par tous : sans droit transposable, on ne crée RIEN.
import { createHash } from 'node:crypto';
import {
  ConnectorAuthError,
  ConnectorQuotaError,
  ConnectorItemRejectedError,
  assertNeverWider,
  assertRestricted,
  extensionOf,
  mapOriginRights,
  redactSecrets,
  rightsConfigSchema,
  splitStoredConfig,
  type ConnectorCredentials,
  type DocuProGrant,
  type OriginAcl,
  type RemoteItem,
  type SourceConnector,
} from '@archivage/connectors';
import {
  GED_CONNECTOR_ALLOWED_EXTENSIONS,
  GED_CONNECTOR_LIMITS,
  GedSourceConnectorStatus,
  GedSourceItemState,
  GedSourceMode,
  GedSyncRunStatus,
} from '@archivage/types';

// ---------------------------------------------------------------------------
// Contrats
// ---------------------------------------------------------------------------

export interface ConnectorRow {
  id: number;
  label: string;
  mode: number;
  status: number;
  changeToken: string | null;
  targetDossierId: number | null;
  /** Configuration stockée (réglages + clé réservée `rights`). */
  config: unknown;
}

export interface ItemRow {
  id: bigint;
  externalId: string;
  state: number;
  documentId: number | null;
  contentHash: string | null;
  remoteVersion: string | null;
  duplicateOfId: bigint | null;
}

/** Provenance écrite à chaque passage. `originAcl` absent = laissé tel quel. */
export interface ItemProvenance {
  name: string;
  originUrl: string | null;
  originPath: string | null;
  mimeType: string | null;
  byteLength: number | null;
  originAuthor: string | null;
  originCreatedAt: Date | null;
  originModifiedAt: Date | null;
  originAcl?: unknown;
  originMetadata: Record<string, unknown> | null;
}

export interface ItemPatch {
  state?: number;
  documentId?: number | null;
  contentHash?: string | null;
  duplicateOfId?: bigint | null;
  errorMessage?: string | null;
  remoteVersion?: string | null;
  indexedAt?: Date | null;
  originMetadata?: Record<string, unknown> | null;
  lastSeenAt?: Date;
}

export interface RunCounters {
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsDeleted: number;
  itemsDuplicate: number;
  itemsFailed: number;
}

export interface RunPatch extends Partial<RunCounters> {
  status?: number;
  finishedAt?: Date;
  changeTokenAfter?: string | null;
  errorMessage?: string | null;
}

export interface ConnectorPatch {
  status?: number;
  lastSyncAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string | null;
}

/** Accès à la base, réduit à ce dont le moteur a besoin (simulable en mémoire). */
export interface SyncStore {
  findOpenRuns(connectorId: number): Promise<Array<{ id: bigint; startedAt: Date }>>;
  createRun(connectorId: number, startedAt: Date, tokenBefore: string | null): Promise<bigint>;
  /** Retire une passe qui n'a rien fait (perdante de l'arbitrage d'ouverture) : pas d'historique parasite. */
  deleteRun(runId: bigint): Promise<void>;
  updateRun(runId: bigint, patch: RunPatch): Promise<void>;
  setChangeToken(connectorId: number, token: string): Promise<void>;
  updateConnector(connectorId: number, patch: ConnectorPatch): Promise<void>;
  findItem(connectorId: number, externalId: string): Promise<ItemRow | null>;
  upsertItem(
    connectorId: number,
    externalId: string,
    provenance: ItemProvenance,
    now: Date,
  ): Promise<ItemRow>;
  touchItem(itemId: bigint, now: Date): Promise<void>;
  updateItem(itemId: bigint, patch: ItemPatch): Promise<void>;
  /**
   * Original d'un contenu : élément (n'importe quel connecteur) de même empreinte, copié ou indexé
   * en place, le plus ancien (`firstSeenAt`, puis id). Jamais un doublon ni un élément supprimé.
   */
  findDuplicateOriginal(contentHash: string, excludeItemId: bigint): Promise<{ id: bigint } | null>;
  /** Passe à l'état « supprimé à la source » les éléments connus (hors déjà supprimés) ; renvoie le nombre. */
  markDeleted(connectorId: number, externalIds: string[]): Promise<number>;
  /** Éléments connus d'états donnés, par id croissant, strictement après `afterId`. */
  listKnownItems(
    connectorId: number,
    states: number[],
    afterId: bigint | null,
    limit: number,
  ): Promise<Array<{ id: bigint; externalId: string }>>;
}

export interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface SyncIngest {
  createDocument(
    input: {
      bytes: Buffer;
      name: string;
      dossierId: number | null;
      /** Élément rattaché au document DANS la même écriture (idempotence au rejeu). */
      sourceItemId?: bigint;
    },
    grants: DocuProGrant[],
  ): Promise<{ documentId: number }>;
  addVersion(
    documentId: number,
    input: { bytes: Buffer; name: string; dossierId: number | null },
  ): Promise<{ documentId: number }>;
}

export interface SyncDeps {
  store: SyncStore;
  ingest: SyncIngest;
  /** Texte d'un fichier (texte brut, HTML, PDF) ou `null`. */
  extractText(bytes: Buffer, extension: string): Promise<string | null>;
  /** Extensions dont `extractText` sait tirer du texte (indexation en place). */
  extractableExtensions: readonly string[];
  now(): Date;
  /** Enfile le pipeline IA si elle est activée (sinon ne fait rien). Peut lever : toléré. */
  enqueueAi(documentId: number, sourceItemId: number): Promise<void>;
  /** Demande une nouvelle passe dans `delayMs` (0 = immédiate). Peut lever : toléré. */
  scheduleResume(connectorId: number, delayMs: number): Promise<void>;
  log: SyncLogger;
  /** Surcharges de bornes (tests) ; défaut `GED_CONNECTOR_LIMITS`. */
  limits?: Partial<{
    pageSize: number;
    maxItemsPerRun: number;
    maxIndexedTextChars: number;
    maxFileBytes: number;
  }>;
}

export type SyncOutcome =
  | { skipped: 'already_running' }
  | {
      runId: bigint;
      status: number;
      counters: RunCounters;
      /** Délai de la reprise demandée (ms), ou `null` si aucune. */
      resumeInMs: number | null;
    };

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Une passe « en cours » plus récente que ça bloque le démarrage d'une autre. */
export const RUN_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const QUOTA_DEFAULT_RETRY_MS = 15 * 60 * 1000;
export const QUOTA_MIN_RETRY_MS = 60 * 1000;
export const QUOTA_MAX_RETRY_MS = 6 * 60 * 60 * 1000;
/** Lot de `findMissing` : borne la taille de la requête envoyée à la source. */
export const MISSING_BATCH_SIZE = 500;

export const NO_GRANT_MESSAGE =
  'droits d’origine non transposables et aucun groupe de repli : document non créé (configurer la correspondance des droits)';

const MAX_MESSAGE_CHARS = 2000;
const ALLOWED_EXTENSIONS: readonly string[] = GED_CONNECTOR_ALLOWED_EXTENSIONS;

const S = GedSourceItemState;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function clip(value: string | undefined | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Message d'erreur SANS secret : passé par `redactSecrets` avant toute écriture ou journalisation. */
function safeMessage(err: unknown, credentials: ConnectorCredentials): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, credentials).slice(0, MAX_MESSAGE_CHARS);
}

export function clampRetryMs(retryAfterMs: number | undefined): number {
  const value =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : QUOTA_DEFAULT_RETRY_MS;
  return Math.min(QUOTA_MAX_RETRY_MS, Math.max(QUOTA_MIN_RETRY_MS, value));
}

function newCounters(): RunCounters {
  return {
    itemsSeen: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    itemsDeleted: 0,
    itemsDuplicate: 0,
    itemsFailed: 0,
  };
}

type RightsContext =
  | { ok: true; principalMap: Record<string, number>; fallbackUserGroupIds: number[] }
  | { ok: false; message: string };

function loadRightsContext(config: unknown): RightsContext {
  try {
    const { rights } = splitStoredConfig(config);
    const parsed = rightsConfigSchema.safeParse(rights ?? {});
    if (!parsed.success) {
      return { ok: false, message: 'configuration des droits invalide : document non créé' };
    }
    return {
      ok: true,
      principalMap: parsed.data.principalMap,
      fallbackUserGroupIds: parsed.data.fallbackUserGroupIds,
    };
  } catch {
    return { ok: false, message: 'configuration du connecteur illisible : document non créé' };
  }
}

interface RunContext {
  row: ConnectorRow;
  connector: SourceConnector;
  credentials: ConnectorCredentials;
  deps: SyncDeps;
  counters: RunCounters;
  rights: RightsContext;
  limits: { maxFileBytes: number; maxIndexedTextChars: number };
}

function buildProvenance(remote: RemoteItem, acl: OriginAcl | null | undefined): ItemProvenance {
  const base: ItemProvenance = {
    name: clip(remote.name, 500) ?? '(sans nom)',
    originUrl: remote.originUrl ?? null,
    originPath: remote.originPath ?? null,
    mimeType: clip(remote.mimeType, 200),
    byteLength: remote.byteLength ?? null,
    originAuthor: clip(remote.originAuthor, 300),
    originCreatedAt: remote.originCreatedAt ?? null,
    originModifiedAt: remote.originModifiedAt ?? null,
    originMetadata: remote.originMetadata ?? null,
  };
  return acl === undefined ? base : { ...base, originAcl: acl };
}

function sameVersion(existing: ItemRow, remote: RemoteItem): boolean {
  return (
    existing.remoteVersion != null &&
    remote.remoteVersion != null &&
    existing.remoteVersion === remote.remoteVersion
  );
}

/** Élément à ne faire que « voir » : même version et état réglé. Les erreurs et découverts sont rejoués. */
function isSettled(existing: ItemRow, remote: RemoteItem, mode: number): boolean {
  if (!sameVersion(existing, remote)) return false;
  if (
    existing.state === S.Copie ||
    existing.state === S.IndexeEnPlace ||
    existing.state === S.Doublon
  ) {
    return true;
  }
  // « Modifié à la source » reste tel quel en mode copie ; en mode synchro il doit être resynchronisé.
  return existing.state === S.ModifieSource && mode !== GedSourceMode.Synchro;
}

// ---------------------------------------------------------------------------
// Traitement d'un élément
// ---------------------------------------------------------------------------

/** Droits ACL lus ; une erreur non fatale vaut « illisibles » (le mapping retombe sur le plus restrictif). */
async function readAcl(ctx: RunContext, remote: RemoteItem): Promise<OriginAcl | null> {
  try {
    return await ctx.connector.readOriginAcl(remote);
  } catch (err) {
    if (err instanceof ConnectorAuthError || err instanceof ConnectorQuotaError) throw err;
    ctx.deps.log.warn(
      { connectorId: ctx.row.id, externalId: remote.externalId },
      'droits d’origine illisibles : repli sur le plus restrictif',
    );
    return null;
  }
}

interface Downloaded {
  bytes: Buffer;
  name: string;
  extension: string;
  hash: string;
}

async function download(ctx: RunContext, remote: RemoteItem): Promise<Downloaded> {
  const fetched = await ctx.connector.fetchFile(remote);
  const name = fetched.name ?? remote.name;
  const extension = extensionOf(name);
  // Redondant avec le connecteur, volontairement : le moteur ne doit pas dépendre de la discipline
  // de chaque connecteur pour refuser un type ou une taille hors bornes.
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    throw new ConnectorItemRejectedError(
      `type de fichier non accepté (${extension === '' ? 'sans extension' : extension})`,
    );
  }
  if (fetched.bytes.length > ctx.limits.maxFileBytes) {
    throw new ConnectorItemRejectedError('fichier trop volumineux');
  }
  return { bytes: fetched.bytes, name, extension, hash: sha256(fetched.bytes) };
}

/**
 * Droits du futur document : le plus restrictif des droits d'origine mappables, jamais plus ouverts.
 * Aucun groupe = on ne crée PAS le document (un document sans droit est visible par tous).
 */
function computeGrants(ctx: RunContext, acl: OriginAcl | null): DocuProGrant[] {
  if (!ctx.rights.ok) throw new ConnectorItemRejectedError(ctx.rights.message);
  const input = {
    acl,
    principalMap: ctx.rights.principalMap,
    fallbackUserGroupIds: ctx.rights.fallbackUserGroupIds,
  };
  const result = mapOriginRights(input);
  if (result.grants.length === 0) throw new ConnectorItemRejectedError(NO_GRANT_MESSAGE);
  // Garde-fous indépendants du mapping, juste avant l'écriture des droits.
  assertNeverWider(input, result);
  assertRestricted(result);
  ctx.deps.log.info(
    {
      connectorId: ctx.row.id,
      groups: result.grants.length,
      unmapped: result.unmapped.length,
      usedFallback: result.usedFallback,
    },
    'droits d’origine transposés',
  );
  return result.grants;
}

async function triggerAi(ctx: RunContext, documentId: number, itemId: bigint): Promise<void> {
  try {
    await ctx.deps.enqueueAi(documentId, Number(itemId));
  } catch (err) {
    // L'IA est accessoire : le document est déjà ingéré, on ne le fait pas échouer.
    ctx.deps.log.warn(
      { connectorId: ctx.row.id, documentId, err: safeMessage(err, ctx.credentials) },
      'enfilage du pipeline IA impossible',
    );
  }
}

/** Pose l'état « doublon » : aucun document, l'élément pointe vers l'original. */
async function markDuplicate(
  ctx: RunContext,
  item: ItemRow,
  remote: RemoteItem,
  hash: string,
  originalId: bigint,
): Promise<void> {
  await ctx.deps.store.updateItem(item.id, {
    state: S.Doublon,
    contentHash: hash,
    duplicateOfId: originalId,
    documentId: null,
    errorMessage: null,
    remoteVersion: remote.remoteVersion ?? null,
  });
  ctx.counters.itemsDuplicate++;
}

/** Mode copie / synchro, élément sans document : télécharge, dédoublonne, contrôle les droits, ingère. */
async function createFromSource(
  ctx: RunContext,
  remote: RemoteItem,
  item: ItemRow,
  acl: OriginAcl | null,
): Promise<void> {
  const { store, ingest } = ctx.deps;
  const file = await download(ctx, remote);

  const original = await store.findDuplicateOriginal(file.hash, item.id);
  if (original) {
    await markDuplicate(ctx, item, remote, file.hash, original.id);
    return;
  }

  const grants = computeGrants(ctx, acl);
  const { documentId } = await ingest.createDocument(
    {
      bytes: file.bytes,
      name: file.name,
      dossierId: ctx.row.targetDossierId,
      // Le document naît DÉJÀ rattaché à l'élément : un arrêt avant la mise à jour ci-dessous ne
      // laisse plus d'orphelin, le rejeu l'adopte (voir `adoptOrphanDocument`).
      sourceItemId: item.id,
    },
    grants,
  );
  await store.updateItem(item.id, {
    state: S.Copie,
    documentId,
    contentHash: file.hash,
    duplicateOfId: null,
    errorMessage: null,
    remoteVersion: remote.remoteVersion ?? null,
  });
  ctx.counters.itemsCreated++;
  await triggerAi(ctx, documentId, item.id);
}

/**
 * Élément déjà rattaché à un document mais jamais finalisé : le worker s'est arrêté (ou l'écriture
 * suivante a échoué) entre la création du document et la mise à jour de l'élément. On ADOPTE ce
 * document au lieu d'en créer un second. Le contenu est repassé par `addVersion`, idempotent : il ne
 * crée une version que si la source a changé depuis, et réécrit sinon les octets éventuellement
 * manquants sur le coffre.
 */
function isOrphanDocument(item: ItemRow): boolean {
  return (
    item.documentId != null &&
    item.contentHash == null &&
    (item.state === S.Decouvert || item.state === S.Erreur)
  );
}

async function adoptOrphanDocument(
  ctx: RunContext,
  remote: RemoteItem,
  item: ItemRow,
): Promise<void> {
  const { store, ingest } = ctx.deps;
  const documentId = item.documentId!;
  const file = await download(ctx, remote);
  await ingest.addVersion(documentId, {
    bytes: file.bytes,
    name: file.name,
    dossierId: ctx.row.targetDossierId,
  });
  await store.updateItem(item.id, {
    state: S.Copie,
    contentHash: file.hash,
    duplicateOfId: null,
    errorMessage: null,
    remoteVersion: remote.remoteVersion ?? null,
  });
  ctx.counters.itemsCreated++;
  await triggerAi(ctx, documentId, item.id);
}

/** Mode synchro, élément déjà copié et modifié : nouvelle version si le contenu a réellement changé. */
async function resyncCopied(ctx: RunContext, remote: RemoteItem, item: ItemRow): Promise<void> {
  const { store, ingest } = ctx.deps;
  const documentId = item.documentId!;
  const file = await download(ctx, remote);

  if (file.hash === item.contentHash) {
    // Même contenu (ex. simple changement de date) : on ne versionne pas, la provenance suffit.
    await store.updateItem(item.id, {
      state: S.Copie,
      errorMessage: null,
      remoteVersion: remote.remoteVersion ?? null,
    });
    return;
  }
  await ingest.addVersion(documentId, {
    bytes: file.bytes,
    name: file.name,
    dossierId: ctx.row.targetDossierId,
  });
  await store.updateItem(item.id, {
    state: S.Copie,
    contentHash: file.hash,
    errorMessage: null,
    remoteVersion: remote.remoteVersion ?? null,
  });
  ctx.counters.itemsUpdated++;
  await triggerAi(ctx, documentId, item.id);
}

/**
 * Mode indexation en place : le binaire n'est JAMAIS écrit et aucun Document n'est créé. On ne garde
 * que le texte indexé (borné), dans `origin_metadata.indexedText`.
 */
async function indexInPlace(
  ctx: RunContext,
  remote: RemoteItem,
  item: ItemRow,
  isNew: boolean,
): Promise<void> {
  const { store, deps } = { store: ctx.deps.store, deps: ctx.deps };
  const extension = extensionOf(remote.name);
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    throw new ConnectorItemRejectedError(
      `type de fichier non accepté (${extension === '' ? 'sans extension' : extension})`,
    );
  }

  let hash: string | null = null;
  let text: string | null = null;
  // On ne lit le contenu que s'il peut produire du texte : les autres types restent indexés par
  // leurs seules métadonnées plutôt que d'être téléchargés pour rien.
  if (deps.extractableExtensions.includes(extension)) {
    const file = await download(ctx, remote);
    hash = file.hash;
    const original = await store.findDuplicateOriginal(file.hash, item.id);
    if (original) {
      await markDuplicate(ctx, item, remote, file.hash, original.id);
      return;
    }
    text = await deps.extractText(file.bytes, file.extension);
  }

  const max = ctx.limits.maxIndexedTextChars;
  const metadata: Record<string, unknown> = { ...(remote.originMetadata ?? {}) };
  if (text != null && text.length > 0) {
    metadata.indexedText = text.slice(0, max);
    metadata.indexedTextTruncated = text.length > max;
  }
  await store.updateItem(item.id, {
    state: S.IndexeEnPlace,
    contentHash: hash,
    indexedAt: deps.now(),
    originMetadata: metadata,
    documentId: null,
    duplicateOfId: null,
    errorMessage: null,
    remoteVersion: remote.remoteVersion ?? null,
  });
  if (isNew) ctx.counters.itemsCreated++;
  else ctx.counters.itemsUpdated++;
}

async function processItem(ctx: RunContext, remote: RemoteItem): Promise<void> {
  const { store, now } = { store: ctx.deps.store, now: ctx.deps.now() };
  const mode = ctx.row.mode;
  const existing = await store.findItem(ctx.row.id, remote.externalId);

  if (existing && isSettled(existing, remote, mode)) {
    await store.touchItem(existing.id, now);
    return;
  }
  if (existing && existing.state === S.SupprimeSource && sameVersion(existing, remote)) {
    // Réapparu sans changement : retour à l'état normal que son historique indique.
    const restored =
      existing.documentId != null
        ? S.Copie
        : existing.duplicateOfId != null
          ? S.Doublon
          : existing.contentHash != null && mode === GedSourceMode.IndexationEnPlace
            ? S.IndexeEnPlace
            : null;
    if (restored !== null) {
      await store.updateItem(existing.id, { state: restored, lastSeenAt: now, errorMessage: null });
      return;
    }
  }

  const acl = await readAcl(ctx, remote);
  const item = await store.upsertItem(
    ctx.row.id,
    remote.externalId,
    buildProvenance(remote, acl),
    now,
  );

  if (mode === GedSourceMode.IndexationEnPlace) {
    await indexInPlace(ctx, remote, item, existing == null);
    return;
  }
  if (isOrphanDocument(item)) {
    await adoptOrphanDocument(ctx, remote, item);
    return;
  }
  if (item.documentId != null) {
    if (mode === GedSourceMode.Synchro) {
      await resyncCopied(ctx, remote, item);
    } else {
      // Mode copie : la copie DocuPro n'est PAS écrasée, on signale seulement le changement.
      await store.updateItem(item.id, {
        state: S.ModifieSource,
        errorMessage: null,
        remoteVersion: remote.remoteVersion ?? null,
      });
    }
    return;
  }
  await createFromSource(ctx, remote, item, acl);
}

/** Erreur sur UN élément : il passe « en erreur », la passe continue. Auth et quota remontent. */
async function handleItem(ctx: RunContext, remote: RemoteItem): Promise<void> {
  try {
    await processItem(ctx, remote);
  } catch (err) {
    if (err instanceof ConnectorAuthError || err instanceof ConnectorQuotaError) throw err;
    ctx.counters.itemsFailed++;
    const message = safeMessage(err, ctx.credentials);
    ctx.deps.log.warn(
      { connectorId: ctx.row.id, externalId: remote.externalId, message },
      'élément en erreur',
    );
    try {
      const item = await ctx.deps.store.upsertItem(
        ctx.row.id,
        remote.externalId,
        buildProvenance(remote, undefined),
        ctx.deps.now(),
      );
      await ctx.deps.store.updateItem(item.id, { state: S.Erreur, errorMessage: message });
    } catch (writeErr) {
      // Identifiant démesuré, base indisponible… : on ne peut pas tracer l'élément, pas plus.
      ctx.deps.log.error(
        { connectorId: ctx.row.id, err: safeMessage(writeErr, ctx.credentials) },
        'état d’erreur de l’élément non enregistré',
      );
    }
  }
}

/** `findMissing` sur les éléments connus d'état copié / indexé / modifié, par lots. */
async function detectMissing(ctx: RunContext): Promise<void> {
  const { store } = ctx.deps;
  const connector = ctx.connector;
  if (!connector.findMissing) return;
  let after: bigint | null = null;
  for (;;) {
    const batch = await store.listKnownItems(
      ctx.row.id,
      [S.Copie, S.IndexeEnPlace, S.ModifieSource],
      after,
      MISSING_BATCH_SIZE,
    );
    if (batch.length === 0) return;
    after = batch[batch.length - 1]!.id;
    const known = new Set(batch.map((b) => b.externalId));
    const missing = (await connector.findMissing(batch.map((b) => b.externalId))).filter((id) =>
      known.has(id),
    );
    if (missing.length > 0) {
      ctx.counters.itemsDeleted += await store.markDeleted(ctx.row.id, missing);
    }
    if (batch.length < MISSING_BATCH_SIZE) return;
  }
}

// ---------------------------------------------------------------------------
// Passe
// ---------------------------------------------------------------------------

export interface RunSyncInput {
  row: ConnectorRow;
  connector: SourceConnector;
  /** Identifiants déchiffrés : servent UNIQUEMENT à masquer les secrets dans les messages. */
  credentials: ConnectorCredentials;
}

/**
 * Une passe d'un connecteur. Anti-concurrence en deux temps, SANS verrou en base (aucun champ
 * dédié dans le schéma) : (1) refus si une passe récente est déjà ouverte ; (2) après création de sa
 * propre passe, arbitrage : la passe d'identifiant le plus petit continue, les autres se retirent.
 * LIMITE CONNUE : deux transactions d'insertion validées dans l'ordre inverse de leurs identifiants,
 * et dont la relecture a lieu avant la validation de l'autre, peuvent encore laisser deux passes
 * actives (fenêtre de quelques millisecondes). Les conséquences sont bornées : le rejeu d'un
 * élément est idempotent (document adopté, version non dupliquée) et le jeton de reprise ne
 * progresse qu'après une page entière. Un vrai verrou exigerait une colonne ou un verrou
 * consultatif Postgres (hors périmètre de ce lot).
 */
export async function runConnectorSync(input: RunSyncInput, deps: SyncDeps): Promise<SyncOutcome> {
  const { row, connector, credentials } = input;
  const { store, log } = deps;
  const startedAt = deps.now();

  // Anti-concurrence : une passe « en cours » récente bloque ; une plus ancienne est une passe
  // morte (worker arrêté en plein travail), fermée comme échouée pour ne pas bloquer à vie.
  const open = await store.findOpenRuns(row.id);
  if (open.some((r) => startedAt.getTime() - r.startedAt.getTime() < RUN_STALE_AFTER_MS)) {
    log.info({ connectorId: row.id }, 'synchronisation ignorée : une passe est déjà en cours');
    return { skipped: 'already_running' };
  }
  for (const stale of open) {
    await store.updateRun(stale.id, {
      status: GedSyncRunStatus.Echouee,
      finishedAt: startedAt,
      errorMessage: 'passe abandonnée (en cours depuis plus de 2 h) : fermée comme échouée',
    });
  }

  const limits = {
    pageSize: deps.limits?.pageSize ?? GED_CONNECTOR_LIMITS.pageSize,
    maxItemsPerRun: deps.limits?.maxItemsPerRun ?? GED_CONNECTOR_LIMITS.maxItemsPerRun,
    maxIndexedTextChars:
      deps.limits?.maxIndexedTextChars ?? GED_CONNECTOR_LIMITS.maxIndexedTextChars,
    maxFileBytes: deps.limits?.maxFileBytes ?? GED_CONNECTOR_LIMITS.maxFileBytes,
  };
  const counters = newCounters();
  const ctx: RunContext = {
    row,
    connector,
    credentials,
    deps,
    counters,
    rights: loadRightsContext(row.config),
    limits,
  };

  const runId = await store.createRun(row.id, startedAt, row.changeToken);
  // Arbitrage APRÈS création : le contrôle initial (lecture puis écriture) laisse une fenêtre où deux
  // workers voient tous deux « aucune passe » puis créent chacun la leur. On relit donc les passes
  // en cours : la plus ancienne (plus petit identifiant, croissant à l'insertion) l'emporte, les
  // autres se retirent sans rien traiter.
  const contenders = (await store.findOpenRuns(row.id)).filter(
    (r) => startedAt.getTime() - r.startedAt.getTime() < RUN_STALE_AFTER_MS,
  );
  if (contenders.some((r) => r.id < runId)) {
    await store.deleteRun(runId);
    log.info(
      { connectorId: row.id },
      'synchronisation ignorée : une passe concurrente est prioritaire',
    );
    return { skipped: 'already_running' };
  }
  let token = row.changeToken;
  let status: number = GedSyncRunStatus.Echouee;
  let runMessage: string | null = null;
  let connectorPatch: ConnectorPatch = {};
  let resumeInMs: number | null = null;

  try {
    await connector.authenticate();

    let complete = false;
    for (;;) {
      const remaining = limits.maxItemsPerRun - counters.itemsSeen;
      const page = await connector.listChanges(token, {
        pageSize: Math.max(1, Math.min(limits.pageSize, remaining)),
      });

      const deleted = new Set(page.deletedExternalIds);
      for (const remote of page.items) {
        counters.itemsSeen++;
        // Supprimé à la source dans la même fenêtre : inutile de le copier pour le marquer aussitôt.
        if (deleted.has(remote.externalId)) continue;
        await handleItem(ctx, remote);
      }
      for (let i = 0; i < page.deletedExternalIds.length; i += MISSING_BATCH_SIZE) {
        counters.itemsDeleted += await store.markDeleted(
          row.id,
          page.deletedExternalIds.slice(i, i + MISSING_BATCH_SIZE),
        );
      }

      // Page ENTIÈREMENT traitée : seulement maintenant le jeton avance (reprise exacte).
      if (page.nextToken != null) {
        if (page.hasMore && page.nextToken === token) {
          throw new Error('le jeton de changement n’avance plus : passe interrompue');
        }
        await store.setChangeToken(row.id, page.nextToken);
        token = page.nextToken;
      }
      await store.updateRun(runId, { ...counters, changeTokenAfter: token });

      if (!page.hasMore || page.nextToken == null) {
        complete = true;
        break;
      }
      if (counters.itemsSeen >= limits.maxItemsPerRun) {
        resumeInMs = 0;
        break;
      }
    }

    if (complete) {
      try {
        await detectMissing(ctx);
      } catch (err) {
        if (err instanceof ConnectorAuthError || err instanceof ConnectorQuotaError) throw err;
        runMessage = `détection des suppressions impossible : ${safeMessage(err, credentials)}`;
        counters.itemsFailed++;
      }
    }

    status = counters.itemsFailed > 0 ? GedSyncRunStatus.Partielle : GedSyncRunStatus.Reussie;
    const now = deps.now();
    connectorPatch = {
      status: GedSourceConnectorStatus.Actif,
      lastSyncAt: now,
      lastSuccessAt: now,
      lastError: null,
    };
  } catch (err) {
    const message = safeMessage(err, credentials);
    const now = deps.now();
    if (err instanceof ConnectorAuthError) {
      status = GedSyncRunStatus.Echouee;
      runMessage = message;
      connectorPatch = {
        status: err.expired
          ? GedSourceConnectorStatus.AutorisationExpiree
          : GedSourceConnectorStatus.Erreur,
        lastSyncAt: now,
        lastError: message,
      };
      resumeInMs = null;
    } else if (err instanceof ConnectorQuotaError) {
      // Le jeton de la dernière page traitée est déjà persisté : on reprend plus tard, sans rien perdre.
      resumeInMs = clampRetryMs(err.retryAfterMs);
      status = GedSyncRunStatus.Partielle;
      runMessage = `quota atteint : reprise automatique dans ${Math.round(resumeInMs / 60_000)} min`;
      connectorPatch = { lastSyncAt: now };
    } else {
      status = GedSyncRunStatus.Echouee;
      runMessage = message;
      connectorPatch = {
        status: GedSourceConnectorStatus.Erreur,
        lastSyncAt: now,
        lastError: message,
      };
      resumeInMs = null;
    }
    log.warn(
      { connectorId: row.id, runId: String(runId), status, message: runMessage },
      'passe interrompue',
    );
  } finally {
    // `finishedAt` toujours posé, même si l'écriture du connecteur échoue juste après.
    await store.updateRun(runId, {
      ...counters,
      status,
      finishedAt: deps.now(),
      changeTokenAfter: token,
      errorMessage: runMessage,
    });
  }
  await store.updateConnector(row.id, connectorPatch);

  if (resumeInMs !== null) {
    try {
      await deps.scheduleResume(row.id, resumeInMs);
    } catch (err) {
      log.warn(
        { connectorId: row.id, err: safeMessage(err, credentials) },
        'reprise de la synchronisation non planifiée',
      );
    }
  }
  log.info(
    { connectorId: row.id, runId: String(runId), status, ...counters },
    'synchronisation terminée',
  );
  return { runId, status, counters, resumeInMs };
}
