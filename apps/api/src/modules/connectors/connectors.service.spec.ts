import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ConnectorAuthError,
  ConnectorQuotaError,
  ConnectorRegistry,
  SsrfError,
  decryptCredentials,
  encryptCredentials,
  loadKeyRing,
  type ConnectorDefinition,
  type SourceConnector,
} from '@archivage/connectors';
import { GED_CONNECTOR_JOB } from '@archivage/types';
import type { AuthUser } from '../auth/auth.types';
import { ConnectorsService } from './connectors.service';

// Mots de passe FACTICES : servent uniquement à vérifier qu'ils ne sortent nulle part.
const PASSWORD = 'S3cret-Pa55-factice';
const PASSWORD_2 = 'Autre-Pa55-factice-2';
const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const ENV_A = { GED_CONNECTOR_KEY: KEY_A, GED_CONNECTOR_KEY_ID: 'k1' };

const admin: AuthUser = { userId: 1, username: 'admin', isAdmin: true, userGroupId: 5 };
const adminSansGroupe: AuthUser = { ...admin, userGroupId: null };

/** Comportement du connecteur factice, piloté test par test. */
const behaviour = {
  authenticate: jest.fn<Promise<void>, []>(),
  listChanges: jest.fn(),
  close: jest.fn<Promise<void>, []>(),
};
const fakeConnector: SourceConnector = {
  type: 'fake',
  authenticate: () => behaviour.authenticate(),
  listChanges: (since, opts) => behaviour.listChanges(since, opts),
  fetchFile: jest.fn(),
  readOriginAcl: jest.fn(),
  close: () => behaviour.close(),
};

const definition: ConnectorDefinition = {
  type: 'fake',
  label: 'Factice',
  description: 'Connecteur de test',
  supportedModes: [0, 1, 2],
  configFields: [{ name: 'host', label: 'Hôte', kind: 'text', required: false }],
  credentialFields: [{ name: 'password', label: 'Mot de passe', kind: 'password', required: true }],
  configSchema: z.object({ host: z.string().optional(), rootPath: z.string().optional() }).strict(),
  credentialsSchema: z.object({ password: z.string().min(1) }).strict(),
  async assertConfigSafe(config) {
    const host = (config as { host?: string }).host;
    if (host && (host.startsWith('10.') || host === 'localhost')) {
      throw new Error(`Hôte interne refusé (${host}).`);
    }
  },
  create: () => fakeConnector,
};

function row(partial: Record<string, unknown> = {}) {
  return {
    gedSourceConnectorId: 1,
    label: 'Source',
    connectorType: 'fake',
    mode: 0,
    status: 1,
    config: { host: 'imap.example.org', rights: { principalMap: {}, fallbackUserGroupIds: [5] } },
    credentialsEnc: null,
    credentialsKeyId: null,
    credentialsRef: null,
    credentialsExpiresAt: null,
    changeToken: 'tok',
    syncIntervalMinutes: null,
    targetDossierId: null,
    lastSyncAt: null,
    lastSuccessAt: null,
    lastError: null,
    isActive: true,
    createdBy: 5,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    updatedAt: new Date('2026-11-20T10:00:00Z'),
    ...partial,
  };
}

function itemRow(partial: Record<string, unknown> = {}) {
  return {
    gedSourceItemId: BigInt(9_007_199_254_740_000),
    connectorId: 1,
    externalId: 'a/b.pdf',
    originUrl: null,
    originPath: 'a/b.pdf',
    name: 'b.pdf',
    mimeType: 'application/pdf',
    byteLength: BigInt(123456789012),
    originAuthor: null,
    originCreatedAt: null,
    originModifiedAt: new Date('2026-11-01T00:00:00Z'),
    contentHash: 'ab'.repeat(32),
    remoteVersion: null,
    originAcl: null,
    originMetadata: null,
    state: 1,
    documentId: 3,
    duplicateOfId: null,
    errorMessage: null,
    firstSeenAt: new Date('2026-11-01T00:00:00Z'),
    lastSeenAt: new Date('2026-11-02T00:00:00Z'),
    indexedAt: null,
    ...partial,
  };
}

interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  current?: ReturnType<typeof row> | null;
  groups?: number[];
  dossiers?: number[];
  testTimeoutMs?: number;
}

function setup(opts: SetupOptions = {}) {
  const current = opts.current === undefined ? row() : opts.current;
  const groups = new Set(opts.groups ?? [5, 6, 7]);
  const dossiers = new Set(opts.dossiers ?? [12]);
  const prisma = {
    gedSourceConnector: {
      findUnique: jest.fn().mockResolvedValue(current),
      findMany: jest.fn().mockResolvedValue(current ? [current] : []),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve(row({ gedSourceConnectorId: 42, ...args.data })),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...current, ...args.data }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    appUserGroup: {
      findMany: jest.fn(({ where }: { where: { userGroupId: { in: number[] } } }) =>
        Promise.resolve(
          where.userGroupId.in.filter((g) => groups.has(g)).map((g) => ({ userGroupId: g })),
        ),
      ),
    },
    dossier: {
      findUnique: jest.fn(({ where }: { where: { dossierId: number } }) =>
        Promise.resolve(dossiers.has(where.dossierId) ? { dossierId: where.dossierId } : null),
      ),
    },
    gedSourceSyncRun: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    gedSourceItem: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
  const queue = {
    add: jest.fn().mockResolvedValue({ id: 'x' }),
    getJob: jest.fn().mockResolvedValue(undefined),
  };
  const registry = new ConnectorRegistry();
  registry.register(definition);
  const service = new ConnectorsService(prisma as never, audit as never, registry, queue as never, {
    env: opts.env ?? ENV_A,
    testTimeoutMs: opts.testTimeoutMs,
  });
  return { service, prisma, audit, queue };
}

const baseCreate = {
  label: 'Ma source',
  connectorType: 'fake',
  mode: 0 as const,
  config: { host: 'imap.example.org' } as Record<string, unknown>,
};

beforeEach(() => {
  behaviour.authenticate.mockReset().mockResolvedValue(undefined);
  behaviour.listChanges
    .mockReset()
    .mockResolvedValue({ items: [], deletedExternalIds: [], nextToken: null, hasMore: false });
  behaviour.close.mockReset().mockResolvedValue(undefined);
});

describe('ConnectorsService', () => {
  describe('listTypes()', () => {
    it('expose le registre sous forme de GedConnectorTypeInfo', () => {
      const { service } = setup();
      expect(service.listTypes()).toEqual([
        {
          type: 'fake',
          label: 'Factice',
          description: 'Connecteur de test',
          supportedModes: [0, 1, 2],
          configFields: definition.configFields,
          credentialFields: definition.credentialFields,
        },
      ]);
    });
  });

  describe('create()', () => {
    it('chiffre les identifiants : le clair n’apparaît ni en base, ni en sortie, ni dans l’audit', async () => {
      const { service, prisma, audit } = setup();
      const view = await service.create(
        { ...baseCreate, credentials: { password: PASSWORD } },
        admin,
      );

      const data = prisma.gedSourceConnector.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.credentialsEnc).toEqual(expect.any(String));
      expect(data.credentialsEnc).not.toBe(PASSWORD);
      expect(data.credentialsKeyId).toBe('k1');
      expect(data.credentialsRef).toBeNull();
      // Aller-retour : le chiffré se déchiffre bien en l'identifiant saisi.
      expect(decryptCredentials(data.credentialsEnc as string, 'k1', loadKeyRing(ENV_A))).toEqual({
        password: PASSWORD,
      });

      for (const sortie of [
        JSON.stringify(prisma.gedSourceConnector.create.mock.calls),
        JSON.stringify(view),
        JSON.stringify(audit.dataChange.mock.calls),
      ]) {
        expect(sortie).not.toContain(PASSWORD);
      }
      expect(JSON.stringify(view)).not.toContain('credentialsEnc');
      expect(view.hasCredentials).toBe(true);
    });

    it('statut 1 (actif), isActive, createdBy = groupe de l’administrateur', async () => {
      const { service, prisma } = setup();
      await service.create(baseCreate, admin);
      expect(prisma.gedSourceConnector.create.mock.calls[0][0].data).toMatchObject({
        status: 1,
        isActive: true,
        createdBy: 5,
        credentialsEnc: null,
        credentialsKeyId: null,
        syncIntervalMinutes: null,
        targetDossierId: null,
      });
    });

    it('ajoute d’office le groupe de l’administrateur comme repli de droits', async () => {
      const { service, prisma } = setup();
      await service.create(baseCreate, admin);
      const data = prisma.gedSourceConnector.create.mock.calls[0][0].data as {
        config: { rights: { fallbackUserGroupIds: number[] } };
      };
      expect(data.config.rights.fallbackUserGroupIds).toEqual([5]);
    });

    it('conserve un repli explicite', async () => {
      const { service, prisma } = setup();
      await service.create(
        {
          ...baseCreate,
          config: { ...baseCreate.config, rights: { fallbackUserGroupIds: [6, 7] } },
        },
        admin,
      );
      const data = prisma.gedSourceConnector.create.mock.calls[0][0].data as {
        config: { rights: { fallbackUserGroupIds: number[] } };
      };
      expect(data.config.rights.fallbackUserGroupIds).toEqual([6, 7]);
    });

    it('400 si le repli est absent et que l’administrateur n’a pas de groupe', async () => {
      const { service, prisma } = setup();
      await expect(service.create(baseCreate, adminSansGroupe)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
    });

    it('400 si le repli fourni est vide', async () => {
      const { service, prisma } = setup();
      await expect(
        service.create(
          { ...baseCreate, config: { ...baseCreate.config, rights: { fallbackUserGroupIds: [] } } },
          admin,
        ),
      ).rejects.toThrow(/fallbackUserGroupIds/);
      expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
    });

    it('400 si un groupe du repli ou de principalMap n’existe pas', async () => {
      const { service, prisma } = setup({ groups: [5] });
      await expect(
        service.create(
          {
            ...baseCreate,
            config: { ...baseCreate.config, rights: { fallbackUserGroupIds: [5, 99] } },
          },
          admin,
        ),
      ).rejects.toThrow(/99/);
      await expect(
        service.create(
          {
            ...baseCreate,
            config: {
              ...baseCreate.config,
              rights: { fallbackUserGroupIds: [5], principalMap: { 'a@b.fr': 77 } },
            },
          },
          admin,
        ),
      ).rejects.toThrow(/77/);
      expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
    });

    it('503 sans GED_CONNECTOR_KEY, message exact, rien d’écrit', async () => {
      const { service, prisma } = setup({ env: {} });
      const err = await service
        .create({ ...baseCreate, credentials: { password: PASSWORD } }, admin)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as Error).message).toBe(
        'Clé de chiffrement des connecteurs absente (GED_CONNECTOR_KEY) : identifiants non enregistrables',
      );
      expect((err as Error).message).not.toContain(PASSWORD);
      expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
    });

    it('sans identifiants, la clé n’est pas exigée', async () => {
      const { service } = setup({ env: {} });
      await expect(service.create(baseCreate, admin)).resolves.toMatchObject({
        hasCredentials: false,
      });
    });

    it('refuse un hôte interne (garde SSRF du connecteur) : 400, rien d’écrit', async () => {
      const { service, prisma } = setup();
      const err = await service
        .create(
          { ...baseCreate, config: { host: '10.0.0.5' }, credentials: { password: PASSWORD } },
          admin,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(/Configuration refusée/);
      expect((err as Error).message).not.toContain(PASSWORD);
      expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
    });

    it('400 : type inconnu, config avec champ inconnu, identifiants invalides (sans écho de la valeur)', async () => {
      const { service } = setup();
      await expect(service.create({ ...baseCreate, connectorType: 'nope' }, admin)).rejects.toThrow(
        /inconnu/,
      );
      await expect(
        service.create({ ...baseCreate, config: { host: 'a.example.org', piege: 1 } }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      const err = await service
        .create({ ...baseCreate, credentials: { password: PASSWORD, extra: PASSWORD_2 } }, admin)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).not.toContain(PASSWORD_2);
    });

    it('400 si le dossier cible n’existe pas, accepté sinon', async () => {
      const { service } = setup();
      await expect(service.create({ ...baseCreate, targetDossierId: 999 }, admin)).rejects.toThrow(
        /Dossier cible/,
      );
      await expect(
        service.create({ ...baseCreate, targetDossierId: 12 }, admin),
      ).resolves.toBeDefined();
    });

    it('credentialsRef : résolu pour validation, stocké tel quel, jamais chiffré ni valeur copiée', async () => {
      const env = { ...ENV_A, GED_CONNECTOR_SECRET_FAKE: JSON.stringify({ password: PASSWORD }) };
      const { service, prisma } = setup({ env });
      const view = await service.create(
        { ...baseCreate, credentialsRef: 'GED_CONNECTOR_SECRET_FAKE' },
        admin,
      );
      const data = prisma.gedSourceConnector.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.credentialsRef).toBe('GED_CONNECTOR_SECRET_FAKE');
      expect(data.credentialsEnc).toBeNull();
      expect(JSON.stringify([data, view])).not.toContain(PASSWORD);
      expect(view.hasCredentials).toBe(true);
    });

    it('credentialsRef : variable absente => 400', async () => {
      const { service, prisma } = setup();
      await expect(
        service.create({ ...baseCreate, credentialsRef: 'GED_CONNECTOR_SECRET_ABSENTE' }, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
    });

    it('journalise la création sans secret', async () => {
      const { service, audit } = setup();
      await service.create({ ...baseCreate, credentials: { password: PASSWORD } }, admin);
      expect(audit.dataChange).toHaveBeenCalledWith({
        userGroupId: 5,
        actorFullName: 'admin',
        objectRef: 'ged_source_connector:42',
        newValue: 'created:fake',
      });
    });
  });

  describe('update()', () => {
    it('mise à jour partielle : le libellé change, les identifiants ne sont pas touchés', async () => {
      const enc = encryptCredentials({ password: PASSWORD }, loadKeyRing(ENV_A));
      const { service, prisma } = setup({ current: row({ ...enc }) });
      await service.update(1, { label: 'Autre' }, admin);
      const data = prisma.gedSourceConnector.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.label).toBe('Autre');
      expect('credentialsEnc' in data).toBe(false);
      expect('credentialsKeyId' in data).toBe(false);
      expect('credentialsRef' in data).toBe(false);
    });

    it('credentials: null efface le chiffré et la clé', async () => {
      const enc = encryptCredentials({ password: PASSWORD }, loadKeyRing(ENV_A));
      const { service, prisma } = setup({
        current: row({
          credentialsEnc: enc.credentialsEnc,
          credentialsKeyId: enc.credentialsKeyId,
        }),
        env: {},
      });
      const view = await service.update(1, { credentials: null }, admin);
      expect(prisma.gedSourceConnector.update.mock.calls[0][0].data).toMatchObject({
        credentialsEnc: null,
        credentialsKeyId: null,
      });
      expect(view.hasCredentials).toBe(false);
    });

    it('credentials objet : remplacement complet, nouveau chiffré, ancienne référence vidée', async () => {
      const { service, prisma } = setup({
        current: row({ credentialsRef: 'GED_CONNECTOR_SECRET_OLD' }),
      });
      await service.update(1, { credentials: { password: PASSWORD_2 } }, admin);
      const data = prisma.gedSourceConnector.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.credentialsRef).toBeNull();
      expect(decryptCredentials(data.credentialsEnc as string, 'k1', loadKeyRing(ENV_A))).toEqual({
        password: PASSWORD_2,
      });
      expect(JSON.stringify(prisma.gedSourceConnector.update.mock.calls)).not.toContain(PASSWORD_2);
    });

    it('remplacement d’identifiants sans clé : 503', async () => {
      const { service, prisma } = setup({ env: {} });
      await expect(
        service.update(1, { credentials: { password: PASSWORD } }, admin),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.gedSourceConnector.update).not.toHaveBeenCalled();
    });

    it('un changement d’hôte, de racine ou de boîte réinitialise changeToken ; sinon non', async () => {
      const { service, prisma } = setup();
      await service.update(1, { config: { host: 'autre.example.org' } }, admin);
      expect(prisma.gedSourceConnector.update.mock.calls[0][0].data).toMatchObject({
        changeToken: null,
      });

      prisma.gedSourceConnector.update.mockClear();
      await service.update(1, { config: { host: 'imap.example.org' } }, admin);
      const data = prisma.gedSourceConnector.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect('changeToken' in data).toBe(false);
    });

    it('re-valide la configuration en entier (SSRF) même sur un simple libellé', async () => {
      const { service, prisma } = setup({ current: row({ config: { host: '10.1.1.1' } }) });
      await expect(service.update(1, { label: 'x' }, admin)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.gedSourceConnector.update).not.toHaveBeenCalled();
    });

    it('la mise à jour d’une config sans repli en pose un (jamais de connecteur sans filet)', async () => {
      const { service, prisma } = setup();
      await service.update(1, { config: { host: 'imap.example.org' } }, admin);
      const data = prisma.gedSourceConnector.update.mock.calls[0][0].data as {
        config: { rights: { fallbackUserGroupIds: number[] } };
      };
      expect(data.config.rights.fallbackUserGroupIds).toEqual([5]);
    });

    it('type inchangé : le registre valide avec le type stocké', async () => {
      const { service } = setup({ current: row({ connectorType: 'disparu' }) });
      await expect(service.update(1, { label: 'x' }, admin)).rejects.toThrow(/inconnu/);
    });

    it('dossier cible : null le détache, inexistant => 400', async () => {
      const { service, prisma } = setup();
      await service.update(1, { targetDossierId: null }, admin);
      expect(prisma.gedSourceConnector.update.mock.calls[0][0].data).toMatchObject({
        targetDossier: { disconnect: true },
      });
      await expect(service.update(1, { targetDossierId: 404 }, admin)).rejects.toThrow(
        /Dossier cible/,
      );
    });

    it('404 si le connecteur n’existe pas', async () => {
      const { service } = setup({ current: null });
      await expect(service.update(1, { label: 'x' }, admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('journalise les NOMS des champs modifiés, pas leurs valeurs', async () => {
      const { service, audit } = setup();
      await service.update(
        1,
        { label: 'Secret-libelle', credentials: { password: PASSWORD } },
        admin,
      );
      const entry = audit.dataChange.mock.calls[0][0] as { newValue: string };
      expect(entry.newValue).toBe('updated:config,label,credentials');
      expect(JSON.stringify(audit.dataChange.mock.calls)).not.toContain(PASSWORD);
    });
  });

  describe('vue', () => {
    it('ne contient jamais credentialsEnc, credentialsKeyId ni la valeur d’un identifiant', async () => {
      const enc = encryptCredentials({ password: PASSWORD }, loadKeyRing(ENV_A));
      const { service } = setup({ current: row({ ...enc, changeToken: 'jeton-interne' }) });
      const view = await service.get(1);
      const json = JSON.stringify(view);
      expect(json).not.toContain(PASSWORD);
      expect(json).not.toContain(enc.credentialsEnc);
      expect(json).not.toContain('credentialsEnc');
      expect(json).not.toContain('credentialsKeyId');
      expect(json).not.toContain('changeToken');
      expect(view.hasCredentials).toBe(true);
      expect(view.createdAt).toBe('2026-11-20T10:00:00.000Z');
    });

    it('list() : une vue par ligne, triée par id', async () => {
      const { service, prisma } = setup();
      const views = await service.list();
      expect(views).toHaveLength(1);
      expect(prisma.gedSourceConnector.findMany).toHaveBeenCalledWith({
        orderBy: { gedSourceConnectorId: 'asc' },
      });
    });

    it('get() : 404 si absent', async () => {
      const { service } = setup({ current: null });
      await expect(service.get(3)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('activate() / deactivate()', () => {
    it('désactive : isActive false, statut 0', async () => {
      const { service, prisma, audit } = setup();
      const view = await service.deactivate(1, admin);
      expect(prisma.gedSourceConnector.update.mock.calls[0][0].data).toEqual({
        isActive: false,
        status: 0,
      });
      expect(view.isActive).toBe(false);
      expect(audit.dataChange.mock.calls[0][0]).toMatchObject({ newValue: 'deactivated' });
    });

    it('active : isActive true, statut 1, lastError effacé', async () => {
      const { service, prisma } = setup({
        current: row({ isActive: false, status: 0, lastError: 'x' }),
      });
      const view = await service.activate(1, admin);
      expect(prisma.gedSourceConnector.update.mock.calls[0][0].data).toEqual({
        isActive: true,
        status: 1,
        lastError: null,
      });
      expect(view.isActive).toBe(true);
    });
  });

  describe('testConnection()', () => {
    const withCreds = () => {
      const enc = encryptCredentials({ password: PASSWORD }, loadKeyRing(ENV_A));
      return setup({ current: row({ ...enc }) });
    };

    it('ok : authentifie puis lit UNE entrée, et ferme', async () => {
      const { service } = withCreds();
      await expect(service.testConnection(1)).resolves.toEqual({
        ok: true,
        message: 'Connexion réussie.',
      });
      expect(behaviour.authenticate).toHaveBeenCalledTimes(1);
      expect(behaviour.listChanges).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ pageSize: 1 }),
      );
      expect(behaviour.close).toHaveBeenCalledTimes(1);
    });

    it('authentification refusée : ok false, message sans le mot de passe que l’erreur recopie', async () => {
      behaviour.authenticate.mockRejectedValue(
        new ConnectorAuthError(`LOGIN user ${PASSWORD} refusé`),
      );
      const { service } = withCreds();
      const res = await service.testConnection(1);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/^Authentification refusée/);
      expect(res.message).not.toContain(PASSWORD);
      expect(behaviour.close).toHaveBeenCalledTimes(1);
    });

    it('autorisation expirée', async () => {
      behaviour.authenticate.mockRejectedValue(new ConnectorAuthError('jeton périmé', true));
      const { service } = withCreds();
      const res = await service.testConnection(1);
      expect(res).toEqual({ ok: false, message: 'Autorisation expirée : jeton périmé' });
    });

    it('quota', async () => {
      behaviour.listChanges.mockRejectedValue(new ConnectorQuotaError('429'));
      const { service } = withCreds();
      const res = await service.testConnection(1);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/Limite de débit/);
    });

    it('SSRF', async () => {
      behaviour.authenticate.mockRejectedValue(new SsrfError('adresse interne'));
      const { service } = withCreds();
      const res = await service.testConnection(1);
      expect(res).toEqual({ ok: false, message: 'Adresse refusée : adresse interne' });
    });

    it('délai dépassé : ok false et fermeture tout de même', async () => {
      behaviour.authenticate.mockImplementation(() => new Promise<void>(() => undefined));
      const enc = encryptCredentials({ password: PASSWORD }, loadKeyRing(ENV_A));
      const { service } = setup({ current: row({ ...enc }), testTimeoutMs: 25 });
      const res = await service.testConnection(1);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/Délai dépassé/);
      expect(behaviour.close).toHaveBeenCalledTimes(1);
    });

    it('erreur inconnue : jamais de 500, secret masqué', async () => {
      behaviour.authenticate.mockRejectedValue(
        new Error(`boom ${encodeURIComponent(PASSWORD)} ${PASSWORD}`),
      );
      const { service } = withCreds();
      const res = await service.testConnection(1);
      expect(res.ok).toBe(false);
      expect(res.message).not.toContain(PASSWORD);
      expect(res.message).toContain('***');
    });

    it('une fermeture qui échoue ne change pas le résultat', async () => {
      behaviour.close.mockRejectedValue(new Error('close ko'));
      const { service } = withCreds();
      await expect(service.testConnection(1)).resolves.toMatchObject({ ok: true });
    });

    it('chiffré illisible (clé retirée) : ok false, aucun secret', async () => {
      const enc = encryptCredentials({ password: PASSWORD }, loadKeyRing(ENV_A));
      const { service } = setup({
        current: row({ ...enc }),
        env: { GED_CONNECTOR_KEY: KEY_B, GED_CONNECTOR_KEY_ID: 'k2' },
      });
      const res = await service.testConnection(1);
      expect(res.ok).toBe(false);
      expect(res.message).not.toContain(PASSWORD);
      expect(behaviour.authenticate).not.toHaveBeenCalled();
    });

    it('identifiants par référence : résolus depuis l’environnement', async () => {
      const env = { GED_CONNECTOR_SECRET_FAKE: JSON.stringify({ password: PASSWORD }) };
      behaviour.authenticate.mockRejectedValue(new ConnectorAuthError(`refus pour ${PASSWORD}`));
      const { service } = setup({
        current: row({ credentialsRef: 'GED_CONNECTOR_SECRET_FAKE' }),
        env,
      });
      const res = await service.testConnection(1);
      expect(res.message).not.toContain(PASSWORD);
    });

    it('configuration devenue invalide : ok false (pas de 500)', async () => {
      const { service } = setup({ current: row({ config: { piege: 1 } }) });
      const res = await service.testConnection(1);
      expect(res.ok).toBe(false);
    });

    it('404 si le connecteur n’existe pas', async () => {
      const { service } = setup({ current: null });
      await expect(service.testConnection(1)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('requestSync()', () => {
    it('409 si le connecteur est inactif', async () => {
      const { service, queue } = setup({ current: row({ isActive: false }) });
      await expect(service.requestSync(1, admin)).rejects.toBeInstanceOf(ConflictException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('409 si une passe est déjà en cours (statut 0 de moins de 2 h)', async () => {
      const { service, prisma, queue } = setup();
      prisma.gedSourceSyncRun.findFirst.mockResolvedValue({ gedSourceSyncRunId: BigInt(3) });
      await expect(service.requestSync(1, admin)).rejects.toBeInstanceOf(ConflictException);
      const where = prisma.gedSourceSyncRun.findFirst.mock.calls[0][0].where as {
        connectorId: number;
        status: number;
        startedAt: { gte: Date };
      };
      expect(where).toMatchObject({ connectorId: 1, status: 0 });
      const age = Date.now() - where.startedAt.gte.getTime();
      expect(age).toBeGreaterThan(2 * 3600_000 - 5_000);
      expect(age).toBeLessThan(2 * 3600_000 + 5_000);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('met en file avec jobId ged-sync-<id> et les données attendues', async () => {
      const { service, queue, audit } = setup();
      await expect(service.requestSync(1, admin)).resolves.toEqual({ queued: true });
      expect(queue.add).toHaveBeenCalledWith(
        GED_CONNECTOR_JOB.sync,
        { connectorId: 1, trigger: 'manual', requestedBy: 5 },
        { jobId: 'ged-sync-1', removeOnComplete: 1000, removeOnFail: 1000 },
      );
      expect(audit.dataChange.mock.calls[0][0]).toMatchObject({ newValue: 'sync-requested' });
    });

    it('retire un job terminé de même identifiant avant de ré-enfiler (sinon BullMQ ignore l’ajout)', async () => {
      const job = { getState: jest.fn().mockResolvedValue('completed'), remove: jest.fn() };
      const { service, queue } = setup();
      queue.getJob.mockResolvedValue(job);
      await service.requestSync(1, admin);
      expect(job.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('un job encore en attente n’est pas doublé', async () => {
      const job = { getState: jest.fn().mockResolvedValue('waiting'), remove: jest.fn() };
      const { service, queue } = setup();
      queue.getJob.mockResolvedValue(job);
      await expect(service.requestSync(1, admin)).resolves.toEqual({ queued: true });
      expect(queue.add).not.toHaveBeenCalled();
      expect(job.remove).not.toHaveBeenCalled();
    });

    it('requestedBy null pour un compte sans groupe', async () => {
      const { service, queue } = setup();
      await service.requestSync(1, adminSansGroupe);
      expect(queue.add.mock.calls[0][1]).toMatchObject({ requestedBy: null });
    });
  });

  describe('rotateKeys()', () => {
    const ancien = { GED_CONNECTOR_KEY: KEY_A, GED_CONNECTOR_KEY_ID: 'k1' };
    const nouveau = {
      GED_CONNECTOR_KEY: KEY_B,
      GED_CONNECTOR_KEY_ID: 'k2',
      GED_CONNECTOR_KEY_PREVIOUS: `k1:${KEY_A}`,
    };

    it('rechiffre sous la clé active uniquement les lignes d’une autre clé', async () => {
      const vieux = encryptCredentials({ password: PASSWORD }, loadKeyRing(ancien));
      const recent = encryptCredentials({ password: PASSWORD_2 }, loadKeyRing(nouveau));
      const { service, prisma, audit } = setup({ env: nouveau });
      prisma.gedSourceConnector.findMany.mockResolvedValue([
        { gedSourceConnectorId: 1, ...vieux },
        { gedSourceConnectorId: 2, ...recent },
      ]);
      await expect(service.rotateKeys(admin)).resolves.toEqual({ reencrypted: 1 });

      expect(prisma.gedSourceConnector.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.gedSourceConnector.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: { credentialsEnc: string; credentialsKeyId: string };
      };
      // Garde optimiste sur l'ancien chiffré, nouvelle clé posée, contenu inchangé.
      expect(call.where).toEqual({ gedSourceConnectorId: 1, credentialsEnc: vieux.credentialsEnc });
      expect(call.data.credentialsKeyId).toBe('k2');
      expect(call.data.credentialsEnc).not.toBe(vieux.credentialsEnc);
      expect(decryptCredentials(call.data.credentialsEnc, 'k2', loadKeyRing(nouveau))).toEqual({
        password: PASSWORD,
      });
      expect(JSON.stringify(audit.dataChange.mock.calls)).not.toContain(PASSWORD);
      expect(audit.dataChange.mock.calls[0][0]).toMatchObject({ newValue: 'keys-rotated:1' });
    });

    it('une ligne illisible n’empêche pas les autres', async () => {
      const vieux = encryptCredentials({ password: PASSWORD }, loadKeyRing(ancien));
      const { service, prisma } = setup({
        env: { GED_CONNECTOR_KEY: KEY_B, GED_CONNECTOR_KEY_ID: 'k2' },
      });
      prisma.gedSourceConnector.findMany.mockResolvedValue([
        { gedSourceConnectorId: 1, ...vieux }, // k1 absente du trousseau : illisible
        { gedSourceConnectorId: 2, credentialsEnc: 'zzz', credentialsKeyId: null },
      ]);
      await expect(service.rotateKeys(admin)).resolves.toEqual({ reencrypted: 0 });
      expect(prisma.gedSourceConnector.updateMany).not.toHaveBeenCalled();
    });

    it('sans clé : 503', async () => {
      const { service, prisma } = setup({ env: {} });
      await expect(service.rotateKeys(admin)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.gedSourceConnector.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listRuns()', () => {
    it('défaut 20, plus récentes d’abord, BigInt converti en number', async () => {
      const { service, prisma } = setup();
      prisma.gedSourceSyncRun.findMany.mockResolvedValue([
        {
          gedSourceSyncRunId: BigInt(77),
          connectorId: 1,
          status: 1,
          startedAt: new Date('2026-11-20T10:00:00Z'),
          finishedAt: new Date('2026-11-20T10:01:00Z'),
          itemsSeen: 4,
          itemsCreated: 3,
          itemsUpdated: 1,
          itemsDeleted: 0,
          itemsDuplicate: 0,
          itemsFailed: 0,
          changeTokenBefore: 'secret-interne',
          changeTokenAfter: 'secret-interne-2',
          errorMessage: null,
        },
      ]);
      const runs = await service.listRuns(1, {});
      expect(prisma.gedSourceSyncRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { connectorId: 1 }, take: 20 }),
      );
      expect(runs[0].gedSourceSyncRunId).toBe(77);
      expect(runs[0].finishedAt).toBe('2026-11-20T10:01:00.000Z');
      expect(JSON.stringify(runs)).not.toContain('secret-interne');
    });

    it('limite fournie', async () => {
      const { service, prisma } = setup();
      await service.listRuns(1, { limit: 100 });
      expect(prisma.gedSourceSyncRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('éléments', () => {
    it('listItems : filtre état + recherche, pagination, tri, BigInt sérialisable', async () => {
      const { service, prisma } = setup();
      prisma.gedSourceItem.findMany.mockResolvedValue([itemRow()]);
      prisma.gedSourceItem.count.mockResolvedValue(51);

      const res = await service.listItems(1, { state: 1, q: 'ABC', page: 2, pageSize: 25 });

      const args = prisma.gedSourceItem.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        skip: number;
        take: number;
        orderBy: unknown;
      };
      expect(args.where).toEqual({
        connectorId: 1,
        state: 1,
        OR: [
          { name: { contains: 'ABC', mode: 'insensitive' } },
          { originPath: { contains: 'ABC', mode: 'insensitive' } },
          { contentHash: { startsWith: 'abc' } },
        ],
      });
      expect(args.skip).toBe(25);
      expect(args.take).toBe(25);
      expect(args.orderBy).toEqual([{ lastSeenAt: 'desc' }, { gedSourceItemId: 'desc' }]);
      expect(prisma.gedSourceItem.count).toHaveBeenCalledWith({ where: args.where });

      expect(res).toMatchObject({ total: 51, page: 2, pageSize: 25 });
      // JSON.stringify lèverait sur un BigInt résiduel.
      expect(() => JSON.stringify(res)).not.toThrow();
      expect(res.items[0].gedSourceItemId).toBe(9_007_199_254_740_000);
      expect(res.items[0].byteLength).toBe(123456789012);
      expect(res.items[0].originModifiedAt).toBe('2026-11-01T00:00:00.000Z');
      expect(res.items[0].originCreatedAt).toBeNull();
    });

    it('listItems : valeurs par défaut (page 1, 25 par page), sans filtre', async () => {
      const { service, prisma } = setup();
      const res = await service.listItems(1, {});
      expect(prisma.gedSourceItem.findMany.mock.calls[0][0]).toMatchObject({
        where: { connectorId: 1 },
        skip: 0,
        take: 25,
      });
      expect(res).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    });

    it('listItems : échappe les jokers LIKE de q (\\, %, _) avant Prisma', async () => {
      const { service, prisma } = setup();
      await service.listItems(1, { q: '50%_a\\b' });
      const where = (prisma.gedSourceItem.findMany.mock.calls[0][0] as { where: unknown }).where;
      // Valeur brute « 50%_a\b » : chaque joker est précédé de « \ », y compris le « \ » lui-même.
      expect(where).toEqual({
        connectorId: 1,
        OR: [
          { name: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } },
          { originPath: { contains: '50\\%\\_a\\\\b', mode: 'insensitive' } },
          { contentHash: { startsWith: '50\\%\\_a\\\\b' } },
        ],
      });
    });

    it('listItems : un q sans joker est transmis tel quel à Prisma', async () => {
      const { service, prisma } = setup();
      await service.listItems(1, { q: 'Rapport 2026-A' });
      const where = (prisma.gedSourceItem.findMany.mock.calls[0][0] as { where: unknown }).where;
      expect(where).toEqual({
        connectorId: 1,
        OR: [
          { name: { contains: 'Rapport 2026-A', mode: 'insensitive' } },
          { originPath: { contains: 'Rapport 2026-A', mode: 'insensitive' } },
          { contentHash: { startsWith: 'rapport 2026-a' } },
        ],
      });
    });

    it('listItems : 404 si le connecteur n’existe pas', async () => {
      const { service } = setup({ current: null });
      await expect(service.listItems(1, {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getItem : filtré par connecteur, avec le doublon d’origine', async () => {
      const { service, prisma } = setup();
      prisma.gedSourceItem.findFirst.mockResolvedValue(
        itemRow({
          state: 6,
          duplicateOfId: BigInt(5),
          duplicateOf: { gedSourceItemId: BigInt(5), name: 'orig.pdf', connectorId: 2 },
        }),
      );
      const item = await service.getItem(1, 9);
      expect(prisma.gedSourceItem.findFirst.mock.calls[0][0]).toMatchObject({
        where: { gedSourceItemId: BigInt(9), connectorId: 1 },
      });
      expect(item.duplicateOf).toEqual({ id: 5, name: 'orig.pdf', connectorId: 2 });
      expect(item.duplicateOfId).toBe(5);
      expect(() => JSON.stringify(item)).not.toThrow();
    });

    it('getItem : sans doublon => duplicateOf null ; 404 si l’élément est d’un autre connecteur', async () => {
      const { service, prisma } = setup();
      prisma.gedSourceItem.findFirst.mockResolvedValueOnce(itemRow({ duplicateOf: null }));
      await expect(service.getItem(1, 9)).resolves.toMatchObject({ duplicateOf: null });
      prisma.gedSourceItem.findFirst.mockResolvedValueOnce(null);
      await expect(service.getItem(1, 10)).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('confidentialité WhatsApp', () => {
      const ACL = { principals: ['wa:22507080910'] };
      const waItem = () =>
        itemRow({ originAcl: ACL, originAuthor: '22507080910', originPath: '+22507080910/x.pdf' });

      it('listItems : ACL, chemin et auteur-numéro masqués pour whatsapp', async () => {
        const { service, prisma } = setup({ current: row({ connectorType: 'whatsapp' }) });
        prisma.gedSourceItem.findMany.mockResolvedValue([waItem(), itemRow({ originAuthor: 'a1b2c3d4' })]);
        const res = await service.listItems(1, {});
        expect(res.items[0].originAcl).toBeNull();
        expect(res.items[0].originPath).toBeNull();
        expect(res.items[0].originAuthor).toBeNull();
        expect(res.items[1].originAuthor).toBe('a1b2c3d4'); // pseudonyme conservé
        expect(JSON.stringify(res)).not.toContain('22507080910');
      });

      it('getItem : ACL masquée pour whatsapp', async () => {
        const { service, prisma } = setup({ current: row({ connectorType: 'whatsapp' }) });
        prisma.gedSourceItem.findFirst.mockResolvedValue(waItem());
        const item = await service.getItem(1, 9);
        expect(item.originAcl).toBeNull();
        expect(JSON.stringify(item)).not.toContain('22507080910');
      });

      it('filesystem : ACL, chemin et auteur inchangés (liste et détail)', async () => {
        const { service, prisma } = setup({ current: row({ connectorType: 'filesystem' }) });
        const fsItem = () => itemRow({ originAcl: ACL, originAuthor: '22507080910' });
        prisma.gedSourceItem.findMany.mockResolvedValue([fsItem()]);
        prisma.gedSourceItem.findFirst.mockResolvedValue(fsItem());
        const list = await service.listItems(1, {});
        const one = await service.getItem(1, 9);
        for (const it of [list.items[0], one]) {
          expect(it.originAcl).toEqual(ACL);
          expect(it.originPath).toBe('a/b.pdf');
          expect(it.originAuthor).toBe('22507080910');
        }
      });
    });
  });
});

describe('ConnectorsService — types OAuth (lot 2b)', () => {
  const REFRESH = 'refresh-factice-1234567890';
  let captured: { onCredentialsChanged?: (c: Record<string, string>) => Promise<void> } = {};
  const oauthDefinition: ConnectorDefinition = {
    ...definition,
    type: 'fake_oauth',
    credentialFields: [],
    credentialsSchema: z.object({ refreshToken: z.string().min(1) }).strict(),
    oauth: { provider: 'google', scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
    create: (ctx) => {
      captured = { onCredentialsChanged: ctx.deps.onCredentialsChanged };
      return fakeConnector;
    },
  };
  function setupOAuth(current = row({ connectorType: 'fake_oauth' })) {
    const prisma = {
      gedSourceConnector: {
        findUnique: jest.fn().mockResolvedValue(current),
        create: jest.fn((a: { data: Record<string, unknown> }) =>
          Promise.resolve(row({ gedSourceConnectorId: 42, ...a.data })),
        ),
        update: jest.fn((a: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...current, ...a.data }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      appUserGroup: {
        findMany: jest.fn(() => Promise.resolve([{ userGroupId: 5 }])),
      },
      dossier: { findUnique: jest.fn() },
    };
    const audit = { dataChange: jest.fn().mockResolvedValue(undefined) };
    const registry = new ConnectorRegistry();
    registry.register(oauthDefinition);
    const service = new ConnectorsService(
      prisma as never,
      audit as never,
      registry,
      { add: jest.fn(), getJob: jest.fn() } as never,
      { env: ENV_A },
    );
    return { service, prisma };
  }
  const create = { label: 'Drive', connectorType: 'fake_oauth', mode: 0 as const, config: {} };

  it('create : identifiants saisis à la main refusés (400), rien n’est écrit', async () => {
    const { service, prisma } = setupOAuth();
    await expect(
      service.create({ ...create, credentials: { refreshToken: REFRESH } }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...create, credentialsRef: 'GED_CONNECTOR_SECRET_X' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.gedSourceConnector.create).not.toHaveBeenCalled();
  });

  it('create sans identifiants : accepté (l’autorisation viendra du bouton)', async () => {
    const { service, prisma } = setupOAuth();
    await service.create(create, admin);
    expect(prisma.gedSourceConnector.create).toHaveBeenCalledTimes(1);
  });

  it('update : credentials / credentialsRef refusés (400) ; null (effacer) permis', async () => {
    const { service, prisma } = setupOAuth();
    await expect(
      service.update(1, { credentials: { refreshToken: REFRESH } }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(1, { credentialsRef: 'GED_CONNECTOR_SECRET_X' }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.gedSourceConnector.update).not.toHaveBeenCalled();
    await service.update(1, { credentials: null }, admin);
    expect(prisma.gedSourceConnector.update).toHaveBeenCalledTimes(1);
  });

  it('un type non OAuth accepte toujours des identifiants (régression)', async () => {
    const { service } = setup();
    await expect(
      service.create({ ...baseCreate, credentials: { password: PASSWORD } }, admin),
    ).resolves.toBeDefined();
  });

  it('testConnection : un jeton tourné est rechiffré et enregistré (garde optimiste), sans fuite', async () => {
    const enc = encryptCredentials({ refreshToken: REFRESH }, loadKeyRing(ENV_A));
    const { service, prisma } = setupOAuth(row({ connectorType: 'fake_oauth', ...enc }));
    behaviour.authenticate.mockResolvedValue(undefined);
    behaviour.listChanges.mockResolvedValue({
      items: [],
      deletedExternalIds: [],
      nextToken: null,
      hasMore: false,
    });
    behaviour.close.mockResolvedValue(undefined);
    await service.testConnection(1);
    expect(captured.onCredentialsChanged).toEqual(expect.any(Function));
    await captured.onCredentialsChanged?.({ refreshToken: 'refresh-NOUVEAU-987654' });
    const call = prisma.gedSourceConnector.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ gedSourceConnectorId: 1, credentialsEnc: enc.credentialsEnc });
    expect(JSON.stringify(call)).not.toContain('refresh-NOUVEAU');
    expect(
      decryptCredentials(call.data.credentialsEnc, call.data.credentialsKeyId, loadKeyRing(ENV_A)),
    ).toEqual({ refreshToken: 'refresh-NOUVEAU-987654' });
  });
});
