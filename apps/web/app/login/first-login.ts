/**
 * Première connexion d'un compte créé ou réinitialisé par un administrateur (`mustChangePwd`).
 *
 * Le serveur renvoie `mustChangePwd` dans la réponse de `POST /auth/login`. Tant qu'il vaut `true`,
 * l'écran de connexion n'ouvre PAS la session : le jeton reste en mémoire, il n'est écrit dans
 * `localStorage` (et l'utilisateur envoyé vers l'accueil) qu'une fois le mot de passe changé.
 * Recharger la page, revenir en arrière ou taper une autre adresse ramène donc à la connexion,
 * et l'obligation s'applique de nouveau.
 *
 * Logique pure (le `fetch` est injecté) : testée par `login-logic.test.ts`.
 */

/** Page d'arrivée après une connexion réussie. */
export const HOME_PATH = '/dashboards';

/** Réponse de `POST /auth/login`. */
export interface LoginResponse {
  accessToken: string;
  mustChangePwd?: boolean;
  isAdmin?: boolean;
}

export type PostLoginStep = 'change-password' | 'home';

/**
 * Étape suivant une connexion réussie. Seul un `true` explicite impose le changement : un serveur
 * antérieur qui ne renverrait pas le champ ne doit pas bloquer tous les comptes.
 */
export function stepAfterLogin(res: Pick<LoginResponse, 'mustChangePwd'>): PostLoginStep {
  return res.mustChangePwd === true ? 'change-password' : 'home';
}

/** Message d'erreur lisible à partir du corps d'une réponse d'erreur NestJS. */
export function errorMessageFrom(status: number, body: unknown): string {
  if (status === 401) return 'Session expirée — reconnectez-vous.';
  const raw = (body as { message?: unknown } | null)?.message;
  if (typeof raw === 'string' && raw.trim()) return raw;
  // ZodValidationPipe : tableau « champ: message ». On n'en garde que le message.
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((m) => String(m).replace(/^[\w.()]+:\s*/, '')).join(' — ');
  }
  return `Modification impossible (HTTP ${status}).`;
}

export type ChangeResult = { ok: true } | { ok: false; message: string };

/**
 * Change le mot de passe provisoire avec le jeton tenu EN MÉMOIRE (et non celui de
 * `localStorage`, que `lib/api.ts` lirait) : la session n'existe pas encore côté navigateur.
 */
export async function changeProvisionalPassword(
  fetchImpl: typeof fetch,
  apiBase: string,
  accessToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<ChangeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase}/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  } catch {
    return {
      ok: false,
      message: 'Connexion impossible — réessayez ou vérifiez que le serveur est démarré.',
    };
  }
  if (res.ok) return { ok: true };
  const body: unknown = await res.json().catch(() => null);
  return { ok: false, message: errorMessageFrom(res.status, body) };
}
