/** Fenêtre glissante par défaut : 10 messages par 60 secondes et par utilisateur. */
export const ASST_MESSAGES_PER_MINUTE_DEFAULT = 10;
export const ASST_MESSAGES_WINDOW_MS = 60_000;
/** Nombre maximal d'utilisateurs suivis en mémoire avant purge forcée des fenêtres échues. */
export const ASST_RATE_LIMITER_MAX_USERS = 10_000;

export interface AsstRateLimiterOptions {
  /** Messages autorisés par fenêtre (entier >= 1). */
  limit?: number;
  windowMs?: number;
  /** Nombre maximal d'utilisateurs suivis (borne mémoire). */
  maxUsers?: number;
  now?: () => number;
}

export type AsstRateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Lit `ASST_MESSAGES_PER_MINUTE` (entier >= 1) ; toute autre valeur donne le défaut. */
export function readMessagesPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ASST_MESSAGES_PER_MINUTE?.trim();
  if (!raw || !/^\d{1,6}$/.test(raw)) return ASST_MESSAGES_PER_MINUTE_DEFAULT;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : ASST_MESSAGES_PER_MINUTE_DEFAULT;
}

/**
 * Limiteur de débit à fenêtre glissante, par utilisateur, EN MÉMOIRE du processus : la limite est donc PAR PROCESSUS
 * (avec N instances de l'API, le plafond effectif est N fois plus haut). Garde-fou contre l'emballement, pas un
 * quota de facturation (celui-ci est porté par la porte de coût). Mémoire bornée : les utilisateurs inactifs sont purgés.
 */
export class AsstMessageRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxUsers: number;
  private readonly now: () => number;
  private readonly hits = new Map<number, number[]>();
  private lastSweep = 0;

  constructor(options: AsstRateLimiterOptions = {}) {
    const limit = options.limit ?? readMessagesPerMinute();
    this.limit = Number.isSafeInteger(limit) && limit >= 1 ? limit : ASST_MESSAGES_PER_MINUTE_DEFAULT;
    this.windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : ASST_MESSAGES_WINDOW_MS;
    this.maxUsers = options.maxUsers && options.maxUsers >= 1 ? Math.floor(options.maxUsers) : ASST_RATE_LIMITER_MAX_USERS;
    this.now = options.now ?? Date.now;
  }

  /** Enregistre un message si la limite le permet ; sinon indique le délai d'attente (secondes, >= 1). */
  tryConsume(userId: number): AsstRateDecision {
    const now = this.now();
    this.sweep(now);
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      const oldest = recent[0] ?? now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return { allowed: true };
  }

  /** Nombre d'utilisateurs actuellement suivis (tests, supervision). */
  get trackedUsers(): number {
    return this.hits.size;
  }

  /** Purge les utilisateurs sans message dans la fenêtre ; au plus une fois par fenêtre, ou si la borne est atteinte. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs && this.hits.size < this.maxUsers) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [userId, times] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || last <= cutoff) this.hits.delete(userId);
    }
    // Borne dure : si tout le monde est encore actif, on évince les plus anciens (ordre d'insertion de la Map).
    while (this.hits.size >= this.maxUsers) {
      const first = this.hits.keys().next();
      if (first.done) break;
      this.hits.delete(first.value);
    }
  }
}
