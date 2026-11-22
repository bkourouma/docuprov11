import { WF_TRIGGER_MAX_CONSECUTIVE_FAILURES } from '../domain/contracts';

/** Nombre maximal d'entrées conservées (évite toute fuite mémoire si de nombreux déclencheurs échouent). */
export const WF_TRIGGER_TRACKER_MAX_ENTRIES = 10_000;

interface Entry {
  count: number;
  updatedAtMs: number;
  lastReason: string;
  touchedAt: number;
}

/**
 * Compteur d'échecs CONSÉCUTIFS par déclencheur, en mémoire (un processus). Classe pure, sans dépendance.
 *
 * `observe` détecte qu'un humain a modifié ou réactivé le déclencheur (son `updated_at` a changé) : le compteur
 * repart alors de zéro, sinon un déclencheur réactivé serait désactivé de nouveau dès le premier échec.
 */
export class TriggerFailureTracker {
  private readonly entries = new Map<number, Entry>();

  constructor(private readonly maxFailures: number = WF_TRIGGER_MAX_CONSECUTIVE_FAILURES) {}

  /** Enregistre l'horodatage de mise à jour du déclencheur ; le compteur est remis à zéro s'il a changé. */
  observe(triggerId: number, updatedAtMs: number): void {
    const entry = this.entries.get(triggerId);
    if (!entry) return this.set(triggerId, { count: 0, updatedAtMs, lastReason: '', touchedAt: Date.now() });
    if (entry.updatedAtMs !== updatedAtMs) {
      entry.count = 0;
      entry.lastReason = '';
      entry.updatedAtMs = updatedAtMs;
    }
    entry.touchedAt = Date.now();
  }

  /** Compte un échec ; renvoie le nombre d'échecs consécutifs. */
  fail(triggerId: number, reason: string): number {
    const entry = this.entries.get(triggerId) ?? { count: 0, updatedAtMs: 0, lastReason: '', touchedAt: 0 };
    entry.count += 1;
    entry.lastReason = reason;
    entry.touchedAt = Date.now();
    this.set(triggerId, entry);
    return entry.count;
  }

  /** Un lancement a réussi : la série d'échecs est rompue. */
  success(triggerId: number): void {
    const entry = this.entries.get(triggerId);
    if (entry) {
      entry.count = 0;
      entry.lastReason = '';
      entry.touchedAt = Date.now();
    }
  }

  /** Le seuil d'échecs consécutifs est atteint. */
  reached(triggerId: number): boolean {
    return (this.entries.get(triggerId)?.count ?? 0) >= this.maxFailures;
  }

  count(triggerId: number): number {
    return this.entries.get(triggerId)?.count ?? 0;
  }

  lastReason(triggerId: number): string {
    return this.entries.get(triggerId)?.lastReason ?? '';
  }

  get size(): number {
    return this.entries.size;
  }

  private set(triggerId: number, entry: Entry): void {
    // Réinsertion : la Map garde l'ordre d'insertion, les plus anciennes entrées sont donc en tête.
    this.entries.delete(triggerId);
    this.entries.set(triggerId, entry);
    if (this.entries.size > WF_TRIGGER_TRACKER_MAX_ENTRIES) {
      // Priorité d'éviction : les entrées sans échec en cours, puis les plus anciennes.
      let toDrop = this.entries.size - WF_TRIGGER_TRACKER_MAX_ENTRIES;
      for (const [id, e] of this.entries) {
        if (toDrop <= 0) break;
        if (e.count === 0 && id !== triggerId) {
          this.entries.delete(id);
          toDrop -= 1;
        }
      }
      for (const id of this.entries.keys()) {
        if (toDrop <= 0) break;
        if (id !== triggerId) {
          this.entries.delete(id);
          toDrop -= 1;
        }
      }
    }
  }
}
