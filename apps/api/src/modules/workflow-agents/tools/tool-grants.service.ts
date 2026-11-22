import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthUser } from '../../auth/auth.types';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ReplaceWfToolGrantsInput,
  WfToolCatalogEntryDto,
  WfToolGrantDto,
  WfToolGrantsResponse,
} from './tool-grants.dto';

/**
 * Autorisations d'outils par workflow (liste blanche : sans ligne, l'outil est interdit). Réservé aux
 * administrateurs du module (garde de menu au contrôleur) ; acteur identifié obligatoire. Chaque
 * remplacement est journalisé (`wf_tool_grant:definition:<id>`).
 */
@Injectable()
export class ToolGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listCatalog(actor: AuthUser): Promise<WfToolCatalogEntryDto[]> {
    this.actorId(actor);
    const rows = await this.prisma.wfTool.findMany({ orderBy: { toolKey: 'asc' } });
    return rows.map((t) => ({
      toolKey: t.toolKey,
      label: t.label,
      description: t.description ?? null,
      sideEffect: t.sideEffect,
      requiresValidation: t.requiresValidation,
      inputSchema: t.inputSchema ?? null,
      isEnabled: t.isEnabled,
    }));
  }

  async getGrants(definitionId: number, actor: AuthUser): Promise<WfToolGrantDto[]> {
    this.actorId(actor);
    await this.assertDefinition(definitionId);
    return this.readGrants(definitionId);
  }

  /** Remplace l'ensemble : upsert des présentes, suppression des absentes. Avertit sans bloquer. */
  async replaceGrants(
    definitionId: number,
    input: ReplaceWfToolGrantsInput,
    actor: AuthUser,
  ): Promise<WfToolGrantsResponse> {
    const actorId = this.actorId(actor);
    await this.assertDefinition(definitionId);

    const keys = input.grants.map((g) => g.toolKey);
    const tools = keys.length ? await this.prisma.wfTool.findMany({ where: { toolKey: { in: keys } } }) : [];
    const byKey = new Map(tools.map((t) => [t.toolKey, t]));
    const invalid = keys.filter((k) => byKey.get(k)?.isEnabled !== true);
    if (invalid.length > 0) {
      throw new UnprocessableEntityException(`Outil inconnu ou désactivé : ${invalid.join(', ')}.`);
    }

    const before = await this.readGrants(definitionId);
    const warnings: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      const keptToolIds: number[] = [];
      for (const g of input.grants) {
        const tool = byKey.get(g.toolKey);
        if (!tool) continue; // déjà écarté plus haut
        keptToolIds.push(tool.wfToolId);
        const max = g.maxCallsPerInstance ?? null;
        await tx.wfToolGrant.upsert({
          where: { definitionId_toolId: { definitionId, toolId: tool.wfToolId } },
          create: { definitionId, toolId: tool.wfToolId, maxCallsPerInstance: max, grantedBy: actorId },
          update: { maxCallsPerInstance: max },
        });
      }

      const removed = await tx.wfToolGrant.findMany({
        where: { definitionId, toolId: { notIn: keptToolIds } },
        select: { toolId: true },
      });
      if (removed.length > 0) {
        const removedIds = removed.map((r) => r.toolId);
        // Configuration agent du BROUILLON courant : on avertit sans bloquer.
        const used = await tx.wfAgentConfigTool.findMany({
          where: {
            toolId: { in: removedIds },
            agentConfig: { definitionVersion: { definitionId, status: 0 } },
          },
          select: { tool: { select: { toolKey: true } }, agentConfig: { select: { stepKey: true } } },
        });
        for (const u of used) {
          warnings.push(
            `L'outil « ${u.tool.toolKey} » est retiré des autorisations mais reste utilisé par l'étape « ${u.agentConfig.stepKey} » du brouillon.`,
          );
        }
        await tx.wfToolGrant.deleteMany({ where: { definitionId, toolId: { in: removedIds } } });
      }
    });

    const after = await this.readGrants(definitionId);
    await this.audit.dataChange({
      userGroupId: actorId,
      actorFullName: actor.fullName ?? actor.username,
      objectRef: `wf_tool_grant:definition:${definitionId}`,
      oldValue: JSON.stringify(before),
      newValue: JSON.stringify(after),
    });
    return { grants: after, warnings };
  }

  private async readGrants(definitionId: number): Promise<WfToolGrantDto[]> {
    const rows = await this.prisma.wfToolGrant.findMany({
      where: { definitionId },
      select: { maxCallsPerInstance: true, tool: { select: { toolKey: true } } },
    });
    return rows
      .map((r) => ({ toolKey: r.tool.toolKey, maxCallsPerInstance: r.maxCallsPerInstance ?? null }))
      .sort((a, b) => a.toolKey.localeCompare(b.toolKey));
  }

  private async assertDefinition(definitionId: number): Promise<void> {
    const def = await this.prisma.wfDefinition.findUnique({
      where: { wfDefinitionId: definitionId },
      select: { wfDefinitionId: true },
    });
    if (!def) throw new NotFoundException('Définition introuvable.');
  }

  private actorId(actor: AuthUser): number {
    if (actor.isScanAgent || actor.userGroupId === null || actor.userGroupId === undefined) {
      throw new ForbiddenException('Action réservée à un utilisateur identifié.');
    }
    return actor.userGroupId;
  }
}
