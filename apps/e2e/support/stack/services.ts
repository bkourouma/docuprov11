/**
 * Builds et lancement des trois services applicatifs de la pile : API NestJS, worker BullMQ, web
 * Next.js. Tous sont lancés directement par `node` (jamais via pnpm/cmd) pour que le PID suivi soit
 * le vrai processus, et détachés pour survivre à `e2e:up`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  API_PORT,
  API_URL,
  CONNECTOR_FS_ROOT,
  GED_CONNECTOR_KEY,
  JWT_EXPIRES_IN,
  JWT_SECRET,
  REDIS_URL,
  REPO_ROOT,
  STACK_DIR,
  WEB_DIST_DIR,
  WEB_MODE,
  WEB_PORT,
  WEB_URL,
} from '../env';
import { baseEnv, ensureDir, isPidAlive, run, sleep, startDetached, tail } from './proc';

export type ServiceName = 'api' | 'worker' | 'web';

const NODE = process.execPath;
const NM = path.join(REPO_ROOT, 'node_modules');
const WEB_DIR = path.join(REPO_ROOT, 'apps', 'web');
const API_DIR = path.join(REPO_ROOT, 'apps', 'api');
const WORKER_DIR = path.join(REPO_ROOT, 'apps', 'worker');
const NEXT_CLI = path.join(NM, 'next', 'dist', 'bin', 'next');
const TURBO_CLI = path.join(NM, 'turbo', 'bin', 'turbo');
const PRISMA_CLI = path.join(NM, 'prisma', 'build', 'index.js');

export const ARCHIVES_DIR = path.join(STACK_DIR, 'archives');
export const logFile = (name: string) => path.join(STACK_DIR, 'logs', `${name}.log`);

/** Environnement d'exécution commun à l'API et au worker (valeurs de test, aucun secret réel). */
export function runtimeEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return baseEnv({
    // `production` : journaux JSON sans transport pino-pretty. Surtout pas `test`, qui coupe le
    // consommateur d'événements Docu-Flow et les purges planifiées de l'assistant.
    NODE_ENV: 'production',
    PORT: String(API_PORT),
    DATABASE_URL: databaseUrl,
    REDIS_URL,
    ARCHIVES_PATH: ARCHIVES_DIR,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    APP_BASE_URL: WEB_URL,
    TESSERACT_LANG: 'fra+eng',
    // Hermétique : pas de SMTP, pas d'IA (ni OPENAI_API_KEY ni GED_AI_*), pas d'OAuth
    // (aucune variable GED_GOOGLE_* / GED_MS_*), pas de CORS_ORIGIN (l'upgrade WebSocket de la
    // collaboration accepte alors toute origine), pas de NEXT_PUBLIC_COLLAB_WS_URL.
    SMTP_HOST: '',
    OPENAI_API_KEY: '',
    // Connecteurs GED : clé de chiffrement de test et racine « dossier surveillé » dédiée.
    GED_CONNECTOR_KEY,
    GED_CONNECTOR_FS_ROOTS: CONNECTOR_FS_ROOT,
    NO_COLOR: '1',
  });
}

/* --------------------------------------------------------------------- builds -------------- */

/** Génère le client Prisma s'il manque (jamais sinon : la DLL du moteur peut être verrouillée). */
export async function ensurePrismaClient(): Promise<void> {
  if (fs.existsSync(path.join(NM, '.prisma', 'client', 'index.d.ts'))) return;
  await run(NODE, [PRISMA_CLI, 'generate'], {
    cwd: path.join(REPO_ROOT, 'packages', 'db'),
    env: baseEnv(),
    log: logFile('build-api'),
  });
}

/**
 * Build de l'API et du worker (et de leurs paquets) par turbo : quasi instantané si rien n'a
 * changé. Environnement de build sans les variables de la pile, pour garder le cache turbo.
 */
export async function buildApiAndWorker(only?: 'api' | 'worker'): Promise<void> {
  const filters = only ? [`--filter=@archivage/${only}`] : ['--filter=@archivage/api', '--filter=@archivage/worker'];
  await run(NODE, [TURBO_CLI, 'run', 'build', ...filters, '--output-logs=errors-only'], {
    cwd: REPO_ROOT,
    env: baseEnv({ TURBO_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' }),
    log: logFile('build-api'),
  });
}

/** Dossiers dont dépend le rendu du web (sources du web et des paquets workspace qu'il importe). */
const WEB_SOURCES = [
  WEB_DIR,
  path.join(REPO_ROOT, 'packages', 'ui'),
  path.join(REPO_ROOT, 'packages', 'types'),
  path.join(REPO_ROOT, 'packages', 'editor'),
  path.join(REPO_ROOT, 'packages', 'mailer'),
];
const WEB_SKIP = new Set(['node_modules', '.turbo', 'dist', 'coverage', 'pdfjs', '.impeccable']);

/** Liste `chemin:taille:mtime` des sources du web (et l'URL de l'API), triée. */
export function webSourceList(): string[] {
  const lines = [`api=${API_URL}`];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (WEB_SKIP.has(entry.name) || entry.name.startsWith('.next')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        lines.push(`${path.relative(REPO_ROOT, full)}:${st.size}:${Math.floor(st.mtimeMs)}`);
      }
    }
  };
  for (const dir of WEB_SOURCES) if (fs.existsSync(dir)) walk(dir);
  return lines.sort();
}

export function webFingerprint(lines = webSourceList()): string {
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

const webStamp = () => path.join(WEB_DIR, WEB_DIST_DIR, '.e2e-fingerprint');

/**
 * Fichiers suivis par git que `next build` / `next dev` réécrivent quand le dossier de sortie
 * n'est pas `.next` (référence `./.next-e2e-<port>/types` dans next-env.d.ts, `include` et formatage de
 * tsconfig.json), et ceux que copy-pdfjs-assets réécrit (fins de ligne des LICENSE). La pile les
 * remet octet pour octet, date de modification comprise : aucun bruit au commit, et une empreinte
 * de build stable.
 */
const WEB_TRACKED_NOISE = [
  path.join(WEB_DIR, 'next-env.d.ts'),
  path.join(WEB_DIR, 'tsconfig.json'),
  path.join(WEB_DIR, 'public', 'pdfjs', 'cmaps', 'LICENSE'),
  path.join(WEB_DIR, 'public', 'pdfjs', 'standard_fonts', 'LICENSE_FOXIT'),
  path.join(WEB_DIR, 'public', 'pdfjs', 'standard_fonts', 'LICENSE_LIBERATION'),
];

interface FileSnapshot {
  restore(): void;
}

function snapshotWebNoise(): FileSnapshot {
  const saved = WEB_TRACKED_NOISE.filter((f) => fs.existsSync(f)).map((file) => {
    const st = fs.statSync(file);
    return { file, content: fs.readFileSync(file), atime: st.atime, mtime: st.mtime };
  });
  return {
    restore() {
      for (const s of saved) {
        const current = fs.existsSync(s.file) ? fs.readFileSync(s.file) : null;
        if (!current || !current.equals(s.content)) fs.writeFileSync(s.file, s.content);
        fs.utimesSync(s.file, s.atime, s.mtime);
      }
    },
  };
}

/** Instantané pris au lancement du web, remis quand il est prêt (next dev réécrit au démarrage). */
let pendingWebNoise: FileSnapshot | null = null;

/**
 * Mode prod : `next build` dans le dossier de sortie de la pile, seulement si les sources (ou
 * l'URL de l'API, figée dans les rewrites au build) ont changé. `E2E_WEB_REBUILD=1` force.
 * Renvoie vrai si un build a eu lieu.
 */
export async function buildWebIfNeeded(force = process.env.E2E_WEB_REBUILD === '1'): Promise<boolean> {
  if (WEB_MODE === 'dev') return false;
  const lines = webSourceList();
  const fp = webFingerprint(lines);
  const stamp = webStamp();
  const listFile = `${stamp}.list`;
  const buildId = path.join(WEB_DIR, WEB_DIST_DIR, 'BUILD_ID');
  if (!force && fs.existsSync(buildId) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fp) return false;
  // Diagnostic : ce qui a changé depuis le dernier build (journal build-web).
  let why = force ? 'E2E_WEB_REBUILD=1' : 'aucun build précédent';
  if (!force && fs.existsSync(listFile)) {
    const before = new Set(fs.readFileSync(listFile, 'utf8').split('\n'));
    const after = new Set(lines);
    const changed = [...lines.filter((l) => !before.has(l)), ...[...before].filter((l) => !after.has(l)).map((l) => `(retiré) ${l}`)];
    why = `sources modifiées : ${changed.slice(0, 10).join(' ; ')}${changed.length > 10 ? ` … (+${changed.length - 10})` : ''}`;
  }
  const env = baseEnv({
    ARCHIVAGE_WEB_DIST_DIR: WEB_DIST_DIR,
    API_INTERNAL_URL: API_URL,
    NEXT_TELEMETRY_DISABLED: '1',
    // Le typage est vérifié par `pnpm build` / le lint du web, pas par la pile E2E.
    ARCHIVAGE_WEB_SKIP_TYPECHECK: '1',
  });
  fs.writeFileSync(logFile('build-web'), `[e2e] next build : ${why}\n`);
  console.log(`[e2e]   next build : ${why.slice(0, 300)}`);
  const noise = snapshotWebNoise();
  try {
    await run(NODE, ['scripts/copy-pdfjs-assets.mjs'], { cwd: WEB_DIR, env, log: logFile('build-web') });
    await run(NODE, [NEXT_CLI, 'build'], { cwd: WEB_DIR, env, log: logFile('build-web') });
  } finally {
    noise.restore();
  }
  fs.writeFileSync(stamp, fp);
  fs.writeFileSync(listFile, lines.join('\n'));
  return true;
}

/* -------------------------------------------------------------------- lancement ------------- */

export function startService(name: ServiceName, databaseUrl: string): number {
  ensureDir(path.join(STACK_DIR, 'logs'));
  if (name === 'api') {
    return startDetached(NODE, [path.join(API_DIR, 'dist', 'main.js')], {
      cwd: API_DIR,
      env: runtimeEnv(databaseUrl),
      log: logFile('api'),
    });
  }
  if (name === 'worker') {
    return startDetached(NODE, [path.join(WORKER_DIR, 'dist', 'index.js')], {
      cwd: WORKER_DIR,
      env: runtimeEnv(databaseUrl),
      log: logFile('worker'),
    });
  }
  const env = baseEnv({
    ARCHIVAGE_WEB_DIST_DIR: WEB_DIST_DIR,
    API_INTERNAL_URL: API_URL,
    NEXT_TELEMETRY_DISABLED: '1',
    ...(WEB_MODE === 'dev' ? { ARCHIVAGE_WEB_DEV_GUARD: '1', NODE_ENV: 'development' } : { NODE_ENV: 'production' }),
  });
  const args =
    WEB_MODE === 'dev'
      ? [NEXT_CLI, 'dev', '--turbopack', '-p', String(WEB_PORT), '-H', '127.0.0.1']
      : [NEXT_CLI, 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'];
  pendingWebNoise = snapshotWebNoise();
  return startDetached(NODE, args, { cwd: WEB_DIR, env, log: logFile('web') });
}

/** GET simple, renvoie le statut HTTP (0 si injoignable). */
export function httpStatus(url: string, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

async function waitFor(
  label: string,
  pid: number,
  log: string,
  timeoutMs: number,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      throw new Error(`[e2e] ${label} s'est arrêté au démarrage.\n--- ${log} (fin) ---\n${tail(log)}`);
    }
    if (await probe()) return;
    await sleep(500);
  }
  throw new Error(`[e2e] ${label} ne répond pas après ${timeoutMs / 1000} s.\n--- ${log} (fin) ---\n${tail(log)}`);
}

/** Attend qu'un service soit prêt (santé HTTP, ou ligne de démarrage pour le worker). */
export async function waitHealthy(name: ServiceName, pid: number): Promise<void> {
  if (name === 'api') {
    await waitFor('API', pid, logFile('api'), 120_000, async () => (await httpStatus(`${API_URL}/api/health`)) === 200);
    return;
  }
  if (name === 'worker') {
    await waitFor('worker', pid, logFile('worker'), 90_000, async () => {
      try {
        return fs.readFileSync(logFile('worker'), 'utf8').includes('Worker booted');
      } catch {
        return false;
      }
    });
    return;
  }
  // Web : la page de connexion ET le proxy /api (rewrites vers la bonne API).
  try {
    await waitFor('web', pid, logFile('web'), WEB_MODE === 'dev' ? 300_000 : 120_000, async () => {
      if ((await httpStatus(`${WEB_URL}/login`, WEB_MODE === 'dev' ? 240_000 : 10_000)) !== 200) return false;
      return (await httpStatus(`${WEB_URL}/api/health`)) === 200;
    });
    if (WEB_MODE === 'dev') {
      // Pré-chauffage : la première compilation des pages lourdes se fait ici, pas dans un test.
      await httpStatus(`${WEB_URL}/dashboards`, 300_000);
    }
  } finally {
    pendingWebNoise?.restore();
    pendingWebNoise = null;
  }
}

/** Vrai si le service répond maintenant (sans attendre). */
export async function isHealthy(name: ServiceName, pid: number | undefined): Promise<boolean> {
  if (!isPidAlive(pid)) return false;
  if (name === 'api') return (await httpStatus(`${API_URL}/api/health`)) === 200;
  if (name === 'web') return (await httpStatus(`${WEB_URL}/api/health`, 15_000)) === 200;
  return true;
}
