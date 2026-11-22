import { Injectable, Logger } from '@nestjs/common';
import { WF_EVAL_ACCURACY_FLOOR, WfEvalRunStatus } from '@archivage/types';
import { PrismaService } from '../../prisma/prisma.service';
import { evalCasesHash } from '../../workflows/agent-spec-hash';
import { AgentConfigLoader } from '../agent-config.loader';

// Docu-Flow (lot W2) — éligibilité d'une étape agent à l'autonomie « autonome » À L'INSTANT T, relue en base à
// chaque exécution (jamais mise en cache). Miroir applicatif du déclencheur SQL `wf_agent_config_autonomy_guard`,
// plus deux garde-fous que le SQL ne voit pas : plancher de précision du jeu et empreinte du comportement de
// l'agent (une configuration modifiée depuis le run n'est plus couverte par lui).
//
// ÉCHEC FERMÉ : toute erreur de lecture => non éligible.

export interface AutonomyEligibility {
  eligible: boolean;
  reason?: string;
}

const NO = (reason: string): AutonomyEligibility => ({ eligible: false, reason });
/** Comparaison de précisions en millièmes entiers (colonnes DECIMAL(4,3)) : pas d'erreur d'arrondi flottant. */
const milli = (v: unknown): number => Math.round(Number(v) * 1000);

@Injectable()
export class AutonomyEligibilityService {
  private readonly logger = new Logger(AutonomyEligibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: AgentConfigLoader,
  ) {}

  async check(definitionVersionId: number, stepKey: string): Promise<AutonomyEligibility> {
    try {
      return await this.evaluate(definitionVersionId, stepKey);
    } catch (err) {
      this.logger.error(`éligibilité illisible (${err instanceof Error ? err.name : 'erreur inconnue'}) : refus`);
      return NO('Éligibilité à l’autonomie illisible : refus par prudence.');
    }
  }

  private async evaluate(definitionVersionId: number, stepKey: string): Promise<AutonomyEligibility> {
    const version = await this.prisma.wfDefinitionVersion.findUnique({
      where: { wfDefinitionVersionId: definitionVersionId },
      select: { definitionId: true, definition: { select: { isLowRisk: true } } },
    });
    if (!version) return NO('Version introuvable.');
    if (version.definition.isLowRisk !== true) return NO('Le workflow n’est pas marqué faible risque.');

    const config = await this.loader.load(definitionVersionId, stepKey);
    if (!config) return NO('Étape agent introuvable ou illisible.');
    if (config.evalSetId === null) return NO('Aucun jeu d’évaluation n’est lié à cette étape.');

    const set = await this.prisma.wfEvalSet.findUnique({
      where: { wfEvalSetId: config.evalSetId },
      select: { definitionId: true, isActive: true, minAccuracy: true },
    });
    if (!set) return NO('Jeu d’évaluation introuvable.');
    if (set.definitionId !== version.definitionId) return NO('Le jeu d’évaluation n’appartient pas à ce workflow.');
    if (!set.isActive) return NO('Le jeu d’évaluation est désactivé.');
    const floor = milli(WF_EVAL_ACCURACY_FLOOR);
    if (milli(set.minAccuracy) < floor) return NO('Le seuil du jeu est inférieur au plancher de précision.');
    const needed = Math.max(floor, milli(set.minAccuracy));

    const runs = await this.prisma.wfEvalRun.findMany({
      where: {
        evalSetId: config.evalSetId,
        definitionVersionId,
        status: WfEvalRunStatus.Completed,
        passed: true,
        totalCases: { gt: 0 },
      },
      orderBy: { wfEvalRunId: 'desc' },
      take: 50,
      select: { requiredAccuracy: true, results: true },
    });
    if (runs.length === 0) return NO('Aucun run d’évaluation réussi pour cette version et ce jeu.');

    const strong = runs.filter((r) => milli(r.requiredAccuracy) >= needed);
    if (strong.length === 0) return NO('Le run réussi a été validé avec un seuil inférieur au seuil actuel du jeu.');

    const current = strong.filter((r) => {
      const res = r.results as { agentSpecHash?: unknown; stepKey?: unknown } | null;
      // Échec fermé : l'étape du run doit être présente ET identique (jamais tolérer `undefined`).
      return res?.agentSpecHash === config.specHash && res.stepKey === stepKey;
    });
    if (current.length === 0) {
      return NO('La configuration de l’agent a changé depuis le dernier run réussi : relancer l’évaluation.');
    }

    // Les cas du jeu ne doivent pas avoir changé depuis le run (ajout, modification, désactivation).
    const activeCases = await this.prisma.wfEvalCase.findMany({
      where: { evalSetId: config.evalSetId, isActive: true },
      select: { wfEvalCaseId: true, input: true, expected: true },
    });
    const casesHash = evalCasesHash(activeCases);
    const sameCases = current.some((r) => (r.results as { casesHash?: unknown } | null)?.casesHash === casesHash);
    if (!sameCases) {
      return NO('Les cas du jeu d’évaluation ont changé depuis le dernier run réussi : relancer l’évaluation.');
    }

    return { eligible: true };
  }
}
