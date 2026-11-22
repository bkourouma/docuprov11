import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';

/** Générations autorisées par utilisateur et par fenêtre. */
export const AUTHORING_RATE_LIMIT_PER_MINUTE = 5;
/** Largeur de la fenêtre glissante. */
export const AUTHORING_RATE_WINDOW_MS = 60_000;
/** Nombre maximal d'utilisateurs suivis : borne dure de la mémoire. */
export const AUTHORING_RATE_MAX_KEYS = 20_000;

/**
 * Limite de débit de la génération de workflows : `AUTHORING_RATE_LIMIT_PER_MINUTE` par utilisateur
 * (`user.userId`), fenêtre glissante. Même principe que `DraftingRateLimitGuard`.
 *
 * LIMITE ASSUMÉE : état en mémoire du processus (non partagé entre instances, perdu au redémarrage).
 * Le budget IA (garde W2) reste la borne de coût ; ce garde freine seulement les rafales.
 */
@Injectable()
export class AuthoringRateLimitGuard implements CanActivate {
  /** Horloge (ms) ; remplaçable en test. */
  clock: () => number = () => Date.now();

  private readonly hits = new Map<number, number[]>();
  private lastPurge = 0;

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const user = http.getRequest<{ user?: AuthUser }>().user;
    // Non authentifié : les gardes d'authentification refusent déjà ; rien à compter ici.
    if (!user) return true;

    const now = this.clock();
    this.purge(now);

    const limit = AUTHORING_RATE_LIMIT_PER_MINUTE;
    const recent = (this.hits.get(user.userId) ?? []).filter((t) => t > now - AUTHORING_RATE_WINDOW_MS);

    if (recent.length >= limit) {
      this.hits.set(user.userId, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0] + AUTHORING_RATE_WINDOW_MS - now) / 1000));
      const res = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();
      res.setHeader?.('Retry-After', String(retryAfter));
      throw new HttpException(
        `Trop de requêtes : limite de ${limit} générations par minute atteinte. Réessayez dans ${retryAfter} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    // Réinsertion : l'ordre d'insertion de la Map suit l'activité (éviction du plus ancien).
    this.hits.delete(user.userId);
    this.hits.set(user.userId, recent);
    while (this.hits.size > AUTHORING_RATE_MAX_KEYS) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    return true;
  }

  /** Nombre d'utilisateurs suivis (tests, supervision). */
  get trackedKeys(): number {
    return this.hits.size;
  }

  private purge(now: number): void {
    if (now - this.lastPurge < AUTHORING_RATE_WINDOW_MS) return;
    this.lastPurge = now;
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= now - AUTHORING_RATE_WINDOW_MS) {
        this.hits.delete(key);
      }
    }
  }
}
