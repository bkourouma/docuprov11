import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import { extensionOf } from '../limits';
import { OAuthApiError, type OAuthApiClient } from '../oauth-contract';
import { createOAuthApiClient } from '../oauth-session';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ChangePage,
  type ConnectorContext,
  type ConnectorDefinition,
  type FetchedFile,
  type ListChangesOptions,
  type OriginAcl,
  type OriginAclEntry,
  type RemoteItem,
  type SourceConnector,
} from '../types';

export const GOOGLE_DRIVE_CONNECTOR_TYPE = 'google_drive';

/** Périmètre MINIMAL : lecture seule. */
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'] as const;

/** Seul hôte appelé. Les jetons de pagination sont des PARAMÈTRES, jamais des URL issues d'une réponse. */
const API_BASE = 'https://www.googleapis.com/drive/v3';

/** Profondeur maximale de remontée des parents pour la restriction à un dossier. */
const MAX_FOLDER_DEPTH = 20;
/** Bornes de mémoire du cache de parents. */
const MAX_PARENT_CACHE = 5000;
/** Pages de permissions lues au plus. */
const MAX_PERMISSION_PAGES = 10;

const DRIVE_ID_REGEX = /^[A-Za-z0-9_-]{5,128}$/;
/** Jeton de pagination Google : opaque, ASCII imprimable, borné. */
const PAGE_TOKEN_REGEX = /^[\x21-\x7e]{1,2048}$/;

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

interface ExportTarget {
  mimeType: string;
  ext: string;
}
/** Types Google natifs exportables : export PDF (défaut) ou bureautique (`office`). */
const NATIVE_EXPORTS: Record<string, { pdf: ExportTarget; office: ExportTarget }> = {
  'application/vnd.google-apps.document': {
    pdf: { mimeType: MIME_PDF, ext: '.pdf' },
    office: { mimeType: MIME_DOCX, ext: '.docx' },
  },
  'application/vnd.google-apps.spreadsheet': {
    pdf: { mimeType: MIME_PDF, ext: '.pdf' },
    office: { mimeType: MIME_XLSX, ext: '.xlsx' },
  },
  'application/vnd.google-apps.presentation': {
    pdf: { mimeType: MIME_PDF, ext: '.pdf' },
    office: { mimeType: MIME_PPTX, ext: '.pptx' },
  },
  // Dessins : PDF seulement.
  'application/vnd.google-apps.drawing': {
    pdf: { mimeType: MIME_PDF, ext: '.pdf' },
    office: { mimeType: MIME_PDF, ext: '.pdf' },
  },
};

/** Champ texte facultatif de formulaire : chaîne vide = absent. */
const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const driveIdField = z.preprocess(
  emptyToUndefined,
  z.string().trim().regex(DRIVE_ID_REGEX, 'identifiant Drive invalide').optional(),
);

const configSchema = z
  .object({
    /** Identifiant d'un DRIVE PARTAGÉ. Absent = « Mon Drive ». */
    driveId: driveIdField,
    /** Sans `driveId` : inclut aussi les drives partagés accessibles. */
    includeSharedDrives: z.boolean().default(false),
    /** Restreint à ce dossier et à sa descendance. */
    folderId: driveIdField,
    /** Format d'export des fichiers Google natifs. */
    exportFormat: z.enum(['pdf', 'office']).default('pdf'),
    /** Sous-ensemble des extensions autorisées (minuscules, point inclus). */
    extensions: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^\.[a-z0-9]{1,10}$/),
      )
      .max(50)
      .optional(),
  })
  .strict();
export type GoogleDriveConfig = z.infer<typeof configSchema>;

const credentialsSchema = z
  .object({
    refreshToken: z.string().min(1).max(16_384),
    scope: z.string().max(2000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Jeton de changement
// ---------------------------------------------------------------------------

type Token = { p: 'full'; t?: string; s: string } | { p: 'chg'; t: string };

function pageToken(v: unknown): string | null {
  return typeof v === 'string' && PAGE_TOKEN_REGEX.test(v) ? v : null;
}

function parseToken(token: string): Token {
  try {
    const t: unknown = JSON.parse(token);
    if (typeof t === 'object' && t !== null) {
      const { p, t: page, s } = t as { p?: unknown; t?: unknown; s?: unknown };
      if (p === 'chg') {
        const pt = pageToken(page);
        if (pt) return { p: 'chg', t: pt };
      } else if (p === 'full') {
        const start = pageToken(s);
        if (start && (page === undefined || pageToken(page))) {
          return page === undefined ? { p: 'full', s: start } : { p: 'full', t: page as string, s: start };
        }
      }
    }
  } catch {
    // tombe dans l'erreur ci-dessous
  }
  // Pas de relistage silencieux : un Drive complet rejouerait tout l'historique à chaque passe.
  throw new Error(
    'Le jeton de changement Google Drive est illisible : réinitialisez-le pour relister le Drive.',
  );
}

// ---------------------------------------------------------------------------
// Réponses de l'API
// ---------------------------------------------------------------------------

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
  headRevisionId?: string;
  version?: string;
  modifiedTime?: string;
  createdTime?: string;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  webViewLink?: string;
  parents?: string[];
  trashed?: boolean;
  driveId?: string;
}
interface FilesListResponse {
  nextPageToken?: string;
  files?: DriveFile[];
}
interface ChangesListResponse {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: Array<{ fileId?: string; removed?: boolean; file?: DriveFile }>;
}
interface PermissionsResponse {
  nextPageToken?: string;
  permissions?: Array<{
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
    domain?: string;
    deleted?: boolean;
  }>;
}

const FILE_FIELDS =
  'id,name,mimeType,size,md5Checksum,headRevisionId,version,modifiedTime,createdTime,' +
  'owners(displayName,emailAddress),webViewLink,parents,trashed,driveId';

function parseDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function isDriveId(id: unknown): id is string {
  return typeof id === 'string' && DRIVE_ID_REGEX.test(id);
}

class GoogleDriveConnector implements SourceConnector {
  readonly type = GOOGLE_DRIVE_CONNECTOR_TYPE;
  private readonly config: GoogleDriveConfig;
  private readonly allowed: Set<string>;
  private oauthClient: OAuthApiClient | null = null;
  /** Parents connus par identifiant de dossier (cache mémoire borné). */
  private readonly parentsCache = new Map<string, string[]>();

  constructor(private readonly ctx: ConnectorContext) {
    this.config = configSchema.parse(ctx.config);
    const globalAllowed = new Set(ctx.limits.allowedExtensions.map((e) => e.toLowerCase()));
    // La config ne peut que restreindre la liste globale, jamais l'élargir.
    this.allowed = this.config.extensions
      ? new Set(this.config.extensions.filter((e) => globalAllowed.has(e)))
      : globalAllowed;
  }

  /** Client d'API, créé à la demande ; refuse net une source non autorisée (aucun jeton). */
  private client(): OAuthApiClient {
    if (!this.ctx.credentials?.refreshToken) {
      throw new ConnectorAuthError(
        "non autorisé : autorisez d'abord l'accès à Google Drive (bouton d'autorisation).",
        true,
      );
    }
    if (!this.oauthClient) {
      const deps = this.ctx.deps;
      this.oauthClient =
        deps.oauth ??
        createOAuthApiClient({
          provider: 'google',
          credentials: this.ctx.credentials,
          env: deps.env ?? process.env,
          scopes: GOOGLE_DRIVE_SCOPES,
          http: deps.http,
          now: deps.now,
          onCredentialsChanged: deps.onCredentialsChanged,
        });
    }
    return this.oauthClient;
  }

  async authenticate(): Promise<void> {
    await this.client().authenticate();
  }

  private url(path: string, params: Record<string, string | number | boolean | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    return `${API_BASE}/${path}?${qs.toString()}`;
  }

  private get sharedScope(): boolean {
    return Boolean(this.config.driveId) || this.config.includeSharedDrives;
  }

  // -------------------------------------------------------------------------
  // Listage
  // -------------------------------------------------------------------------

  async listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage> {
    const pageSize = Math.min(1000, Math.max(1, Math.floor(opts.pageSize)));
    const token = since === null ? null : parseToken(since);
    const oauth = this.client();
    try {
      if (token === null || token.p === 'full') {
        return await this.listFull(oauth, token, pageSize, opts.signal);
      }
      return await this.listChangesPhase(oauth, token.t, pageSize, opts.signal);
    } catch (e) {
      throw this.mapListError(e);
    }
  }

  private mapListError(e: unknown): unknown {
    if (e instanceof OAuthApiError) {
      if (e.status === 400) {
        return new Error(
          'Google Drive a refusé la requête de listage (jeton de changement périmé ou configuration ' +
            'invalide) : réinitialisez le jeton pour relister le Drive.',
        );
      }
      if (e.status === 404) {
        return new Error(
          'Drive partagé ou dossier introuvable, ou inaccessible avec cette autorisation : vérifiez la configuration.',
        );
      }
    }
    return e; // ConnectorAuthError / ConnectorQuotaError et autres : inchangés
  }

  private async listFull(
    oauth: OAuthApiClient,
    token: { t?: string; s: string } | null,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<ChangePage> {
    let startToken = token?.s;
    if (!startToken) {
      const res = await oauth.getJson<{ startPageToken?: string }>(
        this.url('changes/startPageToken', {
          supportsAllDrives: true,
          driveId: this.config.driveId,
        }),
        { signal },
      );
      const s = pageToken(res?.startPageToken);
      if (!s) throw new Error('Google Drive n\'a pas fourni de jeton de départ des changements.');
      startToken = s;
    }

    const corpora = this.config.driveId ? 'drive' : this.config.includeSharedDrives ? 'allDrives' : 'user';
    const res = await oauth.getJson<FilesListResponse>(
      this.url('files', {
        q: 'trashed=false',
        corpora,
        driveId: this.config.driveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize,
        orderBy: 'modifiedTime',
        pageToken: token?.t,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      }),
      { signal },
    );

    const { items, deleted } = await this.convert(res.files ?? [], signal, oauth);
    const next = pageToken(res.nextPageToken);
    if (next) {
      const t: Token = { p: 'full', t: next, s: startToken };
      return { items, deletedExternalIds: deleted, nextToken: JSON.stringify(t), hasMore: true };
    }
    const done: Token = { p: 'chg', t: startToken };
    return { items, deletedExternalIds: deleted, nextToken: JSON.stringify(done), hasMore: false };
  }

  private async listChangesPhase(
    oauth: OAuthApiClient,
    page: string,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<ChangePage> {
    const res = await oauth.getJson<ChangesListResponse>(
      this.url('changes', {
        pageToken: page,
        includeRemoved: true,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        driveId: this.config.driveId,
        restrictToMyDrive: this.sharedScope ? undefined : true,
        pageSize,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      }),
      { signal },
    );

    const files: DriveFile[] = [];
    const removed = new Set<string>();
    for (const ch of res.changes ?? []) {
      const id = ch.file?.id ?? ch.fileId;
      if (!isDriveId(id)) continue;
      if (ch.removed || ch.file?.trashed) {
        removed.add(id);
      } else if (ch.file) {
        files.push({ ...ch.file, id });
      }
    }
    const { items, deleted } = await this.convert(files, signal, oauth);
    for (const id of deleted) removed.add(id);

    const next = pageToken(res.nextPageToken);
    if (next) {
      const t: Token = { p: 'chg', t: next };
      return { items, deletedExternalIds: [...removed], nextToken: JSON.stringify(t), hasMore: true };
    }
    const fresh = pageToken(res.newStartPageToken);
    if (!fresh) throw new Error('Google Drive n\'a fourni ni page suivante ni nouveau jeton de changements.');
    const t: Token = { p: 'chg', t: fresh };
    return { items, deletedExternalIds: [...removed], nextToken: JSON.stringify(t), hasMore: false };
  }

  /** Fichiers Drive → éléments retenus + suppressions (fichiers mis à la corbeille). */
  private async convert(
    files: DriveFile[],
    signal: AbortSignal | undefined,
    oauth: OAuthApiClient,
  ): Promise<{ items: RemoteItem[]; deleted: string[] }> {
    const items: RemoteItem[] = [];
    const deleted: string[] = [];
    for (const f of files) {
      if (!isDriveId(f.id)) continue;
      if (f.mimeType === FOLDER_MIME) {
        // Les dossiers ne sont pas des documents, mais leurs parents nourrissent le cache.
        this.rememberParents(f.id, f.parents);
        continue;
      }
      if (f.trashed) {
        deleted.push(f.id);
        continue;
      }
      // « Mon Drive » seul : on ignore ce qui appartient à un drive partagé.
      if (!this.sharedScope && f.driveId) continue;
      const item = this.toRemoteItem(f);
      if (!item) continue;
      if (this.config.folderId && !(await this.isInScope(f.parents, signal, oauth))) continue;
      items.push(item);
    }
    return { items, deleted };
  }

  private toRemoteItem(f: DriveFile): RemoteItem | null {
    const id = f.id as string;
    const mime = f.mimeType ?? '';
    const baseName = (f.name ?? '').trim() || id;
    const native = mime.startsWith(GOOGLE_APPS_PREFIX);
    let name = baseName;
    let mimeType = mime || undefined;
    let remoteVersion: string;
    let byteLength: number | undefined;

    if (native) {
      const exp = NATIVE_EXPORTS[mime]?.[this.config.exportFormat];
      if (!exp) return null; // dossier, raccourci, formulaire… non exportable
      name = baseName.toLowerCase().endsWith(exp.ext) ? baseName : `${baseName}${exp.ext}`;
      mimeType = exp.mimeType;
      remoteVersion = `${f.modifiedTime ?? ''}:${f.version ?? ''}`;
    } else {
      const size = f.size === undefined ? NaN : Number(f.size);
      byteLength = Number.isFinite(size) && size >= 0 ? size : undefined;
      remoteVersion = f.md5Checksum ?? f.headRevisionId ?? `v${f.version ?? ''}:${f.modifiedTime ?? ''}`;
    }

    // Hors liste d'extensions : ignoré au listage.
    if (!this.allowed.has(extensionOf(name))) return null;

    const owner = f.owners?.[0];
    const item: RemoteItem = {
      externalId: id,
      name,
      originUrl: f.webViewLink,
      mimeType,
      originAuthor: owner?.displayName || owner?.emailAddress || undefined,
      originCreatedAt: parseDate(f.createdTime),
      originModifiedAt: parseDate(f.modifiedTime),
      remoteVersion,
      originMetadata: { driveId: f.driveId ?? null, mimeType: mime, exported: native },
    };
    if (byteLength !== undefined) item.byteLength = byteLength;
    return item;
  }

  // -------------------------------------------------------------------------
  // Restriction à un dossier
  // -------------------------------------------------------------------------

  private rememberParents(id: string, parents: string[] | undefined): void {
    if (this.parentsCache.size >= MAX_PARENT_CACHE) this.parentsCache.clear();
    this.parentsCache.set(id, (parents ?? []).filter(isDriveId));
  }

  private async parentsOf(
    id: string,
    signal: AbortSignal | undefined,
    oauth: OAuthApiClient,
  ): Promise<string[]> {
    const cached = this.parentsCache.get(id);
    if (cached) return cached;
    try {
      const res = await oauth.getJson<{ parents?: string[] }>(
        this.url(`files/${encodeURIComponent(id)}`, { fields: 'id,parents', supportsAllDrives: true }),
        { signal },
      );
      this.rememberParents(id, res?.parents);
    } catch (e) {
      // Parent supprimé ou inaccessible : la chaîne s'arrête là (hors dossier, prudence).
      if (e instanceof OAuthApiError && (e.status === 403 || e.status === 404)) {
        this.rememberParents(id, []);
      } else {
        throw e;
      }
    }
    return this.parentsCache.get(id) ?? [];
  }

  /** `true` si l'un des ancêtres est le dossier configuré (profondeur bornée, jamais de boucle). */
  private async isInScope(
    parents: string[] | undefined,
    signal: AbortSignal | undefined,
    oauth: OAuthApiClient,
  ): Promise<boolean> {
    const target = this.config.folderId as string;
    const visited = new Set<string>();
    let level = (parents ?? []).filter(isDriveId);
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH && level.length > 0; depth++) {
      if (level.includes(target)) return true;
      const next: string[] = [];
      for (const id of level) {
        if (visited.has(id)) continue;
        visited.add(id);
        if (depth < MAX_FOLDER_DEPTH) next.push(...(await this.parentsOf(id, signal, oauth)));
      }
      level = next;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Contenu
  // -------------------------------------------------------------------------

  async fetchFile(item: RemoteItem): Promise<FetchedFile> {
    if (!isDriveId(item.externalId)) {
      throw new ConnectorItemRejectedError('Identifiant de fichier Drive invalide.');
    }
    const ext = extensionOf(item.name);
    if (!this.allowed.has(ext)) {
      throw new ConnectorItemRejectedError(`Type de fichier non autorisé (${ext || 'sans extension'}).`);
    }
    const max = this.ctx.limits.maxFileBytes;
    if (item.byteLength !== undefined && item.byteLength > max) {
      throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${max} octets).`);
    }

    const meta = item.originMetadata ?? {};
    const exported = meta.exported === true;
    const id = encodeURIComponent(item.externalId);
    let url: string;
    if (exported) {
      const source = typeof meta.mimeType === 'string' ? meta.mimeType : '';
      const targets = NATIVE_EXPORTS[source];
      const target = targets && [targets.pdf, targets.office].find((t) => t.mimeType === item.mimeType);
      if (!target) {
        throw new ConnectorItemRejectedError("Format d'export Google non pris en charge pour ce fichier.");
      }
      url = this.url(`files/${id}/export`, { mimeType: target.mimeType });
    } else {
      url = this.url(`files/${id}`, { alt: 'media', supportsAllDrives: true });
    }

    const oauth = this.client();
    try {
      const { bytes, contentType } = await oauth.getBytes(url, { maxBytes: max });
      if (bytes.length > max) {
        throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${max} octets).`);
      }
      return { bytes, name: item.name, mimeType: item.mimeType ?? contentType };
    } catch (e) {
      if (e instanceof OAuthApiError) {
        if (e.status === 403 && e.reason === 'exportSizeLimitExceeded') {
          throw new ConnectorItemRejectedError(
            "Export Google trop volumineux (limite de 10 Mo imposée par Google pour les fichiers natifs).",
          );
        }
        if (e.status === 404) {
          throw new ConnectorItemRejectedError("Le fichier n'existe plus à la source.");
        }
        if (e.status === 403) {
          throw new ConnectorItemRejectedError('Accès refusé à ce fichier par Google Drive.');
        }
      }
      throw e; // ConnectorQuotaError, ConnectorAuthError, ConnectorItemRejectedError…
    }
  }

  // -------------------------------------------------------------------------
  // Droits d'origine
  // -------------------------------------------------------------------------

  async readOriginAcl(item: RemoteItem): Promise<OriginAcl | null> {
    if (!isDriveId(item.externalId)) return null;
    const oauth = this.client();
    const id = encodeURIComponent(item.externalId);
    const entries: OriginAclEntry[] = [];
    try {
      let pageTok: string | undefined;
      for (let page = 0; page < MAX_PERMISSION_PAGES; page++) {
        const res = await oauth.getJson<PermissionsResponse>(
          this.url(`files/${id}/permissions`, {
            supportsAllDrives: true,
            fields: 'permissions(id,type,role,emailAddress,domain,deleted),nextPageToken',
            pageSize: 100,
            pageToken: pageTok,
          }),
        );
        for (const p of res.permissions ?? []) {
          if (p.deleted) continue;
          entries.push(mapPermission(p));
        }
        const next = pageToken(res.nextPageToken);
        if (!next) return { entries };
        pageTok = next;
      }
      // Liste tronquée au-delà de la borne : on la déclare illisible plutôt que partielle.
      return null;
    } catch (e) {
      if (e instanceof ConnectorAuthError || e instanceof ConnectorQuotaError) throw e;
      return null; // 403/404/autre : droits illisibles, le mapping retombera sur le repli
    }
  }

  // findMissing : volontairement absent, les suppressions viennent du journal des changements.

  async close(): Promise<void> {
    this.parentsCache.clear();
  }
}

function mapRole(role: string | undefined): OriginAclEntry['access'] {
  switch (role) {
    case 'owner':
      return 'owner';
    case 'writer':
    case 'fileOrganizer':
    case 'organizer':
      return 'write';
    case 'reader':
    case 'commenter':
      return 'read';
    default:
      return 'unknown';
  }
}

function mapPermission(p: NonNullable<PermissionsResponse['permissions']>[number]): OriginAclEntry {
  const access = mapRole(p.role);
  const email = p.emailAddress?.trim().toLowerCase();
  switch (p.type) {
    case 'user':
      return email
        ? { principal: email, kind: 'user', access }
        : { principal: p.id ?? 'user', kind: 'unknown', access };
    case 'group':
      return email
        ? { principal: email, kind: 'group', access }
        : { principal: p.id ?? 'group', kind: 'unknown', access };
    case 'domain':
      return { principal: p.domain ?? 'domain', kind: 'public', access };
    case 'anyone':
      return { principal: 'anyone', kind: 'public', access };
    default:
      return { principal: p.id ?? p.type ?? 'inconnu', kind: 'unknown', access };
  }
}

export const googleDriveConnector: ConnectorDefinition = {
  type: GOOGLE_DRIVE_CONNECTOR_TYPE,
  label: 'Google Drive',
  description:
    'Reprend les fichiers de Google Drive (Mon Drive ou un drive partagé) en lecture seule. ' +
    "L'accès s'autorise par le bouton Google ; rien n'est jamais modifié ni supprimé dans le Drive. " +
    'Les Docs, Sheets et Slides sont exportés en PDF ou en format bureautique.',
  supportedModes: [GedSourceMode.Copie, GedSourceMode.IndexationEnPlace, GedSourceMode.Synchro],
  configFields: [
    {
      name: 'driveId',
      label: 'Drive partagé (identifiant)',
      kind: 'text',
      required: false,
      help: 'Identifiant d\'un drive partagé. Vide = « Mon Drive ».',
    },
    {
      name: 'includeSharedDrives',
      label: 'Inclure les drives partagés',
      kind: 'boolean',
      required: false,
      help: 'Sans identifiant de drive partagé : inclut aussi les drives partagés accessibles.',
    },
    {
      name: 'folderId',
      label: 'Dossier (identifiant)',
      kind: 'text',
      required: false,
      help: 'Restreint la reprise à ce dossier et à ses sous-dossiers (20 niveaux au plus).',
    },
    {
      name: 'exportFormat',
      label: "Format d'export des Docs, Sheets et Slides",
      kind: 'text',
      required: false,
      help: '« pdf » (défaut) ou « office » (docx, xlsx, pptx). Les dessins sont toujours exportés en PDF.',
      placeholder: 'pdf',
    },
    {
      name: 'extensions',
      label: 'Extensions retenues',
      kind: 'textarea',
      required: false,
      help: 'Sous-ensemble des extensions autorisées (ex. .pdf, .docx). Vide = toutes les autorisées.',
    },
  ],
  // Pas de saisie : l'autorisation passe par le bouton OAuth.
  credentialFields: [],
  configSchema,
  credentialsSchema,
  oauth: { provider: 'google', scopes: GOOGLE_DRIVE_SCOPES },
  async assertConfigSafe(config: unknown): Promise<void> {
    // Aucun hôte configurable : la validation du schéma (identifiants Drive) suffit.
    configSchema.parse(config);
  },
  create(ctx: ConnectorContext): SourceConnector {
    return new GoogleDriveConnector(ctx);
  },
};
