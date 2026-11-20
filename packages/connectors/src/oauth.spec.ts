import { createHmac, randomBytes } from 'node:crypto';
import {
  OAuthConfigError,
  OAuthFlowError,
  type OAuthHttpClient,
  type OAuthHttpRequest,
  type OAuthHttpResponse,
  type OAuthStatePayload,
} from './oauth-contract';
import {
  assertRedirectUriAllowed,
  buildAuthorizationUrl,
  deriveStateKey,
  exchangeAuthorizationCode,
  generatePkce,
  getProviderConfig,
  newOAuthNonce,
  parseRedirectAllowList,
  pkceS256Challenge,
  signOAuthState,
  verifyOAuthState,
} from './oauth';
import { OAuthNetworkError } from './oauth-http';

// Valeurs FICTIVES, reconnaissables : aucun message d'erreur ne doit jamais les contenir.
const G_ID = 'test-google-client-id.apps.example';
const G_SECRET = 'TEST-google-secret-0000000000';
const MS_ID = '00000000-1111-2222-3333-444444444444';
const MS_SECRET = 'TEST-ms-secret-1111111111111';
const CODE = 'TEST-auth-code-2222222222222';
const VERIFIER = 'TEST-verifier-33333333333333333333333333333333';
const REFRESH = 'TEST-refresh-token-4444444444444';
const ACCESS = 'TEST-access-token-5555555555555';
const SECRETS = [G_SECRET, MS_SECRET, CODE, VERIFIER, REFRESH, ACCESS];

const ENV: NodeJS.ProcessEnv = {
  GED_GOOGLE_CLIENT_ID: G_ID,
  GED_GOOGLE_CLIENT_SECRET: G_SECRET,
  GED_MS_CLIENT_ID: MS_ID,
  GED_MS_CLIENT_SECRET: MS_SECRET,
  GED_MS_TENANT: 'contoso.onmicrosoft.com',
};
const G_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const MS_SCOPES = ['Files.Read.All', 'User.Read'];
const REDIRECT = 'https://docupro.example.com/ged/oauth/callback';
const NOW = new Date('2026-11-20T10:00:00Z');

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

function caughtSync(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('aucune erreur levée');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('getProviderConfig', () => {
  it('Google : points de terminaison officiels', () => {
    const c = getProviderConfig('google', ENV);
    expect(c).toEqual({
      provider: 'google',
      clientId: G_ID,
      clientSecret: G_SECRET,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    });
  });

  it('Microsoft : locataire dans le chemin', () => {
    const c = getProviderConfig('microsoft', ENV);
    expect(c.authorizeUrl).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
    expect(c.tokenUrl).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
    expect(c.tenant).toBe('contoso.onmicrosoft.com');
  });

  it('variables manquantes : NOMS seulement, jamais de valeur', () => {
    const e = caughtSync(() => getProviderConfig('google', { GED_GOOGLE_CLIENT_SECRET: G_SECRET }));
    expect(e).toBeInstanceOf(OAuthConfigError);
    expect(e.message).toContain('GED_GOOGLE_CLIENT_ID');
    expect(e.message).not.toContain('GED_GOOGLE_CLIENT_SECRET');
    expectNoSecrets(e);

    const e2 = caughtSync(() =>
      getProviderConfig('microsoft', { GED_MS_CLIENT_SECRET: MS_SECRET, GED_MS_CLIENT_ID: '  ' }),
    );
    expect(e2).toBeInstanceOf(OAuthConfigError);
    expect(e2.message).toContain('GED_MS_CLIENT_ID');
    expect(e2.message).toContain('GED_MS_TENANT');
    expectNoSecrets(e2);
  });

  it('GED_MS_TENANT obligatoire', () => {
    const e = caughtSync(() =>
      getProviderConfig('microsoft', { GED_MS_CLIENT_ID: MS_ID, GED_MS_CLIENT_SECRET: MS_SECRET }),
    );
    expect(e).toBeInstanceOf(OAuthConfigError);
    expect(e.message).toContain('GED_MS_TENANT');
  });

  it.each([
    ['common', 'common'],
    ['organizations', 'organizations'],
    ['consumers', 'consumers'],
    ['CONTOSO.onmicrosoft.com', 'contoso.onmicrosoft.com'],
    ['72F988BF-86F1-41AF-91AB-2D7CD011DB47', '72f988bf-86f1-41af-91ab-2d7cd011db47'],
    [' fabrikam.com ', 'fabrikam.com'],
  ])('locataire valide %s', (raw, expected) => {
    expect(getProviderConfig('microsoft', { ...ENV, GED_MS_TENANT: raw }).tenant).toBe(expected);
  });

  it.each([
    'evil.com/oauth2',
    '../../evil',
    'common?x=1',
    'common#x',
    'a%2fb.com',
    'contoso.com/../..',
    'user@contoso.com',
    '127.0.0.1',
    'localhost',
    'contoso',
    'contoso..com',
    '-contoso.com',
    'contoso.com.',
    'conto so.com',
    'common/',
  ])('locataire refusé sans écho de la valeur : %s', (raw) => {
    const e = caughtSync(() => getProviderConfig('microsoft', { ...ENV, GED_MS_TENANT: raw }));
    expect(e).toBeInstanceOf(OAuthConfigError);
    expect(e.message).toContain('GED_MS_TENANT invalide');
    expect(e.message).not.toContain(raw.trim());
  });

  it('fournisseur inconnu', () => {
    expect(() => getProviderConfig('github' as never, ENV)).toThrow(OAuthConfigError);
  });
});

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe('PKCE', () => {
  it('vecteur de la RFC 7636, annexe B', () => {
    expect(pkceS256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('couple aléatoire S256 bien formé', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(pkceS256Challenge(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
  });

  it.each(['court', 'a'.repeat(129), 'a'.repeat(42) + ' ', 'é'.repeat(50)])(
    'vérificateur invalide refusé',
    (v) => {
      expect(() => pkceS256Challenge(v)).toThrow(OAuthFlowError);
    },
  );
});

// ---------------------------------------------------------------------------
// URL d'autorisation
// ---------------------------------------------------------------------------

describe('buildAuthorizationUrl', () => {
  const challenge = pkceS256Challenge(VERIFIER);

  it('Google : code + PKCE S256, hors ligne, consentement forcé, sans secret', () => {
    const raw = buildAuthorizationUrl({
      provider: 'google',
      env: ENV,
      scopes: [...G_SCOPES, 'openid'],
      redirectUri: REDIRECT,
      state: 'abc.DEF-123_x',
      codeChallenge: challenge,
    });
    const u = new URL(raw);
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = u.searchParams;
    expect(p.get('client_id')).toBe(G_ID);
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly openid');
    expect(p.get('state')).toBe('abc.DEF-123_x');
    expect(p.get('code_challenge')).toBe(challenge);
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('include_granted_scopes')).toBe('false');
    expect(p.has('client_secret')).toBe(false);
    expect(raw).not.toContain(G_SECRET);
    expect(raw).not.toContain(VERIFIER);
  });

  it('Microsoft : locataire, select_account, offline_access ajouté', () => {
    const raw = buildAuthorizationUrl({
      provider: 'microsoft',
      env: ENV,
      scopes: MS_SCOPES,
      redirectUri: REDIRECT,
      state: 'st',
      codeChallenge: challenge,
    });
    const u = new URL(raw);
    expect(`${u.origin}${u.pathname}`).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
    expect(u.searchParams.get('scope')).toBe('Files.Read.All User.Read offline_access');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.has('access_type')).toBe(false);
    expect(raw).not.toContain(MS_SECRET);
  });

  it('refuse un défi non S256, un state invalide, une URI non https, un tenant invalide', () => {
    const base = {
      provider: 'google' as const,
      env: ENV,
      scopes: G_SCOPES,
      redirectUri: REDIRECT,
      state: 'st',
      codeChallenge: challenge,
    };
    expect(() => buildAuthorizationUrl({ ...base, codeChallenge: 'plain' })).toThrow(OAuthFlowError);
    expect(() => buildAuthorizationUrl({ ...base, state: 'a b' })).toThrow(OAuthFlowError);
    expect(() => buildAuthorizationUrl({ ...base, state: '' })).toThrow(OAuthFlowError);
    expect(() => buildAuthorizationUrl({ ...base, redirectUri: 'http://docupro.example.com/cb' })).toThrow(
      OAuthFlowError,
    );
    expect(() => buildAuthorizationUrl({ ...base, scopes: [] })).toThrow(OAuthFlowError);
    expect(() => buildAuthorizationUrl({ ...base, scopes: ['a b'] })).toThrow(OAuthFlowError);
    expect(() =>
      buildAuthorizationUrl({
        ...base,
        provider: 'microsoft',
        env: { ...ENV, GED_MS_TENANT: 'evil.com/x' },
      }),
    ).toThrow(OAuthConfigError);
  });
});

// ---------------------------------------------------------------------------
// URI de redirection
// ---------------------------------------------------------------------------

describe('liste blanche des URI de redirection', () => {
  const list = parseRedirectAllowList(
    [
      'https://DocuPro.Example.com:443/ged/oauth/callback',
      'http://localhost:3000/cb',
      'http://127.0.0.1:8080/cb',
      'http://docupro.example.com/cb', // http non local : ignoré
      'https://user:pw@docupro.example.com/cb', // identifiant : ignoré
      'https://docupro.example.com/cb#frag', // fragment : ignoré
      'pas une url',
      '',
      'ftp://docupro.example.com/cb',
    ].join(','),
  );

  it('normalise et ignore les entrées invalides', () => {
    expect(list).toEqual([
      'https://docupro.example.com/ged/oauth/callback',
      'http://localhost:3000/cb',
      'http://127.0.0.1:8080/cb',
    ]);
    expect(parseRedirectAllowList(undefined)).toEqual([]);
    expect(parseRedirectAllowList(null)).toEqual([]);
  });

  it.each([
    'https://docupro.example.com/ged/oauth/callback',
    'HTTPS://DOCUPRO.EXAMPLE.COM/ged/oauth/callback',
    'https://docupro.example.com:443/ged/oauth/callback',
    'http://localhost:3000/cb',
    'http://127.0.0.1:8080/cb',
  ])('accepte %s', (uri) => {
    expect(() => assertRedirectUriAllowed(uri, list)).not.toThrow();
  });

  it.each([
    'https://docupro.example.com/ged/oauth/callback/',
    'https://docupro.example.com/ged/oauth/Callback',
    'https://docupro.example.com/ged/oauth/callback?x=1',
    'https://docupro.example.com/ged/oauth/callback#x',
    'https://docupro.example.com.evil.com/ged/oauth/callback',
    'https://evil@docupro.example.com/ged/oauth/callback',
    'http://docupro.example.com/ged/oauth/callback',
    'https://docupro.example.com:8443/ged/oauth/callback',
    'http://localhost:3001/cb',
    'http://localhost.evil.com:3000/cb',
    'https://docupro.example.com/ged/oauth/callback\t',
    'javascript:alert(1)',
    '',
  ])('refuse %s', (uri) => {
    const e = caughtSync(() => assertRedirectUriAllowed(uri, list));
    expect(e).toBeInstanceOf(OAuthFlowError);
    expect((e as OAuthFlowError).code).toBe('redirect_not_allowed');
  });

  it('liste vide : tout est refusé', () => {
    expect(() => assertRedirectUriAllowed(REDIRECT, [])).toThrow(OAuthFlowError);
  });
});

// ---------------------------------------------------------------------------
// state signé
// ---------------------------------------------------------------------------

describe('state signé', () => {
  const rawKey = randomBytes(32);
  const env = { GED_CONNECTOR_KEY: rawKey.toString('base64') };
  const key = deriveStateKey(env);
  const payload: OAuthStatePayload = {
    n: newOAuthNonce(),
    exp: Math.floor(NOW.getTime() / 1000) + 600,
    uid: 7,
    cid: 42,
    provider: 'microsoft',
  };

  /** Signe une charge utile ARBITRAIRE avec la bonne clé (pour tester la validation stricte). */
  function forge(obj: unknown): string {
    const enc = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    return `${enc}.${createHmac('sha256', key).update(enc).digest('base64url')}`;
  }

  function code(fn: () => unknown): string {
    const e = caughtSync(fn);
    expect(e).toBeInstanceOf(OAuthFlowError);
    return (e as OAuthFlowError).code;
  }

  it('dérivation : 32 octets, déterministe, jamais la clé brute', () => {
    expect(key).toHaveLength(32);
    expect(key.equals(rawKey)).toBe(false);
    expect(deriveStateKey(env).equals(key)).toBe(true);
    expect(deriveStateKey({ GED_CONNECTOR_KEY: randomBytes(32).toString('base64') }).equals(key)).toBe(
      false,
    );
  });

  it('dérivation : clé ACTIVE seulement (les anciennes clés ne changent rien)', () => {
    const withPrevious = deriveStateKey({
      ...env,
      GED_CONNECTOR_KEY_PREVIOUS: `old:${randomBytes(32).toString('base64')}`,
    });
    expect(withPrevious.equals(key)).toBe(true);
  });

  it('dérivation : clé absente → erreur claire, sans valeur', () => {
    const e = caughtSync(() => deriveStateKey({}));
    expect(e).toBeInstanceOf(OAuthConfigError);
    expect(e.message).toContain('GED_CONNECTOR_KEY');
    const e2 = caughtSync(() => deriveStateKey({ GED_CONNECTOR_KEY: 'pas-du-base64!' }));
    expect(e2.message).not.toContain('pas-du-base64!');
  });

  it('aller-retour', () => {
    const s = signOAuthState(payload, key);
    expect(s).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyOAuthState(s, key, NOW)).toEqual(payload);
  });

  it('charge utile altérée → state_invalid', () => {
    const s = signOAuthState(payload, key);
    const [enc, sig] = s.split('.') as [string, string];
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, cid: 43 }),
      'utf8',
    ).toString('base64url');
    expect(code(() => verifyOAuthState(`${tampered}.${sig}`, key, NOW))).toBe('state_invalid');
    const flipped = (enc[0] === 'A' ? 'B' : 'A') + enc.slice(1);
    expect(code(() => verifyOAuthState(`${flipped}.${sig}`, key, NOW))).toBe('state_invalid');
  });

  it('signature altérée ou tronquée → state_invalid', () => {
    const s = signOAuthState(payload, key);
    const last = s.slice(-1) === 'A' ? 'B' : 'A';
    expect(code(() => verifyOAuthState(s.slice(0, -1) + last, key, NOW))).toBe('state_invalid');
    expect(code(() => verifyOAuthState(s.slice(0, -2), key, NOW))).toBe('state_invalid');
  });

  it('mauvaise clé → state_invalid', () => {
    const s = signOAuthState(payload, key);
    const other = deriveStateKey({ GED_CONNECTOR_KEY: randomBytes(32).toString('base64') });
    expect(code(() => verifyOAuthState(s, other, NOW))).toBe('state_invalid');
  });

  it('expiré → state_expired (y compris à la seconde exacte)', () => {
    const s = signOAuthState(payload, key);
    expect(code(() => verifyOAuthState(s, key, new Date((payload.exp + 1) * 1000)))).toBe(
      'state_expired',
    );
    expect(code(() => verifyOAuthState(s, key, new Date(payload.exp * 1000)))).toBe('state_expired');
    expect(code(() => verifyOAuthState(s, key, new Date(Number.NaN)))).toBe('state_expired');
  });

  it.each([
    ['champ en trop', { ...payload, admin: true }],
    ['champ manquant', { n: payload.n, exp: payload.exp, uid: 7, cid: 42 }],
    ['uid texte', { ...payload, uid: '7' }],
    ['uid nul', { ...payload, uid: 0 }],
    ['cid décimal', { ...payload, cid: 1.5 }],
    ['exp texte', { ...payload, exp: String(payload.exp) }],
    ['fournisseur inconnu', { ...payload, provider: 'github' }],
    ['nonce trop court', { ...payload, n: 'abc' }],
    ['nonce invalide', { ...payload, n: 'a'.repeat(30) + '/' }],
    ['tableau', [payload]],
    ['null', null],
  ])('charge utile malformée mais signée (%s) → state_invalid', (_label, obj) => {
    expect(code(() => verifyOAuthState(forge(obj), key, NOW))).toBe('state_invalid');
  });

  it('JSON invalide mais signé → state_invalid', () => {
    const enc = Buffer.from('{pas du json', 'utf8').toString('base64url');
    const s = `${enc}.${createHmac('sha256', key).update(enc).digest('base64url')}`;
    expect(code(() => verifyOAuthState(s, key, NOW))).toBe('state_invalid');
  });

  it.each(['', 'abc', 'a.b.c', '.', `${'a'.repeat(3000)}.x`, 'é.é'])(
    'chaîne quelconque → state_invalid (%#)',
    (s) => {
      expect(code(() => verifyOAuthState(s, key, NOW))).toBe('state_invalid');
    },
  );

  it('signature : refuse une charge utile invalide ou une clé trop courte', () => {
    expect(() => signOAuthState({ ...payload, uid: -1 }, key)).toThrow(OAuthFlowError);
    expect(() => signOAuthState(payload, Buffer.alloc(8))).toThrow(OAuthFlowError);
  });

  it('nonce : ≥ 128 bits, base64url, unique', () => {
    const a = newOAuthNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(Buffer.from(a, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(newOAuthNonce()).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Échange du code
// ---------------------------------------------------------------------------

function fakeHttp(handler: (req: OAuthHttpRequest) => OAuthHttpResponse | Promise<OAuthHttpResponse>): {
  calls: OAuthHttpRequest[];
  client: OAuthHttpClient;
} {
  const calls: OAuthHttpRequest[] = [];
  return {
    calls,
    client: {
      request: async (req) => {
        calls.push(req);
        return handler(req);
      },
    },
  };
}
const json = (status: number, body: unknown): OAuthHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

describe('exchangeAuthorizationCode', () => {
  const base = {
    env: ENV,
    redirectUri: REDIRECT,
    code: CODE,
    codeVerifier: VERIFIER,
    now: () => NOW,
  };

  it('Google : succès, formulaire complet, expiration de l’autorisation', async () => {
    const { calls, client } = fakeHttp(() =>
      json(200, {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        token_type: 'Bearer',
        refresh_token_expires_in: 604800,
      }),
    );
    const r = await exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: client });
    expect(r.refreshToken).toBe(REFRESH);
    expect(r.scope).toBe('https://www.googleapis.com/auth/drive.readonly');
    expect(r.refreshTokenExpiresAt?.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(calls).toHaveLength(1);
    const req = calls[0] as OAuthHttpRequest;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://oauth2.googleapis.com/token');
    expect(req.redirects ?? 'none').toBe('none');
    expect(req.maxBytes).toBeGreaterThan(0);
    const form = new URLSearchParams(req.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe(CODE);
    expect(form.get('code_verifier')).toBe(VERIFIER);
    expect(form.get('client_id')).toBe(G_ID);
    expect(form.get('client_secret')).toBe(G_SECRET);
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(form.has('scope')).toBe(false);
  });

  it('Microsoft : périmètres envoyés, comparaison tolérante (casse, préfixe Graph, OpenID)', async () => {
    const { calls, client } = fakeHttp(() =>
      json(200, {
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: 'files.read.all User.Read openid profile',
      }),
    );
    const r = await exchangeAuthorizationCode({
      ...base,
      provider: 'microsoft',
      scopes: ['https://graph.microsoft.com/Files.Read.All', 'User.Read'],
      http: client,
    });
    expect(r.refreshToken).toBe(REFRESH);
    expect(r.refreshTokenExpiresAt).toBeUndefined();
    const req = calls[0] as OAuthHttpRequest;
    expect(req.url).toBe('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token');
    expect(new URLSearchParams(req.body).get('scope')).toBe(
      'https://graph.microsoft.com/Files.Read.All User.Read offline_access',
    );
  });

  it('sans refresh_token → no_refresh_token', async () => {
    const { client } = fakeHttp(() =>
      json(200, { access_token: ACCESS, scope: G_SCOPES[0], expires_in: 3600 }),
    );
    const e = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: client }),
    );
    expect(e).toBeInstanceOf(OAuthFlowError);
    expect((e as OAuthFlowError).code).toBe('no_refresh_token');
    expectNoSecrets(e);
  });

  it('périmètre incomplet (consentement granulaire) → exchange_failed « autorisation incomplète »', async () => {
    const { client } = fakeHttp(() =>
      json(200, {
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: 'https://www.googleapis.com/auth/userinfo.email openid',
      }),
    );
    const e = await caught(
      exchangeAuthorizationCode({
        ...base,
        provider: 'google',
        scopes: [...G_SCOPES, 'email'],
        http: client,
      }),
    );
    expect(e).toBeInstanceOf(OAuthFlowError);
    expect((e as OAuthFlowError).code).toBe('exchange_failed');
    expect(e.message).toMatch(/Autorisation incomplète/);
    expectNoSecrets(e);
  });

  it('erreur du fournisseur : seul le code filtré est repris, aucun secret ni corps', async () => {
    const { client } = fakeHttp(() =>
      json(400, {
        error: 'invalid_grant',
        error_description: `Code ${CODE} invalide pour le secret ${G_SECRET} (verifier ${VERIFIER})`,
      }),
    );
    const e = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: client }),
    );
    expect(e).toBeInstanceOf(OAuthFlowError);
    expect((e as OAuthFlowError).code).toBe('exchange_failed');
    expect(e.message).toContain('invalid_grant');
    expect(e.message).not.toContain('invalide pour le secret');
    expectNoSecrets(e);
  });

  it('code d’erreur hors liste blanche de caractères : non recopié', async () => {
    const { client } = fakeHttp(() => json(401, { error: `<b>${G_SECRET}</b>` }));
    const e = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: client }),
    );
    expect(e.message).toContain('401');
    expect(e.message).not.toContain('<b>');
    expectNoSecrets(e);
  });

  it('réponse non JSON contenant des secrets : rien n’est recopié', async () => {
    const { client } = fakeHttp(() => ({
      status: 500,
      headers: {},
      body: Buffer.from(`<html>${CODE} ${G_SECRET} ${REFRESH}</html>`),
    }));
    const e = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: client }),
    );
    expect((e as OAuthFlowError).code).toBe('exchange_failed');
    expectNoSecrets(e);
  });

  it('200 non JSON → exchange_failed', async () => {
    const { client } = fakeHttp(() => ({ status: 200, headers: {}, body: Buffer.from(REFRESH) }));
    const e = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: client }),
    );
    expect((e as OAuthFlowError).code).toBe('exchange_failed');
    expectNoSecrets(e);
  });

  it('erreur réseau : message d’une erreur inconnue jamais recopié, celui du client gardé masqué', async () => {
    const unknown = fakeHttp(() => {
      throw new Error(`POST code=${CODE}&client_secret=${G_SECRET}`);
    });
    const e1 = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: unknown.client }),
    );
    expect((e1 as OAuthFlowError).code).toBe('exchange_failed');
    expectNoSecrets(e1);

    const guarded = fakeHttp(() => {
      throw new OAuthNetworkError(`Échec vers oauth2.googleapis.com ${G_SECRET}`, 'ECONNRESET');
    });
    const e2 = await caught(
      exchangeAuthorizationCode({ ...base, provider: 'google', scopes: G_SCOPES, http: guarded.client }),
    );
    expect(e2.message).toContain('oauth2.googleapis.com');
    expectNoSecrets(e2);
  });

  it('entrées invalides refusées avant tout appel', async () => {
    const { calls, client } = fakeHttp(() => json(200, {}));
    const bad = [
      { codeVerifier: 'court' },
      { code: '' },
      { code: 'a b' },
      { redirectUri: 'http://evil.example.com/cb' },
    ];
    for (const b of bad) {
      const e = await caught(
        exchangeAuthorizationCode({ ...base, ...b, provider: 'google', scopes: G_SCOPES, http: client }),
      );
      expect(e).toBeInstanceOf(OAuthFlowError);
    }
    expect(calls).toHaveLength(0);
  });

  it('fournisseur non configuré → OAuthConfigError avant tout appel', async () => {
    const { calls, client } = fakeHttp(() => json(200, {}));
    const e = await caught(
      exchangeAuthorizationCode({ ...base, env: {}, provider: 'microsoft', scopes: MS_SCOPES, http: client }),
    );
    expect(e).toBeInstanceOf(OAuthConfigError);
    expect(calls).toHaveLength(0);
  });
});
