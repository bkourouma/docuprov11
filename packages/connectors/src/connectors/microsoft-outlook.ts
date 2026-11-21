// Connecteur Microsoft Outlook (pièces jointes d'une boîte dédiée), lecture seule, via Microsoft Graph.
// Même philosophie que la boîte IMAP : les corps de messages ne sont pas importés, la boîte n'est
// jamais modifiée.
//
// Limites connues :
// - une page peut contenir plus d'éléments que `pageSize` (la pagination porte sur les MESSAGES, un
//   message peut avoir plusieurs pièces jointes) ;
// - les suppressions de messages ne sont connues que de la passe en cours (mémoire de l'instance) :
//   si la passe s'interrompt avant `findMissing`, la suppression est perdue (le jeton a avancé) ;
// - un message déplacé hors du dossier suivi apparaît comme supprimé du dossier ;
// - les identifiants Graph de messages ne sont pas « immuables » : un message déplacé de dossier peut
//   changer d'identifiant (les doublons sont alors écartés par empreinte côté moteur).
import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import { extensionOf } from '../limits';
import { OAuthApiError } from '../oauth-contract';
import {
  ConnectorItemRejectedError,
  type ChangePage,
  type ConnectorContext,
  type ConnectorDefinition,
  type FetchedFile,
  type ListChangesOptions,
  type OriginAcl,
  type RemoteItem,
  type SourceConnector,
} from '../types';
import {
  GRAPH_BASE,
  GraphConnectorBase,
  extensionsConfigSchema,
  fetchDeltaPage,
  graphCredentialsSchema,
  isGraphUrl,
  parseDeltaToken,
  resolveAllowedExtensions,
  seg,
} from './microsoft-graph';

export const OUTLOOK_CONNECTOR_TYPE = 'microsoft_outlook';
export const OUTLOOK_SCOPES = ['offline_access', 'Mail.Read'] as const;

/** Image plus petite que ceci = logo / signature de mail, pas un document (comme IMAP). */
const SIGNATURE_IMAGE_MAX_BYTES = 10 * 1024;
const EXTERNAL_ID_MAX_LENGTH = 500;
const MAX_ATTACHMENT_PAGES = 5;
const ID_PATTERN = /^[A-Za-z0-9_=+/-]{1,400}$/;

const MESSAGE_SELECT = 'id,subject,from,receivedDateTime,hasAttachments,webLink,internetMessageId';
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,lastModifiedDateTime';

const configSchema = z
  .object({
    /** Adresse de la boîte dédiée : c'est le principal des droits d'origine. */
    mailboxAddress: z.string().trim().min(3).max(320).email(),
    /** Nom connu (`inbox`, `archive`…) ou identifiant de dossier. */
    folder: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_=-]{1,300}$/, 'nom ou identifiant de dossier invalide')
      .default('inbox'),
    includeInlineImages: z.boolean().default(false),
    extensions: extensionsConfigSchema.optional(),
  })
  .strict();
export type OutlookConfig = z.infer<typeof configSchema>;

interface GraphMessage {
  id?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  receivedDateTime?: string;
  hasAttachments?: boolean;
  webLink?: string;
  internetMessageId?: string;
  '@removed'?: unknown;
}
interface GraphAttachment {
  '@odata.type'?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  lastModifiedDateTime?: string;
}

function parseExternalId(id: string): { messageId: string; attachmentId: string } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const messageId = id.slice(0, i);
  const attachmentId = id.slice(i + 1);
  return ID_PATTERN.test(messageId) && ID_PATTERN.test(attachmentId) ? { messageId, attachmentId } : null;
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

class OutlookConnector extends GraphConnectorBase {
  readonly type = OUTLOOK_CONNECTOR_TYPE;
  private readonly config: OutlookConfig;
  private readonly allowed: Set<string>;
  /** Identifiants Graph des messages supprimés vus pendant la passe (voir `findMissing`). */
  private readonly removedMessageIds = new Set<string>();

  constructor(ctx: ConnectorContext) {
    super(ctx, OUTLOOK_SCOPES);
    this.config = configSchema.parse(ctx.config);
    this.allowed = resolveAllowedExtensions(ctx.limits.allowedExtensions, this.config.extensions);
  }

  async listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage> {
    if (since !== null) parseDeltaToken(since); // jeton illisible : erreur avant tout appel
    const firstUrl = `${GRAPH_BASE}/me/mailFolders/${seg(this.config.folder)}/messages/delta?$select=${MESSAGE_SELECT}`;
    const page = await fetchDeltaPage<GraphMessage>(this.oauth, since, firstUrl, opts.pageSize, opts.signal);

    const items: RemoteItem[] = [];
    for (const msg of page.value) {
      if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || !ID_PATTERN.test(msg.id)) continue;
      if (msg['@removed'] !== undefined && msg['@removed'] !== null) {
        this.removedMessageIds.add(msg.id);
        continue;
      }
      if (msg.hasAttachments !== true) continue;
      items.push(...(await this.itemsOfMessage(msg, msg.id, opts.signal)));
    }
    return { items, deletedExternalIds: [], nextToken: page.nextToken, hasMore: page.hasMore };
  }

  private async itemsOfMessage(msg: GraphMessage, messageId: string, signal?: AbortSignal): Promise<RemoteItem[]> {
    const attachments: GraphAttachment[] = [];
    try {
      let url: string | undefined = `${GRAPH_BASE}/me/messages/${seg(messageId)}/attachments?$select=${ATTACHMENT_SELECT}`;
      for (let p = 0; url && p < MAX_ATTACHMENT_PAGES; p++) {
        const body: { value?: GraphAttachment[]; '@odata.nextLink'?: string } = await this.oauth.getJson(
          url,
          signal ? { signal } : undefined,
        );
        if (Array.isArray(body?.value)) attachments.push(...body.value);
        const next: unknown = body?.['@odata.nextLink'];
        url = isGraphUrl(next) ? next : undefined;
      }
    } catch (e) {
      // Message supprimé entre le delta et la lecture : ses pièces jointes ne sont plus joignables.
      if (e instanceof OAuthApiError && e.status === 404) return [];
      throw e;
    }

    const sender = msg.from?.emailAddress;
    const from = sender?.address || sender?.name || undefined;
    const out: RemoteItem[] = [];
    for (const att of attachments) {
      // Seules les pièces jointes fichier : pas les messages joints (itemAttachment) ni les liens.
      if (att?.['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
      if (typeof att.id !== 'string' || !ID_PATTERN.test(att.id)) continue;
      const name = typeof att.name === 'string' ? att.name : '';
      if (name === '') continue;
      const size = typeof att.size === 'number' && Number.isFinite(att.size) ? att.size : undefined;
      const contentType = typeof att.contentType === 'string' ? att.contentType : undefined;
      if (att.isInline === true && !this.config.includeInlineImages) continue;
      if (contentType?.toLowerCase().startsWith('image/') && size !== undefined && size < SIGNATURE_IMAGE_MAX_BYTES) {
        continue; // logo / signature
      }
      if (!this.allowed.has(extensionOf(name))) continue;
      const externalId = `${messageId}:${att.id}`;
      if (externalId.length > EXTERNAL_ID_MAX_LENGTH) continue; // ne tiendrait pas en base
      out.push({
        externalId,
        name,
        originUrl: typeof msg.webLink === 'string' ? msg.webLink : undefined,
        originPath: this.config.folder,
        mimeType: contentType,
        byteLength: size,
        originAuthor: from,
        originCreatedAt: parseDate(msg.receivedDateTime),
        originModifiedAt: parseDate(att.lastModifiedDateTime),
        remoteVersion: size === undefined ? undefined : String(size),
        originMetadata: {
          subject: typeof msg.subject === 'string' ? msg.subject.slice(0, 1000) : undefined,
          from,
          messageId: msg.internetMessageId,
        },
      });
    }
    return out;
  }

  async fetchFile(item: RemoteItem): Promise<FetchedFile> {
    const ref = parseExternalId(item.externalId);
    if (!ref) throw new ConnectorItemRejectedError('Identifiant de pièce jointe invalide.');
    const ext = extensionOf(item.name);
    if (!this.allowed.has(ext)) {
      throw new ConnectorItemRejectedError(`Type de fichier non autorisé (${ext || 'sans extension'}).`);
    }
    const max = this.ctx.limits.maxFileBytes;
    if (typeof item.byteLength === 'number' && item.byteLength > max) {
      throw new ConnectorItemRejectedError(`Pièce jointe trop volumineuse (limite ${max} octets).`);
    }
    try {
      const { bytes, contentType } = await this.oauth.getBytes(
        `${GRAPH_BASE}/me/messages/${seg(ref.messageId)}/attachments/${seg(ref.attachmentId)}/$value`,
        { maxBytes: max },
      );
      if (bytes.length > max) {
        throw new ConnectorItemRejectedError(`Pièce jointe trop volumineuse (limite ${max} octets).`);
      }
      return { bytes, name: item.name, mimeType: item.mimeType ?? contentType };
    } catch (e) {
      if (e instanceof OAuthApiError && (e.status === 404 || e.status === 410)) {
        throw new ConnectorItemRejectedError("La pièce jointe n'existe plus à la source.");
      }
      throw e;
    }
  }

  /** Boîte dédiée : un seul principal, la boîte elle-même, en lecture (comme IMAP). */
  async readOriginAcl(): Promise<OriginAcl | null> {
    return {
      entries: [{ principal: this.config.mailboxAddress.toLowerCase(), kind: 'user', access: 'read' }],
    };
  }

  /**
   * Parmi les éléments connus, ceux dont le message a été vu comme supprimé pendant cette passe.
   * Aucun appel réseau : la mémoire est celle de l'instance (voir la limite en tête de fichier).
   */
  async findMissing(knownExternalIds: string[]): Promise<string[]> {
    if (this.removedMessageIds.size === 0) return [];
    return knownExternalIds.filter((id) => {
      const i = id.indexOf(':');
      return i > 0 && this.removedMessageIds.has(id.slice(0, i));
    });
  }
}

export const outlookConnector: ConnectorDefinition = {
  type: OUTLOOK_CONNECTOR_TYPE,
  label: 'Microsoft Outlook (pièces jointes)',
  description:
    "Reprend les pièces jointes des messages d'une boîte Outlook / Microsoft 365 dédiée (les corps de " +
    "messages ne sont pas importés). La boîte n'est jamais modifiée : messages ni indicateurs.",
  supportedModes: [GedSourceMode.Copie, GedSourceMode.Synchro],
  configFields: [
    {
      name: 'mailboxAddress',
      label: 'Adresse de la boîte',
      kind: 'text',
      required: true,
      placeholder: 'archives@exemple.org',
      help: 'Compte qui a autorisé l’accès : il sert de principal pour les droits (rights.principalMap).',
    },
    {
      name: 'folder',
      label: 'Dossier',
      kind: 'text',
      required: false,
      placeholder: 'inbox',
      help: 'Nom connu (inbox, archive…) ou identifiant de dossier Outlook.',
    },
    {
      name: 'includeInlineImages',
      label: 'Reprendre les images incorporées',
      kind: 'boolean',
      required: false,
      help: 'Désactivé par défaut. Les images de moins de 10 Ko (logos, signatures) sont toujours écartées.',
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
  oauth: { provider: 'microsoft', scopes: OUTLOOK_SCOPES },
  async assertConfigSafe(config: unknown): Promise<void> {
    configSchema.parse(config);
  },
  create(ctx: ConnectorContext): SourceConnector {
    return new OutlookConnector(ctx);
  },
};
