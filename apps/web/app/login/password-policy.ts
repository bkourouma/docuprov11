/**
 * Règles de saisie d'un NOUVEAU mot de passe, partagées par l'étape de première connexion
 * (`FirstLoginStep`) et par « Mon profil ».
 *
 * Logique pure, sans React ni AntD : testée par `login-logic.test.ts` (`tsx --test`).
 */

/** Longueur minimale imposée par le serveur (`MIN_PASSWORD_LENGTH`, `apps/api/.../login.dto.ts`). */
export const MIN_PASSWORD_LENGTH = 6;

export const PASSWORD_MESSAGES = {
  tooShort: `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères`,
  /**
   * L'écran de connexion retire les espaces de début et de fin du mot de passe saisi (autofill
   * Edge/Chrome). Un mot de passe ENREGISTRÉ avec un tel espace ne pourrait donc plus jamais être
   * saisi avec succès : le compte serait verrouillé. On le refuse dès la saisie.
   */
  edgeSpaces: 'Le mot de passe ne doit ni commencer ni finir par une espace',
  sameAsProvisional: 'Choisissez un mot de passe différent du mot de passe provisoire',
} as const;

/**
 * Premier problème du nouveau mot de passe, ou `null` s'il est acceptable.
 *
 * Un champ vide n'est pas traité ici : la règle `required` du formulaire porte son propre message.
 * `provisional` (étape de première connexion seulement) : le mot de passe attribué par
 * l'administrateur, que l'utilisateur ne doit pas reconduire.
 */
export function newPasswordError(
  password: string | null | undefined,
  opts: { provisional?: string } = {},
): string | null {
  if (!password) return null;
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_MESSAGES.tooShort;
  if (password !== password.trim()) return PASSWORD_MESSAGES.edgeSpaces;
  if (opts.provisional !== undefined && password === opts.provisional) {
    return PASSWORD_MESSAGES.sameAsProvisional;
  }
  return null;
}
