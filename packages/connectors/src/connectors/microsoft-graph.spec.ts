import { mapOriginRights } from '../rights';
import {
  OAuthApiError,
  OAuthHostError,
  type OAuthApiClient,
  type OAuthRequestOptions,
} from '../oauth-contract';
import { ConnectorAuthError, ConnectorQuotaError } from '../types';
import {
  GRAPH_BASE,
  accessFromRoles,
  assertGraphUrl,
  cleanDrivePath,
  encodeDeltaToken,
  fetchDeltaPage,
  isGraphUrl,
  isInFolder,
  mapDriveItem,
  mapGraphPermissions,
  normalizeFolderPath,
  parseDeltaToken,
  parseDriveExternalId,
  readDriveItemAcl,
  resolveAllowedExtensions,
  type GraphPermission,
} from './microsoft-graph';

const FIRST = `${GRAPH_BASE}/me/drive/root/delta`;
const ALLOWED = new Set(['.pdf', '.docx', '.txt']);

type Handler = (url: string, opts?: OAuthRequestOptions) => unknown;

function fake(handler: Handler): OAuthApiClient & { urls: string[]; headers: Array<Record<string, string> | undefined> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  return {
    urls,
    headers,
    async authenticate() {},
    async getJson<T>(url: string, opts?: OAuthRequestOptions): Promise<T> {
      urls.push(url);
      headers.push(opts?.headers);
      const r = handler(url, opts);
      if (r instanceof Error) throw r;
      return r as T;
    },
    async getBytes() {
      throw new Error('non utilisé');
    },
  };
}

describe('microsoft-graph — URL et jeton de changement', () => {
  it('reconnaît seulement le préfixe exact de Graph v1.0', () => {
    expect(isGraphUrl(`${GRAPH_BASE}/me/drive/root/delta`)).toBe(true);
    expect(isGraphUrl('https://graph.microsoft.com/v1.0')).toBe(false);
    expect(isGraphUrl('https://graph.microsoft.com/beta/me')).toBe(false);
    expect(isGraphUrl('https://evil.example/v1.0/x')).toBe(false);
    expect(isGraphUrl('https://graph.microsoft.com.evil.example/v1.0/x')).toBe(false);
    expect(isGraphUrl('http://graph.microsoft.com/v1.0/x')).toBe(false);
    expect(isGraphUrl('https://graph.microsoft.com@evil.example/v1.0/x')).toBe(false);
    expect(isGraphUrl(undefined)).toBe(false);
    expect(isGraphUrl(42)).toBe(false);
  });

  it('assertGraphUrl lève sans citer l’URL', () => {
    const bad = 'https://evil.example/v1.0/secret?token=ABC';
    let message = '';
    try {
      assertGraphUrl(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/jeton de changement invalide/i);
    expect(message).not.toContain('evil.example');
    expect(message).not.toContain('ABC');
  });

  it('encode en JSON compact et relit le jeton', () => {
    const raw = encodeDeltaToken({ k: 'next', u: `${GRAPH_BASE}/x?skiptoken=1` });
    expect(raw).toBe(JSON.stringify({ k: 'next', u: `${GRAPH_BASE}/x?skiptoken=1` }));
    expect(parseDeltaToken(raw)).toEqual({ k: 'next', u: `${GRAPH_BASE}/x?skiptoken=1` });
    expect(parseDeltaToken(encodeDeltaToken({ k: 'delta', u: `${GRAPH_BASE}/y` })).k).toBe('delta');
  });

  it('refuse un jeton illisible ou mal formé', () => {
    for (const bad of ['nope', '', '[]', 'null', '{"k":"x","u":"https://graph.microsoft.com/v1.0/a"}', '{"k":"next"}', '{"k":"next","u":3}']) {
      expect(() => parseDeltaToken(bad)).toThrow(/jeton de changement invalide/i);
    }
  });

  it('refuse un jeton dont l’hôte est étranger, sans citer l’URL', () => {
    const raw = JSON.stringify({ k: 'next', u: 'https://evil.example/v1.0/me/drive/root/delta' });
    let message = '';
    try {
      parseDeltaToken(raw);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/jeton de changement invalide/i);
    expect(message).not.toContain('evil.example');
  });
});

describe('microsoft-graph — fetchDeltaPage', () => {
  it('premier appel : URL initiale et en-tête Prefer', async () => {
    const c = fake(() => ({ value: [{ id: 'a' }], '@odata.deltaLink': `${GRAPH_BASE}/me/drive/root/delta?token=T1` }));
    const page = await fetchDeltaPage<{ id: string }>(c, null, FIRST, 25);
    expect(c.urls).toEqual([FIRST]);
    expect(c.headers[0]).toEqual({ Prefer: 'odata.maxpagesize=25' });
    expect(page.hasMore).toBe(false);
    expect(JSON.parse(page.nextToken)).toEqual({ k: 'delta', u: `${GRAPH_BASE}/me/drive/root/delta?token=T1` });
  });

  it('nextLink => hasMore et jeton next ; reprise mi-parcours depuis ce jeton', async () => {
    const next = `${GRAPH_BASE}/me/drive/root/delta?$skiptoken=S2`;
    const delta = `${GRAPH_BASE}/me/drive/root/delta?token=T9`;
    const c = fake((url) =>
      url === FIRST
        ? { value: [{ id: '1' }], '@odata.nextLink': next }
        : { value: [{ id: '2' }], '@odata.deltaLink': delta },
    );
    const p1 = await fetchDeltaPage<{ id: string }>(c, null, FIRST, 10);
    expect(p1.hasMore).toBe(true);
    expect(JSON.parse(p1.nextToken)).toEqual({ k: 'next', u: next });
    // « plantage » : une nouvelle instance reprend depuis le jeton persisté
    const c2 = fake((url) => (url === next ? { value: [{ id: '2' }], '@odata.deltaLink': delta } : new Error('inattendu')));
    const p2 = await fetchDeltaPage<{ id: string }>(c2, p1.nextToken, FIRST, 10);
    expect(c2.urls).toEqual([next]);
    expect(c2.headers[0]).toEqual({ Prefer: 'odata.maxpagesize=10' });
    expect(p2.hasMore).toBe(false);
    expect(JSON.parse(p2.nextToken)).toEqual({ k: 'delta', u: delta });
  });

  it('un jeton delta repart de l’URL du deltaLink', async () => {
    const delta = `${GRAPH_BASE}/me/drive/root/delta?token=T9`;
    const c = fake(() => ({ value: [], '@odata.deltaLink': `${GRAPH_BASE}/me/drive/root/delta?token=T10` }));
    await fetchDeltaPage(c, encodeDeltaToken({ k: 'delta', u: delta }), FIRST, 10);
    expect(c.urls).toEqual([delta]);
  });

  it('refuse un jeton à hôte étranger AVANT tout appel', async () => {
    const c = fake(() => ({ value: [] }));
    await expect(
      fetchDeltaPage(c, JSON.stringify({ k: 'delta', u: 'https://evil.example/v1.0/x' }), FIRST, 10),
    ).rejects.toThrow(/jeton de changement invalide/i);
    expect(c.urls).toEqual([]);
  });

  it('refuse un nextLink / deltaLink de réponse hors Graph (préfixe testé directement)', async () => {
    const c1 = fake(() => ({ value: [], '@odata.nextLink': 'https://evil.example/v1.0/page2' }));
    await expect(fetchDeltaPage(c1, null, FIRST, 10)).rejects.toThrow(/jeton de changement invalide/i);
    const c2 = fake(() => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/beta/x' }));
    await expect(fetchDeltaPage(c2, null, FIRST, 10)).rejects.toThrow(/jeton de changement invalide/i);
  });

  it('l’erreur d’hôte du client (OAuthHostError) remonte telle quelle', async () => {
    const boom = new OAuthHostError('Hôte refusé.');
    const c = fake(() => boom);
    await expect(
      fetchDeltaPage(c, encodeDeltaToken({ k: 'next', u: `${GRAPH_BASE}/ok` }), FIRST, 10),
    ).rejects.toBe(boom);
  });

  it('réponse sans lien de suite : erreur explicite', async () => {
    const c = fake(() => ({ value: [] }));
    await expect(fetchDeltaPage(c, null, FIRST, 10)).rejects.toThrow(/aucun lien/i);
  });

  it('410 sur un jeton => « jeton de changement expiré », sans relistage', async () => {
    const c = fake(() => new OAuthApiError('gone', 410, 'resyncRequired'));
    await expect(
      fetchDeltaPage(c, encodeDeltaToken({ k: 'delta', u: `${GRAPH_BASE}/d?token=OLD` }), FIRST, 10),
    ).rejects.toThrow(/jeton de changement expiré/i);
    expect(c.urls).toHaveLength(1);
  });

  it('propage quota et autorisation sans conversion', async () => {
    const quota = new ConnectorQuotaError('limite', 5000);
    await expect(fetchDeltaPage(fake(() => quota), null, FIRST, 10)).rejects.toBe(quota);
    const auth = new ConnectorAuthError('expirée', true);
    await expect(fetchDeltaPage(fake(() => auth), null, FIRST, 10)).rejects.toBe(auth);
    const other = new OAuthApiError('introuvable', 404);
    await expect(fetchDeltaPage(fake(() => other), null, FIRST, 10)).rejects.toBe(other);
  });
});

describe('microsoft-graph — chemins et extensions', () => {
  it('nettoie parentReference.path', () => {
    expect(cleanDrivePath('/drive/root:')).toBe('/');
    expect(cleanDrivePath('/drive/root:/Documents/Finance')).toBe('/Documents/Finance');
    expect(cleanDrivePath('/drives/b!abc/root:/Docs%20partag%C3%A9s/')).toBe('/Docs partagés');
    expect(cleanDrivePath(undefined)).toBeUndefined();
    expect(cleanDrivePath('')).toBeUndefined();
  });

  it('filtre de dossier : insensible à la casse, frontière de segment', () => {
    expect(normalizeFolderPath('Documents/Finance/')).toBe('/Documents/Finance');
    expect(normalizeFolderPath('/')).toBe('/');
    expect(isInFolder('/Documents/Finance', '/documents/finance')).toBe(true);
    expect(isInFolder('/Documents/Finance/2026', '/Documents/Finance')).toBe(true);
    expect(isInFolder('/Documents/FinanceBis', '/Documents/Finance')).toBe(false);
    expect(isInFolder('/Autre', '/Documents')).toBe(false);
    expect(isInFolder('/Autre', '/')).toBe(true);
  });

  it('les extensions configurées ne font que restreindre', () => {
    const base = ['.pdf', '.docx'];
    expect([...resolveAllowedExtensions(base)].sort()).toEqual(['.docx', '.pdf']);
    expect([...resolveAllowedExtensions(base, ['PDF'])]).toEqual(['.pdf']);
    expect([...resolveAllowedExtensions(base, ['.exe', '.pdf'])]).toEqual(['.pdf']);
    expect([...resolveAllowedExtensions(base, ['.exe'])]).toEqual([]);
  });

  it('parse un externalId de fichier', () => {
    expect(parseDriveExternalId('b!AbC-1:01XYZ')).toEqual({ driveId: 'b!AbC-1', itemId: '01XYZ' });
    expect(parseDriveExternalId('sans-deux-points')).toBeNull();
    expect(parseDriveExternalId('a/../b:c')).toBeNull();
    expect(parseDriveExternalId('a:b/c')).toBeNull();
  });
});

describe('microsoft-graph — mapDriveItem', () => {
  const ctx = { driveId: 'D1', allowed: ALLOWED };
  const file = (extra: Record<string, unknown> = {}) => ({
    id: 'I1',
    name: 'Facture.pdf',
    size: 1234,
    webUrl: 'https://contoso.sharepoint.com/f',
    cTag: 'ctag',
    eTag: 'etag',
    createdDateTime: '2026-01-02T03:04:05Z',
    lastModifiedDateTime: '2026-02-03T04:05:06Z',
    createdBy: { user: { displayName: 'Alice A', email: 'alice@exemple.test' } },
    parentReference: { driveId: 'D1', path: '/drive/root:/Documents/Finance' },
    file: { mimeType: 'application/pdf', hashes: { sha256Hash: 'S256', sha1Hash: 'S1', quickXorHash: 'QX' } },
    ...extra,
  });

  it('mappe un fichier', () => {
    const r = mapDriveItem(file(), { ...ctx, extraMetadata: { siteId: 'S' } });
    expect(r).toEqual({
      item: {
        externalId: 'D1:I1',
        name: 'Facture.pdf',
        originUrl: 'https://contoso.sharepoint.com/f',
        originPath: '/Documents/Finance',
        mimeType: 'application/pdf',
        byteLength: 1234,
        originAuthor: 'Alice A',
        originCreatedAt: new Date('2026-01-02T03:04:05Z'),
        originModifiedAt: new Date('2026-02-03T04:05:06Z'),
        remoteVersion: 'S256',
        originMetadata: { driveId: 'D1', siteId: 'S' },
      },
    });
  });

  it('remoteVersion : sha256 > sha1 > quickXor > cTag > eTag', () => {
    const v = (f: Record<string, unknown>) => {
      const r = mapDriveItem(file(f), ctx);
      return r && 'item' in r ? r.item.remoteVersion : 'ABSENT';
    };
    expect(v({ file: { hashes: { sha1Hash: 'S1', quickXorHash: 'QX' } } })).toBe('S1');
    expect(v({ file: { hashes: { quickXorHash: 'QX' } } })).toBe('QX');
    expect(v({ file: {} })).toBe('ctag');
    expect(v({ file: {}, cTag: undefined })).toBe('etag');
  });

  it('auteur : nom, sinon e-mail', () => {
    const r = mapDriveItem(file({ createdBy: { user: { email: 'b@exemple.test' } } }), ctx);
    expect(r && 'item' in r && r.item.originAuthor).toBe('b@exemple.test');
  });

  it('ignore dossiers, éléments sans facette fichier, extensions non autorisées', () => {
    expect(mapDriveItem({ id: 'F', name: 'Sous-dossier', folder: { childCount: 3 } }, ctx)).toBeNull();
    expect(mapDriveItem({ id: 'P', name: 'Carnet', package: { type: 'oneNote' } } as never, ctx)).toBeNull();
    expect(mapDriveItem(file({ name: 'setup.exe' }), ctx)).toBeNull();
    expect(mapDriveItem(file({ name: 'sans-extension' }), ctx)).toBeNull();
  });

  it('renvoie un fichier trop gros (le refus a lieu à la récupération)', () => {
    const r = mapDriveItem(file({ size: 999_999_999_999 }), ctx);
    expect(r && 'item' in r && r.item.byteLength).toBe(999_999_999_999);
  });

  it('suppression : facette deleted => identifiant externe', () => {
    expect(mapDriveItem({ id: 'I9', deleted: { state: 'deleted' }, parentReference: { driveId: 'D1' } }, ctx)).toEqual({
      deleted: 'D1:I9',
    });
  });

  it('filtre de dossier côté client ; chemin absent => écarté', () => {
    const inCtx = { ...ctx, folderPath: '/Documents' };
    expect(mapDriveItem(file(), inCtx)).not.toBeNull();
    expect(mapDriveItem(file({ parentReference: { driveId: 'D1', path: '/drive/root:/Autre' } }), inCtx)).toBeNull();
    expect(mapDriveItem(file({ parentReference: { driveId: 'D1' } }), inCtx)).toBeNull();
    // sans filtre, le chemin absent est sans importance
    expect(mapDriveItem(file({ parentReference: { driveId: 'D1' } }), ctx)).not.toBeNull();
  });

  it('ignore un identifiant d’élément douteux', () => {
    expect(mapDriveItem(file({ id: '../x' }), ctx)).toBeNull();
    expect(mapDriveItem(file({ id: undefined }), ctx)).toBeNull();
  });
});

describe('microsoft-graph — droits', () => {
  it('rôles : owner > write > read, le reste est inconnu', () => {
    expect(accessFromRoles(['owner'])).toBe('owner');
    expect(accessFromRoles(['read', 'write'])).toBe('write');
    expect(accessFromRoles(['write'])).toBe('write');
    expect(accessFromRoles(['edit'])).toBe('write');
    expect(accessFromRoles(['sp.full control'])).toBe('write');
    expect(accessFromRoles(['SP.Full Control'])).toBe('write');
    expect(accessFromRoles(['read'])).toBe('read');
    expect(accessFromRoles(['sp.limited access'])).toBe('unknown');
    expect(accessFromRoles([])).toBe('unknown');
    expect(accessFromRoles(undefined)).toBe('unknown');
  });

  it('mappe utilisateurs, groupes, liens et identités', () => {
    const perms: GraphPermission[] = [
      { roles: ['owner'], grantedToV2: { user: { displayName: 'Alice', email: 'Alice@Exemple.Test', id: 'u1' } } },
      { roles: ['write'], grantedToV2: { user: { displayName: 'Sans mail', id: 'u2' } } },
      { roles: ['read'], grantedToV2: { group: { displayName: 'Finance', email: 'Finance@Exemple.Test', id: 'g1' } } },
      { roles: ['sp.full control'], grantedToV2: { siteGroup: { displayName: 'Propriétaires', id: '3' } } },
      {
        roles: ['read'],
        link: { scope: 'users', type: 'view' },
        grantedToIdentitiesV2: [
          { user: { email: 'bob@exemple.test' } },
          { user: { email: 'carol@exemple.test' } },
        ],
      },
      { roles: ['read'], link: { scope: 'anonymous', type: 'view' } },
      { roles: ['write'], link: { scope: 'organization', type: 'edit' } },
      { roles: ['read'], grantedToV2: { application: { id: 'app' } } },
    ];
    const acl = mapGraphPermissions(perms);
    expect(acl.entries).toEqual([
      { principal: 'alice@exemple.test', kind: 'user', access: 'owner' },
      { principal: 'u2', kind: 'user', access: 'write' },
      { principal: 'finance@exemple.test', kind: 'group', access: 'read' },
      { principal: '3', kind: 'group', access: 'write' },
      { principal: 'bob@exemple.test', kind: 'user', access: 'read' },
      { principal: 'carol@exemple.test', kind: 'user', access: 'read' },
      { principal: 'anonymous', kind: 'public', access: 'read' },
      { principal: 'organization', kind: 'public', access: 'write' },
    ]);
  });

  it('un lien anonyme ou d’organisation ne donne AUCUN groupe en plus via mapOriginRights', () => {
    const named = mapGraphPermissions([
      { roles: ['read'], grantedToV2: { user: { email: 'alice@exemple.test' } } },
    ]);
    const withLinks = mapGraphPermissions([
      { roles: ['read'], grantedToV2: { user: { email: 'alice@exemple.test' } } },
      { roles: ['write'], link: { scope: 'anonymous' } },
      { roles: ['write'], link: { scope: 'organization' } },
    ]);
    // Même si l'administrateur avait (à tort) mappé « anonymous » / « organization » à un groupe.
    const principalMap = { 'alice@exemple.test': 10, anonymous: 98, organization: 99 };
    const a = mapOriginRights({ acl: named, principalMap, fallbackUserGroupIds: [1] });
    const b = mapOriginRights({ acl: withLinks, principalMap, fallbackUserGroupIds: [1] });
    expect(b.grants).toEqual(a.grants);
    expect(b.grants.map((g) => g.userGroupId)).toEqual([10]);
    expect(b.ignoredEntries).toBe(2);

    // Uniquement des liens publics : jamais de groupe, retombée sur le repli de l'administrateur.
    const onlyLinks = mapGraphPermissions([
      { roles: ['read'], link: { scope: 'anonymous' } },
      { roles: ['read'], link: { scope: 'organization' } },
    ]);
    const c = mapOriginRights({ acl: onlyLinks, principalMap, fallbackUserGroupIds: [1] });
    expect(c.usedFallback).toBe(true);
    expect(c.grants.map((g) => g.userGroupId)).toEqual([1]);
    const d = mapOriginRights({ acl: onlyLinks, principalMap, fallbackUserGroupIds: [] });
    expect(d.grants).toEqual([]);
    expect(d.restricted).toBe(false);
  });

  it('readDriveItemAcl : pagination, encodage des segments', async () => {
    const page2 = `${GRAPH_BASE}/drives/b!D/items/I/permissions?$skiptoken=2`;
    const c = fake((url) =>
      url.endsWith('/permissions')
        ? { value: [{ roles: ['read'], grantedToV2: { user: { email: 'a@exemple.test' } } }], '@odata.nextLink': page2 }
        : { value: [{ roles: ['write'], grantedToV2: { user: { email: 'b@exemple.test' } } }] },
    );
    const acl = await readDriveItemAcl(c, 'b!D', 'I');
    expect(c.urls[0]).toBe(`${GRAPH_BASE}/drives/b!D/items/I/permissions`);
    expect(c.urls[1]).toBe(page2);
    expect(acl?.entries.map((e) => e.principal)).toEqual(['a@exemple.test', 'b@exemple.test']);
  });

  it('readDriveItemAcl : plus de 10 pages => null ; nextLink étranger => null', async () => {
    const endless = fake(() => ({ value: [], '@odata.nextLink': `${GRAPH_BASE}/drives/D/items/I/permissions?x=1` }));
    expect(await readDriveItemAcl(endless, 'D', 'I')).toBeNull();
    expect(endless.urls).toHaveLength(10);
    const foreign = fake(() => ({ value: [], '@odata.nextLink': 'https://evil.example/x' }));
    expect(await readDriveItemAcl(foreign, 'D', 'I')).toBeNull();
    expect(foreign.urls).toHaveLength(1);
  });

  it('readDriveItemAcl : échec => null, sauf autorisation et quota', async () => {
    expect(await readDriveItemAcl(fake(() => new OAuthApiError('403', 403)), 'D', 'I')).toBeNull();
    expect(await readDriveItemAcl(fake(() => new OAuthApiError('404', 404)), 'D', 'I')).toBeNull();
    expect(await readDriveItemAcl(fake(() => new Error('réseau')), 'D', 'I')).toBeNull();
    const auth = new ConnectorAuthError('révoquée', true);
    await expect(readDriveItemAcl(fake(() => auth), 'D', 'I')).rejects.toBe(auth);
    const quota = new ConnectorQuotaError('limite');
    await expect(readDriveItemAcl(fake(() => quota), 'D', 'I')).rejects.toBe(quota);
  });
});
