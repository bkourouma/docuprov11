import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow';
import { assertPublicHost } from '../ssrf';
import {
  ConnectorItemRejectedError,
  type ImapClientFactory,
  type ImapConnectionParams,
  type ImapMessageSummary,
  type ImapSession,
} from '../types';
import { mapImapError } from './imap-errors';

/** Délais bornés : une boîte qui ne répond pas ne doit pas bloquer indéfiniment un worker. */
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;
/** Adresses essayées au plus pour un même nom d'hôte. */
const MAX_ADDRESSES = 3;

type Attachment = ImapMessageSummary['attachments'][number];

function cleanFileName(raw: string | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()?.trim() ?? '';
  return base ? base.slice(0, 255) : fallback;
}

/**
 * Pièces jointes d'une structure MIME (BODYSTRUCTURE), sans télécharger quoi que ce soit.
 * Ignorées : parties `multipart`, corps de message sans nom, pièces « inline » référencées par un
 * Content-ID (images intégrées au corps du mail). Un message attaché (`message/rfc822`) compte comme
 * UNE pièce jointe, on n'en parcourt pas l'intérieur.
 */
export function extractAttachments(root: MessageStructureObject | undefined): Attachment[] {
  const out: Attachment[] = [];
  if (!root) return out;
  const visit = (node: MessageStructureObject): void => {
    const type = (node.type ?? '').toLowerCase();
    const disposition = (node.disposition ?? '').toLowerCase();
    if (type === 'message/rfc822' && disposition === 'attachment' && node.part) {
      out.push({
        partId: node.part,
        filename: cleanFileName(
          node.dispositionParameters?.filename ?? node.parameters?.name,
          `message-${node.part}.eml`,
        ),
        contentType: type,
        size: node.size ?? 0,
      });
      return;
    }
    if (node.childNodes && node.childNodes.length > 0) {
      node.childNodes.forEach(visit);
      return;
    }
    if (!node.part || type.startsWith('multipart/')) return;
    const rawName = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (!rawName && disposition !== 'attachment') return; // corps du message
    if (disposition === 'inline' && node.id) return; // image/pièce intégrée (cid)
    if (!rawName && disposition === 'attachment') {
      // Pièce jointe sans nom : on lui en donne un stable, l'extension est vérifiée plus loin.
      out.push({ partId: node.part, filename: `piece-${node.part}`, contentType: type, size: node.size ?? 0 });
      return;
    }
    out.push({
      partId: node.part,
      filename: cleanFileName(rawName, `piece-${node.part}`),
      contentType: type || 'application/octet-stream',
      size: node.size ?? 0,
    });
  };
  visit(root);
  return out;
}

function summarize(m: FetchMessageObject): ImapMessageSummary {
  const sender = m.envelope?.from?.[0];
  const internal = m.internalDate ? new Date(m.internalDate) : undefined;
  return {
    uid: m.uid,
    messageId: m.envelope?.messageId,
    from: sender?.address ?? sender?.name,
    subject: m.envelope?.subject,
    date: m.envelope?.date ?? internal,
    attachments: extractAttachments(m.bodyStructure),
  };
}

export interface DefaultImapFactoryOptions {
  /** Résolveur DNS (tests / garde SSRF). Défaut : `dns.promises.lookup`. */
  resolveHost?: (host: string) => Promise<string[]>;
}

class ImapFlowSession implements ImapSession {
  constructor(
    private readonly client: ImapFlow,
    readonly uidValidity: bigint,
  ) {}

  async listMessages(afterUid: number, limit: number): Promise<ImapMessageSummary[]> {
    // `N:*` renvoie TOUJOURS au moins le dernier message, même d'UID < N : on filtre explicitement.
    const found = await this.client.search({ uid: `${afterUid + 1}:*` }, { uid: true });
    if (!found || found.length === 0) return [];
    const uids = found.filter((u) => u > afterUid).sort((a, b) => a - b).slice(0, limit);
    if (uids.length === 0) return [];
    // Enveloppe + structure seulement : on n'ouvre aucun corps de message, c'est la méthode la plus
    // économe (pas besoin de mailparser) et elle suffit à repérer les pièces jointes.
    const messages = await this.client.fetchAll(
      uids,
      { uid: true, envelope: true, bodyStructure: true, internalDate: true },
      { uid: true },
    );
    return messages.sort((a, b) => a.uid - b.uid).map(summarize);
  }

  async downloadAttachment(uid: number, partId: string, maxBytes: number): Promise<Buffer> {
    // +1 octet : permet de distinguer « exactement maxBytes » de « tronqué par la borne ».
    const dl = await this.client.download(String(uid), partId, { uid: true, maxBytes: maxBytes + 1 });
    if (!dl || !dl.content) throw new ConnectorItemRejectedError('Pièce jointe introuvable.');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of dl.content) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes) {
        dl.content.destroy();
        throw new ConnectorItemRejectedError(`Pièce jointe trop volumineuse (limite ${maxBytes} octets).`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

/**
 * Fabrique IMAP réelle (imapflow). À CHAQUE connexion : l'hôte est re-résolu et re-contrôlé par la
 * garde SSRF (un DNS qui change entre la validation et l'usage — « DNS rebinding » — ne contourne
 * rien), puis on se connecte à l'ADRESSE résolue en gardant le nom d'hôte d'origine comme `servername`
 * TLS. Le certificat est toujours vérifié ; avec `secure:false` on EXIGE STARTTLS (pas de repli en clair).
 */
export function createDefaultImapClientFactory(options: DefaultImapFactoryOptions = {}): ImapClientFactory {
  return {
    async connect(params: ImapConnectionParams): Promise<ImapSession> {
      const secrets = [params.password];
      const addresses = (await assertPublicHost(params.host, { resolve: options.resolveHost })).slice(
        0,
        MAX_ADDRESSES,
      );
      if (addresses.length === 0) throw new Error(`Erreur IMAP : hôte « ${params.host} » sans adresse.`);

      let lastError: unknown;
      for (const address of addresses) {
        const client = new ImapFlow({
          host: address,
          port: params.port,
          secure: params.secure,
          servername: params.host,
          doSTARTTLS: params.secure ? undefined : true,
          auth: { user: params.user, pass: params.password },
          tls: { rejectUnauthorized: true, servername: params.host },
          logger: false, // jamais de journal protocolaire : il contiendrait le LOGIN
          connectionTimeout: CONNECTION_TIMEOUT_MS,
          greetingTimeout: GREETING_TIMEOUT_MS,
          socketTimeout: SOCKET_TIMEOUT_MS,
          disableAutoIdle: true,
        });
        // Une erreur asynchrone du socket sans écouteur ferait tomber le processus.
        client.on('error', () => undefined);
        try {
          await client.connect();
          const box = await client.mailboxOpen(params.mailbox, { readOnly: true });
          return new ImapFlowSession(client, box.uidValidity);
        } catch (e) {
          lastError = e;
          client.close();
          const mapped = mapImapError(e, secrets);
          // Identifiants refusés / limitation : changer d'adresse n'y changerait rien.
          if (mapped.name !== 'Error') throw mapped;
        }
      }
      throw mapImapError(lastError, secrets);
    },
  };
}
