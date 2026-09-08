import { contentTypeFor } from './candidates';
import type { Credentials } from './config/env';

/** Erreur d'envoi portant la décision de rejeu — c'est elle qui trie « on réessaie » / « quarantaine ». */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Compte de service refusé (401 après re-login, ou 403). Ce n'est pas le fichier qui est en cause :
 * on interrompt le cycle sans rien mettre en quarantaine, l'administrateur corrige le compte ou le
 * rôle, et le cycle suivant repart tout seul.
 */
export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface UploadedScanResult {
  mailScannedDocumentId: number;
  fileName: string | null;
}

export interface ScanApiClientOptions {
  baseUrl: string;
  credentials: Credentials;
  /** Injectable pour les tests ; par défaut le `fetch` global (Node ≥ 20). */
  fetchImpl?: typeof fetch;
}

/**
 * Client de la file §07, avec deux modes d'authentification :
 *
 *  - **clé de service** (`X-Api-Key`) : un en-tête constant, rien à renouveler — le mode normal
 *    d'un service installé sur un poste ;
 *  - **compte applicatif** : le jeton JWT expire (`JWT_EXPIRES_IN`, 1 jour par défaut) alors que
 *    l'agent tourne des semaines, il est donc obtenu paresseusement, gardé en mémoire, et renouvelé
 *    une fois sur 401 avant de rejouer la requête.
 */
export class ScanApiClient {
  private token: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: ScanApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Vérifie que l'agent ouvre bien la file §07 — appelé au démarrage. */
  async checkAccess(): Promise<void> {
    const res = await this.authorized((headers) =>
      this.fetchImpl(`${this.baseUrl}/courriers/documents-scannes?page=1&pageSize=1`, { headers }),
    );
    if (res.status === 403) {
      throw new AuthorizationError("L'agent n'a pas accès à la file des documents scannés", 403);
    }
    if (!res.ok) {
      throw new UploadError(`Vérification d'accès échouée (HTTP ${res.status})`, true, res.status);
    }
  }

  async upload(
    fileName: string,
    content: Buffer,
    machineName: string,
  ): Promise<UploadedScanResult> {
    const res = await this.authorized((headers) => {
      // FormData/Blob natifs : le boundary multipart est posé par le runtime, ne jamais fixer
      // Content-Type à la main ici (le serveur ne retrouverait pas la frontière des parties).
      const form = new FormData();
      const view = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
      form.append('file', new Blob([view], { type: contentTypeFor(fileName) }), fileName);
      form.append('machineName', machineName);
      return this.fetchImpl(`${this.baseUrl}/courriers/documents-scannes`, {
        method: 'POST',
        headers,
        body: form,
      });
    });

    if (res.ok) return (await res.json()) as UploadedScanResult;
    if (res.status === 403) {
      throw new AuthorizationError('Dépôt refusé : permission de menu manquante', 403);
    }
    const detail = await readErrorMessage(res);
    // 4xx = le fichier lui-même est refusé (extension, taille) : le rejouer ne changera rien.
    throw new UploadError(detail, res.status >= 500 || res.status === 429, res.status);
  }

  /**
   * Joue la requête avec des en-têtes d'authentification valides.
   *
   * Avec une clé de service il n'y a rien à renouveler : un 401 signifie que la clé est fausse ou
   * absente côté serveur, la rejouer ne changerait rien. Avec un compte, le 401 est le cas normal
   * d'un jeton expiré — on se reconnecte une fois et on rejoue.
   */
  private async authorized(
    run: (headers: Record<string, string>) => Promise<Response>,
  ): Promise<Response> {
    const credentials = this.options.credentials;
    if (credentials.kind === 'apiKey') {
      const res = await this.attempt(() => run({ 'X-Api-Key': credentials.apiKey }));
      if (res.status === 401) {
        throw new AuthorizationError(
          'Clé de service refusée : SCAN_AGENT_API_KEY ne correspond pas à celle du serveur',
          401,
        );
      }
      return res;
    }

    const res = await this.attempt(async () => run(await this.bearer(credentials)));
    if (res.status !== 401) return res;
    this.token = null;
    const retried = await this.attempt(async () => run(await this.bearer(credentials)));
    if (retried.status === 401) {
      throw new AuthorizationError('Identifiants du compte de service refusés', 401);
    }
    return retried;
  }

  /** Une coupure réseau n'est pas une erreur de fichier : toujours rejouable. */
  private async attempt(send: () => Promise<Response>): Promise<Response> {
    try {
      return await send();
    } catch (e) {
      if (e instanceof UploadError || e instanceof AuthorizationError) throw e;
      throw new UploadError(`API injoignable : ${(e as Error).message}`, true);
    }
  }

  private async bearer(
    credentials: Extract<Credentials, { kind: 'password' }>,
  ): Promise<Record<string, string>> {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    const res = await this.attempt(() =>
      this.fetchImpl(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
        }),
      }),
    );
    if (res.status === 401) {
      throw new AuthorizationError('Identifiants du compte de service refusés', 401);
    }
    if (!res.ok) {
      throw new UploadError(`Connexion échouée (HTTP ${res.status})`, true, res.status);
    }
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) throw new UploadError('Réponse de connexion sans accessToken', true);
    this.token = body.accessToken;
    return { Authorization: `Bearer ${this.token}` };
  }
}

/** Extrait le message d'erreur de l'API (filtre d'exception global) sans jamais lever. */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    const { message } = body;
    if (typeof message === 'string') return `HTTP ${res.status} — ${message}`;
    if (Array.isArray(message)) return `HTTP ${res.status} — ${message.join(' ; ')}`;
  } catch {
    /* corps vide ou non-JSON : le statut suffit */
  }
  return `HTTP ${res.status}`;
}
