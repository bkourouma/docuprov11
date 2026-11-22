import { Injectable } from '@nestjs/common';
import { wfAutonomyFromKey, wfGraphSchema, type WfAgentStepSpec } from '@archivage/types';
import { effectiveSpec, effectiveSpecHash } from '../workflows/definitions-agents';
import { PrismaService } from '../prisma/prisma.service';

/** Configuration d'exécution d'une étape agent d'une version (brouillon ou publiée). */
export interface LoadedAgentConfig {
  definitionId: number;
  definitionVersionId: number;
  stepKey: string;
  objective: string;
  autonomy: 0 | 1 | 2;
  confidenceThreshold: number;
  model: string | null;
  maxSteps: number;
  maxCostPerRun: number | null;
  timeoutSeconds: number;
  evalSetId: number | null;
  /** Outils de l'étape : déclarés, actifs ET autorisés pour le workflow (sinon écartés). */
  allowedToolKeys: string[];
  /** Outils déclarés mais écartés (inconnus, désactivés ou non autorisés) : l'exécuteur les signale. */
  rejectedToolKeys: string[];
  /** Plafond d'appels par instance (null = illimité), par outil autorisé. */
  maxCallsByTool: Record<string, number | null>;
  /** Empreinte du comportement (`agentSpecHash`), comparée à celle des runs d'évaluation. */
  specHash: string;
}

/**
 * Lit la configuration d'une étape agent : le GRAPHE de la version est la source des champs communs, la ligne
 * `wf_agent_config` apporte `timeoutSeconds` et `evalSetId`. Défense en profondeur : même si la publication a
 * déjà vérifié outils ⊆ autorisations, l'intersection est refaite à chaque exécution (autorisation retirée
 * depuis = outil indisponible).
 */
@Injectable()
export class AgentConfigLoader {
  constructor(private readonly prisma: PrismaService) {}

  async load(definitionVersionId: number, stepKey: string): Promise<LoadedAgentConfig | null> {
    const version = await this.prisma.wfDefinitionVersion.findUnique({
      where: { wfDefinitionVersionId: definitionVersionId },
      select: { definitionId: true, graph: true },
    });
    if (!version) return null;
    const parsed = wfGraphSchema.safeParse(version.graph);
    if (!parsed.success) return null;
    const step = parsed.data.steps.find((s) => s.key === stepKey);
    const spec: WfAgentStepSpec | undefined = step?.type === 'agent' ? step.agent : undefined;
    if (!spec) return null;

    const row = await this.prisma.wfAgentConfig.findUnique({
      where: { definitionVersionId_stepKey: { definitionVersionId, stepKey } },
      select: { timeoutSeconds: true, evalSetId: true },
    });
    const effective = effectiveSpec(spec, row?.timeoutSeconds);

    const declared = [...new Set(effective.tools)];
    const tools = declared.length
      ? await this.prisma.wfTool.findMany({
          where: { toolKey: { in: declared }, isEnabled: true },
          select: { wfToolId: true, toolKey: true },
        })
      : [];
    const grants = tools.length
      ? await this.prisma.wfToolGrant.findMany({
          where: { definitionId: version.definitionId, toolId: { in: tools.map((t) => t.wfToolId) } },
          select: { toolId: true, maxCallsPerInstance: true },
        })
      : [];
    const grantByTool = new Map(grants.map((g) => [g.toolId, g.maxCallsPerInstance]));
    const allowedToolKeys: string[] = [];
    const maxCallsByTool: Record<string, number | null> = {};
    for (const t of tools) {
      if (!grantByTool.has(t.wfToolId)) continue;
      allowedToolKeys.push(t.toolKey);
      maxCallsByTool[t.toolKey] = grantByTool.get(t.wfToolId) ?? null;
    }
    return {
      definitionId: version.definitionId,
      definitionVersionId,
      stepKey,
      objective: effective.objective,
      autonomy: wfAutonomyFromKey(effective.autonomy) as 0 | 1 | 2,
      confidenceThreshold: effective.confidenceThreshold,
      model: effective.model,
      maxSteps: effective.maxSteps,
      maxCostPerRun: effective.maxCostPerRun,
      timeoutSeconds: effective.timeoutSeconds,
      evalSetId: row?.evalSetId ?? null,
      allowedToolKeys,
      rejectedToolKeys: declared.filter((k) => !allowedToolKeys.includes(k)),
      maxCallsByTool,
      specHash: effectiveSpecHash(effective),
    };
  }
}
