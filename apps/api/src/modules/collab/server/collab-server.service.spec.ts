import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  COMMENTS_KEY,
  EDITOR_FRAGMENT,
  MENTION_NODE_NAME,
  addComment,
  addReply,
  listComments,
  setCommentResolved,
} from '@archivage/editor';
import { validateYDocStructure } from '@archivage/editor/server';
import { DocumentState } from '@archivage/types';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { sign } from 'jsonwebtoken';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { WebSocket } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/auth.types';
import type { DocumentsService } from '../../documents/documents.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { CollabAccessService } from '../access/collab-access.service';
import {
  COLLAB_WS_PATH,
  CollabCloseCode,
  type CollabLoadResult,
  type CollabPersistencePort,
  type CollabVersionReason,
  type CollabVersionResult,
} from '../collab.contracts';
import type { CollabServerOptions } from './collab-server.options';
import { CollabServerService } from './collab-server.service';

// Validation de structure RÉELLE (paquet éditeur), sans le point d'entrée HTML (ESM non transformé).
jest.mock('@archivage/editor/server', () => jest.requireActual('./editor-structure.fake'));

// Clé de TEST uniquement (aucun secret réel).
const SECRET = 'cle-de-test-collab-serveur-0123456789';
const FIELD = 'texte';

jest.setTimeout(20_000);

// ------------------------------------------------------------------------------ utilitaires

async function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TestUser {
  sub: number;
  username: string;
  userGroupId: number;
  fullName: string;
}
const ALICE: TestUser = { sub: 1, username: 'alice', userGroupId: 11, fullName: 'Alice Martin' };
const BOB: TestUser = { sub: 2, username: 'bob', userGroupId: 22, fullName: 'Bob Diallo' };
const CARL: TestUser = { sub: 3, username: 'carl', userGroupId: 33, fullName: 'Carl Kone' };

function jwtFor(u: TestUser, expiresIn: number | string = '1h', secret = SECRET): string {
  return sign(
    { sub: u.sub, username: u.username, isAdmin: false, userGroupId: u.userGroupId, fullName: u.fullName },
    secret,
    { expiresIn: expiresIn as never },
  );
}

function stateWithText(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText(FIELD).insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function textOf(state: Uint8Array | null): string {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc.getText(FIELD).toString();
}

// ----------------------------------------------------------------------- client y-protocols

/**
 * Client minimal du protocole Hocuspocus 4 (ce qu'envoie `@hocuspocus/provider`) : authentification
 * dans le protocole, sync step 1/2, mises à jour, awareness. Permet aussi d'envoyer des messages
 * bruts (malveillants) pour éprouver le serveur.
 */
class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  ws!: WebSocket;
  scope: 'readonly' | 'read-write' | null = null;
  deniedReason: string | null = null;
  close: { code: number; reason: string } | null = null;
  upgradeError: string | null = null;
  syncStatuses: boolean[] = [];
  synced = false;
  /** Hors ligne : les modifications locales ne partent pas. */
  offline = false;

  constructor(
    private readonly url: string,
    readonly name: string,
    private readonly headers: Record<string, string> = {},
  ) {
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.offline || !this.isOpen() || this.scope !== 'read-write') return;
      this.send(this.updateMessage(update));
    });
    this.awareness.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin === this || !this.isOpen() || !this.scope) return;
      const changed = added.concat(updated, removed);
      this.send(this.awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)));
    });
  }

  get text(): string {
    return this.doc.getText(FIELD).toString();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async open(): Promise<this> {
    this.ws = new WebSocket(this.url, { headers: this.headers });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('close', (code, reason) => {
      this.close = { code, reason: reason.toString() };
    });
    await new Promise<void>((resolve) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (error) => {
        this.upgradeError = error.message;
        resolve();
      });
    });
    return this;
  }

  /** Comme le provider : jeton dans le protocole, puis step 1 (mis en file avant l'authentification). */
  authenticate(token: string): this {
    this.send(this.authMessage(token));
    this.send(this.step1Message());
    return this;
  }

  async connect(token: string): Promise<this> {
    await this.open();
    this.authenticate(token);
    await waitFor(() => this.synced || this.deniedReason !== null || this.close !== null, `connexion ${this.name}`);
    return this;
  }

  goOffline(): void {
    this.offline = true;
  }

  /** Retour en ligne : resynchronisation par échange step 1 / step 2 (comme après une reconnexion). */
  goOnline(): void {
    this.offline = false;
    this.send(this.step1Message());
  }

  send(bytes: Uint8Array | string): void {
    if (this.isOpen()) this.ws.send(bytes);
  }

  frame(type: number, write?: (e: encoding.Encoder) => void, key = this.name): Uint8Array {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, key);
    encoding.writeVarUint(e, type);
    write?.(e);
    return encoding.toUint8Array(e);
  }

  authMessage(token: string): Uint8Array {
    return this.frame(2, (e) => {
      encoding.writeVarUint(e, 0);
      encoding.writeVarString(e, token);
    });
  }

  step1Message(): Uint8Array {
    return this.frame(0, (e) => syncProtocol.writeSyncStep1(e, this.doc));
  }

  step2Message(update: Uint8Array): Uint8Array {
    return this.frame(0, (e) => {
      encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(e, update);
    });
  }

  updateMessage(update: Uint8Array): Uint8Array {
    return this.frame(0, (e) => syncProtocol.writeUpdate(e, update));
  }

  awarenessMessage(update: Uint8Array): Uint8Array {
    return this.frame(1, (e) => encoding.writeVarUint8Array(e, update));
  }

  private onMessage(data: Uint8Array): void {
    if (this.offline) return; // hors ligne : rien ne parvient non plus
    const decoder = decoding.createDecoder(data);
    decoding.readVarString(decoder);
    const type = decoding.readVarUint(decoder);
    switch (type) {
      case 0:
      case 4: {
        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, this.name);
        encoding.writeVarUint(encoder, 0);
        const before = encoding.length(encoder);
        const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > before && !this.offline) this.send(encoding.toUint8Array(encoder));
        if (kind === syncProtocol.messageYjsSyncStep2) this.synced = true;
        break;
      }
      case 1:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
      case 2: {
        const authType = decoding.readVarUint(decoder);
        if (authType === 2) this.scope = decoding.readVarString(decoder) as TestClient['scope'];
        if (authType === 1) this.deniedReason = decoding.readVarString(decoder);
        break;
      }
      case 8:
        this.syncStatuses.push(decoding.readVarUint(decoder) === 1);
        break;
      default:
        break;
    }
  }

  async closeAndWait(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(1000);
      await waitFor(() => this.close !== null, `fermeture ${this.name}`);
    }
    this.awareness.destroy();
  }
}

// ---------------------------------------------------------------------- doubles de test

interface FakeDocRow {
  /** Niveau par utilisateur (absent = canAccess faux). */
  levels: Record<number, number>;
  isFrozen: boolean;
  documentState: number;
  /** false = document existant mais non texte (pas de pièce `.ydoc`). */
  text: boolean;
  state: Uint8Array | null;
  baseVersionId: number;
}

class FakePersistence implements CollabPersistencePort {
  working = new Map<number, Uint8Array>();
  saves: Array<{ documentId: number; state: Uint8Array; baseVersionId: number }> = [];
  versions: Array<{
    documentId: number;
    state: Uint8Array;
    user: AuthUser | null;
    reason: CollabVersionReason;
  }> = [];
  mentions: Array<{ documentId: number; actor: AuthUser; mentionIds?: readonly number[] }> = [];
  loadCalls = 0;
  failSave = false;
  /** Sauvegarde bloquée tant que cette promesse n'est pas résolue (sauvegarde « en cours »). */
  saveGate: Promise<void> | null = null;
  savesStarted = 0;
  events: string[] = [];

  constructor(private readonly rows: Map<number, FakeDocRow>) {}

  async loadDocument(documentId: number): Promise<CollabLoadResult | null> {
    this.loadCalls += 1;
    const row = this.rows.get(documentId);
    if (!row || !row.text) return null;
    return {
      documentId,
      label: `Document ${documentId}`,
      state: this.working.get(documentId) ?? row.state,
      baseVersionId: row.baseVersionId,
    };
  }

  async saveWorkingState(documentId: number, state: Uint8Array, baseVersionId: number): Promise<void> {
    this.savesStarted += 1;
    if (this.saveGate) await this.saveGate;
    if (this.failSave) throw new Error('disque indisponible');
    this.working.set(documentId, state.slice());
    this.saves.push({ documentId, state: state.slice(), baseVersionId });
    this.events.push('save');
  }

  async discardWorkingState(documentId: number): Promise<void> {
    this.working.delete(documentId);
  }

  async createVersion(
    documentId: number,
    state: Uint8Array,
    user: AuthUser | null,
    opts: { reason: CollabVersionReason },
  ): Promise<CollabVersionResult | null> {
    this.versions.push({ documentId, state: state.slice(), user, reason: opts.reason });
    this.events.push(`version:${opts.reason}`);
    return { documentVersionId: 1000 + this.versions.length, versionNumber: this.versions.length + 1 };
  }

  async notifyMentions(
    documentId: number,
    _ydoc: Y.Doc,
    actor: AuthUser,
    opts?: { mentionIds?: readonly number[] },
  ): Promise<void> {
    this.mentions.push({ documentId, actor, mentionIds: opts?.mentionIds });
  }
}

interface Harness {
  service: CollabServerService;
  http: HttpServer;
  url: string;
  rows: Map<number, FakeDocRow>;
  persistence: FakePersistence;
  audit: { dataChange: jest.Mock };
  documents: { canAccess: jest.Mock; getEffectivePermissionLevel: jest.Mock };
  clients: TestClient[];
  client(name?: string, headers?: Record<string, string>, path?: string): TestClient;
}

let h: Harness;
let warnSpy: jest.SpyInstance;

const TEST_OPTIONS: Partial<CollabServerOptions> = {
  refusalMinDelayMs: 0,
  refusalJitterMs: 0,
  storeDebounceMs: 30,
  storeMaxDebounceMs: 150,
  sweepIntervalMs: 3_600_000,
  authTimeoutMs: 3000,
  shutdownTimeoutMs: 3000,
};

async function setup(
  overrides: Partial<CollabServerOptions> = {},
  env: Record<string, string> = {},
): Promise<Harness> {
  const rows = new Map<number, FakeDocRow>();
  const persistence = new FakePersistence(rows);
  const documents = {
    canAccess: jest.fn(async (id: number, user: AuthUser) => rows.get(id)?.levels[user.userId] !== undefined),
    getEffectivePermissionLevel: jest.fn(async (id: number, user: AuthUser) => {
      const row = rows.get(id);
      return row ? (row.levels[user.userId] ?? 2) : null;
    }),
  };
  const prisma = {
    document: {
      findUnique: jest.fn(async ({ where }: { where: { documentId: number } }) => {
        const row = rows.get(where.documentId);
        return row ? { isFrozen: row.isFrozen, documentState: row.documentState } : null;
      }),
    },
  };
  const config = {
    getOrThrow: () => SECRET,
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  const access = new CollabAccessService(
    documents as unknown as DocumentsService,
    prisma as unknown as PrismaService,
    config,
  );
  const audit = { dataChange: jest.fn(async () => undefined) };
  const service = new CollabServerService(
    persistence,
    access,
    audit as unknown as AuditService,
    undefined,
    config,
    { ...TEST_OPTIONS, ...overrides },
  );
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  service.attach(http);
  const port = (http.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}${COLLAB_WS_PATH}`;
  const clients: TestClient[] = [];
  return {
    service,
    http,
    url,
    rows,
    persistence,
    audit,
    documents,
    clients,
    client(name = '1', headers = {}, path = COLLAB_WS_PATH) {
      const c = new TestClient(`ws://127.0.0.1:${port}${path}`, name, headers);
      clients.push(c);
      return c;
    },
  };
}

function addDoc(id: number, row: Partial<FakeDocRow> = {}): FakeDocRow {
  const full: FakeDocRow = {
    levels: { [ALICE.sub]: 3, [BOB.sub]: 3 },
    isFrozen: false,
    documentState: DocumentState.Archive,
    text: true,
    state: null,
    baseVersionId: 500 + id,
    ...row,
  };
  h.rows.set(id, full);
  return full;
}

async function teardown(): Promise<void> {
  for (const c of h.clients) {
    try {
      if (c.ws && c.ws.readyState !== WebSocket.CLOSED) c.ws.terminate();
      c.awareness.destroy();
    } catch {
      /* déjà fermé */
    }
  }
  await h.service.shutdown();
  await new Promise<void>((resolve) => h.http.close(() => resolve()));
}

beforeEach(async () => {
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  h = await setup();
});

afterEach(async () => {
  await teardown();
  jest.restoreAllMocks();
});

async function restart(
  overrides: Partial<CollabServerOptions>,
  env: Record<string, string> = {},
): Promise<void> {
  await teardown();
  h = await setup(overrides, env);
}

function expectUniformRefusal(c: TestClient): void {
  expect(c.scope).toBeNull();
  expect(c.deniedReason).toBe('permission-denied');
  expect(c.close).toEqual({ code: CollabCloseCode.Unauthorized, reason: 'unauthorized' });
}

// =========================================================================================

describe('(a) contrôle d’accès à la connexion', () => {
  it('niveau 3 : ouverture en écriture, auditée', async () => {
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE));
    expect(c.scope).toBe('read-write');
    expect(h.audit.dataChange).toHaveBeenCalledWith({
      userGroupId: ALICE.userGroupId,
      actorFullName: ALICE.fullName,
      objectRef: 'document:1',
      newValue: 'collab-open-write',
    });
  });

  it('niveau 2 : lecture seule, pas d’audit d’écriture', async () => {
    addDoc(1, { levels: { [ALICE.sub]: 2 } });
    const c = await h.client('1').connect(jwtFor(ALICE));
    expect(c.scope).toBe('readonly');
    expect(h.audit.dataChange).not.toHaveBeenCalled();
  });

  it('document gelé : lecture seule même au niveau 5', async () => {
    addDoc(1, { levels: { [ALICE.sub]: 5 }, isFrozen: true });
    const c = await h.client('1').connect(jwtFor(ALICE));
    expect(c.scope).toBe('readonly');
  });

  it('document épuré : lecture seule', async () => {
    addDoc(1, { documentState: DocumentState.Epure });
    const c = await h.client('1').connect(jwtFor(ALICE));
    expect(c.scope).toBe('readonly');
  });

  it('audit indisponible : pas d’écriture non tracée, ouverture en lecture seule', async () => {
    addDoc(1);
    h.audit.dataChange.mockRejectedValueOnce(new Error('base indisponible'));
    const c = await h.client('1').connect(jwtFor(ALICE));
    expect(c.scope).toBe('readonly');
  });

  it('refus IDENTIQUE : canAccess faux, document inconnu, document non texte', async () => {
    addDoc(1, { levels: { [BOB.sub]: 3 } }); // Alice n'y a pas accès
    addDoc(2, { text: false }); // existe, accessible, mais pas un document texte
    const denied = await h.client('1').connect(jwtFor(ALICE));
    const unknown = await h.client('999').connect(jwtFor(ALICE));
    const notText = await h.client('2').connect(jwtFor(ALICE));
    for (const c of [denied, unknown, notText]) {
      await waitFor(() => c.close !== null, 'fermeture');
      expectUniformRefusal(c);
    }
    expect(h.audit.dataChange).not.toHaveBeenCalled();
  });

  it('refus à durée plancher : pas d’oracle d’existence par le timing', async () => {
    await restart({ refusalMinDelayMs: 150, refusalJitterMs: 0 });
    addDoc(1, { levels: { [BOB.sub]: 3 } });
    const timings: number[] = [];
    for (const [name, token] of [
      ['1', jwtFor(ALICE)],
      ['999', jwtFor(ALICE)],
      ['1', 'jeton-invalide'],
    ] as const) {
      const c = h.client(name);
      await c.open();
      const started = Date.now();
      c.authenticate(token);
      await waitFor(() => c.deniedReason !== null, 'refus');
      timings.push(Date.now() - started);
      await waitFor(() => c.close !== null, 'fermeture');
      expectUniformRefusal(c);
    }
    for (const t of timings) expect(t).toBeGreaterThanOrEqual(140);
  });

  it.each([
    ['absent', () => ''],
    ['invalide', () => 'pas-un-jwt'],
    ['signé avec une autre clé', () => jwtFor(ALICE, '1h', 'une-autre-cle-de-test-0123456789')],
    ['expiré', () => jwtFor(ALICE, -10)],
  ])('jeton %s : refus uniforme', async (_label, makeToken) => {
    addDoc(1);
    const c = await h.client('1').connect(makeToken());
    await waitFor(() => c.close !== null, 'fermeture');
    expectUniformRefusal(c);
  });

  it('aucun jeton ni détail sensible dans les journaux de refus', async () => {
    addDoc(1, { levels: { [BOB.sub]: 3 } });
    const token = jwtFor(ALICE);
    const c = await h.client('1').connect(token);
    await waitFor(() => c.close !== null, 'fermeture');
    const logged = warnSpy.mock.calls.flat().join('\n');
    expect(logged).toContain('refusée');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.split('.')[2]);
  });

  it('authentification non reçue dans le délai : fermeture Unauthorized', async () => {
    await restart({ authTimeoutMs: 150 });
    const c = h.client('1');
    await c.open();
    await waitFor(() => c.close !== null, 'fermeture sur délai');
    expect(c.close?.code).toBe(CollabCloseCode.Unauthorized);
  });

  it('jeton dans l’URL : upgrade refusé', async () => {
    addDoc(1);
    const c = h.client('1', {}, `${COLLAB_WS_PATH}?token=${jwtFor(ALICE)}`);
    await c.open();
    expect(c.upgradeError).toMatch(/400/);
  });

  it('autre chemin : upgrade refusé (404)', async () => {
    const c = h.client('1', {}, '/api/autre');
    await c.open();
    expect(c.upgradeError).toMatch(/404/);
  });

  it('nom de salle non décimal strict : refus Unauthorized', async () => {
    for (const name of ['01', 'abc', '1.0', '2147483648']) {
      const c = await h.client(name).connect(jwtFor(ALICE));
      await waitFor(() => c.close !== null, `fermeture ${name}`);
      expect(c.close?.code).toBe(CollabCloseCode.Unauthorized);
      expect(c.scope).toBeNull();
    }
    expect(h.documents.canAccess).not.toHaveBeenCalled();
  });

  it('JWT expiré pendant une connexion longue : fermeture au balayage', async () => {
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE, 3600));
    expect(c.scope).toBe('read-write');
    h.service.sweep(Date.now() + 2 * 3600 * 1000);
    await waitFor(() => c.close !== null, 'fermeture sur expiration');
    expect(c.close).toEqual({ code: CollabCloseCode.Unauthorized, reason: 'session-expired' });
  });

  it('renouvellement de jeton (token sync) : un autre utilisateur est refusé', async () => {
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE));
    c.send(c.authMessage(jwtFor(BOB)));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close?.code).toBe(CollabCloseCode.Unauthorized);
  });

  it('le mode est réévalué à chaque connexion', async () => {
    const row = addDoc(1);
    const first = await h.client('1').connect(jwtFor(ALICE));
    expect(first.scope).toBe('read-write');
    row.isFrozen = true;
    const second = await h.client('1').connect(jwtFor(ALICE));
    expect(second.scope).toBe('readonly');
  });
});

describe('(b) lecture seule', () => {
  it('les mises à jour (update ET sync step 2) d’un client lecture seule sont ignorées', async () => {
    addDoc(1, { levels: { [ALICE.sub]: 3, [BOB.sub]: 2 }, state: stateWithText('Bonjour') });
    const writer = await h.client('1').connect(jwtFor(ALICE));
    const reader = await h.client('1').connect(jwtFor(BOB));
    expect(reader.scope).toBe('readonly');
    expect(reader.text).toBe('Bonjour');

    // Tentatives d'écriture par les deux canaux du protocole.
    const forged = new Y.Doc();
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(reader.doc));
    forged.getText(FIELD).insert(0, 'PIRATE ');
    const delta = Y.encodeStateAsUpdate(forged, Y.encodeStateVector(reader.doc));
    reader.send(reader.updateMessage(delta));
    reader.send(reader.step2Message(delta));
    await waitFor(() => reader.syncStatuses.filter((s) => !s).length >= 2, 'acquittements négatifs');

    expect(textOf(h.service.getLiveState(1))).toBe('Bonjour');
    expect(writer.text).toBe('Bonjour');

    // La lecture fonctionne : le lecteur reçoit les modifications de l'écrivain.
    writer.doc.getText(FIELD).insert(7, ' à tous');
    await waitFor(() => reader.text === 'Bonjour à tous', 'diffusion au lecteur');
    expect(textOf(h.service.getLiveState(1))).toBe('Bonjour à tous');
    await writer.closeAndWait();
    await reader.closeAndWait();
    await waitFor(() => h.service.getLiveState(1) === null, 'déchargement');
    await h.service.drainTasks();
    expect(h.persistence.versions.every((v) => !textOf(v.state).includes('PIRATE'))).toBe(true);
  });

  it('awareness : identité imposée par le serveur, aucun vol de clientId d’un autre', async () => {
    addDoc(1, { levels: { [ALICE.sub]: 3, [BOB.sub]: 2 } });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const bob = await h.client('1').connect(jwtFor(BOB));

    alice.awareness.setLocalState({ user: { name: 'Alice', color: '#ff0000' }, cursor: null });
    await waitFor(() => bob.awareness.getStates().has(alice.doc.clientID), 'awareness d’Alice chez Bob');

    // Bob (lecture seule) se fait passer pour « Directeur » : réécrit par le serveur.
    bob.awareness.setLocalState({ user: { name: 'Directeur', color: 'javascript:alert(1)' } });
    await waitFor(() => alice.awareness.getStates().has(bob.doc.clientID), 'awareness de Bob chez Alice');
    expect(alice.awareness.getStates().get(bob.doc.clientID)?.user).toEqual({
      name: BOB.fullName,
      userGroupId: BOB.userGroupId,
    });
    expect(alice.awareness.getStates().get(alice.doc.clientID)).toBeDefined();

    // Bob forge un état pour le clientId d'Alice : ignoré.
    const forger = new awarenessProtocol.Awareness(new Y.Doc());
    forger.clientID = alice.doc.clientID;
    forger.setLocalState({ user: { name: 'Alice' }, cursor: 'faux' });
    const meta = forger.meta.get(alice.doc.clientID);
    if (meta) meta.clock = 1000;
    bob.send(bob.awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(forger, [alice.doc.clientID])));
    await sleep(100);
    const seen = bob.awareness.getStates().get(alice.doc.clientID);
    expect(seen?.cursor).toBeNull();
    expect(seen?.user).toEqual({ name: ALICE.fullName, userGroupId: ALICE.userGroupId, color: '#ff0000' });
    forger.destroy();
    expect(bob.close).toBeNull();
  });
});

describe('(c) limites', () => {
  it('message trop gros : fermeture PolicyViolation', async () => {
    await restart({ maxMessageBytes: 16 * 1024 });
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE));
    c.send(c.updateMessage(new Uint8Array(20 * 1024)));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'policy-violation' });
  });

  it('état du document trop gros : mise à jour refusée AVANT application, rien de persisté au-delà', async () => {
    await restart({ maxStateBytes: 4 * 1024, maxMessageBytes: 64 * 1024 });
    addDoc(1, { state: stateWithText('base') });
    const c = await h.client('1').connect(jwtFor(ALICE));
    c.doc.getText(FIELD).insert(0, 'x'.repeat(8 * 1024));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'policy-violation' });
    expect(textOf(h.service.getLiveState(1) ?? stateWithText('base'))).toBe('base');
    await sleep(100);
    for (const s of h.persistence.saves) expect(s.state.byteLength).toBeLessThanOrEqual(4 * 1024);
  });

  it('état persisté trop gros : refus à la connexion', async () => {
    await restart({ maxStateBytes: 1024 });
    addDoc(1, { state: stateWithText('y'.repeat(4096)) });
    const c = await h.client('1').connect(jwtFor(ALICE));
    await waitFor(() => c.close !== null, 'fermeture');
    expectUniformRefusal(c);
  });

  it('débit dépassé : fermeture PolicyViolation', async () => {
    await restart({ messageBurst: 10, messagesPerSecond: 1 });
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE));
    for (let i = 0; i < 30; i += 1) c.send(c.frame(3));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'policy-violation' });
  });

  it('octets/s dépassés : fermeture PolicyViolation', async () => {
    await restart({ maxMessageBytes: 8 * 1024, byteBurst: 8 * 1024, bytesPerSecond: 1024 });
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE));
    for (let i = 0; i < 5; i += 1) c.send(c.frame(5, (e) => encoding.writeVarString(e, 'z'.repeat(4000))));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'policy-violation' });
  });

  it('trop de connexions sur un document', async () => {
    await restart({ maxConnectionsPerDocument: 2 });
    addDoc(1, { levels: { [ALICE.sub]: 3, [BOB.sub]: 3, [CARL.sub]: 3 } });
    await h.client('1').connect(jwtFor(ALICE));
    await h.client('1').connect(jwtFor(BOB));
    const third = await h.client('1').connect(jwtFor(CARL));
    await waitFor(() => third.close !== null, 'fermeture');
    expect(third.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'too-many-connections' });
  });

  it('trop de connexions pour un utilisateur', async () => {
    await restart({ maxConnectionsPerUser: 1 });
    addDoc(1);
    addDoc(2);
    await h.client('1').connect(jwtFor(ALICE));
    const second = await h.client('2').connect(jwtFor(ALICE));
    await waitFor(() => second.close !== null, 'fermeture');
    expect(second.close?.code).toBe(CollabCloseCode.PolicyViolation);
  });

  it('trop de sockets simultanés depuis une IP : upgrade refusé (429)', async () => {
    await restart({ maxConnectionsPerIp: 2 });
    const a = await h.client('1').open();
    const b = await h.client('1').open();
    const c = await h.client('1').open();
    expect(a.upgradeError).toBeNull();
    expect(b.upgradeError).toBeNull();
    expect(c.upgradeError).toMatch(/429/);
    // La place se libère à la fermeture.
    a.ws.terminate();
    await sleep(100);
    const d = await h.client('1').open();
    expect(d.upgradeError).toBeNull();
  });

  it('Origin contrôlée si CORS_ORIGIN est défini', async () => {
    await restart({ allowedOrigins: ['https://ged.exemple.org'] });
    addDoc(1);
    const bad = await h.client('1', { origin: 'https://evil.exemple' }).open();
    expect(bad.upgradeError).toMatch(/403/);
    const good = await h.client('1', { origin: 'https://ged.exemple.org' }).connect(jwtFor(ALICE));
    expect(good.scope).toBe('read-write');
  });

  it.each([
    ['texte (non binaire)', (c: TestClient) => c.send('bonjour')],
    ['octets aléatoires', (c: TestClient) => c.send(Uint8Array.from([255, 255, 255, 255, 255, 7]))],
    ['type interdit (BroadcastStateless)', (c: TestClient) => c.send(c.frame(6, (e) => encoding.writeVarString(e, 'x')))],
    ['type inconnu', (c: TestClient) => c.send(c.frame(42))],
    ['seconde salle sur le même socket', (c: TestClient) => c.send(c.frame(3, undefined, '2'))],
    ['mise à jour Yjs corrompue', (c: TestClient) => c.send(c.updateMessage(Uint8Array.from([9, 9, 9, 9, 9])))],
  ])('message malformé (%s) : fermeture sans crash', async (_label, attack) => {
    addDoc(1);
    const c = await h.client('1').connect(jwtFor(ALICE));
    attack(c);
    await waitFor(() => c.close !== null, 'fermeture');
    expect([CollabCloseCode.PolicyViolation, CollabCloseCode.Unauthorized]).toContain(c.close?.code);
    // Le serveur continue de servir.
    const other = await h.client('1').connect(jwtFor(BOB));
    expect(other.scope).toBe('read-write');
  });

  it('message malformé AVANT authentification : fermeture sans crash', async () => {
    const c = h.client('1');
    await c.open();
    c.send(Uint8Array.from([0xff, 0xff, 0xff]));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close?.code).toBe(CollabCloseCode.PolicyViolation);
  });

  it('nom de salle illisible AVANT authentification : refus Unauthorized', async () => {
    const c = h.client('1');
    await c.open();
    c.send(Uint8Array.from([1, 2, 3]));
    await waitFor(() => c.close !== null, 'fermeture');
    expect(c.close?.code).toBe(CollabCloseCode.Unauthorized);
  });
});

describe('(d) persistance et restauration', () => {
  it('charge -> modifie -> stocke -> recharge à l’identique ; version à la fermeture', async () => {
    addDoc(7, { state: stateWithText('Bonjour') });
    const a = await h.client('7').connect(jwtFor(ALICE));
    expect(a.text).toBe('Bonjour');
    a.doc.getText(FIELD).insert(7, ', le monde');
    await waitFor(() => h.persistence.saves.length > 0, 'autosave');
    const saved = h.persistence.saves.at(-1)!;
    expect(saved).toMatchObject({ documentId: 7, baseVersionId: 507 });
    expect(textOf(saved.state)).toBe('Bonjour, le monde');
    // Aucune mention introduite : aucune notification.
    expect(h.persistence.mentions).toHaveLength(0);

    await a.closeAndWait();
    await waitFor(() => h.service.getLiveState(7) === null, 'déchargement');
    await h.service.drainTasks();
    expect(h.persistence.versions).toHaveLength(1);
    expect(h.persistence.versions[0]).toMatchObject({ documentId: 7, reason: 'close', user: { userId: ALICE.sub } });
    expect(textOf(h.persistence.versions[0].state)).toBe('Bonjour, le monde');

    const b = await h.client('7').connect(jwtFor(BOB));
    expect(b.text).toBe('Bonjour, le monde');
    expect(Y.encodeStateAsUpdate(b.doc)).toBeDefined();
    expect(textOf(h.service.getLiveState(7))).toBe('Bonjour, le monde');
  });

  it('aucune version à la fermeture sans modification', async () => {
    addDoc(7, { state: stateWithText('Inchangé') });
    const a = await h.client('7').connect(jwtFor(ALICE));
    const r = await h.client('7').connect(jwtFor(BOB));
    await a.closeAndWait();
    await r.closeAndWait();
    await waitFor(() => h.service.getLiveState(7) === null, 'déchargement');
    await sleep(100);
    await h.service.drainTasks();
    expect(h.persistence.versions).toHaveLength(0);
    expect(h.persistence.saves).toHaveLength(0);
  });

  it('version « idle » au plus une fois par intervalle, puis « close » seulement si nouveaux changements', async () => {
    await restart({ idleVersionIntervalMs: 200 });
    addDoc(7);
    const a = await h.client('7').connect(jwtFor(ALICE));
    a.doc.getText(FIELD).insert(0, 'v1');
    await waitFor(() => h.persistence.saves.length >= 1, 'premier autosave');
    expect(h.persistence.versions).toHaveLength(0);
    await sleep(250);
    a.doc.getText(FIELD).insert(2, ' v2');
    await waitFor(() => h.persistence.versions.length >= 1, 'version idle');
    expect(h.persistence.versions[0]).toMatchObject({ reason: 'idle', user: { userId: ALICE.sub } });
    expect(textOf(h.persistence.versions[0].state)).toBe('v1 v2');
    await a.closeAndWait();
    await waitFor(() => h.service.getLiveState(7) === null, 'déchargement');
    await h.service.drainTasks();
    expect(h.persistence.versions).toHaveLength(1); // pas de « close » : rien depuis l'idle
  });

  it('autosave en échec : la salle reste en mémoire (pas de perte)', async () => {
    addDoc(7);
    h.persistence.failSave = true;
    const a = await h.client('7').connect(jwtFor(ALICE));
    a.doc.getText(FIELD).insert(0, 'précieux');
    await sleep(300);
    await a.closeAndWait();
    await sleep(200);
    expect(textOf(h.service.getLiveState(7))).toBe('précieux');
    expect(h.persistence.versions).toHaveLength(0);

    // Le disque revient : le balayage retente, sauvegarde, décharge et crée la version de fermeture.
    h.persistence.failSave = false;
    h.service.sweep();
    await waitFor(() => h.service.getLiveState(7) === null, 'déchargement après reprise');
    await h.service.drainTasks();
    expect(textOf(h.persistence.working.get(7) ?? null)).toBe('précieux');
    expect(h.persistence.versions.map((v) => v.reason)).toEqual(['close']);
  });

  it('getLiveState / mutateDocument : mutation serveur diffusée et persistée', async () => {
    addDoc(7, { state: stateWithText('abc') });
    expect(h.service.getLiveState(7)).toBeNull();
    const a = await h.client('7').connect(jwtFor(ALICE));
    const actor: AuthUser = { userId: BOB.sub, username: BOB.username, isAdmin: false, userGroupId: BOB.userGroupId, fullName: BOB.fullName };
    await h.service.mutateDocument(7, (doc) => doc.getText(FIELD).insert(3, 'def'), actor);
    await waitFor(() => a.text === 'abcdef', 'diffusion de la mutation');
    expect(textOf(h.service.getLiveState(7))).toBe('abcdef');
    await waitFor(() => h.persistence.saves.some((s) => textOf(s.state) === 'abcdef'), 'autosave');
  });

  it('mutateDocument sur une salle fermée : charge, applique, persiste puis décharge', async () => {
    addDoc(8, { state: stateWithText('x') });
    const actor: AuthUser = { userId: 1, username: 'alice', isAdmin: false, userGroupId: 11 };
    await h.service.mutateDocument(8, (doc) => doc.getText(FIELD).insert(1, 'y'), actor);
    expect(textOf(h.service.getLiveState(8))).toBe('xy');
    await waitFor(() => h.service.getLiveState(8) === null, 'déchargement après debounce');
    await h.service.drainTasks();
    expect(textOf(h.persistence.working.get(8) ?? null)).toBe('xy');
    expect(h.persistence.versions.at(-1)).toMatchObject({ reason: 'close', user: { userId: 1 } });
  });

  it('mutateDocument sur un document non texte : erreur', async () => {
    addDoc(9, { text: false });
    const actor: AuthUser = { userId: 1, username: 'alice', isAdmin: false, userGroupId: 11 };
    await expect(h.service.mutateDocument(9, () => undefined, actor)).rejects.toThrow();
  });

  it('resetRoom : fermeture Reload, rien de périmé persisté, rechargement depuis la persistance', async () => {
    addDoc(7, { state: stateWithText('ancien') });
    const a = await h.client('7').connect(jwtFor(ALICE));
    a.doc.getText(FIELD).insert(0, 'brouillon ');
    await waitFor(() => textOf(h.service.getLiveState(7)) === 'brouillon ancien', 'modification');
    const savesBefore = h.persistence.saves.length;

    // Restauration côté T2 : l'état de référence change, puis la salle est réinitialisée.
    h.rows.get(7)!.state = stateWithText('restauré');
    h.persistence.working.delete(7);
    await h.service.resetRoom(7);
    await waitFor(() => a.close !== null, 'fermeture Reload');
    expect(a.close).toEqual({ code: CollabCloseCode.Reload, reason: 'reload' });
    expect(h.service.getLiveState(7)).toBeNull();
    await sleep(200);
    await h.service.drainTasks();
    expect(h.persistence.saves.length).toBe(savesBefore);
    expect(h.persistence.versions).toHaveLength(0);
    expect(h.persistence.working.has(7)).toBe(false);

    const b = await h.client('7').connect(jwtFor(BOB));
    expect(b.text).toBe('restauré');
  });

  it('arrêt propre : salles stockées, version de fermeture, sockets fermés', async () => {
    addDoc(7);
    const a = await h.client('7').connect(jwtFor(ALICE));
    a.doc.getText(FIELD).insert(0, 'avant arrêt');
    await waitFor(() => textOf(h.service.getLiveState(7)) === 'avant arrêt', 'modification');
    await h.service.shutdown();
    await waitFor(() => a.close !== null, 'fermeture');
    expect(a.close?.code).toBe(1001);
    expect(textOf(h.persistence.working.get(7) ?? null)).toBe('avant arrêt');
    expect(h.persistence.versions.map((v) => v.reason)).toEqual(['close']);
  });
});

describe('(e) convergence', () => {
  it('deux clients en édition concurrente convergent', async () => {
    addDoc(3, { state: stateWithText('--') });
    const a = await h.client('3').connect(jwtFor(ALICE));
    const b = await h.client('3').connect(jwtFor(BOB));
    for (let i = 0; i < 20; i += 1) {
      a.doc.getText(FIELD).insert(1, 'a');
      b.doc.getText(FIELD).insert(1, 'b');
    }
    await waitFor(() => a.text.length === 42 && a.text === b.text, 'convergence');
    expect(textOf(h.service.getLiveState(3))).toBe(a.text);
  });

  it('édition hors ligne concurrente puis resynchronisation : même état partout', async () => {
    addDoc(3, { state: stateWithText('Titre') });
    const a = await h.client('3').connect(jwtFor(ALICE));
    const b = await h.client('3').connect(jwtFor(BOB));
    b.goOffline();
    a.doc.getText(FIELD).insert(5, ' en ligne');
    b.doc.getText(FIELD).insert(0, '[hors ligne] ');
    b.doc.getText(FIELD).delete(13, 1);
    await waitFor(() => textOf(h.service.getLiveState(3)) === 'Titre en ligne', 'édition en ligne');
    expect(b.text).toBe('[hors ligne] itre');
    b.goOnline();
    await waitFor(() => a.text === b.text && b.text.includes('en ligne') && a.text.includes('[hors ligne]'), 'resynchronisation');
    expect(a.text).toBe('[hors ligne] itre en ligne');
    expect(textOf(h.service.getLiveState(3))).toBe(a.text);
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });
});

// ------------------------------------------------------------------------------------------
// Corrections du lot 4b (vérificateur) : dépendances manquantes, attribution des mentions,
// identité des commentaires, proxy de confiance, réévaluation des droits, mineurs.

function hasPending(state: Uint8Array | null): boolean {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/** Mises à jour successives d'un document, une par transaction. */
function recordUpdates(doc: Y.Doc): Uint8Array[] {
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  return updates;
}

function authUser(u: TestUser): AuthUser {
  return { userId: u.sub, username: u.username, isAdmin: false, userGroupId: u.userGroupId, fullName: u.fullName };
}

/** Paragraphe contenant une mention (nœud `mention`, attribut `id` = user_group_id). */
function insertMention(doc: Y.Doc, id: number): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(EDITOR_FRAGMENT);
    const paragraph = new Y.XmlElement('paragraph');
    fragment.insert(fragment.length, [paragraph]);
    const mention = new Y.XmlElement(MENTION_NODE_NAME);
    paragraph.insert(0, [mention]);
    mention.setAttribute('id', String(id));
    mention.setAttribute('label', `u${id}`);
  });
}

function insertParagraph(doc: Y.Doc, text: string): Y.XmlText {
  const fragment = doc.getXmlFragment(EDITOR_FRAGMENT);
  const paragraph = new Y.XmlElement('paragraph');
  const xmlText = new Y.XmlText();
  doc.transact(() => {
    fragment.insert(fragment.length, [paragraph]);
    paragraph.insert(0, [xmlText]);
    xmlText.insert(0, text);
  });
  return xmlText;
}

function liveComments(documentId: number) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, h.service.getLiveState(documentId)!);
  return listComments(doc);
}

describe('(f) mises à jour à dépendances manquantes', () => {
  async function aliceAndBob(): Promise<{ alice: TestClient; bob: TestClient }> {
    addDoc(1, { state: stateWithText('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const bob = await h.client('1').connect(jwtFor(BOB));
    return { alice, bob };
  }

  it.each([
    ['update', (c: TestClient, u: Uint8Array) => c.updateMessage(u)],
    ['sync step 2', (c: TestClient, u: Uint8Array) => c.step2Message(u)],
  ])(
    '2e modification envoyée seule (%s) : refusée AVANT application, salle, versions et collaborateurs intacts',
    async (_label, frame) => {
      const { alice, bob } = await aliceAndBob();
      alice.goOffline();
      const updates = recordUpdates(alice.doc);
      alice.doc.getText(FIELD).insert(4, ' A1');
      alice.doc.getText(FIELD).insert(7, ' A2');
      expect(updates).toHaveLength(2);
      alice.send(frame(alice, updates[1])); // la 2e sans la 1re

      await waitFor(() => alice.close !== null, 'fermeture du client fautif');
      expect(alice.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'structure' });
      const doc = h.service.hocuspocus.documents.get('1')!;
      expect(doc.store.pendingStructs).toBeNull();
      expect(doc.store.pendingDs).toBeNull();
      expect(hasPending(h.service.getLiveState(1))).toBe(false);
      expect(textOf(h.service.getLiveState(1))).toBe('base');

      // Le collaborateur continue : autosave puis version de fermeture saines.
      expect(bob.close).toBeNull();
      bob.doc.getText(FIELD).insert(4, ' bob');
      await waitFor(() => h.persistence.saves.some((s) => textOf(s.state) === 'base bob'), 'autosave');
      await bob.closeAndWait();
      await waitFor(() => h.service.getLiveState(1) === null, 'déchargement');
      await h.service.drainTasks();
      expect(h.persistence.saves.length).toBeGreaterThan(0);
      for (const s of h.persistence.saves) expect(hasPending(s.state)).toBe(false);
      expect(h.persistence.versions.map((v) => v.reason)).toEqual(['close']);
      expect(hasPending(h.persistence.versions[0].state)).toBe(false);
      expect(textOf(h.persistence.versions[0].state)).toBe('base bob');
    },
  );

  it('référence à un élément d’un autre client inconnu du serveur : refusée', async () => {
    const { alice, bob } = await aliceAndBob();
    const foreign = new Y.Doc(); // client jamais vu par le serveur
    foreign.getText(FIELD).insert(0, 'xyz');
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(foreign));
    const updates = recordUpdates(forger);
    forger.getText(FIELD).insert(1, '!'); // origine = élément de `foreign`
    alice.send(alice.updateMessage(updates[0]));
    await waitFor(() => alice.close !== null, 'fermeture');
    expect(alice.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'structure' });
    expect(hasPending(h.service.getLiveState(1))).toBe(false);
    expect(bob.close).toBeNull();
  });

  it('suppression de contenu inconnu du serveur : refusée', async () => {
    const { alice } = await aliceAndBob();
    const foreign = new Y.Doc();
    foreign.getText(FIELD).insert(0, 'xyz');
    const forger = new Y.Doc();
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(foreign));
    const updates = recordUpdates(forger);
    forger.getText(FIELD).delete(1, 1);
    alice.send(alice.updateMessage(updates[0]));
    await waitFor(() => alice.close !== null, 'fermeture');
    expect(alice.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'structure' });
    expect(hasPending(h.service.getLiveState(1))).toBe(false);
  });

  it('mise à jour légitime d’un client retardataire (recouvrement) : acceptée', async () => {
    const { alice, bob } = await aliceAndBob();
    alice.goOffline();
    alice.doc.getText(FIELD).insert(4, ' hors-ligne');
    alice.goOnline(); // step 1 -> le serveur répond step 1, le client renvoie TOUT ce qui manque
    await waitFor(() => textOf(h.service.getLiveState(1)) === 'base hors-ligne', 'resynchronisation');
    expect(alice.close).toBeNull();
    expect(bob.close).toBeNull();
  });

  it('filet de sécurité : un état avec structures en attente n’est jamais persisté', async () => {
    const { alice, bob } = await aliceAndBob();
    const gap = new Y.Doc();
    const updates = recordUpdates(gap);
    gap.getText('autre').insert(0, 'a');
    gap.getText('autre').insert(1, 'b');
    // Injection directe (hors protocole) dans la salle vivante : contourne la garde de beforeSync.
    const doc = h.service.hocuspocus.documents.get('1')!;
    Y.applyUpdate(doc, updates[1]);
    expect(doc.store.pendingStructs).not.toBeNull();
    expect(hasPending(h.service.getLiveState(1))).toBe(false);
    bob.doc.getText(FIELD).insert(0, '>');
    await waitFor(() => h.persistence.saves.length > 0, 'autosave');
    for (const s of h.persistence.saves) expect(hasPending(s.state)).toBe(false);
    expect(alice.close).toBeNull();
  });
});

describe('(g) attribution des mentions', () => {
  it('chaque mention est notifiée au nom de la connexion qui l’a posée, et à elle seule', async () => {
    addDoc(5, { levels: { [ALICE.sub]: 3, [BOB.sub]: 3 } });
    const alice = await h.client('5').connect(jwtFor(ALICE));
    const bob = await h.client('5').connect(jwtFor(BOB));
    insertMention(alice.doc, 70);
    await waitFor(() => bob.doc.getXmlFragment(EDITOR_FRAGMENT).length === 1, 'diffusion de la mention');
    addComment(bob.doc, {
      id: randomUUID(),
      authorUserGroupId: BOB.userGroupId,
      authorName: BOB.fullName,
      body: 'Voir @80',
      anchorText: 'x',
      mentions: [80],
    });
    await waitFor(() => h.persistence.mentions.length >= 2, 'notifications');
    await h.service.drainTasks();
    const byActor = new Map(h.persistence.mentions.map((m) => [m.actor.userId, m.mentionIds]));
    expect(h.persistence.mentions).toHaveLength(2);
    expect(byActor.get(ALICE.sub)).toEqual([70]);
    expect(byActor.get(BOB.sub)).toEqual([80]);
  });

  it('mentions déjà présentes au chargement : jamais attribuées ; frappe simple : aucune notification', async () => {
    const seed = new Y.Doc();
    insertMention(seed, 50);
    addDoc(5, { state: Y.encodeStateAsUpdate(seed) });
    const alice = await h.client('5').connect(jwtFor(ALICE));
    const text = insertParagraph(alice.doc, 'du texte');
    for (const ch of ' et encore') text.insert(text.length, ch);
    await waitFor(() => h.persistence.saves.length > 0, 'autosave');
    await sleep(100);
    await h.service.drainTasks();
    expect(h.persistence.mentions).toHaveLength(0);

    insertMention(alice.doc, 51);
    await waitFor(() => h.persistence.mentions.length > 0, 'notification');
    expect(h.persistence.mentions).toEqual([
      { documentId: 5, actor: expect.objectContaining({ userId: ALICE.sub }), mentionIds: [51] },
    ]);
  });

  it('mention posée par une mutation serveur : attribuée à l’acteur', async () => {
    addDoc(5);
    await h.service.mutateDocument(5, (doc) => insertMention(doc, 90), authUser(CARL));
    await waitFor(() => h.persistence.mentions.length > 0, 'notification');
    expect(h.persistence.mentions[0]).toMatchObject({ actor: { userId: CARL.sub }, mentionIds: [90] });
  });
});

describe('(h) identité des commentaires imposée par le serveur', () => {
  it('nouveau commentaire au nom d’un autre : auteur réécrit avec l’identité de la connexion', async () => {
    addDoc(6);
    const alice = await h.client('6').connect(jwtFor(ALICE));
    const bob = await h.client('6').connect(jwtFor(BOB));
    const id = randomUUID();
    addComment(bob.doc, {
      id,
      authorUserGroupId: ALICE.userGroupId,
      authorName: 'Alice Martin',
      body: 'Je valide (signé Alice)',
      anchorText: 'x',
      mentions: [],
    });
    await waitFor(() => liveComments(6)[0]?.authorUserGroupId === BOB.userGroupId, 'correction serveur');
    expect(liveComments(6)[0]).toMatchObject({ id, authorUserGroupId: BOB.userGroupId, authorName: BOB.fullName });
    await waitFor(() => listComments(alice.doc)[0]?.authorName === BOB.fullName, 'correction diffusée');
    await waitFor(() => h.persistence.saves.length > 0, 'autosave');
    const saved = new Y.Doc();
    Y.applyUpdate(saved, h.persistence.saves.at(-1)!.state);
    expect(listComments(saved)[0]).toMatchObject({ authorUserGroupId: BOB.userGroupId, authorName: BOB.fullName });
  });

  it('réponse forgée, résolution au nom d’un autre, auteur modifié a posteriori : corrigés', async () => {
    addDoc(6);
    const alice = await h.client('6').connect(jwtFor(ALICE));
    const bob = await h.client('6').connect(jwtFor(BOB));
    const id = randomUUID();
    addComment(alice.doc, {
      id,
      authorUserGroupId: ALICE.userGroupId,
      authorName: ALICE.fullName,
      body: 'Question',
      anchorText: 'x',
      mentions: [],
    });
    await waitFor(() => listComments(bob.doc).length === 1, 'commentaire chez Bob');

    addReply(bob.doc, id, { id: randomUUID(), authorUserGroupId: 999, authorName: 'Directeur', body: 'OK', mentions: [] });
    setCommentResolved(bob.doc, id, true, 'Directeur');
    const comment = bob.doc.getMap<Y.Map<unknown>>(COMMENTS_KEY).get(id)!;
    comment.set('authorName', 'Bob usurpe Alice');
    comment.set('authorUserGroupId', BOB.userGroupId);

    await waitFor(() => {
      const c = liveComments(6)[0];
      return c?.replies[0]?.authorName === BOB.fullName && c.resolvedByName === BOB.fullName && c.authorName === ALICE.fullName;
    }, 'corrections serveur');
    const c = liveComments(6)[0];
    expect(c).toMatchObject({
      authorUserGroupId: ALICE.userGroupId,
      authorName: ALICE.fullName,
      resolved: true,
      resolvedByName: BOB.fullName,
    });
    expect(c.replies[0]).toMatchObject({ authorUserGroupId: BOB.userGroupId, authorName: BOB.fullName });
    await waitFor(() => listComments(bob.doc)[0]?.authorName === ALICE.fullName, 'correction diffusée à Bob');

    // Réouverture : le nom du résolveur est effacé quoi qu'envoie le client.
    comment.doc!.transact(() => {
      comment.set('resolved', false);
      comment.set('resolvedByName', 'Fantôme');
    });
    await waitFor(() => liveComments(6)[0]?.resolved === false && liveComments(6)[0]?.resolvedByName === null, 'réouverture');
    expect(alice.close).toBeNull();
    expect(bob.close).toBeNull();
  });

  it('mutation serveur (code de confiance) : auteur conservé tel quel', async () => {
    addDoc(6);
    const id = randomUUID();
    await h.service.mutateDocument(
      6,
      (doc) =>
        addComment(doc, { id, authorUserGroupId: 77, authorName: 'Import DOCX', body: 'c', anchorText: 'x', mentions: [] }),
      authUser(CARL),
    );
    expect(liveComments(6)[0]).toMatchObject({ authorUserGroupId: 77, authorName: 'Import DOCX' });
  });
});

describe('(i) limite par IP et proxy de confiance', () => {
  const xff = (value: string) => ({ 'x-forwarded-for': value });

  it('par défaut, X-Forwarded-For est ignoré (adresse du socket)', async () => {
    await restart({ maxConnectionsPerIp: 1 });
    const a = await h.client('1', xff('10.0.0.1')).open();
    const b = await h.client('1', xff('10.0.0.2')).open();
    expect(a.upgradeError).toBeNull();
    expect(b.upgradeError).toMatch(/429/);
  });

  it('proxy de confiance (COLLAB_TRUST_PROXY=1) : adresse lue à droite de la chaîne', async () => {
    await restart({ maxConnectionsPerIp: 1 }, { COLLAB_TRUST_PROXY: '1' });
    const a = await h.client('1', xff('10.0.0.1')).open();
    const b = await h.client('1', xff('10.0.0.2')).open();
    const c = await h.client('1', xff('10.0.0.1')).open();
    expect(a.upgradeError).toBeNull();
    expect(b.upgradeError).toBeNull();
    expect(c.upgradeError).toMatch(/429/);
  });

  it('valeur forgée à gauche de la chaîne : ignorée', async () => {
    await restart({ maxConnectionsPerIp: 1, trustProxy: 1 });
    const a = await h.client('1', xff('1.1.1.1, 10.0.0.9')).open();
    const b = await h.client('1', xff('2.2.2.2, 10.0.0.9')).open();
    expect(a.upgradeError).toBeNull();
    expect(b.upgradeError).toMatch(/429/);
  });

  it('valeur invalide : ignorée (adresse du socket)', async () => {
    await restart({ maxConnectionsPerIp: 1, trustProxy: 1 });
    const a = await h.client('1', xff('pas-une-ip')).open();
    const b = await h.client('1', xff('10.0.0.1:8080')).open();
    expect(a.upgradeError).toBeNull();
    expect(b.upgradeError).toMatch(/429/);
  });

  it('COLLAB_TRUST_PROXY invalide : désactivé', async () => {
    await restart({ maxConnectionsPerIp: 1 }, { COLLAB_TRUST_PROXY: 'oui' });
    const a = await h.client('1', xff('10.0.0.1')).open();
    const b = await h.client('1', xff('10.0.0.2')).open();
    expect(a.upgradeError).toBeNull();
    expect(b.upgradeError).toMatch(/429/);
  });
});

describe('(j) réévaluation des droits des connexions ouvertes', () => {
  async function writeIgnored(c: TestClient, text: string): Promise<void> {
    const before = c.syncStatuses.filter((s) => !s).length;
    c.doc.getText(FIELD).insert(0, text);
    await waitFor(() => c.syncStatuses.filter((s) => !s).length > before, 'acquittement négatif');
  }

  it('document gelé pendant la session : passage en lecture seule au balayage', async () => {
    const row = addDoc(1, { state: stateWithText('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    row.isFrozen = true;
    h.service.sweep();
    await h.service.revalidateAccess();
    await writeIgnored(alice, 'X');
    expect(textOf(h.service.getLiveState(1))).toBe('base');
    expect(alice.close).toBeNull();
  });

  it('niveau abaissé sous 3 : lecture seule ; droit retiré : fermeture 4401', async () => {
    const row = addDoc(1, { state: stateWithText('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const bob = await h.client('1').connect(jwtFor(BOB));
    row.levels = { [ALICE.sub]: 2 }; // Bob perd tout accès, Alice passe en lecture
    await h.service.revalidateAccess();
    await waitFor(() => bob.close !== null, 'fermeture de Bob');
    expect(bob.close).toEqual({ code: CollabCloseCode.Unauthorized, reason: 'unauthorized' });
    await writeIgnored(alice, 'X');
    expect(textOf(h.service.getLiveState(1))).toBe('base');
    expect(alice.close).toBeNull();
  });

  it('charge bornée : un seul calcul par (document, utilisateur) et par balayage', async () => {
    addDoc(1);
    await h.client('1').connect(jwtFor(ALICE));
    await h.client('1').connect(jwtFor(ALICE));
    await h.client('1').connect(jwtFor(BOB));
    h.documents.canAccess.mockClear();
    await h.service.revalidateAccess();
    expect(h.documents.canAccess).toHaveBeenCalledTimes(2);
  });

  it('panne de la base pendant le balayage : mode conservé', async () => {
    addDoc(1, { state: stateWithText('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    h.documents.canAccess.mockRejectedValueOnce(new Error('base indisponible'));
    await h.service.revalidateAccess();
    alice.doc.getText(FIELD).insert(4, '!');
    await waitFor(() => textOf(h.service.getLiveState(1)) === 'base!', 'écriture toujours acceptée');
  });

  it('renouvellement de jeton : droits recalculés (gel => lecture seule, retrait => 4401)', async () => {
    const row = addDoc(1, { state: stateWithText('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const bob = await h.client('1').connect(jwtFor(BOB));
    row.isFrozen = true;
    alice.send(alice.authMessage(jwtFor(ALICE, '2h')));
    await sleep(100);
    await writeIgnored(alice, 'X');
    expect(textOf(h.service.getLiveState(1))).toBe('base');
    expect(alice.close).toBeNull();

    row.levels = { [ALICE.sub]: 3 };
    bob.send(bob.authMessage(jwtFor(BOB, '2h')));
    await waitFor(() => bob.close !== null, 'fermeture de Bob');
    expect(bob.close?.code).toBe(CollabCloseCode.Unauthorized);
  });
});

describe('(k) mutation serveur bornée et réinitialisation sûre', () => {
  it('mutation qui dépasserait la taille maximale : refus propre, salle et collaborateurs intacts', async () => {
    await restart({ maxStateBytes: 4 * 1024, maxMessageBytes: 64 * 1024 });
    addDoc(7, { state: stateWithText('base') });
    const alice = await h.client('7').connect(jwtFor(ALICE));
    await expect(
      h.service.mutateDocument(7, (doc) => doc.getText(FIELD).insert(0, 'z'.repeat(8 * 1024)), authUser(BOB)),
    ).rejects.toThrow(/trop volumineux/);
    expect(textOf(h.service.getLiveState(7))).toBe('base');
    expect(alice.close).toBeNull();
    alice.doc.getText(FIELD).insert(4, '!');
    await waitFor(() => textOf(h.service.getLiveState(7)) === 'base!', 'édition toujours possible');
    await sleep(100);
    for (const s of h.persistence.saves) expect(textOf(s.state)).not.toContain('zzz');
  });

  it('resetRoom pendant une sauvegarde : attend sa fin, rien de périmé ensuite ; appel répété sans effet', async () => {
    await restart({ idleVersionIntervalMs: 0 });
    addDoc(7, { state: stateWithText('ancien') });
    const alice = await h.client('7').connect(jwtFor(ALICE));
    let release!: () => void;
    h.persistence.saveGate = new Promise<void>((r) => {
      release = r;
    });
    alice.doc.getText(FIELD).insert(0, 'brouillon ');
    await waitFor(() => h.persistence.savesStarted > 0, 'sauvegarde engagée');

    let resetDone = false;
    const resets = Promise.all([h.service.resetRoom(7), h.service.resetRoom(7)]).then(() => {
      resetDone = true;
      h.persistence.events.push('reset');
    });
    await waitFor(() => alice.close !== null, 'fermeture Reload');
    expect(alice.close).toEqual({ code: CollabCloseCode.Reload, reason: 'reload' });
    await sleep(100);
    expect(resetDone).toBe(false); // la sauvegarde en cours n'est pas terminée
    release();
    await resets;
    // La sauvegarde engagée se termine AVANT la fin du reset ; ni version ni notification ensuite.
    expect(h.persistence.events).toEqual(['save', 'reset']);
    await h.service.resetRoom(7); // troisième appel, sans salle : sans effet
    await sleep(100);
    await h.service.drainTasks();
    expect(h.persistence.versions).toHaveLength(0);
    expect(h.persistence.mentions).toHaveLength(0);

    h.persistence.saveGate = null;
    h.persistence.working.delete(7); // la restauration (T2) remplace l'état de travail
    h.rows.get(7)!.state = stateWithText('restauré');
    const b = await h.client('7').connect(jwtFor(BOB));
    expect(b.text).toBe('restauré');
  });
});

// ------------------------------------------------------------------------------------------
// Structure du contenu (correction bloquante du lot 4b) : mise à jour bien formée, sans
// dépendance manquante, mais non conforme au schéma de l'éditeur (Y.XmlText à la racine,
// imbrication excessive, texte nu dans le fragment…).

function fragmentOf(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(EDITOR_FRAGMENT);
}

function decodeDoc(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

function isValidState(state: Uint8Array | null): boolean {
  return validateYDocStructure(decodeDoc(state)).ok;
}

/** Contenu du fragment (XML), pour comparer des états. */
function contentOf(state: Uint8Array | null): string {
  return fragmentOf(decodeDoc(state)).toString();
}

function stateWithParagraph(text: string): Uint8Array {
  const doc = new Y.Doc();
  insertParagraph(doc, text);
  return Y.encodeStateAsUpdate(doc);
}

/** `depth` blockquote imbriqués dans `parent` (une transaction), un paragraphe au plus profond. */
function nestBlockquotes(doc: Y.Doc, parent: Y.XmlFragment | Y.XmlElement, depth: number): Y.XmlElement {
  let deepest!: Y.XmlElement;
  doc.transact(() => {
    let current: Y.XmlFragment | Y.XmlElement = parent;
    for (let i = 0; i < depth; i += 1) {
      const quote = new Y.XmlElement('blockquote');
      current.insert(current.length, [quote]);
      current = quote;
    }
    current.insert(0, [new Y.XmlElement('paragraph')]);
    deepest = current as Y.XmlElement;
  });
  return deepest;
}

/** Aucune écriture (état de travail, version) d'un état non conforme. */
function expectNothingInvalidPersisted(): void {
  for (const s of h.persistence.saves) expect(isValidState(s.state)).toBe(true);
  for (const v of h.persistence.versions) expect(isValidState(v.state)).toBe(true);
  for (const w of h.persistence.working.values()) expect(isValidState(w)).toBe(true);
}

/** Exceptions non gérées pendant un test. */
function trapUnhandled(): { errors: unknown[]; restore: () => void } {
  const errors: unknown[] = [];
  const on = (error: unknown) => errors.push(error);
  process.on('unhandledRejection', on);
  process.on('uncaughtException', on);
  return {
    errors,
    restore: () => {
      process.off('unhandledRejection', on);
      process.off('uncaughtException', on);
    },
  };
}

describe('(l) structure du contenu validée avant application', () => {
  async function aliceAndBob(): Promise<{ alice: TestClient; bob: TestClient }> {
    addDoc(1, { state: stateWithParagraph('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const bob = await h.client('1').connect(jwtFor(BOB));
    return { alice, bob };
  }

  /** Le fautif est fermé en 4409 ; la salle, Bob et la persistance restent sains ; Bob continue. */
  async function expectRejectedAndRoomHealthy(alice: TestClient, bob: TestClient, liveBefore: string): Promise<void> {
    await waitFor(() => alice.close !== null, 'fermeture du client fautif');
    expect(alice.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'structure' });
    const live = h.service.getLiveState(1);
    expect(isValidState(live)).toBe(true);
    expect(contentOf(live)).toBe(liveBefore);
    await sleep(50);
    expect(bob.close).toBeNull();
    expect(validateYDocStructure(bob.doc).ok).toBe(true); // rien de non conforme ne lui a été diffusé
    expect(fragmentOf(bob.doc).toString()).toBe(liveBefore);

    // Bob continue (frappe + nouveau paragraphe) : autosave puis version de fermeture saines.
    const bobText = (fragmentOf(bob.doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    bobText.insert(4, ' bob');
    insertParagraph(bob.doc, 'suite');
    await waitFor(() => h.persistence.saves.some((s) => contentOf(s.state).includes('suite')), 'autosave');
    await bob.closeAndWait();
    await waitFor(() => h.service.getLiveState(1) === null, 'déchargement');
    await h.service.drainTasks();
    expect(h.persistence.versions.map((v) => v.reason)).toEqual(['close']);
    expect(contentOf(h.persistence.versions[0].state)).toContain('base bob');
    expectNothingInvalidPersisted();
    expect(h.service.getStructureStats().rejected).toBe(1);
  }

  it.each([
    ['update', (c: TestClient, u: Uint8Array) => c.updateMessage(u)],
    ['sync step 2', (c: TestClient, u: Uint8Array) => c.step2Message(u)],
  ])('Y.XmlText seul à la racine du fragment (%s) : refusé AVANT application, 4409, collaborateurs sains', async (_label, frame) => {
    const trap = trapUnhandled();
    try {
      const { alice, bob } = await aliceAndBob();
      const before = contentOf(h.service.getLiveState(1));
      alice.goOffline();
      const updates = recordUpdates(alice.doc);
      fragmentOf(alice.doc).insert(0, [new Y.XmlText('poison')]);
      expect(updates).toHaveLength(1);
      expect(updates[0].byteLength).toBeLessThan(64); // quelques dizaines d'octets suffisent
      alice.send(frame(alice, updates[0]));
      await expectRejectedAndRoomHealthy(alice, bob, before);
    } finally {
      trap.restore();
    }
    expect(trap.errors).toEqual([]);
  });

  it('3000 blockquote imbriqués : refusés (pas de dépassement de pile), rien de diffusé ni persisté', async () => {
    const trap = trapUnhandled();
    try {
      const { alice, bob } = await aliceAndBob();
      const before = contentOf(h.service.getLiveState(1));
      nestBlockquotes(alice.doc, fragmentOf(alice.doc), 3000); // envoyé par le client
      await expectRejectedAndRoomHealthy(alice, bob, before);
    } finally {
      trap.restore();
    }
    expect(trap.errors).toEqual([]);
  });

  it('client malveillant en plusieurs messages : profondeur cumulée, refus du message qui dépasse', async () => {
    const { alice, bob } = await aliceAndBob();
    const deepest = nestBlockquotes(alice.doc, fragmentOf(alice.doc), 40); // conforme : accepté
    await waitFor(() => fragmentOf(bob.doc).length === 2, 'diffusion du 1er message');
    expect(alice.close).toBeNull();
    const accepted = contentOf(h.service.getLiveState(1));
    nestBlockquotes(alice.doc, deepest, 40); // 2e message : profondeur totale > 64
    await expectRejectedAndRoomHealthy(alice, bob, accepted);
  });

  it('client malveillant en plusieurs messages : texte nu forgé à la racine (parent implicite)', async () => {
    const { alice, bob } = await aliceAndBob();
    insertParagraph(alice.doc, 'deuxième'); // 1er message conforme
    await waitFor(() => fragmentOf(bob.doc).length === 2, 'diffusion du 1er message');
    const accepted = contentOf(h.service.getLiveState(1));
    // 2e message : texte inséré « à côté » d'un paragraphe, directement dans le fragment.
    const forger = new Y.Doc();
    const root = forger.getText(EDITOR_FRAGMENT);
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(alice.doc));
    const updates = recordUpdates(forger);
    root.insert(root.length, 'texte nu');
    alice.send(alice.updateMessage(updates[0]));
    await expectRejectedAndRoomHealthy(alice, bob, accepted);
  });

  it('suppressions concurrentes valides seules, invalides fusionnées : 2e refusée, fermée en 4409 « structure », 1re intacte', async () => {
    const base = new Y.Doc();
    base.transact(() => {
      const quote = new Y.XmlElement('blockquote');
      fragmentOf(base).insert(0, [quote]);
      for (const text of ['un', 'deux']) {
        const paragraph = new Y.XmlElement('paragraph');
        quote.insert(quote.length, [paragraph]);
        const xmlText = new Y.XmlText();
        paragraph.insert(0, [xmlText]);
        xmlText.insert(0, text);
      }
    });
    addDoc(1, { state: Y.encodeStateAsUpdate(base) });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const bob = await h.client('1').connect(jwtFor(BOB));
    alice.goOffline();
    bob.goOffline();
    const aliceUpdates = recordUpdates(alice.doc);
    const bobUpdates = recordUpdates(bob.doc);
    (fragmentOf(alice.doc).get(0) as Y.XmlElement).delete(0, 1); // seule : citation à 1 élément, valide
    (fragmentOf(bob.doc).get(0) as Y.XmlElement).delete(1, 1); // seule : valide aussi
    expect(aliceUpdates).toHaveLength(1);
    expect(bobUpdates).toHaveLength(1);

    alice.send(alice.updateMessage(aliceUpdates[0]));
    await waitFor(() => !contentOf(h.service.getLiveState(1)).includes('un'), 'suppression de A appliquée');
    const afterAlice = contentOf(h.service.getLiveState(1));
    expect(isValidState(h.service.getLiveState(1))).toBe(true);

    bob.send(bob.updateMessage(bobUpdates[0])); // fusionnée : citation vide, invalide
    await waitFor(() => bob.close !== null, 'fermeture du client fautif');
    expect(bob.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'structure' });
    expect(contentOf(h.service.getLiveState(1))).toBe(afterAlice);
    expect(isValidState(h.service.getLiveState(1))).toBe(true);
    await sleep(50);
    expect(alice.close).toBeNull();
    expect(h.service.getStructureStats().rejected).toBe(1);

    // A continue et tout ce qui est persisté reste valide.
    alice.goOnline();
    insertParagraph(alice.doc, 'suite');
    await waitFor(() => h.persistence.saves.some((s) => contentOf(s.state).includes('suite')), 'autosave');
    await alice.closeAndWait();
    await waitFor(() => h.service.getLiveState(1) === null, 'déchargement');
    await h.service.drainTasks();
    expectNothingInvalidPersisted();
  });

  it('mise à jour structurelle trop volumineuse : refusée avant validation, 4409 « structure »', async () => {
    await restart({ maxStructuralUpdateBytes: 1024 });
    const { alice, bob } = await aliceAndBob();
    const before = contentOf(h.service.getLiveState(1));
    const checks = h.service.getStructureStats().updateChecks;
    alice.goOffline();
    const updates = recordUpdates(alice.doc);
    insertParagraph(alice.doc, 'x'.repeat(4096)); // structurel (nouveau paragraphe) et > 1 Kio
    alice.send(alice.updateMessage(updates[0]));
    await waitFor(() => alice.close !== null, 'fermeture');
    expect(alice.close).toEqual({ code: CollabCloseCode.PolicyViolation, reason: 'structure' });
    expect(contentOf(h.service.getLiveState(1))).toBe(before);
    expect(h.service.getStructureStats().updateChecks).toBe(checks);
    expect(bob.close).toBeNull();
  });

  it('coût : aucune validation pour la frappe de texte ni les commentaires, une par message structurel', async () => {
    addDoc(1, { state: stateWithParagraph('base') });
    const alice = await h.client('1').connect(jwtFor(ALICE));
    const start = h.service.getStructureStats();
    const text = (fragmentOf(alice.doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    for (const ch of ' et la suite') text.insert(text.length, ch);
    text.delete(0, 2);
    addComment(alice.doc, {
      id: randomUUID(),
      authorUserGroupId: ALICE.userGroupId,
      authorName: ALICE.fullName,
      body: 'Remarque',
      anchorText: 'x',
      mentions: [],
    });
    await waitFor(
      () => h.persistence.saves.some((s) => contentOf(s.state).includes('se et la suite') && listComments(decodeDoc(s.state)).length === 1),
      'frappe et commentaire persistés',
    );
    expect(h.service.getStructureStats().updateChecks).toBe(start.updateChecks); // 14 messages, 0 validation

    insertParagraph(alice.doc, 'nouveau'); // « Entrée » : structurel
    await waitFor(() => h.persistence.saves.some((s) => contentOf(s.state).includes('nouveau')), 'paragraphe persisté');
    const end = h.service.getStructureStats();
    expect(end.updateChecks).toBe(start.updateChecks + 1);
    expect(end.rejected).toBe(0);
    // Avant écriture, l'état vivant est revalidé au plus une fois par sauvegarde (debounce).
    expect(end.liveChecks - start.liveChecks).toBeLessThanOrEqual(h.persistence.saves.length);
    expect(alice.close).toBeNull();
  });

  it('état persisté non conforme : chargement refusé, rien d’écrit ; restauration d’un état valide possible', async () => {
    const poisoned = new Y.Doc();
    fragmentOf(poisoned).insert(0, [new Y.XmlText('poison')]);
    addDoc(2, { state: Y.encodeStateAsUpdate(poisoned) });
    const alice = await h.client('2').connect(jwtFor(ALICE));
    await waitFor(() => alice.close !== null, 'refus');
    expect(alice.close?.code).toBe(CollabCloseCode.Unauthorized);
    expect(alice.synced).toBe(false);
    expect(h.service.getLiveState(2)).toBeNull();
    await expect(h.service.mutateDocument(2, (d) => insertParagraph(d, 'x'), authUser(BOB))).rejects.toThrow();
    await sleep(100);
    await h.service.drainTasks();
    expect(h.persistence.saves).toHaveLength(0);
    expect(h.persistence.versions).toHaveLength(0);

    h.rows.get(2)!.state = stateWithParagraph('restauré'); // restauration d'une version (T2)
    const bob = await h.client('2').connect(jwtFor(BOB));
    expect(fragmentOf(bob.doc).toString()).toBe('<paragraph>restauré</paragraph>');
  });

  it('mutation serveur non conforme : refus propre, salle et collaborateurs intacts', async () => {
    const { alice, bob } = await aliceAndBob();
    const before = contentOf(h.service.getLiveState(1));
    await expect(
      h.service.mutateDocument(1, (d) => fragmentOf(d).insert(0, [new Y.XmlText('poison')]), authUser(CARL)),
    ).rejects.toThrow(/non conforme/);
    expect(contentOf(h.service.getLiveState(1))).toBe(before);
    expect(alice.close).toBeNull();
    expect(bob.close).toBeNull();
    insertParagraph(alice.doc, 'après');
    await waitFor(() => contentOf(h.service.getLiveState(1)).includes('après'), 'édition toujours possible');
    expectNothingInvalidPersisted();
  });

  it('filet : état non conforme injecté hors protocole => rien persisté ni remis, salle rechargée (4410)', async () => {
    const { alice, bob } = await aliceAndBob();
    insertParagraph(bob.doc, 'sauvé');
    await waitFor(() => h.persistence.saves.some((s) => contentOf(s.state).includes('sauvé')), 'autosave valide');
    const savesBefore = h.persistence.saves.length;
    // Injection directe dans la salle vivante (contourne beforeSync : voie « impossible »).
    const doc = h.service.hocuspocus.documents.get('1')!;
    fragmentOf(doc).insert(0, [new Y.XmlText('poison')]);
    await waitFor(() => alice.close !== null && bob.close !== null, 'rechargement des clients');
    expect(alice.close).toEqual({ code: CollabCloseCode.Reload, reason: 'reload' });
    expect(bob.close?.code).toBe(CollabCloseCode.Reload);
    expect(h.service.getLiveState(1)).toBeNull();
    await sleep(100);
    await h.service.drainTasks();
    expect(h.persistence.saves).toHaveLength(savesBefore);
    expect(h.persistence.versions).toHaveLength(0);
    expectNothingInvalidPersisted();

    // Reconnexion : dernier état persisté, valide.
    const carlRow = h.rows.get(1)!;
    carlRow.levels[CARL.sub] = 3;
    const carl = await h.client('1').connect(jwtFor(CARL));
    expect(validateYDocStructure(carl.doc).ok).toBe(true);
    expect(fragmentOf(carl.doc).toString()).toContain('sauvé');
  });
});

// ------------------------------------------------------------------------------------------
// Compatibilité avec le VRAI client du web (`@hocuspocus/provider`, devDependency de apps/api) :
// toujours exécuté (plus de repli `describe.skip`).

describe('(e) compatibilité @hocuspocus/provider', () => {
  const providers: HocuspocusProvider[] = [];
  afterEach(() => {
    for (const p of providers.splice(0)) p.destroy();
  });

  function provider(name: string, token: string, extra: Record<string, unknown> = {}): HocuspocusProvider {
    const p = new HocuspocusProvider({
      url: h.url,
      name,
      token,
      WebSocketPolyfill: WebSocket,
      ...extra,
    } as ConstructorParameters<typeof HocuspocusProvider>[0]);
    providers.push(p);
    return p;
  }

  it('deux providers réels : écriture, lecture seule et convergence', async () => {
    addDoc(4, { levels: { [ALICE.sub]: 3, [BOB.sub]: 2 }, state: stateWithText('Départ') });
    const writer = provider('4', jwtFor(ALICE));
    const reader = provider('4', jwtFor(BOB));
    await waitFor(() => writer.isSynced && reader.isSynced, 'synchronisation des providers');
    expect(writer.authorizedScope).toBe('read-write');
    expect(reader.authorizedScope).toBe('readonly');
    expect(reader.document.getText(FIELD).toString()).toBe('Départ');

    writer.document.getText(FIELD).insert(6, ' commun');
    await waitFor(() => reader.document.getText(FIELD).toString() === 'Départ commun', 'diffusion');

    reader.document.getText(FIELD).insert(0, 'X'); // ignoré par le serveur
    await sleep(150);
    expect(textOf(h.service.getLiveState(4))).toBe('Départ commun');
    expect(writer.document.getText(FIELD).toString()).toBe('Départ commun');
  });

  it('jeton invalide : authenticationFailed avec la raison uniforme', async () => {
    addDoc(4);
    let reason: string | null = null;
    provider('4', 'mauvais-jeton', {
      onAuthenticationFailed: ({ reason: r }: { reason: string }) => {
        reason = r;
      },
    });
    await waitFor(() => reason !== null, 'échec d’authentification');
    expect(reason).toBe('permission-denied');
  });
});
