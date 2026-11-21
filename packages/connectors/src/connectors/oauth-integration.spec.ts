// Lot 2b — intégration connecteurs + vrai client OAuth (jeton, quota, hôtes), transport HTTP simulé.
// Aucun appel réseau : `deps.http` répond selon l'URL.
import { buildConnector } from '../registry';
import { createDefaultRegistry } from '../default-registry';
import {
  ConnectorAuthError,
  ConnectorQuotaError,
  type ConnectorCredentials,
  type ConnectorDeps,
} from '../types';
import type { OAuthHttpClient, OAuthHttpRequest, OAuthHttpResponse } from '../oauth-contract';

const NOW = new Date('2026-11-20T12:00:00Z');
const ENV = {
  GED_GOOGLE_CLIENT_ID: 'gid',
  GED_GOOGLE_CLIENT_SECRET: 'gsecret-xyz-123',
  GED_MS_CLIENT_ID: 'mid',
  GED_MS_CLIENT_SECRET: 'msecret-xyz-456',
  GED_MS_TENANT: 'contoso.onmicrosoft.com',
} as NodeJS.ProcessEnv;
const CREDS: ConnectorCredentials = { refreshToken: 'refresh-secret-abcdef' };

const json = (status: number, body: unknown, headers: Record<string, string> = {}): OAuthHttpResponse => ({
  status,
  headers,
  body: Buffer.from(JSON.stringify(body)),
});

function fakeHttp(handler: (req: OAuthHttpRequest) => OAuthHttpResponse) {
  const calls: OAuthHttpRequest[] = [];
  const http: OAuthHttpClient = {
    request: async (req) => {
      calls.push(req);
      return handler(req);
    },
  };
  return { http, calls };
}

function build(type: string, config: unknown, http: OAuthHttpClient, extra: Partial<ConnectorDeps> = {}) {
  return buildConnector(createDefaultRegistry(), type, {
    config,
    credentials: CREDS,
    deps: { env: ENV, http, now: () => NOW, ...extra },
  });
}

const tokenOk = (_req: OAuthHttpRequest) => json(200, { access_token: 'access-secret-123', expires_in: 3600 });

describe('lot 2b — intégration avec le client OAuth réel (HTTP simulé)', () => {
  it('Drive : 429 avec Retry-After ⇒ ConnectorQuotaError(retryAfterMs), sans jeton dans le message', async () => {
    const { http, calls } = fakeHttp((req) =>
      req.url.startsWith('https://oauth2.googleapis.com/token')
        ? tokenOk(req)
        : json(429, { error: { message: 'slow down' } }, { 'retry-after': '120' }),
    );
    const c = build('google_drive', {}, http);
    await c.authenticate();
    const err = await c.listChanges(null, { pageSize: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorQuotaError);
    expect((err as ConnectorQuotaError).retryAfterMs).toBe(120_000);
    expect(String(err.message)).not.toMatch(/access-secret|refresh-secret|gsecret/);
    // Seuls les hôtes officiels Google ont été appelés.
    for (const call of calls) expect(new URL(call.url).hostname).toMatch(/^(www|oauth2)\.googleapis\.com$/);
  });

  it('Drive : 403 rateLimitExceeded ⇒ quota (et non refus d’accès)', async () => {
    const { http } = fakeHttp((req) =>
      req.url.includes('oauth2.googleapis.com')
        ? tokenOk(req)
        : json(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
    );
    const c = build('google_drive', {}, http);
    await expect(c.listChanges(null, { pageSize: 10 })).rejects.toBeInstanceOf(ConnectorQuotaError);
  });

  it('Drive : invalid_grant au rafraîchissement ⇒ ConnectorAuthError expirée', async () => {
    const { http } = fakeHttp(() => json(400, { error: 'invalid_grant', error_description: 'Token has been revoked' }));
    const c = build('google_drive', {}, http);
    const err = await c.authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorAuthError);
    expect((err as ConnectorAuthError).expired).toBe(true);
    expect(String(err.message)).not.toContain('refresh-secret');
  });

  it('OneDrive : nextLink vers un hôte non officiel refusé, jamais appelé, jeton non transmis', async () => {
    const { http, calls } = fakeHttp((req) => {
      if (req.url.includes('login.microsoftonline.com')) return tokenOk(req);
      return json(200, { value: [], '@odata.nextLink': 'https://evil.example/steal?x=1' });
    });
    const c = build('microsoft_onedrive', {}, http);
    const first = await c.listChanges(null, { pageSize: 10 }).catch((e) => e);
    // Soit la première page signale le lien étranger, soit la page suivante est refusée : jamais d'appel.
    if (!(first instanceof Error)) {
      expect(first.hasMore).toBe(true);
      const second = await c.listChanges(first.nextToken, { pageSize: 10 }).catch((e) => e);
      expect(second).toBeInstanceOf(Error);
    }
    expect(calls.some((x) => new URL(x.url).hostname === 'evil.example')).toBe(false);
  });

  it('OneDrive : jeton de changement relu en base vers un hôte étranger ⇒ refus sans appel', async () => {
    const { http, calls } = fakeHttp(tokenOk);
    const c = build('microsoft_onedrive', {}, http);
    const bad = JSON.stringify({ k: 'delta', u: 'https://graph.microsoft.com.evil.example/v1.0/x' });
    await expect(c.listChanges(bad, { pageSize: 10 })).rejects.toBeInstanceOf(Error);
    expect(calls.some((x) => x.url.includes('evil.example'))).toBe(false);
  });

  it('Graph : 429 ⇒ quota ; rotation du jeton ⇒ onCredentialsChanged reçoit le nouveau jeton', async () => {
    const { http } = fakeHttp((req) =>
      req.url.includes('login.microsoftonline.com')
        ? json(200, { access_token: 'a2', expires_in: 3600, refresh_token: 'refresh-NEW-999' })
        : json(429, {}, { 'retry-after': '30' }),
    );
    const onCredentialsChanged = jest.fn().mockResolvedValue(undefined);
    const c = build('microsoft_onedrive', {}, http, { onCredentialsChanged });
    await expect(c.listChanges(null, { pageSize: 5 })).rejects.toBeInstanceOf(ConnectorQuotaError);
    expect(onCredentialsChanged).toHaveBeenCalledWith({ refreshToken: 'refresh-NEW-999' });
  });

  it('Outlook : le connecteur se construit via le registre par défaut', async () => {
    const { http } = fakeHttp(tokenOk);
    const c = buildConnector(createDefaultRegistry(), 'microsoft_outlook', {
      config: { mailboxAddress: 'boite@exemple.test' },
      credentials: { refreshToken: 'x' },
      deps: { env: ENV, http, now: () => NOW },
    });
    expect(c.type).toBe('microsoft_outlook');
  });
});
