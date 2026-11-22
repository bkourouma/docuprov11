import { Injectable } from '@nestjs/common';
import { AsstError } from '../assistant.contracts';

/** Nombre maximal de confirmations par utilisateur et par fenêtre glissante. */
export const ASST_CONFIRM_MAX_PER_MINUTE = 10;

const WINDOW_MS = 60_000;
/** Au-delà, on purge les utilisateurs sans horodatage récent pour borner la mémoire. */
const MAX_TRACKED_USERS = 10_000;

/**
 * Limiteur de confirmations : fenêtre glissante de 60 s par utilisateur, tenue EN MÉMOIRE.
 * Limite assumée : le compteur est propre à chaque processus (pas de partage entre instances) ;
 * il protège contre les rafales d'un client, pas contre un attaquant réparti sur plusieurs instances.
 * Les tentatives refusées ne sont pas enregistrées : elles ne rallongent donc pas la fenêtre.
 */
@Injectable()
export class AsstConfirmLimiter {
  private readonly hits = new Map<number, number[]>();

  /** Enregistre une tentative ; lève `budget_exceeded` si la limite est atteinte dans la fenêtre. */
  consume(userId: number, now: Date): void {
    const t = now.getTime();
    const recent = (this.hits.get(userId) ?? []).filter((h) => t - h < WINDOW_MS);
    if (recent.length >= ASST_CONFIRM_MAX_PER_MINUTE) {
      this.hits.set(userId, recent);
      throw new AsstError('budget_exceeded', 'Trop de confirmations en peu de temps : réessayez dans une minute.');
    }
    recent.push(t);
    this.hits.set(userId, recent);
    if (this.hits.size > MAX_TRACKED_USERS) this.purge(t);
  }

  private purge(t: number): void {
    for (const [id, list] of this.hits) {
      if (!list.some((h) => t - h < WINDOW_MS)) this.hits.delete(id);
    }
  }

  /** Nombre d'utilisateurs suivis (tests). */
  get trackedUsers(): number {
    return this.hits.size;
  }
}
