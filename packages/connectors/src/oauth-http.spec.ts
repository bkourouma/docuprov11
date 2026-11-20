import { OAuthApiError, OAuthHostError, type OAuthProviderId } from './oauth-contract';
import {
  OAuthNetworkError,
  assertOfficialApiUrl,
  createOfficialHttpClient,
  type OAuthTransport,
  type OAuthTransportRequest,
  type OAuthTransportResponse,
} from './oauth-http';

// Aucun appel réseau réel : DNS et transport simulés dans chaque test.
const TOKEN = 'TEST-bearer-token-9999999999';
const PUBLIC: Record<string, string[]> = {
  'www.googleapis.com': ['142.250.74.110'],
  'oauth2.googleapis.com': ['142.250.74.106'],
  'accounts.google.com': ['142.250.74.109'],
  'graph.microsoft.com': ['20.190.151.68', '2603:1036:3000::1'],
  'login.microsoftonline.com': ['20.190.151.7'],
  'contoso.sharepoint.com': ['13.107.136.9'],
  'contoso-my.sharepoint.com': ['13.107.136.10'],
  'public.am.files.1drv.com': ['13.107.42.12'],
  'onedrive.1drv.com': ['13.107.42.13'],
};

function resolverOf(table: Record<string, string[]>) {
  const calls: string[] = [];
  const resolve = async (host: string): Promise<string[]> => {
    calls.push(host);
    if (!Object.hasOwn(table, host)) throw new Error(`ENOTFOUND ${host}`);
    return table[host] as string[];
  };
  return { calls, resolve };
}

interface FakeResponseSpec {
  status: number;
  headers?: Record<string, string | string[]>;
  chunks?: Array<string | Buffer>;
}

/** Transport simulé : chaque appel consomme la réponse suivante du script. */
function scriptedTransport(script: Array<FakeResponseSpec | ((req: OAuthTransportRequest) => FakeResponseSpec)>) {
  const calls: OAuthTransportRequest[] = [];
  const aborts: number[] = [];
  let yielded = 0;
  const transport: OAuthTransport = async (req) => {
    const index = calls.length;
    calls.push(req);
    const step = script[index];
    if (!step) throw new Error('appel de transport inattendu');
    const spec = typeof step === 'function' ? step(req) : step;
    const res: OAuthTransportResponse = {
      status: spec.status,
      headers: spec.headers ?? {},
      body: (async function* () {
        for (const c of spec.chunks ?? []) {
          yielded++;
          yield typeof c === 'string' ? Buffer.from(c) : c;
        }
      })(),
      abort: () => {
        aborts.push(index);
      },
    };
    return res;
  };
  return {
    calls,
    aborts,
    transport,
    get yielded() {
      return yielded;
    },
  };
}

function client(transport: OAuthTransport, table = PUBLIC, timeoutMs?: number) {
  const dns = resolverOf(table);
  return { dns, http: createOfficialHttpClient({ transport, resolve: dns.resolve, timeoutMs }) };
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('aucune erreur levée');
}

// ---------------------------------------------------------------------------
// assertOfficialApiUrl
// ---------------------------------------------------------------------------

describe('assertOfficialApiUrl', () => {
  it.each<[string, OAuthProviderId]>([
    ['https://www.googleapis.com/drive/v3/changes?pageToken=12', 'google'],
    ['https://oauth2.googleapis.com/token', 'google'],
    ['https://WWW.GoogleApis.com/drive/v3/files', 'google'],
    ['https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc', 'microsoft'],
    ['https://graph.microsoft.com:443/v1.0/me', 'microsoft'],
    ['https://login.microsoftonline.com/common/oauth2/v2.0/token', 'microsoft'],
  ])('accepte %s (%s)', (url, provider) => {
    expect(assertOfficialApiUrl(url, provider)).toBeInstanceOf(URL);
  });

  it.each<[string, OAuthProviderId, string]>([
    ['http://graph.microsoft.com/v1.0/me', 'microsoft', 'http'],
    ['https://graph.microsoft.com:8443/v1.0/me', 'microsoft', 'port'],
    ['https://user:pw@graph.microsoft.com/v1.0/me', 'microsoft', 'userinfo'],
    ['https://@graph.microsoft.com/v1.0/me', 'microsoft', 'userinfo vide'],
    ['https://graph.microsoft.com@evil.com/v1.0/me', 'microsoft', 'userinfo piège'],
    ['https://20.190.151.68/v1.0/me', 'microsoft', 'IPv4 littérale'],
    ['https://[2603:1036:3000::1]/v1.0/me', 'microsoft', 'IPv6 littérale'],
    ['https://0x7f.1/v1.0/me', 'microsoft', 'IPv4 exotique'],
    ['https://graph.microsoft.com.evil.com/v1.0/me', 'microsoft', 'sous-domaine piège'],
    ['https://evilgraph.microsoft.com/v1.0/me', 'microsoft', 'préfixe'],
    ['https://graph.microsoft.com./v1.0/me', 'microsoft', 'point final'],
    ['https://evil.com/?next=https://graph.microsoft.com/', 'microsoft', 'hôte arbitraire'],
    ['https://graph.microsoft.com/v1.0/me', 'google', 'hôte Microsoft pour Google'],
    ['https://www.googleapis.com/drive/v3/files', 'microsoft', 'hôte Google pour Microsoft'],
    ['https://contoso.sharepoint.com/file', 'microsoft', 'hôte de téléchargement en appel direct'],
    ['https://graph.microsoft.com\\@evil.com/', 'microsoft', 'barre oblique inverse'],
    ['https://graph.micro\tsoft.com/v1.0/me', 'microsoft', 'tabulation'],
    ['//graph.microsoft.com/v1.0/me', 'microsoft', 'relative'],
    ['javascript:alert(1)', 'microsoft', 'schéma'],
    ['', 'microsoft', 'vide'],
  ])('refuse %s (%s : %s)', (url, provider) => {
    expect(() => assertOfficialApiUrl(url, provider)).toThrow(OAuthHostError);
  });

  it('fournisseur inconnu', () => {
    expect(() => assertOfficialApiUrl('https://graph.microsoft.com/', 'github' as never)).toThrow(
      OAuthHostError,
    );
  });

  it('message : nom d’hôte seulement, ni chemin ni paramètre', () => {
    try {
      assertOfficialApiUrl(`https://evil.example.com/steal/path?access_token=${TOKEN}`, 'microsoft');
      throw new Error('aucune erreur levée');
    } catch (e) {
      expect(e).toBeInstanceOf(OAuthHostError);
      const msg = (e as Error).message;
      expect(msg).toContain('evil.example.com');
      expect(msg).not.toContain(TOKEN);
      expect(msg).not.toContain('/steal');
    }
  });
});

// ---------------------------------------------------------------------------
// Client gardé
// ---------------------------------------------------------------------------

describe('createOfficialHttpClient', () => {
  it('GET réussi : adresses vérifiées passées au transport, en-têtes de réponse en minuscules', async () => {
    const t = scriptedTransport([
      { status: 200, headers: { 'Content-Type': 'application/json', 'X-Multi': ['a', 'b'] }, chunks: ['{"a":', '1}'] },
    ]);
    const { http, dns } = client(t.transport);
    const res = await http.request({
      method: 'GET',
      url: 'https://graph.microsoft.com/v1.0/me',
      headers: { Authorization: `Bearer ${TOKEN}`, Host: 'evil.com', Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('{"a":1}');
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-multi']).toBe('a, b');
    expect(dns.calls).toEqual(['graph.microsoft.com']);
    const req = t.calls[0] as OAuthTransportRequest;
    expect(req.url.hostname).toBe('graph.microsoft.com');
    expect(req.addresses).toEqual(['20.190.151.68', '2603:1036:3000::1']);
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.host).toBeUndefined();
  });

  it('POST : corps et longueur transmis', async () => {
    const t = scriptedTransport([{ status: 200, chunks: ['{}'] }]);
    const { http } = client(t.transport);
    await http.request({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token',
    });
    const req = t.calls[0] as OAuthTransportRequest;
    expect(req.method).toBe('POST');
    expect(req.body?.toString()).toBe('grant_type=refresh_token');
    expect(req.headers['content-length']).toBe('24');
  });

  it.each([
    'https://evil.com/x',
    'https://graph.microsoft.com.evil.com/x',
    'http://graph.microsoft.com/x',
    'https://graph.microsoft.com:444/x',
    'https://u@graph.microsoft.com/x',
    'https://20.190.151.68/x',
    'https://contoso.sharepoint.com/x',
  ])('refuse %s AVANT toute résolution DNS', async (url) => {
    const t = scriptedTransport([]);
    const { http, dns } = client(t.transport);
    await expect(http.request({ method: 'GET', url })).rejects.toBeInstanceOf(OAuthHostError);
    expect(dns.calls).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ['adresse privée', ['10.0.0.5']],
    ['boucle locale', ['127.0.0.1']],
    ['métadonnées cloud', ['169.254.169.254']],
    ['mélange public + interne', ['20.190.151.68', '192.168.1.10']],
    ['IPv6 locale', ['::1']],
    ['IPv4 mappée', ['::ffff:10.0.0.1']],
  ])('DNS vers une adresse interne (%s) → refus, aucun transport', async (_label, addrs) => {
    const t = scriptedTransport([]);
    const { http } = client(t.transport, { ...PUBLIC, 'graph.microsoft.com': addrs });
    const e = await caught(http.request({ method: 'GET', url: 'https://graph.microsoft.com/v1.0/me' }));
    expect(e).toBeInstanceOf(OAuthHostError);
    expect(e.message).toContain('graph.microsoft.com');
    expect(t.calls).toHaveLength(0);
  });

  it('la liste blanche GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS ne s’applique pas', async () => {
    const before = process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
    process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = '10.0.0.0/8,graph.microsoft.com';
    try {
      const t = scriptedTransport([]);
      const { http } = client(t.transport, { ...PUBLIC, 'graph.microsoft.com': ['10.0.0.5'] });
      await expect(
        http.request({ method: 'GET', url: 'https://graph.microsoft.com/v1.0/me' }),
      ).rejects.toBeInstanceOf(OAuthHostError);
      expect(t.calls).toHaveLength(0);
    } finally {
      if (before === undefined) delete process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
      else process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = before;
    }
  });

  it('hôte introuvable → OAuthHostError', async () => {
    const t = scriptedTransport([]);
    const { http } = client(t.transport, {});
    await expect(
      http.request({ method: 'GET', url: 'https://graph.microsoft.com/v1.0/me' }),
    ).rejects.toBeInstanceOf(OAuthHostError);
  });

  it('en-tête avec retour ligne → refus', async () => {
    const t = scriptedTransport([]);
    const { http } = client(t.transport);
    const e = await caught(
      http.request({
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/me',
        headers: { authorization: `Bearer ${TOKEN}\r\nX-Injected: 1` },
      }),
    );
    expect(e).toBeInstanceOf(OAuthHostError);
    expect(e.message).not.toContain(TOKEN);
    expect(t.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Redirections
  // -------------------------------------------------------------------------

  describe('redirections', () => {
    it.each([301, 302, 303, 307, 308])('refusées par défaut (%i)', async (status) => {
      const t = scriptedTransport([
        { status, headers: { location: 'https://contoso.sharepoint.com/f' } },
      ]);
      const { http } = client(t.transport);
      const e = await caught(
        http.request({ method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/items/1/content' }),
      );
      expect(e).toBeInstanceOf(OAuthHostError);
      expect(t.calls).toHaveLength(1);
      expect(t.aborts).toEqual([0]);
    });

    it.each([
      'https://contoso.sharepoint.com/_layouts/15/download.aspx?UniqueId=1&tempauth=x',
      'https://contoso-my.sharepoint.com/personal/x/file',
      'https://public.am.files.1drv.com/y4m/file',
      'https://onedrive.1drv.com/download?cid=1',
    ])('mode download : suivie vers %s, sans Authorization ni Cookie', async (target) => {
      const t = scriptedTransport([
        { status: 302, headers: { Location: target } },
        { status: 200, headers: { 'content-type': 'application/pdf' }, chunks: ['%PDF-1.7'] },
      ]);
      const { http, dns } = client(t.transport);
      const res = await http.request({
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/me/drive/items/1/content',
        headers: { Authorization: `Bearer ${TOKEN}`, Cookie: 'sid=1', 'X-Keep': 'oui' },
        redirects: 'download',
      });
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('%PDF-1.7');
      expect(t.calls).toHaveLength(2);
      const first = t.calls[0] as OAuthTransportRequest;
      const second = t.calls[1] as OAuthTransportRequest;
      expect(first.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(second.url.href).toBe(new URL(target).href);
      expect(second.method).toBe('GET');
      expect(Object.keys(second.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
      expect(Object.keys(second.headers).map((h) => h.toLowerCase())).not.toContain('cookie');
      expect(JSON.stringify(second.headers)).not.toContain(TOKEN);
      expect(second.headers['x-keep']).toBe('oui');
      // L'hôte de téléchargement est lui aussi résolu et vérifié.
      expect(dns.calls).toEqual(['graph.microsoft.com', new URL(target).hostname]);
    });

    it('trois sauts admis, le quatrième refusé', async () => {
      const hop = (n: number): FakeResponseSpec => ({
        status: 302,
        headers: { location: `https://contoso.sharepoint.com/hop${n}` },
      });
      const ok = scriptedTransport([hop(1), hop(2), hop(3), { status: 200, chunks: ['ok'] }]);
      const res = await client(ok.transport).http.request({
        method: 'GET',
        url: 'https://graph.microsoft.com/v1.0/x',
        redirects: 'download',
      });
      expect(res.body.toString()).toBe('ok');

      const tooMany = scriptedTransport([hop(1), hop(2), hop(3), hop(4), { status: 200 }]);
      const e = await caught(
        client(tooMany.transport).http.request({
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/x',
          redirects: 'download',
        }),
      );
      expect(e).toBeInstanceOf(OAuthHostError);
      expect(e.message).toMatch(/Trop de redirections/);
      expect(tooMany.calls).toHaveLength(4);
    });

    it.each([
      ['hôte arbitraire', 'https://evil.com/f'],
      ['http', 'http://contoso.sharepoint.com/f'],
      ['port', 'https://contoso.sharepoint.com:8443/f'],
      ['userinfo', 'https://u:p@contoso.sharepoint.com/f'],
      ['suffixe sans label', 'https://sharepoint.com/f'],
      ['suffixe collé', 'https://evilsharepoint.com/f'],
      ['sous-domaine piège', 'https://contoso.sharepoint.com.evil.com/f'],
      ['IP littérale', 'https://13.107.136.9/f'],
      ['hôte d’API (pas de téléchargement)', 'https://graph.microsoft.com/v1.0/other'],
      ['relative (reste sur graph)', '/v1.0/other'],
      ['schéma', 'javascript:alert(1)'],
    ])('mode download : refusée vers %s', async (_label, location) => {
      const t = scriptedTransport([{ status: 302, headers: { location } }, { status: 200 }]);
      const e = await caught(
        client(t.transport).http.request({
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/x',
          headers: { authorization: `Bearer ${TOKEN}` },
          redirects: 'download',
        }),
      );
      expect(e).toBeInstanceOf(OAuthHostError);
      expect(e.message).not.toContain(TOKEN);
      expect(t.calls).toHaveLength(1);
    });

    it('mode download : redirection sans Location refusée', async () => {
      const t = scriptedTransport([{ status: 302 }]);
      await expect(
        client(t.transport).http.request({
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/x',
          redirects: 'download',
        }),
      ).rejects.toBeInstanceOf(OAuthHostError);
    });

    it('mode download : cible résolue vers une adresse interne refusée', async () => {
      const t = scriptedTransport([
        { status: 302, headers: { location: 'https://contoso.sharepoint.com/f' } },
        { status: 200 },
      ]);
      const e = await caught(
        client(t.transport, { ...PUBLIC, 'contoso.sharepoint.com': ['172.16.0.2'] }).http.request({
          method: 'GET',
          url: 'https://graph.microsoft.com/v1.0/x',
          redirects: 'download',
        }),
      );
      expect(e).toBeInstanceOf(OAuthHostError);
      expect(t.calls).toHaveLength(1);
    });

    it('mode download réservé à GET', async () => {
      const t = scriptedTransport([]);
      await expect(
        client(t.transport).http.request({
          method: 'POST',
          url: 'https://graph.microsoft.com/v1.0/x',
          redirects: 'download',
        }),
      ).rejects.toBeInstanceOf(OAuthHostError);
    });
  });

  // -------------------------------------------------------------------------
  // Lecture bornée, délai, annulation, erreurs réseau
  // -------------------------------------------------------------------------

  describe('lecture bornée', () => {
    it('dépassement en flux → 413, abandon, aucune lecture supplémentaire', async () => {
      const t = scriptedTransport([
        { status: 200, chunks: ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'] },
      ]);
      const e = await caught(
        client(t.transport).http.request({
          method: 'GET',
          url: 'https://www.googleapis.com/drive/v3/files/1?alt=media',
          maxBytes: 10,
        }),
      );
      expect(e).toBeInstanceOf(OAuthApiError);
      expect((e as OAuthApiError).status).toBe(413);
      expect(t.aborts).toEqual([0]);
      expect(t.yielded).toBe(3);
    });

    it('taille annoncée supérieure au plafond → 413 sans lire', async () => {
      const t = scriptedTransport([
        { status: 200, headers: { 'content-length': '11' }, chunks: ['x'] },
      ]);
      const e = await caught(
        client(t.transport).http.request({ method: 'GET', url: 'https://www.googleapis.com/x', maxBytes: 10 }),
      );
      expect((e as OAuthApiError).status).toBe(413);
      expect(t.yielded).toBe(0);
    });

    it('exactement le plafond : accepté, rien de tronqué', async () => {
      const t = scriptedTransport([{ status: 200, chunks: ['12345', '67890'] }]);
      const res = await client(t.transport).http.request({
        method: 'GET',
        url: 'https://www.googleapis.com/x',
        maxBytes: 10,
      });
      expect(res.body.toString()).toBe('1234567890');
    });

    it('plafond par défaut : 25 Mio', async () => {
      const t = scriptedTransport([
        { status: 200, headers: { 'content-length': String(25 * 1024 * 1024 + 1) } },
      ]);
      const e = await caught(client(t.transport).http.request({ method: 'GET', url: 'https://www.googleapis.com/x' }));
      expect((e as OAuthApiError).status).toBe(413);
    });

    it('plafond invalide refusé', async () => {
      const t = scriptedTransport([]);
      await expect(
        client(t.transport).http.request({ method: 'GET', url: 'https://www.googleapis.com/x', maxBytes: -1 }),
      ).rejects.toBeInstanceOf(OAuthHostError);
    });
  });

  it('délai global dépassé → OAuthNetworkError ETIMEDOUT (nom d’hôte seulement)', async () => {
    const transport: OAuthTransport = (req) =>
      new Promise((_, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error(`aborted ${req.url.href}`)));
      });
    const { http } = client(transport, PUBLIC, 30);
    const e = await caught(
      http.request({ method: 'GET', url: `https://graph.microsoft.com/v1.0/x?token=${TOKEN}` }),
    );
    expect(e).toBeInstanceOf(OAuthNetworkError);
    expect((e as OAuthNetworkError).code).toBe('ETIMEDOUT');
    expect(e.message).toContain('graph.microsoft.com');
    expect(e.message).not.toContain(TOKEN);
  });

  it('délai dépassé pendant la lecture d’un flux qui ignore le signal', async () => {
    let aborted = false;
    const transport: OAuthTransport = async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from('a');
        await new Promise(() => undefined); // ne rend jamais la main
      })(),
      abort: () => {
        aborted = true;
      },
    });
    const e = await caught(client(transport, PUBLIC, 30).http.request({ method: 'GET', url: 'https://www.googleapis.com/x' }));
    expect(e).toBeInstanceOf(OAuthNetworkError);
    expect(aborted).toBe(true);
  });

  it('AbortSignal de l’appelant → AbortError', async () => {
    const transport: OAuthTransport = (req) =>
      new Promise((_, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const ctrl = new AbortController();
    const p = client(transport).http.request({
      method: 'GET',
      url: 'https://graph.microsoft.com/v1.0/x',
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 5);
    const e = await caught(p);
    expect(e.name).toBe('AbortError');

    const pre = new AbortController();
    pre.abort();
    const t = scriptedTransport([]);
    const e2 = await caught(
      client(t.transport).http.request({ method: 'GET', url: 'https://graph.microsoft.com/v1.0/x', signal: pre.signal }),
    );
    expect(e2.name).toBe('AbortError');
    expect(t.calls).toHaveLength(0);
  });

  it('erreur de transport : code système seulement, jamais le message natif', async () => {
    const transport: OAuthTransport = async () => {
      throw Object.assign(new Error(`connect ECONNRESET https://graph.microsoft.com/x?t=${TOKEN}`), {
        code: 'ECONNRESET',
      });
    };
    const e = await caught(client(transport).http.request({ method: 'GET', url: 'https://graph.microsoft.com/x' }));
    expect(e).toBeInstanceOf(OAuthNetworkError);
    expect((e as OAuthNetworkError).code).toBe('ECONNRESET');
    expect(e.message).toContain('graph.microsoft.com');
    expect(e.message).not.toContain(TOKEN);
  });
});
