import { z } from 'zod';

export const createDocumentTypeSchema = z.object({
  label: z.string().min(1),
  code: z.string().optional(),
});

/** Édition inline d'un type de document : libellé obligatoire (le code n'est pas géré ici). */
export const updateDocumentTypeSchema = z.object({
  label: z.string().trim().min(1),
});

export const createFileTypeSchema = z.object({
  extension: z.string().min(1),
  friendlyName: z.string().min(1),
  isMedia: z.boolean().optional(),
});

export const createTreeNodeSchema = z.object({
  label: z.string().min(1),
  code: z.string().optional(),
  parentId: z.number().int().positive().optional(),
});

/**
 * Un dossier = un libellé, un code et un parent. Ni localisation ni catégorie : les deux champs
 * ont été retirés de l'écran et de la base (migration 20260731160000). `createTreeNodeSchema`
 * suffit donc désormais — l'alias est conservé pour ne pas renommer les appelants.
 */
export const createDossierSchema = createTreeNodeSchema;

/** Géolocalisation : NOM (label) et CODE obligatoires, PARENT optionnel. */
export const createLocationSchema = z.object({
  label: z.string().trim().min(1),
  code: z.string().trim().min(1),
  parentId: z.number().int().positive().optional(),
});

/**
 * Plan de classement : NOM obligatoire, PARENT et CODE optionnels.
 *
 * Le parent était obligatoire, ce qui rendait l'écran IMPOSSIBLE À AMORCER : sans élément actif,
 * aucun parent n'est proposé, donc aucun élément ne peut être créé — et désactiver la racine
 * suffisait à condamner définitivement la page. Un parent absent signifie « élément racine »,
 * comme pour les dossiers et la géolocalisation, dont `resolveParent` sait déjà s'accommoder.
 */
export const createPlanSchema = z.object({
  label: z.string().trim().min(1),
  parentId: z.number().int().positive().optional(),
  code: z.string().trim().optional(),
});

/** Édition inline d'un plan de classement : libellé et/ou code (le code peut être vidé). */
export const updatePlanSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    code: z.string().trim().optional(),
  })
  .refine((d) => d.label !== undefined || d.code !== undefined, {
    message: 'Aucun champ à mettre à jour',
  });

/** Édition inline d'un élément de géolocalisation (au moins un champ). */
export const updateLocationSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
  })
  .refine((d) => d.label !== undefined || d.code !== undefined, {
    message: 'Aucun champ à mettre à jour',
  });

/** Édition inline d'un dossier : libellé et/ou code (au moins un champ). */
export const updateDossierSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
  })
  .refine((d) => d.label !== undefined || d.code !== undefined, {
    message: 'Aucun champ à mettre à jour',
  });

export const reparentSchema = z.object({
  parentId: z.number().int().positive().nullable(),
});

export const grantDocumentPermissionSchema = z.object({
  documentId: z.number().int().positive(),
  userGroupId: z.number().int().positive(),
  permissionLevelId: z.number().int().positive(),
});

/**
 * Sécurité Documentaire — droit sur un TYPE de document, avec période de validité optionnelle
 * (legacy `DateDebut`/`DateFin`, écrans « Sécurité type document par utilisateur »/« par rôle »).
 */
export const grantTypePermissionSchema = z
  .object({
    documentTypeId: z.number().int().positive(),
    permissionLevelId: z.number().int().positive(),
    roleId: z.number().int().positive().optional(),
    userGroupId: z.number().int().positive().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .refine((d) => (d.roleId == null) !== (d.userGroupId == null), {
    message: 'Fournir exactement un bénéficiaire : roleId OU userGroupId',
  });

/** Confidentialités : libellé seul, comme les autres référentiels « libellé seul » de l'app. */
export const createConfidentialiteSchema = z.object({
  label: z.string().trim().min(1),
});
export const updateConfidentialiteSchema = z.object({
  label: z.string().trim().min(1),
});

export type CreateDocumentTypeDto = z.infer<typeof createDocumentTypeSchema>;
export type UpdateDocumentTypeDto = z.infer<typeof updateDocumentTypeSchema>;
export type CreateFileTypeDto = z.infer<typeof createFileTypeSchema>;
export type CreateTreeNodeDto = z.infer<typeof createTreeNodeSchema>;
export type CreateDossierDto = z.infer<typeof createDossierSchema>;
export type CreateLocationDto = z.infer<typeof createLocationSchema>;
export type UpdateLocationDto = z.infer<typeof updateLocationSchema>;
export type CreatePlanDto = z.infer<typeof createPlanSchema>;
export type UpdatePlanDto = z.infer<typeof updatePlanSchema>;
export type UpdateDossierDto = z.infer<typeof updateDossierSchema>;
export type ReparentDto = z.infer<typeof reparentSchema>;
export type GrantDocumentPermissionDto = z.infer<typeof grantDocumentPermissionSchema>;
export type GrantTypePermissionDto = z.infer<typeof grantTypePermissionSchema>;
export type CreateConfidentialiteDto = z.infer<typeof createConfidentialiteSchema>;
export type UpdateConfidentialiteDto = z.infer<typeof updateConfidentialiteSchema>;
