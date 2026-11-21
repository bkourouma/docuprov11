// Lot 2c — connecteur WhatsApp Business (API WhatsApp Cloud de Meta). Connecteur « push » : les
// messages arrivent par le webhook public de l'API (apps/api/.../whatsapp-webhook.*) et sont ingérés
// par le worker (apps/worker/.../whatsapp.processor.ts). Il n'y a donc rien à lister ni à synchroniser :
// `listChanges` renvoie toujours une page vide. Mode copie uniquement.
import { GED_WHATSAPP_CONNECTOR_TYPE, GedSourceMode } from '@archivage/types';
import {
  assertWhatsappConfigSafe,
  WHATSAPP_CONFIG_FIELDS,
  WHATSAPP_CREDENTIAL_FIELDS,
  WHATSAPP_DEFAULT_GRAPH_API_VERSION,
  whatsappConfigSchema,
  whatsappCredentialsSchema,
} from '../whatsapp-config';
import {
  createDefaultWhatsappHttp,
  WhatsappGraphClient,
  type WhatsappHttp,
} from '../whatsapp-graph';
import {
  ConnectorItemRejectedError,
  type ChangePage,
  type ConnectorContext,
  type ConnectorDefinition,
  type FetchedFile,
  type OriginAcl,
  type RemoteItem,
  type SourceConnector,
} from '../types';
import { splitStoredConfig } from '../registry';

export const WHATSAPP_CONNECTOR_TYPE = GED_WHATSAPP_CONNECTOR_TYPE;

class WhatsappConnector implements SourceConnector {
  readonly type = WHATSAPP_CONNECTOR_TYPE;
  constructor(
    private readonly ctx: ConnectorContext,
    private readonly http: WhatsappHttp,
  ) {}

  /** Vérifie le jeton d'accès et le numéro auprès de l'API Graph (« tester la connexion »). */
  async authenticate(): Promise<void> {
    const cfg = whatsappConfigSchema.parse(splitStoredConfig(this.ctx.config).settings);
    const client = new WhatsappGraphClient({
      http: this.http,
      accessToken: this.ctx.credentials.accessToken ?? '',
      phoneNumberId: cfg.phoneNumberId,
      apiVersion: cfg.graphApiVersion ?? WHATSAPP_DEFAULT_GRAPH_API_VERSION,
      maxMediaBytes: this.ctx.limits.maxFileBytes,
      now: this.ctx.deps.now,
    });
    await client.probe();
  }

  /** Connecteur à événements : rien à lister, les messages sont poussés par le webhook. */
  async listChanges(): Promise<ChangePage> {
    return { items: [], deletedExternalIds: [], nextToken: null, hasMore: false };
  }

  async fetchFile(_item: RemoteItem): Promise<FetchedFile> {
    throw new ConnectorItemRejectedError(
      'Le connecteur WhatsApp reçoit ses documents par le webhook : pas de récupération à la demande.',
    );
  }

  async readOriginAcl(_item: RemoteItem): Promise<OriginAcl | null> {
    return null;
  }

  async close(): Promise<void> {
    /* aucune connexion persistante */
  }
}

/** Fabrique de la définition ; `http` permet d'injecter un transport simulé (tests). */
export function createWhatsappConnectorDefinition(extra: { http?: WhatsappHttp } = {}): ConnectorDefinition {
  return {
    type: WHATSAPP_CONNECTOR_TYPE,
    label: 'WhatsApp Business',
    description:
      "Les expéditeurs autorisés envoient des documents (PDF, photos, fichiers bureautiques) au numéro " +
      "WhatsApp Business de l'organisation ; ils sont ingérés en copie, avec les droits du groupe de l'expéditeur.",
    supportedModes: [GedSourceMode.Copie],
    configFields: WHATSAPP_CONFIG_FIELDS,
    credentialFields: WHATSAPP_CREDENTIAL_FIELDS,
    configSchema: whatsappConfigSchema,
    credentialsSchema: whatsappCredentialsSchema,
    async assertConfigSafe(config: unknown): Promise<void> {
      // Aucun hôte ni chemin dans la configuration : seule l'API Graph officielle est jointe.
      assertWhatsappConfigSafe(config);
    },
    create(ctx: ConnectorContext): SourceConnector {
      return new WhatsappConnector(ctx, extra.http ?? createDefaultWhatsappHttp());
    },
  };
}

export const whatsappConnector: ConnectorDefinition = createWhatsappConnectorDefinition();
