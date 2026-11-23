/**
 * Client REST minimal par `fetch`, pour les aides qui doivent agir AU NOM d'un acteur sans avoir
 * accès à la fixture `apiAs` (les aides ne reçoivent que le client admin `api`).
 *
 * Hypothèses à vérifier en phase B :
 *  - Base d'URL de l'API : `E2E_API_URL` si défini (ex. `http://127.0.0.1:3001/api`), sinon
 *    `<E2E_BASE_URL | PLAYWRIGHT_BASE_URL | BASE_URL | http://localhost:3000>/api` — le web Next.js
 *    proxifie `/api/*` vers l'API (`apps/web/next.config.mjs`, rewrites) et l'API a le préfixe
 *    global `api` (`apps/api/src/main.ts`). Aligner sur la variable que pose le lot 0.
 *  - Authentification : `POST /auth/login` → `{ accessToken }`, puis `Authorization: Bearer`.
 *  - Si la fixture expose un jour une fabrique de client hors test (ex. `createApiClient`),
 *    remplacer `loginApi` par elle : la forme (`get`/`post`/`del`) est volontairement la même.
 */

export function apiBaseUrl(): string {
  const explicit = process.env.E2E_API_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const web =
    process.env.E2E_BASE_URL ??
    process.env.PLAYWRIGHT_BASE_URL ??
    process.env.BASE_URL ??
    'http://localhost:3000';
  return `${web.replace(/\/$/, '')}/api`;
}

export interface MiniApi {
  readonly token: string;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  del<T = any>(path: string): Promise<T>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`HTTP ${status} sur ${path} : ${JSON.stringify(body)}`);
  }
}

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (res.status >= 400) throw new HttpError(res.status, path, json);
  return json as T;
}

/** Ouvre une session REST pour `username` (lève `HttpError` si les identifiants sont refusés). */
export async function loginApi(username: string, password: string): Promise<MiniApi> {
  const { accessToken } = await call<{ accessToken: string }>('POST', '/auth/login', null, {
    username,
    password,
  });
  return {
    token: accessToken,
    get: (path) => call('GET', path, accessToken),
    post: (path, body) => call('POST', path, accessToken, body ?? {}),
    del: (path) => call('DELETE', path, accessToken),
  };
}
