import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

export type LoginDto = z.infer<typeof loginSchema>;

/** Password policy: minimum 8 characters (FR-034 / T057). */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères'),
});

export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
