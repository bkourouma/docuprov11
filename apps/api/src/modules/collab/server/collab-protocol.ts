import * as decoding from 'lib0/decoding';

/**
 * Validation stricte de ce qui arrive sur le WebSocket, AVANT de le confier à Hocuspocus.
 * Format Hocuspocus : `varString(nom de salle[\0session]) · varUint(type) · charge`.
 */

/** Types de message (miroir de `MessageType` de Hocuspocus, figé ici pour la validation). */
export const CollabMessageType = {
  Sync: 0,
  Awareness: 1,
  Auth: 2,
  QueryAwareness: 3,
  SyncReply: 4,
  Stateless: 5,
  BroadcastStateless: 6,
  Close: 7,
  SyncStatus: 8,
  Ping: 9,
  Pong: 10,
} as const;

/**
 * Seuls types qu'un client légitime (`@hocuspocus/provider` 4.x) envoie. `BroadcastStateless`
 * (opcode interne au serveur), `SyncReply`/`SyncStatus` (sens serveur -> client) et tout type
 * inconnu ferment la connexion.
 */
export const CLIENT_MESSAGE_TYPES: ReadonlySet<number> = new Set([
  CollabMessageType.Sync,
  CollabMessageType.Awareness,
  CollabMessageType.Auth,
  CollabMessageType.QueryAwareness,
  CollabMessageType.Stateless,
  CollabMessageType.Close,
]);

/** Plus grand `document_id` adressable (colonne INT4). */
export const COLLAB_MAX_DOCUMENT_ID = 2_147_483_647;

/** Nom de salle = id du document en décimal strict. */
const ROOM_NAME_RE = /^[1-9]\d{0,9}$/;
/** Identifiant de session du provider (`sessionAwareness`) : court, alphanumérique. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RAW_KEY_LENGTH = 96;

/** `"42"` -> 42 ; tout le reste (zéro initial, signe, espace, hors INT4…) -> `null`. */
export function parseRoomName(name: unknown): number | null {
  if (typeof name !== 'string' || !ROOM_NAME_RE.test(name)) return null;
  const id = Number(name);
  return id <= COLLAB_MAX_DOCUMENT_ID ? id : null;
}

export interface CollabMessageHeader {
  /** Clé brute d'adressage (`nom` ou `nom\0session`). */
  rawKey: string;
  documentName: string;
  sessionId: string | null;
  type: number;
}

/** Lit l'en-tête d'un message client ; `null` s'il est malformé. Ne jette jamais. */
export function readMessageHeader(bytes: Uint8Array): CollabMessageHeader | null {
  try {
    const decoder = decoding.createDecoder(bytes);
    const rawKey = decoding.readVarString(decoder);
    if (rawKey.length === 0 || rawKey.length > MAX_RAW_KEY_LENGTH) return null;
    if (!decoding.hasContent(decoder)) return null;
    const type = decoding.readVarUint(decoder);
    const sep = rawKey.indexOf('\0');
    const documentName = sep === -1 ? rawKey : rawKey.slice(0, sep);
    const sessionId = sep === -1 ? null : rawKey.slice(sep + 1);
    if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) return null;
    return { rawKey, documentName, sessionId, type };
  } catch {
    return null;
  }
}

/** Pong/Ping applicatifs du provider : un seul octet, sans nom de salle. */
export function isHeartbeat(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength === 1 &&
    (bytes[0] === CollabMessageType.Pong || bytes[0] === CollabMessageType.Ping)
  );
}

/** Paramètres d'URL qui trahissent un jeton : refusés à l'upgrade (le jeton passe par le protocole). */
const TOKEN_QUERY_KEYS = new Set(['token', 'access_token', 'accesstoken', 'jwt', 'auth', 'authorization', 'bearer']);

export function urlCarriesToken(search: URLSearchParams): boolean {
  for (const key of search.keys()) {
    if (TOKEN_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}
