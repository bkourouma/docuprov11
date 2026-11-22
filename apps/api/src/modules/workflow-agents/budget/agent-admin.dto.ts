import { z } from 'zod';
import type { WfBudgetDto } from '@archivage/types';

// Docu-Flow — administration des agents : corps d'entrée et formes de réponse.
// Le corps de l'arrêt d'urgence réutilise `emergencyStopSchema` de @archivage/types.

/** Plafond maximal représentable (colonne DECIMAL(14,4) : 10 chiffres entiers). */
export const WF_BUDGET_CAP_MAX = 9_999_999_999;

/**
 * Mise à jour d'un budget. `definitionId` absent ou nul = ligne GLOBALE. Un champ absent n'est pas modifié ;
 * `capAmount: null` retire le plafond.
 */
export const updateWfBudgetSchema = z
  .object({
    definitionId: z.number().int().positive().nullable().optional(),
    capAmount: z.number().min(0).max(WF_BUDGET_CAP_MAX).nullable().optional(),
    periodKind: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    alertThreshold: z.number().min(0).max(1).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Devise attendue : 3 lettres majuscules (ex. XOF).')
      .optional(),
  })
  .strict();
export type UpdateWfBudgetInput = z.infer<typeof updateWfBudgetSchema>;

export interface WfAgentStatusDto {
  aiEnabled: boolean;
  aiMode: number;
  emergencyStopGlobal: boolean;
}

export interface WfAgentBudgetOverviewDto {
  global: WfBudgetDto;
  workflows: WfBudgetDto[];
}
