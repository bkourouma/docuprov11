import { createHmac } from 'node:crypto';
import {
  SlidingWindowRateLimiter,
  WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS,
  WHATSAPP_MAX_BODY_BYTES,
  WHATSAPP_SIGNATURE_HEADER,
  isWithinReplayWindow,
  parseWhatsappWebhook,
  resolveClientIp,
  verifyWhatsappChallenge,
  verifyWhatsappSignature,
} from './whatsapp-webhook';

// Aucun réseau, aucune horloge réelle : tout est injecté.
const APP_SECRET = 'app-secret-de-test-0123456789';
const PHONE_NUMBER_ID = '106540352242922';
const NOW = new Date('2026-11-20T10:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

type Json = Record<string, unknown>;

function documentMessage(overrides: Json = {}): Json {
  return {
    from: '33612345678',
    id: 'wamid.HBgLMzM2MTIzNDU2NzgVAgASGBQzQTk0RjM1QjE3RDM0QjQ0QzRBOQA=',
    timestamp: String(NOW_S - 10),
    type: 'document',
    document: {
      caption: 'légende <script>alert(1)</script>',
      filename: '../../etc/facture mars.pdf',
      mime_type: 'application/pdf',
      sha256: 'A'.repeat(64),
      id: '1234567890123456',
    },
    ...overrides,
  };
}

function imageMessage(overrides: Json = {}): Json {
  return {
    from: '+225 07 07 07 07 07',
    id: 'wamid.IMAGE1',
    timestamp: String(NOW_S - 5),
    type: 'image',
    image: {
      caption: 'photo',
      mime_type: 'image/jpeg',
      // base64 standard de 32 octets, forme observée dans les webhooks Meta.
      sha256: Buffer.alloc(32, 0xab).toString('base64'),
      id: '987654321',
    },
    ...overrides,
  };
}

function change(messages: unknown[], opts: { phoneNumberId?: string; statuses?: unknown[]; field?: string } = {}): Json {
  const value: Json = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550001111', phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
    contacts: [{ profile: { name: 'Awa' }, wa_id: '33612345678' }],
  };
  if (messages.length > 0) value.messages = messages;
  if (opts.statuses) value.statuses = opts.statuses;
  return { field: opts.field ?? 'messages', value };
}

function payload(changes: Json[], object = 'whatsapp_business_account'): Buffer {
  return Buffer.from(JSON.stringify({ object, entry: [{ id: 'WABA_ID', changes }] }), 'utf8');
}

const ctx = { phoneNumberId: PHONE_NUMBER_ID, now: NOW };

describe('constantes', () => {
  it('exposent les valeurs du contrat', () => {
    expect(WHATSAPP_SIGNATURE_HEADER).toBe('x-hub-signature-256');
    expect(WHATSAPP_MAX_BODY_BYTES).toBe(256 * 1024);
    expect(WHATSAPP_DEFAULT_REPLAY_WINDOW_SECONDS).toBe(3600);
  });
});

describe('verifyWhatsappSignature', () => {
  const body = payload([change([documentMessage()])]);

  it('accepte une signature valide', () => {
    expect(verifyWhatsappSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('tolère la casse des hexadécimaux', () => {
    const upper = `sha256=${sign(body).slice('sha256='.length).toUpperCase()}`;
    expect(verifyWhatsappSignature(body, upper, APP_SECRET)).toBe(true);
  });

  it('refuse une signature invalide', () => {
    const sig = sign(body);
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(verifyWhatsappSignature(body, flipped, APP_SECRET)).toBe(false);
  });

  it('refuse un en-tête absent', () => {
    expect(verifyWhatsappSignature(body, undefined, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, null, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, '', APP_SECRET)).toBe(false);
  });

  it('refuse un en-tête mal formé', () => {
    const hex = sign(body).slice('sha256='.length);
    expect(verifyWhatsappSignature(body, hex, APP_SECRET)).toBe(false); // sans préfixe
    expect(verifyWhatsappSignature(body, `sha1=${hex}`, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, `SHA256=${hex}`, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, `sha256=${hex.slice(0, 63)}`, APP_SECRET)).toBe(false); // trop court
    expect(verifyWhatsappSignature(body, `sha256=${hex}0`, APP_SECRET)).toBe(false); // trop long
    expect(verifyWhatsappSignature(body, `sha256=${hex.slice(0, 63)}g`, APP_SECRET)).toBe(false); // hex invalide
    expect(verifyWhatsappSignature(body, ` sha256=${hex}`, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, `sha256=${hex} `, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, `sha256=${hex}\n`, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, 12345, APP_SECRET)).toBe(false);
  });

  it('refuse un en-tête dupliqué (tableau)', () => {
    expect(verifyWhatsappSignature(body, [sign(body)], APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, [sign(body), sign(body)], APP_SECRET)).toBe(false);
  });

  it('refuse un corps modifié d’un seul octet', () => {
    const sig = sign(body);
    const tampered = Buffer.from(body);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] as number) ^ 0x01;
    expect(verifyWhatsappSignature(tampered, sig, APP_SECRET)).toBe(false);
    const extended = Buffer.concat([body, Buffer.from(' ')]);
    expect(verifyWhatsappSignature(extended, sig, APP_SECRET)).toBe(false);
  });

  it('refuse un secret différent ou vide', () => {
    expect(verifyWhatsappSignature(body, sign(body, 'autre-secret'), APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(body, sign(body, ''), '')).toBe(false);
    expect(verifyWhatsappSignature(body, sign(body), undefined as unknown as string)).toBe(false);
  });

  it('refuse un corps qui n’est pas un Buffer (corps déjà analysé)', () => {
    const sig = sign(body);
    expect(verifyWhatsappSignature(body.toString('utf8'), sig, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(JSON.parse(body.toString('utf8')), sig, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(new Uint8Array(body), sig, APP_SECRET)).toBe(false);
    expect(verifyWhatsappSignature(undefined, sig, APP_SECRET)).toBe(false);
  });

  it('accepte un corps vide correctement signé (le refus est le rôle du parseur)', () => {
    const empty = Buffer.alloc(0);
    expect(verifyWhatsappSignature(empty, sign(empty), APP_SECRET)).toBe(true);
  });
});

describe('verifyWhatsappChallenge', () => {
  const TOKEN = 'jeton-de-verification-123';
  const ok = { mode: 'subscribe', token: TOKEN, challenge: '1158201444' };

  it('renvoie le challenge pour une requête valide', () => {
    expect(verifyWhatsappChallenge(ok, TOKEN)).toEqual({ ok: true, challenge: '1158201444' });
    expect(verifyWhatsappChallenge({ ...ok, challenge: 'aB_-9' }, TOKEN)).toEqual({ ok: true, challenge: 'aB_-9' });
  });

  it('refuse un mauvais jeton (y compris préfixe, casse, longueur)', () => {
    expect(verifyWhatsappChallenge({ ...ok, token: 'mauvais' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, token: TOKEN.slice(0, -1) }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, token: `${TOKEN}x` }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, token: TOKEN.toUpperCase() }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, token: '' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, token: undefined }, TOKEN)).toEqual({ ok: false });
  });

  it('refuse un mauvais mode', () => {
    expect(verifyWhatsappChallenge({ ...ok, mode: 'unsubscribe' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, mode: 'Subscribe' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, mode: undefined }, TOKEN)).toEqual({ ok: false });
  });

  it('refuse un challenge piégé', () => {
    expect(verifyWhatsappChallenge({ ...ok, challenge: '<script>alert(1)</script>' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, challenge: '123\r\nSet-Cookie: x=1' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, challenge: 'a'.repeat(201) }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, challenge: '' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, challenge: 'é' }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, challenge: 123 }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, challenge: 'a'.repeat(200) }, TOKEN)).toEqual({ ok: true, challenge: 'a'.repeat(200) });
  });

  it('refuse les valeurs non chaînes (paramètres répétés → tableaux)', () => {
    expect(verifyWhatsappChallenge({ ...ok, challenge: ['1', '2'] }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, token: [TOKEN] }, TOKEN)).toEqual({ ok: false });
    expect(verifyWhatsappChallenge({ ...ok, mode: ['subscribe'] }, TOKEN)).toEqual({ ok: false });
  });

  it('refuse un jeton attendu vide ou absent, même si le jeton reçu est vide', () => {
    expect(verifyWhatsappChallenge({ ...ok, token: '' }, '')).toEqual({ ok: false });
    expect(verifyWhatsappChallenge(ok, '')).toEqual({ ok: false });
    expect(verifyWhatsappChallenge(ok, undefined as unknown as string)).toEqual({ ok: false });
  });

  it('ne lève pas sur une requête absente', () => {
    expect(verifyWhatsappChallenge(null as unknown as Json, TOKEN)).toEqual({ ok: false });
  });
});

describe('isWithinReplayWindow', () => {
  const W = 3600;

  it('accepte un message récent', () => {
    expect(isWithinReplayWindow(NOW_S - 30, NOW, W)).toBe(true);
    expect(isWithinReplayWindow(NOW_S, NOW, W)).toBe(true);
  });

  it('refuse un message trop ancien, accepte la limite exacte', () => {
    expect(isWithinReplayWindow(NOW_S - W, NOW, W)).toBe(true);
    expect(isWithinReplayWindow(NOW_S - W - 1, NOW, W)).toBe(false);
    expect(isWithinReplayWindow(NOW_S - W, new Date(NOW.getTime() + 1), W)).toBe(false);
    expect(isWithinReplayWindow(NOW_S - 7 * 24 * 3600, NOW, W)).toBe(false);
  });

  it('refuse un message trop dans le futur, accepte la limite exacte', () => {
    expect(isWithinReplayWindow(NOW_S + 300, NOW, W)).toBe(true);
    expect(isWithinReplayWindow(NOW_S + 301, NOW, W)).toBe(false);
    expect(isWithinReplayWindow(NOW_S + 10, NOW, W, 0)).toBe(false);
    expect(isWithinReplayWindow(NOW_S + 10, NOW, W, 10)).toBe(true);
  });

  it('refuse les entrées non exploitables', () => {
    expect(isWithinReplayWindow(Number.NaN, NOW, W)).toBe(false);
    expect(isWithinReplayWindow(NOW_S + 0.5, NOW, W)).toBe(false);
    expect(isWithinReplayWindow(Number.POSITIVE_INFINITY, NOW, W)).toBe(false);
    expect(isWithinReplayWindow(-1, NOW, W)).toBe(false);
    expect(isWithinReplayWindow('1700000000' as unknown as number, NOW, W)).toBe(false);
    expect(isWithinReplayWindow(NOW_S, new Date('invalide'), W)).toBe(false);
    expect(isWithinReplayWindow(NOW_S, NOW, Number.NaN)).toBe(false);
    expect(isWithinReplayWindow(NOW_S, NOW, -1)).toBe(false);
    expect(isWithinReplayWindow(NOW_S, NOW, W, Number.NaN)).toBe(false);
  });
});

describe('parseWhatsappWebhook', () => {
  it('extrait un document valide sans lire la légende', () => {
    const r = parseWhatsappWebhook(payload([change([documentMessage()])]), ctx);
    expect(r.malformed).toBe(false);
    expect(r.ignored).toEqual({ wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 });
    expect(r.messages).toEqual([
      {
        messageId: 'wamid.HBgLMzM2MTIzNDU2NzgVAgASGBQzQTk0RjM1QjE3RDM0QjQ0QzRBOQA=',
        from: '33612345678',
        timestamp: NOW_S - 10,
        kind: 'document',
        mediaId: '1234567890123456',
        mimeType: 'application/pdf',
        filename: '../../etc/facture mars.pdf', // brut : assaini ailleurs
        sha256: 'a'.repeat(64),
      },
    ]);
    expect(JSON.stringify(r)).not.toContain('légende');
    expect(JSON.stringify(r)).not.toContain('script');
  });

  it('extrait une image valide (numéro normalisé, sha256 base64 converti en hex)', () => {
    const r = parseWhatsappWebhook(payload([change([imageMessage()])]), ctx);
    expect(r.malformed).toBe(false);
    expect(r.messages).toEqual([
      {
        messageId: 'wamid.IMAGE1',
        from: '2250707070707',
        timestamp: NOW_S - 5,
        kind: 'image',
        mediaId: '987654321',
        mimeType: 'image/jpeg',
        sha256: 'ab'.repeat(32),
      },
    ]);
    expect(r.messages[0]).not.toHaveProperty('filename');
  });

  it('omet les indices illisibles (MIME, sha256, nom) sans invalider le message', () => {
    const msg = documentMessage({
      document: { id: '42', mime_type: 'pas un mime', sha256: 'zz', filename: 'x'.repeat(2000) },
    });
    const r = parseWhatsappWebhook(payload([change([msg])]), ctx);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toEqual({
      messageId: msg.id,
      from: '33612345678',
      timestamp: NOW_S - 10,
      kind: 'document',
      mediaId: '42',
    });
    const withParams = documentMessage({ document: { id: '42', mime_type: 'Application/PDF; charset=binary' } });
    expect(parseWhatsappWebhook(payload([change([withParams])]), ctx).messages[0]?.mimeType).toBe('application/pdf');
  });

  it('accepte un horodatage numérique', () => {
    const r = parseWhatsappWebhook(payload([change([documentMessage({ timestamp: NOW_S })])]), ctx);
    expect(r.messages[0]?.timestamp).toBe(NOW_S);
  });

  it('ignore les messages adressés à un autre numéro (isolation entre connecteurs)', () => {
    const body = payload([
      change([documentMessage({ id: 'wamid.AUTRE1' }), imageMessage({ id: 'wamid.AUTRE2' })], { phoneNumberId: '999999999' }),
      change([imageMessage()]),
    ]);
    const r = parseWhatsappWebhook(body, ctx);
    expect(r.malformed).toBe(false);
    expect(r.messages.map((m) => m.messageId)).toEqual(['wamid.IMAGE1']);
    expect(r.ignored.wrongNumber).toBe(2);
  });

  it('ne traite rien si le Phone Number ID du connecteur est vide ou invalide', () => {
    const body = payload([change([documentMessage()])]);
    expect(parseWhatsappWebhook(body, { ...ctx, phoneNumberId: '' }).messages).toEqual([]);
    expect(parseWhatsappWebhook(body, { ...ctx, phoneNumberId: '' }).ignored.wrongNumber).toBe(1);
    expect(parseWhatsappWebhook(body, { ...ctx, phoneNumberId: `${PHONE_NUMBER_ID} ` }).messages).toEqual([]);
  });

  it('compte et ignore les accusés d’état (statuses)', () => {
    const statuses = [
      { id: 'wamid.S1', status: 'delivered', timestamp: String(NOW_S), recipient_id: '33612345678' },
      { id: 'wamid.S2', status: 'read', timestamp: String(NOW_S), recipient_id: '33612345678' },
    ];
    const r = parseWhatsappWebhook(payload([change([], { statuses })]), ctx);
    expect(r).toEqual({ malformed: false, messages: [], ignored: { wrongNumber: 0, stale: 0, invalid: 0, statuses: 2 } });
  });

  it('classe les types non pris en charge en « unsupported » sans média ni texte', () => {
    const types: Json[] = [
      { type: 'text', text: { body: 'bonjour <b>' } },
      { type: 'audio', audio: { id: '111', mime_type: 'audio/ogg; codecs=opus' } },
      { type: 'video', video: { id: '222' } },
      { type: 'sticker', sticker: { id: '333' } },
      { type: 'location', location: { latitude: 5.3, longitude: -4 } },
      { type: 'reaction', reaction: { emoji: 'x' } },
    ];
    const msgs = types.map((t, i) => ({ from: '33612345678', id: `wamid.T${i}`, timestamp: String(NOW_S), ...t }));
    const r = parseWhatsappWebhook(payload([change(msgs)]), ctx);
    expect(r.ignored.invalid).toBe(0);
    expect(r.messages).toHaveLength(types.length);
    for (const m of r.messages) {
      expect(m.kind).toBe('unsupported');
      expect(Object.keys(m).sort()).toEqual(['from', 'kind', 'messageId', 'timestamp']);
    }
    expect(JSON.stringify(r)).not.toContain('bonjour');
  });

  it('écarte les messages à l’identifiant invalide', () => {
    const bad = [
      documentMessage({ id: 'abc' }),
      documentMessage({ id: 'wamid.' }),
      documentMessage({ id: 'wamid.a b' }),
      documentMessage({ id: `wamid.${'a'.repeat(301)}` }),
      documentMessage({ id: 'wamid.<script>' }),
      documentMessage({ id: 42 }),
    ];
    const r = parseWhatsappWebhook(payload([change([...bad, imageMessage()])]), ctx);
    expect(r.malformed).toBe(false);
    expect(r.messages.map((m) => m.messageId)).toEqual(['wamid.IMAGE1']);
    expect(r.ignored.invalid).toBe(bad.length);
  });

  it('écarte les messages à l’expéditeur invalide', () => {
    const bad = [
      documentMessage({ from: '123' }),
      documentMessage({ from: '0612345678' }),
      documentMessage({ from: 'abc' }),
      documentMessage({ from: 33612345678 }),
      documentMessage({ from: undefined }),
    ];
    const r = parseWhatsappWebhook(payload([change(bad)]), ctx);
    expect(r.messages).toEqual([]);
    expect(r.ignored.invalid).toBe(bad.length);
  });

  it('écarte les messages au média ou à l’horodatage invalide', () => {
    const bad = [
      documentMessage({ document: { id: 'abc' } }),
      documentMessage({ document: undefined }),
      imageMessage({ image: { id: '1'.repeat(31) } }),
      documentMessage({ timestamp: 'hier' }),
      documentMessage({ timestamp: '-5' }),
      documentMessage({ timestamp: 1.5 }),
      documentMessage({ type: 42 }),
    ];
    const r = parseWhatsappWebhook(payload([change(bad)]), ctx);
    expect(r.messages).toEqual([]);
    expect(r.ignored.invalid).toBe(bad.length);
  });

  it('écarte les messages hors fenêtre anti-rejeu', () => {
    const body = payload([
      change([
        documentMessage({ id: 'wamid.VIEUX', timestamp: String(NOW_S - 3601) }),
        documentMessage({ id: 'wamid.FUTUR', timestamp: String(NOW_S + 301) }),
        documentMessage({ id: 'wamid.OK' }),
      ]),
    ]);
    const r = parseWhatsappWebhook(body, ctx);
    expect(r.messages.map((m) => m.messageId)).toEqual(['wamid.OK']);
    expect(r.ignored.stale).toBe(2);
    // Fenêtre élargie par l'appelant.
    const large = parseWhatsappWebhook(body, { ...ctx, replayWindowSeconds: 7200 });
    expect(large.messages.map((m) => m.messageId)).toEqual(['wamid.VIEUX', 'wamid.OK']);
    // Fenêtre ou horloge invalides : refus par défaut.
    expect(parseWhatsappWebhook(body, { ...ctx, replayWindowSeconds: Number.NaN }).messages).toEqual([]);
    expect(parseWhatsappWebhook(body, { ...ctx, now: new Date('x') }).ignored.stale).toBe(3);
  });

  it('déduplique les messageId identiques dans un même corps', () => {
    const body = payload([change([documentMessage(), documentMessage()]), change([documentMessage()])]);
    const r = parseWhatsappWebhook(body, ctx);
    expect(r.messages).toHaveLength(1);
    expect(r.ignored).toEqual({ wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 });
  });

  it('refuse en bloc un corps de plus de 100 messages', () => {
    const many = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => documentMessage({ id: `wamid.${prefix}${i}` }));
    expect(parseWhatsappWebhook(payload([change(many(100, 'A'))]), ctx).messages).toHaveLength(100);
    const over = parseWhatsappWebhook(payload([change(many(101, 'A'))]), ctx);
    expect(over).toEqual({ malformed: true, messages: [], ignored: { wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 } });
    // La borne est totale sur le corps, y compris d'autres numéros et plusieurs changements.
    const split = parseWhatsappWebhook(
      payload([change(many(60, 'A')), change(many(41, 'B'), { phoneNumberId: '1' })]),
      ctx,
    );
    expect(split.malformed).toBe(true);
    expect(split.messages).toEqual([]);
  });

  it('refuse en bloc plus de 50 entrées ou 50 changements', () => {
    const entries = Array.from({ length: 51 }, () => ({ id: 'W', changes: [] }));
    const tooManyEntries = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: entries }));
    expect(parseWhatsappWebhook(tooManyEntries, ctx).malformed).toBe(true);
    const changes = Array.from({ length: 51 }, () => change([], { field: 'account_update' }));
    expect(parseWhatsappWebhook(payload(changes), ctx).malformed).toBe(true);
    const twoEntries = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          { id: 'W1', changes: Array.from({ length: 30 }, () => change([], { field: 'x' })) },
          { id: 'W2', changes: Array.from({ length: 21 }, () => change([], { field: 'x' })) },
        ],
      }),
    );
    expect(parseWhatsappWebhook(twoEntries, ctx).malformed).toBe(true);
  });

  it('refuse un JSON invalide, un UTF-8 invalide et un corps vide', () => {
    expect(parseWhatsappWebhook(Buffer.from('{"object":'), ctx).malformed).toBe(true);
    expect(parseWhatsappWebhook(Buffer.from('not json'), ctx).malformed).toBe(true);
    expect(parseWhatsappWebhook(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), ctx).malformed).toBe(true);
    expect(parseWhatsappWebhook(Buffer.alloc(0), ctx).malformed).toBe(true);
    expect(parseWhatsappWebhook('{}' as unknown as Buffer, ctx).malformed).toBe(true);
  });

  it('refuse un corps trop gros avant toute analyse', () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const big = Buffer.alloc(WHATSAPP_MAX_BODY_BYTES + 1, 0x20);
      expect(parseWhatsappWebhook(big, ctx)).toEqual({
        malformed: true,
        messages: [],
        ignored: { wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 },
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('refuse un corps trop profond avant JSON.parse (sans lever)', () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const deep = Buffer.from(`${'['.repeat(100_000)}${']'.repeat(100_000)}`);
      expect(parseWhatsappWebhook(deep, ctx).malformed).toBe(true);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    // Les crochets dans les chaînes ne comptent pas.
    const inString = documentMessage({ document: { id: '7', filename: `${'['.repeat(100)}"\\"{{{.pdf` } });
    const r = parseWhatsappWebhook(payload([change([inString])]), ctx);
    expect(r.malformed).toBe(false);
    expect(r.messages[0]?.filename).toBe(`${'['.repeat(100)}"\\"{{{.pdf`);
  });

  it('refuse une forme inattendue', () => {
    const cases: unknown[] = [
      null,
      [],
      'chaîne',
      { object: 'whatsapp_business_account' },
      { object: 'whatsapp_business_account', entry: {} },
      { object: 'whatsapp_business_account', entry: [{ changes: {} }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages' }] }] },
      { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: [] } }] }] },
      {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_NUMBER_ID }, messages: {} } }] }],
      },
      { object: 42, entry: [] },
    ];
    for (const c of cases) {
      expect(parseWhatsappWebhook(Buffer.from(JSON.stringify(c)), ctx)).toEqual({
        malformed: true,
        messages: [],
        ignored: { wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 },
      });
    }
  });

  it('ignore un autre objet Meta et les autres champs que « messages »', () => {
    const other = parseWhatsappWebhook(payload([change([documentMessage()])], 'page'), ctx);
    expect(other).toEqual({ malformed: false, messages: [], ignored: { wrongNumber: 0, stale: 0, invalid: 0, statuses: 0 } });
    const r = parseWhatsappWebhook(payload([change([documentMessage()], { field: 'account_update' })]), ctx);
    expect(r.messages).toEqual([]);
    expect(r.malformed).toBe(false);
  });

  it('résiste à la pollution de prototype et aux champs inconnus', () => {
    // `__proto__` écrit en clé JSON brute : JSON.parse en fait une propriété PROPRE.
    const msg = JSON.stringify(documentMessage({ extra: true })).replace('{', '{"__proto__":{"kind":"image"},');
    const body = Buffer.from(
      `{"object":"whatsapp_business_account","__proto__":{"polluted":1},"entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"${PHONE_NUMBER_ID}","__proto__":{"x":1}},"nouveau_champ":{"a":[1,2]},"messages":[${msg}]}}]}]}`,
    );
    const r = parseWhatsappWebhook(body, ctx);
    expect(r.malformed).toBe(false);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.kind).toBe('document');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('SlidingWindowRateLimiter', () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('autorise jusqu’à la limite puis refuse', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 3, windowMs: 1000, now: c.now });
    expect([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([true, true, true, false]);
    expect(rl.take('b')).toBe(true); // clés indépendantes
  });

  it('fait glisser la fenêtre', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1000, now: c.now });
    expect(rl.take('k')).toBe(true); // t0
    c.advance(600);
    expect(rl.take('k')).toBe(true); // t0+600
    expect(rl.take('k')).toBe(false);
    c.advance(399); // t0+999 : le premier est encore dans la fenêtre
    expect(rl.take('k')).toBe(false);
    c.advance(1); // t0+1000 : le premier sort (borne exclue)
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
    c.advance(600); // t0+1600 : le second (t0+600) sort
    expect(rl.take('k')).toBe(true);
  });

  it('un refus ne consomme pas de jeton', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 100, now: c.now });
    expect(rl.take('k')).toBe(true);
    for (let i = 0; i < 50; i++) {
      c.advance(1);
      expect(rl.take('k')).toBe(false);
    }
    c.advance(50); // t0+100
    expect(rl.take('k')).toBe(true);
  });

  it('borne la mémoire avec maxKeys (purge des expirées puis éviction des plus anciennes)', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 100, now: c.now });
    for (let i = 0; i < 10_000; i++) rl.take(`ip-${i}`);
    expect(rl.size).toBe(100);
    // Les plus récentes sont gardées : ip-9999 est toujours limitée, ip-0 a été évincée.
    expect(rl.take('ip-9999')).toBe(false);
    expect(rl.take('ip-0')).toBe(true);
    expect(rl.size).toBe(100);
    // Après expiration, une nouvelle clé purge les expirées d'un coup.
    c.advance(1000);
    rl.take('nouvelle');
    expect(rl.size).toBe(1);
  });

  it('garde une clé active récemment vue plutôt qu’une ancienne', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 10_000, maxKeys: 2, now: c.now });
    rl.take('a');
    c.advance(1);
    rl.take('b');
    c.advance(1);
    expect(rl.take('a')).toBe(false); // « a » redevient la plus récente
    c.advance(1);
    rl.take('c'); // évince « b »
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
  });

  it('reset oublie tout', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, now: c.now });
    rl.take('k');
    expect(rl.take('k')).toBe(false);
    rl.reset();
    expect(rl.size).toBe(0);
    expect(rl.take('k')).toBe(true);
  });

  it('traite les clés invalides ou très longues sans croissance mémoire', () => {
    const c = clock();
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, now: c.now });
    expect(rl.take(undefined as unknown as string)).toBe(true);
    expect(rl.take('' as string)).toBe(false); // même seau que les clés invalides
    const long = 'x'.repeat(10_000);
    expect(rl.take(long)).toBe(true);
    expect(rl.take(`${long}y`)).toBe(false); // tronquées à la même clé
  });

  it('refuse des options invalides avec un message sans donnée', () => {
    expect(() => new SlidingWindowRateLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ limit: 1.5, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
    expect(() => new SlidingWindowRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 0 })).toThrow(RangeError);
  });

  it('utilise Date.now par défaut', () => {
    const rl = new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  it('ignore X-Forwarded-For par défaut', () => {
    const req = { ip: '10.0.0.1', socket: { remoteAddress: '203.0.113.7' }, headers: { 'x-forwarded-for': '6.6.6.6' } };
    expect(resolveClientIp(req)).toBe('203.0.113.7');
    expect(resolveClientIp(req, { trustForwardedFor: false })).toBe('203.0.113.7');
  });

  it('retombe sur req.ip puis sur « unknown »', () => {
    expect(resolveClientIp({ ip: '198.51.100.4', headers: {} })).toBe('198.51.100.4');
    expect(resolveClientIp({ headers: {} })).toBe('unknown');
    expect(resolveClientIp({ ip: 'pas-une-ip', socket: { remoteAddress: '' }, headers: {} })).toBe('unknown');
    expect(resolveClientIp(undefined as unknown as { headers: Record<string, unknown> })).toBe('unknown');
  });

  it('normalise les IPv4 mappées en IPv6 et la casse IPv6', () => {
    expect(resolveClientIp({ socket: { remoteAddress: '::ffff:192.0.2.10' }, headers: {} })).toBe('192.0.2.10');
    expect(resolveClientIp({ socket: { remoteAddress: '2001:DB8::1' }, headers: {} })).toBe('2001:db8::1');
  });

  it('avec trustForwardedFor, prend la dernière adresse de la liste', () => {
    const base = { socket: { remoteAddress: '10.0.0.2' } };
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' } }, { trustForwardedFor: true })).toBe('203.0.113.9');
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': '203.0.113.9 , ' } }, { trustForwardedFor: true })).toBe('203.0.113.9');
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': ['6.6.6.6', '2001:db8::5'] } }, { trustForwardedFor: true })).toBe('2001:db8::5');
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': '[2001:db8::5]:443' } }, { trustForwardedFor: true })).toBe('2001:db8::5');
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': '203.0.113.9:5678' } }, { trustForwardedFor: true })).toBe('203.0.113.9');
  });

  it('avec trustForwardedFor, ne remonte pas vers une entrée du client si la dernière est invalide', () => {
    const base = { socket: { remoteAddress: '10.0.0.2' } };
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': '6.6.6.6, garbage' } }, { trustForwardedFor: true })).toBe('10.0.0.2');
    expect(resolveClientIp({ ...base, headers: {} }, { trustForwardedFor: true })).toBe('10.0.0.2');
    expect(resolveClientIp({ ...base, headers: { 'x-forwarded-for': 42 } }, { trustForwardedFor: true })).toBe('10.0.0.2');
    expect(resolveClientIp({ headers: { 'x-forwarded-for': '<script>' } }, { trustForwardedFor: true })).toBe('unknown');
  });
});
