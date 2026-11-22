import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Jeton d'injection de la barrière d'arrêt d'urgence consultée par le répartiteur de déclencheurs. */
export const WF_EMERGENCY_STOP_GATE = 'WF_EMERGENCY_STOP_GATE';

/**
 * Barrière d'arrêt d'urgence : tant qu'elle répond « arrêté », aucun déclencheur ne lance de workflow.
 */
export interface WfEmergencyStopGate {
  /** Vrai si le lancement doit être bloqué pour cette définition (arrêt global OU propre au workflow). */
  isStopped(definitionId: number): Promise<boolean>;
}

/**
 * Implémentation par défaut : lit `wf_budget`. Une ligne `emergency_stop = true` bloque si elle est globale
 * (`definition_id` nul) ou si elle vise la définition du déclencheur.
 *
 * W2 (budget) peut fournir une autre implémentation (cache, règles de plafond de coût…) sous le MÊME jeton
 * `WF_EMERGENCY_STOP_GATE` : le répartiteur ne dépend que de l'interface.
 */
@Injectable()
export class WfBudgetEmergencyStopGate implements WfEmergencyStopGate {
  constructor(private readonly prisma: PrismaService) {}

  async isStopped(definitionId: number): Promise<boolean> {
    const row = await this.prisma.wfBudget.findFirst({
      where: {
        emergencyStop: true,
        OR: [{ definitionId: null }, { definitionId }],
      },
      select: { wfBudgetId: true },
    });
    return row !== null;
  }
}
