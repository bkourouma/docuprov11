/**
 * Source unique de la configuration de la pile E2E (ports, URL, chemins).
 *
 * Tout est paramétrable par variable d'environnement, pour que plusieurs piles tournent en même
 * temps sur la même machine (une par lot). Les valeurs par défaut sont celles du lot 0.
 * Aucune valeur ici n'est un vrai secret : ce sont des valeurs de test, en clair, pour une pile
 * jetable qui n'écoute que sur 127.0.0.1.
 */
import path from 'node:path';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`[e2e] ${name}="${raw}" n'est pas un port valide`);
  }
  return n;
}

function strFromEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** Racine du paquet apps/e2e. */
export const E2E_ROOT = path.resolve(__dirname, '..');
/** Racine du monorepo. */
export const REPO_ROOT = path.resolve(E2E_ROOT, '..', '..');

export const API_PORT = intFromEnv('E2E_API_PORT', 6100);
export const WEB_PORT = intFromEnv('E2E_WEB_PORT', 6200);
export const PG_PORT = intFromEnv('E2E_PG_PORT', 6300);

/** Redis partagé (conteneur docupro-e2e-redis), une base logique par pile. */
export const REDIS_URL = strFromEnv('E2E_REDIS_URL', 'redis://127.0.0.1:6399/0');

/**
 * Moteur du PostgreSQL jetable :
 * - `docker` (défaut) : conteneur `docupro-e2e-pg-<port>` sur l'image pgvector (l'extension
 *   `vector` est exigée par la migration 20261120120000_add_ged_ia_foundations), publié sur
 *   127.0.0.1:<E2E_PG_PORT>, volume dédié ;
 * - `local` : cluster initdb sous apps/e2e/.tmp avec les binaires de E2E_PG_BIN (exige que
 *   pgvector soit installé dans ce PostgreSQL, ce qui n'est pas le cas du PG 18 de la machine).
 * Ignoré si E2E_DATABASE_URL est fourni.
 */
export const PG_MODE: 'docker' | 'local' = strFromEnv('E2E_PG_MODE', 'docker') === 'local' ? 'local' : 'docker';
/** Image du mode docker (présente localement : pas de téléchargement). */
export const PG_IMAGE = strFromEnv('E2E_PG_IMAGE', 'pgvector/pgvector:pg17');
/** Binaires PostgreSQL (initdb, pg_ctl, psql) du mode local. */
export const PG_BIN = strFromEnv('E2E_PG_BIN', 'D:/Program Files/PostgreSQL/18/bin');

/** Nom de la base créée dans le cluster jetable. */
export const PG_DATABASE = 'docupro_e2e';
/** Base modèle (migrations + SQL brut + seeds), clonée à chaque montage neuf. */
export const PG_TEMPLATE_DATABASE = 'docupro_e2e_tpl';
/** Conteneur et volume du mode docker, propres au port PostgreSQL. */
export const PG_CONTAINER = `docupro-e2e-pg-${PG_PORT}`;
export const PG_VOLUME = `docupro-e2e-pg-${PG_PORT}`;
/** Conteneur Redis partagé par toutes les piles (une base logique chacune). */
export const REDIS_CONTAINER = 'docupro-e2e-redis';
export const REDIS_IMAGE = 'redis:7-alpine';

/**
 * Base déjà fournie (ex. CI). Si elle est définie, aucun cluster n'est créé et la base n'est
 * jamais supprimée : seules les migrations et les seeds idempotents sont appliqués.
 */
export const EXTERNAL_DATABASE_URL = process.env.E2E_DATABASE_URL?.trim() || undefined;

export const DATABASE_URL =
  EXTERNAL_DATABASE_URL ??
  `postgresql://postgres@127.0.0.1:${PG_PORT}/${PG_DATABASE}?schema=public`;

/** Mode du serveur web : `prod` (next build + next start, défaut) ou `dev` (next dev --turbopack). */
export const WEB_MODE: 'prod' | 'dev' = strFromEnv('E2E_WEB_MODE', 'prod') === 'dev' ? 'dev' : 'prod';

export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/** Dossier de sortie Next propre à la pile (relatif à apps/web), pour ne jamais écrire dans `.next`. */
export const WEB_DIST_DIR = WEB_MODE === 'dev' ? `.next-e2e-dev-${WEB_PORT}` : `.next-e2e-${WEB_PORT}`;

/** Dossier de travail de cette pile (journaux, coffre ARCHIVES, état), propre au port web. */
export const STACK_DIR = path.join(E2E_ROOT, '.tmp', `stack-${WEB_PORT}`);
/** Données du cluster PostgreSQL jetable, propre au port PostgreSQL. */
export const PG_DATA_DIR = path.join(E2E_ROOT, '.tmp', `pg-${PG_PORT}`);
/** storageState et jeton administrateur produits par le global setup, propres à la pile. */
export const AUTH_DIR = path.join(E2E_ROOT, '.auth', `stack-${WEB_PORT}`);
export const ADMIN_STORAGE_STATE = path.join(AUTH_DIR, 'admin.json');
export const ADMIN_TOKEN_FILE = path.join(AUTH_DIR, 'admin-token.txt');

/** Valeurs de test (pas de vrai secret) injectées dans l'API et le worker. */
export const JWT_SECRET = 'e2e-only-jwt-secret-not-a-real-secret-0123456789';
export const JWT_EXPIRES_IN = '7d';
/** Clé AES-256 de test des connecteurs GED (32 octets ASCII « e2e-only-connector-key-32-bytes! »). */
export const GED_CONNECTOR_KEY = 'ZTJlLW9ubHktY29ubmVjdG9yLWtleS0zMi1ieXRlcyE=';
/**
 * Racine autorisée du connecteur « dossier surveillé » (GED_CONNECTOR_FS_ROOTS), hors
 * ARCHIVES_PATH, vidée à chaque montage neuf. Exposée aux tests par E2E_CONNECTOR_FS_ROOT.
 */
export const CONNECTOR_FS_ROOT = path.join(STACK_DIR, 'connector-fs');
