import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import type { ConnectorContext, ConnectorDefinition, SourceConnector } from '../types';
import {
  DriveLibraryConnector,
  GRAPH_BASE,
  extensionsConfigSchema,
  folderPathConfigSchema,
  graphCredentialsSchema,
} from './microsoft-graph';
import type { OAuthApiClient } from '../oauth-contract';

export const ONEDRIVE_CONNECTOR_TYPE = 'microsoft_onedrive';
export const ONEDRIVE_SCOPES = ['offline_access', 'Files.Read'] as const;

const configSchema = z
  .object({
    /** Filtre côté client sur `parentReference.path` : le delta ne filtre pas par dossier. */
    folderPath: folderPathConfigSchema.optional(),
    extensions: extensionsConfigSchema.optional(),
  })
  .strict();
export type OneDriveConfig = z.infer<typeof configSchema>;

/** Lecteur OneDrive de l'utilisateur autorisé, déduit au besoin (élément de delta sans `driveId`). */
async function resolveMyDrive(oauth: OAuthApiClient): Promise<{ driveId: string }> {
  const drive = await oauth.getJson<{ id?: string }>(`${GRAPH_BASE}/me/drive?$select=id`);
  if (typeof drive?.id !== 'string' || drive.id === '') {
    throw new Error('Microsoft OneDrive : le lecteur de l’utilisateur est introuvable.');
  }
  return { driveId: drive.id };
}

class OneDriveConnector extends DriveLibraryConnector {
  constructor(ctx: ConnectorContext) {
    const config = configSchema.parse(ctx.config);
    super(ONEDRIVE_CONNECTOR_TYPE, ctx, ONEDRIVE_SCOPES, {
      resolveDrive: resolveMyDrive,
      firstDeltaUrl: `${GRAPH_BASE}/me/drive/root/delta`,
      folderPath: config.folderPath,
      extensions: config.extensions,
    });
  }
}

export const onedriveConnector: ConnectorDefinition = {
  type: ONEDRIVE_CONNECTOR_TYPE,
  label: 'Microsoft OneDrive',
  description:
    "Reprend les fichiers du OneDrive de l'utilisateur qui a autorisé l'accès (lecture seule, " +
    'suivi des modifications et suppressions par Microsoft Graph). Aucun fichier de la source n’est modifié.',
  supportedModes: [GedSourceMode.Copie, GedSourceMode.IndexationEnPlace, GedSourceMode.Synchro],
  configFields: [
    {
      name: 'folderPath',
      label: 'Dossier à reprendre',
      kind: 'text',
      required: false,
      placeholder: '/Documents/Finance',
      help: 'Vide = tout le OneDrive. Le dossier et ses sous-dossiers sont repris.',
    },
    {
      name: 'extensions',
      label: 'Extensions (restriction)',
      kind: 'textarea',
      required: false,
      help: 'Liste d’extensions (ex. .pdf, .docx). Ne peut que restreindre la liste commune.',
    },
  ],
  credentialFields: [],
  configSchema,
  credentialsSchema: graphCredentialsSchema,
  oauth: { provider: 'microsoft', scopes: ONEDRIVE_SCOPES },
  async assertConfigSafe(config: unknown): Promise<void> {
    // Aucun hôte saisi : tous les appels vont à l'hôte unique de Graph.
    configSchema.parse(config);
  },
  create(ctx: ConnectorContext): SourceConnector {
    return new OneDriveConnector(ctx);
  },
};
