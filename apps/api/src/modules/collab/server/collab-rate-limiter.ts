/**
 * Limitation de débit par connexion (seau à jetons) : messages/s ET octets/s. Pur et déterministe
 * (l'horloge est passée en paramètre) pour être testé sans minuterie.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(amount: number, now: number): boolean {
    const elapsedSeconds = Math.max(0, now - this.last) / 1000;
    this.last = Math.max(this.last, now);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    if (amount > this.tokens) return false;
    this.tokens -= amount;
    return true;
  }
}

export interface ConnectionRateLimits {
  messagesPerSecond: number;
  messageBurst: number;
  bytesPerSecond: number;
  byteBurst: number;
}

export class ConnectionRateLimiter {
  private readonly messages: TokenBucket;
  private readonly bytes: TokenBucket;

  constructor(limits: ConnectionRateLimits, now: number = Date.now()) {
    this.messages = new TokenBucket(limits.messageBurst, limits.messagesPerSecond, now);
    this.bytes = new TokenBucket(limits.byteBurst, limits.bytesPerSecond, now);
  }

  /** `false` = débit dépassé (la connexion doit être fermée). */
  allow(byteLength: number, now: number = Date.now()): boolean {
    const messageOk = this.messages.take(1, now);
    const bytesOk = this.bytes.take(byteLength, now);
    return messageOk && bytesOk;
  }
}
