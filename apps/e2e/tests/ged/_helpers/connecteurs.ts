/**
 * Aides GED (T4) : connecteurs de sources, sans aucun service externe.
 *
 * Dossier surveillé (`filesystem`) : l'API n'accepte qu'un dossier situé dans une racine déclarée
 * par `GED_CONNECTOR_FS_ROOTS` (séparateur `path.delimiter`), comparée LEXICALEMENT puis sur chemins
 * réels (`packages/connectors/src/connectors/filesystem.ts`). Le test crée donc ses dossiers sous la
 * MÊME chaîne de base que celle déclarée à l'API :
 *   - `E2E_CONNECTOR_FS_ROOT` (positionnée par la pile, identique à `GED_CONNECTOR_FS_ROOTS`) ;
 *   - à défaut `os.tmpdir()` (la pile doit alors déclarer `GED_CONNECTOR_FS_ROOTS=<os.tmpdir()>`).
 * Le dossier ne doit ni contenir ni être contenu dans `ARCHIVES_PATH`.
 *
 * Il n'existe AUCUNE route de suppression de connecteur : les connecteurs créés restent en base
 * (libellés `uniq()`, sans planification). Les dossiers temporaires, eux, sont supprimés.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GedApi } from './users';

export const FS_CONNECTOR_TYPE = 'filesystem';
export const GOOGLE_DRIVE_TYPE = 'google_drive';
export const ONEDRIVE_TYPE = 'microsoft_onedrive';

/** Types du registre par défaut (`packages/connectors/src/default-registry.ts`), dans l'ordre. */
export const DEFAULT_CONNECTOR_TYPES = [
  'filesystem',
  'imap',
  'google_drive',
  'microsoft_onedrive',
  'microsoft_sharepoint',
  'microsoft_outlook',
  'whatsapp',
] as const;

/** Clés EXACTES de `GedConnectorView` (vue champ par champ : jamais `credentialsEnc`). */
export const CONNECTOR_VIEW_KEYS = [
  'config',
  'connectorType',
  'createdAt',
  'credentialsExpiresAt',
  'credentialsRef',
  'gedSourceConnectorId',
  'hasCredentials',
  'isActive',
  'label',
  'lastError',
  'lastSuccessAt',
  'lastSyncAt',
  'mode',
  'status',
  'syncIntervalMinutes',
  'targetDossierId',
  'updatedAt',
] as const;

export interface ConnectorView {
  gedSourceConnectorId: number;
  label: string;
  connectorType: string;
  mode: 0 | 1 | 2;
  status: 0 | 1 | 2 | 3;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- configuration propre à chaque type de source
  config: Record<string, any> | null;
  hasCredentials: boolean;
  credentialsRef: string | null;
  credentialsExpiresAt: string | null;
  syncIntervalMinutes: number | null;
  targetDossierId: number | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Racine autorisée attendue côté API (voir l'en-tête). */
export function allowedFsBase(): string {
  return process.env.E2E_CONNECTOR_FS_ROOT?.trim() || os.tmpdir();
}

export interface WatchedDir {
  dir: string;
  cleanup: () => Promise<void>;
}

/** Crée un dossier temporaire unique sous la racine autorisée (optionnellement avec des fichiers). */
export async function makeWatchedDir(files: Record<string, string> = {}): Promise<WatchedDir> {
  const dir = await mkdtemp(path.join(allowedFsBase(), 'docupro-ged-e2e-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Un chemin absolu HORS de la racine autorisée (dossier frère de la base, jamais créé). */
export function outsideAllowedRoot(): string {
  const base = path.resolve(allowedFsBase());
  return path.join(path.dirname(base), `hors-racine-docupro-e2e-${process.pid}`);
}

export function createFilesystemConnector(
  api: GedApi,
  opts: { label: string; rootPath: string; mode?: 0 | 1 | 2; minAgeSeconds?: number },
): Promise<ConnectorView> {
  return api.post<ConnectorView>('/ged/connectors', {
    label: opts.label,
    connectorType: FS_CONNECTOR_TYPE,
    mode: opts.mode ?? 0,
    config: { rootPath: opts.rootPath, minAgeSeconds: opts.minAgeSeconds ?? 0 },
    syncIntervalMinutes: null,
    targetDossierId: null,
  });
}

/** Connecteur OAuth sans autorisation : aucune configuration requise, aucun identifiant. */
export function createOAuthConnector(
  api: GedApi,
  opts: { label: string; connectorType: typeof GOOGLE_DRIVE_TYPE | typeof ONEDRIVE_TYPE },
): Promise<ConnectorView> {
  return api.post<ConnectorView>('/ged/connectors', {
    label: opts.label,
    connectorType: opts.connectorType,
    mode: 0,
    config: {},
    syncIntervalMinutes: null,
    targetDossierId: null,
  });
}

/** URI de retour OAuth de la page web (doit figurer dans `GED_OAUTH_REDIRECT_URIS` pour aller plus loin). */
export function oauthRedirectUri(baseURL: string | undefined): string {
  return `${(baseURL ?? 'http://localhost').replace(/\/$/, '')}/connecteurs/oauth/callback`;
}
