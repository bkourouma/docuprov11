import * as path from 'node:path';
import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import {
  ConnectorConfigError,
  ConnectorRegistry,
  buildConnector,
  splitStoredConfig,
  validateConnectorInput,
} from './registry';
import { createDefaultRegistry } from './default-registry';
import type { ConnectorDefinition, SourceConnector } from './types';

// La garde SSRF est le sujet d'un autre module : ici on simule un hôte interne refusé.
jest.mock('./ssrf', () => ({
  SsrfError: class SsrfError extends Error {},
  isBlockedAddress: () => false,
  assertPublicHost: async (host: string, opts?: { resolve?: (h: string) => Promise<string[]> }) => {
    const ips = opts?.resolve ? await opts.resolve(host) : [host];
    if (ips.some((ip) => ip.startsWith('10.'))) throw new Error(`Hôte interne refusé (${host}).`);
    return ips;
  },
}));

function fakeDefinition(
  type: string,
  overrides: Partial<ConnectorDefinition> = {},
): ConnectorDefinition {
  return {
    type,
    label: 'Test',
    description: 'Connecteur de test',
    supportedModes: [GedSourceMode.Copie],
    configFields: [],
    credentialFields: [],
    configSchema: z.object({ a: z.string().default('x') }).strict(),
    credentialsSchema: z.object({ token: z.string().min(1) }).strict(),
    assertConfigSafe: async () => undefined,
    create: () => ({ type }) as unknown as SourceConnector,
    ...overrides,
  };
}

describe('ConnectorRegistry', () => {
  it('enregistre, retrouve et liste dans l’ordre', () => {
    const r = new ConnectorRegistry();
    r.register(fakeDefinition('un'));
    r.register(fakeDefinition('deux_2'));
    expect(r.has('un')).toBe(true);
    expect(r.has('trois')).toBe(false);
    expect(r.get('deux_2')?.type).toBe('deux_2');
    expect(r.get('absent')).toBeUndefined();
    expect(r.list().map((d) => d.type)).toEqual(['un', 'deux_2']);
    // La liste est une copie : la modifier ne touche pas le registre.
    r.list().pop();
    expect(r.list()).toHaveLength(2);
  });

  it.each([['Imap'], ['a-b'], [''], ['a'.repeat(41)], ['avec espace'], ['é']])(
    'refuse la clé invalide %j',
    (type) => {
      expect(() => new ConnectorRegistry().register(fakeDefinition(type))).toThrow(/invalide/);
    },
  );

  it('accepte une clé de 40 caractères', () => {
    expect(() => new ConnectorRegistry().register(fakeDefinition('a'.repeat(40)))).not.toThrow();
  });

  it('refuse un doublon', () => {
    const r = new ConnectorRegistry();
    r.register(fakeDefinition('x'));
    expect(() => r.register(fakeDefinition('x'))).toThrow(/déjà enregistré/);
  });

  it('le registre par défaut fournit filesystem, imap et whatsapp', () => {
    const r = createDefaultRegistry();
    expect(r.list().map((d) => d.type)).toEqual(['filesystem', 'imap', 'whatsapp']);
  });
});

describe('splitStoredConfig', () => {
  it('sépare la clé réservée rights', () => {
    expect(splitStoredConfig({ a: 1, rights: { principalMap: {} } })).toEqual({
      settings: { a: 1 },
      rights: { principalMap: {} },
    });
  });
  it('null ou undefined = réglages vides', () => {
    expect(splitStoredConfig(null)).toEqual({ settings: {}, rights: undefined });
    expect(splitStoredConfig(undefined)).toEqual({ settings: {}, rights: undefined });
  });
  it.each([['texte'], [12], [[1, 2]], [true]])('refuse le non-objet %j', (raw) => {
    expect(() => splitStoredConfig(raw)).toThrow(ConnectorConfigError);
  });
});

describe('validateConnectorInput', () => {
  const registry = new ConnectorRegistry();
  registry.register(fakeDefinition('test'));

  it('renvoie la config nettoyée (défauts + rights)', async () => {
    const out = await validateConnectorInput(registry, {
      connectorType: 'test',
      mode: GedSourceMode.Copie,
      config: {},
      credentials: { token: 'secret-de-test' },
    });
    expect(out.settings).toEqual({ a: 'x' });
    expect(out.rights).toEqual({ principalMap: {}, fallbackUserGroupIds: [] });
    expect(out.config).toEqual({ a: 'x', rights: { principalMap: {}, fallbackUserGroupIds: [] } });
    expect(out.credentials).toEqual({ token: 'secret-de-test' });
  });

  it('refuse un type inconnu', async () => {
    await expect(
      validateConnectorInput(registry, { connectorType: 'nope', mode: 0, config: {} }),
    ).rejects.toThrow(/inconnu/);
  });

  it('refuse un mode non supporté', async () => {
    await expect(
      validateConnectorInput(registry, {
        connectorType: 'test',
        mode: GedSourceMode.Synchro,
        config: {},
      }),
    ).rejects.toThrow(/mode/);
  });

  it('refuse un champ inconnu (schéma strict) en listant les problèmes', async () => {
    const err = await validateConnectorInput(registry, {
      connectorType: 'test',
      mode: GedSourceMode.Copie,
      config: { a: 'ok', intrus: 1 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorConfigError);
    expect(err.problems.length).toBeGreaterThan(0);
    expect(err.message).toMatch(/intrus/);
  });

  it('refuse des droits invalides', async () => {
    await expect(
      validateConnectorInput(registry, {
        connectorType: 'test',
        mode: GedSourceMode.Copie,
        config: { rights: { principalMap: { x: -1 } } },
      }),
    ).rejects.toThrow(/droits/);
  });

  it('refuse des identifiants invalides sans en citer la valeur', async () => {
    const err = await validateConnectorInput(registry, {
      connectorType: 'test',
      mode: GedSourceMode.Copie,
      config: {},
      credentials: { token: '', secretIntrus: 'motdepasse-de-test' },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorConfigError);
    expect(err.message).not.toContain('motdepasse-de-test');
  });

  it('convertit un refus de assertConfigSafe en ConnectorConfigError', async () => {
    const r = new ConnectorRegistry();
    r.register(
      fakeDefinition('risque', {
        assertConfigSafe: async () => {
          throw new Error('dangereux');
        },
      }),
    );
    await expect(
      validateConnectorInput(r, { connectorType: 'risque', mode: 0, config: {} }),
    ).rejects.toThrow(/Configuration refusée : dangereux/);
  });

  it('valide un dossier surveillé réel, refuse sans racines autorisées', async () => {
    const reg = createDefaultRegistry();
    const root = path.resolve('/srv/ged');
    const input = {
      connectorType: 'filesystem',
      mode: GedSourceMode.Copie,
      config: { rootPath: path.join(root, 'scans') },
    };
    // Fournisseur de fichiers simulé : aucune résolution sur le disque réel (/srv/ged n'existe pas).
    const fs = {
      realpath: async (p: string) => p,
      walk: async () => [],
      readFile: async () => Buffer.alloc(0),
    };
    const ok = await validateConnectorInput(reg, input, {
      env: { GED_CONNECTOR_FS_ROOTS: root },
      fs,
    });
    expect(ok.settings).toMatchObject({ recursive: true, minAgeSeconds: 30 });
    await expect(validateConnectorInput(reg, input, { env: {}, fs })).rejects.toThrow(
      ConnectorConfigError,
    );
  });

  it('refuse un hôte IMAP interne', async () => {
    const reg = createDefaultRegistry();
    await expect(
      validateConnectorInput(
        reg,
        {
          connectorType: 'imap',
          mode: GedSourceMode.Copie,
          config: { host: 'mail.exemple.test' },
          credentials: { user: 'u', password: 'motdepasse-de-test' },
        },
        { resolveHost: async () => ['10.0.0.5'] },
      ),
    ).rejects.toThrow(/Configuration refusée/);
  });
});

describe('buildConnector', () => {
  function capturing(): {
    registry: ConnectorRegistry;
    seen: () => Parameters<ConnectorDefinition['create']>[0] | undefined;
  } {
    let seen: Parameters<ConnectorDefinition['create']>[0] | undefined;
    const registry = new ConnectorRegistry();
    registry.register(
      fakeDefinition('ctx', {
        create: (ctx) => {
          seen = ctx;
          return { type: 'ctx' } as unknown as SourceConnector;
        },
      }),
    );
    return { registry, seen: () => seen };
  }

  it('assemble le contexte avec les bornes par défaut', () => {
    const { registry, seen } = capturing();
    buildConnector(registry, 'ctx', {
      config: { a: 'y', rights: { principalMap: {} } },
      credentials: { token: 't' },
    });
    expect(seen()?.config).toEqual({ a: 'y' });
    expect(seen()?.limits.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(seen()?.limits.allowedExtensions).toContain('.pdf');
    expect(seen()?.deps).toEqual({});
  });

  it('les surcharges ne peuvent que resserrer les bornes', () => {
    const { registry, seen } = capturing();
    buildConnector(registry, 'ctx', {
      config: {},
      credentials: { token: 't' },
      limits: { maxFileBytes: 10 ** 12, allowedExtensions: ['.pdf', '.exe'] },
    });
    expect(seen()?.limits.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(seen()?.limits.allowedExtensions).toEqual(['.pdf']);
  });

  it('refuse un type inconnu et une config invalide', () => {
    const { registry } = capturing();
    expect(() => buildConnector(registry, 'zz', { config: {}, credentials: {} })).toThrow(
      ConnectorConfigError,
    );
    expect(() =>
      buildConnector(registry, 'ctx', { config: { b: 1 }, credentials: { token: 't' } }),
    ).toThrow(ConnectorConfigError);
  });
});
