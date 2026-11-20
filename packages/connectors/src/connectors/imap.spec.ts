import { createDefaultRegistry } from '../default-registry';
import { ConnectorConfigError, buildConnector, validateConnectorInput } from '../registry';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ConnectorDeps,
  type ImapClientFactory,
  type ImapConnectionParams,
  type ImapMessageSummary,
  type ImapSession,
  type SourceConnector,
} from '../types';
import { extractAttachments, createDefaultImapClientFactory } from './imap-default';
import { mapImapError } from './imap-errors';

// Garde SSRF simulée : tout résolveur renvoyant 10.x est « interne ».
jest.mock('../ssrf', () => ({
  SsrfError: class SsrfError extends Error {},
  isBlockedAddress: () => false,
  assertPublicHost: async (host: string, opts?: { resolve?: (h: string) => Promise<string[]> }) => {
    const ips = opts?.resolve ? await opts.resolve(host) : [host];
    if (ips.some((ip) => ip.startsWith('10.'))) {
      throw new Error(`Hôte interne refusé (${host}).`);
    }
    return ips;
  },
}));

const PASSWORD = 'motdepasse-de-test';
const CREDS = { user: 'archives@exemple.test', password: PASSWORD };
const CONFIG = { host: 'imap.exemple.test' };

const att = (partId: string, filename: string, contentType = 'application/pdf', size = 50_000) => ({
  partId,
  filename,
  contentType,
  size,
});

function msg(uid: number, attachments: ImapMessageSummary['attachments'], extra: Partial<ImapMessageSummary> = {}) {
  return {
    uid,
    messageId: `<m${uid}@exemple.test>`,
    from: 'alice@exemple.test',
    subject: `Sujet ${uid}`,
    date: new Date(Date.UTC(2026, 0, uid)),
    attachments,
    ...extra,
  } satisfies ImapMessageSummary;
}

class FakeSession implements ImapSession {
  closed = false;
  listCalls: Array<{ after: number; limit: number }> = [];
  downloads: Array<{ uid: number; partId: string; maxBytes: number }> = [];
  constructor(
    public uidValidity: bigint,
    public messages: ImapMessageSummary[],
    public contents = new Map<string, Buffer>(),
  ) {}
  async listMessages(afterUid: number, limit: number) {
    this.listCalls.push({ after: afterUid, limit });
    return this.messages
      .filter((m) => m.uid > afterUid)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, limit);
  }
  async downloadAttachment(uid: number, partId: string, maxBytes: number) {
    this.downloads.push({ uid, partId, maxBytes });
    const buf = this.contents.get(`${uid}:${partId}`);
    if (!buf) throw new ConnectorItemRejectedError('Pièce jointe introuvable.');
    if (buf.length > maxBytes) throw new ConnectorItemRejectedError('trop volumineuse');
    return buf;
  }
  async close() {
    this.closed = true;
  }
}

class FakeFactory implements ImapClientFactory {
  connects: ImapConnectionParams[] = [];
  error: unknown = null;
  constructor(public session: FakeSession) {}
  async connect(params: ImapConnectionParams) {
    this.connects.push(params);
    if (this.error) throw this.error;
    return this.session;
  }
}

function make(
  factory: ImapClientFactory,
  opts: { config?: Record<string, unknown>; limits?: { maxFileBytes?: number } } = {},
): SourceConnector {
  const deps: ConnectorDeps = { imap: factory };
  return buildConnector(createDefaultRegistry(), 'imap', {
    config: { ...CONFIG, ...opts.config },
    credentials: CREDS,
    limits: opts.limits,
    deps,
  });
}

describe('imap — listage', () => {
  it('transmet la configuration validée à la fabrique', async () => {
    const f = new FakeFactory(new FakeSession(7n, []));
    await make(f).authenticate();
    expect(f.connects).toEqual([
      { host: 'imap.exemple.test', port: 993, secure: true, user: CREDS.user, password: PASSWORD, mailbox: 'INBOX' },
    ]);
  });

  it('liste par UID : externalId, métadonnées et jeton', async () => {
    const s = new FakeSession(7n, [msg(10, [att('2', 'Facture mars.pdf')])]);
    const page = await make(new FakeFactory(s)).listChanges(null, { pageSize: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      externalId: '7:10:2',
      name: 'Facture mars.pdf',
      mimeType: 'application/pdf',
      byteLength: 50_000,
      originAuthor: 'alice@exemple.test',
      originMetadata: { subject: 'Sujet 10', messageId: '<m10@exemple.test>', from: 'alice@exemple.test' },
    });
    expect(page.items[0]?.originCreatedAt?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(JSON.parse(page.nextToken as string)).toEqual({ v: 7, u: 10 });
    expect(page.hasMore).toBe(false);
    expect(page.deletedExternalIds).toEqual([]);
  });

  it('est incrémental : seuls les UID au-delà du jeton sont lus', async () => {
    const s = new FakeSession(7n, [msg(1, [att('2', 'a.pdf')]), msg(2, [att('2', 'b.pdf')])]);
    const c = make(new FakeFactory(s));
    const first = await c.listChanges(null, { pageSize: 50 });
    expect(first.items).toHaveLength(2);
    s.messages.push(msg(3, [att('2', 'c.pdf')]));
    const next = await c.listChanges(first.nextToken, { pageSize: 50 });
    expect(next.items.map((i) => i.externalId)).toEqual(['7:3:2']);
    expect(s.listCalls[1]?.after).toBe(2);
    const idle = await c.listChanges(next.nextToken, { pageSize: 50 });
    expect(idle.items).toEqual([]);
    expect(JSON.parse(idle.nextToken as string)).toEqual({ v: 7, u: 3 });
  });

  it('produit un élément par pièce jointe', async () => {
    const s = new FakeSession(7n, [msg(5, [att('2', 'a.pdf'), att('3', 'b.docx', 'application/msword'), att('4', 'c.xlsx')])]);
    const page = await make(new FakeFactory(s)).listChanges(null, { pageSize: 50 });
    expect(page.items.map((i) => i.externalId)).toEqual(['7:5:2', '7:5:3', '7:5:4']);
  });

  it('ignore signatures (petites images) et extensions hors liste, mais fait avancer le jeton', async () => {
    const s = new FakeSession(7n, [
      msg(1, [att('2', 'logo.png', 'image/png', 4_000), att('3', 'setup.exe', 'application/octet-stream')]),
      msg(2, [att('2', 'photo.jpg', 'image/jpeg', 200_000)]),
    ]);
    const page = await make(new FakeFactory(s)).listChanges(null, { pageSize: 50 });
    expect(page.items.map((i) => i.externalId)).toEqual(['7:2:2']);
    expect(JSON.parse(page.nextToken as string).u).toBe(2);
  });

  it('pagine sur les MESSAGES, pas sur les pièces jointes', async () => {
    const s = new FakeSession(
      7n,
      [1, 2, 3, 4, 5].map((u) => msg(u, [att('2', `a${u}.pdf`), att('3', `b${u}.pdf`)])),
    );
    const c = make(new FakeFactory(s));
    const p1 = await c.listChanges(null, { pageSize: 2 });
    expect(p1.items).toHaveLength(4); // 2 messages x 2 pièces
    expect(p1.hasMore).toBe(true);
    expect(JSON.parse(p1.nextToken as string).u).toBe(2);
    const p2 = await c.listChanges(p1.nextToken, { pageSize: 2 });
    expect(p2.items.map((i) => i.externalId)).toEqual(['7:3:2', '7:3:3', '7:4:2', '7:4:3']);
    expect(p2.hasMore).toBe(true);
    const p3 = await c.listChanges(p2.nextToken, { pageSize: 2 });
    expect(p3.items.map((i) => i.externalId)).toEqual(['7:5:2', '7:5:3']);
    expect(p3.hasMore).toBe(false);
  });

  it('page exacte : pas de page vide superflue', async () => {
    const s = new FakeSession(7n, [msg(1, [att('2', 'a.pdf')]), msg(2, [att('2', 'b.pdf')])]);
    const page = await make(new FakeFactory(s)).listChanges(null, { pageSize: 2 });
    expect(page.hasMore).toBe(false);
  });

  it('recommence au début quand UIDVALIDITY a changé', async () => {
    const s = new FakeSession(7n, [msg(1, [att('2', 'a.pdf')]), msg(2, [att('2', 'b.pdf')])]);
    const c = make(new FakeFactory(s));
    const first = await c.listChanges(null, { pageSize: 50 });
    s.uidValidity = 8n; // boîte recréée
    const again = await c.listChanges(first.nextToken, { pageSize: 50 });
    expect(again.items.map((i) => i.externalId)).toEqual(['8:1:2', '8:2:2']);
    expect(s.listCalls[1]?.after).toBe(0);
    expect(JSON.parse(again.nextToken as string)).toEqual({ v: 8, u: 2 });
  });

  it('lève sur un jeton illisible au lieu de relister', async () => {
    const s = new FakeSession(7n, [msg(1, [att('2', 'a.pdf')])]);
    const c = make(new FakeFactory(s));
    for (const bad of ['nope', '{"v":1}', '{"v":1,"u":-3}', '[]']) {
      await expect(c.listChanges(bad, { pageSize: 10 })).rejects.toThrow(/illisible/);
    }
    expect(s.listCalls).toHaveLength(0);
  });

  it('réutilise une seule session pour plusieurs appels', async () => {
    const f = new FakeFactory(new FakeSession(7n, []));
    const c = make(f);
    await c.authenticate();
    await c.listChanges(null, { pageSize: 5 });
    await c.listChanges(null, { pageSize: 5 });
    expect(f.connects).toHaveLength(1);
  });
});

describe('imap — récupération', () => {
  const contents = new Map([['10:2', Buffer.from('%PDF-1.7')]]);
  const base = () => new FakeSession(7n, [msg(10, [att('2', 'a.pdf')])], contents);

  it('télécharge la pièce, bornée par maxFileBytes', async () => {
    const s = base();
    const c = make(new FakeFactory(s), { limits: { maxFileBytes: 1000 } });
    const [item] = (await c.listChanges(null, { pageSize: 10 })).items;
    const file = await c.fetchFile(item!);
    expect(file.bytes.toString()).toBe('%PDF-1.7');
    expect(file.name).toBe('a.pdf');
    expect(s.downloads).toEqual([{ uid: 10, partId: '2', maxBytes: 1000 }]);
  });

  it('refuse une pièce plus grosse que la limite', async () => {
    const s = new FakeSession(7n, [], new Map([['10:2', Buffer.alloc(2000)]]));
    const c = make(new FakeFactory(s), { limits: { maxFileBytes: 1000 } });
    await expect(
      c.fetchFile({ externalId: '7:10:2', name: 'a.pdf' }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('refuse même si la session renvoie plus que la borne', async () => {
    const s = base();
    s.downloadAttachment = async () => Buffer.alloc(5000);
    const c = make(new FakeFactory(s), { limits: { maxFileBytes: 1000 } });
    await expect(
      c.fetchFile({ externalId: '7:10:2', name: 'a.pdf' }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('refuse une extension non autorisée sans télécharger', async () => {
    const s = base();
    const c = make(new FakeFactory(s));
    await expect(
      c.fetchFile({ externalId: '7:10:2', name: 'setup.exe' }),
    ).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    expect(s.downloads).toHaveLength(0);
  });

  it('refuse un identifiant mal formé', async () => {
    const c = make(new FakeFactory(base()));
    for (const id of ['10:2', 'a:b:c', '7:10:2;DROP', '7:-1:2', '']) {
      await expect(c.fetchFile({ externalId: id, name: 'a.pdf' })).rejects.toBeInstanceOf(
        ConnectorItemRejectedError,
      );
    }
  });

  it('refuse un élément d’une ancienne UIDVALIDITY', async () => {
    const s = base();
    s.uidValidity = 9n;
    await expect(
      make(new FakeFactory(s)).fetchFile({ externalId: '7:10:2', name: 'a.pdf' }),
    ).rejects.toThrow(/UIDVALIDITY/);
  });

  it('un élément rejeté ne casse pas la session', async () => {
    const f = new FakeFactory(base());
    const c = make(f);
    await expect(c.fetchFile({ externalId: '7:99:2', name: 'a.pdf' })).rejects.toBeInstanceOf(
      ConnectorItemRejectedError,
    );
    await c.fetchFile({ externalId: '7:10:2', name: 'a.pdf' });
    expect(f.connects).toHaveLength(1);
    expect(f.session.closed).toBe(false);
  });
});

describe('imap — erreurs typées, aucun secret', () => {
  it('échec d’authentification → ConnectorAuthError', async () => {
    const f = new FakeFactory(new FakeSession(1n, []));
    f.error = Object.assign(new Error(`Command failed: LOGIN ${CREDS.user} ${PASSWORD}`), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      response: `NO [AUTHENTICATIONFAILED] Invalid credentials for ${PASSWORD}`,
    });
    const err = await make(f).authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorAuthError);
    expect(err.expired).toBe(false);
    expect(err.message).not.toContain(PASSWORD);
  });

  it('535 sans drapeau → ConnectorAuthError', async () => {
    const f = new FakeFactory(new FakeSession(1n, []));
    f.error = new Error('535 5.7.8 Authentication failed');
    await expect(make(f).authenticate()).rejects.toBeInstanceOf(ConnectorAuthError);
  });

  it('autorisation expirée → ConnectorAuthError expired', async () => {
    const f = new FakeFactory(new FakeSession(1n, []));
    f.error = new Error('NO [AUTHENTICATIONEXPIRED] token expired');
    const err = await make(f).authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorAuthError);
    expect(err.expired).toBe(true);
  });

  it.each([
    ['NO [THROTTLED] Too many commands'],
    ['BAD rate limit exceeded'],
    ['NO [LIMIT] Maximum connections reached'],
    ['NO too many simultaneous connections'],
  ])('limitation %j → ConnectorQuotaError', async (text) => {
    const f = new FakeFactory(new FakeSession(1n, []));
    f.error = new Error(text);
    await expect(make(f).authenticate()).rejects.toBeInstanceOf(ConnectorQuotaError);
  });

  it('conserve le délai suggéré par le serveur', () => {
    const e = mapImapError(Object.assign(new Error('x'), { code: 'ETHROTTLE', throttleReset: 5000 }));
    expect(e).toBeInstanceOf(ConnectorQuotaError);
    expect((e as ConnectorQuotaError).retryAfterMs).toBe(5000);
  });

  it('limitation en cours de listage → ConnectorQuotaError, puis reconnexion', async () => {
    const s = new FakeSession(1n, [msg(1, [att('2', 'a.pdf')])]);
    const f = new FakeFactory(s);
    const c = make(f);
    s.listMessages = async () => {
      throw new Error('NO [THROTTLED] slow down');
    };
    await expect(c.listChanges(null, { pageSize: 5 })).rejects.toBeInstanceOf(ConnectorQuotaError);
    expect(s.closed).toBe(true);
    await c.authenticate();
    expect(f.connects).toHaveLength(2);
  });

  it('une erreur réseau ne laisse jamais fuiter le mot de passe', async () => {
    const f = new FakeFactory(new FakeSession(1n, []));
    f.error = new Error(`connect ECONNRESET while sending ${PASSWORD}`);
    const err = await make(f).authenticate().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(PASSWORD);
    expect(err.message).toContain('***');
  });

  it('une erreur déjà typée traverse telle quelle', () => {
    const e = new ConnectorQuotaError('déjà typée', 12);
    expect(mapImapError(e)).toBe(e);
  });

  it('après un échec de connexion, l’appel suivant retente', async () => {
    const f = new FakeFactory(new FakeSession(1n, []));
    f.error = new Error('ECONNREFUSED');
    const c = make(f);
    await expect(c.authenticate()).rejects.toThrow();
    f.error = null;
    await expect(c.authenticate()).resolves.toBeUndefined();
  });
});

describe('imap — droits, fermeture', () => {
  it('un seul principal en lecture : le compte de la boîte', async () => {
    const c = make(new FakeFactory(new FakeSession(1n, [])));
    expect(await c.readOriginAcl({ externalId: '1:1:2', name: 'a.pdf' })).toEqual({
      entries: [{ principal: CREDS.user, kind: 'user', access: 'read' }],
    });
  });

  it('close ferme la session, et ne fait rien sans session', async () => {
    const s = new FakeSession(1n, []);
    const c = make(new FakeFactory(s));
    await c.close();
    expect(s.closed).toBe(false);
    await c.authenticate();
    await c.close();
    expect(s.closed).toBe(true);
    expect(c.findMissing).toBeUndefined();
  });
});

describe('imap — configuration et SSRF', () => {
  const reg = createDefaultRegistry();
  const input = (config: unknown, credentials: unknown = CREDS) => ({
    connectorType: 'imap',
    mode: 0 as const,
    config,
    credentials,
  });

  it('applique les défauts (993, TLS, INBOX)', async () => {
    const out = await validateConnectorInput(reg, input(CONFIG), { resolveHost: async () => ['93.184.216.34'] });
    expect(out.settings).toEqual({ host: 'imap.exemple.test', port: 993, secure: true, mailbox: 'INBOX' });
  });

  it('refuse un hôte qui résout vers une adresse interne', async () => {
    await expect(
      validateConnectorInput(reg, input(CONFIG), { resolveHost: async () => ['10.0.0.5'] }),
    ).rejects.toThrow(/refusée/);
  });

  it('accepte STARTTLS (secure=false) et un port libre', async () => {
    const out = await validateConnectorInput(reg, input({ ...CONFIG, secure: false, port: 143 }), {
      resolveHost: async () => ['93.184.216.34'],
    });
    expect(out.settings).toMatchObject({ secure: false, port: 143 });
  });

  it.each([
    [{ host: 'x.test', port: 0 }],
    [{ host: 'x.test', port: 70000 }],
    [{ host: 'x.test', port: 1.5 }],
    [{ host: '' }],
    [{ host: 'a b' }],
    [{ host: 'x.test', verifyCertificate: false }],
    [{ host: 'x.test', onlyAttachments: false }],
    [{}],
  ])('refuse la config %j', async (config) => {
    await expect(
      validateConnectorInput(reg, input(config), { resolveHost: async () => ['93.184.216.34'] }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });

  it('refuse des identifiants vides ou trop longs sans les citer', async () => {
    const err = await validateConnectorInput(reg, input(CONFIG, { user: 'u', password: 'x'.repeat(501) }), {
      resolveHost: async () => ['93.184.216.34'],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorConfigError);
    expect(err.message).not.toContain('xxxxx');
    await expect(
      validateConnectorInput(reg, input(CONFIG, { user: '', password: PASSWORD }), {
        resolveHost: async () => ['93.184.216.34'],
      }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });

  it('la fabrique par défaut re-contrôle l’hôte à chaque connexion (anti DNS-rebinding)', async () => {
    const resolveHost = jest.fn(async () => ['10.0.0.5']);
    const factory = createDefaultImapClientFactory({ resolveHost });
    const err = await factory
      .connect({ host: 'imap.exemple.test', port: 993, secure: true, user: 'u', password: PASSWORD, mailbox: 'INBOX' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/interne/);
    expect(err.message).not.toContain(PASSWORD);
    expect(resolveHost).toHaveBeenCalledTimes(1);
    // Aucune connexion réseau n'a été tentée : le refus intervient avant toute ouverture de socket.
  });
});

describe('imap — extraction des pièces jointes (BODYSTRUCTURE)', () => {
  it('garde les pièces jointes, ignore corps, multiparts et images inline (cid)', () => {
    const found = extractAttachments({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          part: '1',
          childNodes: [
            { type: 'text/plain', part: '1.1', size: 120 },
            {
              type: 'multipart/related',
              part: '1.2',
              childNodes: [
                { type: 'text/html', part: '1.2.1', size: 900 },
                {
                  type: 'image/png',
                  part: '1.2.2',
                  id: '<logo@cid>',
                  disposition: 'inline',
                  dispositionParameters: { filename: 'logo.png' },
                  size: 3000,
                },
              ],
            },
          ],
        },
        {
          type: 'application/pdf',
          part: '2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'contrat.pdf' },
          size: 12_345,
        },
        { type: 'application/msword', part: '3', parameters: { name: 'ancien.doc' }, size: 800 },
        { type: 'application/zip', part: '4', disposition: 'attachment', size: 10 },
      ],
    });
    expect(found).toEqual([
      { partId: '2', filename: 'contrat.pdf', contentType: 'application/pdf', size: 12_345 },
      { partId: '3', filename: 'ancien.doc', contentType: 'application/msword', size: 800 },
      { partId: '4', filename: 'piece-4', contentType: 'application/zip', size: 10 },
    ]);
  });

  it('traite un message attaché comme une seule pièce', () => {
    const found = extractAttachments({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'message/rfc822',
          part: '2',
          disposition: 'attachment',
          size: 4000,
          childNodes: [{ type: 'application/pdf', part: '2.1', dispositionParameters: { filename: 'interne.pdf' } }],
        },
      ],
    });
    expect(found).toEqual([{ partId: '2', filename: 'message-2.eml', contentType: 'message/rfc822', size: 4000 }]);
  });

  it('nettoie les noms (chemins, caractères de contrôle) et gère une structure vide', () => {
    expect(extractAttachments(undefined)).toEqual([]);
    const [a] = extractAttachments({
      type: 'application/pdf',
      part: '1',
      disposition: 'attachment',
      dispositionParameters: { filename: '..\\..\\evil\u0000.pdf' },
    });
    expect(a?.filename).toBe('evil.pdf');
  });
});
