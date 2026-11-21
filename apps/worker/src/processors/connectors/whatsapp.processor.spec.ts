// Lot 2c — consommateur WhatsApp : base en mémoire, transport Graph simulé, aucune socket.
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  buildAckMessage,
  buildRefusalMessage,
  buildRejectedMessage,
  hashPhone,
  type WhatsappHttp,
  type WhatsappHttpRequest,
  type WhatsappHttpResponse,
} from '@archivage/connectors';
import { GedAiMode } from '@archivage/types';

jest.mock('../../db', () => ({ prisma: {} }));
jest.mock('../seal-document', () => ({ sealFreshDocument: jest.fn() }));

import {
  createWhatsappProcessor,
  runWhatsappInbound,
  runWhatsappRefuse,
  type WhatsappProcessorDeps,
} from './whatsapp.processor';
import { createMemoryRateLimiter, createRedisRateLimiter } from './whatsapp-rate-limit';

const NOW = new Date('2026-11-20T12:00:00Z');
const TOKEN = 'EAAGtestTOKEN0123456789abcdefSECRET';
const APP_SECRET = 'appsecret-0123456789abcdef';
const VERIFY = 'verify-token-xyz-987';
const PHONE = '33612345678';
const OTHER_PHONE = '221771234567';
const SENDER_HASH = hashPhone(PHONE, APP_SECRET);
const PHONE_ID = '109876543210';
const SIGNED_URL =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=987654321&ext=1732000000&hash=ATsignedHASHvalue42';
const RAW_FILENAME = 'Contrat Dupont confidentiel.pdf';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let PDF: Buffer;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF-photo-data')]);

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage();
  PDF = Buffer.from(await doc.save());
});

// ---------------------------------------------------------------------------
// Transport Graph simulé
// ---------------------------------------------------------------------------

interface GraphScenario {
  bytes?: Buffer;
  mime?: string;
  /** `'auto'` = empreinte réelle du contenu. */
  sha256?: string | 'auto' | null;
  mediaUrl?: string;
  fileSize?: number;
  /** Un contenu différent à chaque téléchargement (texte). */
  uniqueContent?: boolean;
  /** Réponse du premier GET média : redirection vers cette adresse. */
  redirectTo?: string;
  /** Statut/erreur renvoyés par l'appel de métadonnées. */
  infoStatus?: number;
  infoBody?: unknown;
  sendFails?: boolean;
}

const json = (status: number, body: unknown): WhatsappHttpResponse => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

function fakeGraph(s: GraphScenario = {}) {
  const calls: WhatsappHttpRequest[] = [];
  const sends: Array<{ to: string; body: string }> = [];
  const bytes = s.bytes ?? PDF;
  let mediaReads = 0;
  const http: WhatsappHttp = {
    async request(req) {
      calls.push(req);
      const url = new URL(req.url);
      if (req.method === 'POST') {
        if (s.sendFails) throw new Error(`panne réseau ${TOKEN} vers ${req.url}`);
        const payload = JSON.parse(req.body ?? '{}');
        sends.push({ to: payload.to, body: payload.text.body });
        return json(200, { messages: [{ id: 'wamid.out' }] });
      }
      if (url.hostname === 'graph.facebook.com') {
        if (s.infoStatus) return json(s.infoStatus, s.infoBody ?? { error: { message: `mauvais jeton ${TOKEN}`, code: 1 } });
        const id = url.pathname.split('/').pop()!;
        return json(200, {
          id,
          url: s.mediaUrl ?? SIGNED_URL,
          mime_type: s.mime ?? 'application/pdf',
          ...(s.sha256 === null || s.uniqueContent ? {} : { sha256: s.sha256 === undefined || s.sha256 === 'auto' ? sha(bytes) : s.sha256 }),
          file_size: s.fileSize ?? bytes.length,
        });
      }
      if (s.redirectTo) {
        return { status: 302, headers: { location: s.redirectTo }, body: Buffer.alloc(0) };
      }
      mediaReads++;
      return { status: 200, headers: {}, body: s.uniqueContent ? Buffer.from(`contenu ${mediaReads}`) : bytes };
    },
  };
  return { http, calls, sends, hosts: () => calls.map((c) => new URL(c.url).hostname) };
}

// ---------------------------------------------------------------------------
// Base en mémoire
// ---------------------------------------------------------------------------

interface WorldOptions {
  config?: Record<string, unknown>;
  connector?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

const baseConfig = (extra: Record<string, unknown> = {}) => ({
  phoneNumberId: PHONE_ID,
  senders: [{ phone: PHONE, label: 'Marie' }],
  maxFileBytes: 100_000,
  rights: { principalMap: { [`wa:${PHONE}`]: 11 }, fallbackUserGroupIds: [] },
  ...extra,
});

function metadata(over: Record<string, unknown> = {}) {
  return {
    messageType: 'document',
    mediaId: '987654321',
    mimeType: 'application/pdf',
    declaredFilename: RAW_FILENAME,
    senderPhone: PHONE,
    senderHash: SENDER_HASH,
    messageTimestamp: 1_790_000_000,
    receivedAt: '2026-11-20T11:59:00.000Z',
    ...over,
  };
}

function makeWorld(opts: WorldOptions = {}) {
  const connector: Record<string, any> = {
    gedSourceConnectorId: 1,
    label: 'WhatsApp',
    connectorType: 'whatsapp',
    mode: 1,
    status: 1,
    config: baseConfig(),
    credentialsEnc: null,
    credentialsKeyId: null,
    credentialsRef: 'GED_CONNECTOR_SECRET_WA',
    changeToken: null,
    targetDossierId: 7,
    isActive: true,
    lastError: null,
    ...opts.connector,
  };
  if (opts.config) connector.config = opts.config;
  const items = new Map<bigint, Record<string, any>>();
  const docs: Array<Record<string, any>> = [];
  const addItem = (id: bigint, over: Record<string, any> = {}) => {
    items.set(id, {
      gedSourceItemId: id,
      connectorId: 1,
      externalId: `wamid.${id}`,
      state: 0,
      documentId: null,
      contentHash: null,
      originMetadata: metadata(),
      firstSeenAt: new Date(NOW.getTime() + Number(id)),
      ...over,
    });
  };
  addItem(1n);

  const prisma = {
    gedSourceConnector: {
      findUnique: jest.fn(async () => connector),
      update: jest.fn(async ({ data }: any) => Object.assign(connector, data)),
    },
    gedSourceItem: {
      findUnique: jest.fn(async ({ where }: any) => items.get(where.gedSourceItemId) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(items.get(where.gedSourceItemId)!, data)),
      findFirst: jest.fn(async ({ where }: any) =>
        [...items.values()]
          .filter(
            (i) =>
              i.contentHash === where.contentHash &&
              i.gedSourceItemId !== where.gedSourceItemId.not &&
              where.state.in.includes(i.state),
          )
          .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
          .map((i) => ({ gedSourceItemId: i.gedSourceItemId }))[0] ?? null,
      ),
    },
    gedAiSetting: { findFirst: jest.fn().mockResolvedValue(null) },
    fileType: { upsert: jest.fn().mockResolvedValue({ fileTypeId: 9 }) },
    document: {
      create: jest.fn(async ({ data }: any) => {
        docs.push(data);
        const documentId = 100 + docs.length;
        // Création imbriquée : le document naît rattaché à l'élément (comme en base).
        const itemId = data.gedSourceItems?.connect?.gedSourceItemId;
        if (itemId !== undefined) items.get(itemId)!.documentId = documentId;
        return {
          documentId,
          versions: [{ documentVersionId: 200 + docs.length, files: [{ fileId: 300 + docs.length }] }],
        };
      }),
      delete: jest.fn().mockResolvedValue({}),
    },
    documentVersion: {},
    $transaction: jest.fn(),
  };

  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const fileStore = { write: jest.fn().mockResolvedValue('/coffre/x') };
  const graph = fakeGraph();
  const env: NodeJS.ProcessEnv = {
    GED_CONNECTOR_SECRET_WA: JSON.stringify({ accessToken: TOKEN, appSecret: APP_SECRET, verifyToken: VERIFY }),
    JWT_SECRET: 'jwt-ne-doit-pas-fuiter',
    ...opts.env,
  };
  const deps: WhatsappProcessorDeps = {
    prisma: prisma as never,
    fileStore,
    archivesPath: '/coffre',
    aiQueue: null,
    env,
    http: graph.http,
    now: () => NOW,
    log,
  };
  return { connector, items, docs, addItem, prisma, log, fileStore, deps, graph, env };
}

type World = ReturnType<typeof makeWorld>;

/** Branche un scénario de transport sur un monde déjà construit. */
function useGraph(w: World, scenario: GraphScenario) {
  const graph = fakeGraph(scenario);
  w.deps.http = graph.http;
  return graph;
}

const job = (itemId: bigint | string = 1n) => ({ connectorId: 1, itemId: String(itemId) });
const item = (w: World, id: bigint = 1n) => w.items.get(id)!;

/** Rien de secret ni de personnel dans les journaux, les erreurs stockées et les messages sortants. */
function expectClean(w: World, graph?: { sends: Array<{ body: string }> }) {
  const logs = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls]);
  const stored = JSON.stringify(
    [...w.items.values()].map((i) => i.errorMessage).concat([w.connector.lastError]),
  );
  const sent = JSON.stringify((graph?.sends ?? []).map((m) => m.body));
  for (const forbidden of [
    TOKEN,
    APP_SECRET,
    VERIFY,
    PHONE,
    OTHER_PHONE,
    'ATsignedHASHvalue42',
    'lookaside.fbsbx.com',
    'Dupont',
    RAW_FILENAME,
    'jwt-ne-doit-pas-fuiter',
  ]) {
    expect(logs).not.toContain(forbidden);
    expect(stored).not.toContain(forbidden);
    expect(sent).not.toContain(forbidden);
  }
}

// ---------------------------------------------------------------------------

describe('runWhatsappInbound : ingestion', () => {
  it('PDF nominal : un seul document, Consultation sur le groupe mappé, état Copie, accusé WA-<id>', async () => {
    const w = makeWorld();
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);

    expect(res).toMatchObject({ outcome: 'copied', documentId: 101, ackSent: true });
    expect(w.docs).toHaveLength(1);
    const data = w.docs[0]!;
    expect(data.dossierId).toBe(7);
    expect(data.createdBy).toBeNull();
    expect(data.gedSourceItems.connect.gedSourceItemId).toBe(1n);
    expect(data.permissions.create).toEqual([{ userGroupId: 11, permissionLevelId: 2, grantedBy: 11 }]);
    expect(data.versions.create.files.create).toMatchObject({
      originalName: 'Contrat Dupont confidentiel.pdf',
      fileExtension: '.pdf',
      hash: sha(PDF),
    });
    expect(w.fileStore.write).toHaveBeenCalledTimes(1);

    expect(item(w)).toMatchObject({
      state: 1,
      documentId: 101,
      contentHash: sha(PDF),
      remoteVersion: sha(PDF),
      byteLength: BigInt(PDF.length),
      mimeType: 'application/pdf',
      errorMessage: null,
    });
    // Confidentialité : le numéro n'est dans aucun champ visible par l'API (seul originMetadata).
    const it1 = item(w);
    expect(it1.originAcl).toBeDefined();
    expect(JSON.stringify(it1.originAcl ?? null)).not.toContain(PHONE);
    for (const f of ['originAcl', 'originAuthor', 'originPath', 'name', 'errorMessage']) {
      expect(JSON.stringify(it1[f] ?? null)).not.toContain(PHONE);
    }
    expect(JSON.stringify(it1.originMetadata)).toContain(PHONE);
    expect(graph.sends).toEqual([{ to: PHONE, body: buildAckMessage('WA-1') }]);
    expect(graph.sends[0]!.body).toBe('Document reçu. Référence : WA-1. Merci.');
    expectClean(w, graph);
  });

  it('photo image/jpeg sans nom : nom généré (photo-AAAAMMJJ-HHMMSS.jpg)', async () => {
    const w = makeWorld();
    w.addItem(1n, {
      originMetadata: metadata({ messageType: 'image', mimeType: 'image/jpeg', declaredFilename: undefined }),
    });
    useGraph(w, { bytes: JPEG, mime: 'image/jpeg' });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'copied' });
    expect(w.docs[0]!.versions.create.files.create).toMatchObject({
      originalName: 'photo-20261120-120000.jpg',
      fileExtension: '.jpg',
    });
    expect(item(w).mimeType).toBe('image/jpeg');
  });

  it('expéditeur sans entrée « wa: » : groupes de repli', async () => {
    const w = makeWorld({
      config: baseConfig({ rights: { principalMap: {}, fallbackUserGroupIds: [21, 22] } }),
    });
    useGraph(w, {});
    await runWhatsappInbound(job(), w.deps);
    expect(w.docs[0]!.permissions.create.map((p: any) => p.userGroupId).sort()).toEqual([21, 22]);
  });

  it('ni mapping ni groupe de repli : En erreur, aucun document', async () => {
    const w = makeWorld({ config: baseConfig({ rights: { principalMap: {}, fallbackUserGroupIds: [] } }) });
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'no_grant' });
    expect(w.docs).toHaveLength(0);
    expect(w.fileStore.write).not.toHaveBeenCalled();
    expect(graph.calls).toHaveLength(0); // droits évalués avant tout appel Graph / téléchargement
    expect(item(w).state).toBe(5);
    expect(item(w).errorMessage).toMatch(/document non créé/);
    expect(graph.sends).toHaveLength(0);
    expectClean(w, graph);
  });

  it('expéditeur retiré de la liste blanche avant le traitement : rien téléchargé, rien ingéré, aucun accusé', async () => {
    const w = makeWorld({ config: baseConfig({ senders: [{ phone: OTHER_PHONE }] }) });
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'unauthorized' });
    expect(graph.calls).toHaveLength(0);
    expect(w.docs).toHaveLength(0);
    expect(item(w).state).toBe(5);
    expect(item(w).errorMessage).toBe('expéditeur non autorisé : document non créé');
    expectClean(w, graph);
  });

  it('IA activée : pipeline enfilé ; échec de la file IA sans effet sur l’ingestion', async () => {
    const w = makeWorld();
    w.prisma.gedAiSetting.findFirst.mockResolvedValue({
      mode: GedAiMode.Locale,
      provider: null,
      model: 'm',
      endpoint: 'http://localhost:11434/v1',
      apiKeyRef: null,
      maskingEnabled: true,
      autoApplyThreshold: null,
      timeoutSeconds: 60,
    });
    const add = jest.fn().mockResolvedValue(undefined);
    w.deps.aiQueue = { add };
    useGraph(w, {});
    await runWhatsappInbound(job(), w.deps);
    expect(add).toHaveBeenCalledWith(
      'pipeline',
      { documentId: 101, sourceItemId: 1, requestedBy: null },
      expect.anything(),
    );

    const w2 = makeWorld();
    w2.prisma.gedAiSetting.findFirst.mockRejectedValue(new Error('base IA indisponible'));
    w2.deps.aiQueue = { add };
    useGraph(w2, {});
    const res = await runWhatsappInbound(job(), w2.deps);
    expect(res).toMatchObject({ outcome: 'copied', ackSent: true });
    expect(item(w2).state).toBe(1);
    expect(w2.log.warn).toHaveBeenCalledWith(expect.anything(), 'enfilage du pipeline IA impossible');
  });
});

describe('runWhatsappInbound : refus du contenu', () => {
  it('hôte média non officiel renvoyé par Graph : refus, rien téléchargé, message de rejet', async () => {
    const w = makeWorld();
    const graph = useGraph(w, { mediaUrl: 'https://evil.example.com/steal?x=1' });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'rejected', ackSent: true });
    expect(graph.hosts()).toEqual(['graph.facebook.com', 'graph.facebook.com']); // métadonnées + rejet
    expect(graph.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(w.docs).toHaveLength(0);
    expect(item(w).state).toBe(5);
    expect(graph.sends).toEqual([{ to: PHONE, body: buildRejectedMessage() }]);
    expectClean(w, graph);
  });

  it('redirection vers un hôte non officiel : refusée, le jeton n’y part jamais', async () => {
    const w = makeWorld();
    const graph = useGraph(w, { redirectTo: 'https://evil.example.com/pdf' });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'rejected' });
    expect(graph.hosts()).not.toContain('evil.example.com');
    expect(w.docs).toHaveLength(0);
    expect(item(w).state).toBe(5);
    expectClean(w, graph);
  });

  it('taille annoncée trop grande : refus sans téléchargement', async () => {
    const w = makeWorld();
    const graph = useGraph(w, { fileSize: 5_000_000 });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'rejected' });
    expect(graph.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(w.docs).toHaveLength(0);
  });

  it.each(['page.html', 'PAGE.HTM'])('extension %s refusée (contenu actif) : En erreur, aucun document', async (name) => {
    const w = makeWorld();
    w.addItem(1n, { originMetadata: metadata({ declaredFilename: name, mimeType: 'text/html' }) });
    useGraph(w, { bytes: Buffer.from('<html><script>alert(1)</script></html>'), mime: 'text/html' });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'rejected' });
    expect(w.docs).toHaveLength(0);
    expect(item(w).state).toBe(5);
    expect(item(w).errorMessage).toMatch(/non pris en charge/);
    expect(item(w).errorMessage).not.toMatch(/html|htm/i);
  });

  it('un .pdf passe toujours', async () => {
    const w = makeWorld();
    useGraph(w, {});
    expect(await runWhatsappInbound(job(), w.deps)).toMatchObject({ outcome: 'copied' });
  });

  it('type refusé (.exe)', async () => {
    const w = makeWorld();
    w.addItem(1n, { originMetadata: metadata({ declaredFilename: 'facture.exe', mimeType: 'application/octet-stream' }) });
    useGraph(w, { bytes: Buffer.from('MZ-programme'), mime: 'application/octet-stream' });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'rejected' });
    expect(w.docs).toHaveLength(0);
    expect(item(w)).toMatchObject({ state: 5 });
    expect(item(w).errorMessage).toMatch(/non pris en charge/);
  });

  it('empreinte annoncée différente du contenu reçu', async () => {
    const w = makeWorld();
    useGraph(w, { sha256: sha(Buffer.from('autre chose')) });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'rejected' });
    expect(w.docs).toHaveLength(0);
    expect(item(w).errorMessage).toMatch(/Empreinte inattendue/);
  });

  it('rejet sans accusés activés : aucun message sortant', async () => {
    const w = makeWorld({ config: baseConfig({ ackEnabled: false }) });
    const graph = useGraph(w, { sha256: sha(Buffer.from('autre')) });
    await runWhatsappInbound(job(), w.deps);
    expect(graph.sends).toHaveLength(0);
  });
});

describe('runWhatsappInbound : dédoublonnage et idempotence', () => {
  it('2e message de même contenu : état Doublon, pas de 2e document, accusé quand même', async () => {
    const w = makeWorld();
    w.addItem(2n);
    const graph = useGraph(w, {});
    await runWhatsappInbound(job(1n), w.deps);
    const res = await runWhatsappInbound(job(2n), w.deps);
    expect(res).toMatchObject({ outcome: 'duplicate', ackSent: true });
    expect(w.docs).toHaveLength(1);
    expect(item(w, 2n)).toMatchObject({
      state: 6,
      duplicateOfId: 1n,
      contentHash: sha(PDF),
      documentId: null,
    });
    expect(graph.sends.map((s) => s.body)).toEqual([buildAckMessage('WA-1'), buildAckMessage('WA-2')]);
  });

  it('rejeu du même job : un seul document, aucun nouveau téléchargement', async () => {
    const w = makeWorld();
    const graph = useGraph(w, {});
    await runWhatsappInbound(job(), w.deps);
    const callsAfterFirst = graph.calls.length;
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toEqual({ skipped: 'already_processed' });
    expect(w.docs).toHaveLength(1);
    expect(graph.calls).toHaveLength(callsAfterFirst);
  });

  it.each([1, 5, 6])('élément déjà dans l’état final %i : ignoré', async (state) => {
    const w = makeWorld();
    w.addItem(1n, { state });
    const graph = useGraph(w, {});
    expect(await runWhatsappInbound(job(), w.deps)).toEqual({ skipped: 'already_processed' });
    expect(graph.calls).toHaveLength(0);
    expect(w.prisma.gedSourceItem.update).not.toHaveBeenCalled();
  });

  it('élément Découvert déjà rattaché à un document (arrêt en plein travail) : marqué Copie, document non recréé', async () => {
    const w = makeWorld();
    w.addItem(1n, { documentId: 55 });
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'copied', documentId: 55 });
    expect(w.docs).toHaveLength(0);
    expect(graph.calls.filter((c) => c.method === 'GET')).toHaveLength(0);
    expect(item(w)).toMatchObject({ state: 1, documentId: 55 });
  });

  it('élément absent ou d’un autre connecteur : ignoré', async () => {
    const w = makeWorld();
    useGraph(w, {});
    expect(await runWhatsappInbound(job(99n), w.deps)).toEqual({ skipped: 'unknown_item' });
    w.addItem(3n, { connectorId: 2 });
    expect(await runWhatsappInbound(job(3n), w.deps)).toEqual({ skipped: 'unknown_item' });
  });
});

describe('runWhatsappInbound : accusé de réception', () => {
  it('limite atteinte : l’ingestion aboutit, aucun accusé', async () => {
    const w = makeWorld();
    w.deps.rateLimiter = { take: jest.fn().mockResolvedValue(false) };
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'copied', ackSent: false });
    expect(item(w).state).toBe(1);
    expect(graph.sends).toHaveLength(0);
    expect(w.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ senderHash: SENDER_HASH }),
      expect.stringContaining('limite atteinte'),
    );
    expectClean(w, graph);
  });

  it('limiteur en panne (Redis) : l’ingestion aboutit', async () => {
    const w = makeWorld();
    w.deps.rateLimiter = { take: jest.fn().mockRejectedValue(new Error('ECONNREFUSED redis')) };
    useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'copied', ackSent: false });
  });

  it('10 accusés par heure et par expéditeur par défaut : le 11e est retenu', async () => {
    const w = makeWorld();
    w.deps.limits = { perConnectorPerMinute: 1000 };
    for (let i = 1n; i <= 11n; i++) {
      w.addItem(i, { originMetadata: metadata({ declaredFilename: `note${i}.txt`, mimeType: 'text/plain' }) });
    }
    const graph = useGraph(w, { uniqueContent: true, mime: 'text/plain' });
    const results = [];
    for (let i = 1n; i <= 11n; i++) results.push(await runWhatsappInbound(job(i), w.deps));
    expect(results.every((r) => 'outcome' in r && r.outcome === 'copied')).toBe(true);
    expect(results.filter((r) => 'ackSent' in r && r.ackSent)).toHaveLength(10);
    expect(graph.sends).toHaveLength(10);
    expect(w.docs).toHaveLength(11);
  });

  it('limite globale par connecteur (par minute)', async () => {
    const w = makeWorld();
    w.deps.limits = { perConnectorPerMinute: 1 };
    w.addItem(2n);
    const graph = useGraph(w, {});
    const first = await runWhatsappInbound(job(1n), w.deps);
    const second = await runWhatsappInbound(job(2n), w.deps);
    expect(first).toMatchObject({ ackSent: true });
    expect(second).toMatchObject({ ackSent: false });
    expect(graph.sends).toHaveLength(1);
  });

  it('échec d’envoi : le job n’échoue pas, l’erreur journalisée ne contient aucun secret', async () => {
    const w = makeWorld();
    const graph = useGraph(w, { sendFails: true });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'copied', ackSent: false });
    expect(item(w).state).toBe(1);
    expect(w.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ack', senderHash: SENDER_HASH }),
      expect.stringContaining('échec d’envoi'),
    );
    expectClean(w, graph);
  });

  it('accusés désactivés : rien n’est envoyé', async () => {
    const w = makeWorld({ config: baseConfig({ ackEnabled: false }) });
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'copied', ackSent: false });
    expect(graph.sends).toHaveLength(0);
  });
});

describe('runWhatsappInbound : connecteur, configuration, erreurs', () => {
  it.each([
    ['inactif (isActive)', { isActive: false }],
    ['statut Inactif', { status: 0 }],
  ])('connecteur %s : rien n’est traité', async (_label, patch) => {
    const w = makeWorld({ connector: patch });
    const graph = useGraph(w, {});
    expect(await runWhatsappInbound(job(), w.deps)).toEqual({ skipped: 'inactive' });
    expect(graph.calls).toHaveLength(0);
    expect(item(w).state).toBe(0);
  });

  it('connecteur d’un autre type ou introuvable : ignoré', async () => {
    const w = makeWorld({ connector: { connectorType: 'imap' } });
    expect(await runWhatsappInbound(job(), w.deps)).toEqual({ skipped: 'wrong_type' });
    const w2 = makeWorld();
    w2.prisma.gedSourceConnector.findUnique.mockResolvedValue(null as never);
    expect(await runWhatsappInbound(job(), w2.deps)).toEqual({ skipped: 'unknown_connector' });
  });

  it('données de job invalides : le job échoue', async () => {
    const w = makeWorld();
    await expect(runWhatsappInbound({ connectorId: 0, itemId: '1' }, w.deps)).rejects.toThrow(/invalides/);
    await expect(runWhatsappInbound({ connectorId: 1, itemId: 'abc' }, w.deps)).rejects.toThrow(/invalides/);
  });

  it('métadonnées illisibles : élément En erreur, motif générique', async () => {
    const w = makeWorld();
    w.addItem(1n, { originMetadata: { mediaId: 42 } });
    const graph = useGraph(w, {});
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'failed' });
    expect(item(w)).toMatchObject({ state: 5, errorMessage: 'données du message illisibles : document non créé' });
    expect(graph.calls).toHaveLength(0);
  });

  it('configuration illisible : élément En erreur, aucune requête', async () => {
    const w = makeWorld({ config: { phoneNumberId: 'pas-un-numero' } });
    const graph = useGraph(w, {});
    expect(await runWhatsappInbound(job(), w.deps)).toMatchObject({ outcome: 'setup_error' });
    expect(item(w).state).toBe(5);
    expect(graph.calls).toHaveLength(0);
  });

  it('identifiants : référence hors liste blanche (JWT_SECRET) refusée, connecteur en erreur, rien ne fuit', async () => {
    const w = makeWorld({ connector: { credentialsRef: 'JWT_SECRET' } });
    const graph = useGraph(w, {});
    expect(await runWhatsappInbound(job(), w.deps)).toMatchObject({ outcome: 'setup_error' });
    expect(w.connector.status).toBe(2);
    expect(graph.calls).toHaveLength(0);
    expectClean(w, graph);
  });

  it('identifiants chiffrés sans GED_CONNECTOR_KEY : erreur claire, élément En erreur', async () => {
    const w = makeWorld({ connector: { credentialsEnc: 'AAAA', credentialsKeyId: 'k1', credentialsRef: null } });
    expect(await runWhatsappInbound(job(), w.deps)).toMatchObject({ outcome: 'setup_error' });
    expect(w.connector.lastError).toMatch(/GED_CONNECTOR_KEY absente/);
    expect(item(w).state).toBe(5);
  });

  it('ConnectorAuthError (accès refusé) : connecteur En erreur, élément En erreur, pas de relance', async () => {
    const w = makeWorld();
    const graph = useGraph(w, { infoStatus: 403, infoBody: { error: { message: `refus ${TOKEN}`, code: 10 } } });
    const res = await runWhatsappInbound(job(), w.deps);
    expect(res).toMatchObject({ outcome: 'auth_error' });
    expect(w.connector.status).toBe(2);
    expect(w.connector.lastError).toMatch(/Accès refusé/);
    expect(item(w).state).toBe(5);
    expectClean(w, graph);
  });

  it('jeton expiré (code 190) : connecteur « Autorisation expirée »', async () => {
    const w = makeWorld();
    useGraph(w, { infoStatus: 401, infoBody: { error: { message: 'x', code: 190 } } });
    await runWhatsappInbound(job(), w.deps);
    expect(w.connector.status).toBe(3);
  });

  it('ConnectorQuotaError : le job est relancé (erreur remontée), élément resté Découvert', async () => {
    const { ConnectorQuotaError } = jest.requireActual('@archivage/connectors');
    const w = makeWorld();
    useGraph(w, { infoStatus: 429, infoBody: { error: { message: 'trop', code: 4 } } });
    await expect(runWhatsappInbound(job(), w.deps)).rejects.toBeInstanceOf(ConnectorQuotaError);
    expect(item(w).state).toBe(0);
    expect(w.docs).toHaveLength(0);
  });

  it('erreur transitoire à la dernière tentative : élément En erreur (message générique), erreur remontée', async () => {
    const w = makeWorld();
    useGraph(w, { infoStatus: 503, infoBody: { error: { message: `panne ${TOKEN}` } } });
    await expect(runWhatsappInbound(job(), w.deps)).rejects.toThrow();
    expect(item(w).state).toBe(0);
    await expect(runWhatsappInbound(job(), w.deps, { finalAttempt: true })).rejects.toThrow();
    expect(item(w)).toMatchObject({
      state: 5,
      errorMessage: 'traitement impossible après plusieurs tentatives : document non créé',
    });
    expectClean(w);
  });
});

describe('runWhatsappRefuse', () => {
  const refuse = (over: Record<string, unknown> = {}) => ({
    connectorId: 1,
    to: OTHER_PHONE,
    reason: 'unknown_sender' as const,
    ...over,
  });

  it('envoie le refus poli, ne journalise que le hash du numéro', async () => {
    const w = makeWorld({ config: baseConfig({ refuseUnknownSenders: true }) });
    const graph = useGraph(w, {});
    const res = await runWhatsappRefuse(refuse(), w.deps);
    expect(res).toEqual({ sent: true });
    expect(graph.sends).toEqual([{ to: OTHER_PHONE, body: buildRefusalMessage('unknown_sender') }]);
    expect(w.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, senderHash: hashPhone(OTHER_PHONE, APP_SECRET) }),
      'WhatsApp : refus envoyé',
    );
    expectClean(w, graph);
  });

  it('un seul refus par heure et par expéditeur', async () => {
    const w = makeWorld({ config: baseConfig({ refuseUnknownSenders: true }) });
    const graph = useGraph(w, {});
    expect(await runWhatsappRefuse(refuse(), w.deps)).toEqual({ sent: true });
    expect(await runWhatsappRefuse(refuse(), w.deps)).toEqual({ sent: false, reason: 'rate_limited' });
    expect(await runWhatsappRefuse(refuse({ to: '221770000001' }), w.deps)).toEqual({ sent: true });
    expect(graph.sends).toHaveLength(2);
    expectClean(w, graph);
  });

  it('type non pris en charge : message dédié', async () => {
    const w = makeWorld();
    const graph = useGraph(w, {});
    await runWhatsappRefuse(refuse({ reason: 'unsupported_type' }), w.deps);
    expect(graph.sends[0]!.body).toBe(buildRefusalMessage('unsupported_type'));
  });

  it('expéditeur inconnu sans réglage « refuser » : silence', async () => {
    const w = makeWorld();
    const graph = useGraph(w, {});
    expect(await runWhatsappRefuse(refuse(), w.deps)).toEqual({ sent: false, reason: 'disabled' });
    expect(graph.sends).toHaveLength(0);
  });

  it('échec d’envoi : journalisé, aucune exception, aucun secret', async () => {
    const w = makeWorld({ config: baseConfig({ refuseUnknownSenders: true }) });
    const graph = useGraph(w, { sendFails: true });
    expect(await runWhatsappRefuse(refuse(), w.deps)).toEqual({ sent: false, reason: 'send_failed' });
    expectClean(w, graph);
  });

  it('connecteur inactif, introuvable, données invalides', async () => {
    const w = makeWorld({ connector: { isActive: false } });
    expect(await runWhatsappRefuse(refuse(), w.deps)).toEqual({ skipped: 'inactive' });
    const w2 = makeWorld();
    expect(await runWhatsappRefuse(refuse({ to: '12' }), w2.deps)).toEqual({ skipped: 'invalid_data' });
    expect(await runWhatsappRefuse(refuse({ reason: 'autre' }), w2.deps)).toEqual({ skipped: 'invalid_data' });
  });
});

describe('createWhatsappProcessor', () => {
  it('route inbound et refuse, refuse un autre nom', async () => {
    const w = makeWorld({ config: baseConfig({ refuseUnknownSenders: true }) });
    useGraph(w, {});
    const processor = createWhatsappProcessor(w.deps);
    expect(await processor({ name: 'inbound', data: job() })).toMatchObject({ outcome: 'copied' });
    expect(
      await processor({ name: 'refuse', data: { connectorId: 1, to: OTHER_PHONE, reason: 'unknown_sender' } }),
    ).toEqual({ sent: true });
    await expect(processor({ name: 'autre', data: job() })).rejects.toThrow(/inconnu/);
  });

  it('dernière tentative BullMQ déduite de attemptsMade / opts.attempts', async () => {
    const w = makeWorld();
    useGraph(w, { infoStatus: 503, infoBody: { error: { message: 'x' } } });
    const processor = createWhatsappProcessor(w.deps);
    await expect(
      processor({ name: 'inbound', data: job(), attemptsMade: 1, opts: { attempts: 3 } }),
    ).rejects.toThrow();
    expect(item(w).state).toBe(0);
    await expect(
      processor({ name: 'inbound', data: job(), attemptsMade: 2, opts: { attempts: 3 } }),
    ).rejects.toThrow();
    expect(item(w).state).toBe(5);
  });
});

describe('limiteurs', () => {
  it('mémoire : fenêtre glissante par clé', async () => {
    let t = 0;
    const rl = createMemoryRateLimiter(() => t);
    expect(await rl.take('a', 2, 60)).toBe(true);
    expect(await rl.take('a', 2, 60)).toBe(true);
    expect(await rl.take('a', 2, 60)).toBe(false);
    expect(await rl.take('b', 2, 60)).toBe(true);
    t = 61_000;
    expect(await rl.take('a', 2, 60)).toBe(true);
  });

  it('Redis : SET NX EX puis INCR, préfixe appliqué', async () => {
    const store = new Map<string, number>();
    const set = jest.fn(async (k: string, _v: string, _m: 'EX', _s: number, _f: 'NX') => {
      if (!store.has(k)) store.set(k, 0);
      return 'OK';
    });
    const incr = jest.fn(async (k: string) => {
      store.set(k, (store.get(k) ?? 0) + 1);
      return store.get(k)!;
    });
    const rl = createRedisRateLimiter({ set, incr });
    expect(await rl.take('k', 1, 3600)).toBe(true);
    expect(await rl.take('k', 1, 3600)).toBe(false);
    expect(set).toHaveBeenCalledWith('ged:wa:rl:k', '0', 'EX', 3600, 'NX');
  });
});
