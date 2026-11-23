import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../auth/login.dto';

/**
 * Bornes = tailles des colonnes `app_user` (username 400, first/last_name 50, email 200) : au-delà,
 * PostgreSQL refusait l'écriture et l'API répondait 500 au lieu d'un 400 lisible. L'identifiant est
 * rogné comme à la connexion (`loginSchema`), sinon un espace final créait un compte injoignable.
 */
const username = z.string().trim().min(1).max(400);
const personName = z.string().trim().min(1).max(50);

/**
 * Mot de passe fixé par un gestionnaire (création, fiche, réinitialisation). L'écran de connexion
 * retire les espaces de début et de fin de la saisie (autofill) : un mot de passe enregistré avec
 * un tel espace ne pourrait plus jamais être saisi, le compte serait verrouillé. Même règle que le
 * changement en libre-service (`apps/web/app/login/password-policy.ts`).
 */
const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH)
  .refine((p) => p === p.trim(), 'Le mot de passe ne doit ni commencer ni finir par une espace');

/**
 * L'adresse e-mail est OBLIGATOIRE à la création : c'est elle, et elle seule, qui sert à joindre
 * l'utilisateur par le canal e-mail des notifications (§03.5). Un compte sans adresse ne reçoit
 * rien, silencieusement — d'où le refus en amont plutôt qu'une notification perdue.
 *
 * La colonne reste nullable en base pour les comptes historiques (créés avant cette règle) : les
 * rendre non modifiables serait pire que de les laisser sans adresse.
 */
export const createUserSchema = z.object({
  username,
  firstName: personName,
  lastName: personName,
  email: z.string().max(200).email("L'adresse e-mail est obligatoire et doit être valide"),
  password,
  isAdmin: z.boolean().optional(),
  groupId: z.number().int().positive().optional(),
  roleId: z.number().int().positive().nullable().optional(),
  /** Habilitation de confidentialité : rang minimal que l'utilisateur peut consulter. */
  confidentialiteId: z.number().int().positive().nullable().optional(),
});

// Mise à jour partielle : `email` reste optionnel (on peut ne modifier que le rôle), mais s'il est
// fourni il doit être valide — et l'écran d'édition l'exige systématiquement.
export const updateUserSchema = z.object({
  username: username.optional(),
  firstName: personName.optional(),
  lastName: personName.optional(),
  email: z.string().max(200).email('Adresse e-mail invalide').optional(),
  password: password.optional(),
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
  newPassword: password,
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
