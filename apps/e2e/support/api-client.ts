/**
 * Client REST de la pile E2E, bâti sur le contexte de requêtes de Playwright.
 *
 * Il parle directement à l'API (http://127.0.0.1:<E2E_API_PORT>/api), sans passer par le proxy du
 * web : un échec ici désigne l'API, pas Next. Les chemins sont relatifs à `/api`
 * (`api.get('auth/me')` ou `api.get('/auth/me')`, c'est pareil).
 *
 * - `api.get/post/put/patch/del/upload` renvoient le corps décodé (JSON, sinon texte, sinon
 *   `undefined` pour un corps vide) et lèvent une `ApiError` lisible si le statut est >= 400.
 * - `api.raw.<verbe>` renvoie la `APIResponse` de Playwright sans jamais lever : pour tester un
 *   refus (`expect(res.status()).toBe(403)`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_URL } from './env';

/** Valeur de requête acceptée dans `query`. */
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  /** Paramètres ajoutés à l'URL (`undefined` et `null` sont ignorés). */
  query?: Record<string, QueryValue | QueryValue[]>;
  /** En-têtes supplémentaires. */
  headers?: Record<string, string>;
  /** Délai propre à cette requête, en ms (défaut : 30 s). */
  timeout?: number;
}

/** Fichier en mémoire pour `upload`. */
export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface UploadSpec {
  /** Nom du champ multipart du fichier (défaut : `file`). */
  field?: string;
  /** Chemin d'un fichier sur disque, ou fichier en mémoire. */
  file: string | UploadFile;
  /** Champs texte additionnels du formulaire multipart. */
  fields?: Record<string, string | number | boolean>;
}

/** Variante qui ne lève jamais : renvoie la réponse brute. */
export interface RawApi {
  get(path: string, opts?: RequestOptions): Promise<APIResponse>;
  post(path: string, body?: unknown, opts?: RequestOptions): Promise<APIResponse>;
  put(path: string, body?: unknown, opts?: RequestOptions): Promise<APIResponse>;
  patch(path: string, body?: unknown, opts?: RequestOptions): Promise<APIResponse>;
  del(path: string, opts?: RequestOptions): Promise<APIResponse>;
  upload(path: string, spec: UploadSpec, opts?: RequestOptions): Promise<APIResponse>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- `any` par défaut : confort des specs, qui typent au besoin (`api.get<Courrier[]>(…)`). */
export interface ApiClient {
  /** Jeton JWT porté par ce client (`null` : client anonyme). */
  readonly token: string | null;
  /** URL de base, terminée par `/api/`. */
  readonly baseURL: string;
  get<T = any>(path: string, opts?: RequestOptions): Promise<T>;
  post<T = any>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T = any>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T = any>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  del<T = any>(path: string, opts?: RequestOptions): Promise<T>;
  upload<T = any>(path: string, spec: UploadSpec, opts?: RequestOptions): Promise<T>;
  raw: RawApi;
  /** Libère le contexte HTTP sous-jacent. */
  dispose(): Promise<void>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Erreur levée par les méthodes non `raw` quand l'API répond >= 400. */
export class ApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`${method} /api/${path} → ${status} ${ApiError.excerpt(body)}`);
    this.name = 'ApiError';
  }

  private static excerpt(body: unknown): string {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (!text) return '';
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  }
}

function normalizePath(p: string): string {
  let out = p.trim();
  if (out.startsWith('/api/')) out = out.slice(5);
  return out.replace(/^\/+/, '');
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      params.append(key, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function decode(res: APIResponse): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  const type = res.headers()['content-type'] ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function toMultipart(spec: UploadSpec): Record<string, string | number | boolean | { name: string; mimeType: string; buffer: Buffer }> {
  const file =
    typeof spec.file === 'string'
      ? { name: path.basename(spec.file), mimeType: guessMime(spec.file), buffer: fs.readFileSync(spec.file) }
      : spec.file;
  return { ...(spec.fields ?? {}), [spec.field ?? 'file']: file };
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};

function guessMime(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Crée un client REST. Sans jeton : client anonyme (pour tester les refus 401).
 * `apiURL` : origine de l'API (défaut : celle de la pile, `E2E_API_PORT`).
 */
export async function createApiClient(opts: { token?: string | null; apiURL?: string } = {}): Promise<ApiClient> {
  const token = opts.token ?? null;
  const baseURL = `${(opts.apiURL ?? API_URL).replace(/\/+$/, '')}/api/`;
  const ctx: APIRequestContext = await request.newContext({
    baseURL,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
    timeout: 30_000,
  });

  const send = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    p: string,
    body: unknown,
    o: RequestOptions = {},
    multipart?: UploadSpec,
  ): Promise<APIResponse> => {
    const url = normalizePath(p) + buildQuery(o.query);
    return ctx.fetch(url, {
      method,
      headers: o.headers,
      timeout: o.timeout,
      failOnStatusCode: false,
      ...(multipart ? { multipart: toMultipart(multipart) } : body !== undefined ? { data: body } : {}),
    });
  };

  const checked = async (method: string, p: string, resP: Promise<APIResponse>): Promise<unknown> => {
    const res = await resP;
    const decoded = await decode(res);
    if (res.status() >= 400) throw new ApiError(method, normalizePath(p), res.status(), decoded);
    return decoded;
  };

  const raw: RawApi = {
    get: (p, o) => send('GET', p, undefined, o),
    post: (p, b, o) => send('POST', p, b, o),
    put: (p, b, o) => send('PUT', p, b, o),
    patch: (p, b, o) => send('PATCH', p, b, o),
    del: (p, o) => send('DELETE', p, undefined, o),
    upload: (p, spec, o) => send('POST', p, undefined, o, spec),
  };

  /* eslint-disable @typescript-eslint/no-explicit-any -- voir l'interface ApiClient */
  return {
    token,
    baseURL,
    raw,
    get: (p, o) => checked('GET', p, raw.get(p, o)) as Promise<any>,
    post: (p, b, o) => checked('POST', p, raw.post(p, b, o)) as Promise<any>,
    put: (p, b, o) => checked('PUT', p, raw.put(p, b, o)) as Promise<any>,
    patch: (p, b, o) => checked('PATCH', p, raw.patch(p, b, o)) as Promise<any>,
    del: (p, o) => checked('DELETE', p, raw.del(p, o)) as Promise<any>,
    upload: (p, spec, o) => checked('POST', p, raw.upload(p, spec, o)) as Promise<any>,
    dispose: () => ctx.dispose(),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Connexion par l'API : renvoie le jeton d'accès, lève `ApiError` (401) si les identifiants sont refusés. */
export async function loginApi(username: string, password: string, apiURL?: string): Promise<string> {
  const anon = await createApiClient({ apiURL });
  try {
    const res = await anon.post<{ accessToken: string }>('auth/login', { username, password });
    if (!res?.accessToken) throw new Error(`[e2e] auth/login n'a pas renvoyé de accessToken pour ${username}`);
    return res.accessToken;
  } finally {
    await anon.dispose();
  }
}

/** Client REST authentifié pour un autre utilisateur (tests de permissions). */
export async function apiAs(username: string, password: string, apiURL?: string): Promise<ApiClient> {
  return createApiClient({ token: await loginApi(username, password, apiURL), apiURL });
}
