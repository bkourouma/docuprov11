import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import { extensionOf } from '../limits';
import { assertPublicHost } from '../ssrf';
import {
  ConnectorItemRejectedError,
  type ChangePage,
  type ConnectorContext,
  type ConnectorDefinition,
  type ConnectorDeps,
  type FetchedFile,
  type ImapClientFactory,
  type ImapSession,
  type ListChangesOptions,
  type OriginAcl,
  type RemoteItem,
  type SourceConnector,
} from '../types';
import { createDefaultImapClientFactory } from './imap-default';
import { mapImapError } from './imap-errors';

export const IMAP_CONNECTOR_TYPE = 'imap';

/** Image plus petite que ceci = logo / signature de mail, pas un document. */
const SIGNATURE_IMAGE_MAX_BYTES = 10 * 1024;

const configSchema = z
  .object({
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9._:-]+$/, 'nom d\'hôte invalide'),
    port: z.number().int().min(1).max(65_535).default(993),
    /** `true` = TLS direct ; `false` = STARTTLS exigé. Le certificat est TOUJOURS vérifié. */
    secure: z.boolean().default(true),
    mailbox: z
      .string()
      .min(1)
      .max(200)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f]+$/, 'caractères interdits')
      .default('INBOX'),
  })
  .strict();
export type ImapConfig = z.infer<typeof configSchema>;

const credentialsSchema = z
  .object({
    user: z.string().min(1).max(500),
    password: z.string().min(1).max(500),
  })
  .strict();

interface Token {
  v: number;
  u: number;
}

function parseToken(token: string): Token {
  try {
    const t: unknown = JSON.parse(token);
    if (typeof t === 'object' && t !== null) {
      const { v, u } = t as { v?: unknown; u?: unknown };
      const vn = typeof v === 'string' ? Number(v) : v;
      if (
        typeof vn === 'number' &&
        Number.isFinite(vn) &&
        typeof u === 'number' &&
        Number.isInteger(u) &&
        u >= 0
      ) {
        return { v: vn, u };
      }
    }
  } catch {
    // tombe dans l'erreur ci-dessous
  }
  // Pas de relistage silencieux : sur une grosse boîte il rejouerait tout l'historique à chaque passe.
  throw new Error('Le jeton de changement IMAP est illisible : réinitialisez-le pour relister la boîte.');
}

function parseExternalId(id: string): { v: string; uid: number; partId: string } | null {
  const m = /^(\d+):(\d+):([0-9A-Za-z.]+)$/.exec(id);
  if (!m) return null;
  const uid = Number(m[2]);
  return Number.isSafeInteger(uid) ? { v: m[1] ?? '', uid, partId: m[3] ?? '' } : null;
}

class ImapConnector implements SourceConnector {
  readonly type = IMAP_CONNECTOR_TYPE;
  private readonly config: ImapConfig;
  private readonly user: string;
  private readonly password: string;
  private readonly factory: ImapClientFactory;
  private readonly allowed: Set<string>;
  private session: Promise<ImapSession> | null = null;

  constructor(private readonly ctx: ConnectorContext) {
    this.config = configSchema.parse(ctx.config);
    const creds = credentialsSchema.parse(ctx.credentials);
    this.user = creds.user;
    this.password = creds.password;
    this.factory =
      ctx.deps.imap ?? createDefaultImapClientFactory({ resolveHost: ctx.deps.resolveHost });
    this.allowed = new Set(ctx.limits.allowedExtensions.map((e) => e.toLowerCase()));
  }

  /** Connexion paresseuse, partagée entre les appels ; réinitialisée si elle échoue. */
  private getSession(): Promise<ImapSession> {
    if (!this.session) {
      const attempt = this.factory
        .connect({
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
          user: this.user,
          password: this.password,
          mailbox: this.config.mailbox,
        })
        .catch((e: unknown) => {
          this.session = null;
          throw mapImapError(e, [this.password]);
        });
      this.session = attempt;
    }
    return this.session;
  }

  /** Exécute une opération de session en traduisant les erreurs ; une session en échec est jetée. */
  private async run<T>(op: (s: ImapSession) => Promise<T>): Promise<T> {
    const session = await this.getSession();
    try {
      return await op(session);
    } catch (e) {
      const mapped = mapImapError(e, [this.password]);
      if (!(mapped instanceof ConnectorItemRejectedError)) {
        // Connexion probablement morte : on la ferme pour reconnecter au prochain appel.
        this.session = null;
        await session.close().catch(() => undefined);
      }
      throw mapped;
    }
  }

  async authenticate(): Promise<void> {
    await this.getSession();
  }

  async listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage> {
    const pageSize = Math.max(1, Math.floor(opts.pageSize));
    const token = since === null ? null : parseToken(since);

    return this.run(async (session) => {
      const validity = Number(session.uidValidity);
      // UIDVALIDITY changé : les UID du jeton ne désignent plus les mêmes messages. On repart du début ;
      // les doublons éventuels sont écartés par empreinte côté moteur.
      const after = token && token.v === validity ? token.u : 0;

      // pageSize+1 : permet de savoir s'il reste des messages sans requête supplémentaire.
      const messages = await session.listMessages(after, pageSize + 1);
      const page = messages.slice(0, pageSize);
      const hasMore = messages.length > pageSize;

      const items: RemoteItem[] = [];
      for (const msg of page) {
        for (const att of msg.attachments) {
          if (att.contentType.toLowerCase().startsWith('image/') && att.size < SIGNATURE_IMAGE_MAX_BYTES) {
            continue; // logo / signature
          }
          // Hors liste d'extensions : ignoré au listage (rejeté à la récupération si on le demandait).
          if (!this.allowed.has(extensionOf(att.filename))) continue;
          items.push({
            externalId: `${validity}:${msg.uid}:${att.partId}`,
            name: att.filename,
            originPath: this.config.mailbox,
            mimeType: att.contentType,
            byteLength: att.size,
            originAuthor: msg.from,
            originCreatedAt: msg.date,
            remoteVersion: String(att.size),
            originMetadata: {
              subject: msg.subject?.slice(0, 1000),
              messageId: msg.messageId,
              from: msg.from,
            },
          });
        }
      }

      // Le curseur avance sur TOUS les messages de la page, même sans pièce jointe utile.
      const lastUid = page[page.length - 1]?.uid ?? after;
      const next: Token = { v: validity, u: lastUid };
      return {
        items,
        deletedExternalIds: [], // limite connue : pas de détection de suppression IMAP
        nextToken: JSON.stringify(next),
        hasMore,
      };
    });
  }

  async fetchFile(item: RemoteItem): Promise<FetchedFile> {
    const ref = parseExternalId(item.externalId);
    if (!ref) throw new ConnectorItemRejectedError('Identifiant de pièce jointe invalide.');
    const ext = extensionOf(item.name);
    if (!this.allowed.has(ext)) {
      throw new ConnectorItemRejectedError(`Type de fichier non autorisé (${ext || 'sans extension'}).`);
    }
    const max = this.ctx.limits.maxFileBytes;

    return this.run(async (session) => {
      if (String(session.uidValidity) !== ref.v) {
        throw new ConnectorItemRejectedError(
          "Le message n'est plus joignable : la boîte a été réinitialisée (UIDVALIDITY).",
        );
      }
      const bytes = await session.downloadAttachment(ref.uid, ref.partId, max);
      if (bytes.length > max) {
        throw new ConnectorItemRejectedError(`Pièce jointe trop volumineuse (limite ${max} octets).`);
      }
      return { bytes, name: item.name, mimeType: item.mimeType };
    });
  }

  /**
   * Boîte dédiée : un seul principal, le compte lui-même, en lecture. L'administrateur rattache ce
   * compte à un groupe DocuPro dans `rights.principalMap`.
   */
  async readOriginAcl(): Promise<OriginAcl | null> {
    return { entries: [{ principal: this.user, kind: 'user', access: 'read' }] };
  }

  async close(): Promise<void> {
    const pending = this.session;
    this.session = null;
    if (!pending) return;
    try {
      const s = await pending;
      await s.close();
    } catch {
      // connexion déjà en échec : rien à fermer
    }
  }
}

export const imapConnector: ConnectorDefinition = {
  type: IMAP_CONNECTOR_TYPE,
  label: 'Boîte IMAP dédiée',
  description:
    "Reprend les pièces jointes des messages d'une boîte IMAP dédiée (les corps de messages ne sont " +
    "pas importés). La boîte n'est jamais modifiée : messages ni indicateurs.",
  supportedModes: [GedSourceMode.Copie, GedSourceMode.Synchro],
  configFields: [
    { name: 'host', label: 'Serveur IMAP', kind: 'text', required: true, placeholder: 'imap.exemple.org' },
    { name: 'port', label: 'Port', kind: 'number', required: false, placeholder: '993' },
    {
      name: 'secure',
      label: 'Connexion chiffrée (TLS direct)',
      kind: 'boolean',
      required: false,
      help: 'Désactivé = STARTTLS exigé. Le certificat du serveur est toujours vérifié.',
    },
    { name: 'mailbox', label: 'Dossier IMAP', kind: 'text', required: false, placeholder: 'INBOX' },
  ],
  credentialFields: [
    { name: 'user', label: 'Compte', kind: 'text', required: true },
    { name: 'password', label: 'Mot de passe', kind: 'password', required: true },
  ],
  configSchema,
  credentialsSchema,
  async assertConfigSafe(config: unknown, deps: ConnectorDeps): Promise<void> {
    const parsed = configSchema.parse(config);
    // Garde SSRF : le serveur ne doit pas être poussé à joindre son réseau interne. Tous les ports
    // sont admis ; c'est l'adresse résolue qui fait foi.
    await assertPublicHost(parsed.host, { resolve: deps.resolveHost });
  },
  create(ctx: ConnectorContext): SourceConnector {
    return new ImapConnector(ctx);
  },
};
