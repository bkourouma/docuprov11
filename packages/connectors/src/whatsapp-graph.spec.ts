import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import type { PeerCertificate } from 'node:tls';
import { ConnectorAuthError, ConnectorItemRejectedError, ConnectorQuotaError } from './types';
import {
  WhatsappBodyTooLargeError,
  WhatsappGraphClient,
  createDefaultWhatsappHttp,
  type WhatsappHttp,
  type WhatsappHttpRequest,
  type WhatsappHttpResponse,
} from './whatsapp-graph';

// Aucun accès réseau réel : transport simulé (client) ou `https.request` simulé (transport).

const TOKEN = 'EAAGtestTOKEN0123456789abcdefSECRET';
const PHONE_ID = '109876543210';
const PHONE = '33612345678';
const SIGNED_URL =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987654321&ext=1732000000&hash=ATsignedHASHvalue42';
const PDF = Buffer.from('%PDF-1.7\nbonjour\n', 'latin1');

type Handler = (req: WhatsappHttpRequest) => WhatsappHttpResponse | Promise<WhatsappHttpResponse>;

function fakeHttp(...handlers: Handler[]): WhatsappHttp & { calls: WhatsappHttpRequest[] } {
  const calls: WhatsappHttpRequest[] = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      const h = handlers[calls.length - 1];
      if (!h) throw new Error(`requête inattendue n° ${calls.length}`);
      return h(req);
    },
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): WhatsappHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(body)),
});
const raw = (status: number, body: Buffer, headers: Record<string, string> = {}): WhatsappHttpResponse => ({
  status,
  headers,
  body,
});
const redirect = (location: string, status = 302): Handler => () => raw(status, Buffer.alloc(0), { location });
/** Réponse d'erreur Graph qui recopie volontairement des secrets : ils ne doivent jamais ressortir. */
const graphError = (status: number, code?: number, headers: Record<string, string> = {}): Handler => () =>
  json(
    status,
    {
      error: {
        message: `Invalid token ${TOKEN} for ${SIGNED_URL} to ${PHONE}`,
        type: 'OAuthException',
        ...(code !== undefined ? { code } : {}),
        fbtrace_id: 'Axyz',
      },
    },
    headers,
  );

function client(http: WhatsappHttp, extra: Partial<ConstructorParameters<typeof WhatsappGraphClient>[0]> = {}) {
  return new WhatsappGraphClient({
    http,
    accessToken: TOKEN,
    phoneNumberId: PHONE_ID,
    maxMediaBytes: 1024,
    now: () => new Date(Date.UTC(2026, 10, 20, 12, 0, 0)),
    ...extra,
  });
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    assertNoSecret((e as Error).message);
    return e as Error;
  }
  throw new Error('aucune erreur levée');
}

function assertNoSecret(text: string): void {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('SECRET');
  expect(text).not.toContain(SIGNED_URL);
  expect(text).not.toContain('ATsignedHASHvalue42');
  expect(text).not.toContain('lookaside.fbsbx.com/whatsapp_business');
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain('Invalid token');
}

const mediaInfo = { url: SIGNED_URL, mimeType: 'application/pdf' };

describe('WhatsappGraphClient — construction', () => {
  const http = fakeHttp();
  it.each(['v21', '21.0', 'v100.0', 'v21.0.1', 'v21.0/../x', ' v21.0'])('refuse la version %p', (apiVersion) => {
    expect(() => client(http, { apiVersion })).toThrow(/Version/);
  });
  it.each(['', 'abc', '12/34', '1'.repeat(31)])('refuse le Phone Number ID %p', (phoneNumberId) => {
    expect(() => client(http, { phoneNumberId })).toThrow(/numéro/);
  });
  it('refuse un jeton vide ou avec retour à la ligne, sans le recopier', () => {
    expect(() => client(http, { accessToken: '' })).toThrow(ConnectorAuthError);
    try {
      client(http, { accessToken: `${TOKEN}\r\nX-Injected: 1` });
      throw new Error('aucune erreur');
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorAuthError);
      assertNoSecret((e as Error).message);
    }
  });
  it('accepte une version explicite', async () => {
    const h = fakeHttp(() => json(200, { id: PHONE_ID }));
    await client(h, { apiVersion: 'v19.0' }).probe();
    expect(h.calls[0]?.url).toBe(`https://graph.facebook.com/v19.0/${PHONE_ID}?fields=id`);
  });
});

describe('WhatsappGraphClient.probe', () => {
  it('interroge le numéro avec le jeton en en-tête, jamais dans l’URL', async () => {
    const h = fakeHttp(() => json(200, { id: PHONE_ID }));
    await client(h).probe();
    const call = h.calls[0] as WhatsappHttpRequest;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`https://graph.facebook.com/v21.0/${PHONE_ID}?fields=id`);
    expect(call.url).not.toContain(TOKEN);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.maxBytes).toBeLessThanOrEqual(64 * 1024);
    expect(call.timeoutMs).toBeGreaterThan(0);
  });
  it('refuse un identifiant différent', async () => {
    const e = await caught(client(fakeHttp(() => json(200, { id: '1' }))).probe());
    expect(e).toBeInstanceOf(ConnectorAuthError);
  });
  it('401 → ConnectorAuthError non expirée', async () => {
    const e = await caught(client(fakeHttp(graphError(401))).probe());
    expect(e).toBeInstanceOf(ConnectorAuthError);
    expect((e as ConnectorAuthError).expired).toBe(false);
  });
  it('code 190 → ConnectorAuthError expirée', async () => {
    const e = await caught(client(fakeHttp(graphError(400, 190))).probe());
    expect(e).toBeInstanceOf(ConnectorAuthError);
    expect((e as ConnectorAuthError).expired).toBe(true);
  });
  it('404 → ConnectorAuthError (numéro inconnu pour ce jeton)', async () => {
    expect(await caught(client(fakeHttp(graphError(404))).probe())).toBeInstanceOf(ConnectorAuthError);
  });
  it('réponse non JSON → erreur générique', async () => {
    const e = await caught(client(fakeHttp(() => raw(200, Buffer.from(`<html>${TOKEN}</html>`)))).probe());
    expect(e.constructor).toBe(Error);
  });
  it('redirection de l’API Graph → erreur (non suivie)', async () => {
    const h = fakeHttp(redirect('https://graph.facebook.com/x'));
    const e = await caught(client(h).probe());
    expect(e.constructor).toBe(Error);
    expect(h.calls).toHaveLength(1);
  });
});

describe('WhatsappGraphClient.getMediaInfo', () => {
  it('demande le média pour CE numéro et renvoie une URL validée', async () => {
    const h = fakeHttp(() =>
      json(200, { url: SIGNED_URL, mime_type: 'Application/PDF', sha256: 'ab'.repeat(32), file_size: 512, id: '987654321' }),
    );
    const info = await client(h).getMediaInfo('987654321');
    expect(h.calls[0]?.url).toBe(`https://graph.facebook.com/v21.0/987654321?phone_number_id=${PHONE_ID}`);
    expect(h.calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(info).toEqual({ url: SIGNED_URL, mimeType: 'application/pdf', sha256: 'ab'.repeat(32), fileSize: 512 });
  });
  it('accepte file_size en chaîne', async () => {
    const info = await client(fakeHttp(() => json(200, { url: SIGNED_URL, mime_type: 'image/jpeg', file_size: '100' }))).getMediaInfo(
      '1',
    );
    expect(info.fileSize).toBe(100);
  });
  it.each(['', 'abc', '../1', '1/2', '1'.repeat(31), '12 ', '١٢'])('refuse l’identifiant %p sans appel réseau', async (id) => {
    const h = fakeHttp();
    expect(await caught(client(h).getMediaInfo(id))).toBeInstanceOf(ConnectorItemRejectedError);
    expect(h.calls).toHaveLength(0);
  });
  it.each([
    'https://evil.example.com/x?token=1',
    'http://lookaside.fbsbx.com/x',
    'https://lookaside.fbsbx.com.evil.com/x',
    'https://169.254.169.254/latest',
    'https://lookaside.fbsbx.com:8443/x',
  ])('refuse une URL renvoyée non officielle (%s)', async (url) => {
    const e = await caught(client(fakeHttp(() => json(200, { url, mime_type: 'application/pdf' }))).getMediaInfo('1'));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).not.toContain(url);
    expect(e.message).not.toContain('evil');
  });
  it('refuse une taille annoncée trop grande, sans télécharger', async () => {
    const h = fakeHttp(() => json(200, { url: SIGNED_URL, mime_type: 'application/pdf', file_size: 1025 }));
    const e = await caught(client(h).getMediaInfo('1'));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).toMatch(/volumineux/);
    expect(h.calls).toHaveLength(1);
  });
  it('404 → Média introuvable ou expiré', async () => {
    const e = await caught(client(fakeHttp(graphError(404))).getMediaInfo('1'));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).toBe('Média introuvable ou expiré');
  });
  it('code 100 (objet inexistant) → Média introuvable ou expiré', async () => {
    expect((await caught(client(fakeHttp(graphError(400, 100))).getMediaInfo('1'))).message).toBe('Média introuvable ou expiré');
  });
  it('identifiant renvoyé différent → erreur', async () => {
    await caught(client(fakeHttp(() => json(200, { url: SIGNED_URL, mime_type: 'application/pdf', id: '2' }))).getMediaInfo('1'));
  });
  it('réponse JSON invalide (zod) → erreur générique', async () => {
    const e = await caught(client(fakeHttp(() => json(200, { url: 42, mime_type: null }))).getMediaInfo('1'));
    expect(e.constructor).toBe(Error);
  });
  it('réponse JSON trop volumineuse → erreur générique', async () => {
    const http: WhatsappHttp = {
      async request() {
        throw new WhatsappBodyTooLargeError();
      },
    };
    const e = await caught(client(http).getMediaInfo('1'));
    expect(e.constructor).toBe(Error);
    expect(e.message).toMatch(/trop volumineuse/);
  });
});

describe('WhatsappGraphClient.downloadMedia', () => {
  it('télécharge l’URL avec le jeton, bornée à la taille maximale', async () => {
    const h = fakeHttp(() => raw(200, PDF, { 'content-length': String(PDF.length) }));
    expect(await client(h).downloadMedia(mediaInfo)).toEqual(PDF);
    const call = h.calls[0] as WhatsappHttpRequest;
    expect(call.url).toBe(SIGNED_URL);
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.maxBytes).toBe(1024);
  });

  it('suit une redirection vers un hôte officiel (CDN) sans le jeton', async () => {
    const next = 'https://scontent.xx.fbcdn.net/v/t61/media.pdf?oh=1';
    const h = fakeHttp(redirect(next, 301), () => raw(200, PDF));
    expect(await client(h).downloadMedia(mediaInfo)).toEqual(PDF);
    expect(h.calls.map((c) => c.url)).toEqual([SIGNED_URL, next]);
    // Hôte officiel hors liste d'envoi du jeton : suivi, mais SANS Authorization.
    expect(h.calls[1]?.headers.Authorization).toBeUndefined();
  });

  it.each(['https://scontent.xx.fbcdn.net/a', 'https://mmg.whatsapp.net/b'])(
    'redirection vers %s : suivie sans jeton',
    async (next) => {
      const h = fakeHttp(redirect(next, 302), () => raw(200, PDF));
      expect(await client(h).downloadMedia(mediaInfo)).toEqual(PDF);
      expect(h.calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(h.calls[1]?.url).toBe(next);
      expect(Object.keys(h.calls[1]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
    },
  );

  it('redirection vers lookaside.fbsbx.com : jeton conservé', async () => {
    const h = fakeHttp(redirect('https://lookaside.fbsbx.com/y?z=1', 302), () => raw(200, PDF));
    await client(h).downloadMedia(mediaInfo);
    expect(h.calls[1]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('jeton rétabli si la chaîne revient sur graph/lookaside après un CDN', async () => {
    const h = fakeHttp(
      redirect('https://a.fbcdn.net/1', 302),
      redirect('https://lookaside.fbsbx.com/2', 302),
      () => raw(200, PDF),
    );
    await client(h).downloadMedia(mediaInfo);
    expect(h.calls[1]?.headers.Authorization).toBeUndefined();
    expect(h.calls[2]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('résout une redirection relative sur le même hôte', async () => {
    const h = fakeHttp(redirect('/autre?x=1', 307), () => raw(200, PDF));
    await client(h).downloadMedia(mediaInfo);
    expect(h.calls[1]?.url).toBe('https://lookaside.fbsbx.com/autre?x=1');
  });

  it('suit deux redirections au plus', async () => {
    const h = fakeHttp(
      redirect('https://a.fbcdn.net/1', 302),
      redirect('https://b.fbcdn.net/2', 308),
      () => raw(200, PDF),
    );
    expect(await client(h).downloadMedia(mediaInfo)).toEqual(PDF);
    expect(h.calls).toHaveLength(3);
  });

  it('refuse une troisième redirection', async () => {
    const h = fakeHttp(
      redirect('https://a.fbcdn.net/1'),
      redirect('https://b.fbcdn.net/2'),
      redirect('https://c.fbcdn.net/3'),
    );
    const e = await caught(client(h).downloadMedia(mediaInfo));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).toMatch(/^Redirection refusée/);
    expect(h.calls).toHaveLength(3);
  });

  it.each([
    'https://evil.example.com/steal',
    'http://lookaside.fbsbx.com/x',
    'https://fbcdn.net.evil.com/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'ftp://lookaside.fbsbx.com/x',
    'javascript:alert(1)',
    '//evil.example.com/x',
    '',
  ])('refuse une redirection vers %p sans y envoyer le jeton', async (location) => {
    const h = fakeHttp(redirect(location));
    const e = await caught(client(h).downloadMedia(mediaInfo));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).toMatch(/^Redirection refusée/);
    if (location) expect(e.message).not.toContain(location);
    expect(h.calls).toHaveLength(1);
    expect(h.calls.slice(1)).toEqual([]); // le jeton n'est jamais envoyé à la destination refusée
  });

  it('refuse une URL de départ non officielle sans appel réseau', async () => {
    const h = fakeHttp();
    const e = await caught(client(h).downloadMedia({ url: 'https://evil.example.com/x', mimeType: 'application/pdf' }));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(h.calls).toHaveLength(0);
  });

  it('refuse une taille annoncée trop grande sans télécharger', async () => {
    const h = fakeHttp();
    await caught(client(h).downloadMedia({ ...mediaInfo, fileSize: 2048 }));
    expect(h.calls).toHaveLength(0);
  });

  it('refuse un Content-Length supérieur au maximum', async () => {
    const e = await caught(client(fakeHttp(() => raw(200, PDF, { 'content-length': '999999' }))).downloadMedia(mediaInfo));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('refuse un corps supérieur au maximum (transport non conforme)', async () => {
    const e = await caught(client(fakeHttp(() => raw(200, Buffer.alloc(2048)))).downloadMedia(mediaInfo));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('flux interrompu par le transport → média refusé', async () => {
    const http: WhatsappHttp = {
      async request() {
        throw new WhatsappBodyTooLargeError();
      },
    };
    const e = await caught(client(http).downloadMedia(mediaInfo));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).toMatch(/trop volumineux/);
  });

  it.each([
    ['401', graphError(401), ConnectorAuthError],
    ['403', graphError(403), ConnectorAuthError],
    ['190', graphError(400, 190), ConnectorAuthError],
    ['429', graphError(429), ConnectorQuotaError],
    ['130429', graphError(400, 130429), ConnectorQuotaError],
    ['80007', graphError(400, 80007), ConnectorQuotaError],
    ['404', graphError(404), ConnectorItemRejectedError],
    ['410', graphError(410), ConnectorItemRejectedError],
  ])('statut/code %s → erreur typée', async (_l, handler, cls) => {
    expect(await caught(client(fakeHttp(handler)).downloadMedia(mediaInfo))).toBeInstanceOf(cls);
  });

  it.each([500, 502, 503])('%i → Error générique (réessai)', async (status) => {
    const e = await caught(client(fakeHttp(graphError(status))).downloadMedia(mediaInfo));
    expect(e.constructor).toBe(Error);
    expect(e.message).toContain(String(status));
  });

  it('erreur réseau du transport : message d’origine jamais recopié', async () => {
    const http: WhatsappHttp = {
      async request(req) {
        throw new Error(`ECONNRESET ${req.url} Authorization: ${req.headers.Authorization}`);
      },
    };
    const e = await caught(client(http).downloadMedia(mediaInfo));
    expect(e.constructor).toBe(Error);
  });

  it('erreur typée du transport recopiant l’URL : masquée', async () => {
    const http: WhatsappHttp = {
      async request(req) {
        throw new ConnectorItemRejectedError(`refus de ${req.url} (${TOKEN})`);
      },
    };
    const e = await caught(client(http).downloadMedia(mediaInfo));
    expect(e).toBeInstanceOf(ConnectorItemRejectedError);
    expect(e.message).toContain('***');
  });
});

describe('WhatsappGraphClient — quotas', () => {
  it('Retry-After en secondes', async () => {
    const e = await caught(client(fakeHttp(graphError(429, undefined, { 'retry-after': '30' }))).probe());
    expect(e).toBeInstanceOf(ConnectorQuotaError);
    expect((e as ConnectorQuotaError).retryAfterMs).toBe(30_000);
  });
  it('Retry-After en date HTTP (relative à now())', async () => {
    const e = await caught(
      client(fakeHttp(graphError(429, undefined, { 'retry-after': 'Fri, 20 Nov 2026 12:02:00 GMT' }))).probe(),
    );
    expect((e as ConnectorQuotaError).retryAfterMs).toBe(120_000);
  });
  it('sans Retry-After → retryAfterMs indéfini', async () => {
    const e = await caught(client(fakeHttp(graphError(400, 4))).probe());
    expect(e).toBeInstanceOf(ConnectorQuotaError);
    expect((e as ConnectorQuotaError).retryAfterMs).toBeUndefined();
  });
  it.each([4, 17, 32, 613, 80007, 130429])('code %i → quota', async (code) => {
    expect(await caught(client(fakeHttp(graphError(400, code))).sendText(PHONE, 'x'))).toBeInstanceOf(ConnectorQuotaError);
  });
});

describe('WhatsappGraphClient.sendText', () => {
  it('envoie exactement le corps attendu', async () => {
    const h = fakeHttp(() => json(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.ABC' }] }));
    const out = await client(h).sendText('+33 6 12 34 56 78', 'Document reçu. Référence : WA-1. Merci.');
    expect(out).toEqual({ messageId: 'wamid.ABC' });
    const call = h.calls[0] as WhatsappHttpRequest;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBe(
      JSON.stringify({
        messaging_product: 'whatsapp',
        to: PHONE,
        type: 'text',
        text: { body: 'Document reçu. Référence : WA-1. Merci.', preview_url: false },
      }),
    );
  });
  it('réponse sans identifiant → objet vide', async () => {
    expect(await client(fakeHttp(() => json(200, {}))).sendText(PHONE, 'x')).toEqual({});
  });
  it.each(['', '0612345678', '+0', 'abc', '123', `${PHONE}${PHONE}`])('refuse le numéro %p sans le recopier', async (to) => {
    const h = fakeHttp();
    const e = await caught(client(h).sendText(to, 'x'));
    if (to.length >= 4) expect(e.message).not.toContain(to);
    expect(h.calls).toHaveLength(0);
  });
  it('borne le corps à 1000 caractères', async () => {
    const h = fakeHttp(() => json(200, {}));
    await client(h).sendText(PHONE, 'a'.repeat(1000));
    await caught(client(h).sendText(PHONE, 'a'.repeat(1001)));
    await caught(client(h).sendText(PHONE, '   '));
    expect(h.calls).toHaveLength(1);
  });
  it('erreur d’envoi : ni numéro, ni jeton, ni corps brut dans le message', async () => {
    const e = await caught(client(fakeHttp(graphError(400, 131047))).sendText(PHONE, 'x'));
    expect(e.constructor).toBe(Error);
    expect(e.message).toContain('131047');
  });
});

describe('WhatsappGraphClient — aucun secret journalisé', () => {
  it('n’écrit rien sur la console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      await caught(client(fakeHttp(graphError(401))).downloadMedia(mediaInfo));
      await caught(client(fakeHttp(graphError(500))).sendText(PHONE, 'x'));
      await caught(client(fakeHttp(redirect('https://evil.example.com'))).downloadMedia(mediaInfo));
      for (const spy of spies) {
        for (const args of spy.mock.calls) assertNoSecret(JSON.stringify(args));
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------------------
// Transport par défaut — sans socket : `https.request` simulé.
// ---------------------------------------------------------------------------

class FakeRequest extends EventEmitter {
  destroyed = false;
  body: string | undefined;
  constructor(private readonly onEnd: (r: FakeRequest) => void) {
    super();
  }
  end(body?: string): this {
    this.body = body;
    setImmediate(() => this.onEnd(this));
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

type FakeResponse = Readable & { statusCode: number; headers: Record<string, string> };
function fakeResponse(status: number, headers: Record<string, string>, read?: (r: Readable) => void): FakeResponse {
  const r = new Readable({ read() { read?.(this); } });
  return Object.assign(r, { statusCode: status, headers });
}

function fakeRequestFn(script: (opts: RequestOptions, req: FakeRequest) => void) {
  const calls: RequestOptions[] = [];
  const reqs: FakeRequest[] = [];
  const fn = (opts: RequestOptions): ClientRequest => {
    calls.push(opts);
    const r = new FakeRequest((req) => script(opts, req));
    reqs.push(r);
    return r as unknown as ClientRequest;
  };
  return { fn, calls, reqs };
}

const resolverOf = (addrs: string[]) => jest.fn(async () => addrs);
const baseReq = (over: Partial<WhatsappHttpRequest> = {}): WhatsappHttpRequest => ({
  method: 'GET',
  url: SIGNED_URL,
  headers: { Authorization: `Bearer ${TOKEN}` },
  timeoutMs: 5000,
  maxBytes: 1024,
  ...over,
});
const certFor = (name: string) =>
  ({ subject: { CN: name }, subjectaltname: `DNS:${name}` }) as unknown as PeerCertificate;

describe('createDefaultWhatsappHttp', () => {
  it.each([
    ['127.0.0.1'],
    ['10.0.0.5'],
    ['169.254.169.254'],
    ['::1'],
    ['fd00::1'],
    ['157.240.1.1', '192.168.1.1'],
  ])('refuse un hôte Meta résolu vers une adresse interne (%s) avant toute connexion', async (...addrs) => {
    const { fn, calls } = fakeRequestFn(() => undefined);
    const resolveHost = resolverOf(addrs);
    const http = createDefaultWhatsappHttp({ resolveHost, requestFn: fn });
    const e = await caught(http.request(baseReq()));
    expect(e.message).toMatch(/adresse publique/);
    expect(resolveHost).toHaveBeenCalledWith('lookaside.fbsbx.com');
    expect(calls).toHaveLength(0);
  });

  it('la liste blanche de l’exploitant ne s’applique pas', async () => {
    const previous = process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
    process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = '10.0.0.0/8,lookaside.fbsbx.com';
    try {
      const { fn, calls } = fakeRequestFn(() => undefined);
      const env = { GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS: '10.0.0.0/8,lookaside.fbsbx.com' };
      const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['10.1.2.3']), env, requestFn: fn });
      await caught(http.request(baseReq()));
      expect(calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS;
      else process.env.GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS = previous;
    }
  });

  it('refuse un hôte non officiel avant toute résolution DNS', async () => {
    const { fn, calls } = fakeRequestFn(() => undefined);
    const resolveHost = resolverOf(['157.240.1.1']);
    const http = createDefaultWhatsappHttp({ resolveHost, requestFn: fn });
    for (const url of ['https://evil.example.com/x', 'http://lookaside.fbsbx.com/x', 'https://2130706433/']) {
      expect(await caught(http.request(baseReq({ url })))).toBeInstanceOf(ConnectorItemRejectedError);
    }
    expect(resolveHost).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('DNS en échec → erreur générique', async () => {
    const { fn } = fakeRequestFn(() => undefined);
    const http = createDefaultWhatsappHttp({
      resolveHost: async () => {
        throw new Error('ENOTFOUND');
      },
      requestFn: fn,
    });
    expect((await caught(http.request(baseReq()))).message).toMatch(/DNS/);
  });

  it('se connecte à l’adresse vérifiée, nom d’origine en SNI et pour le certificat', async () => {
    const { fn, calls } = fakeRequestFn((_o, req) => {
      const res = fakeResponse(200, { 'content-length': String(PDF.length) });
      req.emit('response', res);
      res.push(PDF);
      res.push(null);
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['2a03:2880:f12f:83:face:b00c:0:25de', '157.240.1.1']), requestFn: fn });
    const out = await http.request(baseReq({ headers: { Authorization: `Bearer ${TOKEN}`, host: 'evil.example.com' } }));
    expect(out.status).toBe(200);
    expect(out.body).toEqual(PDF);
    const o = calls[0] as RequestOptions & { servername?: string; checkServerIdentity?: (h: string, c: PeerCertificate) => Error | undefined };
    expect(o.host).toBe('157.240.1.1'); // IPv4 d'abord
    expect(o.port).toBe(443);
    expect(o.servername).toBe('lookaside.fbsbx.com');
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.path).toBe('/whatsapp_business/attachments/?mid=987654321&ext=1732000000&hash=ATsignedHASHvalue42');
    expect((o.headers as Record<string, string>).Host).toBe('lookaside.fbsbx.com');
    expect((o.headers as Record<string, string>).host).toBeUndefined();
    expect(o.agent).toBeDefined();
    // Le certificat est jugé sur le NOM, pas sur l'IP : celui d'un autre domaine est refusé.
    expect(o.checkServerIdentity?.('157.240.1.1', certFor('lookaside.fbsbx.com'))).toBeUndefined();
    // (Erreur créée par `node:tls`, hors du « realm » jest : on teste sa forme, pas sa classe.)
    const mismatch = o.checkServerIdentity?.('157.240.1.1', certFor('evil.example.com'));
    expect(mismatch).toBeTruthy();
    expect(String(mismatch?.message)).toMatch(/lookaside\.fbsbx\.com/);
  });

  it('envoie le corps d’un POST avec sa longueur', async () => {
    const { fn, calls, reqs } = fakeRequestFn((_o, req) => {
      const res = fakeResponse(200, {});
      req.emit('response', res);
      res.push('{}');
      res.push(null);
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1']), requestFn: fn });
    await http.request(baseReq({ method: 'POST', url: `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, body: '{"a":"é"}' }));
    expect((calls[0]?.headers as Record<string, string>)['Content-Length']).toBe('10');
    expect(reqs[0]?.body).toBe('{"a":"é"}');
  });

  it('ne suit pas une redirection : la réponse 3xx est renvoyée telle quelle', async () => {
    const { fn, calls } = fakeRequestFn((_o, req) => {
      const res = fakeResponse(302, { location: 'https://evil.example.com/' });
      req.emit('response', res);
      res.push(null);
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1']), requestFn: fn });
    const out = await http.request(baseReq());
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe('https://evil.example.com/');
    expect(calls).toHaveLength(1);
  });

  it('refuse d’emblée un Content-Length supérieur au maximum', async () => {
    let read = 0;
    const { fn, reqs } = fakeRequestFn((_o, req) => {
      const res = fakeResponse(200, { 'content-length': '999999999' }, (r) => {
        read++;
        r.push(Buffer.alloc(100));
      });
      req.emit('response', res);
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1']), requestFn: fn });
    expect(await caught(http.request(baseReq()))).toBeInstanceOf(WhatsappBodyTooLargeError);
    expect(read).toBe(0);
    expect(reqs[0]?.destroyed).toBe(true);
  });

  it('interrompt un flux qui dépasse le maximum (sans Content-Length)', async () => {
    let produced = 0;
    let res: FakeResponse | undefined;
    const { fn, reqs } = fakeRequestFn((_o, req) => {
      // Flux infini : sans borne, le test ne se terminerait pas.
      res = fakeResponse(200, {}, (r) => {
        produced += 256;
        r.push(Buffer.alloc(256, 7));
      });
      req.emit('response', res);
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1']), requestFn: fn });
    expect(await caught(http.request(baseReq({ maxBytes: 1000 })))).toBeInstanceOf(WhatsappBodyTooLargeError);
    expect(res?.destroyed).toBe(true);
    expect(reqs[0]?.destroyed).toBe(true);
    expect(produced).toBeLessThan(10_000);
  });

  it('essaie l’adresse suivante si la connexion est refusée', async () => {
    let n = 0;
    const { fn, calls } = fakeRequestFn((_o, req) => {
      n++;
      if (n === 1) {
        req.emit('error', Object.assign(new Error(`connect ECONNREFUSED ${SIGNED_URL}`), { code: 'ECONNREFUSED' }));
        return;
      }
      const res = fakeResponse(200, {});
      req.emit('response', res);
      res.push(PDF);
      res.push(null);
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1', '157.240.1.2']), requestFn: fn });
    expect((await http.request(baseReq())).body).toEqual(PDF);
    expect(calls.map((c) => c.host)).toEqual(['157.240.1.1', '157.240.1.2']);
  });

  it('ne réessaie pas après une erreur en cours d’échange ; message sans détail', async () => {
    const { fn, calls } = fakeRequestFn((_o, req) => {
      req.emit('error', Object.assign(new Error(`socket hang up ${SIGNED_URL} ${TOKEN}`), { code: 'ECONNRESET' }));
    });
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1', '157.240.1.2']), requestFn: fn });
    const e = await caught(http.request(baseReq()));
    expect(e.message).toContain('ECONNRESET');
    expect(calls).toHaveLength(1);
  });

  it('délai global dépassé → requête détruite', async () => {
    const { fn, reqs } = fakeRequestFn(() => undefined); // ne répond jamais
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1']), requestFn: fn });
    expect((await caught(http.request(baseReq({ timeoutMs: 30 })))).message).toMatch(/Délai/);
    expect(reqs[0]?.destroyed).toBe(true);
  });

  it('refuse des paramètres de requête invalides', async () => {
    const { fn, calls } = fakeRequestFn(() => undefined);
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['157.240.1.1']), requestFn: fn });
    await caught(http.request(baseReq({ maxBytes: 0 })));
    await caught(http.request(baseReq({ timeoutMs: -1 })));
    await caught(http.request(baseReq({ method: 'PUT' as 'GET' })));
    expect(calls).toHaveLength(0);
  });

  it('chaîne complète client + transport par défaut : jeton jamais envoyé à une IP interne', async () => {
    const { fn, calls } = fakeRequestFn(() => undefined);
    const http = createDefaultWhatsappHttp({ resolveHost: resolverOf(['127.0.0.1']), requestFn: fn });
    await caught(client(http).downloadMedia(mediaInfo));
    expect(calls).toHaveLength(0);
  });
});
