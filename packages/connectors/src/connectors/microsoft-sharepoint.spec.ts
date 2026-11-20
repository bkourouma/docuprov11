import { GedSourceMode } from '@archivage/types';
import { OAuthApiError, type OAuthApiClient, type OAuthRequestOptions } from '../oauth-contract';
import { ConnectorConfigError, ConnectorRegistry, buildConnector, validateConnectorInput } from '../registry';
import { ConnectorQuotaError, type SourceConnector } from '../types';
import { GRAPH_BASE } from './microsoft-graph';
import { SHAREPOINT_CONNECTOR_TYPE, sharepointConnector } from './microsoft-sharepoint';

const CREDS = { refreshToken: 'jeton-de-test-secret-0123' };
const SITE_ID = 'contoso.sharepoint.com,11111111-aaaa,22222222-bbbb';
const SITE_URL = `${GRAPH_BASE}/sites/contoso.sharepoint.com:/sites/Finance?$select=id`;
const SITE_SEG = `sites/${SITE_ID}`;
const BASE_CONFIG = { hostname: 'contoso.sharepoint.com', sitePath: '/sites/Finance' };

class FakeOAuth implements OAuthApiClient {
  calls: Array<{ kind: 'json' | 'bytes'; url: string; opts?: Record<string, unknown> }> = [];
  constructor(public handler: (url: string) => unknown) {}
  async authenticate() {}
  async getJson<T>(url: string, opts?: OAuthRequestOptions): Promise<T> {
    this.calls.push({ kind: 'json', url, opts: opts as Record<string, unknown> });
    const r = this.handler(url);
    if (r instanceof Error) throw r;
    return r as T;
  }
  async getBytes(url: string, opts: OAuthRequestOptions & { maxBytes: number; followDownloadRedirect?: boolean }) {
    this.calls.push({ kind: 'bytes', url, opts: opts as unknown as Record<string, unknown> });
    const r = this.handler(url);
    if (r instanceof Error) throw r;
    return r as { bytes: Buffer; contentType?: string };
  }
}

function registry(): ConnectorRegistry {
  const r = new ConnectorRegistry();
  r.register(sharepointConnector);
  return r;
}

function make(o: FakeOAuth, config: Record<string, unknown> = {}, limits?: { maxFileBytes?: number }): SourceConnector {
  return buildConnector(registry(), SHAREPOINT_CONNECTOR_TYPE, {
    config: { ...BASE_CONFIG, ...config },
    credentials: CREDS,
    limits,
    deps: { oauth: o },
  });
}

const spFile = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  size: 3000,
  webUrl: `https://contoso.sharepoint.com/sites/Finance/Documents/${name}`,
  createdBy: { user: { displayName: 'Alice' } },
  parentReference: { driveId: 'b!DRIVE', path: '/drives/b!DRIVE/root:/Factures' },
  file: { mimeType: 'application/pdf', hashes: { quickXorHash: `QX-${id}` } },
  ...extra,
});

/** Réponses standard : site, bibliothèque par défaut, delta. */
function standard(delta: unknown): (url: string) => unknown {
  return (url) => {
    if (url === SITE_URL) return { id: SITE_ID };
    if (url === `${GRAPH_BASE}/${SITE_SEG}/drive?$select=id,name`) return { id: 'b!DRIVE', name: 'Documents' };
    if (url.includes('/root/delta')) return delta;
    return new Error(`URL inattendue : ${url}`);
  };
}

describe('microsoft_sharepoint — définition et config', () => {
  it('décrit le connecteur', () => {
    expect(sharepointConnector.type).toBe('microsoft_sharepoint');
    expect(sharepointConnector.label).toBe('Microsoft SharePoint');
    expect(sharepointConnector.supportedModes).toEqual([
      GedSourceMode.Copie,
      GedSourceMode.IndexationEnPlace,
      GedSourceMode.Synchro,
    ]);
    expect(sharepointConnector.oauth).toEqual({
      provider: 'microsoft',
      scopes: ['offline_access', 'Sites.Read.All'],
    });
    expect(sharepointConnector.credentialFields).toEqual([]);
  });

  it('accepte une configuration valide', async () => {
    const v = await validateConnectorInput(registry(), {
      connectorType: 'microsoft_sharepoint',
      mode: GedSourceMode.Synchro,
      config: { ...BASE_CONFIG, libraryName: 'Factures', folderPath: '/2026', extensions: ['.pdf'] },
    });
    expect(v.settings).toMatchObject({ hostname: 'contoso.sharepoint.com', sitePath: '/sites/Finance' });
    await expect(
      validateConnectorInput(registry(), {
        connectorType: 'microsoft_sharepoint',
        mode: GedSourceMode.Copie,
        config: { hostname: 'Contoso-Prod.sharepoint.com', sitePath: '/teams/Equipe' },
      }),
    ).resolves.toBeDefined();
  });

  it('refuse hôte, chemin ou champ invalides', async () => {
    const bads: Array<Record<string, unknown>> = [
      {},
      { hostname: 'contoso.sharepoint.com' },
      { ...BASE_CONFIG, hostname: 'evil.example' },
      { ...BASE_CONFIG, hostname: 'contoso.sharepoint.com.evil.example' },
      { ...BASE_CONFIG, hostname: 'sharepoint.com' },
      { ...BASE_CONFIG, hostname: '10.0.0.1' },
      { ...BASE_CONFIG, hostname: 'a@contoso.sharepoint.com' },
      { ...BASE_CONFIG, hostname: 'contoso.sharepoint.com:8080' },
      { ...BASE_CONFIG, sitePath: '/Finance' },
      { ...BASE_CONFIG, sitePath: '/sites/Fin/ance' },
      { ...BASE_CONFIG, sitePath: '/sites/../x' },
      { ...BASE_CONFIG, sitePath: '/sites/' },
      { ...BASE_CONFIG, sitePath: '/sites/Finance?x=1' },
      { ...BASE_CONFIG, libraryName: '' },
      { ...BASE_CONFIG, extra: 1 },
    ];
    for (const config of bads) {
      await expect(
        validateConnectorInput(registry(), { connectorType: 'microsoft_sharepoint', mode: GedSourceMode.Copie, config }),
      ).rejects.toBeInstanceOf(ConnectorConfigError);
    }
  });
});

describe('microsoft_sharepoint — résolution du site et de la bibliothèque', () => {
  it('site puis bibliothèque par défaut, puis delta du lecteur', async () => {
    const o = new FakeOAuth(standard({ value: [spFile('I1', 'a.pdf')], '@odata.deltaLink': `${GRAPH_BASE}/drives/b!DRIVE/root/delta?token=1` }));
    const page = await make(o).listChanges(null, { pageSize: 30 });
    expect(o.calls.map((c) => c.url)).toEqual([
      SITE_URL,
      `${GRAPH_BASE}/${SITE_SEG}/drive?$select=id,name`,
      `${GRAPH_BASE}/drives/b!DRIVE/root/delta`,
    ]);
    expect(o.calls[2]?.opts).toMatchObject({ headers: { Prefer: 'odata.maxpagesize=30' } });
    expect(page.items[0]).toMatchObject({
      externalId: 'b!DRIVE:I1',
      originPath: '/Factures',
      remoteVersion: 'QX-I1',
      originMetadata: { driveId: 'b!DRIVE', siteId: SITE_ID },
    });
  });

  it('met la résolution en cache (une seule fois par instance)', async () => {
    const o = new FakeOAuth(standard({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/drives/b!DRIVE/root/delta?token=1` }));
    const c = make(o);
    await c.listChanges(null, { pageSize: 10 });
    await c.listChanges(null, { pageSize: 10 });
    expect(o.calls.filter((x) => x.url === SITE_URL)).toHaveLength(1);
  });

  it('bibliothèque par nom (insensible à la casse), avec pagination des bibliothèques', async () => {
    const page2 = `${GRAPH_BASE}/${SITE_SEG}/drives?$skiptoken=2`;
    const o = new FakeOAuth((url) => {
      if (url === SITE_URL) return { id: SITE_ID };
      if (url === `${GRAPH_BASE}/${SITE_SEG}/drives?$select=id,name`) {
        return { value: [{ id: 'b!X', name: 'Autre' }], '@odata.nextLink': page2 };
      }
      if (url === page2) return { value: [{ id: 'b!FACT', name: 'Factures' }] };
      if (url === `${GRAPH_BASE}/drives/b!FACT/root/delta`) {
        return { value: [spFile('I1', 'a.pdf', { parentReference: { driveId: 'b!FACT', path: '/drives/b!FACT/root:' } })], '@odata.deltaLink': `${GRAPH_BASE}/d?t=1` };
      }
      return new Error(`URL inattendue : ${url}`);
    });
    const page = await make(o, { libraryName: 'factures' }).listChanges(null, { pageSize: 10 });
    expect(page.items[0]?.externalId).toBe('b!FACT:I1');
    expect(page.items[0]?.originPath).toBe('/');
  });

  it('bibliothèque introuvable : erreur claire', async () => {
    const o = new FakeOAuth((url) =>
      url === SITE_URL ? { id: SITE_ID } : { value: [{ id: 'b!X', name: 'Autre' }] },
    );
    await expect(make(o, { libraryName: 'Inexistante' }).listChanges(null, { pageSize: 10 })).rejects.toThrow(
      /Bibliothèque « Inexistante » introuvable/,
    );
  });

  it('site introuvable (404) : message explicite ; la résolution en échec n’est pas mémorisée', async () => {
    let ok = false;
    const o = new FakeOAuth((url) => {
      if (url === SITE_URL) return ok ? { id: SITE_ID } : new OAuthApiError('nf', 404);
      if (url.includes('/drive?')) return { id: 'b!DRIVE' };
      return { value: [], '@odata.deltaLink': `${GRAPH_BASE}/d?t=1` };
    });
    const c = make(o);
    await expect(c.listChanges(null, { pageSize: 10 })).rejects.toThrow(/Site SharePoint introuvable/);
    ok = true;
    await expect(c.listChanges(null, { pageSize: 10 })).resolves.toBeDefined();
  });

  it('un jeton illisible est refusé avant toute résolution', async () => {
    const o = new FakeOAuth(standard({ value: [] }));
    await expect(make(o).listChanges('???', { pageSize: 10 })).rejects.toThrow(/jeton de changement invalide/i);
    expect(o.calls).toEqual([]);
  });

  it('encode les segments du nom d’hôte et du chemin', async () => {
    const o = new FakeOAuth(() => new OAuthApiError('nf', 404));
    await make(o, { hostname: 'Contoso-Prod.sharepoint.com', sitePath: '/teams/Equipe_1.2~x' })
      .listChanges(null, { pageSize: 10 })
      .catch(() => undefined);
    expect(o.calls[0]?.url).toBe(`${GRAPH_BASE}/sites/Contoso-Prod.sharepoint.com:/teams/Equipe_1.2~x?$select=id`);
  });
});

describe('microsoft_sharepoint — listage, fichiers, droits', () => {
  it('reprise depuis un jeton delta sans refaire le delta initial', async () => {
    const delta = `${GRAPH_BASE}/drives/b!DRIVE/root/delta?token=OLD`;
    const o = new FakeOAuth(standard({ value: [{ id: 'I9', deleted: {}, parentReference: { driveId: 'b!DRIVE' } }], '@odata.deltaLink': `${GRAPH_BASE}/drives/b!DRIVE/root/delta?token=NEW` }));
    const page = await make(o).listChanges(JSON.stringify({ k: 'delta', u: delta }), { pageSize: 10 });
    expect(o.calls[o.calls.length - 1]?.url).toBe(delta);
    expect(page.deletedExternalIds).toEqual(['b!DRIVE:I9']);
  });

  it('dossiers, extensions, trop gros, filtre de dossier', async () => {
    const o = new FakeOAuth(
      standard({
        value: [
          { id: 'F', name: 'Factures', folder: {}, parentReference: { driveId: 'b!DRIVE' } },
          spFile('I1', 'ok.pdf'),
          spFile('I2', 'script.js'),
          spFile('I3', 'hors.pdf', { parentReference: { driveId: 'b!DRIVE', path: '/drives/b!DRIVE/root:/Archives' } }),
          spFile('I4', 'gros.pdf', { size: 99_999 }),
        ],
        '@odata.deltaLink': `${GRAPH_BASE}/d?t=1`,
      }),
    );
    const c = make(o, { folderPath: '/Factures' }, { maxFileBytes: 5000 });
    const page = await c.listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.name)).toEqual(['ok.pdf', 'gros.pdf']);
    await expect(c.fetchFile(page.items[1] as never)).rejects.toMatchObject({ name: 'ConnectorItemRejectedError' });
  });

  it('téléchargement et droits sur le lecteur de l’élément', async () => {
    const o = new FakeOAuth((url) =>
      url.endsWith('/content')
        ? { bytes: Buffer.from('X') }
        : { value: [{ roles: ['read'], grantedToV2: { siteGroup: { displayName: 'Visiteurs', id: '4' } } }] },
    );
    const c = make(o);
    const item = { externalId: 'b!DRIVE:I1', name: 'a.pdf', byteLength: 5 };
    await c.fetchFile(item);
    expect(o.calls[0]?.url).toBe(`${GRAPH_BASE}/drives/b!DRIVE/items/I1/content`);
    expect(o.calls[0]?.opts).toMatchObject({ followDownloadRedirect: true });
    expect(await c.readOriginAcl(item)).toEqual({ entries: [{ principal: '4', kind: 'group', access: 'read' }] });
  });

  it('quota propagé', async () => {
    const quota = new ConnectorQuotaError('limite', 1000);
    await expect(make(new FakeOAuth(() => quota)).listChanges(null, { pageSize: 10 })).rejects.toBe(quota);
  });

  it('authenticate sans jeton => erreur d’autorisation expirée', async () => {
    const c = sharepointConnector.create({
      config: BASE_CONFIG,
      credentials: {},
      limits: { maxFileBytes: 10, allowedExtensions: ['.pdf'] },
      deps: { oauth: new FakeOAuth(() => ({})) },
    });
    await expect(c.authenticate()).rejects.toMatchObject({ name: 'ConnectorAuthError', expired: true });
  });
});
