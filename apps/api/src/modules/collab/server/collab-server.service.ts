import { randomInt, randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import {
  Hocuspocus,
  type Connection as HocuspocusConnection,
  type Document as HocuspocusDocument,
  type WebSocketLike,
  type afterHandleMessagePayload,
  type afterUnloadDocumentPayload,
  type beforeHandleAwarenessPayload,
  type beforeHandleMessagePayload,
  type beforeSyncPayload,
  type beforeUnloadDocumentPayload,
  type connectedPayload,
  type onAuthenticatePayload,
  type onChangePayload,
  type onDisconnectPayload,
  type onLoadDocumentPayload,
  type onStoreDocumentPayload,
  type onTokenSyncPayload,
} from '@hocuspocus/server';
import { extractMentionIds } from '@archivage/editor';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import * as Y from 'yjs';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { actorName } from '../../documents/documents.service';
import {
  CollabAccessService,
  CollabAuthError,
  type VerifiedCollabToken,
} from '../access/collab-access.service';
import {
  COLLAB_WS_PATH,
  CollabCloseCode,
  type CollabLoadResult,
  type CollabMode,
  type CollabPersistencePort,
  type CollabServerPort,
} from '../collab.contracts';
import {
  CLIENT_MESSAGE_TYPES,
  isHeartbeat,
  parseRoomName,
  readMessageHeader,
  urlCarriesToken,
} from './collab-protocol';
import { parseTrustProxy, resolveClientIp } from './collab-client-ip';
import { ConnectionRateLimiter } from './collab-rate-limiter';
import {
  MentionTracker,
  SERVER_FIX_ORIGIN,
  installCommentIdentityGuard,
  type CollabIdentity,
} from './collab-room-identity';
import {
  COLLAB_PERSISTENCE,
  COLLAB_SERVER_OPTIONS,
  parseAllowedOrigins,
  resolveCollabServerOptions,
  type CollabServerOptions,
} from './collab-server.options';
import {
  RoomStructureGuard,
  classifyUpdate,
  defaultStructureValidator,
  emptyStructureCounters,
  type StructureCounters,
  type StructureVerdict,
} from './collab-structure-guard';
import { findMissingDependency, purgePendingUpdates, stateVectorOf } from './collab-update-guard';

/** Contexte Hocuspocus d'une connexion (socket client) ou d'une connexion directe (serveur). */
export interface CollabConnectionContext {
  /** Clé du socket dans le registre du serveur (absente pour une connexion directe). */
  socketKey?: string;
  user?: AuthUser;
  documentId?: number;
  mode?: CollabMode;
  direct?: boolean;
}

/** Raison unique envoyée au client pour TOUT refus d'accès (jeton, droits, document inconnu…). */
export const COLLAB_DENIED_REASON = 'permission-denied';
const CLOSE_REASON = {
  unauthorized: 'unauthorized',
  expired: 'session-expired',
  policy: 'policy-violation',
  /**
   * Refus de STRUCTURE (mise à jour invalide pour le schéma, dépendances manquantes) : le client
   * doit repartir d'un état sain au lieu de rejouer son Y.Doc local fautif (voir le web).
   */
  structure: 'structure',
  tooMany: 'too-many-connections',
  reload: 'reload',
  shutdown: 'server-shutdown',
} as const;
/** Code WebSocket standard « going away » (arrêt du serveur). */
const CLOSE_GOING_AWAY = 1001;
/** Marge du plafond `ws` au-delà de la limite applicative (au-delà : 1009 direct par `ws`). */
const WS_HARD_PAYLOAD_SLACK = 64 * 1024;
/** Durée de validité de l'état chargé pendant l'authentification, réutilisé par `onLoadDocument`. */
const PENDING_LOAD_TTL_MS = 5_000;
const AWARENESS_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
/** Réévaluations de droits menées en parallèle pendant un balayage (borne la charge en base). */
const REVALIDATION_CONCURRENCY = 16;
/** Passes maximales d'attente des tâches d'une salle dans `resetRoom` (tâches qui en créent d'autres). */
const RESET_WAIT_PASSES = 5;
/**
 * Marge gardée sur le délai d'authentification quand une connexion attend la fin d'une
 * restauration : au-delà, elle est fermée en `Reload` (le client réessaie) AVANT que la minuterie
 * d'authentification ne la ferme en `Unauthorized` (que le client lirait comme un refus).
 */
const RESET_WAIT_AUTH_MARGIN_MS = 500;
/** Verrou de validation structurelle rendu au plus tard après ce délai (filet, jamais atteint). */
const STRUCTURE_LOCK_TIMEOUT_MS = 5_000;

interface SocketState {
  key: string;
  ws: WebSocket;
  ip: string;
  openedAt: number;
  client: ReturnType<Hocuspocus['handleConnection']>;
  limiter: ConnectionRateLimiter;
  /** Clé d'adressage de la SEULE salle autorisée sur ce socket (fixée au premier message). */
  rawKey: string | null;
  roomId: number | null;
  user: AuthUser | null;
  expiresAt: number;
  documentId: number | null;
  mode: CollabMode | null;
  /** Configuration Hocuspocus de la connexion (lecture seule appliquée à sa création). */
  connectionConfig: { readOnly: boolean } | null;
  authenticated: boolean;
  connected: boolean;
  closed: boolean;
  alive: boolean;
  authTimer: NodeJS.Timeout | null;
}

interface RoomState {
  documentId: number;
  baseVersionId: number;
  /** Modifié par un utilisateur depuis le chargement ou la dernière version créée par le serveur. */
  dirty: boolean;
  lastWriter: AuthUser | null;
  lastVersionAt: number;
  /** Majorant de la taille de l'état encodé (recalculé exactement à l'approche de la limite). */
  approxBytes: number;
  abandoned: boolean;
  /** Dernier autosave en échec : la salle ne doit pas être déchargée avant une sauvegarde réussie. */
  unsaved: boolean;
  /** clientId d'awareness -> socket propriétaire (anti-usurpation). */
  awarenessOwners: Map<number, string>;
  finalState: Uint8Array | null;
  /** Mentions introduites, par auteur (userId), en attente de notification après sauvegarde. */
  pendingMentions: Map<number, { user: AuthUser; ids: Set<number> }>;
  /** Validation de la structure du contenu (copie miroir, verrou et budget de la salle). */
  structure: RoomStructureGuard;
  /** Débranche les observateurs posés sur le Y.Doc (mentions, identité des commentaires, structure). */
  detach: () => void;
}

/** Barrière de chargement d'une salle (voir `CollabServerService.holdRoomLoads`). */
interface LoadBarrier {
  released: Promise<void>;
}

/** Erreur jetée par un hook pour refuser un message (sans `message` : Hocuspocus ne la journalise pas). */
function rejection(code: number, reason: string): { code: number; reason: string } {
  return { code, reason };
}

/** Motif INTERNE d'un refus d'accès (journalisé côté serveur, jamais transmis au client). */
class CollabRefusal extends Error {}

/** Refus pour dépassement d'une limite de connexions (après un accès accordé). */
class CollabLimitRefusal extends Error {}

/** Salle suspendue (restauration en cours) : le client doit se reconnecter plus tard (`Reload`). */
class CollabReloadRefusal extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serveur de collaboration temps réel (Hocuspocus 4) greffé sur le serveur HTTP de Nest, chemin
 * `COLLAB_WS_PATH`, via l'événement `upgrade` (`ws` en `noServer`). Implémente `CollabServerPort`.
 *
 * Sécurité, dans l'ordre où un message la rencontre :
 *  1. upgrade : chemin exact, aucun jeton dans l'URL, Origin (si CORS_ORIGIN), sockets par IP,
 *     plafond global, `maxPayload` ;
 *  2. message : binaire seulement, taille, débit (messages/s et octets/s), en-tête valide, type
 *     autorisé, UNE seule salle par socket, nom de salle décimal strict ;
 *  3. authentification (hook) : JWT (même secret/règles que l'HTTP) puis accès refusé par défaut
 *     — refus uniforme (même code, même raison, même durée plancher) que le jeton soit faux, le
 *     document inconnu, refusé ou non texte ;
 *  4. connexion établie : lecture seule appliquée par Hocuspocus (mises à jour ignorées),
 *     awareness réécrite (identité forcée, pas d'usurpation d'un autre client), mise à jour Yjs
 *     à dépendances manquantes refusée, taille d'état bornée et structure du contenu validée
 *     (schéma de l'éditeur, profondeur, nombre de nœuds) AVANT application, expiration du
 *     JWT surveillée, droits réévalués au balayage et au renouvellement du jeton ;
 *  5. contenu : identité des commentaires imposée par le serveur, mentions attribuées à la
 *     connexion qui les introduit (notification au nom de son seul auteur).
 *
 * L'adresse IP des limites est celle du socket, ou `X-Forwarded-For` lu à `COLLAB_TRUST_PROXY`
 * sauts si (et seulement si) un proxy de confiance est déclaré.
 */
@Injectable()
export class CollabServerService
  implements CollabServerPort, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(CollabServerService.name);
  private readonly options: CollabServerOptions;
  readonly hocuspocus: Hocuspocus<CollabConnectionContext>;
  private readonly wss: WebSocketServer;

  private readonly sockets = new Map<string, SocketState>();
  private readonly ipCounts = new Map<string, number>();
  private readonly rooms = new WeakMap<Y.Doc, RoomState>();
  private readonly unloadingRooms = new Map<string, RoomState>();
  /**
   * État lu pendant l'authentification, réutilisé par `onLoadDocument`. `generation` : valeur de
   * `loadGeneration` AVANT la lecture — toute barrière posée ou levée depuis la rend caduque.
   */
  private readonly pendingLoads = new Map<
    number,
    { loaded: CollabLoadResult; at: number; generation: number }
  >();
  /** Barrières de chargement par document (restauration en cours), voir `holdRoomLoads`. */
  private readonly loadBarriers = new Map<number, Set<LoadBarrier>>();
  /** Incrémenté à chaque pose ou levée de barrière (invalide les états lus avant). */
  private loadGeneration = 0;
  private readonly pendingTasks = new Set<Promise<unknown>>();
  /** Tâches de persistance en cours par document (attendues par `resetRoom`). */
  private readonly roomTasks = new Map<number, Set<Promise<void>>>();
  private revalidating: Promise<void> | null = null;
  private readonly structureCounters: StructureCounters = emptyStructureCounters();

  private attachedServer: HttpServer | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private stopping: Promise<void> | null = null;

  constructor(
    @Inject(COLLAB_PERSISTENCE) private readonly persistence: CollabPersistencePort,
    private readonly access: CollabAccessService,
    private readonly audit: AuditService,
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    @Optional() config?: ConfigService,
    @Optional() @Inject(COLLAB_SERVER_OPTIONS) overrides?: Partial<CollabServerOptions>,
  ) {
    const corsOrigin = config?.get<string>('CORS_ORIGIN') ?? process.env.CORS_ORIGIN;
    const rawTrustProxy =
      config?.get<string>('COLLAB_TRUST_PROXY') ?? process.env.COLLAB_TRUST_PROXY;
    const trustProxy = parseTrustProxy(rawTrustProxy);
    if (trustProxy === null) {
      this.logger.warn(
        `COLLAB_TRUST_PROXY invalide (entier de 0 à 10 attendu) : X-Forwarded-For ignoré`,
      );
    }
    this.options = resolveCollabServerOptions({
      allowedOrigins: parseAllowedOrigins(corsOrigin),
      trustProxy: trustProxy ?? 0,
      ...(overrides ?? {}),
    });
    const o = this.options;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: o.maxMessageBytes + WS_HARD_PAYLOAD_SLACK,
      perMessageDeflate: false,
      clientTracking: false,
    });

    this.hocuspocus = new Hocuspocus<CollabConnectionContext>({
      name: 'docupro-collab',
      quiet: true,
      timeout: o.idleTimeoutMs,
      // Filet de sécurité seulement : notre minuterie (`authTimer`) ferme avant, avec `Unauthorized`.
      authenticationTimeout: o.authTimeoutMs * 2,
      debounce: o.storeDebounceMs,
      maxDebounce: o.storeMaxDebounceMs,
      unloadImmediately: true,
      maxUnauthenticatedQueueSize: o.maxMessageBytes,
      maxUnauthenticatedQueueMessages: 64,
      maxPendingDocuments: 1,
      onAuthenticate: (p) => this.onAuthenticate(p),
      onTokenSync: (p) => this.onTokenSync(p),
      connected: (p) => this.safe('connected', () => this.onConnected(p)),
      onLoadDocument: (p) => this.onLoadDocument(p),
      beforeHandleMessage: (p) => this.beforeHandleMessage(p),
      afterHandleMessage: (p) => this.safe('afterHandleMessage', () => this.afterHandleMessage(p)),
      beforeSync: (p) => this.beforeSync(p),
      beforeHandleAwareness: (p) => this.beforeHandleAwareness(p),
      onChange: (p) => this.safe('onChange', () => this.onChange(p)),
      onStoreDocument: (p) => this.onStoreDocument(p),
      onDisconnect: (p) => this.safe('onDisconnect', () => this.onDisconnect(p)),
      // Peut rejeter volontairement : un état non sauvegardé garde la salle en mémoire.
      beforeUnloadDocument: (p) => this.beforeUnload(p),
      afterUnloadDocument: (p) => this.safe('afterUnloadDocument', () => this.afterUnload(p)),
    });
  }

  // ------------------------------------------------------------------------------ cycle de vie

  onApplicationBootstrap(): void {
    const server = this.adapterHost?.httpAdapter?.getHttpServer?.() as HttpServer | undefined;
    if (!server || typeof server.on !== 'function') {
      this.logger.warn('Serveur HTTP indisponible : collaboration temps réel non attachée');
      return;
    }
    this.attach(server);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  /** Greffe le serveur WebSocket sur un serveur HTTP (public pour les tests d'intégration). */
  attach(server: HttpServer): void {
    if (this.attachedServer) return;
    this.attachedServer = server;
    server.on('upgrade', this.upgradeListener);
    this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepIntervalMs);
    this.sweepTimer.unref();
    this.logger.log(`Collaboration temps réel attachée sur ${COLLAB_WS_PATH}`);
  }

  /** Arrêt propre : stocke les salles ouvertes, crée les versions de fermeture, ferme les sockets. */
  shutdown(): Promise<void> {
    if (!this.stopping) this.stopping = this.runShutdown();
    return this.stopping;
  }

  private async runShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.attachedServer?.off('upgrade', this.upgradeListener);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;

    this.hocuspocus.flushPendingStores();
    for (const state of [...this.sockets.values()]) {
      this.closeSocket(state, CLOSE_GOING_AWAY, CLOSE_REASON.shutdown);
    }
    const deadline = Date.now() + this.options.shutdownTimeoutMs;
    let lastRetry = Date.now();
    while (
      Date.now() < deadline &&
      (this.hocuspocus.documents.size > 0 || this.hocuspocus.loadingDocuments.size > 0)
    ) {
      await new Promise((r) => setTimeout(r, 25));
      if (Date.now() - lastRetry >= 500) {
        lastRetry = Date.now();
        this.retryUnsavedRooms();
      }
    }
    if (this.hocuspocus.documents.size > 0) {
      this.logger.error(
        `Arrêt : ${this.hocuspocus.documents.size} salle(s) encore en mémoire après le délai (modifications non sauvegardées possibles)`,
      );
    }
    await this.drainTasks();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** Attend les tâches de persistance en cours (versions, mentions). */
  async drainTasks(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }

  // ------------------------------------------------------------------------- CollabServerPort

  getLiveState(documentId: number): Uint8Array | null {
    const doc = this.hocuspocus.documents.get(String(documentId));
    if (!doc || doc.isLoading) return null;
    const room = this.rooms.get(doc);
    if (!room || room.abandoned) return null;
    // Un état non conforme connu n'est jamais remis à un appelant (version, export, import) :
    // la salle est ramenée au dernier état persisté (valide) et l'appelant lit la persistance.
    if (!this.ensureLiveStructure(doc, room, 'lecture de l’état vivant')) return null;
    return this.encodeRoomState(doc, room.documentId);
  }

  /** Compteurs de validation structurelle (observabilité, tests). */
  getStructureStats(): StructureCounters {
    return { ...this.structureCounters };
  }

  async mutateDocument(
    documentId: number,
    mutator: (ydoc: Y.Doc) => void,
    actor: AuthUser,
  ): Promise<void> {
    const name = this.roomNameOf(documentId);
    if (this.shuttingDown) throw new Error('Serveur collaboratif en cours d’arrêt');
    const context: CollabConnectionContext = { user: actor, documentId, direct: true };
    const connection = await this.hocuspocus.openDirectConnection(name, context);
    let failure: Error | null = null;
    try {
      // Taille vérifiée AVANT de toucher la salle vivante, sur une COPIE : un dépassement est
      // refusé proprement (salle intacte, collaborateurs non coupés, rien de persisté en plus).
      // Structure validée sur la même copie : un résultat non conforme n'atteint jamais la salle.
      const live = connection.document;
      const projected = live ? this.project(live, documentId, mutator) : null;
      if (projected && projected.size > this.options.maxStateBytes) {
        this.logger.warn(
          `Document ${documentId} : mutation serveur refusée, état projeté trop volumineux (${projected.size} o)`,
        );
        failure = new Error('État du document trop volumineux');
      } else if (projected && !projected.verdict.ok) {
        this.logger.warn(
          `Document ${documentId} : mutation serveur refusée, structure non conforme (${projected.verdict.reason})`,
        );
        failure = new Error('Structure du document non conforme');
      } else {
        await connection.transact((doc) => mutator(doc));
        const doc = connection.document;
        const room = doc ? this.rooms.get(doc) : undefined;
        if (doc && room) {
          // Filet de sécurité (mutateur non déterministe) : la salle est alors abandonnée.
          const size = Y.encodeStateAsUpdate(doc).byteLength;
          room.approxBytes = size;
          if (size > this.options.maxStateBytes) {
            this.logger.error(
              `Document ${documentId} : état trop volumineux après mutation serveur (${size} o), salle abandonnée`,
            );
            failure = new Error('État du document trop volumineux');
            this.abandonRoom(name, doc, CollabCloseCode.PolicyViolation, CLOSE_REASON.policy);
          }
        }
      }
    } finally {
      // Salle gardée « chaude » : l'appelant peut créer sa version tout de suite (getLiveState) ;
      // l'autosave et le déchargement suivent le debounce habituel.
      await connection.disconnect({ unloadImmediately: false });
    }
    if (failure) throw failure;
  }

  /** Taille et structure qu'aurait `doc` après `mutator`, calculées sur une copie jetable. */
  private project(
    doc: Y.Doc,
    documentId: number,
    mutator: (ydoc: Y.Doc) => void,
  ): { size: number; verdict: StructureVerdict } {
    const copy = new Y.Doc();
    try {
      Y.applyUpdate(copy, this.encodeRoomState(doc, documentId));
      copy.transact(() => mutator(copy));
      const size = Y.encodeStateAsUpdate(copy).byteLength;
      if (size > this.options.maxStateBytes) return { size, verdict: { ok: true } };
      return { size, verdict: this.validateStructure(copy) };
    } finally {
      copy.destroy();
    }
  }

  private structureLimits(): { maxDepth: number; maxNodes: number } {
    return { maxDepth: this.options.maxStructureDepth, maxNodes: this.options.maxStructureNodes };
  }

  /** Validation ponctuelle d'un document hors salle (chargement, copie de mutation). */
  private validateStructure(doc: Y.Doc): StructureVerdict {
    this.structureCounters.liveChecks += 1;
    return defaultStructureValidator(doc, this.structureLimits());
  }

  /**
   * Filet AVANT toute écriture ou lecture de l'état vivant : en pratique toujours vrai (les mises à
   * jour sont validées avant application). Sinon (état invalide arrivé par une voie imprévue), rien
   * n'est persisté ni remis : la salle est abandonnée et ses clients rechargent (`Reload`) le dernier
   * état persisté — valide — au lieu de garder un état divergent. Seul retour arrière possible : un
   * CRDT n'annule pas une mise à jour déjà intégrée et diffusée.
   */
  private ensureLiveStructure(doc: HocuspocusDocument, room: RoomState, when: string): boolean {
    const verdict = room.structure.checkLive();
    if (verdict.ok) return true;
    this.logger.error(
      `Document ${room.documentId} : structure du contenu non conforme (${verdict.reason}) détectée à la ${when} ; rien n’est persisté, salle ramenée au dernier état sauvegardé`,
    );
    this.abandonRoom(doc.name, doc, CollabCloseCode.Reload, CLOSE_REASON.reload);
    return false;
  }

  /**
   * Abandonne la salle (connexions fermées en `Reload`, rien de périmé persisté) puis attend la fin
   * des écritures DÉJÀ engagées pour ce document (autosave, version, notification) : l'appelant
   * (restauration de version) peut ensuite remplacer l'état sans qu'une écriture tardive ne
   * l'écrase. Idempotent : un second appel, ou un appel sans salle ouverte, est sans effet nuisible.
   */
  async resetRoom(documentId: number): Promise<void> {
    const name = this.roomNameOf(documentId);
    this.pendingLoads.delete(documentId);
    const loading = this.hocuspocus.loadingDocuments.get(name);
    if (loading) await loading.catch(() => undefined);
    const doc = this.hocuspocus.documents.get(name);
    if (doc) {
      this.abandonRoom(name, doc, CollabCloseCode.Reload, CLOSE_REASON.reload);
    } else {
      this.closeRoomSockets(documentId, CollabCloseCode.Reload, CLOSE_REASON.reload);
    }
    // Salle en cours de déchargement : pas de version de fermeture tardive.
    const unloading = this.unloadingRooms.get(name);
    if (unloading) {
      unloading.abandoned = true;
      unloading.pendingMentions.clear();
    }
    await this.waitRoomTasks(documentId);
  }

  /**
   * Suspend tout (re)chargement de la salle `documentId` jusqu'à l'appel de la fonction renvoyée
   * (idempotente) — ANO-GED-08. À poser AVANT `resetRoom` et à lever APRÈS le remplacement de
   * l'état persisté (restauration de version) : `resetRoom` ferme les connexions en `Reload`, et
   * le client se reconnecte AUSSITÔT ; sans barrière, sa reconnexion rechargeait l'état d'AVANT la
   * restauration (version courante pas encore remplacée, état de travail pas encore supprimé),
   * puis une version d'inactivité ou de fermeture le re-versionnait par-dessus la version restaurée.
   *
   * Pendant la barrière :
   *  - `onAuthenticate` ATTEND sa levée (dans la limite du délai d'authentification, sinon
   *    fermeture `Reload` : le client réessaie) avant de lire l'état à charger ;
   *  - `onLoadDocument` REFUSE de charger (fermeture `Reload` des sockets en attente) : il ne peut
   *    pas attendre, car `resetRoom` attend lui-même les chargements engagés (interblocage) ;
   *  - un état lu pendant l'authentification avant ou pendant la barrière n'est jamais réutilisé
   *    (génération de chargement, voir `pendingLoads`).
   * Plusieurs barrières peuvent se chevaucher sur un même document : la salle reste suspendue
   * jusqu'à la levée de la dernière.
   */
  holdRoomLoads(documentId: number): () => void {
    let resolve!: () => void;
    const barrier: LoadBarrier = { released: new Promise<void>((r) => (resolve = r)) };
    let held = this.loadBarriers.get(documentId);
    if (!held) {
      held = new Set();
      this.loadBarriers.set(documentId, held);
    }
    held.add(barrier);
    this.loadGeneration += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.loadBarriers.get(documentId);
      current?.delete(barrier);
      if (current && current.size === 0) this.loadBarriers.delete(documentId);
      this.loadGeneration += 1;
      resolve();
    };
  }

  /** Une barrière de chargement est-elle posée sur ce document ? */
  isRoomLoadHeld(documentId: number): boolean {
    return (this.loadBarriers.get(documentId)?.size ?? 0) > 0;
  }

  /** Attend la levée de toutes les barrières du document ; `false` si le délai est dépassé avant. */
  private async waitRoomLoads(documentId: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const held = this.loadBarriers.get(documentId);
      if (!held || held.size === 0) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        Promise.all([...held].map((b) => b.released)).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (timedOut) return false;
    }
  }

  // ----------------------------------------------------------------------------- upgrade HTTP

  private readonly upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    try {
      this.handleUpgrade(req, socket, head);
    } catch (error) {
      this.logger.error(`Upgrade WebSocket en échec : ${errorMessage(error)}`);
      this.rejectUpgrade(socket, 500);
    }
  };

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return this.rejectUpgrade(socket, 400);
    }
    const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    if (pathname !== COLLAB_WS_PATH) {
      // Pas pour nous. Seul écouteur : personne d'autre ne répondra, on libère le socket.
      if (this.attachedServer && this.attachedServer.listenerCount('upgrade') <= 1) {
        this.rejectUpgrade(socket, 404);
      }
      return;
    }
    socket.on('error', () => socket.destroy());

    if (this.shuttingDown) return this.rejectUpgrade(socket, 503);
    if (urlCarriesToken(url.searchParams)) {
      // Le jeton passe par le protocole, jamais par l'URL (journaux de proxy, historique…).
      this.logger.warn('Upgrade collaboratif refusé : jeton présent dans l’URL');
      return this.rejectUpgrade(socket, 400);
    }
    const origin = req.headers.origin;
    if (!this.isOriginAllowed(origin)) {
      this.logger.warn('Upgrade collaboratif refusé : origine non autorisée');
      return this.rejectUpgrade(socket, 403);
    }
    // X-Forwarded-For n'est lu que si un proxy de confiance est déclaré (COLLAB_TRUST_PROXY).
    const ip = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      this.options.trustProxy,
    );
    if ((this.ipCounts.get(ip) ?? 0) >= this.options.maxConnectionsPerIp) {
      this.logger.warn(`Upgrade collaboratif refusé : trop de connexions depuis ${ip}`);
      return this.rejectUpgrade(socket, 429);
    }
    if (this.sockets.size >= this.options.maxSockets) {
      this.logger.warn('Upgrade collaboratif refusé : plafond global de connexions atteint');
      return this.rejectUpgrade(socket, 503);
    }

    // Réservation libérée à la fermeture du socket TCP, que l'upgrade aboutisse ou non.
    this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1);
    socket.once('close', () => {
      const n = (this.ipCounts.get(ip) ?? 1) - 1;
      if (n <= 0) this.ipCounts.delete(ip);
      else this.ipCounts.set(ip, n);
    });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, ip));
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    const allowed = this.options.allowedOrigins;
    if (allowed.length === 0) return true;
    // Sans en-tête Origin : client non navigateur (aucun risque CSWSH), le jeton reste exigé.
    if (origin === undefined) return true;
    return allowed.includes(origin);
  }

  private rejectUpgrade(socket: Duplex, status: number): void {
    try {
      if (socket.writable) {
        socket.write(
          `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
      }
    } finally {
      socket.destroy();
    }
  }

  // --------------------------------------------------------------------------------- sockets

  private onSocket(ws: WebSocket, ip: string): void {
    const key = randomUUID();
    const adapter: WebSocketLike = {
      send: (data) => {
        if (ws.readyState === ws.OPEN) ws.send(data as Uint8Array);
      },
      close: (code?: number, reason?: string) => {
        const state = this.sockets.get(key);
        if (state) this.closeSocket(state, code ?? 1000, reason ?? '');
      },
      get readyState() {
        return ws.readyState;
      },
    };
    const now = Date.now();
    const state: SocketState = {
      key,
      ws,
      ip,
      openedAt: now,
      client: null as unknown as SocketState['client'],
      limiter: new ConnectionRateLimiter(this.options, now),
      rawKey: null,
      roomId: null,
      user: null,
      expiresAt: 0,
      documentId: null,
      mode: null,
      connectionConfig: null,
      authenticated: false,
      connected: false,
      closed: false,
      alive: true,
      authTimer: null,
    };
    this.sockets.set(key, state);
    // Requête neutre : ni en-têtes ni paramètres d'URL ne sont exposés aux hooks.
    state.client = this.hocuspocus.handleConnection(
      adapter,
      new Request(`http://localhost${COLLAB_WS_PATH}`),
      { socketKey: key },
    );
    state.authTimer = setTimeout(() => {
      if (!state.authenticated) {
        this.logger.warn(`Connexion collaborative fermée : authentification non reçue (ip=${ip})`);
        this.closeSocket(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
      }
    }, this.options.authTimeoutMs);
    state.authTimer.unref();

    ws.on('message', (data, isBinary) => this.onSocketMessage(state, data, isBinary));
    ws.on('pong', () => {
      state.alive = true;
      state.client.touch();
    });
    ws.on('error', (error) => {
      this.logger.warn(`Erreur WebSocket collaboratif : ${errorMessage(error)}`);
    });
    ws.on('close', (code, reason) => this.detachSocket(state, code, reason.toString()));
  }

  private onSocketMessage(state: SocketState, data: RawData, isBinary: boolean): void {
    if (state.closed) return;
    try {
      if (!isBinary) return this.policyClose(state, 'message non binaire');
      const bytes = toBytes(data);
      if (bytes.byteLength > this.options.maxMessageBytes) {
        return this.policyClose(state, 'message trop volumineux');
      }
      if (!state.limiter.allow(bytes.byteLength)) return this.policyClose(state, 'débit dépassé');
      if (isHeartbeat(bytes)) {
        state.client.touch();
        return;
      }
      const header = readMessageHeader(bytes);
      if (!header) return this.policyClose(state, 'message malformé');
      if (!CLIENT_MESSAGE_TYPES.has(header.type)) return this.policyClose(state, 'type interdit');
      if (state.rawKey === null) {
        const roomId = parseRoomName(header.documentName);
        if (roomId === null) {
          this.logRefusal('salle invalide', null, null, state.ip);
          return this.closeSocket(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
        }
        state.rawKey = header.rawKey;
        state.roomId = roomId;
      } else if (header.rawKey !== state.rawKey) {
        return this.policyClose(state, 'une seule salle par connexion');
      }
      state.client.handleMessage(bytes);
    } catch (error) {
      this.logger.warn(`Message collaboratif rejeté : ${errorMessage(error)}`);
      this.policyClose(state, 'message invalide');
    }
  }

  private policyClose(state: SocketState, why: string): void {
    this.logger.warn(
      `Connexion collaborative fermée (${why}) document=${state.roomId ?? '-'} utilisateur=${state.user?.userId ?? '-'} ip=${state.ip}`,
    );
    this.closeSocket(state, CollabCloseCode.PolicyViolation, CLOSE_REASON.policy);
  }

  /** Ferme un socket : le détache IMMÉDIATEMENT de Hocuspocus, puis envoie la trame de fermeture. */
  private closeSocket(state: SocketState, code: number, reason: string): void {
    if (state.closed) return;
    this.detachSocket(state, code, reason);
    const { ws } = state;
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
    } catch {
      ws.terminate();
    }
    // Un pair qui ne répond pas à la fermeture ne garde pas la ressource.
    const force = setTimeout(() => ws.terminate(), 5000);
    force.unref();
    ws.once('close', () => clearTimeout(force));
  }

  private detachSocket(state: SocketState, code: number, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    if (state.authTimer) clearTimeout(state.authTimer);
    this.sockets.delete(state.key);
    try {
      state.client.handleClose({ code, reason });
    } catch (error) {
      this.logger.warn(`Fermeture Hocuspocus en échec : ${errorMessage(error)}`);
    }
  }

  private scheduleClose(state: SocketState | undefined, code: number, reason: string): void {
    if (!state) return;
    // Après la trame « permission refusée » que Hocuspocus envoie quand le hook rejette.
    setTimeout(() => this.closeSocket(state, code, reason), 0);
  }

  private closeRoomSockets(documentId: number, code: number, reason: string): void {
    for (const state of [...this.sockets.values()]) {
      if (state.documentId === documentId || state.roomId === documentId) {
        this.closeSocket(state, code, reason);
      }
    }
  }

  /** Balayage périodique : authentification tardive, JWT expirés, sockets morts, ménage. */
  sweep(now: number = Date.now()): void {
    for (const state of [...this.sockets.values()]) {
      if (!state.authenticated) {
        if (now - state.openedAt >= this.options.authTimeoutMs) {
          this.closeSocket(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
        }
        continue;
      }
      if (state.expiresAt <= now) {
        this.logger.log(
          `Connexion collaborative fermée : jeton expiré (utilisateur=${state.user?.userId ?? '-'})`,
        );
        this.closeSocket(state, CollabCloseCode.Unauthorized, CLOSE_REASON.expired);
        continue;
      }
      if (!state.alive) {
        state.ws.terminate();
        continue;
      }
      state.alive = false;
      try {
        state.ws.ping();
      } catch {
        state.ws.terminate();
      }
    }
    for (const [id, entry] of this.pendingLoads) {
      if (now - entry.at > PENDING_LOAD_TTL_MS) this.pendingLoads.delete(id);
    }
    // Copies de validation des salles sans activité structurelle récente : mémoire rendue.
    for (const doc of this.hocuspocus.documents.values()) this.rooms.get(doc)?.structure.releaseIfIdle();
    this.retryUnsavedRooms();
    void this.revalidateAccess();
  }

  /**
   * Réévalue les droits des connexions ouvertes (appelée à chaque balayage) : droit retiré ou
   * document devenu inaccessible => fermeture `Unauthorized` ; document gelé/épuré ou niveau
   * abaissé => passage en lecture seule. Un seul balayage à la fois ; `resolveMode` n'est appelé
   * qu'une fois par couple (document, utilisateur) et au plus `REVALIDATION_CONCURRENCY` en
   * parallèle. Public pour les tests.
   */
  revalidateAccess(): Promise<void> {
    if (!this.revalidating) {
      const run = this.runRevalidation().finally(() => {
        this.revalidating = null;
      });
      this.revalidating = run;
      this.track(run);
    }
    return this.revalidating;
  }

  private async runRevalidation(): Promise<void> {
    const cache = new Map<string, Promise<CollabMode | null>>();
    const targets = [...this.sockets.values()].filter(
      (s) => s.authenticated && !s.closed && s.user !== null && s.documentId !== null,
    );
    for (let i = 0; i < targets.length; i += REVALIDATION_CONCURRENCY) {
      if (this.shuttingDown) return;
      await Promise.all(
        targets.slice(i, i + REVALIDATION_CONCURRENCY).map((s) => this.revalidateSocket(s, cache)),
      );
    }
  }

  private async revalidateSocket(
    state: SocketState,
    cache: Map<string, Promise<CollabMode | null>>,
  ): Promise<void> {
    const { user, documentId } = state;
    if (!user || documentId === null || state.closed) return;
    const key = `${documentId}:${user.userId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = this.access.resolveMode(documentId, user);
      cache.set(key, pending);
    }
    let mode: CollabMode | null;
    try {
      mode = await pending;
    } catch (error) {
      // Panne passagère (base) : le mode accordé est conservé, nouvel essai au balayage suivant.
      this.logger.warn(
        `Réévaluation des droits impossible (document=${documentId} utilisateur=${user.userId}) : ${errorMessage(error)}`,
      );
      return;
    }
    this.applyMode(state, mode);
  }

  /** Applique un mode recalculé à une connexion ouverte (jamais d'élévation en cours de connexion). */
  private applyMode(
    state: SocketState,
    mode: CollabMode | null,
    connection?: HocuspocusConnection<CollabConnectionContext>,
  ): void {
    if (state.closed) return;
    if (mode === null) {
      this.logRefusal(
        'droit retiré pendant la connexion',
        state.documentId,
        state.user?.userId ?? null,
        state.ip,
      );
      this.closeSocket(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
      return;
    }
    if (mode === 'read' && state.mode !== 'read') {
      state.mode = 'read';
      if (state.connectionConfig) state.connectionConfig.readOnly = true;
      const target = connection ?? this.connectionOf(state);
      if (target) {
        target.readOnly = true;
        if (target.context) target.context.mode = 'read';
      }
      this.logger.log(
        `Connexion collaborative passée en lecture seule (document=${state.documentId ?? '-'} utilisateur=${state.user?.userId ?? '-'})`,
      );
    }
    // 'read' -> 'write' : pas d'élévation silencieuse (ni audit d'ouverture) ; il faut se reconnecter.
  }

  private connectionOf(
    state: SocketState,
  ): HocuspocusConnection<CollabConnectionContext> | undefined {
    if (state.documentId === null) return undefined;
    const doc = this.hocuspocus.documents.get(String(state.documentId));
    if (!doc) return undefined;
    for (const connection of doc.getConnections()) {
      const context = connection.context as CollabConnectionContext | undefined;
      if (context?.socketKey === state.key) {
        return connection as HocuspocusConnection<CollabConnectionContext>;
      }
    }
    return undefined;
  }

  /** Salles sans connexion gardées en mémoire faute de sauvegarde : nouvelle tentative de déchargement. */
  private retryUnsavedRooms(): void {
    for (const doc of [...this.hocuspocus.documents.values()]) {
      const room = this.rooms.get(doc);
      if (room?.unsaved && !room.abandoned && doc.getConnectionsCount() === 0) {
        this.hocuspocus.unloadDocument(doc).catch((error: unknown) =>
          this.logger.error(`Déchargement en échec (document=${room.documentId}) : ${errorMessage(error)}`),
        );
      }
    }
  }

  // ------------------------------------------------------------------------------ hooks : accès

  private async onAuthenticate(
    payload: onAuthenticatePayload<CollabConnectionContext>,
  ): Promise<CollabConnectionContext> {
    const state = this.socketOf(payload.context);
    const started = Date.now();
    let documentId: number | null = null;
    let userId: number | null = null;
    let staged = false;
    try {
      if (!state || state.closed) throw new CollabRefusal('socket fermé');
      documentId = parseRoomName(payload.documentName);
      if (documentId === null) throw new CollabRefusal('salle invalide');
      let verified: VerifiedCollabToken;
      try {
        // Jeton ET compte (relu en base : supprimé/désactivé refusé, `isAdmin` de la base).
        verified = await this.access.authenticateToken(payload.token);
      } catch (error) {
        if (error instanceof CollabAuthError) {
          throw new CollabRefusal('jeton absent, invalide ou expiré, ou compte inactif');
        }
        throw error; // panne (base) : erreur interne, même refus uniforme côté client
      }
      userId = verified.user.userId;

      const mode = await this.access.resolveMode(documentId, verified.user);
      if (!mode) throw new CollabRefusal('accès refusé');

      // Restauration en cours (barrière posée avant `resetRoom`) : on attend qu'elle ait remplacé
      // l'état persisté AVANT de le lire — sinon la reconnexion qui suit le `Reload` rechargerait
      // l'état d'avant (ANO-GED-08). Attente bornée par le délai d'authentification restant.
      if (this.isRoomLoadHeld(documentId)) {
        const budget =
          this.options.authTimeoutMs - (Date.now() - state.openedAt) - RESET_WAIT_AUTH_MARGIN_MS;
        if (!(await this.waitRoomLoads(documentId, Math.max(0, budget)))) {
          throw new CollabReloadRefusal();
        }
        if (state.closed) throw new CollabRefusal('socket fermé');
      }

      // Document non texte (ou disparu) : MÊME refus. Une salle vivante prouve déjà le contraire.
      if (!this.hocuspocus.documents.has(payload.documentName)) {
        const generation = this.loadGeneration;
        const loaded = await this.persistence.loadDocument(documentId);
        if (!loaded) throw new CollabRefusal('document non texte ou inconnu');
        if (loaded.state && loaded.state.byteLength > this.options.maxStateBytes) {
          throw new CollabRefusal('état persisté trop volumineux');
        }
        this.pendingLoads.set(documentId, { loaded, at: Date.now(), generation });
        staged = true;
      }
      if (state.closed) throw new CollabRefusal('socket fermé');

      // Limites de connexions : vérifiées APRÈS l'accès (ne renseignent pas un tiers non autorisé).
      if (
        this.countConnections((s) => s.documentId === documentId) >=
          this.options.maxConnectionsPerDocument ||
        this.countConnections((s) => s.user?.userId === userId) >= this.options.maxConnectionsPerUser
      ) {
        throw new CollabLimitRefusal('trop de connexions');
      }

      state.user = verified.user;
      state.expiresAt = verified.expiresAt;
      state.documentId = documentId;
      state.authenticated = true;
      if (state.authTimer) clearTimeout(state.authTimer);

      let effective: CollabMode = mode;
      if (mode === 'write') {
        try {
          await this.audit.dataChange({
            userGroupId: verified.user.userGroupId,
            actorFullName: actorName(verified.user),
            objectRef: `document:${documentId}`,
            newValue: 'collab-open-write',
          });
        } catch (error) {
          // Pas d'écriture non tracée : à défaut d'audit, l'ouverture se fait en lecture seule.
          this.logger.error(
            `Audit d'ouverture en écriture impossible (document=${documentId}) : ${errorMessage(error)} — lecture seule`,
          );
          effective = 'read';
        }
      }
      state.mode = effective;
      payload.connectionConfig.readOnly = effective !== 'write';
      state.connectionConfig = payload.connectionConfig;
      return { user: verified.user, documentId, mode: effective };
    } catch (error) {
      // Un état chargé pour une connexion refusée ne doit pas servir plus tard (risque de périmé).
      if (staged && documentId !== null) this.pendingLoads.delete(documentId);
      if (error instanceof CollabReloadRefusal) {
        // Fermeture IMMÉDIATE (détache Hocuspocus avant sa trame « permission refusée ») : le client
        // lit `Reload` et se reconnecte, au lieu de conclure à un document inaccessible.
        this.logger.warn(
          `Connexion collaborative différée : restauration en cours (document=${documentId} utilisateur=${userId})`,
        );
        if (state) this.closeSocket(state, CollabCloseCode.Reload, CLOSE_REASON.reload);
        throw rejection(CollabCloseCode.Reload, CLOSE_REASON.reload);
      }
      if (error instanceof CollabLimitRefusal) {
        this.logger.warn(
          `Connexion collaborative refusée : trop de connexions (document=${documentId} utilisateur=${userId})`,
        );
        this.scheduleClose(state, CollabCloseCode.PolicyViolation, CLOSE_REASON.tooMany);
        throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.tooMany);
      }
      const motive =
        error instanceof CollabRefusal ? error.message : `erreur interne (${errorMessage(error)})`;
      this.logRefusal(motive, documentId, userId, state?.ip ?? null);
      await this.padRefusal(started);
      this.scheduleClose(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
      throw rejection(CollabCloseCode.Unauthorized, COLLAB_DENIED_REASON);
    }
  }

  private async onTokenSync(payload: onTokenSyncPayload<CollabConnectionContext>): Promise<void> {
    const state = this.socketOf(payload.context);
    try {
      if (!state?.user) throw new Error('non authentifié');
      // Compte relu aussi au renouvellement : un compte désactivé depuis l'ouverture est coupé.
      let verified: VerifiedCollabToken;
      try {
        verified = await this.access.authenticateToken(payload.token);
      } catch (error) {
        if (error instanceof CollabAuthError) throw error;
        // Panne passagère (base) : ni coupure ni prolongation. La connexion garde son expiration
        // actuelle (fermée à l'échéance par `beforeHandleMessage`/le balayage) ; le prochain
        // renouvellement retentera.
        this.logger.warn(
          `Renouvellement de jeton non vérifiable (document=${state.documentId ?? '-'} utilisateur=${state.user.userId}) : ${errorMessage(error)}`,
        );
        return;
      }
      if (verified.user.userId !== state.user.userId) throw new Error('changement d’utilisateur');
      state.expiresAt = Math.max(state.expiresAt, verified.expiresAt);
      // Même objet que `connection.context.user` : la réévaluation qui suit voit le statut à jour.
      state.user.isAdmin = verified.user.isAdmin;
    } catch {
      this.logRefusal('renouvellement de jeton invalide ou compte inactif', state?.documentId ?? null, state?.user?.userId ?? null, state?.ip ?? null);
      this.scheduleClose(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
      throw rejection(CollabCloseCode.Unauthorized, COLLAB_DENIED_REASON);
    }
    // Droits recalculés au renouvellement (gel, épuration, droit retiré depuis l'ouverture).
    const { user, documentId } = state;
    if (documentId === null) return;
    let mode: CollabMode | null;
    try {
      mode = await this.access.resolveMode(documentId, user);
    } catch (error) {
      this.logger.warn(
        `Réévaluation des droits impossible au renouvellement (document=${documentId} utilisateur=${user.userId}) : ${errorMessage(error)}`,
      );
      return;
    }
    if (mode === null) {
      this.logRefusal('droit retiré (renouvellement de jeton)', documentId, user.userId, state.ip);
      this.scheduleClose(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
      throw rejection(CollabCloseCode.Unauthorized, COLLAB_DENIED_REASON);
    }
    this.applyMode(state, mode, payload.connection);
  }

  private onConnected(payload: connectedPayload<CollabConnectionContext>): void {
    const state = this.socketOf(payload.context);
    if (state) state.connected = true;
  }

  private async beforeHandleMessage(
    payload: beforeHandleMessagePayload<CollabConnectionContext>,
  ): Promise<void> {
    const state = this.socketOf(payload.context);
    if (!state || state.closed) {
      throw rejection(CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
    }
    if (state.expiresAt <= Date.now()) {
      this.scheduleClose(state, CollabCloseCode.Unauthorized, CLOSE_REASON.expired);
      throw rejection(CollabCloseCode.Unauthorized, CLOSE_REASON.expired);
    }
  }

  /**
   * Contrôles AVANT application d'une mise à jour (sync step 2 ET update) d'une connexion en
   * écriture (celles en lecture seule sont filtrées par Hocuspocus : mise à jour ignorée) :
   *  1. dépendances : une mise à jour qui ne s'intégrerait pas entièrement (trou dans les horloges
   *     d'un client, référence ou suppression d'un élément inconnu) est REFUSÉE et la connexion
   *     fermée (`PolicyViolation`) — sinon elle resterait « en attente » dans la salle, recopiée
   *     dans chaque état encodé (autosave, versions, synchronisation des autres) ;
   *  2. taille : la partie réellement nouvelle (`diffUpdate` contre le vecteur d'état) ne doit pas
   *     faire dépasser `maxStateBytes` ;
   *  3. structure : une mise à jour STRUCTURELLE (nœud, attribut, marque, suppression de nœud dans
   *     le fragment de contenu — voir `classifyUpdate`) est appliquée d'abord à une copie miroir
   *     de la salle et validée contre le schéma de l'éditeur (profondeur, nombre de nœuds bornés).
   *     Non conforme : REFUSÉE (jamais appliquée, diffusée ni persistée), connexion fermée
   *     (`PolicyViolation`), les autres collaborateurs ne voient rien. La frappe de texte simple
   *     n'est pas validée (elle ne peut pas changer la structure).
   */
  private async beforeSync(payload: beforeSyncPayload<CollabConnectionContext>): Promise<void> {
    if (payload.connection.readOnly || payload.type === 0) return;
    const state = this.socketOf(payload.context);
    const room = this.rooms.get(payload.document);
    if (!room || room.abandoned) {
      throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.policy);
    }
    const missing = findMissingDependency(payload.payload, stateVectorOf(payload.document));
    if (missing) {
      if (state) this.policyCloseLater(state, `mise à jour Yjs refusée : ${missing}`, CLOSE_REASON.structure);
      throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.structure);
    }
    let incoming: number;
    try {
      incoming = Y.diffUpdate(payload.payload, Y.encodeStateVector(payload.document)).byteLength;
    } catch {
      if (state) this.policyCloseLater(state, 'mise à jour Yjs malformée', CLOSE_REASON.structure);
      throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.structure);
    }
    const max = this.options.maxStateBytes;
    if (room.approxBytes + incoming > max) {
      room.approxBytes = Y.encodeStateAsUpdate(payload.document).byteLength;
      if (room.approxBytes + incoming > max) {
        if (state) this.policyCloseLater(state, 'état du document trop volumineux');
        throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.policy);
      }
    }
    await this.checkStructure(payload, room, state);
  }

  /** Contrôle 3 de `beforeSync` (dernier : rien ne peut plus refuser le message après lui). */
  private async checkStructure(
    payload: beforeSyncPayload<CollabConnectionContext>,
    room: RoomState,
    state: SocketState | undefined,
  ): Promise<void> {
    const footprint = classifyUpdate(payload.payload, payload.document);
    if (!footprint.structural) return;
    if (payload.payload.byteLength > this.options.maxStructuralUpdateBytes) {
      if (state) {
        this.policyCloseLater(state, 'mise à jour structurelle trop volumineuse', CLOSE_REASON.structure);
      }
      throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.structure);
    }
    const verdict = await room.structure.admit(payload.payload, payload.connection, footprint, () =>
      Boolean(!room.abandoned && state && !state.closed),
    );
    if (verdict.ok) return; // verrou de la salle rendu par `afterHandleMessage` (après application)
    if (verdict.invalid) {
      if (state) {
        this.policyCloseLater(
          state,
          `structure du contenu non conforme refusée (${footprint.why ?? 'structurelle'} : ${verdict.reason})`,
          CLOSE_REASON.structure,
        );
      }
      throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.structure);
    }
    throw rejection(CollabCloseCode.PolicyViolation, CLOSE_REASON.policy);
  }

  /**
   * Filet de sécurité APRÈS application : si une mise à jour a malgré tout laissé des structures en
   * attente, elles sont écartées (jamais intégrées ni diffusées, donc sans effet visible) et la
   * connexion fautive est fermée. L'état persisté reste sain (voir aussi `encodeRoomState`).
   */
  private afterHandleMessage(payload: afterHandleMessagePayload<CollabConnectionContext>): void {
    // Message admis par la garde de structure : application vérifiée, verrou de la salle rendu.
    this.rooms.get(payload.document)?.structure.settle(payload.connection);
    if (!purgePendingUpdates(payload.document)) return;
    const state = this.socketOf(payload.context);
    if (state) this.policyCloseLater(state, 'mise à jour Yjs à dépendances manquantes (écartée)', CLOSE_REASON.structure);
  }

  private policyCloseLater(
    state: SocketState,
    why: string,
    reason: typeof CLOSE_REASON.policy | typeof CLOSE_REASON.structure = CLOSE_REASON.policy,
  ): void {
    this.logger.warn(
      `Connexion collaborative fermée (${why}) document=${state.documentId ?? '-'} utilisateur=${state.user?.userId ?? '-'}`,
    );
    this.scheduleClose(state, CollabCloseCode.PolicyViolation, reason);
  }

  /**
   * Awareness permise (curseurs, présence) même en lecture seule, mais assainie : un client ne
   * peut ni écrire ni effacer l'état d'un clientId qui appartient à une autre connexion, son
   * identité affichée (`user.name`, `user.userGroupId`) est imposée par le serveur, et la taille
   * d'un état est bornée.
   */
  private async beforeHandleAwareness(
    payload: beforeHandleAwarenessPayload<CollabConnectionContext>,
  ): Promise<void> {
    const { connection, states, removedClients, document } = payload;
    if (!connection) return; // écriture interne au serveur
    const context = connection.context as CollabConnectionContext | undefined;
    const user = context?.user;
    const socketKey = context?.socketKey;
    const room = this.rooms.get(document);
    if (!user || !socketKey || !room) {
      states.clear();
      removedClients.clear();
      return;
    }
    const owners = room.awarenessOwners;
    let owned = 0;
    for (const owner of owners.values()) if (owner === socketKey) owned += 1;

    for (const [clientId, raw] of [...states.entries()]) {
      const owner = owners.get(clientId);
      if ((owner !== undefined && owner !== socketKey) || clientId === document.awareness.clientID) {
        states.delete(clientId);
        continue;
      }
      if (owner === undefined) {
        if (owned >= this.options.maxAwarenessClientsPerConnection) {
          states.delete(clientId);
          continue;
        }
        owners.set(clientId, socketKey);
        owned += 1;
      }
      if (!isPlainObject(raw)) {
        states.delete(clientId);
        continue;
      }
      const previous = isPlainObject(raw.user) ? raw.user : {};
      const color =
        typeof previous.color === 'string' && AWARENESS_COLOR_RE.test(previous.color)
          ? previous.color
          : undefined;
      raw.user = {
        name: actorName(user),
        userGroupId: user.userGroupId,
        ...(color ? { color } : {}),
      };
      let size = Infinity;
      try {
        size = Buffer.byteLength(JSON.stringify(raw));
      } catch {
        size = Infinity;
      }
      if (size > this.options.maxAwarenessStateBytes) states.delete(clientId);
    }
    for (const clientId of [...removedClients]) {
      const owner = owners.get(clientId);
      if (owner !== socketKey) removedClients.delete(clientId);
      else owners.delete(clientId);
    }
  }

  // ------------------------------------------------------------------------ hooks : persistance

  private async onLoadDocument(
    payload: onLoadDocumentPayload<CollabConnectionContext>,
  ): Promise<void> {
    const documentId = parseRoomName(payload.documentName);
    try {
      if (documentId === null) throw new Error('Salle invalide');
      // Restauration en cours : ne PAS charger (l'état persisté est en train d'être remplacé). Pas
      // d'attente ici : `resetRoom` attend les chargements engagés, attendre la barrière depuis l'un
      // d'eux serait un interblocage. Les sockets en attente se reconnecteront (`Reload`) et
      // attendront, eux, dans `onAuthenticate`.
      if (this.isRoomLoadHeld(documentId)) {
        // Sans message : Hocuspocus ne journalise pas l'erreur d'un hook qui n'en porte pas.
        throw new CollabReloadRefusal();
      }
      const pending = this.pendingLoads.get(documentId);
      this.pendingLoads.delete(documentId);
      const loaded =
        pending &&
        pending.generation === this.loadGeneration &&
        Date.now() - pending.at <= PENDING_LOAD_TTL_MS
          ? pending.loaded
          : await this.persistence.loadDocument(documentId);
      if (!loaded) throw new Error('Document introuvable');
      const doc = payload.document;
      let approxBytes = 0;
      if (loaded.state && loaded.state.byteLength > 0) {
        if (loaded.state.byteLength > this.options.maxStateBytes) {
          throw new Error('État persisté trop volumineux');
        }
        Y.applyUpdate(doc, loaded.state);
        approxBytes = loaded.state.byteLength;
        // État persisté avant la garde des dépendances : ce qui n'a jamais pu s'intégrer est écarté.
        if (purgePendingUpdates(doc)) {
          this.logger.error(
            `Document ${documentId} : état persisté avec des structures en attente, écartées au chargement`,
          );
        }
        // État persisté non conforme au schéma (écrit avant la garde de structure, ou altéré) :
        // chargement REFUSÉ. Rien n'est écrit (ni autosave, ni version) : l'état reste intact sur
        // disque pour analyse, et la restauration d'une version antérieure (REST) reste possible.
        // Ni repli silencieux sur un document vide (qui écraserait le contenu au premier autosave),
        // ni « réparation » automatique (perte de contenu non maîtrisée).
        const verdict = this.validateStructure(doc);
        if (!verdict.ok) {
          throw new Error(`État persisté non conforme au schéma de l’éditeur (${verdict.reason})`);
        }
      }
      const structure = new RoomStructureGuard(
        doc,
        {
          ...this.structureLimits(),
          burstMs: this.options.structureValidationBurstMs,
          msPerSecond: this.options.structureValidationMsPerSecond,
          shadowIdleMs: this.options.structureShadowIdleMs,
          lockTimeoutMs: STRUCTURE_LOCK_TIMEOUT_MS,
        },
        this.structureCounters,
      );
      const room: RoomState = {
        documentId,
        baseVersionId: loaded.baseVersionId,
        dirty: false,
        lastWriter: null,
        lastVersionAt: Date.now(),
        approxBytes,
        abandoned: false,
        unsaved: false,
        awarenessOwners: new Map(),
        finalState: null,
        pendingMentions: new Map(),
        structure,
        detach: () => undefined,
      };
      structure.attach();
      // Observateurs posés APRÈS le chargement : l'état persisté n'est attribué à personne.
      const tracker = new MentionTracker(doc);
      const onTransaction = (transaction: Y.Transaction): void =>
        this.trackMentions(room, tracker, transaction);
      doc.on('afterTransaction', onTransaction);
      const unguard = installCommentIdentityGuard(
        doc,
        (origin) => this.commentIdentityOf(origin),
        (error) =>
          this.logger.warn(
            `Garde d'identité des commentaires en échec (document=${documentId}) : ${errorMessage(error)}`,
          ),
      );
      room.detach = () => {
        doc.off('afterTransaction', onTransaction);
        unguard();
        structure.dispose();
      };
      this.rooms.set(doc, room);
    } catch (error) {
      if (error instanceof CollabReloadRefusal && documentId !== null) {
        this.logger.warn(`Chargement collaboratif différé : restauration en cours (document=${documentId})`);
        // Fermeture IMMÉDIATE en `Reload` (avant la trame « permission refusée » de Hocuspocus) :
        // le client se reconnecte au lieu de conclure à un document inaccessible.
        for (const state of [...this.sockets.values()]) {
          if (state.roomId === documentId && !state.connected) {
            this.closeSocket(state, CollabCloseCode.Reload, CLOSE_REASON.reload);
          }
        }
        throw error;
      }
      this.logger.error(
        `Chargement collaboratif impossible (document=${documentId ?? '-'}) : ${errorMessage(error)}`,
      );
      // Les sockets qui attendaient cette salle reçoivent le refus uniforme.
      if (documentId !== null) {
        for (const state of [...this.sockets.values()]) {
          if (state.roomId === documentId && !state.connected) {
            this.scheduleClose(state, CollabCloseCode.Unauthorized, CLOSE_REASON.unauthorized);
          }
        }
      }
      throw error;
    }
  }

  private onChange(payload: onChangePayload<CollabConnectionContext>): void {
    const room = this.rooms.get(payload.document);
    if (!room || room.abandoned) return;
    room.approxBytes += payload.update.byteLength;
    // Seules les modifications d'un utilisateur (client ou mutation serveur au nom d'un acteur)
    // justifient une version ; une écriture technique anonyme (méta, correction) ne compte pas.
    const user = (payload.context as CollabConnectionContext | undefined)?.user;
    if (!user) return;
    room.dirty = true;
    room.lastWriter = user;
  }

  private onStoreDocument(payload: onStoreDocumentPayload<CollabConnectionContext>): Promise<void> {
    const doc = payload.document;
    const room = this.rooms.get(doc);
    if (!room || room.abandoned) return Promise.resolve(); // salle réinitialisée : rien de périmé
    const task = this.storeRoom(doc, room);
    this.trackRoom(room.documentId, task);
    return task;
  }

  private async storeRoom(doc: HocuspocusDocument, room: RoomState): Promise<void> {
    // Autosave déjà différé (debounce) : au plus une validation par sauvegarde, aucune si la salle
    // n'a pas changé depuis la dernière validation réussie.
    if (!this.ensureLiveStructure(doc, room, 'sauvegarde automatique')) return;
    const state = this.encodeRoomState(doc, room.documentId);
    room.approxBytes = state.byteLength;
    if (state.byteLength > this.options.maxStateBytes) {
      this.logger.error(
        `Document ${room.documentId} : état trop volumineux (${state.byteLength} o), non persisté ; salle abandonnée`,
      );
      this.abandonRoom(doc.name, doc, CollabCloseCode.PolicyViolation, CLOSE_REASON.policy);
      return;
    }
    try {
      await this.persistence.saveWorkingState(room.documentId, state, room.baseVersionId);
      room.unsaved = false;
    } catch (error) {
      room.unsaved = true;
      this.logger.error(
        `Autosave collaboratif en échec (document=${room.documentId}) : ${errorMessage(error)}`,
      );
      throw error; // Hocuspocus ne programme pas de déchargement ; `beforeUnload` retentera
    }
    // Réinitialisée pendant la sauvegarde (restauration) : ni notification ni version périmées.
    if (room.abandoned) return;
    this.flushMentions(room, doc);

    const writer = room.lastWriter;
    if (room.dirty && Date.now() - room.lastVersionAt >= this.options.idleVersionIntervalMs) {
      room.dirty = false;
      room.lastVersionAt = Date.now();
      try {
        const created = await this.persistence.createVersion(room.documentId, state, writer, {
          reason: 'idle',
        });
        // L'état de travail suivant dérive de cette nouvelle version : sans ce suivi, il serait
        // ignoré au rechargement (baseVersionId périmé).
        if (created) room.baseVersionId = created.documentVersionId;
      } catch (error) {
        room.dirty = true;
        this.logger.error(
          `Version automatique en échec (document=${room.documentId}) : ${errorMessage(error)}`,
        );
      }
    }
  }

  private onDisconnect(payload: onDisconnectPayload<CollabConnectionContext>): void {
    const room = this.rooms.get(payload.document);
    const socketKey = payload.context?.socketKey;
    if (!room || !socketKey) return;
    for (const [clientId, owner] of [...room.awarenessOwners]) {
      if (owner === socketKey) room.awarenessOwners.delete(clientId);
    }
  }

  /**
   * Avant déchargement : si le dernier autosave a échoué, nouvelle tentative ; un nouvel échec
   * REJETTE, ce qui garde la salle en mémoire (Hocuspocus annule le déchargement) — le balayage
   * périodique retentera. Jamais de perte silencieuse des dernières modifications.
   */
  private async beforeUnload(payload: beforeUnloadDocumentPayload): Promise<void> {
    const room = this.rooms.get(payload.document);
    if (!room) return;
    if (!room.abandoned && (room.unsaved || room.dirty)) {
      const verdict = room.structure.checkLive();
      if (!verdict.ok) {
        // Jamais d'écriture d'un état non conforme : ni sauvegarde finale ni version de fermeture.
        // La salle se décharge ; la prochaine ouverture repart du dernier état persisté (valide).
        this.logger.error(
          `Document ${room.documentId} : structure du contenu non conforme au déchargement (${verdict.reason}) ; rien n’est persisté`,
        );
        room.abandoned = true;
        room.pendingMentions.clear();
      }
    }
    if (!room.abandoned && room.unsaved) {
      const state = this.encodeRoomState(payload.document, room.documentId);
      if (state.byteLength <= this.options.maxStateBytes) {
        const save = this.persistence.saveWorkingState(room.documentId, state, room.baseVersionId);
        this.trackRoom(room.documentId, save);
        try {
          await save;
          room.unsaved = false;
        } catch (error) {
          this.logger.error(
            `Salle ${room.documentId} conservée en mémoire : sauvegarde impossible (${errorMessage(error)})`,
          );
          throw rejection(CollabCloseCode.PolicyViolation, 'unsaved');
        }
        if (!room.abandoned) this.flushMentions(room, payload.document);
      }
    }
    if (!room.abandoned && room.dirty) {
      const state = this.encodeRoomState(payload.document, room.documentId);
      room.finalState = state.byteLength <= this.options.maxStateBytes ? state : null;
    }
    this.unloadingRooms.set(payload.documentName, room);
  }

  /** Dernière connexion fermée et salle déchargée : version « close » s'il y a eu des modifications. */
  private afterUnload(payload: afterUnloadDocumentPayload): void {
    const room = this.unloadingRooms.get(payload.documentName);
    this.unloadingRooms.delete(payload.documentName);
    room?.detach();
    if (!room || room.abandoned || !room.dirty || !room.finalState) return;
    const state = room.finalState;
    room.finalState = null;
    room.dirty = false;
    this.trackRoom(
      room.documentId,
      this.persistence
        .createVersion(room.documentId, state, room.lastWriter, { reason: 'close' })
        .catch((error) =>
          this.logger.error(
            `Version de fermeture en échec (document=${room.documentId}) : ${errorMessage(error)}`,
          ),
        ),
    );
  }

  // --------------------------------------------------------------------------------- internes

  /**
   * Abandonne une salle : plus rien n'en est persisté (ni état de travail, ni version, ni
   * notification), ses connexions sont fermées avec `code`, et elle est retirée de Hocuspocus tout
   * de suite pour que la prochaine ouverture recharge depuis la persistance. Idempotent.
   */
  private abandonRoom(name: string, doc: HocuspocusDocument, code: number, reason: string): void {
    const room = this.rooms.get(doc);
    if (room) {
      room.abandoned = true;
      room.pendingMentions.clear();
      room.detach();
    }
    const documentId = parseRoomName(name);
    if (documentId !== null) {
      this.pendingLoads.delete(documentId);
      this.closeRoomSockets(documentId, code, reason);
    }
    for (const connection of doc.getConnections()) {
      try {
        connection.close({ code, reason });
      } catch {
        /* déjà fermée */
      }
    }
    if (this.hocuspocus.documents.get(name) === doc) this.hocuspocus.documents.delete(name);
    this.unloadingRooms.delete(name);
    setImmediate(() => {
      try {
        if (!doc.isDestroyed) doc.destroy();
      } catch {
        /* sans effet */
      }
    });
  }

  /**
   * État encodé de la salle, SANS structures en attente : `Y.encodeStateAsUpdate` les recopierait
   * (état jamais intégrable, puis propagé aux versions et aux autres clients). Elles sont écartées
   * (journalisé) — en pratique jamais, la garde de `beforeSync` les refusant en amont.
   */
  private encodeRoomState(doc: Y.Doc, documentId: number): Uint8Array {
    if (purgePendingUpdates(doc)) {
      this.logger.error(`Document ${documentId} : structures Yjs en attente écartées avant encodage`);
    }
    return Y.encodeStateAsUpdate(doc);
  }

  // --------------------------------------------------------------------- mentions et identité

  /** Utilisateur authentifié d'une transaction CLIENT (socket), `null` sinon. */
  private clientUserOf(origin: unknown): AuthUser | null {
    if (!isPlainObject(origin) || origin.source !== 'connection') return null;
    const connection = origin.connection as { context?: CollabConnectionContext } | undefined;
    return connection?.context?.user ?? null;
  }

  /** Auteur d'une transaction : client authentifié, ou acteur d'une mutation serveur. */
  private writerOf(origin: unknown): AuthUser | null {
    const client = this.clientUserOf(origin);
    if (client) return client;
    if (origin === SERVER_FIX_ORIGIN || !isPlainObject(origin) || origin.source !== 'local') {
      return null;
    }
    const context = origin.context as CollabConnectionContext | undefined;
    return context?.user ?? null;
  }

  /**
   * Identité imposée aux commentaires créés/résolus par une connexion CLIENT. Les mutations
   * serveur (REST, import) sont du code de confiance qui fixe lui-même l'auteur : non réécrites.
   */
  private commentIdentityOf(origin: unknown): CollabIdentity | null {
    const user = this.clientUserOf(origin);
    if (!user) return null;
    return { userGroupId: user.userGroupId ?? 0, name: actorName(user) };
  }

  /**
   * Après chaque transaction : les mentions qu'elle introduit sont attribuées à SON auteur (une
   * transaction = un message d'une seule connexion, ou une mutation serveur d'un seul acteur).
   * Un id réintroduit par un autre auteur avant la sauvegarde lui est réattribué.
   */
  private trackMentions(room: RoomState, tracker: MentionTracker, transaction: Y.Transaction): void {
    try {
      if (room.abandoned) return;
      const ids = tracker.added(transaction);
      if (ids.length === 0) return;
      const user = this.writerOf(transaction.origin);
      if (!user) return; // écriture anonyme : connue, jamais notifiée
      for (const [userId, entry] of room.pendingMentions) {
        if (userId !== user.userId) for (const id of ids) entry.ids.delete(id);
      }
      let entry = room.pendingMentions.get(user.userId);
      if (!entry) {
        entry = { user, ids: new Set() };
        room.pendingMentions.set(user.userId, entry);
      }
      for (const id of ids) entry.ids.add(id);
    } catch (error) {
      this.logger.warn(
        `Suivi des mentions en échec (document=${room.documentId}) : ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Après une sauvegarde réussie : une notification par auteur, avec SES seules mentions encore
   * présentes. Hors chemin critique : un échec ne bloque ni ne fait échouer l'autosave.
   */
  private flushMentions(room: RoomState, doc: Y.Doc): void {
    if (room.pendingMentions.size === 0) return;
    const batches = [...room.pendingMentions.values()];
    room.pendingMentions.clear();
    const present = new Set(extractMentionIds(doc));
    for (const { user, ids } of batches) {
      const mentionIds = [...ids].filter((id) => present.has(id)).sort((a, b) => a - b);
      if (mentionIds.length === 0) continue;
      this.trackRoom(
        room.documentId,
        Promise.resolve()
          .then(() => this.persistence.notifyMentions(room.documentId, doc, user, { mentionIds }))
          .catch((error) =>
            this.logger.warn(
              `Notification de mentions en échec (document=${room.documentId}) : ${errorMessage(error)}`,
            ),
          ),
      );
    }
  }

  private roomNameOf(documentId: number): string {
    const name = String(documentId);
    if (parseRoomName(name) !== documentId) throw new Error('Identifiant de document invalide');
    return name;
  }

  private socketOf(context: CollabConnectionContext | undefined): SocketState | undefined {
    const key = context?.socketKey;
    return key ? this.sockets.get(key) : undefined;
  }

  private countConnections(filter: (s: SocketState) => boolean): number {
    let n = 0;
    for (const s of this.sockets.values()) if (!s.closed && s.authenticated && filter(s)) n += 1;
    return n;
  }

  private logRefusal(
    motive: string,
    documentId: number | null,
    userId: number | null,
    ip: string | null,
  ): void {
    // Jamais de jeton ni de détail de vérification : motif, document, utilisateur, IP.
    this.logger.warn(
      `Connexion collaborative refusée (${motive}) document=${documentId ?? '-'} utilisateur=${userId ?? '-'} ip=${ip ?? '-'}`,
    );
  }

  /** Durée plancher (avec gigue) d'un refus : jeton faux, document inconnu ou refusé se ressemblent. */
  private async padRefusal(started: number): Promise<void> {
    const { refusalMinDelayMs, refusalJitterMs } = this.options;
    const target = refusalMinDelayMs + (refusalJitterMs > 0 ? randomInt(refusalJitterMs + 1) : 0);
    const remaining = target - (Date.now() - started);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }

  private track(task: Promise<unknown>): void {
    const guarded = task.catch((error) =>
      this.logger.error(`Tâche collaborative en échec : ${errorMessage(error)}`),
    );
    this.pendingTasks.add(guarded);
    void guarded.finally(() => this.pendingTasks.delete(guarded));
  }

  /**
   * Suit une tâche de persistance d'un document (attendue par `drainTasks` ET `resetRoom`). Ses
   * erreurs sont journalisées par la tâche elle-même ; ici elles sont seulement absorbées.
   */
  private trackRoom(documentId: number, task: Promise<unknown>): void {
    const guarded: Promise<void> = task.then(
      () => undefined,
      () => undefined,
    );
    let set = this.roomTasks.get(documentId);
    if (!set) {
      set = new Set();
      this.roomTasks.set(documentId, set);
    }
    const tasks = set;
    tasks.add(guarded);
    this.pendingTasks.add(guarded);
    void guarded.finally(() => {
      tasks.delete(guarded);
      if (tasks.size === 0 && this.roomTasks.get(documentId) === tasks) {
        this.roomTasks.delete(documentId);
      }
      this.pendingTasks.delete(guarded);
    });
  }

  /** Attend les tâches de persistance engagées pour un document (et celles qu'elles engagent). */
  private async waitRoomTasks(documentId: number): Promise<void> {
    for (let pass = 0; pass < RESET_WAIT_PASSES; pass += 1) {
      const tasks = this.roomTasks.get(documentId);
      if (!tasks || tasks.size === 0) return;
      await Promise.allSettled([...tasks]);
    }
  }

  /** Exécute un hook non attendu par Hocuspocus : une exception ne doit jamais tuer le process. */
  private async safe(hook: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(`Hook collaboratif ${hook} en échec : ${errorMessage(error)}`);
    }
  }
}
