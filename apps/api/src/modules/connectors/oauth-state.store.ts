import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import type { OAuthProviderId } from '@archivage/connectors';

/** Jeton d'injection du magasin d'état OAuth (Redis en production, mémoire en test). */
export const GED_OAUTH_STATE_STORE = 'GED_OAUTH_STATE_STORE';

/**
 * Enregistrement côté serveur d'une autorisation en cours. Le vérificateur PKCE n'y figure que
 * CHIFFRÉ (AES-GCM, trousseau des connecteurs) : jamais en clair dans Redis.
 */
export interface OAuthStateRecord {
  uid: number;
  cid: number;
  provider: OAuthProviderId;
  redirectUri: string;
  verifierEnc: string;
  verifierKeyId: string;
}

/** Magasin à USAGE UNIQUE : `take` lit ET supprime atomiquement (un rejeu ne trouve plus rien). */
export interface OAuthStateStore {
  put(nonce: string, record: OAuthStateRecord, ttlSeconds: number): Promise<void>;
  take(nonce: string): Promise<OAuthStateRecord | null>;
}

const KEY_PREFIX = 'ged:oauth:state:';

const NONCE_SHAPE = /^[A-Za-z0-9_-]{22,128}$/;

function isRecord(v: unknown): v is OAuthStateRecord {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.uid === 'number' &&
    Number.isSafeInteger(o.uid) &&
    typeof o.cid === 'number' &&
    Number.isSafeInteger(o.cid) &&
    (o.provider === 'google' || o.provider === 'microsoft') &&
    typeof o.redirectUri === 'string' &&
    typeof o.verifierEnc === 'string' &&
    typeof o.verifierKeyId === 'string'
  );
}

/** Décodage défensif : une valeur illisible ou de mauvaise forme vaut « introuvable ». */
export function parseStateRecord(raw: unknown): OAuthStateRecord | null {
  if (typeof raw !== 'string') return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function assertNonce(nonce: string): void {
  if (typeof nonce !== 'string' || !NONCE_SHAPE.test(nonce)) {
    throw new Error('Nonce OAuth invalide');
  }
}

/** Lecture + suppression atomiques côté Redis, sans dépendre de GETDEL (Redis ≥ 6.2). */
const TAKE_SCRIPT =
  "local v = redis.call('GET', KEYS[1]) if v then redis.call('DEL', KEYS[1]) end return v";

export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(private readonly redis: IORedis) {}

  async put(nonce: string, record: OAuthStateRecord, ttlSeconds: number): Promise<void> {
    assertNonce(nonce);
    // NX : un nonce déjà présent n'est jamais écrasé.
    const res = await this.redis.set(
      KEY_PREFIX + nonce,
      JSON.stringify(record),
      'EX',
      ttlSeconds,
      'NX',
    );
    if (res !== 'OK') throw new Error('Nonce OAuth déjà enregistré');
  }

  async take(nonce: string): Promise<OAuthStateRecord | null> {
    assertNonce(nonce);
    const raw = await this.redis.eval(TAKE_SCRIPT, 1, KEY_PREFIX + nonce);
    return parseStateRecord(raw);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/** Magasin mémoire (tests) : mêmes garanties d'usage unique et de TTL. */
export class InMemoryOAuthStateStore implements OAuthStateStore {
  readonly entries = new Map<string, { raw: string; expiresAt: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  async put(nonce: string, record: OAuthStateRecord, ttlSeconds: number): Promise<void> {
    assertNonce(nonce);
    this.purge();
    if (this.entries.has(nonce)) throw new Error('Nonce OAuth déjà enregistré');
    this.entries.set(nonce, {
      raw: JSON.stringify(record),
      expiresAt: this.nowMs() + ttlSeconds * 1000,
    });
  }

  async take(nonce: string): Promise<OAuthStateRecord | null> {
    assertNonce(nonce);
    const e = this.entries.get(nonce);
    this.entries.delete(nonce);
    if (!e || e.expiresAt <= this.nowMs()) return null;
    return parseStateRecord(e.raw);
  }

  private purge(): void {
    const now = this.nowMs();
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
  }
}

export const oauthStateStoreProvider: Provider = {
  provide: GED_OAUTH_STATE_STORE,
  inject: [ConfigService],
  useFactory: (config: ConfigService): OAuthStateStore =>
    new RedisOAuthStateStore(new IORedis(config.getOrThrow<string>('REDIS_URL'))),
};

/** Ferme la connexion Redis propre au magasin (sans effet pour un autre magasin). */
export async function closeOAuthStateStore(store: OAuthStateStore): Promise<void> {
  if (store instanceof RedisOAuthStateStore) await store.close();
}
