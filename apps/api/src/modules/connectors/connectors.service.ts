import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { GedSourceConnector, GedSourceItem, GedSourceSyncRun, Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import {
  buildConnector,
  ConnectorAuthError,
  ConnectorConfigError,
  ConnectorQuotaError,
  CredentialsCryptoError,
  decryptCredentials,
  encryptCredentials,
  loadKeyRing,
  needsReencryption,
  redactSecrets,
  reencryptCredentials,
  resolveCredentialsRef,
  SsrfError,
  validateConnectorInput,
  type ConnectorCredentials,
  type ConnectorDeps,
  type ConnectorRegistry,
  type KeyRing,
  type SourceConnector,
  type ValidatedConnectorInput,
} from '@archivage/connectors';
import {
  GED_CONNECTOR_JOB,
  GedSourceConnectorStatus,
  type GedConnectorSyncJobData,
  type GedConnectorTypeInfo,
  type GedConnectorView,
  type GedSourceItemState,
  type GedSourceItemView,
  type GedSourceMode,
  type GedSourceSyncRunView,
  type GedSyncRunStatus,
} from '@archivage/types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONNECTORS_DEFAULT_PAGE_SIZE,
  CONNECTORS_DEFAULT_RUNS_LIMIT,
  type CreateConnectorDto,
  type ListItemsQuery,
  type ListRunsQuery,
  type UpdateConnectorDto,
} from './connectors.dto';
import { GED_CONNECTOR_QUEUE_TOKEN } from './connectors-queue.provider';

/** Jeton d'injection du registre des types de connecteurs. */
export const GED_CONNECTOR_REGISTRY = 'GED_CONNECTOR_REGISTRY';
/** Jeton (optionnel) pour injecter environnement, dépendances et délais — utile aux tests uniquement. */
export const GED_CONNECTORS_RUNTIME = 'GED_CONNECTORS_RUNTIME';

export interface ConnectorsRuntime {
  env?: NodeJS.ProcessEnv;
  deps?: ConnectorDeps;
  /** Délai du test de connexion (défaut 20 s). */
  testTimeoutMs?: number;
}

export interface ConnectorTestResult {
  ok: boolean;
  message: string;
}

export interface GedSourceItemDetailView extends GedSourceItemView {
  duplicateOf: { id: number; name: string; connectorId: number } | null;
}

const TEST_TIMEOUT_MS = 20_000;
/** La fermeture d'un connecteur bloqué ne doit pas retenir la réponse d'un test déjà en échec. */
const CLOSE_TIMEOUT_MS = 2_000;
/** Une passe « en cours » plus ancienne est supposée morte (worker tombé) et ne bloque plus. */
const STALE_RUN_MS = 2 * 60 * 60 * 1000;
const MESSAGE_MAX = 500;
/** Réglages dont le changement invalide le jeton de changement : la source n'est plus la même. */
const SOURCE_IDENTITY_KEYS = ['rootPath', 'host', 'mailbox'] as const;

const MISSING_KEY_MESSAGE =
  'Clé de chiffrement des connecteurs absente (GED_CONNECTOR_KEY) : identifiants non enregistrables';

class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

/** Rejette avec `TimeoutError` après `ms` ; le minuteur est toujours libéré. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError());
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Nom d'acteur figé au journal (même règle que les autres modules ; copie locale pour ne pas dépendre de DocumentsService). */
const actorName = (user: AuthUser): string => user.fullName?.trim() || user.username;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Échappe les jokers LIKE (`\`, `%`, `_`) avant un `contains` / `startsWith` Prisma :
 * Prisma ne les échappe pas lui-même sous PostgreSQL, et `\` est l'échappement par défaut de LIKE.
 */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Administration des connecteurs de sources GED.
 *
 * Invariants de sécurité tenus ici :
 *  - un identifiant en clair n'est jamais écrit en base (chiffré AES-GCM), jamais renvoyé, jamais
 *    journalisé, jamais copié dans un message d'erreur sans passer par `redactSecrets` ;
 *  - une vue est construite champ par champ (jamais `...row`), donc `credentialsEnc` ne peut pas fuiter
 *    par l'ajout d'une colonne ;
 *  - un connecteur ne s'enregistre jamais sans groupe de repli : dans DocuPro un document sans
 *    permission est visible de tous, il faut donc toujours un filet restrictif.
 */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);
  private readonly env: NodeJS.ProcessEnv;
  private readonly deps: ConnectorDeps;
  private readonly testTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(GED_CONNECTOR_REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(GED_CONNECTOR_QUEUE_TOKEN) private readonly queue: Queue,
    @Optional() @Inject(GED_CONNECTORS_RUNTIME) runtime?: ConnectorsRuntime,
  ) {
    this.env = runtime?.env ?? process.env;
    this.deps = { env: this.env, ...runtime?.deps };
    this.testTimeoutMs = runtime?.testTimeoutMs ?? TEST_TIMEOUT_MS;
  }

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  listTypes(): GedConnectorTypeInfo[] {
    return this.registry.list().map((def) => ({
      type: def.type,
      label: def.label,
      description: def.description,
      supportedModes: [...def.supportedModes],
      configFields: def.configFields.map((f) => ({ ...f })),
      credentialFields: def.credentialFields.map((f) => ({ ...f })),
    }));
  }

  async list(): Promise<GedConnectorView[]> {
    const rows = await this.prisma.gedSourceConnector.findMany({
      orderBy: { gedSourceConnectorId: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(id: number): Promise<GedConnectorView> {
    return this.toView(await this.getRow(id));
  }

  // -------------------------------------------------------------------------
  // Écriture
  // -------------------------------------------------------------------------

  async create(dto: CreateConnectorDto, user: AuthUser): Promise<GedConnectorView> {
    const plain = this.nonEmptyCredentials(dto.credentials);
    // Clé vérifiée AVANT tout travail : inutile de valider une config qu'on ne pourra pas enregistrer.
    const ring = plain ? this.requireKeyRing() : null;
    const refCreds = dto.credentialsRef ? this.resolveRef(dto.credentialsRef) : undefined;

    const validated = await this.validate(
      {
        connectorType: dto.connectorType,
        mode: dto.mode,
        config: this.withFallbackGroup(dto.config, user),
        credentials: plain ?? refCreds,
      },
      plain ?? refCreds,
    );
    await this.assertRightsAndTargets(validated, dto.targetDossierId ?? null);

    const encrypted =
      plain && ring ? encryptCredentials(validated.credentials ?? plain, ring) : null;

    const created = await this.prisma.gedSourceConnector.create({
      data: {
        label: dto.label,
        connectorType: dto.connectorType,
        mode: dto.mode,
        status: GedSourceConnectorStatus.Actif,
        isActive: true,
        config: validated.config as Prisma.InputJsonValue,
        credentialsEnc: encrypted?.credentialsEnc ?? null,
        credentialsKeyId: encrypted?.credentialsKeyId ?? null,
        credentialsRef: dto.credentialsRef ?? null,
        credentialsExpiresAt: dto.credentialsExpiresAt ? new Date(dto.credentialsExpiresAt) : null,
        syncIntervalMinutes: dto.syncIntervalMinutes ?? null,
        targetDossierId: dto.targetDossierId ?? null,
        createdBy: user.userGroupId,
      },
    });
    await this.auditChange(user, created.gedSourceConnectorId, `created:${dto.connectorType}`);
    return this.toView(created);
  }

  async update(id: number, dto: UpdateConnectorDto, user: AuthUser): Promise<GedConnectorView> {
    const row = await this.getRow(id);

    const plain = this.nonEmptyCredentials(dto.credentials ?? undefined);
    const ring = plain ? this.requireKeyRing() : null;
    const refCreds = dto.credentialsRef ? this.resolveRef(dto.credentialsRef) : undefined;
    const mode = dto.mode ?? (row.mode as GedSourceMode);

    // Re-validation INTÉGRALE, même pour un simple changement de libellé : la config stockée a pu
    // devenir dangereuse depuis (liste des racines autorisées, DNS d'un hôte).
    const validated = await this.validate(
      {
        connectorType: row.connectorType,
        mode,
        config: this.withFallbackGroup(dto.config ?? row.config ?? {}, user),
        credentials: plain ?? refCreds,
      },
      plain ?? refCreds,
    );
    const targetDossierId =
      dto.targetDossierId === undefined ? row.targetDossierId : dto.targetDossierId;
    await this.assertRightsAndTargets(
      validated,
      dto.targetDossierId === undefined ? null : dto.targetDossierId,
    );

    const data: Prisma.GedSourceConnectorUpdateInput = {
      mode,
      config: validated.config as Prisma.InputJsonValue,
    };
    const changed: string[] = ['config'];
    if (dto.mode !== undefined) changed.push('mode');
    if (dto.label !== undefined) {
      data.label = dto.label;
      changed.push('label');
    }
    if (dto.syncIntervalMinutes !== undefined) {
      data.syncIntervalMinutes = dto.syncIntervalMinutes;
      changed.push('syncIntervalMinutes');
    }
    if (dto.credentialsExpiresAt !== undefined) {
      data.credentialsExpiresAt = dto.credentialsExpiresAt
        ? new Date(dto.credentialsExpiresAt)
        : null;
      changed.push('credentialsExpiresAt');
    }
    if (dto.targetDossierId !== undefined) {
      data.targetDossier =
        targetDossierId === null
          ? { disconnect: true }
          : { connect: { dossierId: targetDossierId } };
      changed.push('targetDossierId');
    }

    // Identifiants : objet = remplacement complet, null = effacement, absent = inchangé. Une
    // référence et un chiffré ne coexistent jamais (le dernier fourni gagne, l'autre est vidé).
    if (dto.credentials !== undefined) {
      if (plain && ring) {
        const enc = encryptCredentials(validated.credentials ?? plain, ring);
        data.credentialsEnc = enc.credentialsEnc;
        data.credentialsKeyId = enc.credentialsKeyId;
      } else {
        data.credentialsEnc = null;
        data.credentialsKeyId = null;
      }
      if (dto.credentials !== null || row.credentialsRef !== null) data.credentialsRef = null;
      changed.push('credentials');
    } else if (dto.credentialsRef !== undefined) {
      data.credentialsRef = dto.credentialsRef;
      if (dto.credentialsRef !== null) {
        data.credentialsEnc = null;
        data.credentialsKeyId = null;
      }
      changed.push('credentialsRef');
    }

    // Autre racine / hôte / boîte : l'ancien jeton ne vaut plus rien, repartir d'un listage complet.
    if (this.sourceIdentityChanged(row.config, validated.settings)) {
      data.changeToken = null;
      changed.push('changeToken');
    }

    const updated = await this.prisma.gedSourceConnector.update({
      where: { gedSourceConnectorId: id },
      data,
    });
    await this.auditChange(user, id, `updated:${changed.join(',')}`);
    return this.toView(updated);
  }

  async deactivate(id: number, user: AuthUser): Promise<GedConnectorView> {
    await this.getRow(id);
    const updated = await this.prisma.gedSourceConnector.update({
      where: { gedSourceConnectorId: id },
      data: { isActive: false, status: GedSourceConnectorStatus.Inactif },
    });
    await this.auditChange(user, id, 'deactivated');
    return this.toView(updated);
  }

  async activate(id: number, user: AuthUser): Promise<GedConnectorView> {
    await this.getRow(id);
    const updated = await this.prisma.gedSourceConnector.update({
      where: { gedSourceConnectorId: id },
      data: { isActive: true, status: GedSourceConnectorStatus.Actif, lastError: null },
    });
    await this.auditChange(user, id, 'activated');
    return this.toView(updated);
  }

  // -------------------------------------------------------------------------
  // Test de connexion
  // -------------------------------------------------------------------------

  /**
   * Authentifie puis lit une page d'un seul élément, sous délai. Un échec de connexion n'est JAMAIS
   * une erreur HTTP : c'est le résultat attendu d'un test (`ok: false`).
   */
  async testConnection(id: number): Promise<ConnectorTestResult> {
    const row = await this.getRow(id);

    let credentials: ConnectorCredentials;
    try {
      credentials = this.credentialsOf(row);
    } catch (e) {
      return { ok: false, message: this.safeMessage(e, {}) };
    }

    let connector: SourceConnector | null = null;
    const controller = new AbortController();
    try {
      connector = buildConnector(this.registry, row.connectorType, {
        config: row.config,
        credentials,
        deps: this.deps,
      });
      const live = connector;
      await withTimeout(
        (async () => {
          await live.authenticate();
          await live.listChanges(null, { pageSize: 1, signal: controller.signal });
        })(),
        this.testTimeoutMs,
        () => controller.abort(),
      );
      return { ok: true, message: 'Connexion réussie.' };
    } catch (e) {
      return { ok: false, message: this.describeFailure(e, credentials) };
    } finally {
      if (connector) {
        try {
          await withTimeout(connector.close(), CLOSE_TIMEOUT_MS);
        } catch {
          // Échec de fermeture : sans conséquence pour le résultat, et le message pourrait citer la source.
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Synchronisation
  // -------------------------------------------------------------------------

  async requestSync(id: number, user: AuthUser): Promise<{ queued: true }> {
    const row = await this.getRow(id);
    if (!row.isActive) {
      throw new ConflictException(
        'Connecteur inactif : activez-le avant de lancer une synchronisation',
      );
    }
    const running = await this.prisma.gedSourceSyncRun.findFirst({
      where: {
        connectorId: id,
        status: 0,
        startedAt: { gte: new Date(Date.now() - STALE_RUN_MS) },
      },
      select: { gedSourceSyncRunId: true },
    });
    if (running) {
      throw new ConflictException('Une synchronisation est déjà en cours pour ce connecteur');
    }

    const jobId = `ged-sync-${id}`;
    // Avec `removeOnComplete: 1000`, un job terminé garde son identifiant : BullMQ ignorerait alors
    // en silence tout nouvel ajout de même `jobId`. On retire donc le job terminé avant de ré-enfiler,
    // et on ne double pas un job encore en attente.
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove();
      else return { queued: true };
    }

    const data: GedConnectorSyncJobData = {
      connectorId: id,
      trigger: 'manual',
      requestedBy: user.userGroupId,
    };
    await this.queue.add(GED_CONNECTOR_JOB.sync, data, {
      jobId,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    await this.auditChange(user, id, 'sync-requested');
    return { queued: true };
  }

  async listRuns(id: number, query: ListRunsQuery): Promise<GedSourceSyncRunView[]> {
    await this.getRow(id);
    const rows = await this.prisma.gedSourceSyncRun.findMany({
      where: { connectorId: id },
      orderBy: [{ startedAt: 'desc' }, { gedSourceSyncRunId: 'desc' }],
      take: query.limit ?? CONNECTORS_DEFAULT_RUNS_LIMIT,
    });
    return rows.map((r) => this.toRunView(r));
  }

  // -------------------------------------------------------------------------
  // Éléments
  // -------------------------------------------------------------------------

  async listItems(
    id: number,
    query: ListItemsQuery,
  ): Promise<{ items: GedSourceItemView[]; total: number; page: number; pageSize: number }> {
    await this.getRow(id);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? CONNECTORS_DEFAULT_PAGE_SIZE;

    const where: Prisma.GedSourceItemWhereInput = { connectorId: id };
    if (query.state !== undefined) where.state = query.state;
    if (query.q) {
      const pattern = escapeLikePattern(query.q);
      where.OR = [
        { name: { contains: pattern, mode: 'insensitive' } },
        { originPath: { contains: pattern, mode: 'insensitive' } },
        // Empreinte stockée en minuscules : préfixe seulement (un hash se cherche par son début).
        { contentHash: { startsWith: pattern.toLowerCase() } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.gedSourceItem.findMany({
        where,
        orderBy: [{ lastSeenAt: 'desc' }, { gedSourceItemId: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.gedSourceItem.count({ where }),
    ]);
    return { items: rows.map((r) => this.toItemView(r)), total, page, pageSize };
  }

  async getItem(id: number, itemId: number): Promise<GedSourceItemDetailView> {
    await this.getRow(id);
    // Le filtre par connecteur est dans la requête : un élément d'un autre connecteur est un 404.
    const row = await this.prisma.gedSourceItem.findFirst({
      where: { gedSourceItemId: BigInt(itemId), connectorId: id },
      include: {
        duplicateOf: { select: { gedSourceItemId: true, name: true, connectorId: true } },
      },
    });
    if (!row) throw new NotFoundException('Élément introuvable');
    return {
      ...this.toItemView(row),
      duplicateOf: row.duplicateOf
        ? {
            id: Number(row.duplicateOf.gedSourceItemId),
            name: row.duplicateOf.name,
            connectorId: row.duplicateOf.connectorId,
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Rotation des clés
  // -------------------------------------------------------------------------

  /** Rechiffre avec la clé active tout identifiant chiffré sous une autre clé. Sans clé : 503. */
  async rotateKeys(user: AuthUser): Promise<{ reencrypted: number }> {
    const ring = this.requireKeyRing();
    const rows = await this.prisma.gedSourceConnector.findMany({
      where: { credentialsEnc: { not: null } },
      select: { gedSourceConnectorId: true, credentialsEnc: true, credentialsKeyId: true },
      orderBy: { gedSourceConnectorId: 'asc' },
    });

    let reencrypted = 0;
    for (const row of rows) {
      if (!row.credentialsEnc || !needsReencryption(row.credentialsKeyId, ring)) continue;
      try {
        const next = reencryptCredentials(row.credentialsEnc, row.credentialsKeyId, ring);
        // Garde optimiste : si le chiffré a changé entre-temps (édition concurrente), on n'écrase rien.
        const res = await this.prisma.gedSourceConnector.updateMany({
          where: {
            gedSourceConnectorId: row.gedSourceConnectorId,
            credentialsEnc: row.credentialsEnc,
          },
          data: { credentialsEnc: next.credentialsEnc, credentialsKeyId: next.credentialsKeyId },
        });
        reencrypted += res.count;
      } catch (e) {
        // Une ligne illisible (ancienne clé retirée trop tôt) ne bloque pas les autres. Le message
        // de `CredentialsCryptoError` est sûr par contrat ; tout autre message est écarté.
        const reason = e instanceof CredentialsCryptoError ? e.message : 'erreur inattendue';
        this.logger.warn(
          `Rotation des clés : connecteur ${row.gedSourceConnectorId} non rechiffré (${reason})`,
        );
      }
    }
    await this.auditChange(user, '*', `keys-rotated:${reencrypted}`);
    return { reencrypted };
  }

  // -------------------------------------------------------------------------
  // Aides internes
  // -------------------------------------------------------------------------

  private async getRow(id: number): Promise<GedSourceConnector> {
    const row = await this.prisma.gedSourceConnector.findUnique({
      where: { gedSourceConnectorId: id },
    });
    if (!row) throw new NotFoundException('Connecteur introuvable');
    return row;
  }

  /** Objet vide = « pas d'identifiants » : on ne chiffre pas `{}`. */
  private nonEmptyCredentials(
    creds: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    return creds && Object.keys(creds).length > 0 ? creds : undefined;
  }

  private requireKeyRing(): KeyRing {
    const raw = this.env.GED_CONNECTOR_KEY;
    if (raw == null || raw.trim() === '')
      throw new ServiceUnavailableException(MISSING_KEY_MESSAGE);
    try {
      return loadKeyRing(this.env);
    } catch (e) {
      // Clé présente mais invalide : le message de la bibliothèque ne cite jamais la clé.
      if (e instanceof CredentialsCryptoError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }

  private resolveRef(ref: string): ConnectorCredentials {
    try {
      return resolveCredentialsRef(ref, this.env);
    } catch (e) {
      if (e instanceof CredentialsCryptoError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Identifiants effectifs d'une ligne : référence résolue, ou chiffré déchiffré, ou aucun. */
  private credentialsOf(row: GedSourceConnector): ConnectorCredentials {
    if (row.credentialsRef) return resolveCredentialsRef(row.credentialsRef, this.env);
    if (row.credentialsEnc) {
      return decryptCredentials(row.credentialsEnc, row.credentialsKeyId, loadKeyRing(this.env));
    }
    return {};
  }

  /**
   * Sans groupe de repli, un document importé sans permission serait visible de tous. Absent : on
   * pose le groupe de l'administrateur (le plus restrictif connu). Présent mais vide : refusé plus loin.
   */
  private withFallbackGroup(config: unknown, user: AuthUser): unknown {
    if (!isPlainObject(config)) return config;
    const rights = config.rights;
    if (rights !== undefined && !isPlainObject(rights)) return config;
    const current = rights ?? {};
    if (current.fallbackUserGroupIds !== undefined) return config;
    if (user.userGroupId == null) {
      throw new BadRequestException(
        'Aucun groupe de repli pour les droits : votre compte n’appartient à aucun groupe, indiquez rights.fallbackUserGroupIds',
      );
    }
    return { ...config, rights: { ...current, fallbackUserGroupIds: [user.userGroupId] } };
  }

  private async validate(
    input: {
      connectorType: string;
      mode: GedSourceMode;
      config: unknown;
      credentials?: ConnectorCredentials;
    },
    secrets: ConnectorCredentials | undefined,
  ): Promise<ValidatedConnectorInput> {
    try {
      return await validateConnectorInput(this.registry, input, this.deps);
    } catch (e) {
      if (e instanceof ConnectorConfigError) {
        throw new BadRequestException(this.safeMessage(e, secrets ?? {}));
      }
      throw e;
    }
  }

  /** Groupes de droits existants, repli non vide, dossier cible existant. */
  private async assertRightsAndTargets(
    validated: ValidatedConnectorInput,
    targetDossierId: number | null,
  ): Promise<void> {
    const { fallbackUserGroupIds, principalMap } = validated.rights;
    if (fallbackUserGroupIds.length === 0) {
      throw new BadRequestException(
        'rights.fallbackUserGroupIds ne peut pas être vide : un document sans permission serait visible de tous',
      );
    }
    const wanted = [...new Set([...fallbackUserGroupIds, ...Object.values(principalMap)])];
    const found = await this.prisma.appUserGroup.findMany({
      where: { userGroupId: { in: wanted } },
      select: { userGroupId: true },
    });
    const known = new Set(found.map((g) => g.userGroupId));
    const missing = wanted.filter((g) => !known.has(g));
    if (missing.length > 0) {
      throw new BadRequestException(`Groupe(s) de droits inexistant(s) : ${missing.join(', ')}`);
    }
    if (targetDossierId !== null) {
      const dossier = await this.prisma.dossier.findUnique({
        where: { dossierId: targetDossierId },
        select: { dossierId: true },
      });
      if (!dossier) throw new BadRequestException('Dossier cible introuvable');
    }
  }

  private sourceIdentityChanged(oldConfig: unknown, newSettings: unknown): boolean {
    const before = isPlainObject(oldConfig) ? oldConfig : {};
    const after = isPlainObject(newSettings) ? newSettings : {};
    return SOURCE_IDENTITY_KEYS.some((k) => before[k] !== after[k]);
  }

  private safeMessage(e: unknown, creds: ConnectorCredentials): string {
    const raw = e instanceof Error ? e.message : 'erreur inconnue';
    return redactSecrets(raw, creds).slice(0, MESSAGE_MAX);
  }

  /** Traduit une erreur de connexion en message français, secrets masqués. */
  private describeFailure(e: unknown, creds: ConnectorCredentials): string {
    const detail = this.safeMessage(e, creds);
    if (e instanceof TimeoutError) {
      return `Délai dépassé : la source n’a pas répondu en ${Math.round(this.testTimeoutMs / 1000)} s`;
    }
    if (e instanceof ConnectorAuthError) {
      const head = e.expired ? 'Autorisation expirée' : 'Authentification refusée';
      return detail ? `${head} : ${detail}` : head;
    }
    if (e instanceof ConnectorQuotaError) {
      return `Limite de débit de la source atteinte : réessayez plus tard${detail ? ` (${detail})` : ''}`;
    }
    if (e instanceof SsrfError) return `Adresse refusée : ${detail}`;
    if (e instanceof ConnectorConfigError || e instanceof CredentialsCryptoError) return detail;
    return `Échec de la connexion : ${detail}`;
  }

  /** Journal d'audit : référence et nature du changement seulement, jamais une valeur de configuration. */
  private async auditChange(user: AuthUser, id: number | string, newValue: string): Promise<void> {
    await this.audit.dataChange({
      userGroupId: user.userGroupId,
      actorFullName: actorName(user),
      objectRef: `ged_source_connector:${id}`,
      newValue,
    });
  }

  // -------------------------------------------------------------------------
  // Vues — champ par champ, jamais `...row`
  // -------------------------------------------------------------------------

  private toView(r: GedSourceConnector): GedConnectorView {
    return {
      gedSourceConnectorId: r.gedSourceConnectorId,
      label: r.label,
      connectorType: r.connectorType,
      mode: r.mode as GedSourceMode,
      status: r.status as GedConnectorView['status'],
      config: isPlainObject(r.config) ? r.config : null,
      hasCredentials: r.credentialsEnc != null || r.credentialsRef != null,
      credentialsRef: r.credentialsRef,
      credentialsExpiresAt: iso(r.credentialsExpiresAt),
      syncIntervalMinutes: r.syncIntervalMinutes,
      targetDossierId: r.targetDossierId,
      lastSyncAt: iso(r.lastSyncAt),
      lastSuccessAt: iso(r.lastSuccessAt),
      lastError: r.lastError,
      isActive: r.isActive,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toRunView(r: GedSourceSyncRun): GedSourceSyncRunView {
    return {
      gedSourceSyncRunId: Number(r.gedSourceSyncRunId),
      connectorId: r.connectorId,
      status: r.status as GedSyncRunStatus,
      startedAt: r.startedAt.toISOString(),
      finishedAt: iso(r.finishedAt),
      itemsSeen: r.itemsSeen,
      itemsCreated: r.itemsCreated,
      itemsUpdated: r.itemsUpdated,
      itemsDeleted: r.itemsDeleted,
      itemsDuplicate: r.itemsDuplicate,
      itemsFailed: r.itemsFailed,
      errorMessage: r.errorMessage,
    };
  }

  private toItemView(r: GedSourceItem): GedSourceItemView {
    return {
      gedSourceItemId: Number(r.gedSourceItemId),
      connectorId: r.connectorId,
      externalId: r.externalId,
      name: r.name,
      originUrl: r.originUrl,
      originPath: r.originPath,
      mimeType: r.mimeType,
      byteLength: r.byteLength == null ? null : Number(r.byteLength),
      originAuthor: r.originAuthor,
      originCreatedAt: iso(r.originCreatedAt),
      originModifiedAt: iso(r.originModifiedAt),
      contentHash: r.contentHash,
      originAcl: r.originAcl,
      state: r.state as GedSourceItemState,
      documentId: r.documentId,
      duplicateOfId: r.duplicateOfId == null ? null : Number(r.duplicateOfId),
      errorMessage: r.errorMessage,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    };
  }
}
