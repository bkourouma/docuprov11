import { z } from 'zod';
import {
  EVAL_CASE_LABEL_MAX,
  EVAL_CASE_MAX_BYTES,
  evalCaseByteSize,
  evalCaseInputSchema,
  evalExpectedSchema,
} from './eval-expected';

// Docu-Flow (lot W2) — évaluation des agents : corps d'entrée (zod, champs inconnus refusés).
// Les réponses sont les DTO de @archivage/types (WfEvalSetDto, WfEvalCaseDto, WfEvalRunDto).

/** Précision : 0..1, au plus 3 décimales (colonne DECIMAL(4,3)). Le plancher est contrôlé par le service (422). */
const accuracySchema = z
  .number()
  .min(0)
  .max(1)
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-9, { message: 'au plus 3 décimales' });

const stepKeySchema = z.string().min(1).max(100);

export const createEvalSetSchema = z
  .object({
    definitionId: z.number().int().positive(),
    stepKey: stepKeySchema.nullable().optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    minAccuracy: accuracySchema.optional(),
  })
  .strict();
export type CreateEvalSetInput = z.infer<typeof createEvalSetSchema>;

/**
 * `definitionId` est accepté dans le corps pour pouvoir être REFUSÉ explicitement (422) : le workflow d'un jeu
 * ne change jamais.
 */
export const updateEvalSetSchema = z
  .object({
    definitionId: z.number().int().positive().optional(),
    stepKey: stepKeySchema.nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    minAccuracy: accuracySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateEvalSetInput = z.infer<typeof updateEvalSetSchema>;

const sizeIssue = (input: unknown, expected: unknown, ctx: z.RefinementCtx): void => {
  if (evalCaseByteSize(input, expected) > EVAL_CASE_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cas trop volumineux (${EVAL_CASE_MAX_BYTES / 1024} Kio au plus)` });
  }
};

export const createEvalCaseSchema = z
  .object({
    label: z.string().trim().min(1).max(EVAL_CASE_LABEL_MAX),
    input: evalCaseInputSchema,
    expected: evalExpectedSchema,
    weight: z.number().int().min(1).max(1000).optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => sizeIssue(v.input, v.expected, ctx));
export type CreateEvalCaseInput = z.infer<typeof createEvalCaseSchema>;

export const updateEvalCaseSchema = z
  .object({
    label: z.string().trim().min(1).max(EVAL_CASE_LABEL_MAX).optional(),
    input: evalCaseInputSchema.optional(),
    expected: evalExpectedSchema.optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => sizeIssue(v.input ?? {}, v.expected ?? {}, ctx));
export type UpdateEvalCaseInput = z.infer<typeof updateEvalCaseSchema>;

export const runEvalSetSchema = z
  .object({
    definitionVersionId: z.number().int().positive().optional(),
    stepKey: stepKeySchema.optional(),
  })
  .strict();
export type RunEvalSetInput = z.infer<typeof runEvalSetSchema>;

export const listEvalSetsQuerySchema = z.object({ definitionId: z.coerce.number().int().positive().optional() });
/** `GET eval-status` : le workflow dont on lit l'éligibilité à l'autonomie (dernière version). */
export const evalStatusQuerySchema = z.object({ definitionId: z.coerce.number().int().positive() }).strict();

/** Statut d'éligibilité d'une étape agent à l'autonomie « autonome » (calculé à l'instant T, lecture seule). */
export interface EvalStepStatus {
  stepKey: string;
  evalSetId: number | null;
  eligible: boolean;
  /** Raison française quand non éligible, null sinon. */
  reason: string | null;
}

export interface EvalStatusResponse {
  definitionId: number;
  definitionVersionId: number;
  versionNumber: number;
  steps: EvalStepStatus[];
}

export const listEvalCasesQuerySchema = z.object({ includeInactive: z.enum(['true', 'false']).optional() });

/** Identifiant décimal d'un BigInt (run). */
export const bigIntIdSchema = z.string().regex(/^[1-9]\d{0,17}$/, 'identifiant invalide');
export const intIdSchema = z.coerce.number().int().positive();
