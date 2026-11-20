import { OAuthApiError, type OAuthApiClient, type OAuthRequestOptions } from '../oauth-contract';
import { ConnectorConfigError, ConnectorRegistry, buildConnector, validateConnectorInput } from '../registry';
import { mapOriginRights } from '../rights';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type RemoteItem,
  type SourceConnector,
} from '../types';
import { googleDriveConnector } from './google-drive';

const REFRESH = 'refresh-secret-de-test-0123';
const CREDS = { refreshToken: REFRESH };
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const DRAWING = 'application/vnd.google-apps.drawing';
const FOLDER = 'application/vnd.google-apps.folder';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type Handler = (url: URL, raw: string) => unknown;

class FakeOAuth implements OAuthApiClient {
  calls: string[] = [];
  byteCalls: Array<{ url: string; maxBytes: number }> = [];
  authCalls = 0;
  constructor(
    public json: Handler = () => ({}),
    public bytes: (url: URL) => Buffer | Error = () => Buffer.from('x'),
  ) {}
  async authenticate() {
    this.authCalls++;
  }
  async getJson<T>(url: string, _opts?: OAuthRequestOptions): Promise<T> {
    this.calls.push(url);
    const r = this.json(new URL(url), url);
    if (r instanceof Error) throw r;
    return r as T;
  }
  async getBytes(url: string, opts: OAuthRequestOptions & { maxBytes: number }) {
    this.byteCalls.push({ url, maxBytes: opts.maxBytes });
    const r = this.bytes(new URL(url));
    if (r instanceof Error) throw r;
    return { bytes: r, contentType: 'application/octet-stream' };
  }
}

function make(
  oauth: FakeOAuth,
  opts: { config?: Record<string, unknown>; credentials?: Record<string, string>; limits?: { maxFileBytes?: number; allowedExtensions?: string[] } } = {},
): SourceConnector {
  const registry = new ConnectorRegistry();
  registry.register(googleDriveConnector);
  return buildConnector(registry, 'google_drive', {
    config: opts.config ?? {},
    credentials: opts.credentials ?? CREDS,
    limits: opts.limits,
    deps: { oauth },
  });
}

const ID = (n: number) => `fileid${String(n).padStart(4, '0')}`;
const file = (n: number, extra: Record<string, unknown> = {}) => ({
  id: ID(n),
  name: `doc${n}.pdf`,
  mimeType: 'application/pdf',
  size: '1000',
  md5Checksum: `md5-${n}`,
  version: '3',
  modifiedTime: '2026-02-01T10:00:00.000Z',
  createdTime: '2026-01-01T10:00:00.000Z',
  owners: [{ displayName: 'Alice', emailAddress: 'alice@exemple.test' }],
  webViewLink: `https://drive.google.com/file/d/${ID(n)}/view`,
  parents: ['root00000'],
  ...extra,
});

/** Serveur Drive simulé : startPageToken, files.list, changes.list. */
function drive(opts: {
  files?: Array<Record<string, unknown>>;
  /** pages de files.list : clé = pageToken ('' = première). */
  pages?: Record<string, { files: Array<Record<string, unknown>>; next?: string }>;
  changes?: Record<string, unknown>;
  more?: Handler;
}): Handler {
  return (url) => {
    const path = url.pathname;
    if (path === '/drive/v3/changes/startPageToken') return { startPageToken: 'START1' };
    if (path === '/drive/v3/files') {
      const key = url.searchParams.get('pageToken') ?? '';
      const page = opts.pages?.[key] ?? { files: opts.files ?? [] };
      return { files: page.files, nextPageToken: page.next };
    }
    if (path === '/drive/v3/changes') {
      const key = url.searchParams.get('pageToken') ?? '';
      return opts.changes?.[key] ?? { changes: [], newStartPageToken: key };
    }
    return opts.more ? opts.more(url, url.href) : new OAuthApiError('introuvable', 404);
  };
}

const list = (c: SourceConnector, since: string | null = null, pageSize = 100) =>
  c.listChanges(since, { pageSize });

describe('google_drive — définition et configuration', () => {
  it('déclare OAuth Google en lecture seule, trois modes, aucun champ d’identifiants', () => {
    expect(googleDriveConnector.type).toBe('google_drive');
    expect(googleDriveConnector.supportedModes).toEqual([0, 1, 2]);
    expect(googleDriveConnector.oauth).toEqual({
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    expect(googleDriveConnector.credentialFields).toEqual([]);
    expect(googleDriveConnector.configFields.map((f) => f.name)).toEqual([
      'driveId',
      'includeSharedDrives',
      'folderId',
      'exportFormat',
      'extensions',
    ]);
  });

  it('applique les défauts et refuse les champs inconnus ou invalides', () => {
    const s = googleDriveConnector.configSchema;
    expect(s.parse({})).toEqual({ includeSharedDrives: false, exportFormat: 'pdf' });
    expect(s.parse({ driveId: '', folderId: '  ' })).toEqual({ includeSharedDrives: false, exportFormat: 'pdf' });
    expect(s.safeParse({ host: 'x' }).success).toBe(false);
    expect(s.safeParse({ driveId: 'a b' }).success).toBe(false);
    expect(s.safeParse({ folderId: 'abc' }).success).toBe(false);
    expect(s.safeParse({ folderId: 'x'.repeat(129) }).success).toBe(false);
    expect(s.safeParse({ exportFormat: 'odt' }).success).toBe(false);
    expect(s.safeParse({ extensions: ['pdf'] }).success).toBe(false);
  });

  it('valide les identifiants (jeton obligatoire, strict)', () => {
    const c = googleDriveConnector.credentialsSchema;
    expect(c.safeParse({ refreshToken: 'abc', scope: 'drive.readonly' }).success).toBe(true);
    expect(c.safeParse({}).success).toBe(false);
    expect(c.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(c.safeParse({ refreshToken: 'x'.repeat(16_385) }).success).toBe(false);
    expect(c.safeParse({ refreshToken: 'abc', extra: '1' }).success).toBe(false);
  });

  it('validateConnectorInput : accepte une config valide, refuse un mode ou un champ invalide', async () => {
    const registry = new ConnectorRegistry();
    registry.register(googleDriveConnector);
    const ok = await validateConnectorInput(registry, {
      connectorType: 'google_drive',
      mode: 1,
      config: { driveId: 'drive12345', exportFormat: 'office' },
    });
    expect(ok.settings).toMatchObject({ driveId: 'drive12345', exportFormat: 'office' });
    await expect(
      validateConnectorInput(registry, { connectorType: 'google_drive', mode: 0, config: { driveId: '!!' } }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
    await expect(
      validateConnectorInput(registry, { connectorType: 'google_drive', mode: 3 as never, config: {} }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });

  it('assertConfigSafe ne lève pas sur une config valide', async () => {
    await expect(googleDriveConnector.assertConfigSafe({}, {})).resolves.toBeUndefined();
  });
});

describe('google_drive — authentification', () => {
  it('buildConnector refuse des identifiants sans jeton de rafraîchissement', () => {
    expect(() => make(new FakeOAuth(), { credentials: {} })).toThrow(ConnectorConfigError);
  });

  it('create() direct sans jeton : authenticate lève une erreur « non autorisé »', async () => {
    const o = new FakeOAuth();
    const c = googleDriveConnector.create({
      config: googleDriveConnector.configSchema.parse({}),
      credentials: {},
      limits: { maxFileBytes: 1000, allowedExtensions: ['.pdf'] },
      deps: { oauth: o },
    });
    const err = await c.authenticate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorAuthError);
    expect((err as ConnectorAuthError).expired).toBe(true);
    expect((err as Error).message).toMatch(/non autorisé/);
    expect(o.authCalls).toBe(0);
  });

  it('délègue au client OAuth quand le jeton est présent', async () => {
    const o = new FakeOAuth();
    await make(o).authenticate();
    expect(o.authCalls).toBe(1);
  });

  it('propage ConnectorAuthError du client', async () => {
    const o = new FakeOAuth();
    o.authenticate = async () => {
      throw new ConnectorAuthError('autorisation expirée', true);
    };
    await expect(make(o).authenticate()).rejects.toMatchObject({ name: 'ConnectorAuthError', expired: true });
  });
});

describe('google_drive — listage complet puis changements', () => {
  it('liste complet : jeton de départ, paramètres, éléments et bascule en phase changements', async () => {
    const o = new FakeOAuth(drive({ files: [file(1), file(2, { md5Checksum: undefined, headRevisionId: 'rev9' })] }));
    const page = await list(make(o), null, 50);
    expect(o.calls[0]).toContain('/drive/v3/changes/startPageToken?');
    expect(o.calls[0]).toContain('supportsAllDrives=true');
    expect(o.calls[0]).not.toContain('driveId');
    const u = new URL(o.calls[1] as string);
    expect(u.origin).toBe('https://www.googleapis.com');
    expect(u.pathname).toBe('/drive/v3/files');
    expect(u.searchParams.get('q')).toBe('trashed=false');
    expect(u.searchParams.get('corpora')).toBe('user');
    expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect(u.searchParams.get('pageSize')).toBe('50');
    expect(u.searchParams.get('orderBy')).toBe('modifiedTime');
    expect(u.searchParams.get('fields')).toContain('md5Checksum');

    expect(page.items.map((i) => i.externalId)).toEqual([ID(1), ID(2)]);
    expect(page.items[0]).toMatchObject({
      name: 'doc1.pdf',
      mimeType: 'application/pdf',
      byteLength: 1000,
      originAuthor: 'Alice',
      originUrl: `https://drive.google.com/file/d/${ID(1)}/view`,
      remoteVersion: 'md5-1',
      originMetadata: { driveId: null, mimeType: 'application/pdf', exported: false },
    });
    expect(page.items[0]?.originCreatedAt?.toISOString()).toBe('2026-01-01T10:00:00.000Z');
    expect(page.items[0]?.originModifiedAt?.toISOString()).toBe('2026-02-01T10:00:00.000Z');
    expect(page.items[1]?.remoteVersion).toBe('rev9');
    expect(page.hasMore).toBe(false);
    expect(JSON.parse(page.nextToken as string)).toEqual({ p: 'chg', t: 'START1' });
  });

  it('remoteVersion de repli v<version>:<modifiedTime> ; auteur = e-mail sans nom', async () => {
    const f = file(1, {
      md5Checksum: undefined,
      owners: [{ emailAddress: 'bob@exemple.test' }],
    });
    const o = new FakeOAuth(drive({ files: [f] }));
    const page = await list(make(o));
    expect(page.items[0]?.remoteVersion).toBe('v3:2026-02-01T10:00:00.000Z');
    expect(page.items[0]?.originAuthor).toBe('bob@exemple.test');
  });

  it('pagine le listage complet (jeton de phase full avec startPageToken) puis bascule', async () => {
    const o = new FakeOAuth(
      drive({
        pages: {
          '': { files: [file(1)], next: 'P2' },
          P2: { files: [file(2)], next: 'P3' },
          P3: { files: [file(3)] },
        },
      }),
    );
    const c = make(o);
    const p1 = await list(c);
    expect(p1.hasMore).toBe(true);
    expect(JSON.parse(p1.nextToken as string)).toEqual({ p: 'full', t: 'P2', s: 'START1' });
    const p2 = await list(c, p1.nextToken);
    expect(p2.hasMore).toBe(true);
    expect(JSON.parse(p2.nextToken as string)).toEqual({ p: 'full', t: 'P3', s: 'START1' });
    // le jeton de départ n'est demandé qu'une fois
    expect(o.calls.filter((u) => u.includes('startPageToken'))).toHaveLength(1);
    const p3 = await list(c, p2.nextToken);
    expect(p3.items.map((i) => i.externalId)).toEqual([ID(3)]);
    expect(p3.hasMore).toBe(false);
    expect(JSON.parse(p3.nextToken as string)).toEqual({ p: 'chg', t: 'START1' });
  });

  it('reprend EXACTEMENT à la page suivante depuis un jeton mi-parcours (nouvelle instance)', async () => {
    const o = new FakeOAuth(
      drive({ pages: { '': { files: [file(1)], next: 'P2' }, P2: { files: [file(2)] } } }),
    );
    const resumed = await list(make(o), JSON.stringify({ p: 'full', t: 'P2', s: 'START0' }));
    expect(o.calls).toHaveLength(1); // aucun nouvel appel startPageToken, aucun relistage de la page 1
    expect(new URL(o.calls[0] as string).searchParams.get('pageToken')).toBe('P2');
    expect(resumed.items.map((i) => i.externalId)).toEqual([ID(2)]);
    expect(JSON.parse(resumed.nextToken as string)).toEqual({ p: 'chg', t: 'START0' });
  });

  it('phase changements : paramètres, nextPageToken puis newStartPageToken', async () => {
    const o = new FakeOAuth(
      drive({
        changes: {
          C1: { changes: [{ fileId: ID(1), file: file(1) }], nextPageToken: 'C2' },
          C2: { changes: [{ fileId: ID(2), file: file(2) }], newStartPageToken: 'C3' },
        },
      }),
    );
    const c = make(o);
    const p1 = await list(c, JSON.stringify({ p: 'chg', t: 'C1' }), 25);
    const u = new URL(o.calls[0] as string);
    expect(u.pathname).toBe('/drive/v3/changes');
    expect(u.searchParams.get('pageToken')).toBe('C1');
    expect(u.searchParams.get('includeRemoved')).toBe('true');
    expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect(u.searchParams.get('pageSize')).toBe('25');
    expect(u.searchParams.get('fields')).toContain('newStartPageToken');
    expect(p1.items.map((i) => i.externalId)).toEqual([ID(1)]);
    expect(p1.hasMore).toBe(true);
    expect(JSON.parse(p1.nextToken as string)).toEqual({ p: 'chg', t: 'C2' });
    const p2 = await list(c, p1.nextToken);
    expect(p2.items.map((i) => i.externalId)).toEqual([ID(2)]);
    expect(p2.hasMore).toBe(false);
    expect(JSON.parse(p2.nextToken as string)).toEqual({ p: 'chg', t: 'C3' });
  });

  it('removed et trashed donnent des suppressions à la source', async () => {
    const o = new FakeOAuth(
      drive({
        changes: {
          C1: {
            changes: [
              { fileId: ID(1), removed: true },
              { fileId: ID(2), file: file(2, { trashed: true }) },
              { fileId: ID(3), file: file(3) },
              { removed: true }, // sans identifiant : ignoré
            ],
            newStartPageToken: 'C2',
          },
        },
      }),
    );
    const page = await list(make(o), JSON.stringify({ p: 'chg', t: 'C1' }));
    expect(page.deletedExternalIds.sort()).toEqual([ID(1), ID(2)]);
    expect(page.items.map((i) => i.externalId)).toEqual([ID(3)]);
  });

  it('en listage complet, un fichier à la corbeille est signalé supprimé', async () => {
    const o = new FakeOAuth(drive({ files: [file(1, { trashed: true }), file(2)] }));
    const page = await list(make(o));
    expect(page.deletedExternalIds).toEqual([ID(1)]);
    expect(page.items.map((i) => i.externalId)).toEqual([ID(2)]);
  });

  it('en Mon Drive seul, restrictToMyDrive et fichiers de drive partagé ignorés', async () => {
    const o = new FakeOAuth(
      drive({
        changes: {
          C1: {
            changes: [
              { fileId: ID(1), file: file(1, { driveId: 'shared0001' }) },
              { fileId: ID(2), file: file(2) },
            ],
            newStartPageToken: 'C2',
          },
        },
      }),
    );
    const page = await list(make(o), JSON.stringify({ p: 'chg', t: 'C1' }));
    expect(new URL(o.calls[0] as string).searchParams.get('restrictToMyDrive')).toBe('true');
    expect(page.items.map((i) => i.externalId)).toEqual([ID(2)]);
  });

  it('jeton illisible ou inconnu : erreur claire, aucun appel', async () => {
    const o = new FakeOAuth(drive({}));
    const c = make(o);
    for (const bad of [
      'nope',
      '[]',
      '{}',
      '{"p":"x","t":"a"}',
      '{"p":"chg"}',
      '{"p":"chg","t":""}',
      '{"p":"chg","t":3}',
      '{"p":"full","t":"a"}',
      '{"p":"full","s":""}',
      '{"p":"chg","t":"a b"}',
    ]) {
      await expect(list(c, bad)).rejects.toThrow(/illisible/);
    }
    expect(o.calls).toEqual([]);
  });

  it('une réponse 400 de Google devient une erreur claire sans secret', async () => {
    const o = new FakeOAuth(() => new OAuthApiError('Requête refusée', 400));
    const err = await list(make(o), JSON.stringify({ p: 'chg', t: 'C1' })).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/réinitialisez/);
    expect((err as Error).message).not.toContain(REFRESH);
  });

  it('une réponse sans page suivante ni nouveau jeton est une erreur', async () => {
    const o = new FakeOAuth(drive({ changes: { C1: { changes: [] } } }));
    await expect(list(make(o), JSON.stringify({ p: 'chg', t: 'C1' }))).rejects.toThrow(/nouveau jeton/);
  });
});

describe('google_drive — drive partagé, dossier et filtres', () => {
  it('drive partagé : driveId, corpora=drive, supportsAllDrives dans les trois requêtes', async () => {
    const o = new FakeOAuth(drive({ files: [file(1, { driveId: 'shared0001' })], changes: { C1: { newStartPageToken: 'C2' } } }));
    const c = make(o, { config: { driveId: 'shared0001' } });
    const page = await list(c);
    const start = new URL(o.calls[0] as string);
    expect(start.searchParams.get('driveId')).toBe('shared0001');
    expect(start.searchParams.get('supportsAllDrives')).toBe('true');
    const f = new URL(o.calls[1] as string);
    expect(f.searchParams.get('corpora')).toBe('drive');
    expect(f.searchParams.get('driveId')).toBe('shared0001');
    expect(f.searchParams.get('supportsAllDrives')).toBe('true');
    expect(f.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(page.items[0]?.originMetadata).toMatchObject({ driveId: 'shared0001' });
    await list(c, JSON.stringify({ p: 'chg', t: 'C1' }));
    const ch = new URL(o.calls[2] as string);
    expect(ch.searchParams.get('driveId')).toBe('shared0001');
    expect(ch.searchParams.get('supportsAllDrives')).toBe('true');
    expect(ch.searchParams.has('restrictToMyDrive')).toBe(false);
  });

  it('includeSharedDrives sans driveId : corpora=allDrives, fichiers de drives partagés conservés', async () => {
    const o = new FakeOAuth(drive({ files: [file(1, { driveId: 'shared0001' }), file(2)] }));
    const page = await list(make(o, { config: { includeSharedDrives: true } }));
    expect(new URL(o.calls[1] as string).searchParams.get('corpora')).toBe('allDrives');
    expect(page.items).toHaveLength(2);
  });

  it('restriction à un dossier : descendance résolue, cache, profondeur bornée, pas de boucle', async () => {
    const FOLDER_ID = 'folderTop1';
    const chain = (n: number) => `chain${String(n).padStart(4, '0')}`;
    const parentsByFolder: Record<string, string[]> = {
      mid000001: [FOLDER_ID], // dossier intermédiaire
      other0001: ['root00000'],
      loopA0001: ['loopB0001'],
      loopB0001: ['loopA0001'],
    };
    // chaîne de 25 dossiers : chain0 -> chain1 -> ... -> chain24 -> folderTop1
    for (let i = 0; i < 25; i++) parentsByFolder[chain(i)] = [i === 24 ? FOLDER_ID : chain(i + 1)];
    const o = new FakeOAuth(
      drive({
        files: [
          file(1, { parents: [FOLDER_ID] }), // direct
          file(2, { parents: ['mid000001'] }), // un niveau
          file(3, { parents: ['other0001'] }), // hors dossier
          file(4, { parents: ['loopA0001'] }), // boucle
          file(5, { parents: [chain(0)] }), // trop profond (26 niveaux)
          file(6, { parents: ['mid000001'] }), // cache : pas de 2e appel
          file(7, { parents: undefined }), // sans parent
          file(8, { parents: [chain(10)] }), // 15 niveaux : dans la borne
        ],
        more: (url) => {
          const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
          const parents = m ? parentsByFolder[m[1] as string] : undefined;
          return parents ? { id: m?.[1], parents } : new OAuthApiError('introuvable', 404);
        },
      }),
    );
    const page = await list(make(o, { config: { folderId: FOLDER_ID } }));
    expect(page.items.map((i) => i.externalId)).toEqual([ID(1), ID(2), ID(6), ID(8)]);
    const lookups = o.calls.filter((u) => u.includes('/files/mid000001'));
    expect(lookups).toHaveLength(1);
    const g = new URL(lookups[0] as string);
    expect(g.searchParams.get('fields')).toBe('id,parents');
    expect(g.searchParams.get('supportsAllDrives')).toBe('true');
    expect(o.calls.length).toBeLessThan(80); // borné malgré la boucle et la chaîne profonde
  });

  it('un parent introuvable (404) est hors dossier, sans erreur', async () => {
    const o = new FakeOAuth(drive({ files: [file(1, { parents: ['gone00001'] })] }));
    const page = await list(make(o, { config: { folderId: 'folderTop1' } }));
    expect(page.items).toEqual([]);
  });

  it('filtre les extensions : hors liste globale, hors config, et dossiers/raccourcis/formulaires', async () => {
    const o = new FakeOAuth(
      drive({
        files: [
          file(1, { name: 'a.pdf' }),
          file(2, { name: 'setup.exe', mimeType: 'application/octet-stream' }),
          file(3, { name: 'sans-extension', mimeType: 'application/octet-stream' }),
          file(4, { name: 'dossier', mimeType: FOLDER }),
          file(5, { name: 'raccourci', mimeType: 'application/vnd.google-apps.shortcut' }),
          file(6, { name: 'formulaire', mimeType: 'application/vnd.google-apps.form' }),
          file(7, { name: 'b.docx', mimeType: DOCX }),
        ],
      }),
    );
    const all = await list(make(o));
    expect(all.items.map((i) => i.externalId)).toEqual([ID(1), ID(7)]);
    const only = await list(make(new FakeOAuth(o.json), { config: { extensions: ['.docx', '.exe'] } }));
    expect(only.items.map((i) => i.externalId)).toEqual([ID(7)]);
  });

  it('taille connue au-delà de la limite : listé, mais fetchFile le refuse sans télécharger', async () => {
    const o = new FakeOAuth(drive({ files: [file(1, { size: '5000' })] }));
    const c = make(o, { limits: { maxFileBytes: 4000 } });
    const page = await list(c);
    expect(page.items[0]?.byteLength).toBe(5000);
    await expect(c.fetchFile(page.items[0] as RemoteItem)).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    expect(o.byteCalls).toEqual([]);
  });
});

describe('google_drive — fichiers natifs Google', () => {
  const natives = [
    file(1, { name: 'Rapport', mimeType: DOC, size: undefined, md5Checksum: undefined }),
    file(2, { name: 'Budget', mimeType: SHEET, size: undefined, md5Checksum: undefined }),
    file(3, { name: 'Soutenance', mimeType: SLIDES, size: undefined, md5Checksum: undefined }),
    file(4, { name: 'Schéma', mimeType: DRAWING, size: undefined, md5Checksum: undefined }),
  ];

  it('export pdf par défaut : extension .pdf, type application/pdf, version modifiedTime:version', async () => {
    const o = new FakeOAuth(drive({ files: natives }));
    const page = await list(make(o));
    expect(page.items.map((i) => [i.name, i.mimeType])).toEqual([
      ['Rapport.pdf', 'application/pdf'],
      ['Budget.pdf', 'application/pdf'],
      ['Soutenance.pdf', 'application/pdf'],
      ['Schéma.pdf', 'application/pdf'],
    ]);
    expect(page.items[0]?.remoteVersion).toBe('2026-02-01T10:00:00.000Z:3');
    expect(page.items[0]?.byteLength).toBeUndefined();
    expect(page.items[0]?.originMetadata).toMatchObject({ mimeType: DOC, exported: true });
  });

  it('export office : docx, xlsx, pptx ; dessins toujours en pdf', async () => {
    const o = new FakeOAuth(drive({ files: natives }));
    const page = await list(make(o, { config: { exportFormat: 'office' } }));
    expect(page.items.map((i) => [i.name, i.mimeType])).toEqual([
      ['Rapport.docx', DOCX],
      ['Budget.xlsx', XLSX],
      ['Soutenance.pptx', PPTX],
      ['Schéma.pdf', 'application/pdf'],
    ]);
  });

  it('ne double pas l’extension si le nom la porte déjà', async () => {
    const o = new FakeOAuth(drive({ files: [file(1, { name: 'Note.PDF', mimeType: DOC })] }));
    const page = await list(make(o));
    expect(page.items[0]?.name).toBe('Note.PDF');
  });

  it('ignore un export dont l’extension n’est pas retenue', async () => {
    const o = new FakeOAuth(drive({ files: natives }));
    const page = await list(make(o, { config: { exportFormat: 'office', extensions: ['.docx'] } }));
    expect(page.items.map((i) => i.name)).toEqual(['Rapport.docx']);
  });

  it('fetchFile : export via files/{id}/export?mimeType=… avec maxBytes', async () => {
    const o = new FakeOAuth(drive({ files: natives }), () => Buffer.from('%PDF-1.7'));
    const c = make(o, { limits: { maxFileBytes: 10_000 } });
    const page = await list(c);
    const got = await c.fetchFile(page.items[0] as RemoteItem);
    expect(got.bytes.toString()).toBe('%PDF-1.7');
    expect(got.name).toBe('Rapport.pdf');
    expect(got.mimeType).toBe('application/pdf');
    const u = new URL(o.byteCalls[0]?.url as string);
    expect(u.origin + u.pathname).toBe(`https://www.googleapis.com/drive/v3/files/${ID(1)}/export`);
    expect(u.searchParams.get('mimeType')).toBe('application/pdf');
    expect(o.byteCalls[0]?.maxBytes).toBe(10_000);
  });

  it('fetchFile : export office avec le bon type', async () => {
    const o = new FakeOAuth(drive({ files: natives }));
    const c = make(o, { config: { exportFormat: 'office' } });
    const page = await list(c);
    await c.fetchFile(page.items[1] as RemoteItem);
    expect(new URL(o.byteCalls[0]?.url as string).searchParams.get('mimeType')).toBe(XLSX);
  });

  it('fetchFile : un type d’export falsifié est refusé sans appel', async () => {
    const o = new FakeOAuth(drive({}));
    const c = make(o);
    const item: RemoteItem = {
      externalId: ID(1),
      name: 'x.pdf',
      mimeType: 'text/html',
      originMetadata: { mimeType: DOC, exported: true },
    };
    await expect(c.fetchFile(item)).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    expect(o.byteCalls).toEqual([]);
  });

  it('export trop gros (403 exportSizeLimitExceeded) : élément rejeté explicitement', async () => {
    const o = new FakeOAuth(drive({ files: natives }), () => new OAuthApiError('limite', 403, 'exportSizeLimitExceeded'));
    const c = make(o);
    const page = await list(c);
    const err = await c.fetchFile(page.items[0] as RemoteItem).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorItemRejectedError);
    expect((err as Error).message).toMatch(/10 Mo/);
  });
});

describe('google_drive — fetchFile binaire', () => {
  it('télécharge via alt=media&supportsAllDrives=true', async () => {
    const o = new FakeOAuth(drive({ files: [file(1)] }), () => Buffer.from('PDFDATA'));
    const c = make(o);
    const page = await list(c);
    const got = await c.fetchFile(page.items[0] as RemoteItem);
    expect(got).toMatchObject({ name: 'doc1.pdf', mimeType: 'application/pdf' });
    expect(got.bytes.toString()).toBe('PDFDATA');
    const u = new URL(o.byteCalls[0]?.url as string);
    expect(u.pathname).toBe(`/drive/v3/files/${ID(1)}`);
    expect(u.searchParams.get('alt')).toBe('media');
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect(o.byteCalls[0]?.maxBytes).toBeGreaterThan(0);
  });

  it('refuse un dépassement signalé par le client, un 404 et un 403', async () => {
    const item: RemoteItem = { externalId: ID(1), name: 'a.pdf', mimeType: 'application/pdf' };
    for (const e of [
      new ConnectorItemRejectedError('trop volumineux'),
      new OAuthApiError('absent', 404),
      new OAuthApiError('interdit', 403, 'cannotDownloadFile'),
    ]) {
      const c = make(new FakeOAuth(drive({}), () => e));
      await expect(c.fetchFile(item)).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    }
  });

  it('refuse une extension non autorisée et un identifiant invalide', async () => {
    const c = make(new FakeOAuth(drive({})));
    await expect(c.fetchFile({ externalId: ID(1), name: 'x.exe' })).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(c.fetchFile({ externalId: '../etc', name: 'x.pdf' })).rejects.toBeInstanceOf(
      ConnectorItemRejectedError,
    );
  });

  it('refuse un contenu qui dépasse la limite même si le client ne l’a pas vu', async () => {
    const c = make(new FakeOAuth(drive({}), () => Buffer.alloc(50)), { limits: { maxFileBytes: 10 } });
    await expect(c.fetchFile({ externalId: ID(1), name: 'x.pdf' })).rejects.toBeInstanceOf(
      ConnectorItemRejectedError,
    );
  });
});

describe('google_drive — droits d’origine', () => {
  const item: RemoteItem = { externalId: ID(1), name: 'a.pdf' };
  const perms = (permissions: unknown[], next?: string) => ({ permissions, nextPageToken: next });

  it('mappe tous les types et rôles, ignore les entrées supprimées', async () => {
    const o = new FakeOAuth(() =>
      perms([
        { id: '1', type: 'user', role: 'owner', emailAddress: 'Alice@Exemple.TEST' },
        { id: '2', type: 'user', role: 'writer', emailAddress: 'bob@exemple.test' },
        { id: '3', type: 'user', role: 'fileOrganizer', emailAddress: 'carl@exemple.test' },
        { id: '4', type: 'user', role: 'organizer', emailAddress: 'dora@exemple.test' },
        { id: '5', type: 'user', role: 'reader', emailAddress: 'emma@exemple.test' },
        { id: '6', type: 'user', role: 'commenter', emailAddress: 'fred@exemple.test' },
        { id: '7', type: 'group', role: 'reader', emailAddress: 'Equipe@Exemple.test' },
        { id: '8', type: 'domain', role: 'reader', domain: 'exemple.test' },
        { id: '9', type: 'anyone', role: 'reader' },
        { id: '10', type: 'user', role: 'reader' }, // sans e-mail
        { id: '11', type: 'user', role: 'bizarre', emailAddress: 'gus@exemple.test' },
        { id: '12', type: 'autre', role: 'reader' },
        { id: '13', type: 'user', role: 'reader', emailAddress: 'old@exemple.test', deleted: true },
      ]),
    );
    const acl = await make(o).readOriginAcl(item);
    expect(acl?.entries).toEqual([
      { principal: 'alice@exemple.test', kind: 'user', access: 'owner' },
      { principal: 'bob@exemple.test', kind: 'user', access: 'write' },
      { principal: 'carl@exemple.test', kind: 'user', access: 'write' },
      { principal: 'dora@exemple.test', kind: 'user', access: 'write' },
      { principal: 'emma@exemple.test', kind: 'user', access: 'read' },
      { principal: 'fred@exemple.test', kind: 'user', access: 'read' },
      { principal: 'equipe@exemple.test', kind: 'group', access: 'read' },
      { principal: 'exemple.test', kind: 'public', access: 'read' },
      { principal: 'anyone', kind: 'public', access: 'read' },
      { principal: '10', kind: 'unknown', access: 'read' },
      { principal: 'gus@exemple.test', kind: 'user', access: 'unknown' },
      { principal: '12', kind: 'unknown', access: 'read' },
    ]);
    const u = new URL(o.calls[0] as string);
    expect(u.pathname).toBe(`/drive/v3/files/${ID(1)}/permissions`);
    expect(u.searchParams.get('supportsAllDrives')).toBe('true');
    expect(u.searchParams.get('fields')).toBe(
      'permissions(id,type,role,emailAddress,domain,deleted),nextPageToken',
    );
  });

  it('pagine les permissions', async () => {
    const o = new FakeOAuth((url) =>
      url.searchParams.get('pageToken') === 'N2'
        ? perms([{ id: '2', type: 'user', role: 'reader', emailAddress: 'b@exemple.test' }])
        : perms([{ id: '1', type: 'user', role: 'reader', emailAddress: 'a@exemple.test' }], 'N2'),
    );
    const acl = await make(o).readOriginAcl(item);
    expect(acl?.entries.map((e) => e.principal)).toEqual(['a@exemple.test', 'b@exemple.test']);
    expect(o.calls).toHaveLength(2);
  });

  it('pagination bornée à 10 pages : liste tronquée = illisible (null)', async () => {
    const o = new FakeOAuth(() =>
      perms([{ id: '1', type: 'user', role: 'reader', emailAddress: 'a@exemple.test' }], 'ENCORE'),
    );
    expect(await make(o).readOriginAcl(item)).toBeNull();
    expect(o.calls).toHaveLength(10);
  });

  it('403 / 404 / erreur quelconque : null', async () => {
    for (const e of [new OAuthApiError('interdit', 403), new OAuthApiError('absent', 404), new Error('boum')]) {
      expect(await make(new FakeOAuth(() => e)).readOriginAcl(item)).toBeNull();
    }
  });

  it('identifiant invalide : null sans appel', async () => {
    const o = new FakeOAuth();
    expect(await make(o).readOriginAcl({ externalId: '../x', name: 'a.pdf' })).toBeNull();
    expect(o.calls).toEqual([]);
  });

  it('une ACL anyone/domain n’ouvre AUCUN groupe en plus via mapOriginRights', async () => {
    const o = new FakeOAuth(() =>
      perms([
        { id: '1', type: 'user', role: 'reader', emailAddress: 'alice@exemple.test' },
        { id: '2', type: 'domain', role: 'reader', domain: 'exemple.test' },
        { id: '3', type: 'anyone', role: 'reader' },
      ]),
    );
    const acl = await make(o).readOriginAcl(item);
    const res = mapOriginRights({
      acl,
      // même si l'admin a (à tort) mappé « anyone » et le domaine : les entrées publiques sont écartées
      principalMap: { 'alice@exemple.test': 10, anyone: 99, 'exemple.test': 98 },
      fallbackUserGroupIds: [5],
    });
    expect(res.grants).toEqual([{ userGroupId: 10, permissionLevelId: 2 }]);
    expect(res.usedFallback).toBe(false);
    expect(res.ignoredEntries).toBe(2);

    const onlyPublic = await make(
      new FakeOAuth(() => perms([{ id: '3', type: 'anyone', role: 'reader' }])),
    ).readOriginAcl(item);
    const fallback = mapOriginRights({ acl: onlyPublic, principalMap: { anyone: 99 }, fallbackUserGroupIds: [5] });
    expect(fallback.grants).toEqual([{ userGroupId: 5, permissionLevelId: 2 }]);
    expect(fallback.usedFallback).toBe(true);
  });

  it('ACL illisible (null) : repli', async () => {
    const acl = await make(new FakeOAuth(() => new OAuthApiError('x', 403))).readOriginAcl(item);
    const res = mapOriginRights({ acl, principalMap: {}, fallbackUserGroupIds: [7] });
    expect(res.usedFallback).toBe(true);
    expect(res.grants).toEqual([{ userGroupId: 7, permissionLevelId: 2 }]);
  });
});

describe('google_drive — quota, erreurs et secrets', () => {
  const quota = new ConnectorQuotaError('limite atteinte', 5000);
  const item: RemoteItem = { externalId: ID(1), name: 'a.pdf', mimeType: 'application/pdf' };

  it('ConnectorQuotaError traverse listChanges (complet et changements), fetchFile et readOriginAcl', async () => {
    const c = make(new FakeOAuth(() => quota, () => quota));
    await expect(list(c)).rejects.toBe(quota);
    await expect(list(c, JSON.stringify({ p: 'chg', t: 'C1' }))).rejects.toBe(quota);
    await expect(c.fetchFile(item)).rejects.toBe(quota);
    await expect(c.readOriginAcl(item)).rejects.toBe(quota);
  });

  it('ConnectorAuthError traverse readOriginAcl et listChanges', async () => {
    const auth = new ConnectorAuthError('autorisation expirée', true);
    const c = make(new FakeOAuth(() => auth));
    await expect(c.readOriginAcl(item)).rejects.toBe(auth);
    await expect(list(c)).rejects.toBe(auth);
  });

  it('n’appelle que www.googleapis.com et jamais d’URL issue d’une réponse', async () => {
    const o = new FakeOAuth(
      drive({
        pages: { '': { files: [file(1, { webViewLink: 'https://evil.test/x' })], next: 'https://evil.test/next' } },
      }),
    );
    const c = make(o);
    const p1 = await list(c);
    await list(c, p1.nextToken).catch(() => undefined);
    const all = [...o.calls, ...o.byteCalls.map((b) => b.url)];
    for (const u of all) expect(new URL(u).origin).toBe('https://www.googleapis.com');
    // le jeton de pagination est transmis comme paramètre, pas comme URL
    expect(all.some((u) => u.includes('evil.test') && !u.includes('pageToken='))).toBe(false);
  });

  it('aucun refreshToken dans les messages d’erreur ni dans les jetons de changement', async () => {
    const messages: string[] = [];
    const record = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        messages.push(String((e as Error).message));
      }
    };
    const c = make(new FakeOAuth(() => new OAuthApiError('mauvais', 400), () => new OAuthApiError('absent', 404)));
    await record(list(c, 'illisible'));
    await record(list(c, JSON.stringify({ p: 'chg', t: 'C1' })));
    await record(c.fetchFile(item));
    await record(c.fetchFile({ externalId: '!', name: 'a.pdf' }));
    const noToken = googleDriveConnector.create({
      config: googleDriveConnector.configSchema.parse({}),
      credentials: {},
      limits: { maxFileBytes: 10, allowedExtensions: ['.pdf'] },
      deps: { oauth: new FakeOAuth() },
    });
    await record(noToken.authenticate());
    await record(list(noToken));
    expect(messages.length).toBeGreaterThanOrEqual(6);
    for (const m of messages) expect(m).not.toContain(REFRESH);
    const ok = await list(make(new FakeOAuth(drive({ files: [file(1)] }))));
    expect(ok.nextToken).not.toContain(REFRESH);
  });

  it('findMissing n’est pas implémentée', () => {
    expect(make(new FakeOAuth()).findMissing).toBeUndefined();
  });

  it('close() est inoffensif et répétable', async () => {
    const c = make(new FakeOAuth());
    await c.close();
    await c.close();
  });
});
