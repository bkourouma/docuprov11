import { z } from 'zod';

export const createRoleSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(400).optional(),
  menuKeys: z.array(z.string()).default([]),
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().max(400).nullable().optional(),
  isActive: z.boolean().optional(),
  menuKeys: z.array(z.string()).optional(),
});

export type CreateRoleDto = z.infer<typeof createRoleSchema>;
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;
