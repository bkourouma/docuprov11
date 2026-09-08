import { z } from 'zod';

/** Référentiel plat : un seul champ libellé (création + édition inline). */
export const labelSchema = z.object({ label: z.string().trim().min(1) });

/** Objet de courrier : libellé + durées de suivi (jours). */
export const createObjetSchema = z.object({
  label: z.string().trim().min(1),
  dureeSuiviExterne: z.number().int().min(0).optional(),
  dureeSuiviInterne: z.number().int().min(0).optional(),
});

export const updateObjetSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    dureeSuiviExterne: z.number().int().min(0).optional(),
    dureeSuiviInterne: z.number().int().min(0).optional(),
  })
  .refine(
    (d) =>
      d.label !== undefined ||
      d.dureeSuiviExterne !== undefined ||
      d.dureeSuiviInterne !== undefined,
    { message: 'Aucun champ à mettre à jour' },
  );

/** Type d'imputation : libellé + drapeau suivi. */
export const createInputationTypeSchema = z.object({
  label: z.string().trim().min(1),
  suivi: z.boolean().optional(),
});

export const updateInputationTypeSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    suivi: z.boolean().optional(),
  })
  .refine((d) => d.label !== undefined || d.suivi !== undefined, {
    message: 'Aucun champ à mettre à jour',
  });

/** Entité externe / correspondant : libellé + coordonnées + type. */
export const createExternalEntitySchema = z.object({
  label: z.string().trim().min(1),
  email: z.string().optional(),
  telephone: z.string().optional(),
  externalEntityTypeId: z.number().int().positive().optional(),
});

export const updateExternalEntitySchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    email: z.string().nullable().optional(),
    telephone: z.string().nullable().optional(),
    externalEntityTypeId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (d) =>
      d.label !== undefined ||
      d.email !== undefined ||
      d.telephone !== undefined ||
      d.externalEntityTypeId !== undefined,
    { message: 'Aucun champ à mettre à jour' },
  );

/**
 * Valeur EAV (propriété personnalisée) d'une entité externe.
 * `externalEntityTypeId` n'est PAS demandé au client : le serveur le déduit de l'entité, comme le
 * source (`ExternalEntityTypeId déduit de l'entité`). Le laisser au client permettrait de ranger
 * une valeur sous un type qui n'est pas celui de son entité.
 */
export const setCustomValueSchema = z.object({
  externalEntityId: z.number().int().positive(),
  externalEntityCustomPropertyId: z.number().int().positive(),
  value: z.string(),
});

export type LabelDto = z.infer<typeof labelSchema>;
export type CreateObjetBody = z.infer<typeof createObjetSchema>;
export type UpdateObjetBody = z.infer<typeof updateObjetSchema>;
export type CreateInputationTypeBody = z.infer<typeof createInputationTypeSchema>;
export type UpdateInputationTypeBody = z.infer<typeof updateInputationTypeSchema>;
export type CreateExternalEntityBody = z.infer<typeof createExternalEntitySchema>;
export type UpdateExternalEntityBody = z.infer<typeof updateExternalEntitySchema>;
export type SetCustomValueBody = z.infer<typeof setCustomValueSchema>;
