/**
 * Rend l'administrateur du seed directement utilisable et produit son storageState.
 *
 * Le seed crée `admin` / `admin1234` avec `mustChangePwd` : on change ce mot de passe pour
 * ADMIN_PASSWORD par l'API (`POST /api/auth/change-password`, qui lève l'obligation). Idempotent :
 * sur une pile réutilisée, la connexion avec ADMIN_PASSWORD réussit d'emblée.
 */
import fs from 'node:fs';
import { ApiError, createApiClient, loginApi } from './api-client';
import { ADMIN_PASSWORD, ADMIN_USER, SEED_ADMIN_PASSWORD } from './constants';
import { ADMIN_STORAGE_STATE, ADMIN_TOKEN_FILE, AUTH_DIR, WEB_URL } from './env';

/** Contenu d'un storageState Playwright portant le jeton du web (localStorage `token`). */
export function storageStateFor(token: string): {
  cookies: never[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
} {
  return { cookies: [], origins: [{ origin: WEB_URL, localStorage: [{ name: 'token', value: token }] }] };
}

export async function prepareAdmin(): Promise<string> {
  let token: string;
  try {
    token = await loginApi(ADMIN_USER, ADMIN_PASSWORD);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    const seedToken = await loginApi(ADMIN_USER, SEED_ADMIN_PASSWORD);
    const api = await createApiClient({ token: seedToken });
    try {
      await api.post('auth/change-password', { currentPassword: SEED_ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD });
    } finally {
      await api.dispose();
    }
    token = await loginApi(ADMIN_USER, ADMIN_PASSWORD);
  }
  const me = await createApiClient({ token });
  try {
    const profile = await me.get<{ mustChangePwd?: boolean; isAdmin?: boolean }>('auth/me');
    if (profile.mustChangePwd || !profile.isAdmin) {
      throw new Error(`[e2e] l'administrateur n'est pas utilisable : ${JSON.stringify(profile)}`);
    }
  } finally {
    await me.dispose();
  }
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(ADMIN_TOKEN_FILE, token);
  fs.writeFileSync(ADMIN_STORAGE_STATE, JSON.stringify(storageStateFor(token), null, 2));
  return token;
}

/** Jeton administrateur écrit par le global setup (null s'il est absent). */
export function readAdminToken(): string | null {
  try {
    return fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
