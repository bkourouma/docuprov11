/** JWT payload carried in the Bearer token. userGroupId is the effective actor (D7). */
export interface JwtPayload {
  sub: number;
  username: string;
  isAdmin: boolean;
  userGroupId: number | null;
  /**
   * Nom affichable de l'acteur, porte par le jeton pour que les ecritures d'audit puissent
   * le figer sans requete supplementaire. Absent des jetons emis avant 2026-09-08 : les
   * appelants retombent sur `username`.
   */
  fullName?: string | null;
}

/** Authenticated user attached to the request after JWT validation. */
export interface AuthUser {
  userId: number;
  username: string;
  isAdmin: boolean;
  userGroupId: number | null;
  /** Nom affichable (peut manquer sur un jeton anterieur au 2026-09-08). */
  fullName?: string | null;
  /**
   * Identité machine issue de `SCAN_AGENT_API_KEY` — pas un compte : `userId` ne correspond à
   * aucune ligne, `userGroupId` est `null` (le dépôt n'a pas d'auteur, l'auteur du courrier est
   * saisi à l'enregistrement §05). Ne peut être posée que sur les routes `@AllowScanAgentKey()`.
   */
  isScanAgent?: boolean;
}
