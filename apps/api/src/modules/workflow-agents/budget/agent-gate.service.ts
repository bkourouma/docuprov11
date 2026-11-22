import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { GedAiMode } from '@archivage/types';
import { AiService } from '../../ai/ai.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AgentBlockedError,
  type AgentReservation,
  type AgentUsage,
  type WfAgentGate,
} from '../agent.contracts';

// Docu-Flow — garde des agents : mode IA, arrêt d'urgence, plafonds budgétaires (table `wf_budget`).
//
// ÉCHEC FERMÉ : toute erreur de lecture ou d'écriture du budget bloque l'agent (`budget_unavailable`).
// ATOMICITÉ : la réservation est UN `UPDATE` conditionnel par ligne (jamais lecture puis écriture), dans une
// seule transaction qui verrouille la ligne globale PUIS celle du workflow (ordre fixe : pas d'interblocage).
// Si une ligne refuse, la transaction entière est annulée (la réservation globale déjà faite disparaît).
// Aucun log ne contient de contenu : identifiants et types d'erreur seulement.

const DEFAULT_COST_PER_1K_PROMPT = 5;
const DEFAULT_COST_PER_1K_COMPLETION = 15;
const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 } as const;
/** Borne de la mémoire des réservations (purge des plus anciennes au-delà). */
const MAX_TRACKED = 10_000;

type Tx = Prisma.TransactionClient;

/** Lignes réellement débitées par une réservation (la ligne du workflow peut ne pas exister). */
interface Charged {
  global: boolean;
  workflow: boolean;
}

function envRate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const safeCount = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

@Injectable()
export class AgentGateService implements WfAgentGate {
  private readonly logger = new Logger(AgentGateService.name);
  /** Réservations ouvertes (id -> lignes débitées). */
  private readonly open = new Map<string, Charged>();
  /** Réservations déjà soldées (anti double settle/release dans ce processus). */
  private readonly done = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // assertRunnable
  // -------------------------------------------------------------------------------------------

  async assertRunnable(scope: { definitionId: number }): Promise<void> {
    let aiMode: number;
    try {
      aiMode = (await this.ai.getEffectiveConfig()).mode;
    } catch (err) {
      this.logFailure('assertRunnable', err);
      throw new AgentBlockedError('budget_unavailable', 'Configuration IA illisible : exécution refusée.');
    }
    if (aiMode === GedAiMode.Desactivee) {
      throw new AgentBlockedError('ai_disabled', 'L’IA est désactivée : le workflow fonctionne en mode humain.');
    }
    let rows: { definitionId: number | null; emergencyStop: boolean }[];
    try {
      rows = await this.prisma.wfBudget.findMany({
        where: { OR: [{ definitionId: null }, { definitionId: scope.definitionId }] },
        select: { definitionId: true, emergencyStop: true },
      });
    } catch (err) {
      this.logFailure('assertRunnable', err);
      throw new AgentBlockedError('budget_unavailable', 'Budget des agents illisible : exécution refusée.');
    }
    const global = rows.find((r) => r.definitionId === null);
    // Ligne globale absente : état anormal (créée par la migration) => échec fermé.
    if (!global) {
      throw new AgentBlockedError('budget_unavailable', 'Ligne budgétaire globale introuvable : exécution refusée.');
    }
    if (global.emergencyStop) {
      throw new AgentBlockedError('emergency_stop_global', 'Arrêt d’urgence global des agents actif.');
    }
    if (rows.some((r) => r.definitionId === scope.definitionId && r.emergencyStop)) {
      throw new AgentBlockedError('emergency_stop_workflow', 'Arrêt d’urgence des agents actif pour ce workflow.');
    }
  }

  // -------------------------------------------------------------------------------------------
  // reserve
  // -------------------------------------------------------------------------------------------

  async reserve(scope: { definitionId: number }, estimate: AgentUsage): Promise<AgentReservation> {
    if (!Number.isFinite(estimate.cost) || estimate.cost < 0) {
      throw new AgentBlockedError('budget_unavailable', 'Estimation de coût invalide : exécution refusée.');
    }
    const cost = estimate.cost.toFixed(4);
    const tokens = Math.round(safeCount(estimate.promptTokens) + safeCount(estimate.completionTokens));
    try {
      const charged = await this.prisma.$transaction(async (tx) => {
        // Ordre FIXE : ligne globale, puis ligne du workflow. Un refus lève et annule TOUTE la transaction.
        const global = await this.reserveRow(tx, null, cost, tokens);
        const workflow = await this.reserveRow(tx, scope.definitionId, cost, tokens);
        return { global, workflow };
      }, TX_OPTIONS);
      const reservation: AgentReservation = {
        id: randomUUID(),
        definitionId: scope.definitionId,
        reserved: { ...estimate },
      };
      this.remember(reservation.id, charged);
      return reservation;
    } catch (err) {
      if (err instanceof AgentBlockedError) throw err;
      this.logFailure('reserve', err);
      throw new AgentBlockedError('budget_unavailable', 'Budget des agents indisponible : exécution refusée.');
    }
  }

  /**
   * Réserve sur UNE ligne. Renvoie `true` si débitée, `false` si la ligne du workflow n'existe pas (pas de
   * plafond workflow). Lève `AgentBlockedError` si l'arrêt d'urgence est actif ou si le plafond serait dépassé.
   */
  private async reserveRow(tx: Tx, definitionId: number | null, cost: string, tokens: number): Promise<boolean> {
    await this.resetPeriodIfDue(tx, definitionId);
    const rows = await this.incrementIfAllowed(tx, definitionId, cost, tokens);
    if (rows.length > 0) return true;

    // 0 ligne : la ligne n'existe pas, ou arrêt d'urgence, ou plafond dépassé.
    const diag = await this.diagnose(tx, definitionId);
    if (!diag) {
      if (definitionId === null) {
        throw new AgentBlockedError('budget_unavailable', 'Ligne budgétaire globale introuvable.');
      }
      return false;
    }
    const isGlobal = definitionId === null;
    if (diag.emergency_stop) {
      throw new AgentBlockedError(
        isGlobal ? 'emergency_stop_global' : 'emergency_stop_workflow',
        isGlobal ? 'Arrêt d’urgence global des agents actif.' : 'Arrêt d’urgence des agents actif pour ce workflow.',
      );
    }
    throw new AgentBlockedError(
      isGlobal ? 'budget_exceeded_global' : 'budget_exceeded_workflow',
      `Plafond budgétaire ${isGlobal ? 'global' : 'du workflow'} atteint : appel refusé avant exécution.`,
    );
  }

  /** Remise à zéro de la période échue (mensuel : mois UTC échu ; journalier : jour UTC échu ; cumulé : jamais). */
  private async resetPeriodIfDue(tx: Tx, definitionId: number | null): Promise<void> {
    if (definitionId === null) {
      await tx.$executeRaw`
        UPDATE "wf_budget"
           SET "consumed_amount" = 0, "consumed_tokens" = 0,
               "period_start" = (now() AT TIME ZONE 'UTC')::date, "updated_at" = now()
         WHERE "definition_id" IS NULL
           AND (("period_kind" = 0 AND date_trunc('month', "period_start") < date_trunc('month', (now() AT TIME ZONE 'UTC')::date))
             OR ("period_kind" = 1 AND "period_start" < (now() AT TIME ZONE 'UTC')::date))`;
      return;
    }
    await tx.$executeRaw`
      UPDATE "wf_budget"
         SET "consumed_amount" = 0, "consumed_tokens" = 0,
             "period_start" = (now() AT TIME ZONE 'UTC')::date, "updated_at" = now()
       WHERE "definition_id" = ${definitionId}
         AND (("period_kind" = 0 AND date_trunc('month', "period_start") < date_trunc('month', (now() AT TIME ZONE 'UTC')::date))
           OR ("period_kind" = 1 AND "period_start" < (now() AT TIME ZONE 'UTC')::date))`;
  }

  /** UN SEUL UPDATE conditionnel : plafond vérifié et compteur incrémenté dans la même instruction. */
  private incrementIfAllowed(
    tx: Tx,
    definitionId: number | null,
    cost: string,
    tokens: number,
  ): Promise<{ wf_budget_id: number }[]> {
    if (definitionId === null) {
      return tx.$queryRaw<{ wf_budget_id: number }[]>`
        UPDATE "wf_budget"
           SET "consumed_amount" = "consumed_amount" + ${cost}::numeric,
               "consumed_tokens" = "consumed_tokens" + ${tokens}::bigint,
               "updated_at" = now()
         WHERE "definition_id" IS NULL
           AND NOT "emergency_stop"
           AND ("cap_amount" IS NULL OR "consumed_amount" + ${cost}::numeric <= "cap_amount")
        RETURNING "wf_budget_id"`;
    }
    return tx.$queryRaw<{ wf_budget_id: number }[]>`
      UPDATE "wf_budget"
         SET "consumed_amount" = "consumed_amount" + ${cost}::numeric,
             "consumed_tokens" = "consumed_tokens" + ${tokens}::bigint,
             "updated_at" = now()
       WHERE "definition_id" = ${definitionId}
         AND NOT "emergency_stop"
         AND ("cap_amount" IS NULL OR "consumed_amount" + ${cost}::numeric <= "cap_amount")
      RETURNING "wf_budget_id"`;
  }

  private async diagnose(tx: Tx, definitionId: number | null): Promise<{ emergency_stop: boolean } | null> {
    const rows =
      definitionId === null
        ? await tx.$queryRaw<{ emergency_stop: boolean }[]>`
            SELECT "emergency_stop" FROM "wf_budget" WHERE "definition_id" IS NULL`
        : await tx.$queryRaw<{ emergency_stop: boolean }[]>`
            SELECT "emergency_stop" FROM "wf_budget" WHERE "definition_id" = ${definitionId}`;
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // settle / release (ne lèvent jamais)
  // -------------------------------------------------------------------------------------------

  async settle(reservation: AgentReservation, actual: AgentUsage): Promise<void> {
    const reservedTokens =
      safeCount(reservation.reserved.promptTokens) + safeCount(reservation.reserved.completionTokens);
    const actualTokens = safeCount(actual.promptTokens) + safeCount(actual.completionTokens);
    const deltaCost = safeCount(actual.cost) - safeCount(reservation.reserved.cost);
    await this.adjust('settle', reservation, deltaCost, Math.round(actualTokens - reservedTokens));
  }

  async release(reservation: AgentReservation): Promise<void> {
    const tokens = safeCount(reservation.reserved.promptTokens) + safeCount(reservation.reserved.completionTokens);
    await this.adjust('release', reservation, -safeCount(reservation.reserved.cost), -Math.round(tokens));
  }

  /** Applique un delta signé ; la consommation ne devient jamais négative ; aucun plafond n'est opposé. */
  private async adjust(op: string, reservation: AgentReservation, deltaCost: number, deltaTokens: number): Promise<void> {
    // Déjà soldée dans ce processus : jamais de double comptabilisation.
    if (this.done.has(reservation.id)) return;
    const charged = this.open.get(reservation.id) ?? { global: true, workflow: true };
    this.open.delete(reservation.id);
    this.markDone(reservation.id);
    const cost = deltaCost.toFixed(4);
    try {
      await this.prisma.$transaction(async (tx) => {
        if (charged.global) await this.applyDelta(tx, null, cost, deltaTokens);
        if (charged.workflow) await this.applyDelta(tx, reservation.definitionId, cost, deltaTokens);
      }, TX_OPTIONS);
    } catch (err) {
      this.logFailure(op, err);
    }
  }

  private async applyDelta(tx: Tx, definitionId: number | null, cost: string, tokens: number): Promise<void> {
    if (definitionId === null) {
      await tx.$executeRaw`
        UPDATE "wf_budget"
           SET "consumed_amount" = GREATEST(0, "consumed_amount" + ${cost}::numeric),
               "consumed_tokens" = GREATEST(0, "consumed_tokens" + ${tokens}::bigint),
               "updated_at" = now()
         WHERE "definition_id" IS NULL`;
      return;
    }
    await tx.$executeRaw`
      UPDATE "wf_budget"
         SET "consumed_amount" = GREATEST(0, "consumed_amount" + ${cost}::numeric),
             "consumed_tokens" = GREATEST(0, "consumed_tokens" + ${tokens}::bigint),
             "updated_at" = now()
       WHERE "definition_id" = ${definitionId}`;
  }

  // -------------------------------------------------------------------------------------------
  // costOf
  // -------------------------------------------------------------------------------------------

  costOf(tokens: { promptTokens: number; completionTokens: number }): number {
    const perPrompt = envRate('WF_AGENT_COST_PER_1K_PROMPT', DEFAULT_COST_PER_1K_PROMPT);
    const perCompletion = envRate('WF_AGENT_COST_PER_1K_COMPLETION', DEFAULT_COST_PER_1K_COMPLETION);
    return (
      (safeCount(tokens.promptTokens) / 1000) * perPrompt + (safeCount(tokens.completionTokens) / 1000) * perCompletion
    );
  }

  // -------------------------------------------------------------------------------------------

  private remember(id: string, charged: Charged): void {
    if (this.open.size >= MAX_TRACKED) {
      const oldest = this.open.keys().next().value;
      if (oldest !== undefined) this.open.delete(oldest);
    }
    this.open.set(id, charged);
  }

  private markDone(id: string): void {
    if (this.done.size >= MAX_TRACKED) {
      const oldest = this.done.values().next().value;
      if (oldest !== undefined) this.done.delete(oldest);
    }
    this.done.add(id);
  }

  /** Journal sans contenu : opération et type d'erreur seulement. */
  private logFailure(op: string, err: unknown): void {
    this.logger.error(`wf_budget ${op} en échec (${err instanceof Error ? err.name : 'erreur inconnue'})`);
  }
}
