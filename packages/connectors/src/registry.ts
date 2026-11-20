import { z } from 'zod';
import { GED_CONNECTOR_TYPE_REGEX, type GedSourceMode } from '@archivage/types';
import { resolveLimits } from './limits';
import { rightsConfigSchema, type RightsConfig } from './rights-config';
import type {
  ConnectorCredentials,
  ConnectorDefinition,
  ConnectorDeps,
  ConnectorLimits,
  SourceConnector,
} from './types';

/** Longueur maximale de la clé `connectorType` (colonne en base). */
export const CONNECTOR_TYPE_MAX_LENGTH = 40;

/** Configuration refusée : message lisible (FR) et liste des problèmes, sans valeur secrète. */
export class ConnectorConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = 'ConnectorConfigError';
  }
}

/**
 * Registre des connecteurs disponibles. La clé est un texte libre `[a-z0-9_]+` : en ajouter un ne
 * demande ni énumération ni migration, seulement un `register` au démarrage.
 */
export class ConnectorRegistry {
  private readonly definitions = new Map<string, ConnectorDefinition>();

  register(def: ConnectorDefinition): void {
    const type = def.type;
    if (
      typeof type !== 'string' ||
      type.length === 0 ||
      type.length > CONNECTOR_TYPE_MAX_LENGTH ||
      !GED_CONNECTOR_TYPE_REGEX.test(type)
    ) {
      throw new Error(
        `Type de connecteur invalide : « ${String(type).slice(0, 60)} » (minuscules, chiffres et _ ` +
          `uniquement, ${CONNECTOR_TYPE_MAX_LENGTH} caractères au plus).`,
      );
    }
    if (this.definitions.has(type)) {
      throw new Error(`Le type de connecteur « ${type} » est déjà enregistré.`);
    }
    this.definitions.set(type, def);
  }

  get(type: string): ConnectorDefinition | undefined {
    return this.definitions.get(type);
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  /** Définitions dans l'ordre d'enregistrement (copie : le registre ne s'altère pas par l'extérieur). */
  list(): ConnectorDefinition[] {
    return [...this.definitions.values()];
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Sépare la configuration stockée en réglages propres au connecteur et clé réservée `rights`.
 * `null`/`undefined` = pas de configuration (réglages vides). Tout autre non-objet est refusé.
 */
export function splitStoredConfig(raw: unknown): { settings: unknown; rights: unknown } {
  if (raw === null || raw === undefined) return { settings: {}, rights: undefined };
  if (!isPlainObject(raw)) {
    throw new ConnectorConfigError('La configuration du connecteur doit être un objet.', [
      'configuration : objet attendu',
    ]);
  }
  const { rights, ...settings } = raw;
  return { settings, rights };
}

function formatIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.length ? i.path.join('.') : '(racine)';
    return `${prefix} ${path} : ${i.message}`;
  });
}

/** Problèmes d'identifiants : chemin et nature seulement, jamais la valeur saisie. */
function formatCredentialIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (i) => `identifiant ${i.path.length ? i.path.join('.') : '(racine)'} : ${i.code}`,
  );
}

export interface ConnectorInput {
  connectorType: string;
  mode: GedSourceMode;
  /** Configuration stockée : réglages du connecteur + clé réservée `rights`. */
  config: unknown;
  /** Identifiants en clair, s'ils sont fournis (création ou remplacement). */
  credentials?: unknown;
}

export interface ValidatedConnectorInput {
  /** Réglages propres au connecteur, nettoyés et complétés par les défauts du schéma. */
  settings: unknown;
  rights: RightsConfig;
  /** Forme à stocker dans `ged_source_connector.config` : réglages + clé `rights`. */
  config: Record<string, unknown>;
  credentials?: ConnectorCredentials;
}

/**
 * Valide une entrée d'administration : type connu, mode supporté, réglages et droits conformes
 * (schémas stricts), identifiants conformes s'ils sont fournis, puis garde de sécurité du
 * connecteur (SSRF, chemin hors racines). Lève `ConnectorConfigError` ; les messages ne contiennent
 * jamais de valeur d'identifiant.
 */
export async function validateConnectorInput(
  registry: ConnectorRegistry,
  input: ConnectorInput,
  deps: ConnectorDeps = {},
): Promise<ValidatedConnectorInput> {
  const def = registry.get(input.connectorType);
  if (!def) {
    throw new ConnectorConfigError(`Type de connecteur inconnu : « ${input.connectorType} ».`, [
      'connectorType : inconnu',
    ]);
  }
  if (!def.supportedModes.includes(input.mode)) {
    throw new ConnectorConfigError(
      `Le mode demandé n'est pas supporté par le connecteur « ${def.label} ».`,
      ['mode : non supporté'],
    );
  }

  const { settings: rawSettings, rights: rawRights } = splitStoredConfig(input.config);
  const problems: string[] = [];

  const settingsResult = def.configSchema.safeParse(rawSettings);
  if (!settingsResult.success) problems.push(...formatIssues('réglage', settingsResult.error));

  const rightsResult = rightsConfigSchema.safeParse(rawRights ?? {});
  if (!rightsResult.success) problems.push(...formatIssues('droits', rightsResult.error));

  let credentials: ConnectorCredentials | undefined;
  if (input.credentials !== undefined && input.credentials !== null) {
    const credsResult = def.credentialsSchema.safeParse(input.credentials);
    if (!credsResult.success) problems.push(...formatCredentialIssues(credsResult.error));
    else credentials = credsResult.data;
  }

  if (!settingsResult.success || !rightsResult.success || problems.length > 0) {
    throw new ConnectorConfigError(
      `Configuration du connecteur « ${def.label} » invalide : ${problems.join(' ; ')}`,
      problems,
    );
  }

  try {
    await def.assertConfigSafe(settingsResult.data, deps);
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'refusée';
    throw new ConnectorConfigError(`Configuration refusée : ${reason}`, [reason]);
  }

  return {
    settings: settingsResult.data,
    rights: rightsResult.data,
    config: {
      ...(isPlainObject(settingsResult.data) ? settingsResult.data : {}),
      rights: rightsResult.data,
    },
    credentials,
  };
}

export interface BuildConnectorOptions {
  /** Configuration stockée (la clé réservée `rights` est écartée avant validation). */
  config: unknown;
  /** Identifiants déchiffrés. */
  credentials: ConnectorCredentials;
  /** Bornes ; ne peuvent que resserrer celles de `@archivage/types`. */
  limits?: Partial<ConnectorLimits>;
  deps?: ConnectorDeps;
}

/** Assemble le contexte puis instancie le connecteur configuré. */
export function buildConnector(
  registry: ConnectorRegistry,
  type: string,
  options: BuildConnectorOptions,
): SourceConnector {
  const def = registry.get(type);
  if (!def) throw new ConnectorConfigError(`Type de connecteur inconnu : « ${type} ».`, []);

  const { settings } = splitStoredConfig(options.config);
  const settingsResult = def.configSchema.safeParse(settings);
  if (!settingsResult.success) {
    const problems = formatIssues('réglage', settingsResult.error);
    throw new ConnectorConfigError(
      `Configuration du connecteur « ${def.label} » invalide : ${problems.join(' ; ')}`,
      problems,
    );
  }
  const credsResult = def.credentialsSchema.safeParse(options.credentials ?? {});
  if (!credsResult.success) {
    const problems = formatCredentialIssues(credsResult.error);
    throw new ConnectorConfigError(
      `Identifiants du connecteur « ${def.label} » invalides : ${problems.join(' ; ')}`,
      problems,
    );
  }

  return def.create({
    config: settingsResult.data,
    credentials: credsResult.data,
    limits: resolveLimits(options.limits),
    deps: options.deps ?? {},
  });
}
