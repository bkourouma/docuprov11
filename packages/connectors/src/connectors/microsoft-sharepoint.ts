import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import { OAuthApiError, type OAuthApiClient } from '../oauth-contract';
import type { ConnectorContext, ConnectorDefinition, SourceConnector } from '../types';
import {
  DriveLibraryConnector,
  GRAPH_BASE,
  extensionsConfigSchema,
  folderPathConfigSchema,
  graphCredentialsSchema,
  isGraphUrl,
  seg,
} from './microsoft-graph';

export const SHAREPOINT_CONNECTOR_TYPE = 'microsoft_sharepoint';
export const SHAREPOINT_SCOPES = ['offline_access', 'Sites.Read.All'] as const;

/** Bibliothèques parcourues au plus pour trouver `libraryName` (pages de 200 environ). */
const MAX_DRIVE_PAGES = 5;

const configSchema = z
  .object({
    /** Domaine SharePoint Online du locataire (jamais un hôte arbitraire). */
    hostname: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.sharepoint\.com$/i, 'nom d’hôte SharePoint invalide'),
    sitePath: z
      .string()
      .trim()
      .regex(/^\/(sites|teams)\/[A-Za-z0-9._~-]{1,128}$/, 'chemin de site invalide (ex. /sites/Finance)'),
    /** Vide = bibliothèque de documents par défaut du site. */
    libraryName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f]+$/, 'caractères interdits')
      .optional(),
    folderPath: folderPathConfigSchema.optional(),
    extensions: extensionsConfigSchema.optional(),
  })
  .strict();
export type SharePointConfig = z.infer<typeof configSchema>;

/** Identifiant de site (`host,guid,guid`) : les virgules restent telles quelles dans le chemin. */
function encodeSiteId(siteId: string): string {
  return seg(siteId).replace(/%2C/gi, ',');
}

interface DriveRow {
  id?: string;
  name?: string;
}

/** `GET /sites/{hostname}:{sitePath}` puis la bibliothèque (par défaut ou par nom). */
async function resolveLibrary(
  oauth: OAuthApiClient,
  config: SharePointConfig,
): Promise<{ driveId: string; extraMetadata: Record<string, unknown> }> {
  const sitePath = config.sitePath.split('/').map(seg).join('/');
  let siteId: string | undefined;
  try {
    const site = await oauth.getJson<{ id?: string }>(
      `${GRAPH_BASE}/sites/${seg(config.hostname)}:${sitePath}?$select=id`,
    );
    siteId = site?.id;
  } catch (e) {
    if (e instanceof OAuthApiError && e.status === 404) {
      throw new Error('Site SharePoint introuvable : vérifiez le nom d’hôte et le chemin du site.');
    }
    throw e;
  }
  if (typeof siteId !== 'string' || siteId === '') {
    throw new Error('Site SharePoint introuvable : réponse sans identifiant de site.');
  }
  const siteSeg = encodeSiteId(siteId);

  if (config.libraryName === undefined) {
    const drive = await oauth.getJson<DriveRow>(`${GRAPH_BASE}/sites/${siteSeg}/drive?$select=id,name`);
    if (typeof drive?.id !== 'string' || drive.id === '') {
      throw new Error('Bibliothèque par défaut du site SharePoint introuvable.');
    }
    return { driveId: drive.id, extraMetadata: { siteId } };
  }

  const wanted = config.libraryName.trim().toLowerCase();
  let url: string | undefined = `${GRAPH_BASE}/sites/${siteSeg}/drives?$select=id,name`;
  for (let page = 0; url && page < MAX_DRIVE_PAGES; page++) {
    const body: { value?: DriveRow[]; '@odata.nextLink'?: string } = await oauth.getJson(url);
    const found = (Array.isArray(body?.value) ? body.value : []).find(
      (d) => typeof d?.name === 'string' && d.name.trim().toLowerCase() === wanted && typeof d.id === 'string' && d.id !== '',
    );
    if (found?.id) return { driveId: found.id, extraMetadata: { siteId } };
    const next: unknown = body?.['@odata.nextLink'];
    url = isGraphUrl(next) ? next : undefined;
  }
  throw new Error(`Bibliothèque « ${config.libraryName.slice(0, 100)} » introuvable sur le site SharePoint.`);
}

class SharePointConnector extends DriveLibraryConnector {
  constructor(ctx: ConnectorContext) {
    const config = configSchema.parse(ctx.config);
    super(SHAREPOINT_CONNECTOR_TYPE, ctx, SHAREPOINT_SCOPES, {
      resolveDrive: (oauth) => resolveLibrary(oauth, config),
      firstDeltaUrl: (driveId) => `${GRAPH_BASE}/drives/${seg(driveId)}/root/delta`,
      // Le siteId fait partie des métadonnées de chaque élément : le site est toujours résolu.
      eagerDrive: true,
      folderPath: config.folderPath,
      extensions: config.extensions,
    });
  }
}

export const sharepointConnector: ConnectorDefinition = {
  type: SHAREPOINT_CONNECTOR_TYPE,
  label: 'Microsoft SharePoint',
  description:
    "Reprend les fichiers d'une bibliothèque de documents SharePoint Online (lecture seule, suivi " +
    'des modifications et suppressions par Microsoft Graph). Aucun fichier de la source n’est modifié.',
  supportedModes: [GedSourceMode.Copie, GedSourceMode.IndexationEnPlace, GedSourceMode.Synchro],
  configFields: [
    {
      name: 'hostname',
      label: 'Domaine SharePoint',
      kind: 'text',
      required: true,
      placeholder: 'contoso.sharepoint.com',
    },
    {
      name: 'sitePath',
      label: 'Chemin du site',
      kind: 'text',
      required: true,
      placeholder: '/sites/Finance',
    },
    {
      name: 'libraryName',
      label: 'Bibliothèque de documents',
      kind: 'text',
      required: false,
      placeholder: 'Documents',
      help: 'Vide = bibliothèque par défaut du site.',
    },
    {
      name: 'folderPath',
      label: 'Dossier à reprendre',
      kind: 'text',
      required: false,
      placeholder: '/Factures',
      help: 'Vide = toute la bibliothèque. Le dossier et ses sous-dossiers sont repris.',
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
  oauth: { provider: 'microsoft', scopes: SHAREPOINT_SCOPES },
  async assertConfigSafe(config: unknown): Promise<void> {
    // Le nom d'hôte n'est jamais appelé directement (seulement passé à Graph) et son format est
    // restreint à *.sharepoint.com : la validation du schéma suffit.
    configSchema.parse(config);
  },
  create(ctx: ConnectorContext): SourceConnector {
    return new SharePointConnector(ctx);
  },
};
