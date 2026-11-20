import { z } from 'zod';

/** Plafonds : `code` jusqu'à 4096 (jetons Microsoft volumineux), `state` signé jusqu'à 2048. */
export const OAUTH_CODE_MAX = 4096;
export const OAUTH_STATE_MAX = 2048;
export const OAUTH_REDIRECT_URI_MAX = 2048;

/** POST :id/oauth/start — corps strict. La liste blanche est vérifiée par le service. */
export const oauthStartSchema = z
  .object({ redirectUri: z.string().min(1).max(OAUTH_REDIRECT_URI_MAX) })
  .strict();
export type OAuthStartDto = z.infer<typeof oauthStartSchema>;

/** POST oauth/callback — corps strict (aucun champ inconnu). */
export const oauthCallbackSchema = z
  .object({
    code: z.string().min(1).max(OAUTH_CODE_MAX),
    state: z.string().min(1).max(OAUTH_STATE_MAX),
  })
  .strict();
export type OAuthCallbackDto = z.infer<typeof oauthCallbackSchema>;
