import {
  OAuthApiError,
  OAuthConfigError,
  OAuthHostError,
  type OAuthHttpClient,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type OAuthProviderId,
} from './oauth-contract';
import { createOfficialHttpClient, type OAuthTransport, type OAuthTransportRequest } from './oauth-http';
import { createOAuthApiClient, parseRetryAfterMs } from './oauth-session';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ConnectorCredentials,
} from './types';

// Valeurs FICTIVES : aucun message d'erreur ne doit les contenir.
const G_SECRET = 'TEST-google-secret-0000000000';
const MS_SECRET = 'TEST-ms-secret-1111111111111';
const REFRESH = 'TEST-refresh-token-4444444444444';
const ROTATED = 'TEST-rotated-refresh-7777777777';
const ACCESS1 = 'TEST-access-token-AAAAAAAAAAAA';
const ACCESS2 = 'TEST-access-token-BBBBBBBBBBBB';
const SECRETS = [G_SECRET, MS_SECRET, REFRESH, ROTATED, ACCESS1, ACCESS2];

const ENV: NodeJS.ProcessEnv = {
  GED_GOOGLE_CLIENT_ID: 'test-google-client-id',
  GED_GOOGLE_CLIENT_SECRET: G_SECRET,
  GED_MS_CLIENT_ID: 'test-ms-client-id',
  GED_MS_CLIENT_SECRET: MS_SECRET,
  GED_MS_TENANT: 'common',
};
const G_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const G_API = 'https://www.googleapis.com/drive/v3/files?pageSize=10';
const MS_API = 'https://graph.microsoft.com/v1.0/me/drive/root/delta';

function expectNoSecrets(err: unknown): void {
  const e = err as Error;
  for (const s of SECRETS) {
    expect(e.message).not.toContain(s);
    expect(String(e.stack)).not.toContain(s);
  }
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('aucune erreur levée');
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): OAuthHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});

type Handler = (req: OAuthHttpRequest) => OAuthHttpResponse | Promise<OAuthHttpResponse>;

/**
 * Client HTTP simulé : le point de jeton délivre ACCESS1, ACCESS2… (ou ce que `token` renvoie), les
 * appels d'API passent par `api`.
 */
function harness(opts: {
  provider?: OAuthProviderId;
  credentials?: ConnectorCredentials;
  token?: Handler;
  api?: Handler;
  onCredentialsChanged?: (next: ConnectorCredentials) => Promise<void>;
}) {
  const provider = opts.provider ?? 'google';
  const tokenUrl = provider === 'google' ? G_TOKEN_URL : MS_TOKEN_URL;
  let clock = new Date('2026-11-20T10:00:00Z').getTime();
  const tokenCalls: OAuthHttpRequest[] = [];
  const apiCalls: OAuthHttpRequest[] = [];
  const issued = [ACCESS1, ACCESS2, 'TEST-access-token-CCCCCCCCCCCC', 'TEST-access-token-DDDDDDDDDDDD'];
  const http: OAuthHttpClient = {
    request: async (req) => {
      if (req.url === tokenUrl) {
        tokenCalls.push(req);
        if (opts.token) return opts.token(req);
        return json(200, { access_token: issued[tokenCalls.length - 1], expires_in: 3600, token_type: 'Bearer' });
      }
      apiCalls.push(req);
      if (opts.api) return opts.api(req);
      return json(200, { ok: true });
    },
  };
  const client = createOAuthApiClient({
    provider,
    credentials: opts.credentials ?? { refreshToken: REFRESH },
    env: ENV,
    scopes: provider === 'google' ? ['https://www.googleapis.com/auth/drive.readonly'] : ['Files.Read.All'],
    http,
    now: () => new Date(clock),
    onCredentialsChanged: opts.onCredentialsChanged,
  });
  return {
    client,
    tokenCalls,
    apiCalls,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
}

const bearer = (req: OAuthHttpRequest | undefined): string | undefined => req?.headers?.authorization;

// ---------------------------------------------------------------------------
// Jeton d'accès
// ---------------------------------------------------------------------------

describe('jeton d’accès', () => {
  it('Google : rafraîchissement par refresh_token, sans périmètre', async () => {
    const h = harness({});
    await h.client.authenticate();
    expect(h.tokenCalls).toHaveLength(1);
    const req = h.tokenCalls[0] as OAuthHttpRequest;
    expect(req.method).toBe('POST');
    expect(req.redirects ?? 'none').toBe('none');
    const form = new URLSearchParams(req.body);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe(REFRESH);
    expect(form.get('client_id')).toBe('test-google-client-id');
    expect(form.get('client_secret')).toBe(G_SECRET);
    expect(form.has('scope')).toBe(false);
  });

  it('Microsoft : périmètres + offline_access envoyés', async () => {
    const h = harness({ provider: 'microsoft' });
    await h.client.authenticate();
    expect(new URLSearchParams(h.tokenCalls[0]?.body).get('scope')).toBe('Files.Read.All offline_access');
  });

  it('cache avec marge de 60 s', async () => {
    const h = harness({});
    await h.client.getJson(G_API);
    await h.client.getJson(G_API);
    expect(h.tokenCalls).toHaveLength(1);
    expect(bearer(h.apiCalls[1])).toBe(`Bearer ${ACCESS1}`);
    h.advance(3600_000 - 61_000); // 61 s avant l'expiration : encore bon
    await h.client.getJson(G_API);
    expect(h.tokenCalls).toHaveLength(1);
    h.advance(2_000); // 59 s avant : rafraîchi d'avance
    await h.client.getJson(G_API);
    expect(h.tokenCalls).toHaveLength(2);
    expect(bearer(h.apiCalls[3])).toBe(`Bearer ${ACCESS2}`);
  });

  it('rafraîchissement unique en vol (coalescence)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({
      token: async () => {
        await gate;
        return json(200, { access_token: ACCESS1, expires_in: 3600 });
      },
    });
    const pending = Promise.all([1, 2, 3, 4, 5].map(() => h.client.getJson(G_API)));
    await new Promise((r) => setTimeout(r, 5));
    release();
    await pending;
    expect(h.tokenCalls).toHaveLength(1);
    expect(h.apiCalls).toHaveLength(5);
    expect(h.apiCalls.every((c) => bearer(c) === `Bearer ${ACCESS1}`)).toBe(true);
  });

  it('échec partagé, puis nouvel essai possible', async () => {
    let n = 0;
    const h = harness({
      token: () => (++n === 1 ? json(500, { error: 'server_error' }) : json(200, { access_token: ACCESS1, expires_in: 3600 })),
    });
    const results = await Promise.allSettled([h.client.getJson(G_API), h.client.getJson(G_API)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(h.tokenCalls).toHaveLength(1);
    await h.client.getJson(G_API);
    expect(h.tokenCalls).toHaveLength(2);
  });

  it('refreshToken absent → ConnectorAuthError(expired=true) « non autorisé », aucun appel', async () => {
    const h = harness({ credentials: {} });
    const e = await caught(h.client.authenticate());
    expect(e).toBeInstanceOf(ConnectorAuthError);
    expect((e as ConnectorAuthError).expired).toBe(true);
    expect(e.message).toMatch(/non autorisé/);
    expect(h.tokenCalls).toHaveLength(0);
  });

  it.each(['invalid_grant', 'interaction_required', 'consent_required'])(
    '%s → ConnectorAuthError(expired=true), message sans secret',
    async (error) => {
      const h = harness({
        token: () =>
          json(400, {
            error,
            error_description: `AADSTS70008: le jeton ${REFRESH} a expiré (secret ${G_SECRET})`,
          }),
      });
      const e = await caught(h.client.getJson(G_API));
      expect(e).toBeInstanceOf(ConnectorAuthError);
      expect((e as ConnectorAuthError).expired).toBe(true);
      expect(e.message).toBe('Autorisation expirée ou révoquée : autorisez de nouveau l’accès au compte.');
      expect(h.apiCalls).toHaveLength(0);
      expectNoSecrets(e);
    },
  );

  it.each(['invalid_client', 'unauthorized_client'])('%s → ConnectorAuthError(expired=false)', async (error) => {
    const h = harness({ token: () => json(401, { error }) });
    const e = await caught(h.client.authenticate());
    expect(e).toBeInstanceOf(ConnectorAuthError);
    expect((e as ConnectorAuthError).expired).toBe(false);
    expect(e.message).toContain('GED_GOOGLE_CLIENT_SECRET');
    expectNoSecrets(e);
  });

  it('point de jeton limité (429) → ConnectorQuotaError', async () => {
    const h = harness({ token: () => json(429, { error: 'too_many' }, { 'retry-after': '30' }) });
    const e = await caught(h.client.authenticate());
    expect(e).toBeInstanceOf(ConnectorQuotaError);
    expect((e as ConnectorQuotaError).retryAfterMs).toBe(30_000);
  });

  it('réponse de jeton sans access_token → OAuthApiError, sans secret', async () => {
    const h = harness({ token: () => json(200, { refresh_token: REFRESH }) });
    const e = await caught(h.client.authenticate());
    expect(e).toBeInstanceOf(OAuthApiError);
    expectNoSecrets(e);
  });

  it('fournisseur non configuré → OAuthConfigError (noms des variables)', async () => {
    const client = createOAuthApiClient({
      provider: 'microsoft',
      credentials: { refreshToken: REFRESH },
      env: {},
      scopes: ['Files.Read.All'],
      http: { request: async () => json(200, {}) },
    });
    const e = await caught(client.authenticate());
    expect(e).toBeInstanceOf(OAuthConfigError);
    expect(e.message).toContain('GED_MS_TENANT');
  });

  it('rotation du refresh_token (Microsoft) → onCredentialsChanged, nouveau jeton réutilisé', async () => {
    const changed: ConnectorCredentials[] = [];
    let n = 0;
    const h = harness({
      provider: 'microsoft',
      credentials: { refreshToken: REFRESH, tenantHint: 'x' },
      token: () => {
        n++;
        return json(200, {
          access_token: n === 1 ? ACCESS1 : ACCESS2,
          expires_in: 3600,
          refresh_token: n === 1 ? ROTATED : ROTATED,
        });
      },
      onCredentialsChanged: async (next) => {
        changed.push(next);
      },
    });
    await h.client.authenticate();
    expect(changed).toEqual([{ refreshToken: ROTATED, tenantHint: 'x' }]);
    h.advance(3600_000);
    await h.client.authenticate();
    // Le rafraîchissement suivant utilise le jeton tourné ; renvoyé à l'identique : pas de rappel.
    expect(new URLSearchParams(h.tokenCalls[1]?.body).get('refresh_token')).toBe(ROTATED);
    expect(changed).toHaveLength(1);
  });

  it('rappel de rotation en échec : avalé, la passe continue avec le jeton en mémoire', async () => {
    const h = harness({
      provider: 'microsoft',
      token: () => json(200, { access_token: ACCESS1, expires_in: 3600, refresh_token: ROTATED }),
      onCredentialsChanged: async () => {
        throw new Error(`échec base ${ROTATED}`);
      },
    });
    await expect(h.client.getJson(MS_API)).resolves.toEqual({ ok: true });
    expect(bearer(h.apiCalls[0])).toBe(`Bearer ${ACCESS1}`);
  });

  it('même refresh_token renvoyé (Google) : pas de rappel', async () => {
    const cb = jest.fn(async () => undefined);
    const h = harness({
      token: () => json(200, { access_token: ACCESS1, expires_in: 3600, refresh_token: REFRESH }),
      onCredentialsChanged: cb,
    });
    await h.client.authenticate();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Appels d'API
// ---------------------------------------------------------------------------

describe('appels d’API', () => {
  it('getJson : Bearer ajouté par la session uniquement, plafond JSON, aucune redirection', async () => {
    const h = harness({});
    const out = await h.client.getJson<{ ok: boolean }>(G_API, {
      headers: { Authorization: 'Bearer forge', cookie: 'x=1', 'X-Custom': 'oui' },
    });
    expect(out).toEqual({ ok: true });
    const req = h.apiCalls[0] as OAuthHttpRequest;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(G_API);
    expect(req.redirects).toBe('none');
    expect(req.maxBytes).toBe(25 * 1024 * 1024);
    expect(req.headers?.authorization).toBe(`Bearer ${ACCESS1}`);
    expect(Object.keys(req.headers ?? {}).filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
    expect(Object.keys(req.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(req.headers?.['X-Custom']).toBe('oui');
  });

  it('401 → un rafraîchissement forcé puis UN seul nouvel essai', async () => {
    let n = 0;
    const h = harness({ api: () => (++n === 1 ? json(401, {}) : json(200, { ok: 2 })) });
    await expect(h.client.getJson(G_API)).resolves.toEqual({ ok: 2 });
    expect(h.tokenCalls).toHaveLength(2);
    expect(h.apiCalls).toHaveLength(2);
    expect(bearer(h.apiCalls[0])).toBe(`Bearer ${ACCESS1}`);
    expect(bearer(h.apiCalls[1])).toBe(`Bearer ${ACCESS2}`);
  });

  it('401 répété → ConnectorAuthError, pas de troisième essai', async () => {
    const h = harness({ api: () => json(401, { error: { code: 'InvalidAuthenticationToken' } }) });
    const e = await caught(h.client.getJson(G_API));
    expect(e).toBeInstanceOf(ConnectorAuthError);
    expect(h.apiCalls).toHaveLength(2);
    expect(h.tokenCalls).toHaveLength(2);
    expectNoSecrets(e);
  });

  it('401 concurrents : un seul rafraîchissement forcé', async () => {
    const seen = new Map<string, number>();
    const h = harness({
      api: (req) => {
        const b = bearer(req) ?? '';
        seen.set(b, (seen.get(b) ?? 0) + 1);
        return b === `Bearer ${ACCESS1}` ? json(401, {}) : json(200, { ok: true });
      },
    });
    await h.client.authenticate();
    await Promise.all([h.client.getJson(G_API), h.client.getJson(G_API), h.client.getJson(G_API)]);
    expect(h.tokenCalls).toHaveLength(2);
  });

  describe('quota', () => {
    it('429 + Retry-After en secondes', async () => {
      const h = harness({ api: () => json(429, {}, { 'retry-after': '120' }) });
      const e = await caught(h.client.getJson(G_API));
      expect(e).toBeInstanceOf(ConnectorQuotaError);
      expect((e as ConnectorQuotaError).retryAfterMs).toBe(120_000);
    });

    it('429 + Retry-After en date HTTP', async () => {
      // Horloge du harnais : 2026-11-20T10:00:00Z.
      const h = harness({
        api: () => json(429, {}, { 'retry-after': new Date('2026-11-20T10:00:30Z').toUTCString() }),
      });
      const e = await caught(h.client.getJson(G_API));
      expect((e as ConnectorQuotaError).retryAfterMs).toBe(30_000);
    });

    it.each([503, 504])('%i sans Retry-After → 60 s', async (status) => {
      const h = harness({ api: () => json(status, {}) });
      const e = await caught(h.client.getJson(MS_API.replace('graph.microsoft.com', 'www.googleapis.com')));
      expect(e).toBeInstanceOf(ConnectorQuotaError);
      expect((e as ConnectorQuotaError).retryAfterMs).toBe(60_000);
    });

    it.each(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'])(
      '403 Google %s → quota',
      async (reason) => {
        const h = harness({
          api: () => json(403, { error: { code: 403, errors: [{ reason, domain: 'usageLimits' }] } }),
        });
        const e = await caught(h.client.getJson(G_API));
        expect(e).toBeInstanceOf(ConnectorQuotaError);
        expect((e as ConnectorQuotaError).retryAfterMs).toBe(60_000);
      },
    );

    it('403 Google hors quota → OAuthApiError(403, reason)', async () => {
      const h = harness({
        api: () => json(403, { error: { code: 403, errors: [{ reason: 'insufficientFilePermissions' }] } }),
      });
      const e = await caught(h.client.getJson(G_API));
      expect(e).toBeInstanceOf(OAuthApiError);
      expect((e as OAuthApiError).status).toBe(403);
      expect((e as OAuthApiError).reason).toBe('insufficientFilePermissions');
    });

    it('403 Microsoft avec une raison de quota Google : pas un quota', async () => {
      const h = harness({
        provider: 'microsoft',
        api: () => json(403, { error: { code: 'rateLimitExceeded' } }),
      });
      const e = await caught(h.client.getJson(MS_API));
      expect(e).toBeInstanceOf(OAuthApiError);
    });

    it('bornes de Retry-After', () => {
      const now = new Date('2026-11-20T10:00:00Z');
      expect(parseRetryAfterMs('0', now)).toBe(1_000);
      expect(parseRetryAfterMs('99999999', now)).toBe(6 * 3600_000);
      expect(parseRetryAfterMs(new Date(now.getTime() - 60_000).toUTCString(), now)).toBe(1_000);
      expect(parseRetryAfterMs('n’importe quoi', now)).toBe(60_000);
      expect(parseRetryAfterMs(undefined, now)).toBe(60_000);
      expect(parseRetryAfterMs('-5', now)).toBe(60_000);
    });
  });

  it.each([
    [400, { error: { code: 'invalidRequest', message: `requête ${ACCESS1}` } }, 'invalidRequest'],
    [404, { error: { code: 'itemNotFound', message: 'introuvable' } }, 'itemNotFound'],
    [410, { error: { code: 'resyncRequired' } }, 'resyncRequired'],
    [500, '<html>panne</html>', undefined],
  ])('%i → OAuthApiError(status, reason) au message sûr', async (status, body, reason) => {
    const h = harness({ provider: 'microsoft', api: () => json(status as number, body) });
    const e = await caught(h.client.getJson(MS_API));
    expect(e).toBeInstanceOf(OAuthApiError);
    expect((e as OAuthApiError).status).toBe(status);
    expect((e as OAuthApiError).reason).toBe(reason);
    expect(e.message).not.toContain('introuvable');
    expectNoSecrets(e);
  });

  it('réponse JSON illisible → OAuthApiError', async () => {
    const h = harness({ api: () => ({ status: 200, headers: {}, body: Buffer.from('{pas du json') }) });
    await expect(h.client.getJson(G_API)).rejects.toBeInstanceOf(OAuthApiError);
  });

  describe('validation des URL (nextLink, jeton relu en base)', () => {
    it.each<[OAuthProviderId, string]>([
      ['microsoft', 'https://evil.com/v1.0/me/drive/root/delta?$skiptoken=x'],
      ['microsoft', 'https://graph.microsoft.com.evil.com/v1.0/me'],
      ['microsoft', 'http://graph.microsoft.com/v1.0/me'],
      ['microsoft', 'https://graph.microsoft.com:8443/v1.0/me'],
      ['microsoft', 'https://attacker@graph.microsoft.com/v1.0/me'],
      ['microsoft', 'https://20.190.151.68/v1.0/me'],
      ['microsoft', 'https://www.googleapis.com/drive/v3/files'],
      ['google', 'https://graph.microsoft.com/v1.0/me'],
      ['google', 'https://contoso.sharepoint.com/file'],
    ])('%s : %s refusée, sans même obtenir de jeton', async (provider, url) => {
      const h = harness({ provider });
      const e = await caught(h.client.getJson(url));
      expect(e).toBeInstanceOf(OAuthHostError);
      expect(h.tokenCalls).toHaveLength(0);
      expect(h.apiCalls).toHaveLength(0);
      const e2 = await caught(h.client.getBytes(url, { maxBytes: 10 }));
      expect(e2).toBeInstanceOf(OAuthHostError);
      expect(h.apiCalls).toHaveLength(0);
    });
  });

  it('erreur du client HTTP citant un jeton : masquée (message et pile)', async () => {
    const h = harness({
      api: () => {
        throw new Error(`socket fermé (Authorization: Bearer ${ACCESS1}, refresh ${REFRESH}, ${G_SECRET})`);
      },
    });
    const e = await caught(h.client.getJson(G_API));
    expect(e.message).toContain('***');
    expectNoSecrets(e);
  });

  describe('getBytes', () => {
    it('contenu et type, plafond transmis, pas de redirection par défaut', async () => {
      const h = harness({
        api: () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('%PDF') }),
      });
      const out = await h.client.getBytes('https://www.googleapis.com/drive/v3/files/1?alt=media', {
        maxBytes: 100,
      });
      expect(out.bytes.toString()).toBe('%PDF');
      expect(out.contentType).toBe('application/pdf');
      expect(h.apiCalls[0]?.maxBytes).toBe(100);
      expect(h.apiCalls[0]?.redirects).toBe('none');
    });

    it('followDownloadRedirect → mode download', async () => {
      const h = harness({ provider: 'microsoft', api: () => ({ status: 200, headers: {}, body: Buffer.from('x') }) });
      const out = await h.client.getBytes('https://graph.microsoft.com/v1.0/me/drive/items/1/content', {
        maxBytes: 10,
        followDownloadRedirect: true,
      });
      expect(out.contentType).toBeUndefined();
      expect(h.apiCalls[0]?.redirects).toBe('download');
    });

    it('dépassement signalé par le client (413) → ConnectorItemRejectedError', async () => {
      const h = harness({
        api: () => {
          throw new OAuthApiError('Réponse trop volumineuse', 413, 'response_too_large');
        },
      });
      const e = await caught(h.client.getBytes('https://www.googleapis.com/drive/v3/files/1?alt=media', { maxBytes: 5 }));
      expect(e).toBeInstanceOf(ConnectorItemRejectedError);
      expect(e.message).toMatch(/Fichier trop volumineux/);
    });

    it('client qui n’applique pas la borne : refus, jamais de troncature', async () => {
      const h = harness({ api: () => ({ status: 200, headers: {}, body: Buffer.alloc(11) }) });
      await expect(
        h.client.getBytes('https://www.googleapis.com/drive/v3/files/1?alt=media', { maxBytes: 10 }),
      ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    });

    it('plafond invalide refusé', async () => {
      const h = harness({});
      await expect(
        h.client.getBytes('https://www.googleapis.com/drive/v3/files/1', { maxBytes: 0 }),
      ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    });
  });
});

// ---------------------------------------------------------------------------
// Intégration avec le client gardé réel (transport et DNS simulés)
// ---------------------------------------------------------------------------

describe('session + client gardé', () => {
  const PUBLIC: Record<string, string[]> = {
    'login.microsoftonline.com': ['20.190.151.7'],
    'graph.microsoft.com': ['20.190.151.68'],
    'contoso.sharepoint.com': ['13.107.136.9'],
  };

  it('Graph : jeton, 302 vers SharePoint suivi sans Authorization, contenu borné', async () => {
    const calls: OAuthTransportRequest[] = [];
    const transport: OAuthTransport = async (req) => {
      calls.push(req);
      const reply = (status: number, headers: Record<string, string>, body: string) => ({
        status,
        headers,
        body: (async function* () {
          if (body) yield Buffer.from(body);
        })(),
        abort: () => undefined,
      });
      if (req.url.hostname === 'login.microsoftonline.com') {
        return reply(200, { 'content-type': 'application/json' }, JSON.stringify({ access_token: ACCESS1, expires_in: 3600 }));
      }
      if (req.url.hostname === 'graph.microsoft.com') {
        return reply(302, { location: 'https://contoso.sharepoint.com/_layouts/15/download.aspx?tempauth=t' }, '');
      }
      return reply(200, { 'content-type': 'application/pdf' }, '%PDF-1.7');
    };
    const http = createOfficialHttpClient({
      transport,
      resolve: async (host) => {
        const a = PUBLIC[host];
        if (!a) throw new Error('ENOTFOUND');
        return a;
      },
    });
    const client = createOAuthApiClient({
      provider: 'microsoft',
      credentials: { refreshToken: REFRESH },
      env: ENV,
      scopes: ['Files.Read.All'],
      http,
    });
    const out = await client.getBytes('https://graph.microsoft.com/v1.0/me/drive/items/1/content', {
      maxBytes: 1024,
      followDownloadRedirect: true,
    });
    expect(out.bytes.toString()).toBe('%PDF-1.7');
    expect(calls.map((c) => c.url.hostname)).toEqual([
      'login.microsoftonline.com',
      'graph.microsoft.com',
      'contoso.sharepoint.com',
    ]);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${ACCESS1}`);
    expect(calls[2]?.headers.authorization).toBeUndefined();

    // Contenu trop gros derrière la redirection → élément refusé.
    const big = await caught(
      client.getBytes('https://graph.microsoft.com/v1.0/me/drive/items/1/content', {
        maxBytes: 4,
        followDownloadRedirect: true,
      }),
    );
    expect(big).toBeInstanceOf(ConnectorItemRejectedError);
  });
});
