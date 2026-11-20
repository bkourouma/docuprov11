import { EDITOR_LIMITS } from '@archivage/editor';
import { MAX_TRUSTED_PROXY_HOPS } from './collab-client-ip';

/** Jeton d'injection du port de persistance (implémenté par `CollabPersistenceService`). */
export const COLLAB_PERSISTENCE = 'COLLAB_PERSISTENCE';
/** Jeton d'injection (facultatif) des réglages du serveur collaboratif ; sert surtout aux tests. */
export const COLLAB_SERVER_OPTIONS = 'COLLAB_SERVER_OPTIONS';

/**
 * Réglages du serveur collaboratif. Tous ont une valeur par défaut prudente ; seuls `CORS_ORIGIN`
 * (lu comme le fait `main.ts`) et `COLLAB_TRUST_PROXY` (sauts de proxy de confiance) viennent de
 * l'environnement.
 */
export interface CollabServerOptions {
  /** Taille max d'un message applicatif (octets) ; au-delà : fermeture `PolicyViolation`. */
  maxMessageBytes: number;
  /** Taille max de l'état Yjs encodé d'un document : jamais chargé, appliqué ni persisté au-delà. */
  maxStateBytes: number;
  /** Délai pour recevoir l'authentification après l'ouverture du socket. */
  authTimeoutMs: number;
  /** Fermeture d'une connexion authentifiée silencieuse (aucun message ni pong). */
  idleTimeoutMs: number;
  /** Période du balayage : expiration des JWT, ping des sockets, ménage. */
  sweepIntervalMs: number;
  /** Plancher de durée d'un refus (uniformise le timing des refus : pas d'oracle d'existence). */
  refusalMinDelayMs: number;
  /** Gigue ajoutée au plancher de refus. */
  refusalJitterMs: number;
  maxConnectionsPerDocument: number;
  maxConnectionsPerUser: number;
  /**
   * Sockets simultanés par adresse IP (contrôlé dès l'upgrade HTTP). L'adresse est celle du socket,
   * ou celle de `X-Forwarded-For` lue à `trustProxy` sauts si un proxy de confiance est déclaré.
   */
  maxConnectionsPerIp: number;
  /**
   * Nombre de proxys de confiance devant l'API (`COLLAB_TRUST_PROXY`) ; 0 = `X-Forwarded-For`
   * ignoré (défaut : l'en-tête est forgeable par n'importe quel client).
   */
  trustProxy: number;
  /** Plafond global de sockets ouverts. */
  maxSockets: number;
  /** Débit par connexion : messages/s soutenus et rafale. */
  messagesPerSecond: number;
  messageBurst: number;
  /** Débit par connexion : octets/s soutenus et rafale (>= `maxMessageBytes`). */
  bytesPerSecond: number;
  byteBurst: number;
  /** Autosave : debounce et délai maximal de `onStoreDocument`. */
  storeDebounceMs: number;
  storeMaxDebounceMs: number;
  /** Intervalle minimal entre deux versions automatiques « idle » d'un même document. */
  idleVersionIntervalMs: number;
  /** Attente maximale de l'arrêt propre (salles stockées, versions de fermeture). */
  shutdownTimeoutMs: number;
  /** Origines autorisées à l'upgrade ; vide = pas de contrôle (comme `enableCors` sans CORS_ORIGIN). */
  allowedOrigins: string[];
  /** Nombre max d'identifiants d'awareness qu'une connexion peut revendiquer. */
  maxAwarenessClientsPerConnection: number;
  /** Taille max (JSON) d'un état d'awareness. */
  maxAwarenessStateBytes: number;
  /**
   * Structure du contenu (fragment ProseMirror) : profondeur d'éléments et nombre de nœuds
   * maximaux. Une mise à jour qui produirait un fragment non conforme (schéma, profondeur, taille)
   * est refusée avant application ; un état persisté non conforme n'est pas chargé.
   */
  maxStructureDepth: number;
  maxStructureNodes: number;
  /** Budget de calcul de la validation structurelle, par salle : rafale (ms)… */
  structureValidationBurstMs: number;
  /** … et recharge (ms de calcul de validation autorisés par seconde). */
  structureValidationMsPerSecond: number;
  /** Copie de validation d'une salle libérée après cette durée sans mise à jour structurelle. */
  structureShadowIdleMs: number;
  /**
   * Taille max (octets) d'une mise à jour STRUCTURELLE : au-delà, refusée (raison `structure` : le
   * client doit repartir d'un état sain) avant tout calcul de validation.
   */
  maxStructuralUpdateBytes: number;
}

export const DEFAULT_COLLAB_SERVER_OPTIONS: CollabServerOptions = {
  maxMessageBytes: 1024 * 1024,
  maxStateBytes: EDITOR_LIMITS.MAX_STATE_BYTES,
  authTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  sweepIntervalMs: 15_000,
  refusalMinDelayMs: 250,
  refusalJitterMs: 100,
  maxConnectionsPerDocument: 50,
  maxConnectionsPerUser: 20,
  // Sans proxy de confiance déclaré, tous les utilisateurs derrière le reverse proxy (nginx puis
  // Next.js) partagent UNE adresse : la limite par IP devient un plafond global. 200 laisse passer
  // un usage normal (les limites par utilisateur — 20 — et par document — 50 — s'appliquent après
  // l'authentification, `maxSockets` reste le plafond global) tout en bornant un flot de sockets
  // non authentifiés (fermés après `authTimeoutMs`) depuis une même adresse.
  maxConnectionsPerIp: 200,
  trustProxy: 0,
  maxSockets: 2000,
  messagesPerSecond: 60,
  messageBurst: 240,
  bytesPerSecond: 512 * 1024,
  byteBurst: 2 * 1024 * 1024,
  storeDebounceMs: 2000,
  storeMaxDebounceMs: 10_000,
  idleVersionIntervalMs: 10 * 60_000,
  shutdownTimeoutMs: 10_000,
  allowedOrigins: [],
  maxAwarenessClientsPerConnection: 4,
  maxAwarenessStateBytes: 8 * 1024,
  maxStructureDepth: 64,
  maxStructureNodes: 100_000,
  // Au plus ~50 % d'un cœur par salle en régime soutenu, 1 s de rafale : une salle très sollicitée
  // voit ses mises à jour structurelles retardées (contre-pression), le processus reste disponible.
  structureValidationBurstMs: 1000,
  structureValidationMsPerSecond: 500,
  structureShadowIdleMs: 2 * 60_000,
  maxStructuralUpdateBytes: 256 * 1024,
};

/** Entier strictement positif, sinon la valeur par défaut. */
function positiveInt(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** `CORS_ORIGIN` (liste séparée par des virgules) -> origines autorisées, comme `main.ts`. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function resolveCollabServerOptions(
  overrides: Partial<CollabServerOptions> | undefined,
): CollabServerOptions {
  const o: CollabServerOptions = { ...DEFAULT_COLLAB_SERVER_OPTIONS, ...(overrides ?? {}) };
  // Un message légitime de taille maximale doit pouvoir passer le limiteur d'octets.
  o.byteBurst = Math.max(o.byteBurst, o.maxMessageBytes);
  // Valeur de confiance hors bornes (ou non entière) : proxy ignoré, réglage le plus prudent.
  if (!Number.isSafeInteger(o.trustProxy) || o.trustProxy < 0 || o.trustProxy > MAX_TRUSTED_PROXY_HOPS) {
    o.trustProxy = 0;
  }
  // Bornes de structure : jamais désactivables (valeur absurde => défaut prudent).
  const d = DEFAULT_COLLAB_SERVER_OPTIONS;
  o.maxStructureDepth = positiveInt(o.maxStructureDepth, d.maxStructureDepth);
  o.maxStructureNodes = positiveInt(o.maxStructureNodes, d.maxStructureNodes);
  o.structureValidationMsPerSecond = positiveInt(
    o.structureValidationMsPerSecond,
    d.structureValidationMsPerSecond,
  );
  o.maxStructuralUpdateBytes = positiveInt(o.maxStructuralUpdateBytes, d.maxStructuralUpdateBytes);
  if (!Number.isFinite(o.structureValidationBurstMs) || o.structureValidationBurstMs < 0) {
    o.structureValidationBurstMs = d.structureValidationBurstMs;
  }
  return o;
}
