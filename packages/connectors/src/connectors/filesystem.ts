import * as path from 'node:path';
import { z } from 'zod';
import { GedSourceMode } from '@archivage/types';
import { extensionOf } from '../limits';
import {
  ConnectorAuthError,
  ConnectorItemRejectedError,
  type ChangePage,
  type ConnectorContext,
  type ConnectorDefinition,
  type ConnectorDeps,
  type FetchedFile,
  type FsEntry,
  type FsProvider,
  type ListChangesOptions,
  type OriginAcl,
  type OriginAclEntry,
  type RemoteItem,
  type SourceConnector,
} from '../types';
import { createDefaultFsProvider } from './fs-default';

export const FILESYSTEM_CONNECTOR_TYPE = 'filesystem';

/** Variable d'environnement : racines que l'exploitant autorise (séparées par `path.delimiter`). */
export const FS_ROOTS_ENV = 'GED_CONNECTOR_FS_ROOTS';

const configSchema = z
  .object({
    /** Chemin ABSOLU du dossier sur le serveur (typiquement un montage SFTP/SMB). */
    rootPath: z.string().trim().min(1).max(1000),
    recursive: z.boolean().default(true),
    /** Tant qu'un fichier a été modifié depuis moins de ce délai, il est jugé « en cours d'écriture ». */
    minAgeSeconds: z.number().int().min(0).max(86_400).default(30),
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
export type FilesystemConfig = z.infer<typeof configSchema>;

const credentialsSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Sécurité des chemins
// ---------------------------------------------------------------------------

function hasParentSegment(p: string): boolean {
  return p.split(/[\\/]+/).includes('..');
}

/** `child` est-il `parent` ou un descendant ? `path.relative` est insensible à la casse sous Windows. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function parseRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Refuse tout dossier hors des racines que l'exploitant a déclarées. Sans `GED_CONNECTOR_FS_ROOTS`
 * (absente ou vide), TOUT est refusé : un administrateur de la GED ne doit pas pouvoir faire lire au
 * serveur un dossier arbitraire (accès refusé par défaut). Le coffre `ARCHIVES_PATH` est exclu, ainsi
 * que ses parents et ses descendants : ingérer le coffre dans lui-même le dupliquerait à l'infini.
 */
export function assertFilesystemPathSafe(rootPath: string, env: NodeJS.ProcessEnv): void {
  if (rootPath.includes('\0'))
    throw new Error('Le chemin du dossier contient un caractère interdit.');
  if (!path.isAbsolute(rootPath)) {
    throw new Error('Le chemin du dossier doit être absolu (ex. /mnt/partage/scans).');
  }
  if (hasParentSegment(rootPath)) {
    throw new Error('Le chemin du dossier ne doit pas contenir « .. ».');
  }

  const roots = parseRoots(env[FS_ROOTS_ENV]);
  if (roots.length === 0) {
    throw new Error(
      `Aucun dossier n'est autorisé sur ce serveur : l'exploitant doit renseigner ${FS_ROOTS_ENV}.`,
    );
  }
  if (!roots.some((r) => path.isAbsolute(r) && isInside(rootPath, r))) {
    throw new Error("Ce dossier n'est pas dans les racines autorisées par l'exploitant.");
  }

  const archives = env.ARCHIVES_PATH?.trim();
  if (archives && (isInside(rootPath, archives) || isInside(archives, rootPath))) {
    throw new Error(
      'Ce dossier recouvre le coffre des archives (ARCHIVES_PATH) : choisissez un dossier distinct.',
    );
  }
}

/**
 * Chemin réel d'un chemin éventuellement inexistant : on remonte jusqu'au plus proche parent qui
 * existe, on le résout (liens suivis), puis on y recolle la partie non encore créée. Ainsi un lien
 * posé dans un dossier PARENT est vu même si la feuille n'existe pas encore. `null` si rien n'est
 * résolvable jusqu'à la racine du disque ; toute erreur autre que « absent » est propagée (on ne
 * devine pas : refus).
 */
async function realpathNearest(fs: FsProvider, target: string): Promise<string | null> {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length > 0 ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = errorCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    rest.push(path.basename(current));
    current = parent;
  }
}

/**
 * Validation sur les chemins RÉELS (liens symboliques résolus). La garde lexicale seule se contourne
 * par un lien posé sous une racine autorisée et pointant dehors (ou vers le coffre) : on refait donc
 * le test « est à l'intérieur de » et l'exclusion du coffre après `realpath`.
 *
 * - racine configurée : résolue via le plus proche parent existant (elle peut ne pas exister encore à
 *   l'enregistrement ; `authenticate` refait ce contrôle à chaque passe, car un lien peut être posé
 *   après coup) ;
 * - racines autorisées : chacune résolue ; une racine non résolvable est IGNORÉE (jamais autorisante) ;
 * - coffre : comparé sous sa forme lexicale normalisée ET sous sa forme réelle (plus proche parent
 *   existant) ; une erreur de résolution autre que « absent » refuse.
 * La comparaison passe par `isInside` (`path.relative`), insensible à la casse sous Windows.
 */
export async function assertFilesystemRealPathSafe(
  rootPath: string,
  env: NodeJS.ProcessEnv,
  fs: FsProvider,
): Promise<void> {
  // Garde lexicale d'abord : elle porte les messages précis (chemin relatif, « .. », aucune racine…).
  assertFilesystemPathSafe(rootPath, env);

  let realRoot: string | null;
  try {
    realRoot = await realpathNearest(fs, rootPath);
  } catch {
    throw new Error(
      'Le chemin réel du dossier ne peut pas être vérifié : dossier refusé par précaution.',
    );
  }
  if (!realRoot) {
    throw new Error(
      'Le chemin réel du dossier ne peut pas être résolu : dossier refusé par précaution.',
    );
  }

  const realAllowed: string[] = [];
  for (const r of parseRoots(env[FS_ROOTS_ENV])) {
    if (!path.isAbsolute(r)) continue;
    try {
      realAllowed.push(await fs.realpath(r));
    } catch {
      // Racine inexistante ou illisible : elle n'autorise rien.
    }
  }
  if (!realAllowed.some((r) => isInside(realRoot, r))) {
    throw new Error(
      "Ce dossier n'est pas dans les racines autorisées par l'exploitant (liens symboliques résolus).",
    );
  }

  const archives = env.ARCHIVES_PATH?.trim();
  if (archives) {
    const vaults = [path.resolve(archives)];
    try {
      const realVault = await realpathNearest(fs, archives);
      if (realVault) vaults.push(realVault);
    } catch {
      throw new Error(
        'Le chemin réel du coffre (ARCHIVES_PATH) ne peut pas être vérifié : dossier refusé.',
      );
    }
    if (vaults.some((v) => isInside(realRoot, v) || isInside(v, realRoot))) {
      throw new Error(
        'Ce dossier recouvre le coffre des archives (ARCHIVES_PATH) : choisissez un dossier distinct.',
      );
    }
  }
}

/** Identifiant externe → segments sûrs, ou `null` s'il n'a pas la forme d'un chemin relatif propre. */
function safeSegments(externalId: string): string[] | null {
  if (!externalId || externalId.includes('\0') || externalId.includes('\\')) return null;
  if (externalId.startsWith('/') || /^[a-zA-Z]:/.test(externalId)) return null;
  const segments = externalId.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments;
}

// ---------------------------------------------------------------------------
// Filtrage des entrées, types MIME
// ---------------------------------------------------------------------------

/** Dossiers de service du scan-agent : jamais ingérés. */
const SERVICE_DIRS = new Set(['_envoyes', '_erreurs']);
const TEMP_SUFFIXES = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.filepart'];

/** Fichier caché, temporaire (`~$`, `.tmp`…) ou dans un dossier de service / caché. */
export function isIgnoredName(relPath: string): boolean {
  const segments = relPath.split('/');
  const file = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  if (dirs.some((d) => d.startsWith('.') || SERVICE_DIRS.has(d.toLowerCase()))) return true;
  if (!file || file.startsWith('.') || file.startsWith('~$')) return true;
  const lower = file.toLowerCase();
  return TEMP_SUFFIXES.some((s) => lower.endsWith(s));
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.eml': 'message/rfc822',
  '.msg': 'application/vnd.ms-outlook',
};

export function mimeTypeForName(name: string): string | undefined {
  return MIME_BY_EXTENSION[extensionOf(name)];
}

// ---------------------------------------------------------------------------
// Curseur de changement
// ---------------------------------------------------------------------------

interface Cursor {
  /** mtime (ms) du dernier élément rendu. */
  m: number;
  /** chemin relatif du dernier élément rendu. */
  p: string;
}

function encodeCursor(c: Cursor): string {
  return JSON.stringify({ m: c.m, p: c.p });
}

/**
 * Jeton illisible : on LÈVE au lieu de relister en silence. Un relistage complet à chaque passe
 * (sur un jeton définitivement corrompu) saturerait la source sans que personne ne le voie ; l'erreur
 * remonte dans l'écran d'administration, où l'on peut réinitialiser le jeton volontairement.
 */
function decodeCursor(token: string): Cursor {
  try {
    const v: unknown = JSON.parse(token);
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Cursor).m === 'number' &&
      Number.isFinite((v as Cursor).m) &&
      typeof (v as Cursor).p === 'string'
    ) {
      return { m: (v as Cursor).m, p: (v as Cursor).p };
    }
  } catch {
    // tombe dans l'erreur ci-dessous
  }
  throw new Error(
    'Le jeton de changement du dossier surveillé est illisible : réinitialisez-le pour relister le dossier.',
  );
}

function compareEntries(a: { m: number; p: string }, b: { m: number; p: string }): number {
  if (a.m !== b.m) return a.m - b.m;
  return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Droits POSIX → droits d'origine
// ---------------------------------------------------------------------------

/** Métadonnées POSIX déposées dans `originMetadata` pour que `readOriginAcl` n'ait pas à relire le disque. */
interface PosixMeta {
  mode?: number;
  uid?: number;
  gid?: number;
}

function aclFromPosix(meta: PosixMeta): OriginAcl | null {
  if (typeof meta.mode !== 'number') return null; // SMB/Windows : droits inconnus
  const mode = meta.mode;
  const entries: OriginAclEntry[] = [];
  if (mode & 0o400) {
    entries.push({
      principal: typeof meta.uid === 'number' ? `uid:${meta.uid}` : 'owner',
      kind: 'user',
      access: mode & 0o200 ? 'write' : 'read',
    });
  }
  if (mode & 0o040) {
    entries.push({
      principal: typeof meta.gid === 'number' ? `gid:${meta.gid}` : 'group',
      kind: 'group',
      access: mode & 0o020 ? 'write' : 'read',
    });
  }
  // « Autres » lisible : exposé comme `public`, que rights.ts ne traduit jamais en accès général.
  if (mode & 0o004) entries.push({ principal: '*', kind: 'public', access: 'read' });
  return { entries };
}

// ---------------------------------------------------------------------------
// Connecteur
// ---------------------------------------------------------------------------

const IO_REJECTIONS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

function errorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined;
}

class FilesystemConnector implements SourceConnector {
  readonly type = FILESYSTEM_CONNECTOR_TYPE;
  private readonly config: FilesystemConfig;
  private readonly fs: FsProvider;
  private readonly allowedExtensions: Set<string>;
  private readonly rootAbs: string;

  constructor(private readonly ctx: ConnectorContext) {
    this.config = configSchema.parse(ctx.config);
    this.fs = ctx.deps.fs ?? createDefaultFsProvider();
    const globalAllowed = new Set(ctx.limits.allowedExtensions.map((e) => e.toLowerCase()));
    // La config ne peut que restreindre la liste globale, jamais l'élargir.
    this.allowedExtensions = this.config.extensions
      ? new Set(this.config.extensions.filter((e) => globalAllowed.has(e)))
      : globalAllowed;
    this.rootAbs = path.resolve(this.config.rootPath);
  }

  private now(): Date {
    return (this.ctx.deps.now ?? (() => new Date()))();
  }

  /**
   * Re-contrôle défensif, lexical ET réel : le moteur a déjà validé, mais le connecteur ne se fie pas
   * à l'appelant, et un lien symbolique peut avoir été posé après l'enregistrement de la source.
   */
  private async assertSafe(): Promise<void> {
    try {
      await assertFilesystemRealPathSafe(
        this.config.rootPath,
        this.ctx.deps.env ?? process.env,
        this.fs,
      );
    } catch (e) {
      throw new ConnectorAuthError(e instanceof Error ? e.message : 'Dossier refusé.');
    }
  }

  async authenticate(): Promise<void> {
    await this.assertSafe();
    try {
      await this.fs.realpath(this.rootAbs);
    } catch (e) {
      const code = errorCode(e);
      if (code === 'EACCES' || code === 'EPERM') {
        throw new ConnectorAuthError(
          'Accès refusé au dossier surveillé (droits du compte du serveur).',
        );
      }
      throw new Error(
        `Dossier surveillé introuvable ou inaccessible (${code ?? 'erreur'}) : vérifiez le montage.`,
      );
    }
  }

  async listChanges(since: string | null, opts: ListChangesOptions): Promise<ChangePage> {
    await this.assertSafe();
    const cursor = since === null ? null : decodeCursor(since);
    const pageSize = Math.max(1, Math.floor(opts.pageSize));
    const minAgeMs = this.config.minAgeSeconds * 1000;
    const nowMs = this.now().getTime();

    const entries = (await this.fs.walk(this.rootAbs))
      .filter((e) => this.isListable(e, nowMs, minAgeMs))
      .filter((e) => !cursor || compareEntries({ m: e.mtimeMs, p: e.relPath }, cursor) > 0)
      .sort((a, b) =>
        compareEntries({ m: a.mtimeMs, p: a.relPath }, { m: b.mtimeMs, p: b.relPath }),
      );

    const page = entries.slice(0, pageSize);
    const hasMore = entries.length > page.length;
    const last = page[page.length - 1];
    const nextToken = last ? encodeCursor({ m: last.mtimeMs, p: last.relPath }) : since; // rien de neuf : on conserve le jeton tel quel

    return {
      items: page.map((e) => this.toRemoteItem(e)),
      deletedExternalIds: [], // pas de journal de suppressions : voir `findMissing`
      nextToken,
      hasMore,
    };
  }

  private isListable(e: FsEntry, nowMs: number, minAgeMs: number): boolean {
    if (!safeSegments(e.relPath)) return false;
    if (!this.config.recursive && e.relPath.includes('/')) return false;
    if (isIgnoredName(e.relPath)) return false;
    // Hors liste d'extensions : ce n'est pas un document de la GED (miniatures, bases…), on
    // l'ignore plutôt que de le faire apparaître comme erreur à chaque passe.
    if (!this.allowedExtensions.has(extensionOf(e.relPath))) return false;
    // Encore en cours d'écriture (ou date dans le futur) : sera vu à la passe suivante. Comme le tri
    // est par mtime croissant, ces fichiers forment la fin de l'ordre : le curseur ne les saute pas.
    if (nowMs - e.mtimeMs < minAgeMs) return false;
    return true;
  }

  private toRemoteItem(e: FsEntry): RemoteItem {
    const name = e.relPath.split('/').pop() ?? e.relPath;
    const meta: Record<string, unknown> = {};
    if (typeof e.mode === 'number') meta.mode = e.mode & 0o777;
    if (typeof e.uid === 'number') meta.uid = e.uid;
    if (typeof e.gid === 'number') meta.gid = e.gid;
    return {
      externalId: e.relPath,
      name,
      originPath: e.relPath,
      mimeType: mimeTypeForName(name),
      byteLength: e.size,
      originAuthor: typeof e.uid === 'number' ? `uid:${e.uid}` : undefined,
      originCreatedAt:
        typeof e.birthtimeMs === 'number' && e.birthtimeMs > 0
          ? new Date(e.birthtimeMs)
          : undefined,
      originModifiedAt: new Date(e.mtimeMs),
      remoteVersion: `${e.size}:${e.mtimeMs}`,
      originMetadata: Object.keys(meta).length ? meta : undefined,
    };
  }

  async fetchFile(item: RemoteItem): Promise<FetchedFile> {
    // Contrôle lexical seulement ici (coût par fichier) : la validation réelle de la racine est faite
    // à `authenticate`/`listChanges`, et le chemin réel du fichier est comparé à la racine réelle plus bas.
    try {
      assertFilesystemPathSafe(this.config.rootPath, this.ctx.deps.env ?? process.env);
    } catch (e) {
      throw new ConnectorAuthError(e instanceof Error ? e.message : 'Dossier refusé.');
    }
    const segments = safeSegments(item.externalId);
    if (!segments) throw new ConnectorItemRejectedError('Chemin de fichier invalide.');
    const name = segments[segments.length - 1] ?? item.externalId;
    if (isIgnoredName(item.externalId)) {
      throw new ConnectorItemRejectedError('Fichier temporaire, caché ou de dossier de service.');
    }
    const ext = extensionOf(name);
    if (!this.allowedExtensions.has(ext)) {
      throw new ConnectorItemRejectedError(
        `Type de fichier non autorisé (${ext || 'sans extension'}).`,
      );
    }
    const max = this.ctx.limits.maxFileBytes;
    if (typeof item.byteLength === 'number' && item.byteLength > max) {
      throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${max} octets).`);
    }

    const abs = path.resolve(this.rootAbs, ...segments);
    // Le chemin réel doit rester sous la racine réelle : un lien symbolique (ou une traversée par
    // montage) ne doit jamais permettre de lire hors du dossier surveillé.
    let real: string;
    try {
      const [realRoot, realFile] = await Promise.all([
        this.fs.realpath(this.rootAbs),
        this.fs.realpath(abs),
      ]);
      if (!isInside(realFile, realRoot)) {
        throw new ConnectorItemRejectedError(
          'Le fichier sort du dossier surveillé (lien symbolique).',
        );
      }
      real = realFile;
    } catch (e) {
      if (e instanceof ConnectorItemRejectedError) throw e;
      if (IO_REJECTIONS.has(errorCode(e) ?? '')) {
        throw new ConnectorItemRejectedError('Fichier introuvable ou illisible.');
      }
      throw e;
    }

    let bytes: Buffer;
    try {
      bytes = await this.fs.readFile(real, max);
    } catch (e) {
      if (e instanceof ConnectorItemRejectedError) throw e;
      if (IO_REJECTIONS.has(errorCode(e) ?? '')) {
        throw new ConnectorItemRejectedError('Fichier introuvable ou illisible.');
      }
      throw e;
    }
    if (bytes.length > max) {
      throw new ConnectorItemRejectedError(`Fichier trop volumineux (limite ${max} octets).`);
    }
    return { bytes, name, mimeType: mimeTypeForName(name) ?? item.mimeType };
  }

  async readOriginAcl(item: RemoteItem): Promise<OriginAcl | null> {
    const m = item.originMetadata;
    if (!m) return null;
    return aclFromPosix({
      mode: typeof m.mode === 'number' ? m.mode : undefined,
      uid: typeof m.uid === 'number' ? m.uid : undefined,
      gid: typeof m.gid === 'number' ? m.gid : undefined,
    });
  }

  /**
   * Ids dont le fichier n'existe plus. Si la RACINE elle-même est injoignable (partage démonté),
   * on lève : sinon toute la source serait déclarée supprimée d'un coup.
   */
  async findMissing(knownExternalIds: string[]): Promise<string[]> {
    await this.assertSafe();
    let realRoot: string;
    try {
      realRoot = await this.fs.realpath(this.rootAbs);
    } catch {
      throw new Error(
        'Dossier surveillé injoignable : suppression non évaluée (partage démonté ou indisponible ?).',
      );
    }
    const missing: string[] = [];
    const BATCH = 20;
    for (let i = 0; i < knownExternalIds.length; i += BATCH) {
      const chunk = knownExternalIds.slice(i, i + BATCH);
      const results = await Promise.all(
        chunk.map(async (id) => {
          const segments = safeSegments(id);
          if (!segments) return true;
          try {
            const real = await this.fs.realpath(path.resolve(this.rootAbs, ...segments));
            return !isInside(real, realRoot);
          } catch (e) {
            const code = errorCode(e);
            if (code === 'ENOENT' || code === 'ENOTDIR') return true;
            throw e;
          }
        }),
      );
      chunk.forEach((id, k) => {
        if (results[k]) missing.push(id);
      });
    }
    return missing;
  }

  async close(): Promise<void> {
    // Rien à fermer : aucun descripteur n'est conservé entre deux appels.
  }
}

export const filesystemConnector: ConnectorDefinition = {
  type: FILESYSTEM_CONNECTOR_TYPE,
  label: 'Dossier surveillé',
  description:
    'Lit un dossier du serveur (partage SFTP/SMB monté) sans jamais rien y modifier : les fichiers ' +
    'nouveaux ou modifiés sont repris, ceux qui disparaissent sont signalés.',
  supportedModes: [GedSourceMode.Copie, GedSourceMode.IndexationEnPlace, GedSourceMode.Synchro],
  configFields: [
    {
      name: 'rootPath',
      label: 'Dossier à surveiller',
      kind: 'text',
      required: true,
      help: "Chemin absolu sur le serveur, dans les dossiers autorisés par l'exploitant.",
      placeholder: '/mnt/partage/documents',
    },
    {
      name: 'recursive',
      label: 'Inclure les sous-dossiers',
      kind: 'boolean',
      required: false,
    },
    {
      name: 'minAgeSeconds',
      label: 'Délai de stabilité (secondes)',
      kind: 'number',
      required: false,
      help: 'Un fichier modifié depuis moins de ce délai est ignoré (copie probablement en cours).',
      placeholder: '30',
    },
    {
      name: 'extensions',
      label: 'Extensions retenues',
      kind: 'textarea',
      required: false,
      help: 'Sous-ensemble des extensions autorisées (ex. .pdf, .docx). Vide = toutes les autorisées.',
    },
  ],
  credentialFields: [],
  configSchema,
  credentialsSchema,
  async assertConfigSafe(config: unknown, deps: ConnectorDeps): Promise<void> {
    const parsed = configSchema.parse(config);
    // Si `rootPath` n'existe pas encore, seul son plus proche parent existant est résolu ici (la
    // validation lexicale reste obligatoire) ; `authenticate` refait la validation réelle à chaque
    // passe, car un lien peut être posé après l'enregistrement.
    await assertFilesystemRealPathSafe(
      parsed.rootPath,
      deps.env ?? process.env,
      deps.fs ?? createDefaultFsProvider(),
    );
  },
  create(ctx: ConnectorContext): SourceConnector {
    return new FilesystemConnector(ctx);
  },
};
