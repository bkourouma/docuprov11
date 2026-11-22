/**
 * Orchestration de la pile E2E : montage, réutilisation, arrêt, redémarrage ciblé.
 *
 * État : `<STACK_DIR>/state.json` (PIDs, ports, URL de la base). Une pile dont l'état existe et
 * qui répond est réutilisée telle quelle (ni base recréée, ni build) : c'est le mode « pile gardée
 * montée » (`pnpm e2e:up` puis `pnpm e2e` autant de fois que voulu).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  API_PORT,
  API_URL,
  CONNECTOR_FS_ROOT,
  EXTERNAL_DATABASE_URL,
  PG_MODE,
  PG_PORT,
  REDIS_URL,
  STACK_DIR,
  WEB_MODE,
  WEB_PORT,
  WEB_URL,
} from '../env';
import { ensurePostgres, postgresRunning, prepareFreshDatabase, stopPostgres } from './database';
import { ensureDir, isPidAlive, killOwnedTree, killOwnedTrees, step } from './proc';
import { ensureRedis, flushStackRedisDb } from './redis';
import {
  ARCHIVES_DIR,
  buildApiAndWorker,
  buildWebIfNeeded,
  ensurePrismaClient,
  isHealthy,
  logFile,
  startService,
  waitHealthy,
  type ServiceName,
} from './services';

export type { ServiceName } from './services';

export interface StackState {
  version: 1;
  apiPort: number;
  webPort: number;
  pgPort: number;
  redisUrl: string;
  databaseUrl: string;
  webMode: 'prod' | 'dev';
  pgMode: 'docker' | 'local' | 'external';
  pids: Partial<Record<ServiceName, number>>;
  startedAt: string;
}

const STATE_FILE = path.join(STACK_DIR, 'state.json');
const SERVICES: ServiceName[] = ['api', 'worker', 'web'];

export function readState(): StackState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as StackState;
  } catch {
    return null;
  }
}

function writeState(state: StackState): void {
  ensureDir(STACK_DIR);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

function assertPortFree(port: number, label: string): Promise<void> {
  return portInUse(port).then((busy) => {
    if (busy) {
      throw new Error(
        `[e2e] le port ${port} (${label}) est déjà occupé par un processus qui n'appartient pas à cette pile. ` +
          `Choisissez un autre port (E2E_${label.toUpperCase()}_PORT) ou identifiez-le : ` +
          `Get-NetTCPConnection -LocalPort ${port} -State Listen`,
      );
    }
  });
}

/** Vrai si la pile décrite par l'état répond entièrement. */
export async function isStackHealthy(state: StackState | null = readState()): Promise<boolean> {
  if (!state) return false;
  if (state.apiPort !== API_PORT || state.webPort !== WEB_PORT) return false;
  if (!postgresRunning()) return false;
  for (const name of SERVICES) {
    if (!(await isHealthy(name, state.pids[name]))) return false;
  }
  return true;
}

/** Arrête les processus d'un état (périmé ou non) ; ne touche qu'aux PID de cette copie de travail. */
function killStateProcesses(state: StackState | null): void {
  if (!state) return;
  killOwnedTrees(SERVICES.map((name) => ({ pid: state.pids[name], label: name })));
}

export interface UpResult {
  reused: boolean;
  state: StackState;
}

/** Monte la pile, ou réutilise celle qui tourne déjà sur ces ports. */
export async function stackUp(opts: { forceFresh?: boolean } = {}): Promise<UpResult> {
  const t0 = Date.now();
  const previous = readState();
  if (!opts.forceFresh && (await isStackHealthy(previous))) {
    console.log(`[e2e] pile déjà montée réutilisée : web ${WEB_URL}, API ${API_URL} (base non réinitialisée)`);
    return { reused: true, state: previous as StackState };
  }
  killStateProcesses(previous);
  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
  await assertPortFree(API_PORT, 'api');
  await assertPortFree(WEB_PORT, 'web');
  ensureDir(path.join(STACK_DIR, 'logs'));

  const pids: Partial<Record<ServiceName, number>> = {};
  const state: StackState = {
    version: 1,
    apiPort: API_PORT,
    webPort: WEB_PORT,
    pgPort: PG_PORT,
    redisUrl: REDIS_URL,
    databaseUrl: '',
    webMode: WEB_MODE,
    pgMode: EXTERNAL_DATABASE_URL ? 'external' : PG_MODE,
    pids,
    startedAt: new Date().toISOString(),
  };

  try {
    // Base, Redis et builds en parallèle : le build web à froid (≈ 3 min 30) domine.
    const prepareDb = async () => {
      let done = step(`PostgreSQL (${state.pgMode}, port ${PG_PORT})`);
      await ensurePostgres();
      done();
      done = step('base neuve (clone de la base modèle, reconstruite si packages/db/prisma a changé)');
      const db = await prepareFreshDatabase();
      done();
      if (db.templateRebuilt) console.log('[e2e]   base modèle reconstruite (migrations + SQL brut + seeds)');
      state.databaseUrl = db.url;
    };
    const prepareRedis = async () => {
      const done = step(`Redis (${REDIS_URL})`);
      await ensureRedis();
      await flushStackRedisDb();
      done();
    };
    const buildServers = async () => {
      let done = step('build API + worker (turbo, cache)');
      await ensurePrismaClient();
      await buildApiAndWorker();
      done();
      if (WEB_MODE === 'prod') {
        done = step('build web (next build, seulement si les sources ont changé)');
        const built = await buildWebIfNeeded();
        done();
        if (!built) console.log('[e2e]   build web à jour, réutilisé');
      }
    };
    await Promise.all([prepareDb(), prepareRedis(), buildServers()]);

    for (const dir of [ARCHIVES_DIR, CONNECTOR_FS_ROOT]) {
      fs.rmSync(dir, { recursive: true, force: true });
      ensureDir(dir);
    }

    const done = step(`démarrage API :${API_PORT}, worker, web :${WEB_PORT} (${WEB_MODE})`);
    for (const name of SERVICES) {
      pids[name] = startService(name, state.databaseUrl);
    }
    writeState(state);
    await Promise.all(SERVICES.map((name) => waitHealthy(name, pids[name] as number)));
    done();
  } catch (err) {
    killStateProcesses(state);
    if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
    throw err;
  }
  console.log(`[e2e] pile prête en ${((Date.now() - t0) / 1000).toFixed(1)} s : web ${WEB_URL}, API ${API_URL}/api, journaux ${path.join(STACK_DIR, 'logs')}`);
  return { reused: false, state };
}

/** Arrête toute la pile (services puis PostgreSQL). Redis partagé : laissé en marche. */
export async function stackDown(): Promise<void> {
  const state = readState();
  killStateProcesses(state);
  // Laisse à Windows le temps de libérer les ports avant un éventuel remontage.
  for (let i = 0; i < 20 && state && SERVICES.some((n) => isPidAlive(state.pids[n])); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await stopPostgres();
  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
  console.log(`[e2e] pile ${WEB_PORT} arrêtée`);
}

/**
 * Reconstruit puis redémarre un service (ou tous) sans toucher à la base : boucle « je corrige
 * le code, je relance les tests ».
 */
export async function restartService(target: ServiceName | 'all'): Promise<void> {
  const state = readState();
  if (!state) throw new Error('[e2e] aucune pile montée sur ces ports : lancez d\'abord `pnpm e2e:up`.');
  const names = target === 'all' ? SERVICES : [target];
  let done = step(`build ${names.join(', ')}`);
  if (names.includes('api') || names.includes('worker')) {
    await buildApiAndWorker(names.length === 1 ? (names[0] as 'api' | 'worker') : undefined);
  }
  if (names.includes('web') && WEB_MODE === 'prod') await buildWebIfNeeded();
  done();
  done = step(`redémarrage ${names.join(', ')}`);
  for (const name of names) {
    killOwnedTree(state.pids[name], name);
    for (let i = 0; i < 40 && isPidAlive(state.pids[name]); i++) await new Promise((r) => setTimeout(r, 250));
  }
  for (const name of names) {
    state.pids[name] = startService(name, state.databaseUrl);
  }
  writeState(state);
  await Promise.all(names.map((name) => waitHealthy(name, state.pids[name] as number)));
  done();
}

export async function stackStatus(): Promise<string> {
  const state = readState();
  if (!state) return `[e2e] aucune pile montée pour le port web ${WEB_PORT} (${STATE_FILE} absent)`;
  const lines = [`[e2e] pile ${WEB_PORT} — montée le ${state.startedAt}, web ${state.webMode}, PostgreSQL ${state.pgMode} :${state.pgPort}`];
  lines.push(`  postgres  ${postgresRunning() ? 'OK' : 'ARRÊTÉ'}`);
  for (const name of SERVICES) {
    const pid = state.pids[name];
    lines.push(`  ${name.padEnd(8)}  PID ${String(pid).padEnd(7)} ${(await isHealthy(name, pid)) ? 'OK' : 'KO'}  (${logFile(name)})`);
  }
  lines.push(`  web ${WEB_URL} · API ${API_URL}/api · base ${state.databaseUrl} · Redis ${state.redisUrl}`);
  return lines.join('\n');
}
