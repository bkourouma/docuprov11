// Socle commun des connecteurs Microsoft 365 (lecture seule, Microsoft Graph) : OneDrive, SharePoint,
// Outlook. Contient le jeton de changement (delta Graph), le mapping DriveItem -> RemoteItem, le
// mapping des droits d'origine, les validations de configuration et le moteur de delta d'une
// bibliothèque de documents (partagé par OneDrive et SharePoint).
//
// Sécurité : les URL d'appel sont toujours construites ici, sur l'hôte unique `GRAPH_BASE`. Les
// `@odata.nextLink` / `@odata.deltaLink` (réponses de Graph, ou jeton relu en base) ne sont suivis
// qu'après vérification du préfixe `GRAPH_BASE/` : le client OAuth valide déjà l'hôte, ceci est une
// seconde barrière. Aucun message d'erreur ne cite d'URL ni de jeton.
import { z } from 'zod';
import { extensionOf } from '../limits';
import { createOAuthApiClient } from '../oauth-session';
import {
  OAuthApiError,
  type OAuthApiClient,
  type OAuthRequestOptions,
} from '../oauth-contract';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  ConnectorQuotaError,
  type ChangePage,
  type ConnectorContext,
  type FetchedFile,
  type ListChangesOptions,
  type OriginAcl,
  type OriginAclEntry,
  type RemoteItem,
  type SourceConnector,
} from '../types';

/** Hôte et version uniques des appels d'API. */
export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** Longueur maximale de `external_id` en base. */
const EXTERNAL_ID_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// Schémas de configuration et d'identifiants
// ---------------------------------------------------------------------------

/** Identifiants OAuth : le jeton de rafraîchissement est posé par le bouton d'autorisation. */
export const graphCredentialsSchema = z
  .object({
    refreshToken: z.string().min(1).max(16_384),
    scope: z.string().max(4096).optional(),
  })
  .strict() as unknown as z.ZodType<Record<string, string>>;

/** Extensions facultatives (avec ou sans point) : ne servent qu'à RESTREINDRE la liste globale. */
export const extensionsConfigSchema = z
  .array(z.string().trim().regex(/^\.?[A-Za-z0-9]{1,10}$/, 'extension invalide'))
  .min(1)
  .max(30);

/** Chemin de dossier à filtrer (côté client). Sans caractère de contrôle. */
export const folderPathConfigSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]+$/, 'caractères interdits');

/** Extensions retenues : celles de `limits` (liste globale déjà resserrée), intersectées avec la config. */
export function resolveAllowedExtensions(
  limitsExtensions: readonly string[],
  configured?: readonly string[],
): Set<string> {
  const base = new Set(limitsExtensions.map((e) => e.toLowerCase()));
  if (!configured) return base;
  const wanted = configured.map((e) => {
    const lower = e.trim().toLowerCase();
    return lower.startsWith('.') ? lower : `.${lower}`;
  });
  return new Set(wanted.filter((e) => base.has(e)));
}

/** `/a/b/` ou `a/b` -> `/a/b` (`/` = tout). Comparaison faite en minuscules par `isInFolder`. */
export function normalizeFolderPath(p: string): string {
  const trimmed = p.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  if (trimmed === '') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// ---------------------------------------------------------------------------
// URL et jeton de changement
// ---------------------------------------------------------------------------

/** `true` si l'URL est un appel Graph v1.0 (préfixe exact, donc hôte exact). */
export function isGraphUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(`${GRAPH_BASE}/`);
}

/** Erreur de jeton de changement : message fixe, jamais l'URL. */
function invalidToken(reason: string): Error {
  return new Error(
    `Jeton de changement invalide (${reason}) : réinitialisez-le pour relister la source.`,
  );
}

/** Lève si `url` n'est pas un appel Graph v1.0. Sans citer l'URL. */
export function assertGraphUrl(url: unknown, reason = 'adresse hors de Microsoft Graph'): asserts url is string {
  if (!isGraphUrl(url)) throw invalidToken(reason);
}

export interface DeltaToken {
  /** `next` : page suivante du parcours en cours ; `delta` : parcours terminé, base du prochain. */
  k: 'next' | 'delta';
  u: string;
}

export function encodeDeltaToken(token: DeltaToken): string {
  return JSON.stringify({ k: token.k, u: token.u });
}

/** Décode un jeton relu en base. Pas de relistage silencieux : un jeton illisible lève. */
export function parseDeltaToken(raw: string): DeltaToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidToken('illisible');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidToken('illisible');
  }
  const { k, u } = parsed as { k?: unknown; u?: unknown };
  if ((k !== 'next' && k !== 'delta') || typeof u !== 'string') throw invalidToken('illisible');
  assertGraphUrl(u);
  return { k, u };
}

interface DeltaResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

export interface DeltaPage<T> {
  value: T[];
  nextToken: string;
  hasMore: boolean;
}

/**
 * Lit UNE page de delta Graph. `since` null = premier appel sur `firstUrl`. Graph 410 (jeton de delta
 * expiré, `resyncRequired`) = erreur explicite : pas de relistage silencieux. Le quota
 * (`ConnectorQuotaError`) et l'autorisation (`ConnectorAuthError`) traversent sans conversion.
 */
export async function fetchDeltaPage<T>(
  oauth: OAuthApiClient,
  since: string | null,
  firstUrl: string,
  pageSize: number,
  signal?: AbortSignal,
): Promise<DeltaPage<T>> {
  const token = since === null ? null : parseDeltaToken(since);
  const url = token ? token.u : firstUrl;
  const size = Math.max(1, Math.floor(pageSize));
  const opts: OAuthRequestOptions = {
    headers: { Prefer: `odata.maxpagesize=${size}` },
    ...(signal ? { signal } : {}),
  };
  let body: DeltaResponse<T>;
  try {
    body = await oauth.getJson<DeltaResponse<T>>(url, opts);
  } catch (e) {
    if (token && e instanceof OAuthApiError && e.status === 410) {
      throw new Error(
        'Jeton de changement expiré : Microsoft Graph demande une resynchronisation complète. ' +
          'Réinitialisez le jeton de changement du connecteur pour relister la source.',
      );
    }
    throw e;
  }
  const value = Array.isArray(body?.value) ? body.value : [];
  const nextLink = body?.['@odata.nextLink'];
  const deltaLink = body?.['@odata.deltaLink'];
  if (nextLink !== undefined && nextLink !== null) {
    assertGraphUrl(nextLink, 'lien de page hors de Microsoft Graph');
    return { value, nextToken: encodeDeltaToken({ k: 'next', u: nextLink }), hasMore: true };
  }
  if (deltaLink !== undefined && deltaLink !== null) {
    assertGraphUrl(deltaLink, 'lien de suivi hors de Microsoft Graph');
    return { value, nextToken: encodeDeltaToken({ k: 'delta', u: deltaLink }), hasMore: false };
  }
  throw new Error('Réponse Microsoft Graph inattendue : aucun lien de suite ni de suivi.');
}

/** Segment d'URL encodé. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

// ---------------------------------------------------------------------------
// Base commune des connecteurs : client OAuth paresseux, authentification
// ---------------------------------------------------------------------------

export abstract class GraphConnectorBase implements SourceConnector {
  abstract readonly type: string;
  private oauthClient: OAuthApiClient | null = null;

  constructor(
    protected readonly ctx: ConnectorContext,
    private readonly scopes: readonly string[],
  ) {}

  /** Client d'API : injecté (tests) ou créé au premier usage (une configuration OAuth absente se voit alors à l'authentification). */
  protected get oauth(): OAuthApiClient {
    if (!this.oauthClient) {
      this.oauthClient =
        this.ctx.deps.oauth ??
        createOAuthApiClient({
          provider: 'microsoft',
          credentials: this.ctx.credentials,
          env: this.ctx.deps.env ?? process.env,
          scopes: this.scopes,
          http: this.ctx.deps.http,
          now: this.ctx.deps.now,
          onCredentialsChanged: this.ctx.deps.onCredentialsChanged,
        });
    }
    return this.oauthClient;
  }

  async authenticate(): Promise<void> {
    const refresh = this.ctx.credentials?.refreshToken;
    if (typeof refresh !== 'string' || refresh === '') {
      throw new ConnectorAuthError(
        "Connecteur non autorisé : lancez l'autorisation Microsoft depuis l'écran d'administration.",
        true,
      );
    }
    await this.oauth.authenticate();
  }

  abstract listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage>;
  abstract fetchFile(item: RemoteItem): Promise<FetchedFile>;
  abstract readOriginAcl(item: RemoteItem): Promise<OriginAcl | null>;

  async close(): Promise<void> {
    // Aucune connexion persistante : rien à fermer.
  }
}

// ---------------------------------------------------------------------------
// Bibliothèque de documents : DriveItem -> RemoteItem
// ---------------------------------------------------------------------------

export interface GraphIdentity {
  displayName?: string;
  email?: string;
  id?: string;
  loginName?: string;
}
export interface GraphIdentitySet {
  user?: GraphIdentity;
  group?: GraphIdentity;
  siteUser?: GraphIdentity;
  siteGroup?: GraphIdentity;
  application?: GraphIdentity;
  device?: GraphIdentity;
}
export interface GraphDriveItem {
  id?: string;
  name?: string;
  size?: number;
  webUrl?: string;
  cTag?: string;
  eTag?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  createdBy?: GraphIdentitySet;
  parentReference?: { driveId?: string; path?: string; id?: string };
  file?: { mimeType?: string; hashes?: { sha256Hash?: string; sha1Hash?: string; quickXorHash?: string } };
  folder?: unknown;
  deleted?: unknown;
}

const DRIVE_ID_PATTERN = /^[A-Za-z0-9!_.-]{1,200}$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9!_.-]{1,200}$/;

export function buildDriveExternalId(driveId: string, itemId: string): string {
  return `${driveId}:${itemId}`;
}

/** `<driveId>:<itemId>` -> parties validées, ou `null`. */
export function parseDriveExternalId(id: string): { driveId: string; itemId: string } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const driveId = id.slice(0, i);
  const itemId = id.slice(i + 1);
  if (!DRIVE_ID_PATTERN.test(driveId) || !ITEM_ID_PATTERN.test(itemId)) return null;
  return { driveId, itemId };
}

/** `/drive/root:/Docs/Finance` ou `/drives/ID/root:/Docs` -> `/Docs/Finance` (`/` = racine). */
export function cleanDrivePath(path: string | undefined): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined;
  let s = path;
  const m = /^\/drive(?:s\/[^/]+)?\/root:?/.exec(s);
  if (m) s = s.slice(m[0].length);
  try {
    s = decodeURIComponent(s);
  } catch {
    // chemin non encodé : conservé tel quel
  }
  s = s.replace(/\/+$/, '');
  if (s === '') return '/';
  return s.startsWith('/') ? s : `/${s}`;
}

/** `path` est `folder` ou sous `folder` (insensible à la casse, comme OneDrive/SharePoint). */
export function isInFolder(path: string, folder: string): boolean {
  if (folder === '/') return true;
  const p = path.toLowerCase();
  const f = folder.toLowerCase();
  return p === f || p.startsWith(`${f}/`);
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export interface MapDriveItemContext {
  /** Lecteur de bibliothèque déjà résolu pour cet élément. */
  driveId: string;
  allowed: ReadonlySet<string>;
  /** Dossier normalisé (`/a/b`), ou `undefined` = toute la bibliothèque. */
  folderPath?: string;
  /** Métadonnées propres au connecteur (siteId pour SharePoint). */
  extraMetadata?: Record<string, unknown>;
}

export type MappedDriveItem = { deleted: string } | { item: RemoteItem } | null;

/**
 * Un élément de delta : suppression, fichier à retenir, ou `null` (ignoré : dossier, non-fichier,
 * hors dossier filtré, extension non autorisée). Un fichier trop gros est RENVOYÉ : `fetchFile` le
 * refuse, ce qui le met « en erreur » avec un motif lisible au lieu de le faire disparaître.
 */
export function mapDriveItem(raw: GraphDriveItem, mctx: MapDriveItemContext): MappedDriveItem {
  if (typeof raw.id !== 'string' || !ITEM_ID_PATTERN.test(raw.id)) return null;
  const externalId = buildDriveExternalId(mctx.driveId, raw.id);
  if (raw.deleted !== undefined && raw.deleted !== null) return { deleted: externalId };
  if (raw.folder !== undefined && raw.folder !== null) return null;
  if (raw.file === undefined || raw.file === null) return null;
  if (externalId.length > EXTERNAL_ID_MAX_LENGTH) return null;
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (name === '' || !mctx.allowed.has(extensionOf(name))) return null;

  const path = cleanDrivePath(raw.parentReference?.path);
  if (mctx.folderPath !== undefined && mctx.folderPath !== '/') {
    // Chemin absent (certains deltas l'omettent) : on ne peut pas prouver que l'élément est dans le
    // dossier demandé, on l'écarte par prudence.
    if (path === undefined || !isInFolder(path, mctx.folderPath)) return null;
  }

  const hashes = raw.file.hashes;
  const version =
    hashes?.sha256Hash || hashes?.sha1Hash || hashes?.quickXorHash || raw.cTag || raw.eTag || undefined;
  const author = raw.createdBy?.user?.displayName || raw.createdBy?.user?.email || undefined;
  const item: RemoteItem = {
    externalId,
    name,
    originUrl: typeof raw.webUrl === 'string' ? raw.webUrl : undefined,
    originPath: path,
    mimeType: raw.file.mimeType,
    byteLength: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : undefined,
    originAuthor: author,
    originCreatedAt: parseDate(raw.createdDateTime),
    originModifiedAt: parseDate(raw.lastModifiedDateTime),
    remoteVersion: version,
    originMetadata: { driveId: mctx.driveId, ...(mctx.extraMetadata ?? {}) },
  };
  return { item };
}

// ---------------------------------------------------------------------------
// Droits d'origine (permissions Graph)
// ---------------------------------------------------------------------------

export interface GraphPermission {
  roles?: string[];
  grantedToV2?: GraphIdentitySet;
  grantedTo?: GraphIdentitySet;
  grantedToIdentitiesV2?: GraphIdentitySet[];
  grantedToIdentities?: GraphIdentitySet[];
  link?: { scope?: string; type?: string };
}

const WRITE_ROLES = new Set(['write', 'edit', 'contribute', 'sp.full control', 'sp.edit', 'sp.contribute']);
const READ_ROLES = new Set(['read', 'view', 'sp.read', 'sp.view only']);

/** Meilleur accès des rôles (owner > write > read), `unknown` pour tout le reste. */
export function accessFromRoles(roles: unknown): OriginAclEntry['access'] {
  const list = Array.isArray(roles)
    ? roles.filter((r): r is string => typeof r === 'string').map((r) => r.trim().toLowerCase())
    : [];
  if (list.includes('owner')) return 'owner';
  if (list.some((r) => WRITE_ROLES.has(r))) return 'write';
  if (list.some((r) => READ_ROLES.has(r))) return 'read';
  return 'unknown';
}

function userPrincipal(id: GraphIdentity | undefined): string | null {
  if (!id) return null;
  const email = typeof id.email === 'string' ? id.email.trim() : '';
  if (email) return email.toLowerCase();
  const uid = typeof id.id === 'string' ? id.id.trim() : '';
  return uid || null;
}

function groupPrincipal(id: GraphIdentity | undefined): string | null {
  const p = userPrincipal(id);
  if (p) return p;
  const name = typeof id?.displayName === 'string' ? id.displayName.trim() : '';
  return name || null;
}

function entriesOfIdentitySet(set: GraphIdentitySet | undefined, access: OriginAclEntry['access']): OriginAclEntry[] {
  if (!set || typeof set !== 'object') return [];
  const out: OriginAclEntry[] = [];
  for (const [id, kind] of [
    [set.user, 'user'],
    [set.siteUser, 'user'],
    [set.group, 'group'],
    [set.siteGroup, 'group'],
  ] as const) {
    const principal = kind === 'user' ? userPrincipal(id) : groupPrincipal(id);
    if (principal) out.push({ principal, kind, access });
  }
  // `application` et `device` ne sont pas des personnes : ignorés.
  return out;
}

/**
 * Permissions Graph -> `OriginAcl`. Un lien `anonymous` ou `organization` devient une entrée
 * `public` (jamais mappée vers un groupe DocuPro, cf. rights.ts). Les liens à personnes précises
 * donnent une entrée par identité. Entrées dédoublonnées.
 */
export function mapGraphPermissions(permissions: readonly GraphPermission[]): OriginAcl {
  const seen = new Set<string>();
  const entries: OriginAclEntry[] = [];
  const push = (e: OriginAclEntry): void => {
    const key = `${e.kind}|${e.principal}|${e.access}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(e);
  };
  for (const perm of permissions) {
    if (!perm || typeof perm !== 'object') continue;
    const access = accessFromRoles(perm.roles);
    const scope = typeof perm.link?.scope === 'string' ? perm.link.scope.toLowerCase() : undefined;
    if (scope === 'anonymous' || scope === 'organization') {
      push({ principal: scope, kind: 'public', access });
      continue;
    }
    for (const e of entriesOfIdentitySet(perm.grantedToV2 ?? perm.grantedTo, access)) push(e);
    const many = perm.grantedToIdentitiesV2 ?? perm.grantedToIdentities;
    if (Array.isArray(many)) {
      for (const set of many) for (const e of entriesOfIdentitySet(set, access)) push(e);
    }
  }
  return { entries };
}

const MAX_PERMISSION_PAGES = 10;

/**
 * Droits d'un fichier. `null` si illisibles (403, 404, plus de 10 pages…) : le mapping retombera sur
 * le plus restrictif. L'autorisation et le quota se propagent.
 */
export async function readDriveItemAcl(oauth: OAuthApiClient, driveId: string, itemId: string): Promise<OriginAcl | null> {
  try {
    const all: GraphPermission[] = [];
    let url: string | undefined = `${GRAPH_BASE}/drives/${seg(driveId)}/items/${seg(itemId)}/permissions`;
    for (let page = 0; url; page++) {
      if (page >= MAX_PERMISSION_PAGES) return null; // liste incomplète : jamais d'ACL partielle
      const body: { value?: GraphPermission[]; '@odata.nextLink'?: string } = await oauth.getJson(url);
      if (Array.isArray(body?.value)) all.push(...body.value);
      const next: unknown = body?.['@odata.nextLink'];
      if (next === undefined || next === null) url = undefined;
      else if (isGraphUrl(next)) url = next;
      else return null;
    }
    return mapGraphPermissions(all);
  } catch (e) {
    if (e instanceof ConnectorAuthError || e instanceof ConnectorQuotaError) throw e;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Moteur de delta d'une bibliothèque de documents (OneDrive, SharePoint)
// ---------------------------------------------------------------------------

export interface DriveLibraryOptions {
  /** Résout (une fois, mis en cache) le lecteur à lister. */
  resolveDrive: (oauth: OAuthApiClient) => Promise<{ driveId: string; extraMetadata?: Record<string, unknown> }>;
  /**
   * URL du premier appel de delta : fixe (OneDrive : `/me/drive/root/delta`, le lecteur n'est alors
   * résolu que si un élément n'indique pas le sien) ou calculée depuis le lecteur résolu.
   */
  firstDeltaUrl: string | ((driveId: string) => string);
  /** `true` : le lecteur est toujours résolu avant le listage (SharePoint : siteId dans les métadonnées). */
  eagerDrive?: boolean;
  folderPath?: string;
  extensions?: readonly string[];
}

export class DriveLibraryConnector extends GraphConnectorBase {
  readonly type: string;
  private readonly allowed: Set<string>;
  private readonly folderPath: string | undefined;
  private drive: Promise<{ driveId: string; extraMetadata?: Record<string, unknown> }> | null = null;

  constructor(
    type: string,
    ctx: ConnectorContext,
    scopes: readonly string[],
    private readonly options: DriveLibraryOptions,
  ) {
    super(ctx, scopes);
    this.type = type;
    this.allowed = resolveAllowedExtensions(ctx.limits.allowedExtensions, options.extensions);
    this.folderPath = options.folderPath === undefined ? undefined : normalizeFolderPath(options.folderPath);
  }

  /** Lecteur résolu, mis en cache ; une résolution en échec n'est pas mémorisée. */
  private getDrive(): Promise<{ driveId: string; extraMetadata?: Record<string, unknown> }> {
    if (!this.drive) {
      this.drive = this.options.resolveDrive(this.oauth).catch((e: unknown) => {
        this.drive = null;
        throw e;
      });
    }
    return this.drive;
  }

  async listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage> {
    // Le jeton est validé AVANT toute résolution réseau.
    if (since !== null) parseDeltaToken(since);
    const first = this.options.firstDeltaUrl;
    let drive: { driveId: string; extraMetadata?: Record<string, unknown> } | null = null;
    if (this.options.eagerDrive || (typeof first === 'function' && since === null)) {
      drive = await this.getDrive();
    }
    const firstUrl = typeof first === 'string' ? first : first((drive as { driveId: string }).driveId);
    const page = await fetchDeltaPage<GraphDriveItem>(this.oauth, since, firstUrl, opts.pageSize, opts.signal);
    const items: RemoteItem[] = [];
    const deleted: string[] = [];
    for (const raw of page.value) {
      if (!raw || typeof raw !== 'object') continue;
      const rawDriveId = raw.parentReference?.driveId;
      let driveId: string;
      if (typeof rawDriveId === 'string' && DRIVE_ID_PATTERN.test(rawDriveId)) driveId = rawDriveId;
      else {
        drive = drive ?? (await this.getDrive());
        driveId = drive.driveId;
      }
      const mapped = mapDriveItem(raw, {
        driveId,
        allowed: this.allowed,
        folderPath: this.folderPath,
        extraMetadata: drive?.extraMetadata,
      });
      if (!mapped) continue;
      if ('deleted' in mapped) deleted.push(mapped.deleted);
      else items.push(mapped.item);
    }
    return { items, deletedExternalIds: deleted, nextToken: page.nextToken, hasMore: page.hasMore };
  }

  async fetchFile(item: RemoteItem): Promise<FetchedFile> {
    const ref = parseDriveExternalId(item.externalId);
    if (!ref) throw new ConnectorItemRejectedError('Identifiant de fichier invalide.');
    const ext = extensionOf(item.name);
    if (!this.allowed.has(ext)) {
      throw new ConnectorItemRejectedError(`Type de fichier non autorisé (${ext || 'sans extension'}).`);
    }
    const max = this.ctx.limits.maxFileBytes;
    if (typeof item.byteLength === 'number' && item.byteLength > max) {
      throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${max} octets).`);
    }
    try {
      const { bytes, contentType } = await this.oauth.getBytes(
        `${GRAPH_BASE}/drives/${seg(ref.driveId)}/items/${seg(ref.itemId)}/content`,
        { maxBytes: max, followDownloadRedirect: true },
      );
      if (bytes.length > max) {
        throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${max} octets).`);
      }
      return { bytes, name: item.name, mimeType: item.mimeType ?? contentType };
    } catch (e) {
      if (e instanceof OAuthApiError && (e.status === 404 || e.status === 410)) {
        throw new ConnectorItemRejectedError("Le fichier n'existe plus à la source.");
      }
      throw e;
    }
  }

  async readOriginAcl(item: RemoteItem): Promise<OriginAcl | null> {
    const ref = parseDriveExternalId(item.externalId);
    if (!ref) return null;
    return readDriveItemAcl(this.oauth, ref.driveId, ref.itemId);
  }
}
