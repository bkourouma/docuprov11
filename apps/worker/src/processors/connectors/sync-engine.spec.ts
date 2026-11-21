// Moteur de synchronisation : Prisma, connecteur, coffre et file IA SIMULÉS en mémoire (aucun
// accès réseau ni disque).
import { createHash } from 'node:crypto';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ChangePage,
  type OriginAcl,
  type RemoteItem,
  type SourceConnector,
} from '@archivage/connectors';
import {
  GedSourceConnectorStatus,
  GedSourceItemState,
  GedSourceMode,
  GedSyncRunStatus,
} from '@archivage/types';
import {
  NO_GRANT_MESSAGE,
  RUN_STALE_AFTER_MS,
  runConnectorSync,
  type ConnectorPatch,
  type ConnectorRow,
  type ItemPatch,
  type ItemProvenance,
  type ItemRow,
  type RunPatch,
  type SyncDeps,
  type SyncStore,
} from './sync-engine';

const S = GedSourceItemState;

// ---------------------------------------------------------------------------
// Base simulée
// ---------------------------------------------------------------------------

interface StoredItem extends ItemRow {
  connectorId: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  errorMessage: string | null;
  indexedAt: Date | null;
  originAcl: unknown;
  originMetadata: Record<string, unknown> | null;
  name: string;
}
interface StoredRun {
  id: bigint;
  connectorId: number;
  startedAt: Date;
  status: number;
  finishedAt: Date | null;
  tokenBefore: string | null;
  tokenAfter: string | null;
  errorMessage: string | null;
  counters: Partial<Record<string, number>>;
}
interface StoredConnector {
  changeToken: string | null;
  status: number;
  lastError: string | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
}

class MemStore implements SyncStore {
  items: StoredItem[] = [];
  runs: StoredRun[] = [];
  connectors = new Map<number, StoredConnector>();
  private seq = 1n;
  clock: () => Date = () => new Date('2026-11-20T10:00:00Z');

  connector(id: number): StoredConnector {
    if (!this.connectors.has(id)) {
      this.connectors.set(id, {
        changeToken: null,
        status: 1,
        lastError: null,
        lastSyncAt: null,
        lastSuccessAt: null,
      });
    }
    return this.connectors.get(id)!;
  }
  item(connectorId: number, externalId: string): StoredItem {
    const it = this.items.find((i) => i.connectorId === connectorId && i.externalId === externalId);
    if (!it) throw new Error(`élément absent : ${externalId}`);
    return it;
  }
  seed(connectorId: number, externalId: string, patch: Partial<StoredItem> = {}): StoredItem {
    const it: StoredItem = {
      id: this.seq++,
      externalId,
      state: S.Copie,
      documentId: null,
      contentHash: null,
      remoteVersion: null,
      duplicateOfId: null,
      connectorId,
      firstSeenAt: this.clock(),
      lastSeenAt: this.clock(),
      errorMessage: null,
      indexedAt: null,
      originAcl: null,
      originMetadata: null,
      name: externalId,
      ...patch,
    };
    this.items.push(it);
    return it;
  }

  async findOpenRuns(connectorId: number) {
    return this.runs
      .filter((r) => r.connectorId === connectorId && r.status === GedSyncRunStatus.EnCours)
      .map((r) => ({ id: r.id, startedAt: r.startedAt }));
  }
  async createRun(connectorId: number, startedAt: Date, tokenBefore: string | null) {
    const run: StoredRun = {
      id: this.seq++,
      connectorId,
      startedAt,
      status: GedSyncRunStatus.EnCours,
      finishedAt: null,
      tokenBefore,
      tokenAfter: null,
      errorMessage: null,
      counters: {},
    };
    this.runs.push(run);
    return run.id;
  }
  async deleteRun(runId: bigint) {
    this.runs = this.runs.filter((r) => r.id !== runId);
  }
  async updateRun(runId: bigint, patch: RunPatch) {
    const run = this.runs.find((r) => r.id === runId)!;
    const { status, finishedAt, changeTokenAfter, errorMessage, ...counters } = patch;
    if (status !== undefined) run.status = status;
    if (finishedAt !== undefined) run.finishedAt = finishedAt;
    if (changeTokenAfter !== undefined) run.tokenAfter = changeTokenAfter;
    if (errorMessage !== undefined) run.errorMessage = errorMessage;
    Object.assign(run.counters, counters);
  }
  async setChangeToken(connectorId: number, token: string) {
    this.connector(connectorId).changeToken = token;
  }
  async updateConnector(connectorId: number, patch: ConnectorPatch) {
    Object.assign(this.connector(connectorId), patch);
  }
  async findItem(connectorId: number, externalId: string) {
    return (
      this.items.find((i) => i.connectorId === connectorId && i.externalId === externalId) ?? null
    );
  }
  async upsertItem(connectorId: number, externalId: string, p: ItemProvenance, now: Date) {
    let it = this.items.find((i) => i.connectorId === connectorId && i.externalId === externalId);
    if (!it) it = this.seed(connectorId, externalId, { state: S.Decouvert, firstSeenAt: now });
    it.lastSeenAt = now;
    it.name = p.name;
    it.originMetadata = p.originMetadata;
    if ('originAcl' in p) it.originAcl = p.originAcl;
    return it;
  }
  async touchItem(itemId: bigint, now: Date) {
    this.items.find((i) => i.id === itemId)!.lastSeenAt = now;
  }
  async updateItem(itemId: bigint, patch: ItemPatch) {
    Object.assign(this.items.find((i) => i.id === itemId)!, patch);
  }
  async findDuplicateOriginal(hash: string, excludeId: bigint) {
    const found = this.items
      .filter(
        (i) =>
          i.contentHash === hash &&
          i.id !== excludeId &&
          (i.state === S.Copie || i.state === S.IndexeEnPlace),
      )
      .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || Number(a.id - b.id))[0];
    return found ? { id: found.id } : null;
  }
  async markDeleted(connectorId: number, ids: string[]) {
    let n = 0;
    for (const it of this.items) {
      if (
        it.connectorId === connectorId &&
        ids.includes(it.externalId) &&
        it.state !== S.SupprimeSource
      ) {
        it.state = S.SupprimeSource;
        n++;
      }
    }
    return n;
  }
  async listKnownItems(
    connectorId: number,
    states: number[],
    afterId: bigint | null,
    limit: number,
  ) {
    return this.items
      .filter(
        (i) =>
          i.connectorId === connectorId &&
          states.includes(i.state) &&
          (afterId == null || i.id > afterId),
      )
      .sort((a, b) => Number(a.id - b.id))
      .slice(0, limit)
      .map((i) => ({ id: i.id, externalId: i.externalId }));
  }
}

// ---------------------------------------------------------------------------
// Connecteur simulé
// ---------------------------------------------------------------------------

type PageScript = ChangePage | Error;

class FakeConnector implements SourceConnector {
  readonly type = 'fake';
  pages = new Map<string, PageScript>();
  files = new Map<string, Buffer | Error>();
  acls = new Map<string, OriginAcl | null>();
  listCalls: Array<{ since: string | null; pageSize: number }> = [];
  fetched: string[] = [];
  authError: Error | null = null;
  missing: string[] | ((known: string[]) => string[]) = [];
  findMissingCalls: string[][] = [];
  findMissing?: (known: string[]) => Promise<string[]>;

  /** `findMissing` est optionnel dans l'interface : on ne l'expose que si le test le demande. */
  enableFindMissing(): void {
    this.findMissing = async (known) => {
      this.findMissingCalls.push(known);
      return typeof this.missing === 'function' ? this.missing(known) : this.missing;
    };
  }

  async authenticate() {
    if (this.authError) throw this.authError;
  }
  async listChanges(since: string | null, opts: { pageSize: number }) {
    this.listCalls.push({ since, pageSize: opts.pageSize });
    const page = this.pages.get(since ?? 'START');
    if (!page) throw new Error(`page non scriptée : ${since}`);
    if (page instanceof Error) throw page;
    return page;
  }
  async fetchFile(item: RemoteItem) {
    this.fetched.push(item.externalId);
    const f = this.files.get(item.externalId);
    if (f instanceof Error) throw f;
    if (!f) throw new Error(`fichier non scripté : ${item.externalId}`);
    return { bytes: f };
  }
  async readOriginAcl(item: RemoteItem) {
    return this.acls.get(item.externalId) ?? null;
  }
  async close() {}
}

/** `item('a')` désigne le fichier `a.txt` (identifiant externe = nom), `item('x.exe')` reste tel quel. */
const item = (
  shortName: string,
  remoteVersion = 'v1',
  extra: Partial<RemoteItem> = {},
): RemoteItem => {
  const name = shortName.includes('.') ? shortName : `${shortName}.txt`;
  return { externalId: name, name, remoteVersion, ...extra };
};
const page = (
  items: RemoteItem[],
  nextToken: string | null,
  hasMore = false,
  deletedExternalIds: string[] = [],
): ChangePage => ({ items, deletedExternalIds, nextToken, hasMore });
const acl = (...principals: string[]): OriginAcl => ({
  entries: principals.map((p) => ({ principal: p, kind: 'user', access: 'read' })),
});

// ---------------------------------------------------------------------------
// Harnais
// ---------------------------------------------------------------------------

const RIGHTS = { rights: { principalMap: { 'a@x.org': 11, 'b@x.org': 12, 'c@x.org': 13 } } };

interface Harness {
  store: MemStore;
  conn: FakeConnector;
  deps: SyncDeps;
  created: Array<{
    documentId: number;
    name: string;
    bytes: Buffer;
    grants: unknown[];
    dossierId: number | null;
  }>;
  versions: Array<{ documentId: number; name: string }>;
  enqueueAi: jest.Mock;
  scheduleResume: jest.Mock;
  extractText: jest.Mock;
  mode: number;
  config: unknown;
  run(opts?: {
    credentials?: Record<string, string>;
    connectorId?: number;
  }): ReturnType<typeof runConnectorSync>;
  row(mode: number, config?: unknown, id?: number): ConnectorRow;
}

function harness(
  store = new MemStore(),
  limits?: SyncDeps['limits'],
  docSeq = { n: 100 },
): Harness {
  const conn = new FakeConnector();
  const created: Harness['created'] = [];
  const versions: Harness['versions'] = [];
  const enqueueAi = jest.fn().mockResolvedValue(undefined);
  const scheduleResume = jest.fn().mockResolvedValue(undefined);
  const extractText = jest.fn(async (bytes: Buffer) => bytes.toString('utf8'));
  // Empreinte de la version courante de chaque document : l'ingestion réelle ne recrée pas une
  // version identique (idempotence), la simulation en fait autant.
  const docHashes = new Map<number, string>();
  const hashOf = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const deps: SyncDeps = {
    store,
    ingest: {
      async createDocument(input, grants) {
        const documentId = docSeq.n++;
        docHashes.set(documentId, hashOf(input.bytes));
        // Comme la vraie création imbriquée : l'élément est rattaché dans la même écriture.
        if (input.sourceItemId !== undefined) {
          store.items.find((i) => i.id === input.sourceItemId)!.documentId = documentId;
        }
        created.push({
          documentId,
          name: input.name,
          bytes: input.bytes,
          grants,
          dossierId: input.dossierId,
        });
        return { documentId };
      },
      async addVersion(documentId, input) {
        if (docHashes.get(documentId) === hashOf(input.bytes)) return { documentId };
        docHashes.set(documentId, hashOf(input.bytes));
        versions.push({ documentId, name: input.name });
        return { documentId };
      },
    },
    extractText,
    extractableExtensions: ['.txt', '.pdf'],
    now: () => store.clock(),
    enqueueAi,
    scheduleResume,
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ...(limits ? { limits } : {}),
  };
  const h: Harness = {
    store,
    conn,
    deps,
    created,
    versions,
    enqueueAi,
    scheduleResume,
    extractText,
    mode: GedSourceMode.Copie,
    config: RIGHTS,
    row: (mode, config = RIGHTS, id = 1) => ({
      id,
      label: 'test',
      mode,
      status: 1,
      changeToken: store.connector(id).changeToken,
      targetDossierId: 5,
      config,
    }),
    run: (opts = {}) =>
      runConnectorSync(
        {
          row: h.row(h.mode, h.config, opts.connectorId ?? 1),
          connector: conn,
          credentials: opts.credentials ?? {},
        },
        deps,
      ),
  };
  return h;
}
function setup(h: Harness, mode: number, config: unknown = RIGHTS): Harness {
  h.mode = mode;
  h.config = config;
  return h;
}
/** Un élément lisible par trois personnes, contenu distinct. */
function giveFile(
  h: Harness,
  id: string,
  content = `contenu de ${id}`,
  acls: OriginAcl | null = acl('a@x.org'),
) {
  h.conn.files.set(id.includes('.') ? id : `${id}.txt`, Buffer.from(content));
  h.conn.acls.set(id.includes('.') ? id : `${id}.txt`, acls);
}
const outcome = (r: Awaited<ReturnType<typeof runConnectorSync>>) => {
  if ('skipped' in r) throw new Error('passe ignorée');
  return r;
};

// ---------------------------------------------------------------------------

describe('synchronisation incrémentale', () => {
  it('1re passe complète puis passe avec 1 nouveau, 1 modifié, 1 inchangé (mode synchro)', async () => {
    const h = setup(harness(), GedSourceMode.Synchro);
    ['a', 'b', 'c'].forEach((n) => giveFile(h, n));
    h.conn.pages.set('START', page([item('a'), item('b'), item('c')], 't1'));
    const first = outcome(await h.run());
    expect(first.status).toBe(GedSyncRunStatus.Reussie);
    expect(first.counters).toMatchObject({ itemsSeen: 3, itemsCreated: 3, itemsFailed: 0 });
    expect(h.created).toHaveLength(3);
    expect(h.store.connector(1).changeToken).toBe('t1');
    expect(h.store.connector(1)).toMatchObject({
      status: GedSourceConnectorStatus.Actif,
      lastError: null,
    });
    expect(h.store.connector(1).lastSuccessAt).not.toBeNull();

    // Passe 2 : b modifié (nouveau contenu), c inchangé, d nouveau.
    giveFile(h, 'b', 'contenu de b, version 2');
    giveFile(h, 'd');
    h.conn.fetched.length = 0;
    h.conn.pages.set('t1', page([item('b', 'v2'), item('c', 'v1'), item('d')], 't2'));
    const second = outcome(await h.run());
    expect(second.counters).toMatchObject({ itemsSeen: 3, itemsCreated: 1, itemsUpdated: 1 });
    expect(h.versions).toEqual([
      { documentId: h.store.item(1, 'b.txt').documentId, name: 'b.txt' },
    ]);
    expect(h.conn.fetched.sort()).toEqual(['b.txt', 'd.txt']); // c n'est pas relu
    expect(h.created).toHaveLength(4);
    expect(h.store.item(1, 'c.txt').lastSeenAt).toBeInstanceOf(Date);
    expect(h.store.runs[1]).toMatchObject({ tokenBefore: 't1', tokenAfter: 't2' });
  });

  it('mode synchro : même empreinte malgré une nouvelle version distante = métadonnées seules', async () => {
    const h = setup(harness(), GedSourceMode.Synchro);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    await h.run();
    h.conn.pages.set('t1', page([item('a', 'v2')], 't2'));
    const r = outcome(await h.run());
    expect(h.versions).toHaveLength(0);
    expect(r.counters.itemsUpdated).toBe(0);
    expect(h.store.item(1, 'a.txt')).toMatchObject({ state: S.Copie, remoteVersion: 'v2' });
  });

  it('provenance complète enregistrée avec les droits d’origine bruts', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    const origin = acl('a@x.org');
    giveFile(h, 'a', 'x', origin);
    h.conn.pages.set(
      'START',
      page([item('a', 'v1', { originMetadata: { sujet: 'Facture' } })], null),
    );
    await h.run();
    expect(h.store.item(1, 'a.txt')).toMatchObject({
      originAcl: origin,
      originMetadata: { sujet: 'Facture' },
      remoteVersion: 'v1',
    });
  });
});

describe('reprise et bornes', () => {
  it('jeton persisté page par page : la relance reprend à la bonne page sans retraiter', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    ['a', 'b', 'c'].forEach((n) => giveFile(h, n));
    h.conn.pages.set('START', page([item('a')], 't1', true));
    h.conn.pages.set('t1', page([item('b')], 't2', true));
    h.conn.pages.set('t2', new Error('réseau coupé'));
    const first = outcome(await h.run());
    expect(first.status).toBe(GedSyncRunStatus.Echouee);
    expect(h.store.connector(1)).toMatchObject({
      changeToken: 't2',
      status: GedSourceConnectorStatus.Erreur,
    });
    expect(h.store.runs[0]).toMatchObject({ tokenBefore: null, tokenAfter: 't2' });
    expect(h.store.runs[0]!.finishedAt).not.toBeNull();

    h.conn.listCalls.length = 0;
    h.conn.fetched.length = 0;
    h.conn.pages.set('t2', page([item('c')], 't3'));
    const second = outcome(await h.run());
    expect(second.status).toBe(GedSyncRunStatus.Reussie);
    expect(h.conn.listCalls.map((c) => c.since)).toEqual(['t2']);
    expect(h.conn.fetched).toEqual(['c.txt']);
    expect(h.created.map((c) => c.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('plantage au milieu d’une page : seule cette page est rejouée, sans doublon', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    ['a', 'b'].forEach((n) => giveFile(h, n));
    h.conn.pages.set('START', page([item('a')], 't1', true));
    h.conn.pages.set('t1', page([item('b')], 't2'));
    // Simule un arrêt dur pendant la page 2 : l'élément b lève une erreur d'authentification.
    h.conn.files.set('b.txt', new ConnectorAuthError('jeton révoqué'));
    await h.run();
    expect(h.store.connector(1).changeToken).toBe('t1');
    h.conn.files.set('b.txt', Buffer.from('contenu de b'));
    await h.run();
    expect(h.created.map((c) => c.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('quota : jeton conservé, passe partielle « quota atteint », reprise retardée (bornée)', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1', true));
    h.conn.pages.set('t1', new ConnectorQuotaError('429', 10_000));
    const r = outcome(await h.run());
    expect(r.status).toBe(GedSyncRunStatus.Partielle);
    expect(h.store.runs[0]!.errorMessage).toContain('quota atteint');
    expect(h.store.connector(1).changeToken).toBe('t1');
    expect(h.scheduleResume).toHaveBeenCalledWith(1, 60_000); // plancher 1 min

    h.scheduleResume.mockClear();
    h.conn.pages.set('t1', new ConnectorQuotaError('429', 99 * 3_600_000));
    await h.run();
    expect(h.scheduleResume).toHaveBeenCalledWith(1, 6 * 3_600_000); // plafond 6 h

    h.scheduleResume.mockClear();
    h.conn.pages.set('t1', new ConnectorQuotaError('429'));
    await h.run();
    expect(h.scheduleResume).toHaveBeenCalledWith(1, 15 * 60_000); // défaut 15 min
  });

  it('maxItemsPerRun : arrêt propre, jeton persisté, reprise immédiate, findMissing non appelé', async () => {
    const h = setup(harness(undefined, { maxItemsPerRun: 3, pageSize: 2 }), GedSourceMode.Copie);
    h.conn.enableFindMissing();
    ['a', 'b', 'c', 'd', 'e'].forEach((n) => giveFile(h, n));
    h.conn.pages.set('START', page([item('a'), item('b')], 't1', true));
    h.conn.pages.set('t1', page([item('c'), item('d')], 't2', true));
    h.conn.pages.set('t2', page([item('e')], 't3'));
    const r = outcome(await h.run());
    expect(r.status).toBe(GedSyncRunStatus.Reussie);
    expect(h.conn.listCalls).toEqual([
      { since: null, pageSize: 2 },
      { since: 't1', pageSize: 1 },
    ]);
    expect(h.store.connector(1).changeToken).toBe('t2');
    expect(h.scheduleResume).toHaveBeenCalledWith(1, 0);
    expect(h.conn.findMissingCalls).toHaveLength(0);
  });
});

describe('dédoublonnage par empreinte', () => {
  it('deux sources, même contenu : un seul document, le 2e en Doublon pointant sur le 1er', async () => {
    const store = new MemStore();
    const seq = { n: 100 };
    const h1 = setup(harness(store, undefined, seq), GedSourceMode.Copie);
    const h2 = setup(harness(store, undefined, seq), GedSourceMode.Copie);
    giveFile(h1, 'a', 'même contenu');
    giveFile(h2, 'copie', 'même contenu');
    h1.conn.pages.set('START', page([item('a')], null));
    h2.conn.pages.set('START', page([item('copie')], null));

    await h1.run({ connectorId: 1 });
    store.clock = () => new Date('2026-11-20T11:00:00Z');
    const r2 = outcome(await h2.run({ connectorId: 2 }));

    expect(h1.created.length + h2.created.length).toBe(1);
    const original = store.item(1, 'a.txt');
    const dup = store.item(2, 'copie.txt');
    expect(dup).toMatchObject({ state: S.Doublon, duplicateOfId: original.id, documentId: null });
    expect(dup.contentHash).toBe(original.contentHash);
    expect(r2.counters).toMatchObject({ itemsDuplicate: 1, itemsCreated: 0 });
    expect(h2.enqueueAi).not.toHaveBeenCalled();
  });

  it('l’original supprimé à la source ne casse pas le doublon ; il ne sert plus d’original', async () => {
    const store = new MemStore();
    const seq = { n: 100 };
    const h1 = setup(harness(store, undefined, seq), GedSourceMode.Copie);
    const h2 = setup(harness(store, undefined, seq), GedSourceMode.Copie);
    giveFile(h1, 'a', 'même contenu');
    giveFile(h2, 'copie', 'même contenu');
    h1.conn.pages.set('START', page([item('a')], 't1'));
    h2.conn.pages.set('START', page([item('copie')], null));
    await h1.run({ connectorId: 1 });
    await h2.run({ connectorId: 2 });

    h1.conn.pages.set('t1', page([], 't2', false, ['a.txt']));
    const r = outcome(await h1.run({ connectorId: 1 }));
    expect(r.counters.itemsDeleted).toBe(1);
    expect(store.item(1, 'a.txt').state).toBe(S.SupprimeSource);
    expect(store.item(2, 'copie.txt')).toMatchObject({
      state: S.Doublon,
      duplicateOfId: store.item(1, 'a.txt').id,
    });
  });

  it('l’original est le plus ancien (firstSeenAt, puis id)', async () => {
    const store = new MemStore();
    const t = (h: number) => new Date(`2026-11-20T0${h}:00:00Z`);
    store.seed(1, 'recent', { contentHash: 'H', state: S.Copie, firstSeenAt: t(8) });
    const oldest = store.seed(2, 'ancien', {
      contentHash: 'H',
      state: S.IndexeEnPlace,
      firstSeenAt: t(1),
    });
    store.seed(3, 'doublon', { contentHash: 'H', state: S.Doublon, firstSeenAt: t(0) });
    expect(await store.findDuplicateOriginal('H', 999n)).toEqual({ id: oldest.id });
  });
});

describe('modes copie, synchro et indexation en place', () => {
  it('mode copie : élément modifié à la source = état 3, la copie DocuPro n’est pas écrasée', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    await h.run();
    const original = { ...h.store.item(1, 'a.txt') };
    h.conn.fetched.length = 0;
    h.conn.pages.set('t1', page([item('a', 'v2')], 't2'));
    await h.run();
    expect(h.store.item(1, 'a.txt')).toMatchObject({
      state: S.ModifieSource,
      documentId: original.documentId,
      contentHash: original.contentHash,
      remoteVersion: 'v2',
    });
    expect(h.conn.fetched).toHaveLength(0);
    expect(h.created).toHaveLength(1);
    expect(h.versions).toHaveLength(0);
  });

  it('indexation en place : aucun document, aucune écriture du binaire, texte borné', async () => {
    const h = setup(
      harness(undefined, { maxIndexedTextChars: 10 }),
      GedSourceMode.IndexationEnPlace,
    );
    giveFile(h, 'note', 'abcdefghijklmnopqrstuvwxyz');
    h.conn.files.set('rapport.docx', Buffer.from('binaire'));
    h.conn.pages.set(
      'START',
      page([item('note', 'v1', { originMetadata: { auteur: 'X' } }), item('rapport.docx')], null),
    );
    const r = outcome(await h.run());
    expect(h.created).toHaveLength(0);
    expect(h.enqueueAi).not.toHaveBeenCalled();
    expect(r.counters).toMatchObject({ itemsCreated: 2, itemsFailed: 0 });

    const note = h.store.item(1, 'note.txt');
    expect(note).toMatchObject({ state: S.IndexeEnPlace, documentId: null });
    expect(note.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(note.indexedAt).toBeInstanceOf(Date);
    expect(note.originMetadata).toEqual({
      auteur: 'X',
      indexedText: 'abcdefghij',
      indexedTextTruncated: true,
    });
    // Type sans extraction de texte : indexé sur ses métadonnées, jamais téléchargé.
    expect(h.store.item(1, 'rapport.docx')).toMatchObject({
      state: S.IndexeEnPlace,
      contentHash: null,
    });
    expect(h.conn.fetched).toEqual(['note.txt']);
  });

  it('indexation en place : les droits d’origine sont conservés, rien n’est exigé du mapping', async () => {
    const h = setup(harness(), GedSourceMode.IndexationEnPlace, {});
    const origin = acl('inconnu@x.org');
    giveFile(h, 'note', 'texte', origin);
    h.conn.pages.set('START', page([item('note')], null));
    await h.run();
    expect(h.store.item(1, 'note.txt')).toMatchObject({
      state: S.IndexeEnPlace,
      originAcl: origin,
    });
  });
});

describe('suppression à la source (H3)', () => {
  it('deletedExternalIds : état 4, la copie (document) est conservée', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    await h.run();
    const documentId = h.store.item(1, 'a.txt').documentId;
    h.conn.pages.set('t1', page([], 't2', false, ['a.txt', 'inconnu.txt']));
    const r = outcome(await h.run());
    expect(r.counters.itemsDeleted).toBe(1);
    expect(h.store.item(1, 'a.txt')).toMatchObject({ state: S.SupprimeSource, documentId });
  });

  it('findMissing : appelé en fin de passe COMPLÈTE, sur les éléments d’état 1/2/3 seulement', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.enableFindMissing();
    h.conn.missing = ['a.txt'];
    ['a', 'b'].forEach((n) => giveFile(h, n));
    h.conn.pages.set('START', page([item('a'), item('b')], 't1'));
    await h.run();
    expect(h.conn.findMissingCalls).toHaveLength(1);
    expect(h.conn.findMissingCalls[0]!.sort()).toEqual(['a.txt', 'b.txt']);
    expect(h.store.item(1, 'a.txt').state).toBe(S.SupprimeSource);
    expect(h.store.item(1, 'b.txt').state).toBe(S.Copie);
    expect(h.store.item(1, 'a.txt').documentId).not.toBeNull();
    expect(h.store.runs[0]!.counters.itemsDeleted).toBe(1);
  });

  it('findMissing : par lots de 500, jamais sur doublons / erreurs / déjà supprimés', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.enableFindMissing();
    for (let i = 0; i < 1100; i++) h.store.seed(1, `f${i}.txt`, { state: S.Copie });
    h.store.seed(1, 'dup.txt', { state: S.Doublon });
    h.store.seed(1, 'err.txt', { state: S.Erreur });
    h.store.seed(1, 'del.txt', { state: S.SupprimeSource });
    h.conn.pages.set('START', page([], null));
    await h.run();
    expect(h.conn.findMissingCalls.map((c) => c.length)).toEqual([500, 500, 100]);
    expect(h.conn.findMissingCalls.flat()).not.toContain('dup.txt');
    expect(h.conn.findMissingCalls.flat()).not.toContain('err.txt');
    expect(h.conn.findMissingCalls.flat()).not.toContain('del.txt');
  });

  it('findMissing non appelé quand la passe s’arrête sur un quota', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.enableFindMissing();
    h.store.seed(1, 'a.txt');
    h.conn.pages.set('START', new ConnectorQuotaError('429'));
    await h.run();
    expect(h.conn.findMissingCalls).toHaveLength(0);
  });

  it('un élément réapparu (même version) retrouve un état normal', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    await h.run();
    h.conn.pages.set('t1', page([], 't2', false, ['a.txt']));
    await h.run();
    expect(h.store.item(1, 'a.txt').state).toBe(S.SupprimeSource);
    h.conn.pages.set('t2', page([item('a')], 't3'));
    await h.run();
    expect(h.store.item(1, 'a.txt').state).toBe(S.Copie);
    expect(h.created).toHaveLength(1);
  });
});

describe('erreurs', () => {
  it('une erreur d’élément passe l’élément en erreur, la passe continue (partielle)', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'b');
    h.conn.files.set('a.txt', new ConnectorItemRejectedError('fichier trop volumineux'));
    h.conn.pages.set('START', page([item('a'), item('b')], null));
    const r = outcome(await h.run());
    expect(h.store.item(1, 'a.txt')).toMatchObject({
      state: S.Erreur,
      errorMessage: 'fichier trop volumineux',
    });
    expect(h.store.item(1, 'b.txt').state).toBe(S.Copie);
    expect(r.counters).toMatchObject({ itemsFailed: 1, itemsCreated: 1 });
    expect(r.status).toBe(GedSyncRunStatus.Partielle);
    expect(h.store.connector(1).status).toBe(GedSourceConnectorStatus.Actif);
  });

  it('type de fichier hors liste : refusé, élément en erreur', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.files.set('x.exe', Buffer.from('MZ'));
    h.conn.pages.set('START', page([item('x.exe')], null));
    await h.run();
    expect(h.store.item(1, 'x.exe')).toMatchObject({ state: S.Erreur });
    expect(h.store.item(1, 'x.exe').errorMessage).toContain('.exe');
    expect(h.created).toHaveLength(0);
  });

  it('autorisation expirée : connecteur 3 ; refusée : 2 ; passe échouée, STOP', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.authError = new ConnectorAuthError('jeton expiré', true);
    const r = outcome(await h.run());
    expect(r.status).toBe(GedSyncRunStatus.Echouee);
    expect(h.store.connector(1).status).toBe(GedSourceConnectorStatus.AutorisationExpiree);
    expect(h.store.runs[0]!.finishedAt).not.toBeNull();
    expect(h.conn.listCalls).toHaveLength(0);

    h.conn.authError = new ConnectorAuthError('refusé', false);
    await h.run();
    expect(h.store.connector(1).status).toBe(GedSourceConnectorStatus.Erreur);
  });

  it('autorisation perdue en cours de passe : arrêt, pas de reprise planifiée', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.pages.set('START', page([item('a')], null));
    h.conn.files.set('a.txt', new ConnectorAuthError('révoqué', true));
    const r = outcome(await h.run());
    expect(r.status).toBe(GedSyncRunStatus.Echouee);
    expect(h.store.connector(1).status).toBe(GedSourceConnectorStatus.AutorisationExpiree);
    expect(h.scheduleResume).not.toHaveBeenCalled();
  });

  it('aucun secret dans errorMessage ni lastError (élément, page, authentification)', async () => {
    const secret = 'Sup3r-S3cret-Passw0rd';
    const credentials = { password: secret };
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.files.set('a.txt', new Error(`LOGIN user ${secret} refusé`));
    h.conn.pages.set('START', page([item('a')], 't1', true));
    h.conn.pages.set('t1', new Error(`connexion imap://u:${encodeURIComponent(secret)}@h échouée`));
    await h.run({ credentials });
    expect(h.store.item(1, 'a.txt').errorMessage).not.toContain(secret);
    expect(h.store.item(1, 'a.txt').errorMessage).toContain('***');
    expect(h.store.connector(1).lastError).not.toContain(secret);
    expect(h.store.runs[0]!.errorMessage).not.toContain(secret);

    h.conn.authError = new ConnectorAuthError(`mot de passe ${secret} invalide`);
    await h.run({ credentials });
    expect(h.store.connector(1).lastError).not.toContain(secret);
    for (const call of (h.deps.log.warn as jest.Mock).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret);
    }
  });

  it('erreur de page (autre) : passe échouée, connecteur en erreur avec lastError', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.pages.set('START', new Error('DNS introuvable'));
    const r = outcome(await h.run());
    expect(r.status).toBe(GedSyncRunStatus.Echouee);
    expect(h.store.connector(1)).toMatchObject({
      status: GedSourceConnectorStatus.Erreur,
      lastError: 'DNS introuvable',
    });
    expect(h.scheduleResume).not.toHaveBeenCalled();
  });
});

describe('anti-concurrence', () => {
  it('refuse de démarrer si une passe en cours a moins de 2 h', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.store.runs.push({
      id: 900n,
      connectorId: 1,
      startedAt: new Date(h.store.clock().getTime() - 10 * 60_000),
      status: GedSyncRunStatus.EnCours,
      finishedAt: null,
      tokenBefore: null,
      tokenAfter: null,
      errorMessage: null,
      counters: {},
    });
    const r = await h.run();
    expect(r).toEqual({ skipped: 'already_running' });
    expect(h.store.runs).toHaveLength(1);
    expect(h.conn.listCalls).toHaveLength(0);
  });

  it('ferme comme échouée une passe en cours de plus de 2 h, puis démarre', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.store.runs.push({
      id: 900n,
      connectorId: 1,
      startedAt: new Date(h.store.clock().getTime() - RUN_STALE_AFTER_MS - 60_000),
      status: GedSyncRunStatus.EnCours,
      finishedAt: null,
      tokenBefore: null,
      tokenAfter: null,
      errorMessage: null,
      counters: {},
    });
    h.conn.pages.set('START', page([], null));
    const r = outcome(await h.run());
    expect(h.store.runs[0]).toMatchObject({ status: GedSyncRunStatus.Echouee });
    expect(h.store.runs[0]!.finishedAt).not.toBeNull();
    expect(r.status).toBe(GedSyncRunStatus.Reussie);
  });
});

describe('anti-concurrence : arbitrage après création de la passe', () => {
  it('deux passes créées en même temps : la plus récente se retire et ne traite rien', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    // Une autre passe (identifiant plus petit) existe déjà, mais n'était pas visible au 1er contrôle.
    h.store.runs.push({
      id: 0n,
      connectorId: 1,
      startedAt: new Date(h.store.clock().getTime() - 1000),
      status: GedSyncRunStatus.EnCours,
      finishedAt: null,
      tokenBefore: null,
      tokenAfter: null,
      errorMessage: null,
      counters: {},
    });
    const real = h.store.findOpenRuns.bind(h.store);
    let calls = 0;
    h.store.findOpenRuns = async (id: number) => (calls++ === 0 ? [] : real(id));
    expect(await h.run()).toEqual({ skipped: 'already_running' });
    expect(h.store.runs.map((r) => r.id)).toEqual([0n]); // la passe perdante est retirée
    expect(h.conn.listCalls).toHaveLength(0);
  });

  it('la passe la plus ancienne continue même si une plus récente existe', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.conn.pages.set('START', page([], null));
    const real = h.store.findOpenRuns.bind(h.store);
    let calls = 0;
    h.store.findOpenRuns = async (id: number) => {
      const found = await real(id);
      if (calls++ === 0) return [];
      return [...found, { id: 999n, startedAt: h.store.clock() }];
    };
    expect(outcome(await h.run()).status).toBe(GedSyncRunStatus.Reussie);
  });
});

describe('idempotence au rejeu après arrêt du worker', () => {
  /** Fait échouer UNE écriture d'état « copié » de l'élément : le worker s'arrête avant de la noter. */
  function crashOnceOnCopied(h: Harness) {
    const real = h.store.updateItem.bind(h.store);
    let armed = true;
    h.store.updateItem = async (id: bigint, patch: ItemPatch) => {
      if (armed && patch.state === S.Copie) {
        armed = false;
        throw new Error('arrêt simulé');
      }
      return real(id, patch);
    };
  }

  it("arrêt entre la création du document et l'élément : le rejeu adopte le document (un seul)", async () => {
    const h = setup(harness(), GedSourceMode.Synchro);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    crashOnceOnCopied(h);
    await h.run();
    expect(h.created).toHaveLength(1);
    const orphanId = h.store.item(1, 'a.txt').documentId;
    expect(orphanId).toBe(h.created[0]!.documentId);
    expect(h.store.item(1, 'a.txt').contentHash).toBeNull();

    // Rejeu (le jeton n'a pas pu être pris en compte : la page revient).
    h.store.connector(1).changeToken = null;
    const second = outcome(await h.run());
    expect(h.created).toHaveLength(1);
    expect(h.versions).toHaveLength(0);
    expect(second.counters).toMatchObject({ itemsCreated: 1, itemsFailed: 0 });
    expect(h.store.item(1, 'a.txt')).toMatchObject({
      state: S.Copie,
      documentId: orphanId,
      contentHash: createHash('sha256').update('contenu de a').digest('hex'),
      remoteVersion: 'v1',
    });
    expect(h.enqueueAi).toHaveBeenCalledWith(orphanId, expect.any(Number));
  });

  it("arrêt pur (aucune trace d'erreur) : l'élément resté « découvert » avec son document est adopté", async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    crashOnceOnCopied(h);
    await h.run();
    Object.assign(h.store.item(1, 'a.txt'), { state: S.Decouvert, errorMessage: null });
    h.store.connector(1).changeToken = null;
    await h.run();
    expect(h.created).toHaveLength(1);
    expect(h.store.item(1, 'a.txt').state).toBe(S.Copie);
  });

  it("synchro : arrêt entre la nouvelle version et l'élément : le rejeu ne crée pas de version de trop", async () => {
    const h = setup(harness(), GedSourceMode.Synchro);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    await h.run();
    giveFile(h, 'a', 'contenu de a, version 2');
    h.conn.pages.set('t1', page([item('a', 'v2')], 't2'));
    crashOnceOnCopied(h);
    await h.run();
    expect(h.versions).toHaveLength(1);
    h.store.connector(1).changeToken = 't1';
    await h.run();
    expect(h.versions).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect(h.store.item(1, 'a.txt')).toMatchObject({ state: S.Copie, remoteVersion: 'v2' });
  });
});

describe('droits du document créé', () => {
  it('trois principaux mappés : exactement trois permissions, toutes en Consultation (niveau 2)', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a', 'x', acl('a@x.org', 'b@x.org', 'c@x.org', 'inconnu@x.org'));
    h.conn.pages.set('START', page([item('a')], null));
    await h.run();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.grants).toEqual([
      { userGroupId: 11, permissionLevelId: 2 },
      { userGroupId: 12, permissionLevelId: 2 },
      { userGroupId: 13, permissionLevelId: 2 },
    ]);
    expect(h.created[0]!.dossierId).toBe(5);
    expect(
      h.created[0]!.grants.every(
        (g) => (g as { permissionLevelId: number }).permissionLevelId !== 1,
      ),
    ).toBe(true);
  });

  it('« public » seul et repli vide : le document N’EST PAS créé (état 5, motif explicite)', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a', 'x', { entries: [{ principal: '*', kind: 'public', access: 'read' }] });
    h.conn.pages.set('START', page([item('a')], null));
    const r = outcome(await h.run());
    expect(h.created).toHaveLength(0);
    expect(h.store.item(1, 'a.txt')).toMatchObject({
      state: S.Erreur,
      errorMessage: NO_GRANT_MESSAGE,
      documentId: null,
    });
    expect(NO_GRANT_MESSAGE).toContain('document non créé');
    expect(r.counters.itemsFailed).toBe(1);
    expect(h.enqueueAi).not.toHaveBeenCalled();
  });

  it('droits illisibles (ACL nulle) sans repli : document non créé ; avec repli : groupes de repli seuls', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a', 'x', null);
    h.conn.pages.set('START', page([item('a')], null));
    await h.run();
    expect(h.created).toHaveLength(0);

    const h2 = setup(harness(), GedSourceMode.Copie, {
      rights: { principalMap: {}, fallbackUserGroupIds: [7] },
    });
    giveFile(h2, 'a', 'x', null);
    h2.conn.pages.set('START', page([item('a')], null));
    await h2.run();
    expect(h2.created[0]!.grants).toEqual([{ userGroupId: 7, permissionLevelId: 2 }]);
  });

  it('la resynchronisation après correction de la config crée le document', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    giveFile(h, 'a', 'x', acl('a@x.org'));
    h.conn.pages.set('START', page([item('a')], null));
    // 1re config : aucune correspondance de droits.
    h.config = { rights: { principalMap: {} } };
    await h.run();
    expect(h.created).toHaveLength(0);
    // Config corrigée ; même élément (même version) en état 5 : il est rejoué.
    h.config = RIGHTS;
    h.store.connector(1).changeToken = null;
    await h.run();
    expect(h.created).toHaveLength(1);
    expect(h.store.item(1, 'a.txt').state).toBe(S.Copie);
  });

  it('configuration des droits invalide : aucun document', async () => {
    const h = setup(harness(), GedSourceMode.Copie, {
      rights: { principalMap: { 'a@x.org': 'oups' } },
    });
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], null));
    await h.run();
    expect(h.created).toHaveLength(0);
    expect(h.store.item(1, 'a.txt').state).toBe(S.Erreur);
  });

  it('un doublon n’exige aucun droit (aucun document n’est créé)', async () => {
    const h = setup(harness(), GedSourceMode.Copie, {});
    h.store.seed(9, 'orig', {
      state: S.Copie,
      contentHash: createHash('sha256').update('x').digest('hex'),
    });
    giveFile(h, 'a', 'x', null);
    h.conn.pages.set('START', page([item('a')], null));
    await h.run();
    expect(h.store.item(1, 'a.txt').state).toBe(S.Doublon);
  });
});

describe('déclenchement IA', () => {
  it('enfile après un nouveau document et après une nouvelle version (id d’élément numérique)', async () => {
    const h = setup(harness(), GedSourceMode.Synchro);
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], 't1'));
    await h.run();
    const it = h.store.item(1, 'a.txt');
    expect(h.enqueueAi).toHaveBeenCalledWith(it.documentId, Number(it.id));

    giveFile(h, 'a', 'autre contenu');
    h.conn.pages.set('t1', page([item('a', 'v2')], 't2'));
    await h.run();
    expect(h.enqueueAi).toHaveBeenCalledTimes(2);
  });

  it('un échec d’enfilage ne fait pas échouer l’ingestion', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.enqueueAi.mockRejectedValue(new Error('Redis indisponible'));
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], null));
    const r = outcome(await h.run());
    expect(r.counters).toMatchObject({ itemsCreated: 1, itemsFailed: 0 });
    expect(h.store.item(1, 'a.txt').state).toBe(S.Copie);
    expect(h.deps.log.warn).toHaveBeenCalled();
  });
});

describe('erreurs d’ingestion', () => {
  it('une ingestion qui échoue met l’élément en erreur sans document ni IA', async () => {
    const h = setup(harness(), GedSourceMode.Copie);
    h.deps.ingest.createDocument = jest.fn().mockRejectedValue(new Error('disque plein'));
    giveFile(h, 'a');
    h.conn.pages.set('START', page([item('a')], null));
    await h.run();
    expect(h.store.item(1, 'a.txt')).toMatchObject({ state: S.Erreur, documentId: null });
    expect(h.enqueueAi).not.toHaveBeenCalled();
  });
});
