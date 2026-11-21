import { z } from 'zod';
import {
  WF_DEFINITION_STATUS_VALUES,
  wfGraphSchema,
  type WfDefinitionDto,
  type WfDefinitionVersionDto,
  type WfGraphIssue,
} from '@archivage/types';

// Docu-Flow — définitions de workflow : schémas d'entrée et formes de réponse propres à l'API.
// Le corps de création (`createWfDefinitionSchema`) est réutilisé tel quel depuis @archivage/types.

/** Identifiant de définition (Int) dans le chemin. */
export const wfDefinitionIdSchema = z.coerce.number().int().positive().max(2_147_483_647);

/** Numéro de version dans le chemin. */
export const wfVersionNumberSchema = z.coerce.number().int().positive().max(2_147_483_647);

export const listWfDefinitionsQuerySchema = z.object({
  status: z.coerce
    .number()
    .int()
    .refine((v) => (WF_DEFINITION_STATUS_VALUES as readonly number[]).includes(v), {
      message: 'statut de workflow invalide',
    })
    .optional(),
});
export type ListWfDefinitionsQuery = z.infer<typeof listWfDefinitionsQuerySchema>;

/**
 * Modification du brouillon : nom / description (en-tête) et/ou graphe. Le graphe est contrôlé en FORME
 * seulement (`wfGraphSchema`) : un brouillon incomplet reste enregistrable ; la sémantique est vérifiée
 * par `POST :id/validate` et à la publication.
 */
export const updateWfDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(4000).nullable().optional(),
    graph: wfGraphSchema.optional(),
    changeNote: z.string().max(500).nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.graph !== undefined ||
      v.changeNote !== undefined,
    { message: 'aucune modification fournie' },
  );
export type UpdateWfDraftInput = z.infer<typeof updateWfDraftSchema>;

export const setWfLowRiskSchema = z.object({ isLowRisk: z.boolean() });
export type SetWfLowRiskInput = z.infer<typeof setWfLowRiskSchema>;

/** Problème de validation : ceux du graphe, plus les contrôles de publication propres à l'API. */
export type WfDefinitionIssueCode = WfGraphIssue['code'] | 'ESCALATION_INVALID' | 'EXECUTOR_MISSING';

export interface WfDefinitionIssue {
  code: WfDefinitionIssueCode;
  message: string;
  stepKey?: string;
  path?: (string | number)[];
}

export interface WfDefinitionValidationResponse {
  ok: boolean;
  issues: WfDefinitionIssue[];
}

/** Version sans graphe (liste). */
export type WfDefinitionVersionSummaryDto = Omit<WfDefinitionVersionDto, 'graph' | 'sourcePrompt'>;

export interface WfDefinitionDetailDto {
  definition: WfDefinitionDto;
  versions: WfDefinitionVersionSummaryDto[];
}

export interface WfDefinitionWithVersionDto {
  definition: WfDefinitionDto;
  version: WfDefinitionVersionDto;
}
