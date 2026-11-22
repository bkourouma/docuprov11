import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, WfBudget } from '@prisma/client';
import { GedAiMode, type EmergencyStopInput, type WfBudgetDto, type WfBudgetPeriodKind } from '@archivage/types';
import { AiService } from '../../ai/ai.service';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import type { UpdateWfBudgetInput, WfAgentBudgetOverviewDto, WfAgentStatusDto } from './agent-admin.dto';

// Docu-Flow — administration des budgets et de l'arrêt d'urgence des agents. Toute modification est
// journalisée (`AuditService.dataChange`). L'acteur doit être un utilisateur identifié (jamais l'identité machine).

type Tx = Prisma.TransactionClient;

const objectRefOf = (definitionId: number | null): string =>
  definitionId === null ? 'wf_budget:global' : `wf_budget:definition:${definitionId}`;

export function toBudgetDto(row: WfBudget): WfBudgetDto {
  return {
    wfBudgetId: row.wfBudgetId,
    definitionId: row.definitionId,
    periodKind: row.periodKind as WfBudgetPeriodKind,
    periodStart: row.periodStart.toISOString().slice(0, 10),
    capAmount: row.capAmount === null ? null : String(row.capAmount),
    consumedAmount: String(row.consumedAmount),
    consumedTokens: String(row.consumedTokens),
    alertThreshold: String(row.alertThreshold),
    currency: row.currency,
    emergencyStop: row.emergencyStop,
    emergencyStopAt: row.emergencyStopAt ? row.emergencyStopAt.toISOString() : null,
    emergencyStopBy: row.emergencyStopBy,
    emergencyStopReason: row.emergencyStopReason,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

@Injectable()
export class AgentAdminService {
  private readonly logger = new Logger(AgentAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  async status(actor: AuthUser): Promise<WfAgentStatusDto> {
    this.actorId(actor);
    const config = await this.ai.getEffectiveConfig();
    const global = await this.ensureRow(this.prisma, null);
    return {
      aiEnabled: config.mode !== GedAiMode.Desactivee,
      aiMode: config.mode,
      emergencyStopGlobal: global.emergencyStop,
    };
  }

  async getBudget(actor: AuthUser): Promise<WfAgentBudgetOverviewDto> {
    this.actorId(actor);
    const global = await this.ensureRow(this.prisma, null);
    const rows = await this.prisma.wfBudget.findMany({
      where: { definitionId: { not: null } },
      orderBy: { definitionId: 'asc' },
    });
    return { global: toBudgetDto(global), workflows: rows.map(toBudgetDto) };
  }

  async updateBudget(input: UpdateWfBudgetInput, actor: AuthUser): Promise<WfBudgetDto> {
    const actorId = this.actorId(actor);
    const definitionId = input.definitionId ?? null;

    const { before, after } = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findRow(tx, definitionId);
      const prior = existing ?? (await this.ensureRow(tx, definitionId));

      const data: Prisma.WfBudgetUpdateManyMutationInput = { updatedBy: actorId };
      if (input.capAmount !== undefined) data.capAmount = input.capAmount === null ? null : input.capAmount.toFixed(4);
      if (input.periodKind !== undefined) data.periodKind = input.periodKind;
      if (input.alertThreshold !== undefined) data.alertThreshold = input.alertThreshold.toFixed(3);

      const changesCurrency = input.currency !== undefined && input.currency !== prior.currency;
      if (input.currency !== undefined) data.currency = input.currency;

      // Un changement de devise est refusé s'il y a du consommé (les montants ne seraient plus comparables).
      // Garde atomique : la condition `consumedAmount = 0` est évaluée dans l'UPDATE lui-même.
      const where: Prisma.WfBudgetWhereInput = { wfBudgetId: prior.wfBudgetId };
      if (changesCurrency) where.consumedAmount = 0;
      const res = await tx.wfBudget.updateMany({ where, data });
      if (res.count === 0) {
        throw new ConflictException('La devise ne peut pas changer tant que le budget a du consommé.');
      }
      const updated = await tx.wfBudget.findUniqueOrThrow({ where: { wfBudgetId: prior.wfBudgetId } });
      return { before: existing, after: updated };
    });

    await this.journal(actor, definitionId, before, after);
    return toBudgetDto(after);
  }

  async setEmergencyStop(input: EmergencyStopInput, actor: AuthUser): Promise<WfBudgetDto> {
    const actorId = this.actorId(actor);
    const definitionId = input.definitionId ?? null;

    const { before, after, changed } = await this.prisma.$transaction(async (tx) => {
      const existing = await this.findRow(tx, definitionId);
      const prior = existing ?? (await this.ensureRow(tx, definitionId));
      // Idempotent : déjà dans l'état demandé => aucune écriture, aucun journal.
      if (prior.emergencyStop === input.active) return { before: existing, after: prior, changed: false };
      const updated = await tx.wfBudget.update({
        where: { wfBudgetId: prior.wfBudgetId },
        data: input.active
          ? {
              emergencyStop: true,
              emergencyStopAt: new Date(),
              emergencyStopBy: actorId,
              emergencyStopReason: input.reason?.trim() || null,
              updatedBy: actorId,
            }
          : {
              emergencyStop: false,
              emergencyStopAt: null,
              emergencyStopBy: null,
              emergencyStopReason: null,
              updatedBy: actorId,
            },
      });
      return { before: existing, after: updated, changed: true };
    });

    if (changed) await this.journal(actor, definitionId, before, after);
    return toBudgetDto(after);
  }

  // -------------------------------------------------------------------------------------------

  private actorId(actor: AuthUser): number {
    if (actor.isScanAgent || actor.userGroupId === null || actor.userGroupId === undefined) {
      throw new ForbiddenException('Action réservée à un utilisateur identifié.');
    }
    return actor.userGroupId;
  }

  private findRow(tx: Pick<Tx, 'wfBudget'>, definitionId: number | null): Promise<WfBudget | null> {
    return definitionId === null
      ? tx.wfBudget.findFirst({ where: { definitionId: null } })
      : tx.wfBudget.findUnique({ where: { definitionId } });
  }

  /**
   * Renvoie la ligne, la créant si besoin (globale : défauts de la migration ; workflow : la définition doit
   * exister, 404 sinon). `skipDuplicates` (ON CONFLICT DO NOTHING) évite d'avorter la transaction en cas de
   * création concurrente.
   */
  private async ensureRow(tx: Pick<Tx, 'wfBudget' | 'wfDefinition'>, definitionId: number | null): Promise<WfBudget> {
    const found = await this.findRow(tx, definitionId);
    if (found) return found;
    if (definitionId !== null) {
      const def = await tx.wfDefinition.findUnique({
        where: { wfDefinitionId: definitionId },
        select: { wfDefinitionId: true },
      });
      if (!def) throw new NotFoundException('Workflow introuvable.');
    }
    await tx.wfBudget.createMany({ data: [{ definitionId }], skipDuplicates: true });
    const created = await this.findRow(tx, definitionId);
    if (!created) throw new ConflictException('Création du budget impossible, réessayez.');
    return created;
  }

  /** Journal d'audit : ne bloque jamais la modification déjà validée (une erreur est tracée sans contenu). */
  private async journal(
    actor: AuthUser,
    definitionId: number | null,
    before: WfBudget | null,
    after: WfBudget,
  ): Promise<void> {
    try {
      await this.audit.dataChange({
        userGroupId: actor.userGroupId,
        actorFullName: actor.fullName ?? actor.username,
        objectRef: objectRefOf(definitionId),
        oldValue: before ? JSON.stringify(auditView(before)) : undefined,
        newValue: JSON.stringify(auditView(after)),
      });
    } catch (err) {
      this.logger.error(`audit wf_budget en échec (${err instanceof Error ? err.name : 'erreur inconnue'})`);
    }
  }
}

/** Champs de configuration seulement (pas de consommé : il bouge à chaque appel d'agent). */
function auditView(row: WfBudget): Record<string, unknown> {
  return {
    capAmount: row.capAmount === null ? null : String(row.capAmount),
    periodKind: row.periodKind,
    alertThreshold: String(row.alertThreshold),
    currency: row.currency,
    emergencyStop: row.emergencyStop,
    emergencyStopReason: row.emergencyStopReason,
  };
}
