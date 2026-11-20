// Contrat du cadre de connecteurs de sources (lot 2a). FIGÉ : api, worker et connecteurs codent
// contre ces types ; toute évolution se discute avec le chef de lot.
import type { z } from 'zod';
import type { GedSourceMode } from '@archivage/types';

/** Identifiants déchiffrés d'une source (clé → valeur). Jamais journalisés, jamais renvoyés par l'API. */
export type ConnectorCredentials = Record<string, string>;

/** Erreurs typées : le moteur de synchro en déduit le statut du connecteur et la reprise. */
export class ConnectorAuthError extends Error {
  /** `true` si l'autorisation a expiré (statut « autorisation expirée »), `false` si refusée. */
  constructor(
    message: string,
    readonly expired = false,
  ) {
    super(message);
    this.name = 'ConnectorAuthError';
  }
}
/** Quota / limitation de débit de la source : la passe s'arrête proprement et reprend plus tard. */
export class ConnectorQuotaError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ConnectorQuotaError';
  }
}
/** Fichier refusé par les bornes (taille, type) : l'élément passe « en erreur », la passe continue. */
export class ConnectorItemRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorItemRejectedError';
  }
}

/** Un élément vu dans la source. `externalId` est stable (chemin, UID de message + pièce…). */
export interface RemoteItem {
  externalId: string;
  name: string;
  originUrl?: string;
  originPath?: string;
  mimeType?: string;
  byteLength?: number;
  originAuthor?: string;
  originCreatedAt?: Date;
  originModifiedAt?: Date;
  /** ETag / révision / mtime : change quand le contenu change, sans relire le fichier. */
  remoteVersion?: string;
  /** Métadonnées propres au connecteur (sujet du mail, expéditeur…). JSON-sérialisable, non secret. */
  originMetadata?: Record<string, unknown>;
}

/**
 * Droits d'origine d'un élément, normalisés. `public` = « tout le monde / lien public / autres » :
 * ne se mappe JAMAIS vers un accès général DocuPro (cf. rights.ts).
 */
export interface OriginAclEntry {
  /** Identifiant du principal dans la source (e-mail, uid, nom de groupe, SID…). */
  principal: string;
  kind: 'user' | 'group' | 'public' | 'unknown';
  access: 'read' | 'write' | 'owner' | 'unknown';
}
export interface OriginAcl {
  entries: OriginAclEntry[];
}

/** Une page de changements. `nextToken` est persisté (reprise) ; `hasMore` = d'autres pages suivent. */
export interface ChangePage {
  items: RemoteItem[];
  /** Éléments supprimés à la source depuis le jeton précédent. */
  deletedExternalIds: string[];
  /** Jeton à fournir à l'appel suivant (et à persister dans `change_token`). */
  nextToken: string | null;
  hasMore: boolean;
}

export interface ListChangesOptions {
  pageSize: number;
  signal?: AbortSignal;
}

export interface FetchedFile {
  /** Contenu borné par `limits.maxFileBytes` : au-delà, lever `ConnectorItemRejectedError`. */
  bytes: Buffer;
  /** Nom de fichier à retenir (peut différer de `RemoteItem.name`, ex. pièce jointe). */
  name?: string;
  mimeType?: string;
}

/** Interface commune de tous les connecteurs. Une instance = un connecteur configuré. */
export interface SourceConnector {
  readonly type: string;
  /** Vérifie la connexion et les identifiants. Lève `ConnectorAuthError` si refus ou expiration. */
  authenticate(): Promise<void>;
  /**
   * Liste les éléments nouveaux/modifiés depuis `since` (jeton de changement ; `null` = premier
   * passage, listage complet), page par page. Lève `ConnectorQuotaError` si la source limite le débit.
   */
  listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage>;
  /** Récupère le contenu d'un élément. Respecte `limits.maxFileBytes` et les types autorisés. */
  fetchFile(item: RemoteItem): Promise<FetchedFile>;
  /** Droits d'origine ; `null` = illisibles (le mapping retombera sur le plus restrictif). */
  readOriginAcl(item: RemoteItem): Promise<OriginAcl | null>;
  /**
   * OPTIONNEL — pour les sources sans journal de suppressions (dossier) : renvoie, parmi les
   * `knownExternalIds` fournis, ceux qui n'existent plus à la source. Appelé par le moteur en fin de
   * passe complète, par lots. Une source qui sait lister ses suppressions les met dans `ChangePage`.
   */
  findMissing?(knownExternalIds: string[]): Promise<string[]>;
  close(): Promise<void>;
}

export interface ConnectorLimits {
  maxFileBytes: number;
  allowedExtensions: readonly string[];
}

/** Dépendances externes injectables (tests : fournisseurs simulés, aucun accès réseau/disque réel). */
export interface ConnectorDeps {
  /** Fournisseur de système de fichiers (connecteur `filesystem`). Défaut : `node:fs/promises`. */
  fs?: FsProvider;
  /** Fabrique de client IMAP (connecteur `imap`). Défaut : imapflow (aucune analyse MIME : seule la structure de la boîte est lue). */
  imap?: ImapClientFactory;
  /** Résolveur DNS pour la garde SSRF. Défaut : `dns.promises.lookup`. */
  resolveHost?: (host: string) => Promise<string[]>;
  now?: () => Date;
  /** Environnement (défaut ) : GED_CONNECTOR_FS_ROOTS, ARCHIVES_PATH, GED_CONNECTOR_ALLOWED_INTERNAL_HOSTS. */
  env?: NodeJS.ProcessEnv;
}

export interface ConnectorContext {
  /** Configuration déjà validée par `ConnectorDefinition.configSchema`. */
  config: unknown;
  credentials: ConnectorCredentials;
  limits: ConnectorLimits;
  deps: ConnectorDeps;
}

/** Description d'un champ de formulaire (l'écran d'administration se construit à partir d'elle). */
export interface ConnectorFieldDescriptor {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'boolean' | 'password' | 'textarea';
  required: boolean;
  help?: string;
  placeholder?: string;
}

/** Entrée du registre : une clé libre `[a-z0-9_]+`, aucun changement de schéma pour en ajouter. */
export interface ConnectorDefinition {
  type: string;
  label: string;
  description: string;
  supportedModes: GedSourceMode[];
  /** Champs de configuration (non secrets) et d'identifiants, en français, pour le formulaire. */
  configFields: ConnectorFieldDescriptor[];
  credentialFields: ConnectorFieldDescriptor[];
  /** Schéma zod STRICT de la configuration non secrète. */
  configSchema: z.ZodType<unknown>;
  /** Schéma zod STRICT des identifiants (secrets). */
  credentialsSchema: z.ZodType<Record<string, string>>;
  /** Lève (async-sûr) si la config est dangereuse (hôte interne : garde SSRF, chemin hors racine…). */
  assertConfigSafe(config: unknown, deps: ConnectorDeps): Promise<void>;
  create(ctx: ConnectorContext): SourceConnector;
}

// ---------------------------------------------------------------------------
// Fournisseurs simulables
// ---------------------------------------------------------------------------

export interface FsEntry {
  /** Chemin relatif à la racine surveillée, séparateur `/`. */
  relPath: string;
  size: number;
  mtimeMs: number;
  birthtimeMs?: number;
  /** Bits de permission POSIX (ex. 0o640) ; `undefined` sur Windows/SMB sans mapping. */
  mode?: number;
  uid?: number;
  gid?: number;
}
export interface FsProvider {
  /** Parcours récursif sous `root`, sans suivre les liens symboliques, hors dossiers de service. */
  walk(root: string): Promise<FsEntry[]>;
  /** Lecture bornée : lève si le fichier dépasse `maxBytes`. */
  readFile(absPath: string, maxBytes: number): Promise<Buffer>;
  /** Chemin réel (résolution des liens) pour interdire toute sortie de la racine. */
  realpath(absPath: string): Promise<string>;
}

export interface ImapMessageSummary {
  uid: number;
  messageId?: string;
  from?: string;
  subject?: string;
  date?: Date;
  /** Pièces jointes (nom, type, taille) — contenu récupéré à la demande. */
  attachments: Array<{ partId: string; filename: string; contentType: string; size: number }>;
}
export interface ImapSession {
  /** UIDVALIDITY de la boîte : s'il change, les UID précédents ne sont plus valides (re-listage). */
  uidValidity: bigint;
  /** Messages d'UID strictement supérieur à `afterUid`, par ordre croissant, au plus `limit`. */
  listMessages(afterUid: number, limit: number): Promise<ImapMessageSummary[]>;
  downloadAttachment(uid: number, partId: string, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
}
export interface ImapConnectionParams {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
}
export interface ImapClientFactory {
  connect(params: ImapConnectionParams): Promise<ImapSession>;
}
