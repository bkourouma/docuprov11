import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '../auth/auth.types';

export type SemanticRateBucket = 'search' | 'ask';

/** Clé de métadonnée : compteur de débit auquel une route est soumise (absente = pas de limite). */
export const SEMANTIC_RATE_BUCKET_KEY = 'semantic_rate_bucket';

/** Soumet une route au compteur `search` (20/min) ou `ask` (6/min). */
export const SemanticRateLimit = (bucket: SemanticRateBucket) =>
  SetMetadata(SEMANTIC_RATE_BUCKET_KEY, bucket);

/** Largeur de la fenêtre glissante. */
export const SEMANTIC_RATE_WINDOW_MS = 60_000;
/** Requêtes autorisées par fenêtre et par utilisateur, par compteur. */
export const SEMANTIC_RATE_LIMITS: Record<SemanticRateBucket, number> = { search: 20, ask: 6 };
/** Nombre maximal de clés (utilisateur x compteur) conservées : borne dure de la mémoire. */
export const SEMANTIC_RATE_MAX_KEYS = 20_000;
/** Purge des clés expirées au plus une fois par fenêtre. */
const PURGE_INTERVAL_MS = SEMANTIC_RATE_WINDOW_MS;

/**
 * Limite de débit par utilisateur (`user.userId`), fenêtre glissante, DEUX compteurs séparés.
 *
 * LIMITE ASSUMÉE : l'état est en mémoire du processus. Il n'est pas partagé entre instances de
 * l'API (N instances => jusqu'à N fois la limite) et il est perdu au redémarrage. Suffisant pour
 * borner le coût des appels d'embedding / génération ; un quota strict exigerait Redis.
 *
 * Mémoire bornée : au plus `SEMANTIC_RATE_MAX_KEYS` clés, chacune avec au plus `limite`
 * horodatages ; les clés inactives sont purgées périodiquement.
 */
@Injectable()
export class SemanticRateLimitGuard implements CanActivate {
  /** Horloge (ms) ; remplaçable en test. */
  clock: () => number = () => Date.now();

  private readonly hits = new Map<string, number[]>();
  private lastPurge = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const bucket = this.reflector.get<SemanticRateBucket | undefined>(
      SEMANTIC_RATE_BUCKET_KEY,
      context.getHandler(),
    );
    if (!bucket) return true;
    const http = context.switchToHttp();
    const user = http.getRequest<{ user?: AuthUser }>().user;
    // Non authentifié : les gardes d'authentification refusent déjà ; rien à compter ici.
    if (!user) return true;

    const now = this.clock();
    this.purge(now);

    const key = `${bucket}:${user.userId}`;
    const limit = SEMANTIC_RATE_LIMITS[bucket];
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - SEMANTIC_RATE_WINDOW_MS);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0] + SEMANTIC_RATE_WINDOW_MS - now) / 1000));
      const res = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();
      res.setHeader?.('Retry-After', String(retryAfter));
      throw new HttpException(
        `Trop de requêtes : limite de ${limit} par minute atteinte. Réessayez dans ${retryAfter} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    // Réinsertion : l'ordre d'insertion de la Map suit l'activité (éviction du plus ancien).
    this.hits.delete(key);
    this.hits.set(key, recent);
    this.evictOverflow();
    return true;
  }

  /** Nombre de clés suivies (tests, supervision). */
  get trackedKeys(): number {
    return this.hits.size;
  }

  private purge(now: number): void {
    if (now - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = now;
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= now - SEMANTIC_RATE_WINDOW_MS) {
        this.hits.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    while (this.hits.size > SEMANTIC_RATE_MAX_KEYS) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }
}
