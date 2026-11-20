import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import * as connectors from '@archivage/connectors';
import {
  encryptCredentials,
  hashPhone,
  loadKeyRing,
  SlidingWindowRateLimiter,
  WHATSAPP_MAX_BODY_BYTES,
} from '@archivage/connectors';
import { GED_WHATSAPP_JOB, GedSourceItemState } from '@archivage/types';
import {
  inboundJobId,
  parseWebhookConnectorId,
  refusalJobId,
  replayWindowFromEnv,
  utcHourBucket,
  WhatsappWebhookService,
  type WhatsappRateLimiter,
} from './whatsapp-webhook.service';

// Espions sur les fonctions du paquet (ses réexports sont des accesseurs non configurables : on
// remplace le module par une copie dont ces deux fonctions sont observables, comportement réel).
jest.mock('@archivage/connectors', () => {
  const actual = jest.requireActual('@archivage/connectors');
  return {
    ...actual,
    parseWhatsappWebhook: jest.fn(actual.parseWhatsappWebhook),
    parseWhatsappStoredConfig: jest.fn(actual.parseWhatsappStoredConfig),
    verifyWhatsappSignature: jest.fn(actual.verifyWhatsappSignature),
    verifyWhatsappChallenge: jest.fn(actual.verifyWhatsappChallenge),
  };
});
const parseSpy = connectors.parseWhatsappWebhook as unknown as jest.Mock;
const configSpy = connectors.parseWhatsappStoredConfig as unknown as jest.Mock;
const signatureSpy = connectors.verifyWhatsappSignature as unknown as jest.Mock;
const challengeSpy = connectors.verifyWhatsappChallenge as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// Données FACTICES : ne servent qu'à vérifier qu'elles ne sortent nulle part.
// ---------------------------------------------------------------------------
const APP_SECRET = 'app-secret-factice-0123456789';
const VERIFY_TOKEN = 'verify-token-factice-42';
const ACCESS_TOKEN = 'access-token-factice-0123456789abcdef';
const KEY_ENV = { GED_CONNECTOR_KEY: Buffer.alloc(32, 7).toString('base64'), GED_CONNECTOR_KEY_ID: 'k1' };
const PHONE_NUMBER_ID = '123456789012345';
const SENDER = '221771234567';
const SENDER_2 = '221781112233';
const STRANGER = '33612345678';
const NOW = new Date('2026-11-20T12:34:56Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
/** Contient une marque bidi U+202E (affichage inversé) : retirée du nom de l'élément. */
const DOC_FILENAME = 'Facture Mars ‮fdp.exe';
const CAPTION = 'légende confidentielle';
const TEXT_BODY = 'texte privé du message';
const CONTACT_NAME = 'Awa Ndiaye';

const CREDENTIALS = { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN };
const ENC = encryptCredentials(CREDENTIALS, loadKeyRing(KEY_ENV));

function config(partial: Record<string, unknown> = {}) {
  return {
    phoneNumberId: PHONE_NUMBER_ID,
    senders: [{ phone: SENDER, label: 'Awa' }, { phone: SENDER_2 }],
    refuseUnknownSenders: false,
    ...partial,
    rights: { principalMap: {}, fallbackUserGroupIds: [5] },
  };
}

function connectorRow(partial: Record<string, unknown> = {}) {
  return {
    connectorType: 'whatsapp',
    status: 1,
    isActive: true,
    credentialsEnc: ENC.credentialsEnc,
    credentialsKeyId: ENC.credentialsKeyId,
    credentialsRef: null,
    config: config(),
    ...partial,
  };
}

let wamidSeq = 0;
function wamid(): string {
  wamidSeq += 1;
  return `wamid.HBgMMjIxNzcxMjM0NTY3FQIAEhgg${wamidSeq.toString().padStart(6, '0')}`;
}

function docMessage(partial: Record<string, unknown> = {}) {
  return {
    from: SENDER,
    id: wamid(),
    timestamp: String(NOW_S - 30),
    type: 'document',
    document: {
      id: '987654321012345',
      mime_type: 'application/pdf',
      sha256: 'ab'.repeat(32),
      filename: DOC_FILENAME,
      caption: CAPTION,
    },
    ...partial,
  };
}

function imageMessage(partial: Record<string, unknown> = {}) {
  return {
    from: SENDER,
    id: wamid(),
    timestamp: String(NOW_S - 5),
    type: 'image',
    image: { id: '555666777888', mime_type: 'image/jpeg', caption: CAPTION },
    ...partial,
  };
}

function textMessage(partial: Record<string, unknown> = {}) {
  return {
    from: SENDER,
    id: wamid(),
    timestamp: String(NOW_S - 5),
    type: 'text',
    text: { body: TEXT_BODY },
    ...partial,
  };
}

function notification(
  messages: unknown[],
  opts: { phoneNumberId?: string; statuses?: unknown[] } = {},
): Buffer {
  const value: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '221330000000', phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
    contacts: [{ profile: { name: CONTACT_NAME }, wa_id: SENDER }],
  };
  if (messages.length > 0) value.messages = messages;
  if (opts.statuses) value.statuses = opts.statuses;
  return Buffer.from(
    JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value }] }] }),
    'utf8',
  );
}

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Doubles : base (unicité connecteur + external_id) et file (jobId / dédoublonnage BullMQ).
// ---------------------------------------------------------------------------

type ItemData = Record<string, unknown> & { originMetadata: Record<string, unknown> };

interface StoredItem {
  gedSourceItemId: bigint;
  connectorId: number;
  externalId: string;
  state: number;
  data: Record<string, unknown>;
}

function makePrisma(row: unknown = connectorRow()) {
  const items = new Map<string, StoredItem>();
  let seq = 0n;
  const prisma = {
    items,
    gedSourceConnector: { findUnique: jest.fn(async () => row) },
    gedSourceItem: {
      create: jest.fn(async ({ data }: { data: ItemData }) => {
        const key = `${data.connectorId as number}:${data.externalId as string}`;
        if (items.has(key)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        seq += 1n;
        items.set(key, {
          gedSourceItemId: seq,
          connectorId: data.connectorId as number,
          externalId: data.externalId as string,
          state: data.state as number,
          data,
        });
        return { gedSourceItemId: seq };
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { connectorId_externalId: { connectorId: number; externalId: string } } }) => {
          const k = where.connectorId_externalId;
          const it = items.get(`${k.connectorId}:${k.externalId}`);
          return it ? { gedSourceItemId: it.gedSourceItemId, state: it.state } : null;
        },
      ),
    },
  };
  return prisma;
}

interface AddedJob {
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
}

/** Imite BullMQ : un `jobId` encore présent ou une clé de dédoublonnage non expirée = ajout ignoré. */
function makeQueue() {
  const jobs = new Map<string, AddedJob>();
  const dedup = new Map<string, number>();
  let clock = NOW.getTime();
  const queue = {
    jobs,
    setClock: (ms: number) => {
      clock = ms;
    },
    /** Simule l'exécution et la suppression (`removeOnComplete`) des jobs. */
    completeAll: () => jobs.clear(),
    add: jest.fn(async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      const jobId = opts.jobId as string;
      const d = opts.deduplication as { id: string; ttl: number } | undefined;
      if (d) {
        const until = dedup.get(d.id);
        if (until !== undefined && until > clock) return { id: jobId };
        dedup.set(d.id, clock + d.ttl);
      }
      if (!jobs.has(jobId)) jobs.set(jobId, { name, data, opts });
      return { id: jobId };
    }),
  };
  return queue;
}

const generous = (): WhatsappRateLimiter => ({ take: () => true });

interface Setup {
  row?: unknown;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  ipLimiter?: WhatsappRateLimiter;
  senderLimiter?: WhatsappRateLimiter;
}

function setup(opts: Setup = {}) {
  const prisma = makePrisma(opts.row === undefined ? connectorRow() : opts.row);
  const queue = makeQueue();
  const clock = { now: opts.now ?? NOW };
  const service = new WhatsappWebhookService(
    prisma as never,
    queue as never,
    opts.ipLimiter ?? generous(),
    opts.senderLimiter ?? generous(),
    { env: { ...KEY_ENV, ...opts.env }, now: () => clock.now },
  );
  return { service, prisma, queue, clock };
}

const req = (ip = '203.0.113.7', headers: Record<string, unknown> = {}) => ({
  socket: { remoteAddress: ip },
  headers,
});

function post(
  service: WhatsappWebhookService,
  body: unknown,
  opts: { signature?: unknown; connectorId?: unknown; ip?: string; headers?: Record<string, unknown> } = {},
) {
  return service.receiveNotification({
    connectorId: opts.connectorId ?? '7',
    body,
    signature: 'signature' in opts ? opts.signature : Buffer.isBuffer(body) ? sign(body) : undefined,
    req: req(opts.ip, opts.headers),
  });
}

/** Capture de tout ce qui passe par le Logger de Nest (toutes instances, tous niveaux). */
const logged: unknown[][] = [];
const responses: unknown[] = [];
beforeEach(() => {
  logged.length = 0;
  parseSpy.mockClear();
  configSpy.mockClear();
  signatureSpy.mockClear();
  challengeSpy.mockClear();
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
    loggerSpies.push(
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
  }
});
const loggerSpies: jest.SpyInstance[] = [];
afterEach(() => {
  for (const s of loggerSpies.splice(0)) s.mockRestore();
});

async function expectHttpError(p: Promise<unknown>, type: new (...a: never[]) => HttpException) {
  const err = await p.then(
    () => {
      throw new Error('aucune erreur levée');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(type);
  responses.push((err as HttpException).getResponse());
  return err as HttpException;
}

const FORBIDDEN_IN_OUTPUT = [
  SENDER,
  SENDER_2,
  STRANGER,
  APP_SECRET,
  VERIFY_TOKEN,
  ACCESS_TOKEN,
  'Facture',
  'fdp',
  CAPTION,
  TEXT_BODY,
  CONTACT_NAME,
  'whatsapp_business_account',
  'lookaside',
  'sha256=',
  KEY_ENV.GED_CONNECTOR_KEY,
];

function assertNoLeak(extra: string[] = []): void {
  const dump = JSON.stringify({ logged, responses });
  for (const s of [...FORBIDDEN_IN_OUTPUT, ...extra]) expect(dump).not.toContain(s);
}

// ---------------------------------------------------------------------------

describe('utilitaires', () => {
  it('identifiant de connecteur : entier canonique int4 > 0, sinon 404', () => {
    expect(parseWebhookConnectorId('1')).toBe(1);
    expect(parseWebhookConnectorId('2147483647')).toBe(2147483647);
    for (const bad of ['0', '-1', '01', '1.0', '1e3', '2147483648', '99999999999', ' 1', 'abc', '', undefined, 5, ['1']]) {
      expect(() => parseWebhookConnectorId(bad)).toThrow(NotFoundException);
    }
  });

  it('tranche horaire UTC et identifiants de jobs (sans « : »)', () => {
    expect(utcHourBucket(new Date('2026-11-20T09:59:59Z'))).toBe('2026112009');
    const id = refusalJobId(7, 'abcdef0123456789', new Date('2026-11-20T09:00:00Z'));
    expect(id).toBe('wa-refuse-7-abcdef0123456789-2026112009');
    expect(id).not.toContain(':');
    expect(inboundJobId(42n)).toBe('wa-in-42');
  });

  it('fenêtre anti-rejeu : valeur invalide ignorée', () => {
    expect(replayWindowFromEnv({})).toBe(3600);
    expect(replayWindowFromEnv({ GED_WHATSAPP_REPLAY_WINDOW_SECONDS: '600' })).toBe(600);
    for (const bad of ['abc', '-5', '0', '59', '999999999', '1.5', '']) {
      expect(replayWindowFromEnv({ GED_WHATSAPP_REPLAY_WINDOW_SECONDS: bad })).toBe(3600);
    }
  });
});

describe('GET — vérification de l’abonnement', () => {
  const q = (partial: Record<string, unknown> = {}) => ({
    'hub.mode': 'subscribe',
    'hub.verify_token': VERIFY_TOKEN,
    'hub.challenge': '1158201444',
    ...partial,
  });

  it('challenge valide : renvoie le challenge', async () => {
    const { service } = setup();
    await expect(service.verifySubscription('7', q(), req())).resolves.toBe('1158201444');
    assertNoLeak();
  });

  it('mauvais jeton, mauvais mode, challenge dangereux ou paramètre répété : 403', async () => {
    const { service } = setup();
    await expectHttpError(service.verifySubscription('7', q({ 'hub.verify_token': 'autre-jeton' }), req()), ForbiddenException);
    await expectHttpError(service.verifySubscription('7', q({ 'hub.mode': 'unsubscribe' }), req()), ForbiddenException);
    await expectHttpError(service.verifySubscription('7', q({ 'hub.challenge': '<script>' }), req()), ForbiddenException);
    await expectHttpError(service.verifySubscription('7', q({ 'hub.verify_token': [VERIFY_TOKEN, VERIFY_TOKEN] }), req()), ForbiddenException);
    await expectHttpError(service.verifySubscription('7', {}, req()), ForbiddenException);
    assertNoLeak();
  });

  it('connecteur inconnu, inactif, d’un autre type ou illisible : même 403', async () => {
    const cases = [
      null,
      connectorRow({ isActive: false }),
      connectorRow({ status: 0 }),
      connectorRow({ connectorType: 'imap' }),
      connectorRow({ credentialsKeyId: 'k9' }),
      connectorRow({ credentialsEnc: null }),
    ];
    const bodies: unknown[] = [];
    for (const row of cases) {
      const { service } = setup({ row });
      const err = await expectHttpError(service.verifySubscription('7', q(), req()), ForbiddenException);
      bodies.push(err.getResponse());
    }
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    assertNoLeak();
  });

  it('identifiant non numérique : 404 sans accès base', async () => {
    const { service, prisma } = setup();
    await expectHttpError(service.verifySubscription('7abc', q(), req()), NotFoundException);
    expect(prisma.gedSourceConnector.findUnique).not.toHaveBeenCalled();
  });

  it('limité par IP comme le POST', async () => {
    const { service, prisma } = setup({ ipLimiter: { take: () => false } });
    const err = await expectHttpError(service.verifySubscription('7', q(), req()), HttpException);
    expect(err.getStatus()).toBe(429);
    expect(prisma.gedSourceConnector.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST — authentification avant tout traitement', () => {
  it('signature valide : document accepté, élément créé, job enfilé', async () => {
    const { service, prisma, queue } = setup();
    const msg = docMessage();
    const body = notification([msg]);

    await expect(post(service, body)).resolves.toEqual({ received: true });

    // Chargement MINIMAL du connecteur.
    expect(prisma.gedSourceConnector.findUnique).toHaveBeenCalledWith({
      where: { gedSourceConnectorId: 7 },
      select: {
        connectorType: true,
        status: true,
        isActive: true,
        credentialsEnc: true,
        credentialsKeyId: true,
        credentialsRef: true,
        config: true,
      },
    });

    expect(prisma.gedSourceItem.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.gedSourceItem.create.mock.calls[0]![0];
    const senderHash = hashPhone(SENDER, APP_SECRET);
    expect(data).toEqual({
      connectorId: 7,
      externalId: msg.id,
      name: 'Facture Mars fdp.exe',
      mimeType: 'application/pdf',
      originAuthor: senderHash,
      originCreatedAt: new Date((NOW_S - 30) * 1000),
      originMetadata: {
        messageType: 'document',
        mediaId: '987654321012345',
        mimeType: 'application/pdf',
        // Brut (le worker le ré-assainit), seuls contrôles et demi-substituts retirés.
        declaredFilename: DOC_FILENAME,
        declaredSha256: 'ab'.repeat(32),
        senderPhone: SENDER,
        senderHash,
        messageTimestamp: NOW_S - 30,
        receivedAt: NOW.toISOString(),
      },
      state: GedSourceItemState.Decouvert,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    });
    expect(data.originAuthor).not.toContain(SENDER);
    expect('originAcl' in data).toBe(false);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      GED_WHATSAPP_JOB.inbound,
      { connectorId: 7, itemId: '1' },
      {
        jobId: 'wa-in-1',
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    );
    assertNoLeak();
  });

  it('image sans nom : nom généré, pas de nom déclaré', async () => {
    const { service, prisma } = setup();
    await post(service, notification([imageMessage()]));
    const { data } = prisma.gedSourceItem.create.mock.calls[0]![0];
    expect(data.name).toMatch(/^photo-20261120-\d{6}\.jpg$/);
    expect(data.originMetadata.declaredFilename).toBeUndefined();
    expect(data.originMetadata.messageType).toBe('image');
  });

  it('nom déclaré nettoyé des caractères refusés par PostgreSQL (NUL, demi-substituts)', async () => {
    const { service, prisma } = setup();
    const msg = docMessage();
    (msg.document as Record<string, unknown>).filename = 'rap\u0000port\ud800.pdf';
    await post(service, notification([msg]));
    const { data } = prisma.gedSourceItem.create.mock.calls[0]![0];
    expect(data.originMetadata.declaredFilename).toBe('rapport.pdf');
    expect(data.name).toBe('rapport.pdf');
  });

  const noSideEffects = (prisma: ReturnType<typeof makePrisma>, queue: ReturnType<typeof makeQueue>) => {
    expect(parseSpy).not.toHaveBeenCalled();
    expect(configSpy).not.toHaveBeenCalled();
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(prisma.gedSourceItem.findUnique).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  };

  it('signature invalide, absente, mal formée ou dupliquée : 401 sans parse, écriture ni file', async () => {
    const body = notification([docMessage()]);
    const variants: unknown[] = [
      sign(body, 'autre-secret-factice-000000'),
      undefined,
      '',
      'sha256=',
      sign(body).toUpperCase(),
      sign(body).replace('sha256=', 'sha1='),
      [sign(body), sign(body)],
      `${sign(body)}, ${sign(body)}`,
    ];
    for (const signature of variants) {
      const { service, prisma, queue } = setup();
      await expectHttpError(post(service, body, { signature }), UnauthorizedException);
      noSideEffects(prisma, queue);
    }
    assertNoLeak();
  });

  it('corps modifié d’un octet après signature : 401', async () => {
    const body = notification([docMessage()]);
    const signature = sign(body);
    const tampered = Buffer.from(body);
    tampered[tampered.length - 3] ^= 0x01;
    const { service, prisma, queue } = setup();
    await expectHttpError(post(service, tampered, { signature }), UnauthorizedException);
    noSideEffects(prisma, queue);
  });

  it('corps ré-sérialisé (mêmes données, autres octets) : 401', async () => {
    const pretty = Buffer.from(JSON.stringify(JSON.parse(notification([docMessage()]).toString()), null, 2));
    const compact = Buffer.from(JSON.stringify(JSON.parse(pretty.toString())));
    const { service, prisma, queue } = setup();
    await expectHttpError(post(service, compact, { signature: sign(pretty) }), UnauthorizedException);
    noSideEffects(prisma, queue);
  });

  it('connecteur inconnu, inactif, d’un autre type, secret illisible ou absent : 401 IDENTIQUE à une signature fausse', async () => {
    const body = notification([docMessage()]);
    const reference = await (async () => {
      const { service } = setup();
      return (await expectHttpError(post(service, body, { signature: sign(body, 'x'.repeat(20)) }), UnauthorizedException)).getResponse();
    })();
    const rows = [
      null,
      connectorRow({ isActive: false }),
      connectorRow({ status: 0 }),
      connectorRow({ connectorType: 'imap' }),
      connectorRow({ credentialsKeyId: 'k9' }),
      connectorRow({ credentialsEnc: 'AAAA' }),
      connectorRow({ credentialsEnc: null }),
      connectorRow({ credentialsEnc: null, credentialsKeyId: null, credentialsRef: 'GED_CONNECTOR_SECRET_ABSENT' }),
      connectorRow({ credentialsEnc: null, credentialsKeyId: null, credentialsRef: 'JWT_SECRET' }),
    ];
    for (const row of rows) {
      const { service, prisma, queue } = setup({ row });
      // Même avec une signature calculée avec le BON secret : rien ne doit distinguer les cas.
      const err = await expectHttpError(post(service, body), UnauthorizedException);
      expect(err.getStatus()).toBe(401);
      expect(err.getResponse()).toEqual(reference);
      noSideEffects(prisma, queue);
    }
    assertNoLeak();
  });

  it('le HMAC et la comparaison du jeton sont calculés même en échec (secret leurre, temps homogène)', async () => {
    const body = notification([docMessage()]);
    for (const row of [null, connectorRow({ isActive: false }), connectorRow({ credentialsEnc: null })]) {
      const { service } = setup({ row });
      signatureSpy.mockClear();
      challengeSpy.mockClear();
      await expectHttpError(post(service, body), UnauthorizedException);
      expect(signatureSpy).toHaveBeenCalledTimes(1);
      const [raw, header, secret] = signatureSpy.mock.calls[0]!;
      expect(raw).toBe(body);
      expect(header).toBe(sign(body));
      expect(typeof secret).toBe('string');
      expect((secret as string).length).toBe(64);
      expect(secret).not.toBe(APP_SECRET);
      await expectHttpError(
        service.verifySubscription('7', { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' }, req()),
        ForbiddenException,
      );
      expect(challengeSpy).toHaveBeenCalledTimes(1);
      expect(challengeSpy.mock.calls[0]![1]).not.toBe(VERIFY_TOKEN);
    }
  });

  it('signature vérifiée sur le Buffer reçu, avec le secret déchiffré', async () => {
    const { service } = setup();
    const body = notification([docMessage()]);
    await post(service, body);
    expect(signatureSpy).toHaveBeenCalledWith(body, sign(body), APP_SECRET);
    expect(signatureSpy.mock.invocationCallOrder[0]!).toBeLessThan(parseSpy.mock.invocationCallOrder[0]!);
  });

  it('identifiants par référence d’environnement (credentials_ref)', async () => {
    const { service, prisma } = setup({
      row: connectorRow({ credentialsEnc: null, credentialsKeyId: null, credentialsRef: 'GED_CONNECTOR_SECRET_WA' }),
      env: { GED_CONNECTOR_SECRET_WA: JSON.stringify(CREDENTIALS) },
    });
    await expect(post(service, notification([docMessage()]))).resolves.toEqual({ received: true });
    expect(prisma.gedSourceItem.create).toHaveBeenCalledTimes(1);
  });

  it('corps vide, non Buffer (déjà analysé) ou trop gros : 400 / 413 sans accès base', async () => {
    const { service, prisma, queue } = setup();
    await expectHttpError(post(service, Buffer.alloc(0), { signature: sign(Buffer.alloc(0)) }), BadRequestException);
    await expectHttpError(post(service, { object: 'whatsapp_business_account' }, { signature: 'sha256=00' }), BadRequestException);
    await expectHttpError(post(service, undefined, { signature: undefined }), BadRequestException);
    const big = Buffer.alloc(WHATSAPP_MAX_BODY_BYTES + 1, 0x20);
    await expectHttpError(post(service, big), PayloadTooLargeException);
    expect(prisma.gedSourceConnector.findUnique).not.toHaveBeenCalled();
    noSideEffects(prisma, queue);
  });

  it('identifiant de connecteur invalide : 404 sans accès base', async () => {
    const { service, prisma } = setup();
    await expectHttpError(post(service, notification([docMessage()]), { connectorId: '2147483648' }), NotFoundException);
    await expectHttpError(post(service, notification([docMessage()]), { connectorId: '../1' }), NotFoundException);
    expect(prisma.gedSourceConnector.findUnique).not.toHaveBeenCalled();
  });

  it('base indisponible au chargement : 500 générique, message d’erreur non journalisé', async () => {
    const { service, prisma } = setup();
    prisma.gedSourceConnector.findUnique.mockRejectedValueOnce(
      Object.assign(new Error(`Can't reach database server at db.interne:5432 ${SENDER}`), { code: 'P1001' }),
    );
    await expectHttpError(post(service, notification([docMessage()])), InternalServerErrorException);
    assertNoLeak(['db.interne']);
    expect(JSON.stringify(logged)).toContain('P1001');
  });
});

describe('POST — après signature valide', () => {
  it('corps signé mais JSON invalide : 400, rien d’écrit', async () => {
    const { service, prisma, queue } = setup();
    const body = Buffer.from('{"object":"whatsapp_business_account","entry":[', 'utf8');
    await expectHttpError(post(service, body), BadRequestException);
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('configuration enregistrée invalide : 500 générique (Meta ré-essaiera)', async () => {
    const { service, prisma } = setup({ row: connectorRow({ config: { phoneNumberId: 'abc' } }) });
    await expectHttpError(post(service, notification([docMessage()])), InternalServerErrorException);
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('rejeu du même message : un seul élément, un seul job', async () => {
    const { service, prisma, queue } = setup();
    const body = notification([docMessage()]);
    await post(service, body);
    // Traitement terminé par le worker : l'élément n'est plus « Découvert ».
    for (const it of prisma.items.values()) it.state = GedSourceItemState.Copie;
    queue.completeAll();
    await expect(post(service, body)).resolves.toEqual({ received: true });
    expect(prisma.items.size).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged)).toContain('decision=replay action=ignored');
  });

  it('rejeu alors que l’élément est encore « Découvert » : ré-enfilé avec le même jobId', async () => {
    const { service, prisma, queue } = setup();
    const body = notification([docMessage()]);
    await post(service, body);
    await post(service, body);
    expect(prisma.items.size).toBe(1);
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[1]![2].jobId).toBe('wa-in-1');
    expect(queue.jobs.size).toBe(1);
  });

  it('Redis indisponible après création de l’élément : 500, puis ré-enfilé à la livraison suivante', async () => {
    const { service, prisma, queue } = setup();
    const body = notification([docMessage()]);
    queue.add.mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED redis:6379 ${SENDER}`), { code: 'ECONNREFUSED' }));
    await expectHttpError(post(service, body), InternalServerErrorException);
    expect(prisma.items.size).toBe(1);
    await expect(post(service, body)).resolves.toEqual({ received: true });
    expect(queue.jobs.has('wa-in-1')).toBe(true);
    assertNoLeak(['redis:6379']);
  });

  it('base indisponible à l’écriture : 500 générique', async () => {
    const { service, prisma } = setup();
    prisma.gedSourceItem.create.mockRejectedValueOnce(new Error(`Invalid prisma.gedSourceItem.create() ${SENDER}`));
    await expectHttpError(post(service, notification([docMessage()])), InternalServerErrorException);
    assertNoLeak(['Invalid prisma']);
  });

  it('message hors fenêtre temporelle : ignoré (compté), 200', async () => {
    const { service, prisma, queue } = setup();
    const old = docMessage({ timestamp: String(NOW_S - 2 * 3600) });
    const future = docMessage({ timestamp: String(NOW_S + 3600) });
    await expect(post(service, notification([old, future]))).resolves.toEqual({ received: true });
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).toContain('stale=2');
  });

  it('fenêtre réglable par GED_WHATSAPP_REPLAY_WINDOW_SECONDS, valeur invalide ignorée', async () => {
    const halfHour = () => notification([docMessage({ timestamp: String(NOW_S - 1800) })]);
    const short = setup({ env: { GED_WHATSAPP_REPLAY_WINDOW_SECONDS: '600' } });
    await post(short.service, halfHour());
    expect(short.prisma.gedSourceItem.create).not.toHaveBeenCalled();

    const invalid = setup({ env: { GED_WHATSAPP_REPLAY_WINDOW_SECONDS: 'beaucoup' } });
    await post(invalid.service, halfHour());
    expect(invalid.prisma.gedSourceItem.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged)).toContain('GED_WHATSAPP_REPLAY_WINDOW_SECONDS ignorée');
    expect(JSON.stringify(logged)).not.toContain('beaucoup');
  });

  it('autre phone_number_id : ignoré', async () => {
    const { service, prisma, queue } = setup();
    await expect(post(service, notification([docMessage()], { phoneNumberId: '999999999999' }))).resolves.toEqual({ received: true });
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).toContain('wrong_number=1');
  });

  it('statuts Meta seuls : ignorés, 200', async () => {
    const { service, prisma, queue } = setup();
    const statuses = [{ id: 'wamid.X', status: 'delivered', timestamp: String(NOW_S), recipient_id: SENDER }];
    await expect(post(service, notification([], { statuses }))).resolves.toEqual({ received: true });
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).toContain('statuses=1');
    assertNoLeak();
  });

  it('expéditeur non autorisé, refus désactivé : rien créé, rien enfilé', async () => {
    const { service, prisma, queue } = setup();
    await post(service, notification([docMessage({ from: STRANGER })]));
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(JSON.stringify(logged)).toContain('decision=refused_unknown_sender reply=none');
    expect(JSON.stringify(logged)).toContain(hashPhone(STRANGER, APP_SECRET));
    assertNoLeak();
  });

  it('expéditeur non autorisé, refus activé : UN job de refus par heure et par expéditeur', async () => {
    const { service, prisma, queue, clock } = setup({ row: connectorRow({ config: config({ refuseUnknownSenders: true }) }) });
    // Deux messages dans le même corps, puis un autre corps dans la même heure.
    await post(service, notification([docMessage({ from: STRANGER }), textMessage({ from: STRANGER })]));
    queue.completeAll(); // le job est supprimé après exécution : le jobId seul ne suffirait plus
    clock.now = new Date('2026-11-20T12:59:00Z');
    queue.setClock(clock.now.getTime());
    await post(service, notification([docMessage({ from: STRANGER, timestamp: String(Math.floor(clock.now.getTime() / 1000) - 5) })]));
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    const refusals = queue.add.mock.calls.filter((c) => c[0] === GED_WHATSAPP_JOB.refuse);
    expect(refusals).toHaveLength(2); // 1 appel par requête ; le second est dédoublonné
    const senderHash = hashPhone(STRANGER, APP_SECRET);
    for (const c of refusals) {
      expect(c[1]).toEqual({ connectorId: 7, to: STRANGER, reason: 'unknown_sender' });
      expect(c[2]).toMatchObject({
        jobId: `wa-refuse-7-${senderHash}-2026112012`,
        deduplication: { id: `wa-refuse-7-${senderHash}-2026112012` },
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
    expect((refusals[0]![2].deduplication as { ttl: number }).ttl).toBe((25 * 60 + 4) * 1000);
    expect(queue.jobs.size).toBe(0);

    // Heure suivante : un nouveau refus est permis.
    clock.now = new Date('2026-11-20T13:00:30Z');
    queue.setClock(clock.now.getTime());
    await post(service, notification([docMessage({ from: STRANGER, timestamp: String(Math.floor(clock.now.getTime() / 1000) - 5) })]));
    expect([...queue.jobs.keys()]).toEqual([`wa-refuse-7-${senderHash}-2026112013`]);
    assertNoLeak();
  });

  it('expéditeur autorisé, type non pris en charge : refus unsupported_type, contenu jamais lu', async () => {
    const { service, prisma, queue } = setup();
    await post(service, notification([textMessage(), textMessage()]));
    expect(prisma.gedSourceItem.create).not.toHaveBeenCalled();
    const refusals = queue.add.mock.calls.filter((c) => c[0] === GED_WHATSAPP_JOB.refuse);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]![1]).toEqual({ connectorId: 7, to: SENDER, reason: 'unsupported_type' });
    expect(refusals[0]![2].jobId).toBe(`wa-refuse-7-${hashPhone(SENDER, APP_SECRET)}-2026112012`);
    assertNoLeak();
  });

  it('plusieurs messages : traités dans l’ordre, compteurs exacts', async () => {
    const { service, prisma, queue } = setup();
    await post(service, notification([docMessage(), imageMessage({ from: SENDER_2 }), docMessage({ from: STRANGER })]));
    expect(prisma.items.size).toBe(2);
    expect([...queue.jobs.keys()]).toEqual(['wa-in-1', 'wa-in-2']);
    expect(JSON.stringify(logged)).toMatch(/messages=3 accepted=2 .*unknown_sender=1/);
  });
});

describe('limites de débit', () => {
  it('par IP : 429 au-delà, avant tout accès base', async () => {
    let t = NOW.getTime();
    const ipLimiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    const { service, prisma } = setup({ ipLimiter });
    const body = notification([docMessage()]);
    await post(service, body);
    await post(service, body);
    const calls = prisma.gedSourceConnector.findUnique.mock.calls.length;
    const err = await expectHttpError(post(service, body), HttpException);
    expect(err.getStatus()).toBe(429);
    expect(prisma.gedSourceConnector.findUnique.mock.calls.length).toBe(calls);
    // Une autre IP n'est pas concernée ; la fenêtre glisse.
    await expect(post(service, body, { ip: '198.51.100.9' })).resolves.toEqual({ received: true });
    t += 61_000;
    await expect(post(service, body)).resolves.toEqual({ received: true });
    assertNoLeak(['203.0.113.7', '198.51.100.9']);
  });

  it('X-Forwarded-For ignoré par défaut, pris en compte avec GED_WHATSAPP_TRUST_PROXY=1', async () => {
    const keys: string[] = [];
    const ipLimiter = { take: (k: string) => (keys.push(k), true) };
    const xff = { 'x-forwarded-for': '192.0.2.44' };
    const off = setup({ ipLimiter });
    await post(off.service, notification([docMessage()]), { headers: xff });
    const on = setup({ ipLimiter, env: { GED_WHATSAPP_TRUST_PROXY: '1' } });
    await post(on.service, notification([docMessage()]), { headers: xff });
    expect(keys).toEqual(['ip:203.0.113.7', 'ip:192.0.2.44']);
  });

  it('par expéditeur : messages au-delà ignorés et comptés, autres expéditeurs non concernés', async () => {
    const senderLimiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 600_000, now: () => NOW.getTime() });
    const { service, prisma } = setup({ senderLimiter });
    await post(service, notification([docMessage(), docMessage(), imageMessage({ from: SENDER_2 })]));
    expect(prisma.items.size).toBe(2);
    const dump = JSON.stringify(logged);
    expect(dump).toContain('decision=rate_limited scope=sender');
    expect(dump).toContain('rate_limited=1');
    assertNoLeak();
  });
});

describe('aucune donnée personnelle ni secret dans les sorties', () => {
  it('réponses d’erreur accumulées : génériques (statut + libellé standard), sans donnée', () => {
    // `logged` est vidé à chaque test (vérifié test par test) ; les réponses sont cumulées.
    expect(responses.length).toBeGreaterThan(20);
    const dump = JSON.stringify(responses);
    for (const s of FORBIDDEN_IN_OUTPUT) expect(dump).not.toContain(s);
    const generic = new Set([
      'Bad Request',
      'Unauthorized',
      'Forbidden',
      'Not Found',
      'Payload Too Large',
      'Too Many Requests',
      'Internal Server Error',
    ]);
    for (const r of responses) {
      const message = typeof r === 'string' ? r : (r as { message?: unknown }).message;
      expect(generic.has(message as string)).toBe(true);
      if (typeof r === 'object' && r !== null) expect(Object.keys(r).sort()).toEqual(['message', 'statusCode']);
    }
  });
});
