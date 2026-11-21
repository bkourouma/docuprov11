import { z, type ZodTypeAny } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { WF_INSTANCE_STATUS_VALUES } from '@archivage/types';

/** Identifiant BigInt décimal (instance, tâche, élément de boîte) transmis comme chaîne. */
export const bigintIdSchema = z.string().regex(/^\d{1,18}$/, 'identifiant invalide');

/** Valeur d'un statut d'instance (0 à 5). */
const instanceStatusSchema = z.coerce
  .number()
  .int()
  .refine((v) => (WF_INSTANCE_STATUS_VALUES as readonly number[]).includes(v), 'statut invalide');

const jsonObjectSchema = z.record(z.string(), z.unknown());

/** Lancement d'une instance. Le lanceur est TOUJOURS l'utilisateur authentifié. */
export const launchInstanceSchema = z
  .object({
    definitionId: z.number().int().positive().max(2_147_483_647),
    context: jsonObjectSchema.optional(),
    subjectType: z.string().min(1).max(100).optional(),
    subjectId: z.string().min(1).max(200).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => (v.subjectType === undefined) === (v.subjectId === undefined), {
    message: 'subjectType et subjectId vont ensemble',
    path: ['subjectId'],
  });
export type LaunchInstanceBody = z.infer<typeof launchInstanceSchema>;

const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};

export const listInstancesQuerySchema = z.object({
  status: instanceStatusSchema.optional(),
  definitionId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  /** Détenteur du menu d'administration : `true` restreint à ses propres instances. */
  mine: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  ...pagination,
});
export type ListInstancesQuery = z.infer<typeof listInstancesQuerySchema>;

export const instanceReasonSchema = z.object({ reason: z.string().max(1000).optional() }).strict().default({});
export type InstanceReasonBody = z.infer<typeof instanceReasonSchema>;

export const listInboxQuerySchema = z.object({
  /** Statuts de boîte (0 à 5), séparés par des virgules ; défaut : ouverts et pris (0,1). */
  status: z
    .string()
    .regex(/^[0-5](,[0-5]){0,5}$/, 'statut invalide')
    .transform((v) => [...new Set(v.split(',').map(Number))])
    .optional(),
  ...pagination,
});
export type ListInboxQuery = z.infer<typeof listInboxQuerySchema>;

export const completeTaskSchema = z
  .object({
    result: z.unknown(),
    expectedRowVersion: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => v.result !== undefined, { message: 'result est requis', path: ['result'] });
export type CompleteTaskBody = z.infer<typeof completeTaskSchema>;

export const rejectTaskSchema = z.object({ comment: z.string().max(4000).optional() }).strict().default({});
export type RejectTaskBody = z.infer<typeof rejectTaskSchema>;

export const delegateTaskSchema = z
  .object({
    toUserGroupId: z.number().int().positive().max(2_147_483_647),
    comment: z.string().max(4000).optional(),
  })
  .strict();
export type DelegateTaskBody = z.infer<typeof delegateTaskSchema>;

/**
 * Tube de validation dont le type de sortie est celui du schéma (le `ZodValidationPipe` générique exige
 * entrée = sortie, ce que `default` / `coerce` / `transform` ne respectent pas).
 */
export function zodPipe<S extends ZodTypeAny>(schema: S): ZodValidationPipe<z.output<S>> {
  return new ZodValidationPipe<z.output<S>>(schema as unknown as ConstructorParameters<typeof ZodValidationPipe<z.output<S>>>[0]);
}
