import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ConnectorRegistry,
  decryptCredentials,
  deriveStateKey,
  loadKeyRing,
  newOAuthNonce,
  signOAuthState,
  type ConnectorDefinition,
  type OAuthHttpRequest,
} from '@archivage/connectors';
import { GedSourceConnectorStatus } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { ConnectorsService } from './connectors.service';
import { OAuthService, OAUTH_STATE_TTL_SECONDS } from './oauth.service';
import { InMemoryOAuthStateStore, parseStateRecord } from './oauth-state.store';

// Valeurs FACTICES : servent uniquement à vérifier qu'elles ne sortent nulle part.
const CLIENT_ID = 'client-id-factice.apps.example';
const CLIENT_SECRET = 'client-secret-factice-XYZ';
const CODE = 'code-autorisation-factice-123';
const REFRESH_TOKEN = '1//refresh-token-factice-ABCDEF';
const KEY = Buffer.alloc(32, 7).toString('base64');
const REDIRECT = 'https://docupro.example.org/ged/oauth/retour';

const ENV: NodeJS.ProcessEnv = {
  GED_CONNECTOR_KEY: KEY,
  GED_CONNECTOR_KEY_ID: 'k1',
  GED_GOOGLE_CLIENT_ID: CLIENT_ID,
  GED_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GED_OAUTH_REDIRECT_URIS: `${REDIRECT}, https://autre.example.org/retour`,
};

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const NOW = new Date('2026-11-20T12:00:00Z');

const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 5 };
const autreAdmin: AuthUser = { userId: 2, username: 'admin2', isAdmin: true, userGroupId: 5 };

const oauthDef: ConnectorDefinition = {
  type: 'google_fake',
  label: 'Google factice',
  description: 'OAuth Google',
  supportedModes: [0],
  configFields: [],
  credentialFields: [],
  configSchema: z.object({}).strict(),
  credentialsSchema: z.object({}).strict(),
  oauth: { provider: 'google', scopes: [SCOPE] },
  async assertConfigSafe() {},
  create: () => {
    throw new Error('non utilisé');
  },
};
const plainDef: ConnectorDefinition = {
  ...oauthDef,
  type: 'plain_fake',
  label: 'Simple',
  oauth: undefined,
};
const msDef: ConnectorDefinition = {
  ...oauthDef,
  type: 'ms_fake',
  oauth: { provider: 'microsoft', scopes: ['https://graph.microsoft.com/Files.Read.All'] },
};

function row(partial: Record<string, unknown> = {}) {
  return {
    gedSourceConnectorId: 1,
    label: 'Source',
    connectorType: 'google_fake',
    mode: 0,
    status: 4,
    config: {},
    credentialsEnc: 'ancien',
    credentialsKeyId: 'k1',
    credentialsRef: 'GED_CONNECTOR_SECRET_X',
    credentialsExpiresAt: null,
    changeToken: 'tok',
    isActive: true,
    lastError: 'ancienne erreur',
    ...partial,
  };
}

interface HttpPlan {
  status: number;
  body: unknown;
  throws?: boolean;
}

function setup(
  opts: { env?: NodeJS.ProcessEnv; current?: ReturnType<typeof row> | null; http?: HttpPlan } = {},
) {
  const current = opts.current === undefined ? row() : opts.current;
  const prisma = {
    gedSourceConnector: {
      findUnique: jest.fn().mockResolvedValue(current),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...current, ...args.data }),
      ),
    },
  };
  const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
  const registry = new ConnectorRegistry();
  registry.register(oauthDef);
  registry.register(plainDef);
  registry.register(msDef);
  const store = new InMemoryOAuthStateStore(() => nowMs.value);
  const plan: HttpPlan = opts.http ?? {
    status: 200,
    body: { refresh_token: REFRESH_TOKEN, scope: SCOPE, refresh_token_expires_in: 3600 },
  };
  const requests: OAuthHttpRequest[] = [];
  const http = {
    request: jest.fn((req: OAuthHttpRequest) => {
      requests.push(req);
      if (plan.throws) return Promise.reject(new Error(`boom ${CODE}`));
      return Promise.resolve({
        status: plan.status,
        headers: {},
        body: Buffer.from(JSON.stringify(plan.body)),
      });
    }),
  };
  const service = new OAuthService(prisma as never, audit as never, registry, store, {
    env: opts.env ?? ENV,
    http,
    now: () => new Date(nowMs.value),
  });
  return { service, prisma, audit, store, http, requests, registry };
}

const nowMs = { value: NOW.getTime() };
beforeEach(() => {
  nowMs.value = NOW.getTime();
});

const stateOf = (url: string): string => new URL(url).searchParams.get('state') as string;
const nonceOf = (state: string): string =>
  (JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString()) as { n: string }).n;

/** Tout ce qui ne doit jamais circuler en clair. */
function expectNoLeak(value: unknown, secrets: string[]): void {
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
  for (const s of secrets) expect(text).not.toContain(s);
}

describe('OAuthService.start()', () => {
  it('démarre : URL avec state, PKCE S256 et périmètres minimaux, sans secret ni verifier', async () => {
    const { service, store, audit } = setup();
    const res = await service.start(1, { redirectUri: REDIRECT }, admin);

    expect(res.expiresInSeconds).toBe(600);
    const url = new URL(res.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('scope')).toBe(SCOPE);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);

    const state = stateOf(res.authorizationUrl);
    const nonce = nonceOf(state);
    const stored = store.entries.get(nonce);
    expect(stored).toBeDefined();
    const record = parseStateRecord(stored?.raw);
    expect(record).toMatchObject({ uid: 1, cid: 1, provider: 'google', redirectUri: REDIRECT });
    // Le vérificateur est chiffré : déchiffrable, absent en clair du magasin, de l'URL et de la réponse.
    const verifier = decryptCredentials(
      record?.verifierEnc as string,
      record?.verifierKeyId as string,
      loadKeyRing(ENV),
    ).verifier;
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expectNoLeak(stored, [verifier]);
    expectNoLeak(res, [verifier, CLIENT_SECRET]);
    expect(res.authorizationUrl).not.toContain(CLIENT_SECRET);

    expect(audit.dataChange).toHaveBeenCalledTimes(1);
    const entry = audit.dataChange.mock.calls[0][0] as { newValue: string; objectRef: string };
    expect(entry).toMatchObject({ newValue: 'oauth-start', objectRef: 'ged_source_connector:1' });
    expectNoLeak(audit.dataChange.mock.calls, [verifier, state, CLIENT_SECRET, 'accounts.google']);
  });

  it('TTL de 600 s sur l’enregistrement et sur le state', async () => {
    const { service, store } = setup();
    const res = await service.start(1, { redirectUri: REDIRECT }, admin);
    const nonce = nonceOf(stateOf(res.authorizationUrl));
    expect(store.entries.get(nonce)?.expiresAt).toBe(NOW.getTime() + OAUTH_STATE_TTL_SECONDS * 1000);
    const payload = JSON.parse(
      Buffer.from(stateOf(res.authorizationUrl).split('.')[0], 'base64url').toString(),
    ) as { exp: number };
    expect(payload.exp).toBe(Math.floor(NOW.getTime() / 1000) + 600);
  });

  it('URI hors liste blanche => 400', async () => {
    const { service, store } = setup();
    await expect(
      service.start(1, { redirectUri: 'https://evil.example.com/cb' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.entries.size).toBe(0);
  });

  it('liste blanche vide ou absente => 409', async () => {
    for (const v of [undefined, '', '  , ']) {
      const { service } = setup({ env: { ...ENV, GED_OAUTH_REDIRECT_URIS: v } });
      const err = await service.start(1, { redirectUri: REDIRECT }, admin).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toContain('Liste blanche');
    }
  });

  it('fournisseur non configuré => 409, message = noms de variables seulement', async () => {
    const env = { ...ENV };
    delete env.GED_GOOGLE_CLIENT_SECRET;
    const { service } = setup({ env });
    const err = await service.start(1, { redirectUri: REDIRECT }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toContain('GED_GOOGLE_CLIENT_SECRET');
    expectNoLeak((err as Error).message, [CLIENT_ID, CLIENT_SECRET]);
  });

  it('clé GED_CONNECTOR_KEY absente => 503', async () => {
    const env = { ...ENV };
    delete env.GED_CONNECTOR_KEY;
    const { service } = setup({ env });
    await expect(service.start(1, { redirectUri: REDIRECT }, admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('type non OAuth => 400 ; connecteur inconnu => 404', async () => {
    await expect(
      setup({ current: row({ connectorType: 'plain_fake' }) }).service.start(
        1,
        { redirectUri: REDIRECT },
        admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      setup({ current: null }).service.start(9, { redirectUri: REDIRECT }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OAuthService.callback()', () => {
  async function started(ctx = setup(), user: AuthUser = admin) {
    const res = await ctx.service.start(1, { redirectUri: REDIRECT }, user);
    return { ...ctx, state: stateOf(res.authorizationUrl), url: res.authorizationUrl };
  }

  it('autorise : refreshToken chiffré, ligne mise à jour, aucune fuite', async () => {
    const ctx = await started();
    const { service, prisma, audit, requests, state } = ctx;
    const res = await service.callback({ code: CODE, state }, admin);

    expect(res).toEqual({
      connectorId: 1,
      authorized: true,
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    });

    // L'échange a utilisé le verifier d'origine, la redirection enregistrée, et le code reçu.
    expect(requests).toHaveLength(1);
    const form = new URLSearchParams(requests[0].body);
    expect(form.get('code')).toBe(CODE);
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

    expect(prisma.gedSourceConnector.update).toHaveBeenCalledTimes(1);
    const arg = prisma.gedSourceConnector.update.mock.calls[0][0] as {
      where: unknown;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ gedSourceConnectorId: 1 });
    expect(arg.data).toMatchObject({
      credentialsRef: null,
      changeToken: null,
      lastError: null,
      status: GedSourceConnectorStatus.Actif,
      credentialsKeyId: 'k1',
      credentialsExpiresAt: new Date(NOW.getTime() + 3600_000),
    });
    expect(arg.data).not.toHaveProperty('isActive');
    const creds = decryptCredentials(
      arg.data.credentialsEnc as string,
      'k1',
      loadKeyRing(ENV),
    );
    expect(creds).toEqual({ refreshToken: REFRESH_TOKEN, scope: SCOPE });

    const secrets = [REFRESH_TOKEN, CODE, state, CLIENT_SECRET, form.get('code_verifier') as string];
    expectNoLeak(prisma.gedSourceConnector.update.mock.calls, [REFRESH_TOKEN, CODE, state]);
    expectNoLeak(res, secrets);
    expectNoLeak(audit.dataChange.mock.calls, secrets);
    expect(audit.dataChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ newValue: 'oauth-authorized', objectRef: 'ged_source_connector:1' }),
    );
  });

  it('expiresAt null quand le fournisseur ne donne pas d’expiration', async () => {
    const ctx = await started(
      setup({ http: { status: 200, body: { refresh_token: REFRESH_TOKEN, scope: SCOPE } } }),
    );
    const res = await ctx.service.callback({ code: CODE, state: ctx.state }, admin);
    expect(res.expiresAt).toBeNull();
    const data = (ctx.prisma.gedSourceConnector.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.credentialsExpiresAt).toBeNull();
  });

  it('rejeu du même state refusé', async () => {
    const ctx = await started();
    await ctx.service.callback({ code: CODE, state: ctx.state }, admin);
    const err = await ctx.service.callback({ code: CODE, state: ctx.state }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toContain('déjà utilisée');
    expect(ctx.http.request).toHaveBeenCalledTimes(1);
  });

  it('state expiré refusé', async () => {
    const ctx = await started();
    nowMs.value += (OAUTH_STATE_TTL_SECONDS + 1) * 1000;
    const err = await ctx.service.callback({ code: CODE, state: ctx.state }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('Autorisation invalide ou expirée : recommencez');
    expect(ctx.http.request).not.toHaveBeenCalled();
  });

  it('state altéré ou mal formé refusé', async () => {
    const ctx = await started();
    const [p, s] = ctx.state.split('.');
    const forged = `${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    for (const bad of [forged, 'n-importe-quoi', `${p}x.${s}`]) {
      await expect(ctx.service.callback({ code: CODE, state: bad }, admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(ctx.http.request).not.toHaveBeenCalled();
    // Le state légitime reste utilisable.
    await expect(ctx.service.callback({ code: CODE, state: ctx.state }, admin)).resolves.toBeDefined();
  });

  it('state d’un autre administrateur => 403 et NON consommé', async () => {
    const ctx = await started();
    await expect(
      ctx.service.callback({ code: CODE, state: ctx.state }, autreAdmin),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.http.request).not.toHaveBeenCalled();
    expect(ctx.store.entries.size).toBe(1);
    const ok = await ctx.service.callback({ code: CODE, state: ctx.state }, admin);
    expect(ok.authorized).toBe(true);
  });

  it('enregistrement serveur incohérent avec la charge utile (autre connecteur) => 400', async () => {
    const ctx = await started();
    // Un state valide (signé) pour le connecteur 2, mais dont le nonce pointe l'enregistrement du connecteur 1.
    const nonce = nonceOf(ctx.state);
    const forged = signOAuthState(
      {
        n: nonce,
        exp: Math.floor(NOW.getTime() / 1000) + 600,
        uid: 1,
        cid: 2,
        provider: 'google',
      },
      deriveStateKey(ENV),
    );
    await expect(ctx.service.callback({ code: CODE, state: forged }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ctx.http.request).not.toHaveBeenCalled();
  });

  it('fournisseur de l’enregistrement différent de la charge utile => 400', async () => {
    const ctx = await started();
    const nonce = nonceOf(ctx.state);
    const forged = signOAuthState(
      { n: nonce, exp: Math.floor(NOW.getTime() / 1000) + 600, uid: 1, cid: 1, provider: 'microsoft' },
      deriveStateKey(ENV),
    );
    await expect(ctx.service.callback({ code: CODE, state: forged }, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('connecteur devenu d’un autre fournisseur ou non OAuth => 400', async () => {
    for (const type of ['ms_fake', 'plain_fake']) {
      const ctx = await started();
      ctx.prisma.gedSourceConnector.findUnique.mockResolvedValue(row({ connectorType: type }));
      await expect(
        ctx.service.callback({ code: CODE, state: ctx.state }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.http.request).not.toHaveBeenCalled();
      expect(ctx.prisma.gedSourceConnector.update).not.toHaveBeenCalled();
    }
  });

  it('connecteur supprimé entre-temps => 404', async () => {
    const ctx = await started();
    ctx.prisma.gedSourceConnector.findUnique.mockResolvedValue(null);
    await expect(ctx.service.callback({ code: CODE, state: ctx.state }, admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('échange refusé par le fournisseur => 400 sans fuite, nonce consommé', async () => {
    const ctx = await started(
      setup({ http: { status: 400, body: { error: 'invalid_grant', error_description: CODE } } }),
    );
    const err = await ctx.service.callback({ code: CODE, state: ctx.state }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('Le fournisseur a refusé l’autorisation');
    expectNoLeak((err as BadRequestException).getResponse(), [
      CODE,
      ctx.state,
      CLIENT_SECRET,
      'invalid_grant',
    ]);
    expect(ctx.prisma.gedSourceConnector.update).not.toHaveBeenCalled();
    expect(ctx.audit.dataChange).toHaveBeenCalledTimes(1); // seulement oauth-start
    // Consommé : un second essai est un rejeu.
    const again = await ctx.service.callback({ code: CODE, state: ctx.state }, admin).catch((e) => e);
    expect((again as Error).message).toContain('déjà utilisée');
  });

  it('erreur réseau du client HTTP => 400 sans fuite', async () => {
    const ctx = await started(setup({ http: { status: 0, body: {}, throws: true } }));
    const err = await ctx.service.callback({ code: CODE, state: ctx.state }, admin).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expectNoLeak((err as Error).message, [CODE]);
  });

  it('clé absente => 503', async () => {
    const ctx = await started();
    const env = { ...ENV };
    delete env.GED_CONNECTOR_KEY;
    const other = new OAuthService(
      ctx.prisma as never,
      ctx.audit as never,
      ctx.registry,
      ctx.store,
      { env },
    );
    await expect(other.callback({ code: CODE, state: ctx.state }, admin)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('InMemoryOAuthStateStore / parseStateRecord', () => {
  const rec = {
    uid: 1,
    cid: 1,
    provider: 'google' as const,
    redirectUri: REDIRECT,
    verifierEnc: 'x',
    verifierKeyId: 'k1',
  };

  it('usage unique, TTL, nonce non écrasé', async () => {
    const store = new InMemoryOAuthStateStore(() => nowMs.value);
    const n = newOAuthNonce();
    await store.put(n, rec, 10);
    await expect(store.put(n, rec, 10)).rejects.toThrow();
    expect(await store.take(n)).toEqual(rec);
    expect(await store.take(n)).toBeNull();
    await store.put(n, rec, 10);
    nowMs.value += 11_000;
    expect(await store.take(n)).toBeNull();
  });

  it('JSON illisible ou de mauvaise forme => null', () => {
    for (const bad of [null, 42, '{', '[]', '{"uid":1}', JSON.stringify({ ...rec, provider: 'x' })]) {
      expect(parseStateRecord(bad)).toBeNull();
    }
  });
});

describe('ConnectorsService.listTypes() — oauth', () => {
  it('expose fournisseur et périmètres, et rien pour un type non OAuth', () => {
    const { registry } = setup();
    const service = new ConnectorsService(
      {} as never,
      {} as never,
      registry,
      {} as never,
      { env: ENV },
    );
    const types = service.listTypes();
    expect(types.find((t) => t.type === 'google_fake')?.oauth).toEqual({
      provider: 'google',
      scopes: [SCOPE],
    });
    expect(types.find((t) => t.type === 'plain_fake')?.oauth).toBeUndefined();
  });
});
