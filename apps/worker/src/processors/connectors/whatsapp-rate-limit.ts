// Lot 2c — limitation de débit des messages WhatsApp SORTANTS (accusés, refus).
//
// Un expéditeur (ou un attaquant qui connaîtrait le numéro) ne doit pas pouvoir faire envoyer un flot
// de messages par le numéro Business : chaque envoi consomme un jeton, par expéditeur et par
// connecteur. Deux implémentations derrière la même interface :
//  - Redis (partagée entre les processus du worker, survit à un redémarrage) ;
//  - mémoire (`SlidingWindowRateLimiter` du paquet connecteurs) : défaut quand aucune connexion
//    Redis n'est fournie (tests, exécution isolée).
// Les clés ne contiennent que des pseudonymes de numéros (jamais un numéro en clair).
import { SlidingWindowRateLimiter } from '@archivage/connectors';

export interface RateLimiter {
  /** Vrai = un jeton est consommé, l'envoi est permis ; faux = limite atteinte. Peut lever (Redis). */
  take(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

/** Limites par défaut (modifiables par injection). */
export const WHATSAPP_OUTBOUND_LIMITS = {
  /** Accusés par expéditeur et par heure. */
  ackPerSenderPerHour: 10,
  /** Messages sortants (accusés + refus) par connecteur et par minute. */
  perConnectorPerMinute: 60,
  /** Refus par expéditeur et par heure (en plus du `jobId` stable côté API). */
  refusePerSenderPerHour: 1,
} as const;

export type WhatsappOutboundLimits = {
  -readonly [K in keyof typeof WHATSAPP_OUTBOUND_LIMITS]: number;
};

/** Le strict nécessaire d'un client Redis (ioredis) : `SET … EX … NX` puis `INCR`. */
export interface RedisCounterClient {
  set(key: string, value: string, mode: 'EX', seconds: number, flag: 'NX'): Promise<unknown>;
  incr(key: string): Promise<number>;
}

/**
 * Fenêtre fixe Redis. `SET key 0 EX n NX` crée la clé AVEC son expiration (jamais de compteur sans
 * TTL, même si le processus s'arrête ensuite), puis `INCR` compte en conservant le TTL.
 */
export function createRedisRateLimiter(
  redis: RedisCounterClient,
  prefix = 'ged:wa:rl:',
): RateLimiter {
  return {
    async take(key, limit, windowSeconds) {
      const k = `${prefix}${key}`;
      await redis.set(k, '0', 'EX', windowSeconds, 'NX');
      const count = await redis.incr(k);
      return count <= limit;
    },
  };
}

/** Limiteur en mémoire du processus : un `SlidingWindowRateLimiter` par couple (limite, fenêtre). */
export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, SlidingWindowRateLimiter>();
  return {
    async take(key, limit, windowSeconds) {
      const id = `${limit}/${windowSeconds}`;
      let bucket = buckets.get(id);
      if (!bucket) {
        bucket = new SlidingWindowRateLimiter({ limit, windowMs: windowSeconds * 1000, now });
        buckets.set(id, bucket);
      }
      return bucket.take(key);
    },
  };
}
