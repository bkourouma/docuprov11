import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

const DEFAULT_INTERVAL_MINUTES = 60;

/** Intervalle de purge en minutes : défaut 60 ; 0 = désactivée ; valeur illisible ou négative = défaut. */
export function asstPurgeIntervalMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.floor(n);
}

/**
 * Purge physique des échanges de l'assistant dont `purge_at` est échue (échanges masqués sans trace d'exécution, dont
 * le masquage a ramené `purge_at` à l'instant du masquage, ou arrivés au terme de la rétention). Un échange masqué qui
 * porte une trace d'exécution (proposition appliquée ou en échec) garde sa `purge_at` d'origine : il n'est pas
 * sélectionné avant l'échéance, donc jamais compté en erreur. Chaque conversation est supprimée SEULE (la cascade emporte messages et
 * propositions) : si les déclencheurs refusent (proposition confirmée en cours d'exécution, trace d'exécution encore
 * sous rétention), elle est comptée « skipped » et retentée au passage suivant. Rien du contenu n'est journalisé.
 */
@Injectable()
export class AsstPurgeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AsstPurgeService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const minutes = asstPurgeIntervalMinutes(process.env.ASST_PURGE_INTERVAL_MINUTES);
    if (minutes === 0) return;
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
    this.timer.unref();
    this.logger.log(`purge des échanges de l'assistant planifiée toutes les ${minutes} minute(s)`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Un passage planifié : ne se chevauche jamais, ne lève jamais, journalise des compteurs seulement. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { purged, skipped } = await this.purgeDue(new Date());
      if (purged > 0 || skipped > 0) this.logger.log(`purge assistant : ${purged} supprimé(s), ${skipped} différé(s)`);
    } catch (err) {
      this.logger.warn(`purge assistant impossible : ${err instanceof Error ? err.name : 'erreur inconnue'}`);
    } finally {
      this.running = false;
    }
  }

  async purgeDue(now: Date, limit = 100): Promise<{ purged: number; skipped: number }> {
    const due = await this.prisma.asstConversation.findMany({
      where: { purgeAt: { lte: now } },
      orderBy: [{ purgeAt: 'asc' }, { asstConversationId: 'asc' }],
      take: Math.max(0, limit),
      select: { asstConversationId: true },
    });
    let purged = 0;
    let skipped = 0;
    for (const { asstConversationId } of due) {
      try {
        const { count } = await this.prisma.asstConversation.deleteMany({
          where: { asstConversationId, purgeAt: { lte: now } },
        });
        if (count > 0) purged += 1;
      } catch (err) {
        // Déclencheur ou contrainte : cause métier attendue ; on ne journalise ni identifiant utilisateur ni contenu.
        skipped += 1;
        this.logger.warn(`purge assistant : suppression différée (${err instanceof Error ? err.name : 'erreur'})`);
      }
    }
    return { purged, skipped };
  }
}
