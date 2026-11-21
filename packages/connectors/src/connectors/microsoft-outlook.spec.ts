import { GedSourceMode } from '@archivage/types';
import {
  OAuthApiError,
  OAuthHostError,
  type OAuthApiClient,
  type OAuthRequestOptions,
} from '../oauth-contract';
import { mapOriginRights } from '../rights';
import { ConnectorConfigError, ConnectorRegistry, buildConnector, validateConnectorInput } from '../registry';
import { ConnectorAuthError, ConnectorItemRejectedError, ConnectorQuotaError, type SourceConnector } from '../types';
import { GRAPH_BASE } from './microsoft-graph';
import { OUTLOOK_CONNECTOR_TYPE, outlookConnector } from './microsoft-outlook';

const SECRET = 'jeton-de-test-secret-0123';
const CREDS = { refreshToken: SECRET };
const BASE_CONFIG = { mailboxAddress: 'Archives@Exemple.Test' };
const MSG_SELECT = 'id,subject,from,receivedDateTime,hasAttachments,webLink,internetMessageId';
const FIRST = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=${MSG_SELECT}`;
const ATT_SELECT = 'id,name,contentType,size,isInline,lastModifiedDateTime';
const attUrl = (m: string) => `${GRAPH_BASE}/me/messages/${m}/attachments?$select=${ATT_SELECT}`;

class FakeOAuth implements OAuthApiClient {
  calls: Array<{ kind: 'json' | 'bytes'; url: string; opts?: Record<string, unknown> }> = [];
  authCalls = 0;
  constructor(public handler: (url: string) => unknown) {}
  async authenticate() {
    this.authCalls++;
  }
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
  r.register(outlookConnector);
  return r;
}

function make(o: FakeOAuth, config: Record<string, unknown> = {}, limits?: { maxFileBytes?: number }): SourceConnector {
  return buildConnector(registry(), OUTLOOK_CONNECTOR_TYPE, {
    config: { ...BASE_CONFIG, ...config },
    credentials: CREDS,
    limits,
    deps: { oauth: o },
  });
}

const msg = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: `Sujet ${id}`,
  from: { emailAddress: { name: 'Alice', address: 'alice@exemple.test' } },
  receivedDateTime: '2026-03-04T05:06:07Z',
  hasAttachments: true,
  webLink: `https://outlook.office.test/mail/${id}`,
  internetMessageId: `<${id}@exemple.test>`,
  ...extra,
});
const fileAtt = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  id,
  name,
  contentType: 'application/pdf',
  size: 50_000,
  isInline: false,
  lastModifiedDateTime: '2026-03-04T05:06:08Z',
  ...extra,
});

/** Réponses : delta de messages + pièces jointes par message. */
function mailbox(
  delta: Record<string, unknown>,
  atts: Record<string, unknown[]>,
): (url: string) => unknown {
  return (url) => {
    if (url === FIRST) return delta;
    for (const [m, list] of Object.entries(atts)) if (url === attUrl(m)) return { value: list };
    return new Error(`URL inattendue : ${url}`);
  };
}
const DELTA_LINK = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=T1`;

describe('microsoft_outlook — définition et config', () => {
  it('décrit le connecteur', () => {
    expect(outlookConnector.type).toBe('microsoft_outlook');
    expect(outlookConnector.label).toBe('Microsoft Outlook (pièces jointes)');
    expect(outlookConnector.supportedModes).toEqual([GedSourceMode.Copie, GedSourceMode.Synchro]);
    expect(outlookConnector.oauth).toEqual({ provider: 'microsoft', scopes: ['offline_access', 'Mail.Read'] });
    expect(outlookConnector.credentialFields).toEqual([]);
  });

  it('applique les défauts et refuse l’indexation en place', async () => {
    const v = await validateConnectorInput(registry(), {
      connectorType: 'microsoft_outlook',
      mode: GedSourceMode.Copie,
      config: BASE_CONFIG,
    });
    expect(v.settings).toMatchObject({ folder: 'inbox', includeInlineImages: false });
    await expect(
      validateConnectorInput(registry(), {
        connectorType: 'microsoft_outlook',
        mode: GedSourceMode.IndexationEnPlace,
        config: BASE_CONFIG,
      }),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });

  it('config stricte', async () => {
    const bads: Array<Record<string, unknown>> = [
      {},
      { mailboxAddress: 'pas-un-mail' },
      { ...BASE_CONFIG, folder: 'a/b' },
      { ...BASE_CONFIG, folder: '' },
      { ...BASE_CONFIG, folder: 'x'.repeat(301) },
      { ...BASE_CONFIG, includeInlineImages: 'oui' },
      { ...BASE_CONFIG, extensions: [] },
      { ...BASE_CONFIG, inconnu: true },
    ];
    for (const config of bads) {
      await expect(
        validateConnectorInput(registry(), { connectorType: 'microsoft_outlook', mode: GedSourceMode.Copie, config }),
      ).rejects.toBeInstanceOf(ConnectorConfigError);
    }
    await expect(
      validateConnectorInput(registry(), {
        connectorType: 'microsoft_outlook',
        mode: GedSourceMode.Synchro,
        config: { ...BASE_CONFIG, folder: 'AAMkAGI2TG93AAA=', includeInlineImages: true, extensions: ['.pdf'] },
      }),
    ).resolves.toBeDefined();
  });
});

describe('microsoft_outlook — authentification', () => {
  it('délègue au client ; sans jeton => autorisation expirée, sans appel', async () => {
    const o = new FakeOAuth(() => ({}));
    await make(o).authenticate();
    expect(o.authCalls).toBe(1);
    const o2 = new FakeOAuth(() => ({}));
    const c = outlookConnector.create({
      config: BASE_CONFIG,
      credentials: {},
      limits: { maxFileBytes: 10, allowedExtensions: ['.pdf'] },
      deps: { oauth: o2 },
    });
    await expect(c.authenticate()).rejects.toBeInstanceOf(ConnectorAuthError);
    await expect(c.authenticate()).rejects.toMatchObject({ expired: true, message: expect.stringMatching(/non autorisé/i) });
    expect(o2.authCalls).toBe(0);
  });
});

describe('microsoft_outlook — listage', () => {
  it('premier appel : URL delta, en-tête Prefer, éléments et jeton', async () => {
    const o = new FakeOAuth(
      mailbox({ value: [msg('M1')], '@odata.deltaLink': DELTA_LINK }, { M1: [fileAtt('A1', 'Facture mars.pdf')] }),
    );
    const page = await make(o).listChanges(null, { pageSize: 20 });
    expect(o.calls[0]).toMatchObject({ url: FIRST, opts: { headers: { Prefer: 'odata.maxpagesize=20' } } });
    expect(o.calls[1]?.url).toBe(attUrl('M1'));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      externalId: 'M1:A1',
      name: 'Facture mars.pdf',
      originUrl: 'https://outlook.office.test/mail/M1',
      originPath: 'inbox',
      mimeType: 'application/pdf',
      byteLength: 50_000,
      originAuthor: 'alice@exemple.test',
      remoteVersion: '50000',
      originMetadata: { subject: 'Sujet M1', from: 'alice@exemple.test', messageId: '<M1@exemple.test>' },
    });
    expect(page.items[0]?.originCreatedAt?.toISOString()).toBe('2026-03-04T05:06:07.000Z');
    expect(page.items[0]?.originModifiedAt?.toISOString()).toBe('2026-03-04T05:06:08.000Z');
    expect(page.hasMore).toBe(false);
    expect(page.deletedExternalIds).toEqual([]);
    expect(JSON.parse(page.nextToken as string)).toEqual({ k: 'delta', u: DELTA_LINK });
  });

  it('dossier configuré : encodé dans l’URL', async () => {
    const o = new FakeOAuth(() => new Error('stop'));
    await make(o, { folder: 'AAMk=_-1' }).listChanges(null, { pageSize: 5 }).catch(() => undefined);
    expect(o.calls[0]?.url).toBe(`${GRAPH_BASE}/me/mailFolders/AAMk%3D_-1/messages/delta?$select=${MSG_SELECT}`);
  });

  it('pagination nextLink puis deltaLink ; reprise mi-parcours', async () => {
    const next = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$skiptoken=S2`;
    const o = new FakeOAuth((url) => {
      if (url === FIRST) return { value: [msg('M1')], '@odata.nextLink': next };
      if (url === next) return { value: [msg('M2')], '@odata.deltaLink': DELTA_LINK };
      if (url === attUrl('M1')) return { value: [fileAtt('A1', 'a.pdf')] };
      if (url === attUrl('M2')) return { value: [fileAtt('A2', 'b.pdf')] };
      return new Error(`URL inattendue : ${url}`);
    });
    const c = make(o);
    const p1 = await c.listChanges(null, { pageSize: 1 });
    expect(p1.hasMore).toBe(true);
    expect(JSON.parse(p1.nextToken as string)).toEqual({ k: 'next', u: next });
    const p2 = await c.listChanges(p1.nextToken, { pageSize: 1 });
    expect(p2.items.map((i) => i.externalId)).toEqual(['M2:A2']);
    expect(p2.hasMore).toBe(false);

    // reprise par une nouvelle instance depuis le jeton persisté
    const o2 = new FakeOAuth((url) => (url === next ? { value: [], '@odata.deltaLink': DELTA_LINK } : new Error('inattendu')));
    const resumed = await make(o2).listChanges(p1.nextToken, { pageSize: 1 });
    expect(o2.calls[0]?.url).toBe(next);
    expect(resumed.hasMore).toBe(false);
  });

  it('jeton illisible ou à hôte étranger : erreur claire, aucun appel, URL non citée', async () => {
    const o = new FakeOAuth(() => ({ value: [] }));
    const c = make(o);
    await expect(c.listChanges('xx', { pageSize: 10 })).rejects.toThrow(/jeton de changement invalide/i);
    const err = await c
      .listChanges(JSON.stringify({ k: 'delta', u: 'https://evil.example/v1.0/me/messages/delta' }), { pageSize: 10 })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/jeton de changement invalide/i);
    expect((err as Error).message).not.toContain('evil.example');
    expect(o.calls).toEqual([]);
  });

  it('nextLink hors Graph : refusé (préfixe) ; erreur d’hôte du client : remontée', async () => {
    const o = new FakeOAuth(() => ({ value: [], '@odata.nextLink': 'https://evil.example/v1.0/x' }));
    await expect(make(o).listChanges(null, { pageSize: 10 })).rejects.toThrow(/jeton de changement invalide/i);
    const host = new OAuthHostError('Hôte refusé.');
    const o2 = new FakeOAuth(() => host);
    await expect(
      make(o2).listChanges(JSON.stringify({ k: 'next', u: `${GRAPH_BASE}/ok` }), { pageSize: 10 }),
    ).rejects.toBe(host);
  });

  it('410 : jeton de changement expiré', async () => {
    const o = new FakeOAuth(() => new OAuthApiError('gone', 410, 'resyncRequired'));
    const token = JSON.stringify({ k: 'delta', u: DELTA_LINK });
    await expect(make(o).listChanges(token, { pageSize: 10 })).rejects.toThrow(/jeton de changement expiré/i);
  });

  it('quota traverse (liste de messages comme pièces jointes)', async () => {
    const quota = new ConnectorQuotaError('limite', 9000);
    await expect(make(new FakeOAuth(() => quota)).listChanges(null, { pageSize: 10 })).rejects.toBe(quota);
    const o = new FakeOAuth((url) => (url === FIRST ? { value: [msg('M1')], '@odata.deltaLink': DELTA_LINK } : quota));
    await expect(make(o).listChanges(null, { pageSize: 10 })).rejects.toBe(quota);
  });

  it('messages sans pièce jointe : aucun appel de pièces jointes', async () => {
    const o = new FakeOAuth(mailbox({ value: [msg('M1', { hasAttachments: false })], '@odata.deltaLink': DELTA_LINK }, {}));
    const page = await make(o).listChanges(null, { pageSize: 10 });
    expect(page.items).toEqual([]);
    expect(o.calls).toHaveLength(1);
  });
});

describe('microsoft_outlook — pièces jointes', () => {
  it('ne garde que les fichiers (pas item/reference), écarte inline, petites images et extensions', async () => {
    const o = new FakeOAuth(
      mailbox(
        { value: [msg('M1')], '@odata.deltaLink': DELTA_LINK },
        {
          M1: [
            fileAtt('A1', 'bon.pdf'),
            { '@odata.type': '#microsoft.graph.itemAttachment', id: 'A2', name: 'message.eml', size: 9000 },
            { '@odata.type': '#microsoft.graph.referenceAttachment', id: 'A3', name: 'lien.pdf', size: 9000 },
            fileAtt('A4', 'incorpore.png', { contentType: 'image/png', size: 80_000, isInline: true }),
            fileAtt('A5', 'logo.png', { contentType: 'image/png', size: 4_000 }),
            fileAtt('A6', 'setup.exe', { contentType: 'application/octet-stream' }),
            fileAtt('A7', 'photo.jpg', { contentType: 'image/jpeg', size: 200_000 }),
          ],
        },
      ),
    );
    const page = await make(o).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.externalId)).toEqual(['M1:A1', 'M1:A7']);
  });

  it('includeInlineImages : garde l’image incorporée, mais jamais une petite image', async () => {
    const o = new FakeOAuth(
      mailbox(
        { value: [msg('M1')], '@odata.deltaLink': DELTA_LINK },
        {
          M1: [
            fileAtt('A4', 'incorpore.png', { contentType: 'image/png', size: 80_000, isInline: true }),
            fileAtt('A5', 'logo.png', { contentType: 'image/png', size: 4_000, isInline: true }),
          ],
        },
      ),
    );
    const page = await make(o, { includeInlineImages: true }).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.externalId)).toEqual(['M1:A4']);
  });

  it('plusieurs pièces jointes par message : plus d’éléments que pageSize (accepté)', async () => {
    const o = new FakeOAuth(
      mailbox(
        { value: [msg('M1')], '@odata.deltaLink': DELTA_LINK },
        { M1: [fileAtt('A1', 'a.pdf'), fileAtt('A2', 'b.pdf'), fileAtt('A3', 'c.pdf')] },
      ),
    );
    const page = await make(o).listChanges(null, { pageSize: 1 });
    expect(page.items).toHaveLength(3);
  });

  it('suit la pagination des pièces jointes (nextLink vérifié)', async () => {
    const more = `${GRAPH_BASE}/me/messages/M1/attachments?$skiptoken=2`;
    const o = new FakeOAuth((url) => {
      if (url === FIRST) return { value: [msg('M1')], '@odata.deltaLink': DELTA_LINK };
      if (url === attUrl('M1')) return { value: [fileAtt('A1', 'a.pdf')], '@odata.nextLink': more };
      if (url === more) return { value: [fileAtt('A2', 'b.pdf')], '@odata.nextLink': 'https://evil.example/x' };
      return new Error(`URL inattendue : ${url}`);
    });
    const page = await make(o).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.externalId)).toEqual(['M1:A1', 'M1:A2']);
    expect(o.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('message disparu entre le delta et la lecture (404) : ignoré', async () => {
    const o = new FakeOAuth((url) =>
      url === FIRST ? { value: [msg('M1'), msg('M2')], '@odata.deltaLink': DELTA_LINK } : url === attUrl('M1') ? new OAuthApiError('nf', 404) : { value: [fileAtt('A2', 'b.pdf')] },
    );
    const page = await make(o).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.externalId)).toEqual(['M2:A2']);
  });

  it('la config `extensions` restreint', async () => {
    const o = new FakeOAuth(
      mailbox({ value: [msg('M1')], '@odata.deltaLink': DELTA_LINK }, { M1: [fileAtt('A1', 'a.pdf'), fileAtt('A2', 'b.docx')] }),
    );
    const page = await make(o, { extensions: ['docx'] }).listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.name)).toEqual(['b.docx']);
  });
});

describe('microsoft_outlook — suppressions', () => {
  it('@removed : mémorisé, et findMissing rend les éléments de ces messages sans appel réseau', async () => {
    const o = new FakeOAuth(
      mailbox(
        {
          value: [{ id: 'M9', '@removed': { reason: 'deleted' } }, msg('M1')],
          '@odata.deltaLink': DELTA_LINK,
        },
        { M1: [fileAtt('A1', 'a.pdf')] },
      ),
    );
    const c = make(o);
    const page = await c.listChanges(null, { pageSize: 10 });
    expect(page.items.map((i) => i.externalId)).toEqual(['M1:A1']);
    expect(page.deletedExternalIds).toEqual([]);
    const callsBefore = o.calls.length;
    const missing = await c.findMissing?.(['M9:A1', 'M9:A2', 'M1:A1', 'M99:A1', 'M9']);
    expect(missing).toEqual(['M9:A1', 'M9:A2']);
    expect(o.calls.length).toBe(callsBefore);
  });

  it('un identifiant qui ne fait que commencer comme un message supprimé n’est pas pris', async () => {
    const o = new FakeOAuth(mailbox({ value: [{ id: 'M9', '@removed': {} }], '@odata.deltaLink': DELTA_LINK }, {}));
    const c = make(o);
    await c.listChanges(null, { pageSize: 10 });
    expect(await c.findMissing?.(['M90:A1', 'M9X:A1', 'M9:A1'])).toEqual(['M9:A1']);
  });

  it('sans suppression vue : findMissing vide', async () => {
    const c = make(new FakeOAuth(() => ({})));
    expect(await c.findMissing?.(['M1:A1'])).toEqual([]);
  });

  it('limite documentée : la mémoire ne survit pas à une nouvelle instance', async () => {
    const o = new FakeOAuth(mailbox({ value: [{ id: 'M9', '@removed': {} }], '@odata.deltaLink': DELTA_LINK }, {}));
    await make(o).listChanges(null, { pageSize: 10 });
    expect(await make(new FakeOAuth(() => ({}))).findMissing?.(['M9:A1'])).toEqual([]);
  });
});

describe('microsoft_outlook — fetchFile et droits', () => {
  const remote = (over: Record<string, unknown> = {}) => ({
    externalId: 'M1:A1',
    name: 'a.pdf',
    mimeType: 'application/pdf',
    byteLength: 100,
    ...over,
  });

  it('télécharge /$value sans redirection, borné', async () => {
    const o = new FakeOAuth(() => ({ bytes: Buffer.from('PDF') }));
    const f = await make(o, {}, { maxFileBytes: 2048 }).fetchFile(remote());
    expect(f).toMatchObject({ name: 'a.pdf', mimeType: 'application/pdf' });
    expect(f.bytes.toString()).toBe('PDF');
    expect(o.calls[0]?.url).toBe(`${GRAPH_BASE}/me/messages/M1/attachments/A1/$value`);
    expect(o.calls[0]?.opts).toMatchObject({ maxBytes: 2048 });
    expect(o.calls[0]?.opts?.followDownloadRedirect).toBeUndefined();
  });

  it('refuse trop gros, extension interdite, identifiant invalide ; 404 => refusé', async () => {
    const o = new FakeOAuth(() => ({ bytes: Buffer.alloc(500) }));
    const c = make(o, {}, { maxFileBytes: 100 });
    await expect(c.fetchFile(remote({ byteLength: 101 }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(c.fetchFile(remote({ byteLength: undefined }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(c.fetchFile(remote({ name: 'x.exe' }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(c.fetchFile(remote({ externalId: 'M1/../A1' }))).rejects.toBeInstanceOf(ConnectorItemRejectedError);
    await expect(make(new FakeOAuth(() => new OAuthApiError('nf', 404))).fetchFile(remote())).rejects.toBeInstanceOf(
      ConnectorItemRejectedError,
    );
    const quota = new ConnectorQuotaError('limite');
    await expect(make(new FakeOAuth(() => quota)).fetchFile(remote())).rejects.toBe(quota);
  });

  it('droits : un seul principal, la boîte en minuscules, en lecture (sans appel)', async () => {
    const o = new FakeOAuth(() => new Error('aucun appel attendu'));
    const acl = await make(o).readOriginAcl(remote());
    expect(acl).toEqual({ entries: [{ principal: 'archives@exemple.test', kind: 'user', access: 'read' }] });
    expect(o.calls).toEqual([]);
    const mapped = mapOriginRights({ acl, principalMap: { 'Archives@Exemple.test': 7 }, fallbackUserGroupIds: [1] });
    expect(mapped.grants.map((g) => g.userGroupId)).toEqual([7]);
  });

  it('aucun jeton dans les messages d’erreur', async () => {
    const o = new FakeOAuth(() => ({ value: [] }));
    const err = await make(o).listChanges(SECRET, { pageSize: 10 }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(SECRET);
  });
});
