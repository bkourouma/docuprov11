import { GedSourceMode } from '@archivage/types';
import { createDefaultRegistry } from '../default-registry';
import { buildConnector, validateConnectorInput } from '../registry';
import { ConnectorAuthError } from '../types';
import type { WhatsappHttp, WhatsappHttpRequest } from '../whatsapp-graph';
import { createWhatsappConnectorDefinition } from './whatsapp';

const CREDS = {
  accessToken: 'EAAGtestTOKEN0123456789abcdef',
  appSecret: 'appsecret-0123456789ab',
  verifyToken: 'verify-token-xyz',
};
const CONFIG = {
  phoneNumberId: '109876543210',
  senders: [{ phone: '+33 6 12 34 56 78', label: 'Alice' }],
  rights: { principalMap: { 'wa:33612345678': 7 }, fallbackUserGroupIds: [1] },
};

describe('connecteur whatsapp', () => {
  it('est enregistré par défaut, en mode copie seulement', () => {
    const def = createDefaultRegistry().get('whatsapp');
    expect(def?.supportedModes).toEqual([GedSourceMode.Copie]);
  });

  it('valide la configuration et refuse un mode autre que la copie', async () => {
    const registry = createDefaultRegistry();
    const ok = await validateConnectorInput(
      registry,
      { connectorType: 'whatsapp', mode: GedSourceMode.Copie, config: CONFIG, credentials: CREDS },
      {},
    );
    expect(ok.rights.principalMap['wa:33612345678']).toBe(7);
    await expect(
      validateConnectorInput(
        registry,
        { connectorType: 'whatsapp', mode: GedSourceMode.Synchro, config: CONFIG, credentials: CREDS },
        {},
      ),
    ).rejects.toThrow();
    await expect(
      validateConnectorInput(
        registry,
        { connectorType: 'whatsapp', mode: GedSourceMode.Copie, config: { ...CONFIG, host: 'x' }, credentials: CREDS },
        {},
      ),
    ).rejects.toThrow();
  });

  it('listChanges renvoie une page vide, fetchFile est refusé', async () => {
    const c = buildConnector(createDefaultRegistry(), 'whatsapp', { config: CONFIG, credentials: CREDS });
    expect(await c.listChanges(null, { pageSize: 10 })).toEqual({
      items: [],
      deletedExternalIds: [],
      nextToken: null,
      hasMore: false,
    });
    await expect(c.fetchFile({ externalId: 'x', name: 'x' })).rejects.toThrow();
    expect(await c.readOriginAcl({ externalId: 'x', name: 'x' })).toBeNull();
  });

  it('authenticate interroge Graph via le transport injecté (jeton en en-tête, jamais dans l’URL)', async () => {
    const calls: WhatsappHttpRequest[] = [];
    const http: WhatsappHttp = {
      async request(req) {
        calls.push(req);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ id: CONFIG.phoneNumberId })),
        };
      },
    };
    const def = createWhatsappConnectorDefinition({ http });
    const { rights: _r, ...settings } = CONFIG;
    const c = def.create({
      config: def.configSchema.parse(settings),
      credentials: CREDS,
      limits: { maxFileBytes: 1000, allowedExtensions: ['.pdf'] },
      deps: {},
    });
    await c.authenticate();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).not.toContain(CREDS.accessToken);
    expect(calls[0]!.headers.Authorization ?? calls[0]!.headers.authorization).toContain(CREDS.accessToken);
  });

  it('authenticate : jeton refusé => ConnectorAuthError sans le jeton', async () => {
    const http: WhatsappHttp = {
      async request() {
        return { status: 401, headers: {}, body: Buffer.from('{"error":{"code":190,"message":"x"}}') };
      },
    };
    const def = createWhatsappConnectorDefinition({ http });
    const { rights: _r, ...settings } = CONFIG;
    const c = def.create({
      config: def.configSchema.parse(settings),
      credentials: CREDS,
      limits: { maxFileBytes: 1000, allowedExtensions: ['.pdf'] },
      deps: {},
    });
    const err = await c.authenticate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorAuthError);
    expect(String((err as Error).message)).not.toContain(CREDS.accessToken);
  });
});
