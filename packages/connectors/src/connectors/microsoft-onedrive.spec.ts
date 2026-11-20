import { GedSourceMode } from '@archivage/types';
import {
  OAuthApiError,
  OAuthHostError,
  type OAuthApiClient,
  type OAuthRequestOptions,
} from '../oauth-contract';
import { ConnectorConfigError, ConnectorRegistry, buildConnector, validateConnectorInput } from '../registry';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ConnectorDeps,
  type SourceConnector,
} from '../types';
import { GRAPH_BASE } from './microsoft-graph';
import { ONEDRIVE_CONNECTOR_TYPE, onedriveConnector } from './microsoft-onedrive';

const SECRET = 'jeton-de-test-secret-0123';
const CREDS = { refreshToken: SECRET };
const FIRST = `${GRAPH_BASE}/me/drive/root/delta`;

type Handler = (url: string, kind: 'json' | 'bytes', opts?: Record<string, unknown>) => unknown;

class FakeOAuth implements OAuthApiClient {
  calls: Array<{ kind: 'json' | 'bytes'; url: string; opts?: Record<string, unknown> }> = [];
  authCalls = 0;
  authError: Error | null = null;
  constructor(public handler: Handler) {}
  async authenticate() {
    this.authCalls++;
    if (this.authError) throw this.authError;
  }
  async getJson<T>(url: string, opts?: OAuthRequestOptions): Promise<T> {
    this.calls.push({ kind: 'json', url, opts: opts as Record<string, unknown> });
    const r = this.handler(url, 'json', opts as Record<string, unknown>);
    if (r instanceof Error) throw r;
    return r as T;
  }
  async getBytes(url: string, opts: OAuthRequestOptions & { maxBytes: number; followDownloadRedirect?: boolean }) {
    this.calls.push({ kind: 'bytes', url, opts: opts as unknown as Record<string, unknown> });
    const r = this.handler(url, 'bytes', opts as unknown as Record<string, unknown>);
    if (r instanceof Error) throw r;
    return r as { bytes: Buffer; contentType?: string };
  }
}

function registry(): ConnectorRegistry {
  const r = new ConnectorRegistry();
  r.register(onedriveConnector);
  return r;
}

function make(
  oauth: FakeOAuth,
  opts: { config?: Record<string, unknown>; limits?: { maxFileBytes?: number } } = {},
): SourceConnector {
  const deps: ConnectorDeps = { oauth };
  return buildConnector(registry(), ONEDRIVE_CONNECTOR_TYPE, {
    config: opts.config ?? {},
    credentials: CREDS,
    limits: opts.limits,
    deps,
  });
}

const fileItem = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  size: 2000,
  webUrl: `https://onedrive.live.test/${id}`,
  createdDateTime: '2026-01-02T00:00:00Z',
  lastModifiedDateTime: '2026-01-03T00:00:00Z',
  createdBy: { user: { displayName: 'Alice' } },
  parentReference: { driveId: 'D1', path: '/drive/root:/Documents' },
  file: { mimeType: 'application/pdf', hashes: { sha256Hash: `H-${id}` } },
  ...extra,
});

describe('microsoft_onedrive — définition', () => {
  it('décrit le connecteur', () => {
    expect(onedriveConnector.type).toBe('microsoft_onedrive');
    expect(onedriveConnector.label).toBe('Microsoft OneDrive');
    expect(onedriveConnector.supportedModes).toEqual([
      GedSourceMode.Copie,
      GedSourceMode.IndexationEnPlace,
      GedSourceMode.Synchro,
    ]);
    expect(onedriveConnector.oauth).toEqual({ provider: 'microsoft', scopes: ['offline_access', 'Files.Read'] });
    expect(onedriveConnector.credentialFields).toEqual([]);
  });

  it('config stricte', async () => {
    const ok = await validateConnectorInput(registry(), {
      connectorType: 'microsoft_onedrive',
      mode: GedSourceMode.Copie,
      config: { folderPath: '/Documents', extensions: ['.pdf', 'docx'] },
    });
    expect(ok.settings).toEqual({ folderPath: '/Documents', extensions: ['.pdf', 'docx'] });
    for (const bad of [{ inconnu: 1 }, { folderPath: '' }, { extensions: [] }, { extensions: ['.pdf; rm'] }, { folderPath: 'a\u0001b' }]) {
      await expect(
        validateConnectorInput(registry(), { connectorType: 'microsoft_onedrive', mode: GedSourceMode.Copie, config: bad }),
      ).rejects.toBeInstanceOf(ConnectorConfigError);
    }
  });

  it('identifiants stricts : refreshToken 1..16384, scope facultatif', () => {
    const s = onedriveConnector.credentialsSchema;
    expect(s.safeParse({ refreshToken: 'x' }).success).toBe(true);
    expect(s.safeParse({ refreshToken: 'x', scope: 'Files.Read' }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ refreshToken: '' }).success).toBe(false);
    expect(s.safeParse({ refreshToken: 'x'.repeat(16_385) }).success).toBe(false);
    expect(s.safeParse({ refreshToken: 'x', autre: 'y' }).success).toBe(false);
  });

  it('le mode indexation en place est accepté', async () => {
    await expect(
      validateConnectorInput(registry(), {
        connectorType: 'microsoft_onedrive',
        mode: GedSourceMode.IndexationEnPlace,
        config: {},
      }),
    ).resolves.toBeDefined();
  });
});

describe('microsoft_onedrive — authentification', () => {
  it('délègue au client OAuth', async () => {
    const o = new FakeOAuth(() => ({}));
    await make(o).authenticate();
    expect(o.authCalls).toBe(1);
  });

  it('sans jeton de rafraîchissement : ConnectorAuthError expirée, sans appel', async () => {
    const o = new FakeOAuth(() => ({}));
    const c = onedriveConnector.create({
      config: {},
      credentials: {},
      limits: { maxFileBytes: 1000, allowedExtensions: ['.pdf'] },
      deps: { oauth: o },
    });
    await expect(c.authenticate()).rejects.toMatchObject({ name: 'ConnectorAuthError', expired: true });
    await expect(c.authenticate()).rejects.toThrow(/non autorisé/i);
    expect(o.authCalls).toBe(0);
  });

  it('propage le refus du client', async () => {
    const o = new FakeOAuth(() => ({}));
    o.authError = new ConnectorAuthError('autorisation révoquée', true);
    await expect(make(o).authenticate()).rejects.toBe(o.authError);
  });
});

describe('microsoft_onedrive — listage', () => {
  it('premier appel, pagination nextLink puis deltaLink', async () => {
    const next = `${GRAPH_BASE}/drives/D1/root/delta?$skiptoken=P2`;
    const delta = `${GRAPH_BASE}/drives/D1/root/delta?token=T1`;
    const o = new FakeOAuth((url) =>
      url === FIRST
        ? { value: [fileItem('I1', 'a.pdf'), { id: 'F', name: 'Dossier', folder: {}, parentReference: { driveId: 'D1' } }], '@odata.nextLink': next }
        : { value: [fileItem('I2', 'b.docx')], '@odata.deltaLink': delta },
    );
    const c = make(o);
    const p1 = await c.listChanges(null, { pageSize: 2 });
    expect(o.calls[0]).toMatchObject({ url: FIRST, opts: { headers: { Prefer: 'odata.maxpagesize=2' } } });
    expect(p1.items.map((i) => i.externalId)).toEqual(['D1:I1']);
    expect(p1.hasMore).toBe(true);
    expect(JSON.parse(p1.nextToken as string)).toEqual({ k: 'next', u: next });

    const p2 = await c.listChanges(p1.nextToken, { pageSize: 2 });
    expect(o.calls[1]?.url).toBe(next);
    expect(p2.items.map((i) => i.externalId)).toEqual(['D1:I2']);
    expect(p2.hasMore).toBe(false);
    expect(JSON.parse(p2.nextToken as string)).toEqual({ k: 'delta', u: delta });
    // aucune résolution de lecteur : les éléments portent leur driveId
    expect(o.calls.every((x) => !x.url.includes('/me/drive?'))).toBe(true);
  });

  it('reprise mi-parcours depuis un jeton persisté (nouvelle instance)', async () => {
    const next = `${GRAPH_BASE}/drives/D1/root/delta?$skiptoken=P2`;
    const delta = `${GRAPH_BASE}/drives/D1/root/delta?token=T1`;
    const o = new FakeOAuth((url) => (url === next ? { value: [fileItem('I2', 'b.pdf')], '@odata.deltaLink': delta } : new Error('inattendu')));
    const page = await make(o).listChanges(JSON.stringify({ k: 'next', u: next }), { pageSize: 50 });
    expect(page.items).toHaveLength(1);
    expect(o.calls).toHaveLength(1);
  });

  it('jeton delta : l’incrémental repart du deltaLink', async () => {
    const delta = `${GRAPH_BASE}/drives/D1/root/delta?token=T1`;
    const delta2 = `${GRAPH_BASE}/drives/D1/root/delta?token=T2`;
    const o = new FakeOAuth(() => ({ value: [], '@odata.deltaLink': delta2 }));
    const page = await make(o).listChanges(JSON.stringify({ k: 'delta', u: delta }), { pageSize: 50 });
    expect(o.calls[0]?.url).toBe(delta);
    expect(page.items).toEqual([]);
    expect(JSON.parse(page.nextToken as string).u).toBe(delta2);
  });

  it('jeton illisible ou à hôte étranger : erreur claire, aucun appel, URL non citée', async () => {
    const o = new FakeOAuth(() => ({ value: [] }));
    const c = make(o);
    await expect(c.listChanges('pas du json', { pageSize: 10 })).rejects.toThrow(/jeton de changement invalide/i);
    const foreign = JSON.stringify({ k: 'delta', u: 'https://evil.example/v1.0/me/drive/root/delta' });
    const err = await c.listChanges(foreign, { pageSize: 10 }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/jeton de changement invalide/i);
    expect((err as Error).message).not.toContain('evil.example');
    expect(o.calls).toEqual([]);
  });

  it('nextLink vers un autre hôte : l’erreur du client simulé remonte', async () => {
    const o = new FakeOAuth(() => new OAuthHostError('Hôte refusé.'));
    const token = JSON.stringify({ k: 'next', u: `${GRAPH_BASE}/ok` });
    await expect(make(o).listChanges(token, { pageSize: 10 })).rejects.toBeInstanceOf(OAuthHostError);
  });

  it('nextLink de réponse hors Graph : refusé par la vérification de préfixe', async () => {
    const o = new FakeOAuth(() => ({ value: [fileItem('I1', 'a.pdf')], '@odata.nextLink': 'https://evil.example/v1.0/p2' }));
    await expect(make(o).listChanges(null, { pageSize: 10 })).rejects.toThrow(/jeton de changement invalide/i);
  });

  it('410 : jeton de changement expiré, pas de relistage', async () => {
    const o = new FakeOAuth(() => new OAuthApiError('gone', 410, 'resyncRequired'));
    const token = JSON.stringify({ k: 'delta', u: `${GRAPH_BASE}/drives/D1/root/delta?token=OLD` });
    await expect(make(o).listChanges(token, { pageSize: 10 })).rejects.toThrow(/jeton de changement expiré/i);
    expect(o.calls).toHaveLength(1);
  });

  it('suppression : deletedExternalIds', async () => {
    const o = new FakeOAuth(() => ({
      value: [{ id: 'I7', deleted: { state: 'deleted' }, parentReference: { driveId: 'D1' } }],
      '@odata.deltaLink': `${GRAPH_BASE}/d?t=1`,
    }));
    const page = await make(o).listChanges(null, { pageSize: 10 });
    expect(page.deletedExternalIds).toEqual(['D1:I7']);
    expect(page.items).toEqual([]);
  });

  it('ignore les extensions non autorisées, retient les trop gros', async () => {
    const o = new FakeOAuth(() => ({
      value: [fileItem('I1', 'prog.exe'), fileItem('I2', 'gros.pdf', { size: 5000 }), fileItem('I3', 'petit.pdf', { size: 10 })],
      '@odata.deltaLink': `${GRAPH_BASE}/d?t=1`,
    }));
    const page = await make(o, { limits: { maxFileBytes: 1000 } }).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.name)).toEqual(['gros.pdf', 'petit.pdf']);
  });

  it('la config `extensions` restreint', async () => {
    const o = new FakeOAuth(() => ({
      value: [fileItem('I1', 'a.pdf'), fileItem('I2', 'b.docx')],
      '@odata.deltaLink': `${GRAPH_BASE}/d?t=1`,
    }));
    const page = await make(o, { config: { extensions: ['pdf'] } }).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.name)).toEqual(['a.pdf']);
  });

  it('folderPath filtre sur parentReference.path', async () => {
    const o = new FakeOAuth(() => ({
      value: [
        fileItem('I1', 'a.pdf', { parentReference: { driveId: 'D1', path: '/drive/root:/Documents/Finance' } }),
        fileItem('I2', 'b.pdf', { parentReference: { driveId: 'D1', path: '/drive/root:/Perso' } }),
        fileItem('I3', 'c.pdf', { parentReference: { driveId: 'D1', path: '/drive/root:/Documents/Finance/2026' } }),
      ],
      '@odata.deltaLink': `${GRAPH_BASE}/d?t=1`,
    }));
    const page = await make(o, { config: { folderPath: '/documents/finance' } }).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.name)).toEqual(['a.pdf', 'c.pdf']);
  });

  it('élément sans driveId : lecteur résolu une seule fois', async () => {
    const o = new FakeOAuth((url) =>
      url === FIRST
        ? {
            value: [fileItem('I1', 'a.pdf', { parentReference: { path: '/drive/root:/X' } }), fileItem('I2', 'b.pdf', { parentReference: { path: '/drive/root:/X' } })],
            '@odata.deltaLink': `${GRAPH_BASE}/d?t=1`,
          }
        : { id: 'RESOLU' },
    );
    const page = await make(o).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.externalId)).toEqual(['RESOLU:I1', 'RESOLU:I2']);
    expect(o.calls.filter((x) => x.url === `${GRAPH_BASE}/me/drive?$select=id`)).toHaveLength(1);
  });

  it('le quota traverse sans conversion', async () => {
    const quota = new ConnectorQuotaError('limite', 12_000);
    const o = new FakeOAuth(() => quota);
    await expect(make(o).listChanges(null, { pageSize: 10 })).rejects.toBe(quota);
  });

  it('aucun jeton dans les messages d’erreur', async () => {
    const o = new FakeOAuth(() => ({ value: [] }));
    const err = await make(o).listChanges(`${SECRET}`, { pageSize: 10 }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(SECRET);
  });
});

describe('microsoft_onedrive — fetchFile', () => {
  const remote = (over: Record<string, unknown> = {}) => ({ externalId: 'D1:I1', name: 'a.pdf', mimeType: 'application/pdf', byteLength: 10, ...over });

  it('télécharge via /content, avec redirection de téléchargement et borne', async () => {
    const o = new FakeOAuth(() => ({ bytes: Buffer.from('PDF'), contentType: 'application/pdf' }));
    const f = await make(o, { limits: { maxFileBytes: 4096 } }).fetchFile(remote());
    expect(f.bytes.toString()).toBe('PDF');
    expect(o.calls[0]).toMatchObject({
      kind: 'bytes',
      url: `${GRAPH_BASE}/drives/D1/items/I1/content`,
      opts: { maxBytes: 4096, followDownloadRedirect: true },
    });
  });

  it('refuse un fichier trop gros avant tout appel', async () => {
    const o = new FakeOAuth(() => ({ bytes: Buffer.from('x') }));
    await expect(make(o, { limits: { maxFileBytes: 100 } }).fetchFile(remote({ byteLength: 101 }))).rejects.toBeInstanceOf(
      ConnectorItemRejectedError,
    );
    expect(o.calls).toEqual([]);
  });

  it('refuse un contenu dépassant la borne, une extension ou un identifiant invalides', async () => {
    const o = new FakeOAuth(() => ({ bytes: Buffer.alloc(200) }));
    const c = make(o, { limits: { maxFileBytes: 100 } });
    await expect(c.fetchFile(remote({ byteLength: undefined }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(c.fetchFile(remote({ name: 'x.exe' }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(c.fetchFile(remote({ externalId: '../../x' }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
  });

  it('404 : élément refusé, autres erreurs inchangées', async () => {
    const gone = new FakeOAuth(() => new OAuthApiError('nf', 404));
    await expect(make(gone).fetchFile(remote())).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    const quota = new ConnectorQuotaError('limite');
    await expect(make(new FakeOAuth(() => quota)).fetchFile(remote())).rejects.toBe(quota);
  });
});

describe('microsoft_onedrive — droits', () => {
  const remote = { externalId: 'D1:I1', name: 'a.pdf' };

  it('lit les permissions du fichier', async () => {
    const o = new FakeOAuth(() => ({
      value: [
        { roles: ['owner'], grantedToV2: { user: { email: 'Alice@Exemple.Test' } } },
        { roles: ['read'], link: { scope: 'anonymous' } },
      ],
    }));
    const acl = await make(o).readOriginAcl(remote);
    expect(o.calls[0]?.url).toBe(`${GRAPH_BASE}/drives/D1/items/I1/permissions`);
    expect(acl).toEqual({
      entries: [
        { principal: 'alice@exemple.test', kind: 'user', access: 'owner' },
        { principal: 'anonymous', kind: 'public', access: 'read' },
      ],
    });
  });

  it('403 => null ; quota et autorisation propagés', async () => {
    expect(await make(new FakeOAuth(() => new OAuthApiError('403', 403))).readOriginAcl(remote)).toBeNull();
    const quota = new ConnectorQuotaError('limite');
    await expect(make(new FakeOAuth(() => quota)).readOriginAcl(remote)).rejects.toBe(quota);
    const auth = new ConnectorAuthError('révoquée');
    await expect(make(new FakeOAuth(() => auth)).readOriginAcl(remote)).rejects.toBe(auth);
  });

  it('identifiant invalide => null sans appel', async () => {
    const o = new FakeOAuth(() => ({ value: [] }));
    expect(await make(o).readOriginAcl({ externalId: 'x', name: 'a.pdf' })).toBeNull();
    expect(o.calls).toEqual([]);
  });
});
