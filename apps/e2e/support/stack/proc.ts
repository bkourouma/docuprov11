/**
 * Lancement et arrêt de processus pour la pile E2E (Windows d'abord, POSIX toléré).
 *
 * Règle de la machine : on n'arrête QUE des PID lancés par la pile, jamais par nom. Avant de tuer
 * un PID lu dans state.json, on vérifie que sa ligne de commande contient bien le chemin de cette
 * copie de travail (un PID peut avoir été réutilisé par Windows depuis).
 */
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../env';

const IS_WIN = process.platform === 'win32';

/** Variables héritées autorisées : le système, jamais la configuration applicative de l'hôte. */
const INHERITED = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramData',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'HOMEDRIVE',
  'HOMEPATH', 'HOME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'OS', 'LANG', 'TZ', 'PNPM_HOME', 'COREPACK_HOME', 'DOCKER_HOST', 'DOCKER_CONFIG',
  'PLAYWRIGHT_BROWSERS_PATH', 'CI',
];

/** Environnement minimal hérité de l'hôte, complété par `extra` (valeurs de la pile). */
export function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Dernières lignes d'un journal (pour les messages d'erreur). */
export function tail(file: string, lines = 40): string {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(journal absent)';
  }
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Journal où écrire stdout/stderr (ajout). */
  log: string;
  /** Contenu envoyé sur stdin. */
  input?: string;
  timeoutMs?: number;
  /** Ne lève pas si le code de sortie n'est pas 0 : le renvoie. */
  allowFailure?: boolean;
}

/** Exécute une commande jusqu'au bout, sortie vers `log`. Lève avec la fin du journal si échec. */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<number> {
  ensureDir(path.dirname(opts.log));
  fs.appendFileSync(opts.log, `\n$ ${cmd} ${args.join(' ')}\n`);
  const fd = fs.openSync(opts.log, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? baseEnv(),
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', fd, fd],
      windowsHide: true,
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        if (child.pid) killTreeUnchecked(child.pid);
      }, opts.timeoutMs);
    }
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      fs.closeSync(fd);
      reject(new Error(`[e2e] impossible de lancer ${cmd} : ${err.message}`));
    });
    // 'exit' et non 'close' : un enfant détaché (pg_ctl → postgres) peut garder les poignées.
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      fs.closeSync(fd);
      const status = code ?? 1;
      if (status !== 0 && !opts.allowFailure) {
        reject(
          new Error(
            `[e2e] échec (${status}) : ${cmd} ${args.join(' ')}\n--- ${opts.log} (fin) ---\n${tail(opts.log)}`,
          ),
        );
      } else {
        resolve(status);
      }
    });
  });
}

/** Exécute une commande courte et renvoie sa sortie standard (synchrone, sans journal). */
export function capture(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const res = spawnSync(cmd, args, {
    env: opts.env ?? baseEnv(),
    input: opts.input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: (res.stderr ?? '') + (res.error ? String(res.error) : '') };
}

/**
 * Lance un service longue durée, détaché (il survit au processus qui l'a lancé : nécessaire pour
 * `e2e:up`), sortie vers `log`. Renvoie son PID.
 */
export function startDetached(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string }): number {
  ensureDir(path.dirname(opts.log));
  fs.writeFileSync(opts.log, `$ ${cmd} ${args.join(' ')}\n(cwd ${opts.cwd})\n`);
  const fd = fs.openSync(opts.log, 'a');
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', fd, fd],
    detached: true,
    windowsHide: true,
  };
  const child = spawn(cmd, args, spawnOpts);
  fs.closeSync(fd);
  if (!child.pid) throw new Error(`[e2e] impossible de lancer ${cmd} ${args.join(' ')}`);
  child.unref();
  return child.pid;
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Ligne de commande d'un PID (null s'il n'existe plus). */
export function commandLineOf(pid: number): string | null {
  if (IS_WIN) {
    const res = capture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    const out = res.stdout.trim();
    return out === '' ? null : out;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return null;
  }
}

/** Vrai si la ligne de commande désigne un processus de cette copie de travail. */
export function belongsToRepo(cmdLine: string | null): boolean {
  if (!cmdLine) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return norm(cmdLine).includes(norm(REPO_ROOT));
}

function killTreeUnchecked(pid: number): void {
  if (IS_WIN) {
    capture('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* déjà arrêté */
      }
    }
  }
}

/** Lignes de commande de plusieurs PID en un seul appel (Windows : une requête CIM). */
function commandLinesOf(pids: number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (!IS_WIN) {
    for (const pid of pids) out.set(pid, commandLineOf(pid));
    return out;
  }
  const filter = pids.map((p) => `ProcessId=${p}`).join(' OR ');
  const res = capture('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
  ]);
  for (const pid of pids) out.set(pid, null);
  for (const line of res.stdout.split(/\r?\n/)) {
    const i = line.indexOf('\t');
    if (i > 0) out.set(Number(line.slice(0, i)), line.slice(i + 1));
  }
  return out;
}

/**
 * Arrête l'arbre de PID lancés par la pile, après vérification de leur ligne de commande.
 * Un PID qui ne nous appartient plus (réutilisé par Windows) ou déjà arrêté est laissé tel quel.
 * Renvoie le nombre d'arbres arrêtés.
 */
export function killOwnedTrees(entries: Array<{ pid: number | undefined; label: string }>): number {
  const alive = entries.filter((e): e is { pid: number; label: string } => !!e.pid && isPidAlive(e.pid));
  if (alive.length === 0) return 0;
  const cmdLines = commandLinesOf(alive.map((e) => e.pid));
  let killed = 0;
  for (const { pid, label } of alive) {
    const cmdLine = cmdLines.get(pid) ?? null;
    if (!belongsToRepo(cmdLine)) {
      if (cmdLine) console.warn(`[e2e] ${label} : PID ${pid} ne correspond plus à la pile (${cmdLine}), laissé tel quel.`);
      continue;
    }
    killTreeUnchecked(pid);
    killed += 1;
  }
  return killed;
}

/** Variante pour un seul PID. */
export function killOwnedTree(pid: number | undefined, label: string): boolean {
  return killOwnedTrees([{ pid, label }]) === 1;
}

/** Processus dont la ligne de commande contient le chemin de la copie de travail (diagnostic). */
export function listRepoProcesses(): Array<{ pid: number; cmd: string }> {
  if (!IS_WIN) return [];
  const res = capture('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
  ]);
  const self = new Set([process.pid, process.ppid]);
  return res.stdout
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf('\t');
      return { pid: Number(line.slice(0, i)), cmd: line.slice(i + 1) };
    })
    .filter((p) => p.pid && !self.has(p.pid) && belongsToRepo(p.cmd))
    .filter((p) => !/powershell\.exe.*Get-CimInstance/i.test(p.cmd));
}

/** Attente sans `setTimeout` exposé aux specs (usage interne à la pile). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Chronomètre d'étape : `const done = step('migrations'); …; done();` */
export function step(label: string): () => number {
  const t0 = Date.now();
  console.log(`[e2e] ▶ ${label}…`);
  return () => {
    const ms = Date.now() - t0;
    console.log(`[e2e] ✔ ${label} (${(ms / 1000).toFixed(1)} s)`);
    return ms;
  };
}
