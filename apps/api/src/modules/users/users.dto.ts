import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../auth/login.dto';

/**
 * L'adresse e-mail est OBLIGATOIRE à la création : c'est elle, et elle seule, qui sert à joindre
 * l'utilisateur par le canal e-mail des notifications (§03.5). Un compte sans adresse ne reçoit
 * rien, silencieusement — d'où le refus en amont plutôt qu'une notification perdue.
 *
 * La colonne reste nullable en base pour les comptes historiques (créés avant cette règle) : les
 * rendre non modifiables serait pire que de les laisser sans adresse.
 */
export const createUserSchema = z.object({
  username: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email("L'adresse e-mail est obligatoire et doit être valide"),
  password: z.string().min(MIN_PASSWORD_LENGTH),
  isAdmin: z.boolean().optional(),
  groupId: z.number().int().positive().optional(),
  roleId: z.number().int().positive().nullable().optional(),
  /** Habilitation de confidentialité : rang minimal que l'utilisateur peut consulter. */
  confidentialiteId: z.number().int().positive().nullable().optional(),
});

// Mise à jour partielle : `email` reste optionnel (on peut ne modifier que le rôle), mais s'il est
// fourni il doit être valide — et l'écran d'édition l'exige systématiquement.
export const updateUserSchema = z.object({
  username: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email('Adresse e-mail invalide').optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).optional(),
  isDisabled: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  roleId: z.number().int().positive().nullable().optional(),
  /** Habilitation de confidentialité : rang minimal que l'utilisateur peut consulter. */
  confidentialiteId: z.number().int().positive().nullable().optional(),
});

/**
 * Affectation EN MASSE du niveau de confidentialité (écran « Confidentialité des utilisateurs »,
 * menu Sécurité Documentaire). Volontairement distinct de `updateUserSchema` : cet écran est
 * accessible sans le menu « Utilisateurs », il ne doit donc jamais servir de porte dérobée vers
 * `isAdmin`, `roleId` ou `password`. `null` retire l'habilitation.
 */
export const bulkConfidentialiteSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1),
  confidentialiteId: z.number().int().positive().nullable(),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(MIN_PASSWORD_LENGTH),
});

export const assignGroupSchema = z.object({
  groupId: z.number().int().positive(),
  isDefault: z.boolean().optional(),
});

export const createGroupSchema = z.object({
  name: z.string().min(1),
});

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type BulkConfidentialiteDto = z.infer<typeof bulkConfidentialiteSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
export type AssignGroupDto = z.infer<typeof assignGroupSchema>;
export type CreateGroupDto = z.infer<typeof createGroupSchema>;
