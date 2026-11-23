import { z } from 'zod';

/**
 * Nom de rôle : rogné AVANT la vérification de longueur. Avec `.min(1)` seul, un nom fait
 * d'espaces passait la validation puis était enregistré vide par le `trim()` du service.
 * 200 = taille de la colonne `role.name` (au-delà, erreur base de données en 500).
 */
const roleName = z.string().trim().min(1, 'Le nom du rôle est obligatoire').max(200);

export const createRoleSchema = z.object({
  name: roleName,
  description: z.string().max(400).optional(),
  menuKeys: z.array(z.string()).default([]),
});

export const updateRoleSchema = z.object({
  name: roleName.optional(),
  description: z.string().max(400).nullable().optional(),
  isActive: z.boolean().optional(),
  menuKeys: z.array(z.string()).optional(),
});

export type CreateRoleDto = z.infer<typeof createRoleSchema>;
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;
