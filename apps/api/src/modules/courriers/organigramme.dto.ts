import { z } from 'zod';

/** Création d'un nœud d'organigramme (§14). */
export const createNodeSchema = z.object({
  label: z.string().trim().min(1),
  parentId: z.number().int().positive().optional(),
});

/** Édition inline du libellé d'un nœud. */
export const updateNodeSchema = z.object({ label: z.string().trim().min(1) });

/** Déplacement d'un nœud (parent null = racine). */
export const reparentNodeSchema = z.object({
  parentId: z.number().int().positive().nullable(),
});

/** Assignation rôle ↔ organigramme (§15) : null = détacher. */
export const assignRoleSchema = z.object({
  organigrammeId: z.number().int().positive().nullable(),
});

export type CreateNodeBody = z.infer<typeof createNodeSchema>;
export type UpdateNodeBody = z.infer<typeof updateNodeSchema>;
export type ReparentNodeBody = z.infer<typeof reparentNodeSchema>;
export type AssignRoleBody = z.infer<typeof assignRoleSchema>;
