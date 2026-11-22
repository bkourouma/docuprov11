import { z } from 'zod';

const MAX_INT = 2_147_483_647;

export const wfToolGrantInputSchema = z
  .object({
    toolKey: z.string().min(1).max(100).regex(/^[a-z0-9_.]+$/),
    maxCallsPerInstance: z.number().int().positive().max(MAX_INT).nullable().optional(),
  })
  .strict();

/** Remplace l'ensemble des autorisations d'un workflow. Clés d'outil uniques. */
export const replaceWfToolGrantsSchema = z
  .object({
    grants: z
      .array(wfToolGrantInputSchema)
      .max(100)
      .refine((g) => new Set(g.map((x) => x.toolKey)).size === g.length, {
        message: 'Un outil ne peut figurer qu’une fois.',
      }),
  })
  .strict();

export type ReplaceWfToolGrantsInput = z.infer<typeof replaceWfToolGrantsSchema>;

export interface WfToolCatalogEntryDto {
  toolKey: string;
  label: string;
  description: string | null;
  sideEffect: number;
  requiresValidation: boolean;
  inputSchema: unknown;
  isEnabled: boolean;
}

export interface WfToolGrantDto {
  toolKey: string;
  maxCallsPerInstance: number | null;
}

export interface WfToolGrantsResponse {
  grants: WfToolGrantDto[];
  /** Avertissements non bloquants (ex. autorisation retirée mais encore utilisée par le brouillon). */
  warnings: string[];
}
