import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AsstExecutorService } from './asst-executor.service';

const DEFAULT_SWEEP_MS = 60_000;
const BATCH = 200;

/**
 * Balayeur des propositions : clôture les propositions échues et reprend celles restées « en cours ».
 *
 * Décision : minuterie EN PROCESSUS (le projet n'utilise pas @nestjs/schedule, et le worker BullMQ n'a pas
 * accès aux services Nest). Multi-instance sûr : chaque transition d'état est un CAS sur `rowVersion`, donc
 * deux balayeurs concurrents ne peuvent pas traiter deux fois la même proposition.
 *
 * Période : `ASST_EXPIRY_SWEEP_MS` (défaut 60 000 ms) ; désactivé si la valeur est 0/invalide
 * ou si `NODE_ENV === 'test'`.
 */
@Injectable()
export class AsstExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsstExpirySweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly executor: AsstExecutorService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    const raw = process.env.ASST_EXPIRY_SWEEP_MS;
    const period = raw === undefined || raw === '' ? DEFAULT_SWEEP_MS : Number(raw);
    if (!Number.isFinite(period) || period <= 0) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, period);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un passage ; ignoré (0/0) si le précédent n'est pas terminé. Chaque étape est isolée. */
  async tick(): Promise<{ expired: number; interrupted: number }> {
    if (this.running) return { expired: 0, interrupted: 0 };
    this.running = true;
    let expired = 0;
    let interrupted = 0;
    try {
      try {
        expired = await this.executor.expireDue(new Date(), BATCH);
      } catch (e) {
        this.logger.warn(`Expiration des propositions en échec : ${e instanceof Error ? e.name : 'erreur'}`);
      }
      try {
        interrupted = await this.executor.recoverInterrupted(new Date(), BATCH);
      } catch (e) {
        this.logger.warn(`Reprise des propositions interrompues en échec : ${e instanceof Error ? e.name : 'erreur'}`);
      }
    } finally {
      this.running = false;
    }
    return { expired, interrupted };
  }
}
