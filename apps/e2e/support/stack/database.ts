/**
 * PostgreSQL jetable de la pile E2E : moteur (conteneur pgvector ou cluster local), base modèle,
 * migrations, SQL brut, seeds de référence.
 *
 * Montage neuf : la base `docupro_e2e` est recréée par clonage de la base modèle
 * `docupro_e2e_tpl` (≈ 1 s). La base modèle n'est reconstruite (≈ 1 à 2 min : migrate deploy +
 * SQL brut + seeds) que si packages/db/prisma a changé depuis : son empreinte est stockée en
 * commentaire de la base modèle.
 *
 * Jamais le PostgreSQL du service local (5432) : seul E2E_PG_PORT (ou E2E_DATABASE_URL) est utilisé.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXTERNAL_DATABASE_URL,
  PG_BIN,
  PG_CONTAINER,
  PG_DATA_DIR,
  PG_DATABASE,
  PG_IMAGE,
  PG_MODE,
  PG_PORT,
  PG_TEMPLATE_DATABASE,
  PG_VOLUME,
  REPO_ROOT,
  STACK_DIR,
} from '../env';
import { baseEnv, capture, run, sleep } from './proc';

const DB_DIR = path.join(REPO_ROOT, 'packages', 'db');
const PRISMA_CLI = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const LOG = () => path.join(STACK_DIR, 'logs', 'db.log');

/**
 * Seeds de référence, dans l'ordre de leurs dépendances (voir docs/e2e/README.md) :
 * socle, puis référentiels génériques « administration francophone » qui ne sont pas des jeux de
 * démonstration. Écartés : seed-demo, seed-dashboard-demo, seed-agef* (démonstration / client),
 * grant-dashboard-menu (rattrapage de rôles existants, le socle donne déjà tout au rôle système),
 * migrate-permission-levels (migration de données d'une base ancienne, le socle pose déjà la
 * nouvelle échelle).
 */
export const REFERENCE_SEEDS = [
  'prisma/seed.ts',
  'prisma/seed-confidentialites.ts',
  'prisma/seed-correspondants.ts',
  'prisma/seed-document-types.ts',
  'prisma/seed-dossiers.ts',
  'prisma/seed-classification-plan.ts',
  'prisma/seed-type-settings.ts',
  'prisma/seed-metadata.ts',
  'prisma/seed-life-cycles.ts',
];

/** SQL brut rejoué après les migrations (idempotent ; ged/wf/asst sont déjà dans les migrations). */
const RAW_SQL = ['prisma/sql/analytics.sql'];

function urlFor(db: string): string {
  return `postgresql://postgres@127.0.0.1:${PG_PORT}/${db}?schema=public`;
}

/* ---------------------------------------------------------------- moteur ------------------- */

function docker(args: string[]): { status: number; stdout: string; stderr: string } {
  return capture('docker', args);
}

function containerState(): 'running' | 'stopped' | 'absent' {
  const res = docker(['inspect', '-f', '{{.State.Running}}', PG_CONTAINER]);
  if (res.status !== 0) return 'absent';
  return res.stdout.trim() === 'true' ? 'running' : 'stopped';
}

async function ensureDockerPg(): Promise<void> {
  const state = containerState();
  if (state === 'absent') {
    const res = docker([
      'run', '-d', '--name', PG_CONTAINER,
      '--label', 'docupro-e2e=1',
      '-p', `127.0.0.1:${PG_PORT}:5432`,
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_DB=postgres',
      '-v', `${PG_VOLUME}:/var/lib/postgresql/data`,
      PG_IMAGE,
      // Base jetable : durabilité inutile, vitesse utile.
      '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
      '-c', 'max_connections=300',
    ]);
    if (res.status !== 0) {
      throw new Error(
        `[e2e] docker run ${PG_CONTAINER} a échoué : ${res.stderr.trim()}\n` +
          `Docker Desktop est-il démarré (docker info) ? L'image ${PG_IMAGE} est-elle présente (docker images) ?`,
      );
    }
  } else if (state === 'stopped') {
    const res = docker(['start', PG_CONTAINER]);
    if (res.status !== 0) throw new Error(`[e2e] docker start ${PG_CONTAINER} : ${res.stderr.trim()}`);
  }
  // pg_isready sur TCP : pendant l'initialisation, l'image n'écoute que sur le socket local.
  for (let i = 0; i < 120; i++) {
    if (docker(['exec', PG_CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']).status === 0) return;
    await sleep(500);
  }
  throw new Error(`[e2e] ${PG_CONTAINER} ne répond pas (docker logs ${PG_CONTAINER})`);
}

function pgBin(name: string): string {
  return path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name);
}

async function ensureLocalPg(): Promise<void> {
  if (!fs.existsSync(pgBin('pg_ctl'))) {
    throw new Error(`[e2e] binaires PostgreSQL introuvables sous E2E_PG_BIN=${PG_BIN}`);
  }
  if (!fs.existsSync(path.join(PG_DATA_DIR, 'PG_VERSION'))) {
    await run(pgBin('initdb'), ['-D', PG_DATA_DIR, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], {
      log: LOG(),
    });
  }
  const status = capture(pgBin('pg_ctl'), ['status', '-D', PG_DATA_DIR]);
  if (status.status !== 0) {
    await run(
      pgBin('pg_ctl'),
      ['start', '-D', PG_DATA_DIR, '-l', path.join(PG_DATA_DIR, '..', `pg-${PG_PORT}.log`), '-w', '-t', '60',
        '-o', `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=300`],
      { log: LOG() },
    );
  }
  const vector = await psql(`SELECT count(*) FROM pg_available_extensions WHERE name = 'vector'`);
  if (vector.trim() !== '1') {
    throw new Error(
      `[e2e] l'extension pgvector n'est pas installée dans ${PG_BIN} : la migration ` +
        `20261120120000_add_ged_ia_foundations l'exige. Utilisez E2E_PG_MODE=docker (défaut).`,
    );
  }
}

/** Démarre (ou réutilise) le moteur PostgreSQL de la pile. Sans effet avec E2E_DATABASE_URL. */
export async function ensurePostgres(): Promise<void> {
  if (EXTERNAL_DATABASE_URL) return;
  if (PG_MODE === 'docker') await ensureDockerPg();
  else await ensureLocalPg();
}

/** Arrête le moteur (le volume / dossier de données est conservé pour la base modèle). */
export async function stopPostgres(): Promise<void> {
  if (EXTERNAL_DATABASE_URL) return;
  if (PG_MODE === 'docker') {
    if (containerState() === 'running') docker(['stop', '-t', '5', PG_CONTAINER]);
  } else if (fs.existsSync(path.join(PG_DATA_DIR, 'PG_VERSION'))) {
    capture(pgBin('pg_ctl'), ['stop', '-D', PG_DATA_DIR, '-m', 'fast', '-w']);
  }
}

export function postgresRunning(): boolean {
  if (EXTERNAL_DATABASE_URL) return true;
  if (PG_MODE === 'docker') return containerState() === 'running';
  return capture(pgBin('pg_ctl'), ['status', '-D', PG_DATA_DIR]).status === 0;
}

/** Exécute du SQL sur la base `postgres` du moteur de la pile ; renvoie la sortie brute (-At). */
async function psql(sql: string): Promise<string> {
  const args = ['-v', 'ON_ERROR_STOP=1', '-At', '-U', 'postgres', '-d', 'postgres', '-c', sql];
  const res =
    PG_MODE === 'docker'
      ? docker(['exec', PG_CONTAINER, 'psql', '-h', '127.0.0.1', ...args])
      : capture(pgBin('psql'), ['-h', '127.0.0.1', '-p', String(PG_PORT), ...args]);
  if (res.status !== 0) throw new Error(`[e2e] psql : ${sql}\n${res.stderr.trim()}`);
  return res.stdout;
}

/* ----------------------------------------------------------- schéma et seeds ---------------- */

/** Empreinte de tout ce qui définit la base modèle (migrations, SQL, seeds, données de seed). */
function templateFingerprint(): string {
  const hash = crypto.createHash('sha1');
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(DB_DIR, full)).update(fs.readFileSync(full));
    }
  };
  walk(path.join(DB_DIR, 'prisma'));
  hash.update(JSON.stringify({ REFERENCE_SEEDS, RAW_SQL }));
  return hash.digest('hex').slice(0, 16);
}

function dbEnv(url: string): NodeJS.ProcessEnv {
  return baseEnv({ DATABASE_URL: url, NODE_ENV: 'production', PRISMA_HIDE_UPDATE_MESSAGE: '1' });
}

/** Migrations + SQL brut + seeds de référence sur la base `url`. */
async function buildSchemaAndSeeds(url: string): Promise<void> {
  const env = dbEnv(url);
  await run(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], { cwd: DB_DIR, env, log: LOG() });
  // `db push` volontairement absent : sur une base issue de `migrate deploy`, l'écart restant
  // (quelques clés étrangères ON DELETE, l'index HNSW posé en SQL brut) n'est pas une table
  // manquante, et `db push` supprimerait l'index HNSW de ged_chunk.
  for (const file of RAW_SQL) {
    await run(process.execPath, [PRISMA_CLI, 'db', 'execute', '--file', file, '--schema', 'prisma'], {
      cwd: DB_DIR,
      env,
      log: LOG(),
    });
  }
  for (const seed of REFERENCE_SEEDS) {
    await run(process.execPath, [TSX_CLI, seed], { cwd: DB_DIR, env, log: LOG() });
  }
}

export interface DatabaseResult {
  url: string;
  templateRebuilt: boolean;
}

/**
 * Prépare une base neuve pour la pile et renvoie son URL.
 * Avec E2E_DATABASE_URL : migrations et seeds idempotents sur la base fournie, jamais de DROP.
 */
export async function prepareFreshDatabase(): Promise<DatabaseResult> {
  if (EXTERNAL_DATABASE_URL) {
    await buildSchemaAndSeeds(EXTERNAL_DATABASE_URL);
    return { url: EXTERNAL_DATABASE_URL, templateRebuilt: true };
  }
  const fp = templateFingerprint();
  const current = (
    await psql(
      `SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '${PG_TEMPLATE_DATABASE}'`,
    )
  ).trim();
  let rebuilt = false;
  if (current !== `e2e:${fp}`) {
    rebuilt = true;
    await psql(`DROP DATABASE IF EXISTS ${PG_TEMPLATE_DATABASE} WITH (FORCE)`);
    await psql(`CREATE DATABASE ${PG_TEMPLATE_DATABASE}`);
    await buildSchemaAndSeeds(urlFor(PG_TEMPLATE_DATABASE));
    await psql(`COMMENT ON DATABASE ${PG_TEMPLATE_DATABASE} IS 'e2e:${fp}'`);
  }
  await psql(`DROP DATABASE IF EXISTS ${PG_DATABASE} WITH (FORCE)`);
  await psql(`CREATE DATABASE ${PG_DATABASE} TEMPLATE ${PG_TEMPLATE_DATABASE}`);
  return { url: urlFor(PG_DATABASE), templateRebuilt: rebuilt };
}
