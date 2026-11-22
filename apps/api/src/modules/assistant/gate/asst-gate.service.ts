import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ASST_GATE_DEFINITION_ID } from '@archivage/types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AgentBlockedError,
  WF_AGENT_GATE,
  type AgentReservation,
  type AgentUsage,
  type WfAgentGate,
} from '../../workflow-agents/agent.contracts';
import {
  AsstError,
  type AsstGatePort,
  type AsstReservation,
  type AsstUserCap,
} from '../assistant.contracts';

// Assistant — porte de coût : plafond par utilisateur et par jour UTC (`asst_user_budget`) PUIS porte globale
// des agents (`WfAgentGate`, `definitionId = ASST_GATE_DEFINITION_ID` = 0, ligne globale de `wf_budget` seule).
//
// HYPOTHÈSE MÉTIER (plafonds par utilisateur, lus à CHAQUE création de ligne du jour ; une ligne existante
// n'est jamais modifiée par un changement de configuration) :
//   - ASST_USER_DAILY_CAP_AMOUNT : montant maximal par utilisateur et par jour, dans la devise du budget.
//     Défaut 3000 (ordre de grandeur : une soixantaine d'appels au tarif par défaut de `AgentGateService.costOf`).
//   - ASST_USER_DAILY_CAP_TOKENS : jetons maximaux par utilisateur et par jour. Défaut 500000.
//   - Valeur `none` (insensible à la casse) = pas de plafond (NULL) ; valeur non numérique ou négative = défaut.
//
// ATOMICITÉ : la réservation utilisateur est UN `UPDATE` conditionnel ; la porte globale est appelée ensuite et, si
// elle refuse ou échoue, la ligne utilisateur est compensée (aucune réservation partielle ne subsiste).
// ÉCHEC FERMÉ : toute erreur inattendue (SQL, réseau) devient `assistant_unavailable`. Aucun log ni message ne
// contient de détail technique ni de contenu : identifiants et types d'erreur seulement.

const DEFAULT_CAP_AMOUNT = 3000;
const DEFAULT_CAP_TOKENS = 500_000;
/** Borne de la mémoire des réservations (purge des plus anciennes au-delà). */
const MAX_TRACKED = 10_000;

const UNAVAILABLE = 'L’assistant est momentanément indisponible.';
const EXCEEDED = 'Votre plafond d’utilisation de l’assistant pour aujourd’hui est atteint.';

interface Tracked {
  day: string;
  userId: number;
  reserved: AgentUsage;
  globalReservationId: string;
}

interface CapRow {
  cap_amount: number | null;
  cap_tokens: number | null;
  consumed_amount: number;
  consumed_tokens: number;
}

/** Lit un plafond d'environnement : nombre >= 0, `none` = pas de plafond (null), sinon valeur par défaut. */
function envCap(name: string, fallback: number): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim().toLowerCase() === 'none') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const safeCount = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
const tokensOf = (u: AgentUsage): number =>
  Math.round(safeCount(u.promptTokens) + safeCount(u.completionTokens));
/** Jour UTC `AAAA-MM-JJ`. */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

@Injectable()
export class AsstGateService implements AsstGatePort {
  private readonly logger = new Logger(AsstGateService.name);
  /** Horloge (surchargeable dans les tests). */
  now: () => Date = () => new Date();
  private readonly open = new Map<string, Tracked>();
  private readonly done = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WF_AGENT_GATE) private readonly wfGate: WfAgentGate,
  ) {}

  // -------------------------------------------------------------------------------------------

  async assertRunnable(userId: number): Promise<void> {
    try {
      await this.wfGate.assertRunnable({ definitionId: ASST_GATE_DEFINITION_ID });
    } catch (err) {
      throw this.mapGateError(err, 'assertRunnable');
    }
    let cap: AsstUserCap;
    try {
      cap = await this.readCap(userId, utcDay(this.now()));
    } catch (err) {
      this.logFailure('assertRunnable', err);
      throw new AsstError('assistant_unavailable', UNAVAILABLE);
    }
    if (
      (cap.capAmount !== null && cap.consumedAmount >= cap.capAmount) ||
      (cap.capTokens !== null && cap.consumedTokens >= cap.capTokens)
    ) {
      throw new AsstError('budget_exceeded', EXCEEDED);
    }
  }

  async reserve(userId: number, estimate: AgentUsage): Promise<AsstReservation> {
    if (
      ![estimate.cost, estimate.promptTokens, estimate.completionTokens].every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    ) {
      throw new AsstError('assistant_unavailable', UNAVAILABLE);
    }
    const day = utcDay(this.now());
    const cost = estimate.cost.toFixed(4);
    const tokens = tokensOf(estimate);

    // (2)-(3) ligne du jour puis réservation conditionnelle sur l'utilisateur.
    let granted: boolean;
    try {
      const capAmount = envCap('ASST_USER_DAILY_CAP_AMOUNT', DEFAULT_CAP_AMOUNT);
      const capTokens = envCap('ASST_USER_DAILY_CAP_TOKENS', DEFAULT_CAP_TOKENS);
      const capAmountSql = capAmount === null ? null : capAmount.toFixed(4);
      await this.prisma.$executeRaw`
        INSERT INTO "asst_user_budget" ("user_id", "day", "cap_amount", "cap_tokens")
        VALUES (${userId}, ${day}::date, ${capAmountSql}::numeric, ${capTokens}::bigint)
        ON CONFLICT ("user_id", "day") DO NOTHING`;
      const rows = await this.prisma.$queryRaw<{ asst_user_budget_id: number }[]>`
        UPDATE "asst_user_budget"
           SET "consumed_amount" = "consumed_amount" + ${cost}::numeric,
               "consumed_tokens" = "consumed_tokens" + ${tokens}::bigint,
               "call_count" = "call_count" + 1,
               "updated_at" = now()
         WHERE "user_id" = ${userId} AND "day" = ${day}::date
           AND ("cap_amount" IS NULL OR "consumed_amount" + ${cost}::numeric <= "cap_amount")
           AND ("cap_tokens" IS NULL OR "consumed_tokens" + ${tokens}::bigint <= "cap_tokens")
        RETURNING "asst_user_budget_id"`;
      granted = rows.length > 0;
    } catch (err) {
      this.logFailure('reserve', err);
      throw new AsstError('assistant_unavailable', UNAVAILABLE);
    }
    if (!granted) throw new AsstError('budget_exceeded', EXCEEDED);

    // (4) porte globale ; en cas de refus ou d'échec, compensation de la ligne utilisateur.
    let globalReservation: AgentReservation;
    try {
      globalReservation = await this.wfGate.reserve(
        { definitionId: ASST_GATE_DEFINITION_ID },
        estimate,
      );
    } catch (err) {
      await this.adjustUser(userId, day, -safeCount(estimate.cost), -tokens, -1);
      throw this.mapGateError(err, 'reserve');
    }

    // (5)
    const reservation: AsstReservation = {
      id: randomUUID(),
      userId,
      reserved: { ...estimate },
      globalReservationId: globalReservation.id,
    };
    this.remember(reservation.id, {
      day,
      userId,
      reserved: { ...estimate },
      globalReservationId: globalReservation.id,
    });
    return reservation;
  }

  async settle(reservation: AsstReservation, actual: AgentUsage): Promise<void> {
    try {
      const tracked = this.take(reservation);
      if (!tracked) return;
      const deltaCost = safeCount(actual.cost) - safeCount(reservation.reserved.cost);
      const deltaTokens = tokensOf(actual) - tokensOf(reservation.reserved);
      await this.adjustUser(tracked.userId, tracked.day, deltaCost, deltaTokens, 0);
      await this.safeGlobal('settle', () => this.wfGate.settle(this.globalOf(reservation), actual));
    } catch (err) {
      this.logFailure('settle', err);
    }
  }

  async release(reservation: AsstReservation): Promise<void> {
    try {
      const tracked = this.take(reservation);
      if (!tracked) return;
      await this.adjustUser(
        tracked.userId,
        tracked.day,
        -safeCount(reservation.reserved.cost),
        -tokensOf(reservation.reserved),
        -1,
      );
      await this.safeGlobal('release', () => this.wfGate.release(this.globalOf(reservation)));
    } catch (err) {
      this.logFailure('release', err);
    }
  }

  async userCap(userId: number, now?: Date): Promise<AsstUserCap> {
    try {
      return await this.readCap(userId, utcDay(now ?? this.now()));
    } catch (err) {
      this.logFailure('userCap', err);
      throw new AsstError('assistant_unavailable', UNAVAILABLE);
    }
  }

  // -------------------------------------------------------------------------------------------

  private async readCap(userId: number, day: string): Promise<AsstUserCap> {
    const rows = await this.prisma.$queryRaw<CapRow[]>`
      SELECT "cap_amount"::float8 AS "cap_amount", "cap_tokens"::float8 AS "cap_tokens",
             "consumed_amount"::float8 AS "consumed_amount", "consumed_tokens"::float8 AS "consumed_tokens"
        FROM "asst_user_budget"
       WHERE "user_id" = ${userId} AND "day" = ${day}::date`;
    const row = rows[0];
    if (!row) {
      return {
        capAmount: envCap('ASST_USER_DAILY_CAP_AMOUNT', DEFAULT_CAP_AMOUNT),
        capTokens: envCap('ASST_USER_DAILY_CAP_TOKENS', DEFAULT_CAP_TOKENS),
        consumedAmount: 0,
        consumedTokens: 0,
      };
    }
    const num = (v: number | null): number | null =>
      v === null || v === undefined ? null : Number(v);
    return {
      capAmount: num(row.cap_amount),
      capTokens: num(row.cap_tokens),
      consumedAmount: Number(row.consumed_amount),
      consumedTokens: Number(row.consumed_tokens),
    };
  }

  /** Delta signé sur la ligne utilisateur ; jamais sous 0 ; aucun plafond opposé ; ne lève jamais. */
  private async adjustUser(
    userId: number,
    day: string,
    deltaCost: number,
    deltaTokens: number,
    calls: number,
  ): Promise<void> {
    const cost = deltaCost.toFixed(4);
    try {
      await this.prisma.$executeRaw`
        UPDATE "asst_user_budget"
           SET "consumed_amount" = GREATEST(0, "consumed_amount" + ${cost}::numeric),
               "consumed_tokens" = GREATEST(0, "consumed_tokens" + ${deltaTokens}::bigint),
               "call_count" = GREATEST(0, "call_count" + ${calls}::int),
               "updated_at" = now()
         WHERE "user_id" = ${userId} AND "day" = ${day}::date`;
    } catch (err) {
      this.logFailure('adjust', err);
    }
  }

  private async safeGlobal(op: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logFailure(`${op} global`, err);
    }
  }

  private globalOf(r: AsstReservation): AgentReservation {
    return {
      id: r.globalReservationId,
      definitionId: ASST_GATE_DEFINITION_ID,
      reserved: { ...r.reserved },
    };
  }

  /** Retire la réservation de la mémoire et la marque soldée ; `null` si déjà soldée (idempotence). */
  private take(r: AsstReservation): Tracked | null {
    if (this.done.has(r.id)) return null;
    const tracked: Tracked = this.open.get(r.id) ?? {
      day: utcDay(this.now()),
      userId: r.userId,
      reserved: r.reserved,
      globalReservationId: r.globalReservationId,
    };
    this.open.delete(r.id);
    if (this.done.size >= MAX_TRACKED) {
      const oldest = this.done.values().next().value;
      if (oldest !== undefined) this.done.delete(oldest);
    }
    this.done.add(r.id);
    return tracked;
  }

  private remember(id: string, t: Tracked): void {
    if (this.open.size >= MAX_TRACKED) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.open.set(id, t);
  }

  private mapGateError(err: unknown, op: string): AsstError {
    if (err instanceof AgentBlockedError) {
      switch (err.reason) {
        case 'budget_exceeded_global':
        case 'budget_exceeded_workflow':
          return new AsstError('budget_exceeded', 'Le budget global de l’assistant est atteint.');
        default:
          // ai_disabled, arrêts d'urgence, budget_unavailable : échec fermé.
          return new AsstError('assistant_unavailable', UNAVAILABLE);
      }
    }
    this.logFailure(op, err);
    return new AsstError('assistant_unavailable', UNAVAILABLE);
  }

  /** Journal sans contenu : opération et type d'erreur seulement. */
  private logFailure(op: string, err: unknown): void {
    this.logger.error(
      `porte de l’assistant ${op} en échec (${err instanceof Error ? err.name : 'erreur inconnue'})`,
    );
  }
}
