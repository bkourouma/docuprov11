import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

export type LoginDto = z.infer<typeof loginSchema>;

/**
 * Longueur minimale d'un mot de passe : 6 caracteres.
 *
 * C'est la regle de la maison, deja celle de `users.dto.ts` (creation, modification et
 * reinitialisation d'un compte par un administrateur). Le changement en libre-service exigeait
 * 8 : un compte cree a 6 caracteres par un administrateur ne pouvait donc pas etre change pour
 * un mot de passe de meme longueur. Une seule constante desormais, importee des deux cotes.
 */
export const MIN_PASSWORD_LENGTH = 6;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères`,
    ),
});

export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;
